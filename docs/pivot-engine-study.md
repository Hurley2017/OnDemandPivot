# Is there anything better than Perspective for this application?

**A research study — no code changed.**
Prepared for review; implementation waits for your go-ahead.

---

## 1. What we are actually optimising for

Before comparing libraries, these are the constraints this project really has.
They rule out more options than any feature list does.

| # | Constraint | Why it matters here |
|---|---|---|
| C1 | **Fully offline**, no CDN, shipped inside one `.exe` | Every asset must be vendorable. A library that pulls tiles, fonts, workers or WASM from a CDN is out. |
| C2 | **No build step** — plain HTML/CSS/ESM served by Flask | We have no webpack/vite pipeline. Anything that needs bundling adds a Node toolchain to a Python project. |
| C3 | **Pivot + charts + drag-and-drop field configuration** | The core user promise: analysts drag fields and get a pivot or a chart. Building this ourselves is the expensive part. |
| C4 | **Up to ~500k rows** on an ordinary desktop | Verified: our current stack ingests 500k × 15 in ~3.5 s and renders it. |
| C5 | **Zero licence cost, permissive licence** | It is redistributed inside an internal tool. |
| C6 | **Business analysts, not developers** | The UI must be self-service; no SQL, no config files. |
| C7 | **Single-user, local, Windows** | No server-side rendering, no multi-tenant concerns. |

---

## 2. What we run today, honestly assessed

**Perspective 3.8.0** (`@finos/perspective*`), vendored under `static/vendor/`
(3.7 MB: 4 JS bundles + 3 stylesheets + 2 WASM modules), Apache-2.0.

### What it does genuinely well for us
- **Arrow ingestion straight from Pandas.** Our backend already speaks Arrow IPC; Perspective consumes it with no conversion. Nothing else in this list does that as cleanly.
- **Pivot *and* charts *and* the drag-and-drop field UI** in one component. That UI is the single biggest thing we did not have to build.
- **Performance.** 500k rows pivot and re-pivot instantly. WASM aggregation is the reason.
- **Free and Apache-2.0**, no per-seat cost, redistributable.
- **Offline-friendly** once vendored — proven, zero external requests.

### The friction we actually hit (all documented in our commits)
| Problem | Root cause | Our workaround |
|---|---|---|
| `Cannot read properties of null (reading 'opacity')` on every chart | `pro.css` defines the d3fc palette only under a `[theme="…"]` selector the viewer strips | We define the palette ourselves on the host element |
| `Cannot read properties of undefined (reading 'name')` on X/Y charts | d3fc needs two "main values"; one measure crashes it and **bricks the plugin** | Config validation + a self-healing viewer rebuild |
| Chart colours can't be changed live | d3fc caches its palette on first draw | Palette changes rebuild the whole viewer element |
| No image export | Not offered | Hand-rolled SVG → canvas rasteriser with style inlining |
| No CSV/Excel export of a view | Not offered | We call `view.to_arrow()` and build the workbook server-side |
| Config API is fiddly | `restore()` needs complete configs; partial patches misbehave | We always send full configs and track state ourselves |

**Pattern:** nearly every workaround exists because of **`viewer-d3fc`**, the charting plugin — not the grid or the pivot engine.

---

## 3. The headline finding: Perspective itself has moved on

This is the most important result of the study, and it is not what I expected.

Perspective is now a **member project of the OpenJS Foundation** and has been
renamed and re-versioned:

| | We use | Current |
|---|---|---|
| Package scope | `@finos/perspective*` | **`@perspective-dev/*`** |
| Version | 3.8.0 | **5.3.1** (Aug 2026) |
| Chart plugin | `viewer-d3fc` | **`viewer-charts`** — WebGL engine, 15+ chart types |
| Status | Legacy namespace | Actively developed |

Notable in v4/v5:
- **`viewer-charts` replaces the d3fc plugin entirely** — a WebGL charting engine with configurable legends, tooltips and configuration groups. Every single workaround in the table above traces to `viewer-d3fc`, so this directly addresses our worst pain.
- `viewer-datagrid` replaces the deprecated hypergrid package.
- Full theme support, tile-based geographic maps, React bindings.
- v4.5.2 added `page_to_disk` / OPFS disk-backed columns — relevant if datasets ever exceed browser memory.
- Still **Apache-2.0**, still WASM, still Arrow-native, still offline-vendorable.

**This is not a hypothetical improvement; it is the same product, five major versions further on, with the specific component we fight with replaced.**

---

## 4. The alternatives, evaluated against our constraints

Costs are list prices as published in 2026.

