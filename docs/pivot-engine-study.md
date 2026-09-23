# Is there anything better than Perspective for this application?

**Research study — revised 2026-09-24.** No code changed; implementation waits for
your go-ahead.

---

## 1. The constraints that actually decide this

These eliminate more options than any feature list does.

| # | Constraint | Consequence |
|---|---|---|
| C1 | **Fully offline**, no CDN, shipped inside one `.exe` | Every asset must be vendorable. Anything that phones home is out. |
| C2 | **No build step** — plain HTML/CSS/ESM served by Flask | Anything needing webpack/vite adds a Node toolchain to a Python project. |
| C3 | **Pivot + charts + drag-and-drop field UI** | Building this ourselves is the expensive part. |
| C4 | **~500k rows** on an ordinary desktop | Verified working today. |
| C5 | **Free, permissive licence, redistributed internally** | A per-seat licence on a tool you hand to colleagues is a compliance question, not just a cost. |
| C6 | **Business analysts, not developers** | Self-service only. |
| C7 | **Single-user, local, Windows** | No server-side rendering. |

---

## 2. The headline finding

**There is no better *product* for these constraints. There is a much better
*version* of the one we already use — and it fixes exactly the component we fight with.**

Perspective is now a **member project of the OpenJS Foundation**, renamed from
`@finos/*` to **`@perspective-dev/*`**, and is at **v5.3.1** (v5.0.0 shipped
July 2026). We are on **v3.8.0** — five major versions behind.

### What v5 changes that matters to us

| Change | Why it matters here |
|---|---|
| **`viewer-d3fc` is deleted**, replaced by `viewer-charts` | Every workaround we wrote traces to `viewer-d3fc`. That code path no longer exists. |
| Charts are **GPU-rendered** (GLSL shaders), **multithreaded** in a Web Worker, zero-copy Arrow | No main-thread stalls; render-warning threshold raised to **1,000,000 rows** |
| **`export` / `download` are now viewer methods** | We hand-rolled an SVG→canvas rasteriser and an Arrow→xlsx builder. v5 may make both unnecessary. |
| **`<perspective-viewer>` is now a workspace** | Multi-panel dashboards, drag-to-dock, master/detail cross-filtering built in — we would get this free |
| **Virtual Servers** for DuckDB / ClickHouse / Polars | Push-down SQL to a real engine, still driven by the same viewer UI |
| `page_to_disk` (OPFS in the browser) | Datasets larger than memory |
| Memory64 build | In-browser heap ceiling 4 GB → **16 GB** |
| 12 chart types + **Density** + **Maps** | Maps replace the separate openlayers package |
| **All CSS variables renamed** to `--psp-{module}--{component?}--{property}` | **Breaks our chart-palette fix** (see quirks) |

### The quirks — what would actually bite us

These are the migration notes that matter, taken from the official v5.0.0 release.

1. **`load()` now takes a `Client`, not a `Table`.**
   ```js
   // before
   const table = await worker.table(data);
   await viewer.load(table);
   // after
   await worker.table(data, { name: "my_table" });
   await viewer.load(worker);
   await viewer.restore({ ...config, table: "my_table" });
   ```
2. **Tables must be named.** An unnamed table gets a **random** name, which
   `save()` captures and which **will not exist after a page reload** — silently
   breaking `restore()`. **Duplicate table names now error** instead of
   overwriting. This is the sharpest edge in the whole migration for an app that
   saves and restores configs.
3. **All CSS variables renamed.** Our chart-palette workaround sets
   `--d3fc-series-*` on the host element. In v5 those become `--psp-*`. The
   *reason* we needed the workaround may also be gone — `viewer-charts` is a
   different engine — but this has to be re-verified, not assumed.
4. **Method signatures became options-dict**: `getSelection`, `getEditPort`,
   `export`, `download`, `copy`, `reset` now take an options object (which may
   carry a `panel` key).
5. **`leaves_only` → `group_rollup_mode`** (`"rollup"` | `"flat"` | `"total"`).
6. **`@perspective-dev/workspace` is removed** — merged into the viewer.
   Persisted workspace layout JSON is **not** the old format.
7. **Custom plugin API is breaking** — plugins no longer implement `save()`.
   Only matters if we ever write a plugin.
8. Jupyter packaging changed (AnyWidget). Irrelevant to us.

**Net risk: moderate and bounded.** Our Perspective-specific code lives almost
entirely in `static/js/dashboard.js` — view specs, config building, palette,
export. The migration is concentrated, not spread across the app.

---

## 3. The alternatives, and their quirks

Costs are published list prices for 2026.

### AG Grid Enterprise (+ AG Charts Enterprise) — the credible commercial option
**$999 / developer** (perpetual, 1 year of updates); **$1,498** with AG Charts.
Pivot and integrated charts are Enterprise-only.

**Quirks:**
- **Without a licence key it shows a watermark and logs console errors.** AG
  Charts Enterprise shows a **5-second watermark**. You cannot quietly ship it.
