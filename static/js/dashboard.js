/**
 * OnDemandPivot — dashboard controller.
 *
 * Loads the Pandas frame (served as Apache Arrow IPC streaming bytes) into a
 * Perspective table, wires the pivot/chart toolbar to <perspective-viewer>,
 * renders the KPI side panel from /api/kpis, and drives the AI chat.
 *
 * Perspective v3.8.0 ESM bundles self-initialise their WebAssembly assets
 * relative to their own CDN URL, so no manual init_server()/init_client()
 * calls are required here.
 */

import perspective from "https://cdn.jsdelivr.net/npm/@finos/perspective@3.8.0/dist/cdn/perspective.js";
import "https://cdn.jsdelivr.net/npm/@finos/perspective-viewer@3.8.0/dist/cdn/perspective-viewer.js";
import "https://cdn.jsdelivr.net/npm/@finos/perspective-viewer-datagrid@3.8.0/dist/cdn/perspective-viewer-datagrid.js";
import "https://cdn.jsdelivr.net/npm/@finos/perspective-viewer-d3fc@3.8.0/dist/cdn/perspective-viewer-d3fc.js";

const toast = (msg, kind) => window.CPA.toast(msg, kind);
const escapeHtml = window.CPA.escapeHtml;

/* ------------------------------------------------------------------ state */

const state = {
    plugin: "Datagrid",
    // The live view configuration. These mirror whatever the user has built in
    // Perspective's own Pivot panel, so switching views never discards work.
    groupBy: [],
    splitBy: [],
    columns: [],
    filter: [],
    sort: [],
    fields: [],        // [{name, kind, ...}] from /api/kpis
    schema: [],        // raw column names in frame order
    numeric: [],       // subset of schema
    categorical: [],   // string/category/date columns — chart grouping axes
    selectedKpi: null,
    registered: [],    // plugin names Perspective actually exposes
    profile: null,
    ready: false,
    table: null,       // the Perspective table, kept for viewer rebuilds
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
];

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
    if (el) el.textContent = text;
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
}

