/**
 * OnDemandPivot — dashboard controller.
 *
 * Loads the Pandas frame (served as Apache Arrow IPC streaming bytes) into a
 * Perspective table, wires the pivot/chart toolbar to <perspective-viewer>,
 * renders the KPI side panel from /api/kpis, and drives the AI chat.
 *
 * Perspective 5.5.1 (@perspective-dev) ESM bundles self-initialise their WebAssembly assets
 * relative to their own CDN URL, so no manual init_server()/init_client()
 * calls are required here.
 */

// Vendored locally (static/vendor/perspective) so the workbench runs on a
// machine with no internet access. The paths are relative to this module.
import perspective from "../vendor/perspective/cdn/perspective.js";
import "../vendor/perspective/cdn/perspective-viewer.js";
import "../vendor/perspective/cdn/perspective-viewer-datagrid.js";
import "../vendor/perspective/cdn/perspective-viewer-charts.js";

// The core bundle guesses where its server WASM lives by rewriting a CDN-shaped
// path. Ours is not CDN-shaped, so point it at the vendored file explicitly -
// this runs before any worker is created, so it wins.
perspective.init_server({
    wasm32: () =>
        fetch(new URL("../vendor/perspective/wasm/perspective-server.wasm",
                      import.meta.url)).then((r) => r.arrayBuffer()),
});

const toast = (msg, kind) => window.CPA.toast(msg, kind);
const escapeHtml = window.CPA.escapeHtml;

/* ------------------------------------------------------------------ state */

const state = {
    plugin: "Datagrid",
    // The live view configuration. These mirror whatever the user has built on
    // the shelves (or that the AI assistant has applied), so switching views
    // never discards work.
    groupBy: [],
    splitBy: [],
    columns: [],
    filter: [],
    sort: [],
    aggregates: {},    // column -> Perspective aggregate name
    // Perspective's rollup modes. "rollup" keeps the Total rows, "flat" hides
    // them — the same choice Excel offers with Grand Totals. Grouped views
    // already showed a Total row, so that default is preserved; splits did not
    // show a total column, so that one stays flat until asked for.
    grandTotals: "rollup",
    columnSubtotals: "flat",
    fields: [],        // [{name, kind, ...}] from /api/kpis
    schema: [],        // raw column names in frame order
    numeric: [],       // subset of schema
    categorical: [],   // string/category/date columns — chart grouping axes
    dates: [],         // subset of schema, for the field list's type hint
    selectedKpi: null,
    registered: [],    // plugin names Perspective actually exposes
    profile: null,
    ready: false,
    worker: null,      // the Perspective client, kept for viewer rebuilds
    palette: null,     // chart colours currently applied
    chatVerified: null, // null = untested, true = replied, false = failed
    chatError: "",
};

/**
 * Views offered in the toolbar.
 *
 * `kind` drives how a *complete* Perspective config is derived. d3fc chart
 * plugins dereference null when they are handed a config with no numeric
 * column or no grouping axis (the "Cannot read properties of null (reading
 * 'opacity')" crash), so we never hand them a half-built patch: each kind
 * below always resolves a full, valid config or is refused up front.
 */
const VIEW_SPECS = [
    { label: "Grid — pivot table", plugin: "Datagrid", kind: "grid", group: "Table" },
    { label: "Bar chart", plugin: "Y Bar", kind: "chart", group: "Charts" },
    { label: "Column chart", plugin: "X Bar", kind: "chart", group: "Charts" },
    { label: "Line chart", plugin: "Y Line", kind: "chart", group: "Charts" },
    { label: "Area chart", plugin: "Y Area", kind: "chart", group: "Charts" },
    { label: "Scatter", plugin: "Y Scatter", kind: "chart", group: "Charts" },
    { label: "Scatter X/Y", plugin: "X/Y Scatter", kind: "xy", group: "X/Y charts" },
    { label: "Line X/Y", plugin: "X/Y Line", kind: "xy", group: "X/Y charts" },
    { label: "Heatmap", plugin: "Heatmap", kind: "heatmap", group: "Hierarchy & density" },
    { label: "Treemap", plugin: "Treemap", kind: "tree", group: "Hierarchy & density" },
    { label: "Sunburst", plugin: "Sunburst", kind: "tree", group: "Hierarchy & density" },
    { label: "OHLC bars", plugin: "OHLC", kind: "ohlc", group: "Financial" },
    { label: "Candlestick", plugin: "Candlestick", kind: "ohlc", group: "Financial" },
];

/** Keys Perspective's Table.view() accepts (the viewer config has extras). */
const VIEW_CONFIG_KEYS = [
    "group_by",
    "split_by",
    "columns",
    "filter",
    "sort",
    "expressions",
    "aggregates",
    "group_by_depth",
    "filter_op",
    "group_rollup_mode",
    "split_rollup_mode",
];

/**
 * v5 binds a viewer to a Client and selects the Table by name. An unnamed
 * table gets a *random* name that save() captures and which will not exist
 * after a reload, so we always name ours.
 */
const TABLE_NAME = "dataset";

const KIND_BADGE = {
    number: "badge-number",
    string: "badge-string",
    datetime: "badge-datetime",
    boolean: "badge-boolean",
    category: "badge-string",
    timedelta: "badge-datetime",
};

const $ = (id) => document.getElementById(id);

function pluginName(p) {
    if (typeof p === "string") return p;
    return (p && (p.name || p.plugin)) || "";
}

function specFor(plugin) {
    return (
        VIEW_SPECS.find((v) => v.plugin === plugin) || {
            plugin,
            label: plugin,
            kind: "grid",
        }
    );
}

function fail(message) {
    const box = $("loadError");
    if (box) {
        box.className = "notice notice-error";
        box.textContent = message;
        box.hidden = false;
    }
    const status = $("viewerStatus");
    if (status) status.textContent = "Error";
    toast(message, "error");
}

function setStatus(text) {
    const el = $("viewerStatus");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-ready", text === "Ready");
    el.classList.toggle("is-error", /error|unavailable|failed/i.test(text));
}

/* --------------------------------------------------------------- toolbar */

async function getRegisteredPlugins() {
    try {
        const all = await $("viewer").getAllPlugins();
        if (Array.isArray(all)) {
            const names = all.map(pluginName).filter(Boolean);
            if (names.length) return names;
        }
    } catch (_err) {
        /* fall back to the specs below */
    }
    return VIEW_SPECS.map((v) => v.plugin);
}

async function renderViewSelect() {
    const select = $("viewSelect");
    state.registered = await getRegisteredPlugins();

    // Only offer views that Perspective actually registered *and* that we know
    // how to configure safely. Options are grouped so the list stays scannable.
    let views = VIEW_SPECS.filter((v) => state.registered.includes(v.plugin));
    if (!views.length) views = [VIEW_SPECS[0]];

    const groups = new Map();
    views.forEach((v) => {
        const key = v.group || "Other";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(v);
    });

    select.innerHTML = [...groups.entries()]
        .map(
            ([group, items]) =>
                `<optgroup label="${escapeHtml(group)}">` +
                items
                    .map(
                        (v) =>
                            `<option value="${escapeHtml(v.plugin)}">` +
                            `${escapeHtml(v.label)}</option>`
                    )
                    .join("") +
                "</optgroup>"
        )
        .join("");

    select.value = state.plugin;
    select.addEventListener("change", (e) => selectView(e.target.value));
    window.CPA.refreshSelects();
}

function markActiveView() {
    const select = $("viewSelect");
    if (select && state.registered.includes(state.plugin)) {
        select.value = state.plugin;
    }
    window.CPA.refreshSelects();
    const dl = $("downloadBtn");
    if (dl) {
        dl.textContent =
            state.plugin === "Datagrid" ? "Download table" : "Download PNG";
    }
}

function fillSelect(select, options, includeAllLabel) {
    const current = select.value;
    select.innerHTML =
        `<option value="">${includeAllLabel}</option>` +
        options
            .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
            .join("");
    // Preserve the previous choice if the column still exists.
    if (options.includes(current)) select.value = current;
}

function buildToolbar() {
    $("resetBtn").addEventListener("click", resetView);
    $("downloadBtn").addEventListener("click", downloadCurrentView);
}

/* ------------------------------------------------------- fields panel */

/**
 * The pivot builder.
 *
 * Perspective's own panel is hidden, so this is the only place a view can be
 * shaped. Shelves hold ordered column lists; the Values shelf additionally
 * carries a per-column aggregate. Every change is pushed straight back into the
 * viewer through refreshView(), and anything the user does inside the viewer
 * (including the AI assistant reconfiguring it) flows back through
 * syncToolbarFromConfig().
 */

/** Aggregates Perspective accepts, in the order a person is likely to want them. */
const AGGREGATES = [
    ["sum", "Sum"],
    ["avg", "Average"],
    ["count", "Count"],
    ["count_distinct", "Distinct"],
    ["min", "Min"],
    ["max", "Max"],
    ["median", "Median"],
    ["stddev", "Std dev"],
    ["var", "Variance"],
    ["first", "First"],
    ["last", "Last"],
    ["unique", "Unique"],
];

const NUMERIC_AGGREGATES = new Set([
    "sum", "avg", "median", "stddev", "var",
]);

const SHELF_LABELS = {
    group: "Group by",
    split: "Split by",
    values: "Values",
};