- Licensing is **per developer and per deployment/application** — some tiers add
  a deployment fee on top. Bundling it into an internal `.exe` that you hand to
  colleagues is a distribution question, not just a purchase. (The NiceGUI
  maintainers publicly refused to bundle AG Grid Enterprise for exactly this
  reason: "legal/distribution issues".)
- It is a **grid-first** product. The pivot is a mode of the grid, not a
  reporting product, and charts need a separate licence.
- Adopting it is a **dashboard rewrite**, not a swap — different data layer,
  different config model.

**Usable here?** Technically yes. Practically, the licence and redistribution
question is the blocker for an internal tool, and it costs a rewrite to get
there.

### RevoGrid Pivot — the most interesting free alternative
MIT-licensed core, Web Component (so it fits our no-build-step constraint), claims
1M+ rows, pivot with linked charts.

**Quirks:**
- **Pivot is a newer, less proven product** than its grid core. The maturity gap
  versus Perspective's pivot engine is real.
- Charts are a separate concern from the pivot.
- Smaller ecosystem and community than AG Grid or Perspective.
- I have **not verified** offline vendoring, large-data behaviour, or the config
  API. That needs a spike before it can be recommended.

**Usable here?** Possibly — it is the only free option worth a spike as a Plan B.
I would not switch to it blind.

### Flexmonster — pivot-first commercial
**From ~$799.**

**Quirks:** commercial licence; another vendor to manage; large-data support is
good (millions of rows, OLAP) but it is a reporting widget rather than an
embeddable grid. Same redistribution question as AG Grid.

**Usable here?** Yes, if the organisation is willing to pay and licence it.

### WebDataRocks — free, but ruled out
**Quirks:** free including commercial use, but capped at a **1 MB dataset**
(CSV/JSON). That is three orders of magnitude short of our 59 MB test file.

**Usable here? No. Hard blocker.**

### DuckDB-WASM — the "modern" answer that does not fit
**Quirks:**
- **10–12 MB gzipped** base bundle (≈3× our entire current vendor tree)
- **Single-threaded by default**; multithreading still experimental
- 4 GB WASM memory ceiling, and **WASM memory never shrinks** once grown
- It is an **engine, not a user interface**. You would build the drag-and-drop
  pivot builder, the aggregation UI and all charts yourself, then wire a grid and
  a chart library on top.

**Usable here?** No, not as a drop-in. And note the irony: **Perspective v5 now
integrates DuckDB as a Virtual Server**, so you can have DuckDB *under*
Perspective's UI if you want push-down SQL.

### The rest — briefly
| Option | Quirk that decides it |
|---|---|
| **TanStack Table** | Headless. No UI, no aggregation UI. You build everything. |
| **Glide Data Grid** | Fast canvas grid, no pivot, no charts. |
| **Handsontable** | ~$990–1,490/dev, spreadsheet-first, pivot not the focus. |
| **SpreadJS / Syncfusion / Kendo / Wijmo** | Suite licences; only sensible if the org already owns one. |
| **PivotTable.js** | Effectively unmaintained; small-data only. |

---

## 4. Recommendation

**Upgrade Perspective to v5. Do not change vendors.**

1. It is the only option that satisfies **all seven constraints** — free,
   Apache-2.0, offline-vendorable, no build step, pivot UI included.
2. **The specific component behind every workaround we wrote has been replaced.**
   The `opacity` crash, the `mainValues` X/Y crash, the palette caching, the
   hand-rolled SVG rasteriser — all of it traces to `viewer-d3fc`.
3. It keeps our biggest asset: **Arrow from Pandas straight into a pivot**, with
   no transformation step.
4. We would gain a workspace (multi-panel, master/detail), GPU charts, built-in
   export, and an optional DuckDB path — for free.

**If the organisation would rather pay than maintain:** AG Grid Enterprise is the
credible alternative, but budget for the licence, the per-deployment terms, and a
dashboard rewrite.

**If you want a free Plan B:** spike RevoGrid Pivot. It is the only other free
option that could plausibly fit, and I would want to verify it before believing
its claims.

---

## 5. Suggested sequence, when you give the word

1. **Spike (½–1 day)** in a scratch copy: vendor v5, confirm offline vendoring
   still resolves WASM the same way, render one grid and one chart.
2. **Answer four questions during the spike:**
   - Does `viewer-charts` still cache its palette, or does the workaround go away?
   - Does the built-in `export` replace our SVG rasteriser?
   - What is the actual v5 asset size? (Likely ~4 MB, possibly more with the GPU engine.)
   - Does the `--psp-*` variable rename break our HSBC theming?
3. **Port (2–4 days):** update imports, plugin names, the `load(client)` +
   named-table pattern, theme variables, and the palette code.
4. **Retire workarounds** that v5 makes unnecessary.
5. **Regression:** re-run the 13-view sweep, exports, and the 500k-row test.

**Do not start any of this without your signal.**