function markActiveView() {
    const select = $("viewSelect");
    if (select && state.registered.includes(state.plugin)) {
        select.value = state.plugin;
    }
    const dl = $("downloadBtn");
    if (dl) {
        dl.textContent =
            state.plugin === "Datagrid" ? "Download Excel" : "Download PNG";
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
    const all = state.schema;

    fillSelect($("groupBy"), all, "— none —");
    fillSelect($("splitBy"), all, "— none —");
    fillSelect($("measure"), state.numeric.length ? state.numeric : all, "— all —");

    $("groupBy").addEventListener("change", async (e) => {
        state.groupBy = e.target.value ? [e.target.value] : [];
        await refreshView();
    });

    $("splitBy").addEventListener("change", async (e) => {
        state.splitBy = e.target.value ? [e.target.value] : [];
        await refreshView();
    });

    $("measure").addEventListener("change", async (e) => {
        state.columns = e.target.value ? [e.target.value] : [];
        await refreshView();
    });

    $("settingsBtn").addEventListener("click", async () => {
        try {
            await $("viewer").toggleConfig();
        } catch (_err) {
            /* panel may already be in the requested state */
        }
    });

    $("resetBtn").addEventListener("click", resetView);
    $("downloadBtn").addEventListener("click", downloadCurrentView);
}

/** Push the live Perspective config back into our toolbar controls. */
function syncToolbarFromConfig(cfg) {
    if (!cfg) return;
    state.groupBy = Array.isArray(cfg.group_by) ? cfg.group_by : [];
    state.splitBy = Array.isArray(cfg.split_by) ? cfg.split_by : [];
    state.columns = Array.isArray(cfg.columns) ? cfg.columns : [];
    state.filter = Array.isArray(cfg.filter) ? cfg.filter : [];
    state.sort = Array.isArray(cfg.sort) ? cfg.sort : [];

    const pick = (el, values) => {
        if (!el) return;
        const first = values[0] || "";
        const has = [...el.options].some((o) => o.value === first);
        el.value = has ? first : "";
    };
    pick($("groupBy"), state.groupBy);
    pick($("splitBy"), state.splitBy);
    pick($("measure"), state.columns.length === 1 ? state.columns : []);
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
    const group = state.groupBy.length ? state.groupBy : [];
    const groupAxis = group.length ? group : firstCategorical() ? [firstCategorical()] : [];
    const split = state.splitBy;

    if (spec.kind === "grid") {
        return {
            plugin: spec.plugin,
            group_by: group,
            split_by: split,
            columns: state.columns.length ? state.columns : state.schema.slice(),
            filter: state.filter,
            sort: state.sort,
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
            filter: state.filter,
            sort: state.sort,
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
            filter: state.filter,
            sort: state.sort,
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
            filter: state.filter,
            sort: state.sort,
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
            filter: state.filter,
            sort: state.sort,
        };
    }

    // "tree" (Treemap / Sunburst)
    return {
        plugin: spec.plugin,
        group_by: groupAxis,
        split_by: split,
        columns,
        filter: state.filter,
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
    viewer.addEventListener("perspective-config-update", (event) => {
        const cfg = event.detail;
        if (!cfg) return;
        if (cfg.plugin) state.plugin = cfg.plugin;
        syncToolbarFromConfig(cfg);
        markActiveView();
    });
}

/**
 * A bad chart config can leave the d3fc plugin permanently broken - further
 * restores keep failing until the page is reloaded. Rebuilding the element is
 * the only reliable way out, so the app heals itself instead of asking the
 * user to refresh.
 */
async function rebuildViewer() {
    const old = $("viewer");
    const fresh = document.createElement("perspective-viewer");
    fresh.id = "viewer";
    old.replaceWith(fresh);
    attachViewerEvents(fresh);

    if (state.table) {
        await fresh.load(state.table);
    }
    const safe = {
        plugin: "Datagrid",
        group_by: [],
        split_by: [],
        columns: state.schema.slice(),
        filter: [],
        sort: [],
    };
    await fresh.restore(safe);
    state.config = safe;
    state.plugin = "Datagrid";
    state.groupBy = [];
    state.splitBy = [];
    state.columns = state.schema.slice();
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
    $("groupBy").value = "";
    $("splitBy").value = "";
    $("measure").value = "";
    state.plugin = "Datagrid";
    markActiveView();
    await applyConfig(buildViewConfig(specFor("Datagrid")));
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
        add("Source file", humanBytes(profile.file_bytes), "as uploaded");
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

    const navMeta = $("navMeta");
    if (navMeta) {
        navMeta.textContent =
            `${NUMBER_FMT.format(profile.rows || 0)} rows × ` +
            `${NUMBER_FMT.format(profile.cols || 0)} cols · ` +
            `${profile.flagged_fields || 0} flagged` +
            (profile.file_bytes ? ` · ${humanBytes(profile.file_bytes)}` : "");
    }
    if (profile.filename) {
        const navFile = $("navFile");
        if (navFile) {
            navFile.textContent = profile.filename;
            navFile.title = profile.filename;
        }
    }
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
    const table = await worker.table(arrow);
    state.table = table;

    // Keep our own config in step with whatever the user builds in the
    // viewer's Pivot panel, so switching views never resets their work.
    attachViewerEvents(viewer);

    await viewer.load(table);

    const initial = buildViewConfig(specFor("Datagrid"));
    await viewer.restore(initial);
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

async function downloadExcel() {
    const viewer = $("viewer");
    const table = await viewer.getTable();
    if (!table) throw new Error("The dataset is not ready yet.");

    const cfg = viewConfigFrom(await viewer.save());
    const view = await table.view(cfg);
    let arrow;
    try {
        arrow = await view.to_arrow();
    } finally {
        try {
            await view.delete();
        } catch (_err) {
            /* view already gone */
        }
    }
    if (!arrow || !arrow.byteLength) {
        throw new Error("The current view has no rows to export.");
    }

    const resp = await fetch("/api/export/xlsx", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.apache.arrow.stream" },
        body: arrow,
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "The workbook could not be built.");
    }
    saveBlob(await resp.blob(), filenameFromHeaders(resp, "view.xlsx"));
}

/** The d3fc plugin element lives in the viewer's light DOM. */
function activeChartElement() {
    return [...$("viewer").children].find((el) =>
        el.tagName.toLowerCase().startsWith("perspective-viewer-d3fc")
    );
}

// Computed styles are copied onto the clone because the stylesheet rules that
// position and colour the chart do not travel with the SVG.
const SVG_STYLE_PROPS = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "letter-spacing",
    "text-anchor",
    "dominant-baseline",
    "alignment-baseline",
    "paint-order",
    "shape-rendering",
    "visibility",
];

function inlineSvgStyles(source, target) {
    const computed = getComputedStyle(source);
    let css = "";
    SVG_STYLE_PROPS.forEach((prop) => {
        const value = computed.getPropertyValue(prop);
        if (value) css += `${prop}:${value};`;
    });
    if (css) target.setAttribute("style", css);

    const src = source.children;
    const dst = target.children;
    for (let i = 0; i < src.length && i < dst.length; i += 1) {
        inlineSvgStyles(src[i], dst[i]);
    }
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Could not rasterise the chart."));
        img.src = src;
    });
}