/** Which shelves a column may be dropped on. */
function shelfAccepts(shelf, column) {
    const isNumeric = state.numeric.includes(column);
    if (shelf === "values") return isNumeric;
    // Grouping axes are meaningful for text and dates, not measures.
    return !isNumeric || shelf === "group";
}

/** The aggregate a value column should use when first dropped. */
function defaultAggregate(column) {
    return state.numeric.includes(column) ? "sum" : "count";
}

function aggregateFor(column) {
    const chosen = (state.aggregates || {})[column];
    return chosen || defaultAggregate(column);
}

/** Drop aggregates for columns that are no longer on the Values shelf. */
function pruneAggregates() {
    const keep = new Set(state.columns);
    Object.keys(state.aggregates || {}).forEach((key) => {
        if (!keep.has(key)) delete state.aggregates[key];
    });
}

/* ---- rendering ---- */

function renderFieldList() {
    const list = $("fieldList");
    if (!list) return;
    const term = ($("fieldSearch").value || "").trim().toLowerCase();
    const used = new Set([
        ...state.groupBy, ...state.splitBy, ...state.columns,
    ]);

    list.textContent = "";
    const matches = state.schema.filter(
        (name) => !term || name.toLowerCase().includes(term)
    );

    $("fieldsCount").textContent =
        term ? `${matches.length} of ${state.schema.length}` : `${state.schema.length}`;

    if (!matches.length) {
        const empty = document.createElement("p");
        empty.className = "fields-hint";
        empty.textContent = "No column matches that.";
        list.appendChild(empty);
        return;
    }

    matches.forEach((name) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "field-chip" + (used.has(name) ? " is-used" : "");
        chip.draggable = true;
        chip.dataset.column = name;

        const label = document.createElement("span");
        label.textContent = name;
        chip.appendChild(label);

        const kind = document.createElement("span");
        const k = state.numeric.includes(name)
            ? "number"
            : state.dates && state.dates.includes(name) ? "datetime" : "string";
        kind.className = "kind " + k;
        kind.textContent = k === "number" ? "num" : k === "datetime" ? "date" : "text";
        chip.appendChild(kind);

        chip.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", name);
            e.dataTransfer.effectAllowed = "copy";
            chip.classList.add("dragging");
        });
        chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
        // Double-click sends it to the first shelf that will take it.
        chip.addEventListener("dblclick", () => {
            const shelf = ["group", "values", "split"].find((s) =>
                shelfAccepts(s, name)
            );
            if (shelf) addToShelf(shelf, name);
        });

        list.appendChild(chip);
    });
}

function renderShelves() {
    const shelves = {
        group: { el: $("shelfGroup"), cols: state.groupBy },
        split: { el: $("shelfSplit"), cols: state.splitBy },
        values: { el: $("shelfValues"), cols: state.columns },
    };

    Object.entries(shelves).forEach(([key, { el, cols }]) => {
        if (!el) return;
        el.textContent = "";

        if (!cols.length) {
            const empty = document.createElement("span");
            empty.className = "shelf-empty";
            empty.textContent = {
                group: "Drag fields here to build rows",
                split: "Drag fields here to build columns",
                values: "Drag measures here to summarise",
            }[key];
            el.appendChild(empty);
            return;
        }

        cols.forEach((name, index) => {
            const chip = document.createElement("div");
            chip.className = "shelf-chip";
            chip.draggable = true;
            chip.dataset.column = name;
            chip.dataset.shelf = key;
            chip.dataset.index = String(index);

            const label = document.createElement("span");
            label.className = "name";
            label.textContent = name;
            label.title = name;
            chip.appendChild(label);

            if (key === "values") {
                const select = document.createElement("select");
                select.title = "Aggregate";
                AGGREGATES.forEach(([value, text]) => {
                    if (NUMERIC_AGGREGATES.has(value) &&
                        !state.numeric.includes(name)) return;
                    const opt = document.createElement("option");
                    opt.value = value;
                    opt.textContent = text;
                    select.appendChild(opt);
                });
                select.value = aggregateFor(name);
                select.addEventListener("change", () => {
                    state.aggregates = state.aggregates || {};
                    state.aggregates[name] = select.value;
                    refreshView();
                });
                chip.appendChild(select);
            }

            const drop = document.createElement("button");
            drop.type = "button";
            drop.className = "drop";
            drop.textContent = "\u00d7";
            drop.setAttribute("aria-label", `Remove ${name}`);
            drop.addEventListener("click", () => removeFromShelf(key, name));
            chip.appendChild(drop);

            chip.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData("text/plain", name);
                e.dataTransfer.setData("application/x-shelf", key);
                e.dataTransfer.effectAllowed = "move";
                chip.classList.add("is-dragging");
            });
            chip.addEventListener("dragend", () => chip.classList.remove("is-dragging"));

            el.appendChild(chip);
        });
    });
}

/* ---- distinct values, for Excel-style filter pickers ---- */

const valueCache = new Map();

/**
 * Distinct values of a column, as the server sees them.
 *
 * Cached per column for the life of the page: the underlying frame only changes
 * when a new file is uploaded, and that reloads the dashboard anyway.
 */
function distinctValues(column) {
    if (!valueCache.has(column)) {
        valueCache.set(
            column,
            fetch(`/api/values?column=${encodeURIComponent(column)}`)
                .then((resp) => (resp.ok ? resp.json() : null))
                .then((data) =>
                    data && data.success
                        ? data
                        : { values: [], truncated: true, has_blanks: false }
                )
                .catch(() => ({ values: [], truncated: true, has_blanks: false }))
        );
    }
    return valueCache.get(column);
}

function clearValueCache() {
    valueCache.clear();
}

/** Human text for one filter condition. */
function renderRules() {
    const filterList = $("filterList");
    const sortList = $("sortList");
    if (!filterList || !sortList) return;

    filterList.textContent = "";
    if (!state.filter.length) {
        const empty = document.createElement("div");
        empty.className = "rule-empty";
        empty.textContent = "No filters — every row is included.";
        filterList.appendChild(empty);
    } else {
        state.filter.forEach((cond, i) => {
            filterList.appendChild(buildFilterRow(cond, i));
        });
    }

    sortList.textContent = "";
    if (!state.sort.length) {
        const empty = document.createElement("div");
        empty.className = "rule-empty";
        empty.textContent = "No sort — rows keep their natural order.";
        sortList.appendChild(empty);
    } else {
        state.sort.forEach((spec, i) => {
            sortList.appendChild(buildSortRow(spec, i));
        });
    }

    renderFilterShelf();
}

/** The Filters drop zone mirrors the active conditions as removable chips. */
function renderFilterShelf() {
    const el = $("shelfFilters");
    if (!el) return;
    el.textContent = "";

    if (!state.filter.length) {
        const empty = document.createElement("span");
        empty.className = "shelf-empty";
        empty.textContent = "Drag fields here to filter";
        el.appendChild(empty);
        return;
    }

    state.filter.forEach((cond, index) => {
        const chip = document.createElement("div");
        chip.className = "shelf-chip";

        const label = document.createElement("span");
        label.className = "name";
        label.textContent = cond[0];
        label.title = cond[0];
        chip.appendChild(label);

        const drop = document.createElement("button");
        drop.type = "button";
        drop.className = "drop";
        drop.textContent = "\u00d7";
        drop.setAttribute("aria-label", `Remove the filter on ${cond[0]}`);
        drop.addEventListener("click", () => {
            state.filter.splice(index, 1);
            refreshView();
        });
        chip.appendChild(drop);
        el.appendChild(chip);
    });
}

function buildFilterRow(cond, index) {
    const row = document.createElement("div");
    row.className = "rule-row";

    const column = document.createElement("select");
    state.schema.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        column.appendChild(opt);
    });
    column.value = cond[0];
    row.appendChild(column);

    const op = document.createElement("select");
    [["==", "="], ["!=", "\u2260"], [">", ">"], ["<", "<"],
     [">=", "\u2265"], ["<=", "\u2264"], ["contains", "has"],
     ["begins with", "starts"]].forEach(([value, text]) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = text;
        op.appendChild(opt);
    });
    op.value = cond[1] || "==";
    row.appendChild(op);

    // The value control is a picker of the values actually present, the way
    // Excel's filter is — falling back to a text box when the column has too
    // many distinct values (or the operator needs free text).
    const host = document.createElement("span");
    host.className = "rule-value-host";
    row.appendChild(host);

    const commit = (raw) => {
        const asNumber = Number(raw);
        const cast = raw !== "" && !Number.isNaN(asNumber) &&
            state.numeric.includes(column.value)
            ? asNumber
            : raw;
        state.filter[index] = [column.value, op.value, cast];
        refreshView();
    };

    const paintValue = (data) => {
        host.textContent = "";
        const needsText =
            !data || data.truncated || !data.values.length ||
            op.value === "contains" || op.value === "begins with";

        if (needsText) {
            const input = document.createElement("input");
            input.type = "text";
            input.value = cond[2] === undefined || cond[2] === null
                ? "" : String(cond[2]);
            input.placeholder = "value";
            input.addEventListener("change", () => commit(input.value));
            host.appendChild(input);
            return;
        }

        const picker = document.createElement("select");
        const any = document.createElement("option");
        any.value = "";
        any.textContent = "(Any)";
        picker.appendChild(any);

        data.values.forEach((v) => {
            const opt = document.createElement("option");
            opt.value = String(v);
            opt.textContent = String(v);
            picker.appendChild(opt);
        });
        if (data.has_blanks) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(Blanks)";
            picker.appendChild(opt);
        }

        picker.value = cond[2] === undefined || cond[2] === null
            ? "" : String(cond[2]);
        picker.addEventListener("change", () => commit(picker.value));
        host.appendChild(picker);
    };

    paintValue(null);
    distinctValues(cond[0]).then(paintValue);

    column.addEventListener("change", () => {
        // A new field means a new value list and a clean condition.
        state.filter[index] = [column.value, op.value, ""];
        refreshView();
    });
    op.addEventListener("change", () => {
        state.filter[index] = [column.value, op.value, cond[2]];
        renderRules();
    });

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "drop";
    drop.textContent = "\u00d7";
    drop.setAttribute("aria-label", "Remove filter");
    drop.addEventListener("click", () => {
        state.filter.splice(index, 1);
        refreshView();
    });
    row.appendChild(drop);
    return row;
}

