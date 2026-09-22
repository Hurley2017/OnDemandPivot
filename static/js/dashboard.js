/**
 * OnDemandPivot — dashboard controller.
 *
 * Loads the Pandas frame (served as Apache Arrow IPC streaming bytes) into a
 * Perspective table, wires the pivot/chart toolbar to <perspective-viewer>,
 * renders the KPI side panel from /api/kpis, and drives the placeholder chat.
 *
 * Perspective v3.8.0 ESM bundles self-initialise their WebAssembly assets
 * relative to their own CDN URL, so no manual init_server()/init_client()
 * calls are required here.
 */

import perspective from "https://cdn.jsdelivr.net/npm/@finos/perspective@3.8.0/dist/cdn/perspective.js";
import "https://cdn.jsdelivr.net/npm/@finos/perspective-viewer@3.8.0/dist/cdn/perspective-viewer.js";
import "https://cdn.jsdelivr.net/npm/@finos/perspective-viewer-datagrid@3.8.0/dist/cdn/perspective-viewer-datagrid.js";
import "https://cdn.jsdelivr.net/npm/@finos/perspective-viewer-d3fc@3.8.0/dist/cdn/perspective-viewer-d3fc.js";

/* ------------------------------------------------------------------ state */

const state = {
    plugin: "Datagrid",
    groupBy: "",
    splitBy: "",
    measure: "",
    fields: [],        // [{name, kind, ...}] from /api/kpis
    schema: [],        // raw column names in frame order
    numeric: [],       // subset of schema
    categorical: [],   // string/category/date columns — chart grouping axes
    selectedKpi: null,
    registered: [],    // plugin names Perspective actually exposes
    config: null,      // last successfully applied, complete view config
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
    { label: "Grid", plugin: "Datagrid", kind: "grid" },
    { label: "Bar", plugin: "Y Bar", kind: "chart" },
    { label: "Column", plugin: "X Bar", kind: "chart" },
    { label: "Line", plugin: "Y Line", kind: "chart" },
    { label: "Area", plugin: "Y Area", kind: "chart" },
    { label: "Scatter", plugin: "Y Scatter", kind: "chart" },
    { label: "Scatter XY", plugin: "X/Y Scatter", kind: "xy" },
    { label: "Line XY", plugin: "X/Y Line", kind: "xy" },
    { label: "Heatmap", plugin: "Heatmap", kind: "heatmap" },
    { label: "Treemap", plugin: "Treemap", kind: "tree" },
    { label: "Sunburst", plugin: "Sunburst", kind: "tree" },
    { label: "OHLC", plugin: "OHLC", kind: "ohlc" },
    { label: "Candles", plugin: "Candlestick", kind: "ohlc" },
];

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

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function fail(message) {
    const box = $("loadError");
    box.className = "notice notice-error";
    box.textContent = message;
    box.hidden = false;
    const status = $("viewerStatus");
    if (status) status.textContent = "Error";
}

/* Recoverable notice (e.g. a chart that cannot be built from this dataset). */
function note(message) {
    const box = $("loadError");
    box.className = "notice notice-info";
    box.textContent = message;
    box.hidden = false;
}

function clearNotice() {
    const box = $("loadError");
    box.hidden = true;
    box.textContent = "";
}

const KIND_BADGE = {
    number: "badge-number",
    string: "badge-string",
    datetime: "badge-datetime",
    boolean: "badge-boolean",
    category: "badge-string",
    timedelta: "badge-datetime",
};

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

async function renderViewSwitch() {
    const host = $("viewSwitch");
    state.registered = await getRegisteredPlugins();

    // Only offer views that Perspective actually registered *and* that we
    // know how to configure safely.
    let views = VIEW_SPECS.filter((v) => state.registered.includes(v.plugin));
    if (!views.length) views = [VIEW_SPECS[0]];

    host.innerHTML = views
        .map(
            (v) => `
        <button class="view-btn${v.plugin === state.plugin ? " is-active" : ""}"
                type="button" role="tab"
                data-plugin="${escapeHtml(v.plugin)}">${escapeHtml(v.label)}</button>`
        )
        .join("");

    host.querySelectorAll(".view-btn").forEach((btn) => {
        btn.addEventListener("click", () => selectView(btn.dataset.plugin));
    });
}