async function downloadPng() {
    const pluginEl = activeChartElement();
    if (!pluginEl || !pluginEl.shadowRoot) {
        throw new Error("This view has no chart to export.");
    }

    const box = pluginEl.getBoundingClientRect();
    const scale = 2;
    // Legends and axis titles can sit just outside the plugin box, so the
    // canvas is padded and every piece is drawn relative to that margin.
    const MARGIN = 72;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((box.width + MARGIN * 2) * scale));
    canvas.height = Math.max(1, Math.round((box.height + MARGIN * 2) * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const svgs = [...pluginEl.shadowRoot.querySelectorAll("svg")].filter((s) => {
        const r = s.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
    });
    if (!svgs.length) throw new Error("This view has no chart to export.");

    // Axis tick labels routinely overflow the SVG box they belong to (the
    // browser shows that overflow because SVG defaults to `visible`). When a
    // lone SVG is rasterised, anything outside its own box is clipped, so each
    // one is re-rendered with padding and placed back at its true offset.
    const PAD = 64;

    for (const svg of svgs) {
        const r = svg.getBoundingClientRect();
        const clone = svg.cloneNode(true);
        inlineSvgStyles(svg, clone);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
        clone.setAttribute("overflow", "visible");
        clone.setAttribute("preserveAspectRatio", "xMinYMin meet");

        const box4 = (svg.getAttribute("viewBox") || "")
            .split(/[\s,]+/)
            .map(Number);
        const hasViewBox =
            box4.length === 4 && box4.every((n) => Number.isFinite(n));
        if (hasViewBox) {
            const [vx, vy, vw, vh] = box4;
            clone.setAttribute(
                "viewBox",
                `${vx - PAD} ${vy - PAD} ${vw + PAD * 2} ${vh + PAD * 2}`
            );
        }
        clone.setAttribute("width", String(r.width + PAD * 2));
        clone.setAttribute("height", String(r.height + PAD * 2));

        const markup = new XMLSerializer().serializeToString(clone);
        const url =
            "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
        const img = await loadImage(url);
        ctx.drawImage(
            img,
            (r.left - box.left - PAD + MARGIN) * scale,
            (r.top - box.top - PAD + MARGIN) * scale,
            (r.width + PAD * 2) * scale,
            (r.height + PAD * 2) * scale
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
            await downloadExcel();
            toast("Workbook downloaded.", "success");
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

/* Credentials live only in this browser's localStorage and are sent to the
   local Flask proxy — never anywhere else, and never written server-side. */
function readChatConfig() {
    return {
        endpoint: ($("chatEndpoint").value || "").trim(),
        api_key: ($("chatKey").value || "").trim(),
        model: ($("chatModel").value || "").trim(),
    };
}

function chatHasCredentials() {
    const cfg = readChatConfig();
    return Boolean(cfg.endpoint && cfg.api_key);
}

function setChatMode() {
    const live = chatHasCredentials();

    $("chatMode").textContent = live ? "Model connected" : "No model connected";
    $("chatMode").classList.toggle("is-live", live);

    const state = $("aiState");
    if (state) {
        state.textContent = live ? "Connected" : "No model";
        $("chatToggle").classList.toggle("is-live", live);
    }

    const status = $("chatStatus");
    if (status) {
        status.classList.toggle("is-live", live);
        status.textContent = live
            ? "Connected. Answers come from your endpoint — data leaves this " +
              "machine only if that endpoint is remote."
            : "No model connected — add an endpoint and API key above to start " +
              "asking questions.";
    }

    // The connection form is the useful thing to show until a model is set up.
    const toggle = document.querySelector("#chatConnection .group-toggle");
    const panel = $("grpConnection");
    if (toggle && panel && !live) {
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
        toggle.classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
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
        setChatMode();
        toast(
            chatHasCredentials()
                ? "Connection saved for this browser."
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
            const resp = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query,
                    endpoint: cfg.endpoint,
                    api_key: cfg.api_key,
                    model: cfg.model,
                }),
            });
            const data = await resp.json().catch(() => ({}));
            typing.remove();
            addMessage(
                data.success ? data.reply : data.error || "Something went wrong.",
                "bot"
            );
        } catch (err) {
            typing.remove();
            addMessage("Could not reach the local server.", "bot");
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
        text.indexOf("perspective-viewer-d3fc") >= 0 &&
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
    initChat();
    markActiveView();

    try {
        await loadKpis();
        buildToolbar();
        await renderViewSelect();
        await loadPerspective();
    } catch (err) {
        fail(err && err.message ? err.message : String(err));
    }
}

main();