function buildSortRow(spec, index) {
    const row = document.createElement("div");
    row.className = "rule-row";

    const column = document.createElement("select");
    state.schema.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        column.appendChild(opt);
    });
    column.value = spec[0];
    row.appendChild(column);

    const dir = document.createElement("select");
    [["asc", "Ascending"], ["desc", "Descending"]].forEach(([value, text]) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = text;
        dir.appendChild(opt);
    });
    dir.value = spec[1] || "asc";
    row.appendChild(dir);

    const commit = () => {
        state.sort[index] = [column.value, dir.value];
        refreshView();
    };
    column.addEventListener("change", commit);
    dir.addEventListener("change", commit);

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "drop";
    drop.textContent = "\u00d7";
    drop.setAttribute("aria-label", "Remove sort");
    drop.addEventListener("click", () => {
        state.sort.splice(index, 1);
        refreshView();
    });
    row.appendChild(drop);
    return row;
}

/* ---- shelf mutations ---- */

function addToShelf(shelf, column) {
    const key = shelf === "values" ? "columns" : shelf === "group" ? "groupBy" : "splitBy";
    if (state[key].includes(column)) return;
    state[key].push(column);
    if (shelf === "values") {
        state.aggregates = state.aggregates || {};
        state.aggregates[column] = defaultAggregate(column);
    }
    refreshView();
}

function removeFromShelf(shelf, column) {
    const key = shelf === "values" ? "columns" : shelf === "group" ? "groupBy" : "splitBy";
    state[key] = state[key].filter((c) => c !== column);
    if (shelf === "values") pruneAggregates();
    refreshView();
}

function moveToShelf(shelf, column, index) {
    const key = shelf === "values" ? "columns" : shelf === "group" ? "groupBy" : "splitBy";
    // Take it off whichever shelf currently holds it, then insert at the target.
    ["groupBy", "splitBy", "columns"].forEach((k) => {
        state[k] = state[k].filter((c) => c !== column);
    });
    pruneAggregates();

    const target = state[key];
    const at = Math.max(0, Math.min(index ?? target.length, target.length));
    target.splice(at, 0, column);

    if (shelf === "values") {
        state.aggregates = state.aggregates || {};
        if (!state.aggregates[column]) state.aggregates[column] = defaultAggregate(column);
    }
    refreshView();
}

/* ------------------------------------------------------- pane resizing */

const FIELDS_WIDTH_KEY = "cpa.fields.width.v1";
const FIELDS_WIDTH_DEFAULT = 322;
const FIELDS_MIN = 236;
const FIELDS_MAX = 640;
/* The table never gets squeezed below this, however far the handle is dragged. */
const TABLE_MIN = 420;

/** Keep the pane usable and the table visible. */
function clampFieldsWidth(px) {
    const layout = $("dashLayout");
    const room = layout ? layout.clientWidth : window.innerWidth;
    const cap = Math.min(FIELDS_MAX, Math.max(FIELDS_MIN, room - TABLE_MIN));
    return Math.round(Math.max(FIELDS_MIN, Math.min(cap, px)));
}

function fieldsWidthNow() {
    const layout = $("dashLayout");
    if (!layout) return FIELDS_WIDTH_DEFAULT;
    const current = parseInt(
        getComputedStyle(layout).getPropertyValue("--fields-w"), 10
    );
    return Number.isFinite(current) ? current : FIELDS_WIDTH_DEFAULT;
}

function setFieldsWidth(px, persist) {
    const layout = $("dashLayout");
    if (!layout) return;
    const width = clampFieldsWidth(px);
    layout.style.setProperty("--fields-w", `${width}px`);
    if (!persist) return;
    try {
        localStorage.setItem(FIELDS_WIDTH_KEY, String(width));
    } catch (_err) {
        /* storage unavailable — the live width still works this session */
    }
}

function loadFieldsWidth() {
    try {
        const raw = parseInt(localStorage.getItem(FIELDS_WIDTH_KEY) || "", 10);
        if (Number.isFinite(raw)) return raw;
    } catch (_err) {
        /* fall through to the default */
    }
    return FIELDS_WIDTH_DEFAULT;
}

/**
 * Horizontal resize between the table and the PivotTable Fields pane.
 *
 * The pane lives on the right, so dragging left widens it. Widths are written
 * to `--fields-w` on the layout, which the grid columns read; the drag itself
 * is on the window so the pointer can leave the 1px handle without dropping it.
 */
function initResizer() {
    const handle = $("dashResizer");
    const layout = $("dashLayout");
    if (!handle || !layout) return;

    setFieldsWidth(loadFieldsWidth(), false);

    let startX = 0;
    let startW = 0;

    const onMove = (event) => {
        setFieldsWidth(startW - (event.clientX - startX), false);
    };

    const onUp = () => {
        handle.classList.remove("is-dragging");
        document.body.classList.remove("is-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setFieldsWidth(fieldsWidthNow(), true);
    };

    handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        startX = event.clientX;
        startW = fieldsWidthNow();
        handle.classList.add("is-dragging");
        document.body.classList.add("is-resizing");
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    });

    // Keyboard equivalent, so the handle is not mouse-only.
    handle.addEventListener("keydown", (event) => {
        const step = event.shiftKey ? 40 : 12;
        if (event.key === "ArrowLeft") setFieldsWidth(fieldsWidthNow() + step, true);
        else if (event.key === "ArrowRight") setFieldsWidth(fieldsWidthNow() - step, true);
        else if (event.key === "Home") setFieldsWidth(FIELDS_WIDTH_DEFAULT, true);
        else return;
        event.preventDefault();
    });

    // A narrower window must not leave the pane wider than the table can afford.
    window.addEventListener("resize", () => setFieldsWidth(fieldsWidthNow(), false));
}

function initFields() {
    const dock = $("fieldsDock");
    const layout = $("dashLayout");
    const btn = $("fieldsBtn");
    if (!dock || !layout || !btn) return;

    const setOpen = (open) => {
        dock.hidden = !open;
        layout.classList.toggle("fields-open", open);
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        btn.textContent = open ? "Hide Fields" : "Show Fields";
        const handle = $("dashResizer");
        if (handle) handle.hidden = !open;
        if (open) {
            // Re-clamp: the window may have changed size while it was closed.
            setFieldsWidth(fieldsWidthNow(), false);
            renderFieldList();
        }
    };

    btn.addEventListener("click", () => setOpen(dock.hidden));
    $("fieldsClose").addEventListener("click", () => setOpen(false));

    $("fieldSearch").addEventListener("input", renderFieldList);

    $("addFilter").addEventListener("click", () => {
        state.filter.push([state.schema[0], "==", ""]);
        refreshView();
    });
    $("addSort").addEventListener("click", () => {
        state.sort.push([state.groupBy[0] || state.schema[0], "asc"]);
        refreshView();
    });

    // Report options map straight onto Perspective's rollup modes: with totals
    // the grouped axis keeps its "Total" rows, without them it is flat.
    const wireTotals = (id, key) => {
        const box = $(id);
        if (!box) return;
        box.addEventListener("change", () => {
            state[key] = box.checked ? "rollup" : "flat";
            refreshView();
        });
    };
    wireTotals("optGrandTotals", "grandTotals");
    wireTotals("optRowTotals", "columnSubtotals");

    // Every shelf is a drop target; dropping onto a chip inserts before it.
    [["shelfGroup", "group"], ["shelfSplit", "split"],
     ["shelfValues", "values"], ["shelfFilters", "filters"]]
        .forEach(([id, shelf]) => {
            const el = $(id);
            if (!el) return;

            el.addEventListener("dragover", (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect =
                    e.dataTransfer.types.includes("application/x-shelf")
                        ? "move" : "copy";
                el.classList.add("is-over");
            });
            el.addEventListener("dragleave", (e) => {
                if (!el.contains(e.relatedTarget)) el.classList.remove("is-over");
            });
            el.addEventListener("drop", (e) => {
                e.preventDefault();
                el.classList.remove("is-over");
                const column = e.dataTransfer.getData("text/plain");
                if (!column || !state.schema.includes(column)) return;

                // Filters are conditions, not an ordered list, so a drop simply
                // adds one (or clears the existing one for that field).
                if (shelf === "filters") {
                    const existing = state.filter.findIndex((c) => c[0] === column);
                    if (existing >= 0) {
                        state.filter.splice(existing, 1);
                    } else {
                        state.filter.push([column, "==", ""]);
                    }
                    refreshView();
                    return;
                }

                const chip = e.target.closest(".shelf-chip");
                const index = chip ? Number(chip.dataset.index) : state[
                    shelf === "values" ? "columns"
                        : shelf === "group" ? "groupBy" : "splitBy"
                ].length;

                if (chip && chip.dataset.shelf === shelf) {
                    moveToShelf(shelf, column, index);
                } else if (shelfAccepts(shelf, column)) {
                    moveToShelf(shelf, column, index);
                } else {
                    toast(
                        shelf === "values"
                            ? `${column} is not a measure — Values only takes numbers.`
                            : `${column} is a measure — put it on Values instead.`,
                        "warn"
                    );
                }
            });
        });
}