function markActiveView() {
    document.querySelectorAll(".view-btn").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.plugin === state.plugin);
    });
}

function firstCategorical() {
    return state.categorical[0] || null;
}

/**
 * Resolve a complete Perspective config for `spec`, or `null` when the
 * dataset cannot support that view. Never returns a partial config.
 */
function buildViewConfig(spec) {
    const group = state.groupBy || firstCategorical();
    const measure = state.measure ? [state.measure] : null;

    if (spec.kind === "grid") {
        return {
            plugin: spec.plugin,
            group_by: state.groupBy ? [state.groupBy] : [],
            split_by: state.splitBy ? [state.splitBy] : [],
            columns: measure || state.schema.slice(),
            filter: [],
            sort: [],
        };
    }

    // Every chart needs something to plot and something to group by.
    if (!state.numeric.length || !group) return null;

    const columns = measure || state.numeric.slice(0, 8);

    if (spec.kind === "chart") {
        return {
            plugin: spec.plugin,
            group_by: [group],
            split_by: state.splitBy ? [state.splitBy] : [],
            columns,
            filter: [],
            sort: [],
        };
    }

    if (spec.kind === "xy") {
        // X/Y plugins read the group_by axis as X, so prefer a numeric X and
        // keep the plotted measures distinct from it.
        const x = state.numeric.find((n) => !columns.includes(n)) || group;
        const ys = columns.filter((c) => c !== x);
        return {
            plugin: spec.plugin,
            group_by: [x],
            split_by: state.splitBy ? [state.splitBy] : [],
            columns: ys.length ? ys : columns,
            filter: [],
            sort: [],
        };
    }

    if (spec.kind === "heatmap") {
        const split =
            state.splitBy || state.categorical[1] || state.categorical[0] || "";
        return {
            plugin: spec.plugin,
            group_by: [group],
            split_by: split && split !== group ? [split] : [],
            columns: [columns[0]],
            filter: [],
            sort: [],
        };
    }

    if (spec.kind === "ohlc") {
        // OHLC / Candlestick need a date axis plus four measures.
        const dateField = state.fields.find((f) => f.kind === "datetime");
        if (!dateField || state.numeric.length < 4) return null;
        // Always four series, with the chosen measure first when there is one.
        const picked = measure
            ? [measure[0], ...state.numeric.filter((n) => n !== measure[0])]
            : state.numeric;
        return {
            plugin: spec.plugin,
            group_by: [dateField.name],
            split_by: [],
            columns: picked.slice(0, 4),
            filter: [],
            sort: [],
        };
    }

    // "tree" (Treemap / Sunburst)
    return {
        plugin: spec.plugin,
        group_by: [group],
        split_by: state.splitBy ? [state.splitBy] : [],
        columns,
        filter: [],
        sort: [],
    };
}

async function selectView(plugin) {
    const spec = specFor(plugin);
    const next = buildViewConfig(spec);

    if (!next) {
        note(
            `The “${spec.label}” view needs at least one numeric column and one ` +
                "groupable column. Add a measure or pick a Rows column first."
        );
        return;
    }

    state.plugin = plugin;
    markActiveView();
    if (spec.kind !== "grid" && next.group_by.length) {
        $("groupBy").value = next.group_by[0];
    }
    $("viewerStatus").textContent = "Applying…";
    await applyConfig(next);
}