| Option | Licence / cost | Pivot UI included? | Charts | Offline fit | Effort to adopt | Verdict |
|---|---|---|---|---|---|---|
| **Perspective v5** (`@perspective-dev/*`) | Free, Apache-2.0 | **Yes** (drag & drop) | Yes — WebGL, 15+ | Excellent (same vendoring) | **Low–medium** — namespace, plugin names, theme/CSS, some API changes | **Strongest candidate** |
| **AG Grid Enterprise** + AG Charts Enterprise | **$999 / $1,498 per developer**, perpetual + 1 yr updates | Yes, but Enterprise-only | Yes, separate AG Charts licence | Good (npm, vendorable) | High — different data layer, we'd rewrite the dashboard | Best "enterprise grid" feel; costly per seat |
| **Flexmonster** | **from ~$799** (some sources ~$395/dev/mo) | Yes, pivot-first | Yes | Good | Medium–high | Strong pivot, commercial, another licence to manage |
| **WebDataRocks** | Free, incl. commercial | Yes | Basic | Good | Low | **Ruled out: 1 MB dataset cap** — three orders of magnitude short |
| **Handsontable** | ~$990–1,490/dev | Spreadsheet-first, pivot not the focus | No | Good | High | Wrong shape for us |
| **SpreadJS / Syncfusion / Kendo / Wijmo** | Suite licences | Yes (some) | Yes | Good | High | Only sensible if the org already owns the suite |
| **RevoGrid Pivot** | Free core, newer | Yes (grid-first) | Separate | Good | Medium | Young; pivot is newer and less proven |
| **DuckDB-WASM + a grid + a chart lib** | Free, MIT | **No — you build it** | Separate | Good but heavy: **~10–12 MB** gzipped base | **Very high** | Engine only. You would rebuild the pivot UI and charts yourself |
| **TanStack Table + custom pivot + ECharts** | Free, MIT | **No — you build it** | Yes | Excellent (all vendorable) | **Very high** | Maximum control, maximum work, no aggregation UI |
| **Glide Data Grid** | Free, MIT | No | No | Good | High | Fast canvas grid, nothing else |
| **PivotTable.js** | Free, MIT | Yes (basic) | No | Good | Low | Effectively unmaintained; small-data only |

### On DuckDB-WASM specifically
It keeps coming up as the "modern" answer, and it is genuinely excellent — but it
is a **SQL engine, not a user interface**. Choosing it means:
- shipping ~10–12 MB gzipped (≈3× our entire current vendor tree), and
- **building the drag-and-drop pivot builder, the aggregation UI and all charts ourselves**, plus wiring a separate grid and chart library.

That is a large amount of work to end up with something our analysts would find
less capable than what they have now. It is the right tool if the requirement
were "let power users write SQL locally", which it is not.

---

## 5. Recommendation

**Stay on Perspective. Upgrade to v5 (`@perspective-dev/*`) as the improvement path.**

Reasoning:
1. It is the only option that satisfies **all seven constraints** without spending money or building a pivot UI.
2. The specific component that caused **every** workaround we wrote — `viewer-d3fc` — has been **replaced** in v4/v5 by a different engine.
3. It keeps our biggest asset: **Arrow from Pandas straight into a pivot with no transformation**.
4. Migration is contained: our Perspective-specific code lives almost entirely in `static/js/dashboard.js` (view specs, config building, palette, export).

**If the organisation would rather pay than maintain:** AG Grid Enterprise at
$999/dev is the credible commercial alternative — a more conventional enterprise
grid with native Excel export and integrated charts. It is a **rewrite of the
dashboard**, not a swap, and adds a per-seat licence to an internal tool.

**I would not choose DuckDB-WASM or a hand-rolled TanStack pivot** for this
product: both mean building the analyst-facing pivot UI ourselves.

### Suggested sequence, when you give the word
1. **Spike (½–1 day):** vendor v5 into a scratch copy, confirm offline vendoring still works the same way, render one grid + one chart.
2. **Port (2–4 days):** update the four imports, plugin names, CSS/theme wiring and the palette code in `dashboard.js`.
3. **Retire workarounds:** delete the d3fc colour-cache rebuild and the SVG rasteriser if `viewer-charts` makes them unnecessary.
4. **Regression:** re-run the 13-view sweep and the export tests.

### Open questions I could not settle without building the spike
- Does v5's `viewer-charts` still cache its palette the way d3fc did? (Determines whether the palette rebuild goes away.)
- Does v5 expose a built-in image export? (Would let us delete the rasteriser.)
- Are the v5 CDN bundles still structured so `new URL("../wasm/…")` resolves inside a vendored tree?
- Exact v5 asset size — likely similar (~4 MB), possibly larger with the WebGL engine.

---

## 6. Recommendation summary

| | |
|---|---|
| **Nothing better exists for our constraints?** | Nothing *free* that includes the pivot UI. |
| **Is there a better version of what we have?** | **Yes — Perspective v5, same licence, better chart engine.** |
| **Best commercial alternative** | AG Grid Enterprise, $999/dev, but it is a rewrite. |
| **Best "modern" alternative** | DuckDB-WASM — but it is an engine, not a UI. |
| **My recommendation** | Upgrade Perspective to v5. Do not change vendors. |
| **Action now** | None — awaiting your signal. |