/* ---------------------------------------------------------- palette UI */

function initPalette() {
    const btn = $("paletteBtn");
    const panel = $("palettePanel");
    const presets = $("palettePresets");
    const primary = $("palettePrimary");
    const secondary = $("paletteSecondary");

    presets.innerHTML = PALETTES.map(
        (p, i) => `
        <button class="palette-preset" type="button" data-index="${i}">
            <span class="palette-swatches">${p.colors
                .slice(0, 5)
                .map((c) => `<i style="background:${c}"></i>`)
                .join("")}</span>
            ${escapeHtml(p.name)}
        </button>`
    ).join("");

    const mark = () => {
        const current = JSON.stringify(state.palette);
        presets.querySelectorAll(".palette-preset").forEach((el) => {
            el.classList.toggle(
                "is-active",
                JSON.stringify(PALETTES[Number(el.dataset.index)].colors) === current
            );
        });
    };

    const apply = async (colors) => {
        state.palette = colors;
        savePalette(colors);
        primary.value = colors[0];
        secondary.value = colors[1];
        paintViewer($("viewer"), colors);
        mark();

        // An open chart is redrawn by rebuilding the viewer.
        if (state.plugin && state.plugin !== "Datagrid") {
            // Rebuild from what is actually on screen. state.config can be
            // stale once the user has dragged fields in the Pivot panel, and
            // restoring a stale config silently changes their grouping.
            let next = null;
            try {
                const live = await $("viewer").save();
                next = {
                    ...viewConfigFrom(live),
                    plugin: live.plugin || state.plugin,
                    table: TABLE_NAME,
                };
            } catch (_err) {
                next = state.config || undefined;
            }
            await rebuildViewer(next);
            setStatus("Ready");
        }
    };

    presets.querySelectorAll(".palette-preset").forEach((el) => {
        el.addEventListener("click", () =>
            apply(PALETTES[Number(el.dataset.index)].colors.slice())
        );
    });

    const applyCustom = () => {
        const colors = state.palette.slice();
        colors[0] = primary.value;
        colors[1] = secondary.value;
        apply(colors);
    };
    primary.addEventListener("change", applyCustom);
    secondary.addEventListener("change", applyCustom);

    const close = () => {
        panel.hidden = true;
        btn.setAttribute("aria-expanded", "false");
    };

    btn.addEventListener("click", (event) => {
        event.stopPropagation();
        mark();
        panel.hidden = !panel.hidden;
        btn.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    });
    panel.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", close);

    primary.value = state.palette[0];
    secondary.value = state.palette[1];
    mark();
}

/** Push the live Perspective config back into our toolbar controls. */
function syncToolbarFromConfig(cfg) {
    if (!cfg) return;
    state.groupBy = Array.isArray(cfg.group_by) ? cfg.group_by : [];
    state.splitBy = Array.isArray(cfg.split_by) ? cfg.split_by : [];

    // The Values shelf only holds a *deliberate* selection. A flat grid reports
    // every remaining column, and a chart reports its plotted measures; the
    // former is just the default, so adopting it would silently fill the shelf
    // with columns the user never chose.
    const onAxes = new Set([...state.groupBy, ...state.splitBy]);
    const rest = state.schema.filter((c) => !onAxes.has(c));
    const cols = Array.isArray(cfg.columns) ? cfg.columns : [];
    const isDefault = rest.length > 0 && rest.every((c) => cols.includes(c));
    state.columns = isDefault ? [] : cols;

    // The viewer only reports conditions it actually applied, so a field the
    // user has dropped on Filters but not yet given a value to would be lost.
    // Keep those drafts, keyed by field.
    const incomingFilter = Array.isArray(cfg.filter) ? cfg.filter : [];
    const drafts = state.filter.filter(
        (c) => isDraftFilter(c) && !incomingFilter.some((i) => i[0] === c[0])
    );
    state.filter = incomingFilter.concat(drafts);
    state.sort = Array.isArray(cfg.sort) ? cfg.sort : [];

    // Rollup modes come back from the viewer, so the checkboxes stay honest
    // even when the AI assistant changes them.
    if (cfg.group_rollup_mode) state.grandTotals = cfg.group_rollup_mode;
    if (cfg.split_rollup_mode) state.columnSubtotals = cfg.split_rollup_mode;
    const totals = $("optGrandTotals");
    const subtotals = $("optRowTotals");
    if (totals) totals.checked = state.grandTotals !== "flat";
    if (subtotals) subtotals.checked = state.columnSubtotals !== "flat";

    // Keep our aggregate choice when the incoming config omits it — the viewer
    // only reports aggregates it considers non-default.
    const incoming = cfg.aggregates || {};
    const merged = {};
    state.columns.forEach((c) => {
        merged[c] = incoming[c] || (state.aggregates || {})[c] || defaultAggregate(c);
    });
    state.aggregates = merged;

    renderShelves();
    renderRules();
    renderFieldList();
}

/* ------------------------------------------------------------- palette */

/**
 * Chart palettes. The first is the corporate default (red and grey); the
 * others are opt-in. `state.palette` is kept so a rebuilt viewer inherits it.
 */
const PALETTES = [
    {
        name: "HSBC Colors",
        colors: ["#db0011", "#1a1a1a", "#666666", "#b5000e", "#333333",
                 "#999999", "#808080", "#c8c8c8"],
    },
    {
        name: "Classic",
        colors: ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
                 "#8c564b", "#e377c2", "#7f7f7f"],
    },
    {
        name: "Ocean",
        colors: ["#0b5394", "#1a7fb5", "#4fb3d9", "#8fd6e8", "#005f73",
                 "#0a9396", "#94d2bd", "#cfeef7"],
    },
    {
        name: "Warm",
        colors: ["#b5000e", "#e8590c", "#f08c00", "#ffd43b", "#c92a2a",
                 "#a61e4d", "#862e9c", "#db0011"],
    },
    {
        name: "Mono",
        colors: ["#111111", "#3a3a3a", "#5c5c5c", "#7d7d7d", "#9e9e9e",
                 "#bcbcbc", "#d6d6d6", "#ececec"],
    },
];

const PALETTE_KEY = "cpa.palette.v1";

function hexToRgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** "#db0011" -> [219, 0, 17] */
function hexToRgb(hex) {
    const value = String(hex || "").replace("#", "");
    const full =
        value.length === 3
            ? value.split("").map((c) => c + c).join("")
            : value.padEnd(6, "0").slice(0, 6);
    const int = parseInt(full, 16);
    if (!Number.isFinite(int)) return [0, 0, 0];
    /* eslint-disable no-bitwise */
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
    /* eslint-enable no-bitwise */
}

function rgbToHex([r, g, b]) {
    const part = (n) => Math.max(0, Math.min(255, Math.round(n)))
        .toString(16).padStart(2, "0");
    return `#${part(r)}${part(g)}${part(b)}`;
}

/** Blend `hex` toward `target` by `amount` (0 = unchanged, 1 = target). */
function mixHex(hex, target, amount) {
    const a = hexToRgb(hex);
    const b = hexToRgb(target);
    return rgbToHex(a.map((v, i) => v + (b[i] - v) * amount));
}

/**
 * Black or white, whichever stays legible on `hex`.
 * Uses the WCAG relative-luminance weights, so mid reds and blues get white
 * text while a pale custom colour gets black.
 */
function readableOn(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.45 ? "#1a1a1a" : "#ffffff";
}

/**
 * Push a palette onto a viewer element.
 *
 * v5's chart engine reads `--psp-charts--series-N--color`. Two things matter:
 *
 *  1. pro.css defines its defaults under `perspective-viewer [theme=...]`, which
 *     matches the plugin element itself (v5 copies the theme name onto it) and
 *     therefore beats inheritance from the viewer. So the palette is written to
 *     a dedicated stylesheet matching the same shapes, which — being appended
 *     last — wins at equal specificity.
 *  2. The engine reads series-1, series-2, ... and stops at the first one that
 *     is empty, so a short palette would let pro.css's orange and green leak in.
 *     Twelve entries are always written, cycling if the palette is shorter.
 */
const PALETTE_VARS = 12;