/** Re-build and re-apply the current view (used by the toolbar selects). */
async function refreshView() {
    const next = buildViewConfig(specFor(state.plugin));
    if (!next) {
        note("That column choice cannot be plotted — pick a numeric column.");
        return;
    }
    await applyConfig(next);
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
    fillSelect(
        $("measure"),
        state.numeric.length ? state.numeric : all,
        "— all —"
    );

    $("groupBy").addEventListener("change", async (e) => {
        state.groupBy = e.target.value;
        await refreshView();
    });

    $("splitBy").addEventListener("change", async (e) => {
        state.splitBy = e.target.value;
        await refreshView();
    });

    $("measure").addEventListener("change", async (e) => {
        state.measure = e.target.value;
        await refreshView();
    });

    $("settingsBtn").addEventListener("click", async () => {
        const viewer = $("viewer");
        try {
            await viewer.toggleConfig();
        } catch (_err) {
            /* panel may already be in the requested state */
        }
    });

    $("resetBtn").addEventListener("click", resetView);
}

/**
 * Apply a *complete* config. On failure, roll back to the last good config so
 * the viewer never ends up on a broken canvas, and surface a notice instead of
 * a hard error.
 */
async function applyConfig(next) {
    const viewer = $("viewer");
    const previous = state.config;
    try {
        await viewer.restore(next);
        state.config = next;
        clearNotice();
        $("viewerStatus").textContent = "Ready";
        return true;
    } catch (err) {
        if (previous) {
            try {
                await viewer.restore(previous);
            } catch (_err) {
                /* the previous config is still on screen */
            }
        }
        $("viewerStatus").textContent = "View unavailable";
        note(
            "Could not apply that view: " +
                ((err && err.message) || String(err)) +
                " — reverted to the previous view."
        );
        return false;
    }
}

async function resetView() {
    state.plugin = "Datagrid";
    state.groupBy = "";
    state.splitBy = "";
    state.measure = "";
    $("groupBy").value = "";
    $("splitBy").value = "";
    $("measure").value = "";
    markActiveView();
    await applyConfig(buildViewConfig(specFor("Datagrid")));
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
        ? field.anomalies
              .map((a) => `<li>${escapeHtml(a)}</li>`)
              .join("")
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

function renderSummary(profile) {
    const tiles = [
        { label: "Rows", value: profile.rows },
        { label: "Columns", value: profile.cols },
        {
            label: "Missing cells",
            value: profile.missing_cells,
            hint: profile.missing_pct + "%",
            alert: profile.missing_pct > 0,
        },
        {
            label: "Flagged columns",
            value: profile.flagged_fields,
            alert: profile.flagged_fields > 0,
        },
    ];

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
    renderKpiList(data.profile);
    renderSummary(data.profile);
    return data.profile;
}

/* ------------------------------------------------------------- Perspective */

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

    await viewer.load(table);

    // Initial state: flat grid showing every column.
    const initial = buildViewConfig(specFor("Datagrid"));
    await viewer.restore(initial);
    state.config = initial;

    $("viewerStatus").textContent = "Ready";
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
    $("chatMode").textContent = live
        ? "Live model connected"
        : "Placeholder replies";
    $("chatHint").textContent = live
        ? "Live mode — answers come from the endpoint configured above."
        : "Placeholder mode — add an endpoint and API key for live answers.";
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
    const fab = $("chatFab");
    const panel = $("chatPanel");
    const body = $("chatBody");
    const input = $("chatInput");

    loadChatConfig();

    const open = () => {
        panel.hidden = false;
        fab.style.display = "none";
        setChatMode();
        input.focus();
    };
    const close = () => {
        panel.hidden = true;
        fab.style.display = "";
    };

    fab.addEventListener("click", open);
    $("chatClose").addEventListener("click", close);

    ["chatEndpoint", "chatKey", "chatModel"].forEach((id) =>
        $(id).addEventListener("input", setChatMode)
    );
    $("chatSaveCfg").addEventListener("click", () => {
        saveChatConfig();
        setChatMode();
        $("chatHint").textContent = chatHasCredentials()
            ? "Connection saved for this browser."
            : "Add both an endpoint and an API key to connect.";
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

async function main() {
    initChat();

    try {
        const profile = await loadKpis();
        buildToolbar();
        await renderViewSwitch();
        await loadPerspective();

        // Toolbar selects are populated from the KPI profile, so refresh the
        // "Values" list once Perspective has confirmed the schema.
        $("measure").value = "";
    } catch (err) {
        fail(err && err.message ? err.message : String(err));
    }

}

main();