function paintViewer(viewer, colors) {
    // Also inline on the host: covers the plugin element losing its theme
    // attribute, and any part of the UI that reads the variable directly.
    colors.forEach((color, i) => {
        viewer.style.setProperty(`--psp-charts--series-${i + 1}--color`, color);
    });
    viewer.style.setProperty("--psp-charts--series--color", hexToRgba(colors[0], 0.85));

    let sheet = document.getElementById("paletteSheet");
    if (!sheet) {
        sheet = document.createElement("style");
        sheet.id = "paletteSheet";
        document.head.appendChild(sheet);
    }

    const decls = [];
    for (let i = 0; i < PALETTE_VARS; i += 1) {
        decls.push(
            `--psp-charts--series-${i + 1}--color:${colors[i % colors.length]};`
        );
    }
    decls.push(`--psp-charts--series--color:${hexToRgba(colors[0], 0.85)};`);

    sheet.textContent =
        "perspective-viewer," +
        "perspective-viewer[theme]," +
        `perspective-viewer [theme]{${decls.join("")}}`;

    // The table follows the same palette, so the Colours picker themes the
    // whole workbench rather than just the charts.
    styleSurfaces(colors, viewer);
}

/**
 * Make the grid look exactly like the import page's preview table.
 *
 * v5 renders the cells inside the datagrid plugin's shadow root and exposes no
 * custom property for their chrome, so a stylesheet is injected there instead.
 * The header and body rules mirror `table.data` in style.css; the zebra stripe
 * and row height are read from custom properties when the plugin paints, so
 * those go on :host.
 *
 * The header takes the palette's primary colour and the banding takes a tint of
 * it, so the Colours picker themes the table as well as the charts. The header
 * text flips to black when the primary is too pale to carry white.
 *
 * Injected once per shadow root, keyed with a marker attribute, and rewritten in
 * place when the palette changes.
 */
function gridThemeCss(colors) {
    const primary = (colors && colors[0]) || "#db0011";
    const hover = mixHex(primary, "#000000", 0.16);
    const divider = mixHex(primary, "#ffffff", 0.28);
    const onPrimary = readableOn(primary);
    const zebra = mixHex(primary, "#ffffff", 0.955);
    const rowHover = mixHex(primary, "#ffffff", 0.9);
    const rowHeader = mixHex(primary, "#ffffff", 0.975);
    const rowHeaderHover = mixHex(primary, "#ffffff", 0.945);

    return `
/* ---- header: mirrors table.data thead th ---- */
thead th {
    background: ${primary} !important;
    color: ${onPrimary} !important;
    font-weight: 700 !important;
    font-size: 10.5px !important;
    letter-spacing: 0.08em !important;
    text-transform: uppercase !important;
    border-bottom: 1px solid ${hover} !important;
    border-right: 1px solid ${divider} !important;
    padding: 0 12px !important;
}
thead th:hover {
    background: ${hover} !important;
}
thead th :is(.psp-header-sort-asc, .psp-header-sort-desc,
             .psp-header-sort-col-asc, .psp-header-sort-col-desc)::after {
    background-color: ${onPrimary} !important;
}

/* ---- body: mirrors table.data tbody td ---- */
tbody td,
tbody th {
    padding: 0 12px !important;
    border-bottom: 1px solid #e2e2e2 !important;
    border-right: 1px solid #f2f2f2 !important;
    color: #1a1a1a !important;
}
tbody tr:hover td,
tbody tr:hover th {
    background-color: ${rowHover} !important;
}

/* ---- row headers: the grouped first column ----
   Tinted and semibold so the hierarchy reads at a glance, the way Excel's row
   labels do, and separated from the measures by a stronger rule. */
tbody th {
    background-color: ${rowHeader} !important;
    font-weight: 600 !important;
    border-right: 1px solid #d8d8d8 !important;
}
tbody tr:hover th {
    background-color: ${rowHeaderHover} !important;
}

/* The tree guides between levels, softened to a hairline. */
tbody th span.rt-tree-group {
    border-left-color: #d8d8d8 !important;
}

/* ---- scrollbars ----
   The plugin paints its own track; give it one that matches the app instead of
   the browser default. */
::-webkit-scrollbar {
    width: 12px;
    height: 12px;
}
::-webkit-scrollbar-track,
::-webkit-scrollbar-corner {
    background: #f7f7f7;
}
::-webkit-scrollbar-thumb {
    background: #c8c8c8;
    border: 3px solid #f7f7f7;
    border-radius: 7px;
}
::-webkit-scrollbar-thumb:hover {
    background: #9e9e9e;
}

/* Values the plugin reads when it paints. */
:host {
    --psp-datagrid--zebra--color: ${zebra};
    --psp-datagrid--row--height: 30px;
    --psp-datagrid--border-color: #e2e2e2;
    --psp-datagrid--hover--border-color: #e2e2e2;
}

/* The plugin leaves a 12px inset on its scroll surface, which reads as dead
   space between the caption and the first row. A hairline is wanted, not
   nothing, so the header does not sit flush against the caption. */
regular-table {
    margin: 0.1rem 0 0 0 !important;
}

/* v5 shows an inline-edit row under the headers. This app is read-only, so the
   affordance is hidden rather than left as a row of inert EDIT buttons. */
regular-table #psp-column-edit-buttons {
    display: none !important;
}
`;
}

/**
 * Trim the dead space Perspective reserves above the plugin.
 *
 * The viewer's workspace frame keeps a 26px panel titlebar even with a single
 * panel and no tab strip, plus a 4px margin and a 1px border on the frame
 * itself — about 31px of empty space between our caption and the grid. The
 * titlebar is exposed as `part="titlebar"`, so it can be hidden through the
 * official hook rather than by reaching into an unmarked div.
 */
const VIEWER_SHELL_CSS = `
regular-layout-frame {
    margin: 0 !important;
    border: 0 !important;
}
regular-layout-frame::part(titlebar) {
    display: none !important;
}
`;

function styleViewerShell(viewer) {
    const host = viewer || $("viewer");
    const root = host && host.shadowRoot;
    if (!root) return;

    let style = root.querySelector("style[data-hsbc-shell]");
    if (!style) {
        style = document.createElement("style");
        style.setAttribute("data-hsbc-shell", "1");
        root.appendChild(style);
    }
    style.textContent = VIEWER_SHELL_CSS;
}

/**
 * Inject (or refresh) the grid theme in the datagrid plugin's shadow root.
 * Safe to call on every render and on every palette change.
 */
function styleGrid(colors, viewer) {
    const host = viewer || $("viewer");
    const grid = [...host.children].find((el) =>
        el.tagName.toLowerCase().startsWith("perspective-viewer-datagrid")
    );
    const root = grid && grid.shadowRoot;
    if (!root) return;

    let style = root.querySelector("style[data-hsbc-grid]");
    if (!style) {
        style = document.createElement("style");
        style.setAttribute("data-hsbc-grid", "1");
        root.appendChild(style);
    }
    style.textContent = gridThemeCss(colors || state.palette || PALETTES[0].colors);
}

/** Both rendering surfaces need restyling together. */
function styleSurfaces(colors, viewer) {
    styleViewerShell(viewer);
    styleGrid(colors, viewer);
}

function loadPalette() {
    try {
        const raw = localStorage.getItem(PALETTE_KEY);
        if (raw) {
            const colors = JSON.parse(raw);
            if (Array.isArray(colors) && colors.length >= 2) return colors;
        }
    } catch (_err) {
        /* fall through to the default */
    }    return PALETTES[0].colors.slice();
}

function savePalette(colors) {
    try {
        localStorage.setItem(PALETTE_KEY, JSON.stringify(colors));
    } catch (_err) {
        /* storage unavailable */
    }
}

function firstCategorical() {
    return state.categorical[0] || null;
}

/** Columns to plot: whatever is live, narrowed to numbers, else a default. */
function chartColumns() {
    const live = state.columns.filter((c) => state.numeric.includes(c));
    if (live.length) return live;
    return state.numeric.slice(0, 8);
}

/**
 * Resolve a complete Perspective config for `spec`, or `null` when the
 * dataset cannot support that view. Never returns a partial config.
 */
function buildViewConfig(spec) {
    const cfg = rawViewConfig(spec);
    if (!cfg) return null;
    // v5 names the table inside the config, and the rollup modes apply to every
    // view, so both are added here rather than in each branch.
    return {
        ...cfg,
        table: TABLE_NAME,
        group_rollup_mode: state.grandTotals || "rollup",
        split_rollup_mode: state.columnSubtotals || "rollup",
    };
}

/**
 * Only conditions with a value actually filter.
 *
 * Dropping a field on the Filters shelf creates the condition before the user
 * has chosen anything, which is Excel's behaviour too — the field sits there
 * showing "(All)" and the view is untouched until a value is picked.
 */
function activeFilter() {
    return state.filter.filter(
        (c) => Array.isArray(c) && c[2] !== "" && c[2] !== null && c[2] !== undefined
    );
}

/** A condition with no value yet — shown in the pane, not applied to the view. */
function isDraftFilter(cond) {
    return !Array.isArray(cond) || cond[2] === "" || cond[2] === null ||
        cond[2] === undefined;
}

function rawViewConfig(spec) {
    const group = state.groupBy.length ? state.groupBy : [];
    const groupAxis = group.length ? group : firstCategorical() ? [firstCategorical()] : [];
    const split = state.splitBy;
    const aggregates = Object.keys(state.aggregates || {}).length
        ? state.aggregates
        : undefined;
    const filter = activeFilter();

    if (spec.kind === "grid") {
        return {
            plugin: spec.plugin,
            group_by: group,
            split_by: split,
            columns: state.columns.length ? state.columns : state.schema.slice(),
            filter,
            sort: state.sort,
            aggregates,
            // Zebra is a row *count*: 1 means every other row, matching what the
            // import page's preview table does with :nth-child(even).
            plugin_config: { zebra_rows: 1 },
        };
    }

    // Every chart needs something to plot and something to group by.
    if (!state.numeric.length || !groupAxis.length) return null;

    const columns = chartColumns();

    if (spec.kind === "chart") {
        return {
            plugin: spec.plugin,
            group_by: groupAxis,
            split_by: split,
            columns,
            filter,
            sort: state.sort,
            aggregates,
        };
    }

    if (spec.kind === "xy") {
        // X/Y plugins read TWO main values (X and Y) and crash with
        // "Cannot read properties of undefined (reading 'name')" when fewer
        // than two numeric columns are supplied. The X axis is the first
        // column, so a single measure has to borrow a second numeric column
        // or the view is refused outright.
        const x = columns[0];
        const rest = columns.filter((c) => c !== x);
        const spare = state.numeric.filter(
            (n) => n !== x && !rest.includes(n)
        );
        const ys = rest.length ? rest : spare.slice(0, 1);
        if (!ys.length) return null;
        return {
            plugin: spec.plugin,
            group_by: [],
            split_by: split,
            columns: [x, ...ys],
            filter,
            sort: state.sort,
            aggregates,
        };
    }

    if (spec.kind === "heatmap") {
        const second =
            split.length
                ? split
                : state.categorical[1]
                  ? [state.categorical[1]]
                  : [];
        const usable = second.filter((c) => !groupAxis.includes(c));
        return {
            plugin: spec.plugin,
            group_by: groupAxis,
            split_by: usable,
            columns: [columns[0]],
            filter,
            sort: state.sort,
            aggregates,
        };
    }

    if (spec.kind === "ohlc") {
        // OHLC / Candlestick need a date axis plus four measures.
        const dateField = state.fields.find((f) => f.kind === "datetime");
        if (!dateField || state.numeric.length < 4) return null;
        const picked = columns.length >= 4
            ? columns.slice(0, 4)
            : [columns[0], ...state.numeric.filter((n) => n !== columns[0])].slice(0, 4);
        return {
            plugin: spec.plugin,
            group_by: [dateField.name],
            split_by: [],
            columns: picked,
            filter,
            sort: state.sort,
        };
    }

    // "tree" (Treemap / Sunburst)
    return {
        plugin: spec.plugin,
        group_by: groupAxis,
        split_by: split,
        columns,
        filter,
        sort: state.sort,
    };
}

async function selectView(plugin) {
    const spec = specFor(plugin);
    const next = buildViewConfig(spec);

    if (!next) {
        toast(
            `The “${spec.label}” view needs a numeric column and a groupable ` +
                "column. Add a measure or pick a Rows column first.",
            "warn"
        );
        return;
    }

    state.plugin = plugin;
    markActiveView();
    setStatus("Applying…");
    await applyConfig(next);
}

/** Re-build and re-apply the current view (used by the toolbar selects). */
async function refreshView() {
    const next = buildViewConfig(specFor(state.plugin));
    if (!next) {
        toast("That column choice cannot be plotted — pick a numeric column.", "warn");
        return;
    }
    await applyConfig(next);
}

/** Attach the config-sync listener to a viewer element. */
function attachViewerEvents(viewer) {
    viewer.addEventListener("perspective-config-update", async (event) => {
        const detail = event.detail;
        if (!detail) return;

        // v5 hands over a handle with a getConfig() method; earlier versions
        // handed the config object itself. Accept both.
        let cfg = detail;
        if (typeof detail.getConfig === "function") {
            try {
                cfg = await detail.getConfig();
            } catch (_err) {
                return;
            }
        }
        if (!cfg || typeof cfg !== "object") return;

        if (cfg.plugin) state.plugin = cfg.plugin;
        syncToolbarFromConfig(cfg);
        markActiveView();
        styleSurfaces();
    });
}

/**
 * A bad chart config can leave the d3fc plugin permanently broken - further
 * restores keep failing until the page is reloaded. Rebuilding the element is
 * the only reliable way out, so the app heals itself instead of asking the
 * user to refresh.
 */
async function rebuildViewer(restoreConfig) {
    const old = $("viewer");
    const fresh = document.createElement("perspective-viewer");
    fresh.id = "viewer";
    // The chart engine caches its colour styles on first draw, so the palette
    // has to be on the element before the replacement is drawn.
    paintViewer(fresh, state.palette || PALETTES[0].colors);
    old.replaceWith(fresh);
    attachViewerEvents(fresh);

    if (state.worker) {
        await fresh.load(state.worker);
    }

    const next = restoreConfig || {
        plugin: "Datagrid",
        group_by: [],
        split_by: [],
        columns: state.schema.slice(),
        filter: [],
        sort: [],
        table: TABLE_NAME,
    };
    await fresh.restore(next);
    styleSurfaces();

    state.config = next;
    state.plugin = next.plugin || "Datagrid";
    state.groupBy = next.group_by || [];
    state.splitBy = next.split_by || [];
    state.columns = next.columns || state.schema.slice();
    markActiveView();
}

/**
 * Apply a *complete* config. If the plugin rejects it, rebuild the viewer and
 * land on the flat grid rather than leaving a dead canvas behind.
 */
async function applyConfig(next) {
    try {
        await $("viewer").restore(next);
        state.config = next;
        styleSurfaces();
        setStatus("Ready");
        return true;
    } catch (err) {
        const message = (err && err.message) || String(err);
        try {
            await rebuildViewer();
            setStatus("Ready");
            toast(
                "That view could not be drawn, so the grid was restored. " +
                    "Reason: " + message,
                "error"
            );
        } catch (rebuildErr) {
            setStatus("View unavailable");
            toast("Could not apply that view: " + message, "error");
        }
        return false;
    }
}

async function resetView() {
    state.groupBy = [];
    state.splitBy = [];
    state.columns = [];
    state.filter = [];
    state.sort = [];
    state.aggregates = {};
    state.plugin = "Datagrid";
    markActiveView();
    await applyConfig(buildViewConfig(specFor("Datagrid")));
    renderShelves();
    renderRules();
    renderFieldList();
    toast("View reset to the flat grid.", "info");
}

/* ------------------------------------------------------------- KPI panel */

function renderKpiList(profile) {
    const host = $("kpiList");
    state.fields = profile.fields || [];
    state.schema = state.fields.map((f) => f.name);
    state.numeric = state.fields
        .filter((f) => f.kind === "number")
        .map((f) => f.name);
    state.categorical = state.fields
        .filter(
            (f) =>
                f.kind === "string" ||
                f.kind === "category" ||
                f.kind === "datetime"
        )
        .map((f) => f.name);
    state.dates = state.fields
        .filter((f) => f.kind === "datetime")
        .map((f) => f.name);

    $("kpiTag").textContent = `${state.fields.length} KPIs`;

    if (!state.fields.length) {
        host.innerHTML = '<div class="panel-empty">No columns found.</div>';
        return;
    }

    host.innerHTML = state.fields
        .map((f) => {
            const badge = KIND_BADGE[f.kind] || "badge-string";
            const hasIssue = f.anomalies.length > 0;
            const missingTxt = f.missing
                ? `${f.missing} missing (${f.missing_pct}%)`
                : "no missing";

            return `
            <div class="kpi-item${hasIssue ? " has-issue" : ""}"
                 data-name="${escapeHtml(f.name)}" tabindex="0">
                <div class="kpi-top">
                    <span class="kpi-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
                    <span class="badge ${badge}">${escapeHtml(f.kind)}</span>
                </div>
                <div class="kpi-meta">
                    <span>${escapeHtml(f.dtype)}</span>
                    <span${f.missing ? ' class="warn"' : ""}>${escapeHtml(missingTxt)}</span>
                    <span><b>${escapeHtml(f.unique)}</b> distinct</span>
                </div>
            </div>`;
        })
        .join("");

    host.querySelectorAll(".kpi-item").forEach((item) => {
        const pick = () => selectKpi(item.dataset.name);
        item.addEventListener("click", pick);
        item.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                pick();
            }
        });
    });
}

function selectKpi(name) {
    const field = state.fields.find((f) => f.name === name);
    if (!field) return;
    state.selectedKpi = name;

    document.querySelectorAll(".kpi-item").forEach((el) => {
        el.classList.toggle("is-selected", el.dataset.name === name);
    });

    const s = field.stats || {};
    const rows = [
        ["Data type", field.dtype],
        ["Kind", field.kind],
        ["Missing values", `${field.missing} (${field.missing_pct}%)`],
        ["Distinct values", field.unique],
    ];

    if (field.kind === "number") {
        if (s.min !== undefined && s.min !== null) rows.push(["Min", s.min]);
        if (s.max !== undefined && s.max !== null) rows.push(["Max", s.max]);
        if (s.mean !== undefined && s.mean !== null) rows.push(["Mean", s.mean]);
        if (s.sum !== undefined && s.sum !== null) rows.push(["Sum", s.sum]);
    } else if (field.sample !== null && field.sample !== undefined) {
        rows.push(["Sample", field.sample]);
    }

    const issues = field.anomalies.length
        ? field.anomalies.map((a) => `<li>${escapeHtml(a)}</li>`).join("")
        : '<li class="ok">No anomalies detected</li>';

    $("kpiDetail").innerHTML = `
        <div class="kpi-name" style="margin-bottom:10px">${escapeHtml(field.name)}</div>
        <dl>
            ${rows
                .map(
                    ([k, v]) =>
                        `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`
                )
                .join("")}
        </dl>
        <ul class="issue-list">${issues}</ul>`;

    // Keep the detail in view: the explorer list is the part that scrolls.
    const detail = $("kpiDetail");
    if (detail.scrollIntoView) {
        detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
}

/* --------------------------------------------------- dataset summary */

const NUMBER_FMT = new Intl.NumberFormat(undefined);

function humanBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = Number(bytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function shortDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

/**
 * Build the Dataset summary tiles. Tiles are added only when the profile
 * actually contains the relevant information, so the panel stays honest for
 * every shape of input.
 */
function renderSummary(profile) {
    const tiles = [];
    const add = (label, value, hint, alert) =>
        tiles.push({ label, value, hint, alert: Boolean(alert) });

    add("Rows", NUMBER_FMT.format(profile.rows || 0), "after restructuring");
    add(
        "Columns",
        NUMBER_FMT.format(profile.cols || 0),
        `${profile.numeric_cols || 0} numeric · ${profile.text_cols || 0} text`
    );

    if (profile.cells) {
        add("Cells", NUMBER_FMT.format(profile.cells), "values inspected");
    }
    add(
        "Missing cells",
        NUMBER_FMT.format(profile.missing_cells || 0),
        `${profile.missing_pct || 0}% of dataset`,
        profile.missing_cells > 0
    );
    if (profile.complete_cols !== undefined) {
        add(
            "Complete columns",
            NUMBER_FMT.format(profile.complete_cols),
            "no gaps at all"
        );
    }
    if (profile.duplicate_rows) {
        add(
            "Duplicate rows",
            NUMBER_FMT.format(profile.duplicate_rows),
            "consider removing",
            true
        );
    }
    if (profile.constant_cols) {
        add(
            "Single-value columns",
            NUMBER_FMT.format(profile.constant_cols),
            "no variation",
            true
        );
    }
    if (profile.outlier_cols) {
        add(
            "Columns with outliers",
            NUMBER_FMT.format(profile.outlier_cols),
            "IQR rule",
            true
        );
    }
    if (profile.flagged_fields) {
        add(
            "Flagged columns",
            NUMBER_FMT.format(profile.flagged_fields),
            "review anomalies",
            true
        );
    }
    if (profile.date_cols) {
        add("Date columns", NUMBER_FMT.format(profile.date_cols), "parsed as dates");
    }
    if (profile.date_min) {
        add("First date", shortDate(profile.date_min), "earliest record");
    }
    if (profile.date_max) {
        add("Last date", shortDate(profile.date_max), "latest record");
    }
    if (profile.numeric_cols) {
        add("Numeric columns", NUMBER_FMT.format(profile.numeric_cols), "measurable");
    }
    if (profile.text_cols) {
        add("Text columns", NUMBER_FMT.format(profile.text_cols), "groupable");
    }
    if (profile.memory_bytes) {
        add("In memory", humanBytes(profile.memory_bytes), "cleaned frame");
    }
    if (profile.file_bytes) {
        // The header is bare now, so the file name lives here.
        add("Source file", humanBytes(profile.file_bytes),
            profile.filename || "as uploaded");
    }

    $("summaryTag").textContent = `${tiles.length} measures`;
    $("summaryStats").innerHTML = tiles
        .map(
            (t) => `
        <div class="stat${t.alert ? " alert" : ""}">
            <div class="stat-label">${escapeHtml(t.label)}</div>
            <div class="stat-value">${escapeHtml(t.value)}</div>
            ${t.hint ? `<div class="stat-hint">${escapeHtml(t.hint)}</div>` : ""}
        </div>`
        )
        .join("");

}

async function loadKpis() {
    const resp = await fetch("/api/kpis");
    if (!resp.ok) throw new Error("Could not load KPI metadata.");
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || "KPI request failed.");
    state.profile = data.profile;
    renderKpiList(data.profile);
    renderSummary(data.profile);
    return data.profile;
}

/* ----------------------------------------------------------- Perspective */

async function loadPerspective() {
    const viewer = $("viewer");

    const resp = await fetch("/api/data");
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Could not download the dataset.");
    }
    const arrow = await resp.arrayBuffer();

    const worker = await perspective.worker();
    await worker.table(arrow, { name: TABLE_NAME });
    state.worker = worker;
    paintViewer(viewer, state.palette || PALETTES[0].colors);

    // Keep our own config in step with whatever the user builds in the
    // viewer's Pivot panel, so switching views never resets their work.
    attachViewerEvents(viewer);

    // v5: bind the Client, then let restore() select the table and its config
    // in one atomic render.
    await viewer.load(worker);

    const initial = buildViewConfig(specFor("Datagrid"));
    await viewer.restore(initial);
    styleSurfaces();
    setStatus("Ready");
    state.ready = true;
}

/* --------------------------------------------------------------- export */

function viewConfigFrom(full) {
    const out = {};
    VIEW_CONFIG_KEYS.forEach((k) => {
        if (full && full[k] !== undefined) out[k] = full[k];
    });
    return out;
}

function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function filenameFromHeaders(resp, fallback) {
    const cd = resp.headers.get("Content-Disposition") || "";
    const match = /filename="?([^";]+)"?/i.exec(cd);
    return match ? match[1] : fallback;
}

/* Matches EXCEL_CELL_BUDGET in app.py: beyond this a workbook takes minutes
   to write, so the view is handed over as CSV instead. */
const EXCEL_CELL_BUDGET = 500000;

async function downloadTable() {
    const viewer = $("viewer");
    const table = await viewer.getTable();
    if (!table) throw new Error("The dataset is not ready yet.");

    const cfg = viewConfigFrom(await viewer.save());
    const view = await table.view(cfg);
    let arrow;
    let rows = 0;
    let cols = 0;
    try {
        rows = await view.num_rows();
        cols = await view.num_columns();
        arrow = await view.to_arrow();
    } finally {
        try {
            await view.delete();
        } catch (_err) {
            /* view already gone */
        }
    }
    if (!arrow || !arrow.byteLength || !rows) {
        throw new Error("The current view has no rows to export.");
    }

    const cells = rows * Math.max(1, cols);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    // The workbook carries the table's colours, so a download looks like what
    // was on screen.
    const primary = (state.palette || PALETTES[0].colors)[0] || "#db0011";
    const themeQuery = `?primary=${encodeURIComponent(primary)}`;

    if (cells > EXCEL_CELL_BUDGET) {
        // v5 can serialise the current view to CSV itself, which avoids posting
        // a very large Arrow buffer back to the server just to be re-encoded.
        let csv = null;
        if (typeof viewer.export === "function") {
            try {
                csv = await viewer.export();
            } catch (_err) {
                csv = null;
            }
        }
        if (typeof csv === "string" && csv.length) {
            saveBlob(new Blob([csv], { type: "text/csv" }), `view-${stamp}.csv`);
        } else {
            const resp = await fetch("/api/export/csv", {
                method: "POST",
                headers: { "Content-Type": "application/vnd.apache.arrow.stream" },
                body: arrow,
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || "The export could not be built.");
            }
            saveBlob(await resp.blob(), filenameFromHeaders(resp, "view.csv"));
        }
        toast(
            `${NUMBER_FMT.format(rows)} rows is too large for a quick Excel ` +
                "write, so it downloaded as CSV — Excel opens that directly.",
            "info"
        );
        return;
    }

    const resp = await fetch("/api/export/xlsx" + themeQuery, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.apache.arrow.stream" },
        body: arrow,
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "The export could not be built.");
    }
    saveBlob(await resp.blob(), filenameFromHeaders(resp, "view.xlsx"));
}

/**
 * The active plugin element lives in the viewer's light DOM. Match any
 * perspective-viewer-* element that is not the datagrid, so this keeps working
 * whichever chart engine the bundle ships (d3fc in v3, charts in v5).
 */
function activeChartElement() {
    return [...$("viewer").children].find((el) => {
        const tag = el.tagName.toLowerCase();
        return tag.startsWith("perspective-viewer-") && !tag.includes("datagrid");
    });
}

/**
 * Rasterise the current chart.
 *
 * v5's chart engine renders to GPU-backed <canvas> elements inside the plugin's
 * shadow root (there is no SVG any more), so the chart is composited by drawing
 * each laid-out canvas onto one bitmap at its own offset.
 */
async function downloadPng() {
    const pluginEl = activeChartElement();
    if (!pluginEl || !pluginEl.shadowRoot) {
        throw new Error("This view has no chart to export.");
    }

    const box = pluginEl.getBoundingClientRect();
    const scale = 2;
    // Axis labels and the legend can sit just outside the plugin box, so the
    // canvas is padded and everything is drawn relative to that margin.
    const MARGIN = 72;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((box.width + MARGIN * 2) * scale));
    canvas.height = Math.max(1, Math.round((box.height + MARGIN * 2) * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const surfaces = [...pluginEl.shadowRoot.querySelectorAll("canvas")]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 2 && r.height > 2);

    if (!surfaces.length) throw new Error("This view has no chart to export.");

    for (const { el, r } of surfaces) {
        ctx.drawImage(
            el,
            (r.left - box.left + MARGIN) * scale,
            (r.top - box.top + MARGIN) * scale,
            r.width * scale,
            r.height * scale
        );
    }

    const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed."))),
            "image/png"
        )
    );
    const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-");
    saveBlob(blob, `${state.plugin.replace(/[^\w]+/g, "-")}-${stamp}.png`);
}

async function downloadCurrentView() {
    const btn = $("downloadBtn");
    if (!state.ready || btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
        if (state.plugin === "Datagrid") {
            await downloadTable();
        } else {
            await downloadPng();
            toast("Chart image downloaded.", "success");
        }
    } catch (err) {
        toast(err.message || String(err), "error");
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
}

/* ------------------------------------------------------------------- chat */

const CHAT_STORE_KEY = "cpa.chat.config.v1";

/* Credentials live only in this browser's localStorage, and go straight from
   this page to the endpoint the user names — never to this app's server. */
function readChatConfig() {
    return {
        endpoint: ($("chatEndpoint").value || "").trim(),
        api_key: ($("chatKey").value || "").trim(),
        model: ($("chatModel").value || "").trim(),
    };
}

/**
 * v5's agent wants a full chat-completions URL, while people naturally type a
 * base URL. Accept either: anything already ending in /chat/completions is used
 * as-is, and a bare base gets the path appended.
 */
function chatEndpointUrl(endpoint) {
    const url = (endpoint || "").trim().replace(/\/+$/, "");
    if (!url) return url;
    if (/\/chat\/completions$/.test(url)) return url;
    return `${url}/chat/completions`;
}

function chatHasCredentials() {
    const cfg = readChatConfig();
    return Boolean(cfg.endpoint && cfg.api_key);
}

/**
 * Report the assistant's real state. Saving a key is not the same as having a
 * working model, so the label only claims "connected" once a reply has
 * actually come back.
 */
function setChatMode() {
    const configured = chatHasCredentials();
    let label;
    let chip;
    let note;
    let live;

    if (!configured) {
        live = false;
        label = "No model connected";
        chip = "No model";
        note =
            "No model connected — add an endpoint and API key above to start " +
            "asking questions.";
    } else if (state.chatVerified === true) {
        live = true;
        label = "Model connected";
        chip = "Connected";
        note =
            "Connected. The assistant reads this dataset and can build pivots " +
            "and charts for you. A stronger tool-calling model drives it more " +
            "reliably — data leaves this machine only if the endpoint above is " +
            "remote.";
    } else if (state.chatVerified === false) {
        live = false;
        label = "Connection failed";
        chip = "Failed";
        note =
            state.chatError ||
            "The endpoint could not be reached. Check the URL and the API key.";
    } else {
        live = false;
        label = "Model configured — not verified";
        chip = "Not verified";
        note =
            "A model is configured but has not answered yet. Send a question " +
            "to confirm the connection works.";
    }

    $("chatMode").textContent = label;
    $("chatMode").classList.toggle("is-live", live);

    const chipEl = $("aiState");
    if (chipEl) {
        chipEl.textContent = chip;
        $("chatToggle").classList.toggle("is-live", live);
    }

    const status = $("chatStatus");
    if (status) {
        status.classList.toggle("is-live", live);
        status.textContent = note;
    }

    // The connection form is the useful thing to show until a model works.
    const toggle = document.querySelector("#chatConnection .group-toggle");
    const panel = $("grpConnection");
    if (toggle && panel && state.chatVerified !== true) {
        toggle.setAttribute("aria-expanded", "true");
        panel.hidden = false;
    }
}

function loadChatConfig() {
    let cfg = null;
    try {
        const raw = localStorage.getItem(CHAT_STORE_KEY);
        if (raw) cfg = JSON.parse(raw);
    } catch (_err) {
        /* private mode or corrupt value — start clean */
    }
    if (cfg && typeof cfg === "object") {
        $("chatEndpoint").value = cfg.endpoint || "";
        $("chatKey").value = cfg.api_key || "";
        $("chatModel").value = cfg.model || "";
    }
    setChatMode();
}

function saveChatConfig() {
    try {
        localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(readChatConfig()));
    } catch (_err) {
        /* storage unavailable — the live values still work this session */
    }
}

function clearChatConfig() {
    try {
        localStorage.removeItem(CHAT_STORE_KEY);
    } catch (_err) {
        /* nothing to clear */
    }
    $("chatEndpoint").value = "";
    $("chatKey").value = "";
    $("chatModel").value = "";
    setChatMode();
}

function initChat() {
    const dock = $("chatDock");
    const toggle = $("chatToggle");
    const layout = $("dashLayout");
    const body = $("chatBody");
    const input = $("chatInput");

    loadChatConfig();

    const setOpen = (open) => {
        dock.hidden = !open;
        layout.classList.toggle("chat-open", open);
        // The button stays put and becomes the toggle, rather than stepping
        // aside — it now lives in the command bar, not over the table.
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.title = open ? "Close the AI Data Assistant"
                            : "Open the AI Data Assistant";
        if (open) {
            setChatMode();
            input.focus();
        }
    };

    toggle.addEventListener("click", () => setOpen(dock.hidden));
    $("chatClose").addEventListener("click", () => setOpen(false));

    ["chatEndpoint", "chatKey", "chatModel"].forEach((id) =>
        $(id).addEventListener("input", setChatMode)
    );
    $("chatSaveCfg").addEventListener("click", () => {
        saveChatConfig();
        // A new endpoint or key invalidates whatever we knew before.
        state.chatVerified = null;
        state.chatError = "";
        setChatMode();
        toast(
            chatHasCredentials()
                ? "Saved. Send a question to confirm the connection works."
                : "Add both an endpoint and an API key to connect.",
            chatHasCredentials() ? "success" : "warn"
        );
    });
    $("chatClearCfg").addEventListener("click", clearChatConfig);

    function addMessage(text, who) {
        const div = document.createElement("div");
        div.className = "msg msg-" + who;
        div.textContent = text;
        body.appendChild(div);
        body.scrollTop = body.scrollHeight;
        return div;
    }

    async function send() {
        const query = input.value.trim();
        if (!query) return;
        input.value = "";

        addMessage(query, "user");
        const typing = document.createElement("div");
        typing.className = "msg msg-typing";
        typing.textContent = "Thinking…";
        body.appendChild(typing);
        body.scrollTop = body.scrollHeight;

        const cfg = readChatConfig();
        // Keep whatever the user typed so it survives a reload.
        if (cfg.endpoint || cfg.api_key || cfg.model) saveChatConfig();

        try {
            // v5 ships the assistant: point it at the endpoint and ask. It is a
            // tool-calling agent, so it reads the schema and can reconfigure the
            // view itself — the answer can be a pivot, not just prose.
            const viewer = $("viewer");
            viewer.agentConfig({
                url: chatEndpointUrl(cfg.endpoint),
                apiKey: cfg.api_key || "",
                model: cfg.model || "default",
            });
            const reply = await viewer.agentPrompt(query);

            typing.remove();
            state.chatVerified = true;
            state.chatError = "";
            setChatMode();

            const text = typeof reply === "string" ? reply : String(reply ?? "");
            addMessage(text.trim() || "(the model returned an empty reply)", "bot");

            // The agent may have reconfigured the view; perspective-config-update
            // fires for that, so the toolbar is already back in step.
        } catch (err) {
            typing.remove();
            state.chatVerified = false;
            state.chatError = (err && err.message) || "The model did not answer.";
            setChatMode();
            addMessage(state.chatError, "bot");
        }
    }

    $("chatSend").addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") send();
    });
}

/* ------------------------------------------------------------------- boot */

/**
 * Last line of defence: if the d3fc plugin throws while drawing on its own
 * (for example after the user drags an impossible combination into an X/Y
 * chart), rebuild the viewer so the page never has to be reloaded.
 */
let recovering = false;
let lastRecovery = 0;

function looksLikePluginCrash(reason) {
    const text = (reason && (reason.stack || reason.message)) || String(reason || "");
    return (
        /perspective-viewer-(charts|d3fc)/.test(text) &&
        /reading '|is not a function|of undefined|of null/.test(text)
    );
}

async function selfHeal(reason) {
    if (recovering || !state.ready) return;
    if (Date.now() - lastRecovery < 5000) return;
    recovering = true;
    lastRecovery = Date.now();
    try {
        await rebuildViewer();
        setStatus("Ready");
        toast(
            "That combination could not be drawn, so the grid was restored. " +
                "Reason: " + ((reason && reason.message) || reason),
            "warn"
        );
    } catch (_err) {
        /* nothing more we can do automatically */
    } finally {
        recovering = false;
    }
}

window.addEventListener("unhandledrejection", (event) => {
    if (looksLikePluginCrash(event.reason)) selfHeal(event.reason);
});
window.addEventListener("error", (event) => {
    if (looksLikePluginCrash(event.error || event.message)) {
        selfHeal(event.error || event.message);
    }
});

async function main() {
    window.CPA.initCollapsibles();
    window.CPA.initGroupBar();
    initChat();
    markActiveView();

    state.palette = loadPalette();
    initPalette();

    try {
        await loadKpis();
        buildToolbar();
        initFields();
        initResizer();
        // The fields pane is where the report is built, so it starts open —
        // the same way Excel's PivotTable Fields does.
        $("fieldsBtn").click();
        await renderViewSelect();
        await loadPerspective();
        renderFieldList();
        renderShelves();
        renderRules();
        window.CPA.enhanceSelects();
    } catch (err) {
        fail(err && err.message ? err.message : String(err));
    }
}

main();
