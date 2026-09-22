/* OnDemandPivot — upload page: drag & drop, profiling, preview, processing. */
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const toast = (msg, kind) => window.CPA.toast(msg, kind);
    const escapeHtml = window.CPA.escapeHtml;

    const dropzone = $("dropzone");
    const fileInput = $("fileInput");
    const profileCard = $("profileCard");
    const previewCard = $("previewCard");

    let busy = false;
    let previewTimer = null;
    let previewSeq = 0;

    const KIND_BADGE = {
        number: "badge-number",
        string: "badge-string",
        datetime: "badge-datetime",
        boolean: "badge-boolean",
        category: "badge-string",
        timedelta: "badge-datetime",
    };

    /* ------------------------------------------------------------ options */

    const NUMBER_FIELDS = ["skipRows", "skipCols", "skipLastRows", "skipLastCols",
                           "maxMissing", "roundDecimals"];
    const BOOL_FIELDS = ["optHasHeader", "optPromote", "optTranspose",
                         "optStrip", "optDropRows", "optDropRowsNull", "optDedupe",
                         "optDropCols", "optConstantCols", "optDuplicateCols",
                         "optNormalizeCols", "optCoerceNumbers", "sortDesc"];
    const SELECT_FIELDS = ["textCase", "fillMissing", "dedupeKeep", "sortBy"];
    const TEXT_FIELDS = ["dataRange", "dropCols", "replaceFind", "replaceWith"];

    /* id -> backend option name */
    const OPTION_MAP = {
        skipRows: "skip_rows",
        skipCols: "skip_cols",
        skipLastRows: "skip_last_rows",
        skipLastCols: "skip_last_cols",
        dataRange: "data_range",
        optHasHeader: "has_header",
        optPromote: "promote_first_row",
        optTranspose: "transpose",
        optStrip: "strip_whitespace",
        optDropRows: "drop_empty_rows",
        optDropRowsNull: "drop_rows_with_null",
        optDedupe: "dedupe",
        dedupeKeep: "dedupe_keep",
        sortBy: "sort_by",
        sortDesc: "sort_desc",
        optDropCols: "drop_empty_cols",
        optConstantCols: "drop_constant_cols",
        optDuplicateCols: "drop_duplicate_cols",
        maxMissing: "max_missing_pct",
        dropCols: "drop_cols",
        optNormalizeCols: "normalize_col_names",
        textCase: "text_case",
        optCoerceNumbers: "coerce_numbers",
        fillMissing: "fill_missing",
        roundDecimals: "round_decimals",
        replaceFind: "replace_find",
        replaceWith: "replace_with",
    };

    function readOptions() {
        const payload = {};
        NUMBER_FIELDS.forEach((id) => {
            const raw = parseInt($(id).value, 10);
            payload[OPTION_MAP[id]] = Number.isFinite(raw) ? raw : 0;
        });
        BOOL_FIELDS.forEach((id) => {
            payload[OPTION_MAP[id]] = $(id).checked;
        });
        SELECT_FIELDS.forEach((id) => {
            payload[OPTION_MAP[id]] = $(id).value;
        });
        TEXT_FIELDS.forEach((id) => {
            payload[OPTION_MAP[id]] = ($(id).value || "").trim();
        });
        return payload;
    }

    /** Put every restructuring control back to the server's defaults. */
    function applyOptions(options) {
        const opts = options || {};
        Object.keys(OPTION_MAP).forEach((id) => {
            const el = $(id);
            if (!el) return;
            const value = opts[OPTION_MAP[id]];
            if (el.type === "checkbox") {
                el.checked = value !== undefined ? Boolean(value) : el.defaultChecked;
            } else if (value !== undefined && value !== null) {
                el.value = value;
            } else {
                el.value = el.defaultValue;
            }
        });
    }

    async function postJSON(url, payload) {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload || {}),
        });
        let data = null;
        try {
            data = await resp.json();
        } catch (err) {
            throw new Error("The server returned an unreadable response.");
        }
        if (!resp.ok || !data.success) {
            throw new Error((data && data.error) || "Request failed.");
        }
        return data;
    }

    /* ---------------------------------------------------------- rendering */

    function renderStats(profile) {
        const tiles = [
            { label: "Rows", value: profile.rows, hint: "after restructuring" },
            { label: "Columns", value: profile.cols, hint: "KPIs detected" },
            {
                label: "Missing cells",
                value: profile.missing_cells,
                hint: profile.missing_pct + "% of dataset",
                alert: profile.missing_pct > 0,
            },
            {
                label: "Duplicate rows",
                value: profile.duplicate_rows,
                hint: profile.duplicate_rows ? "consider removing" : "none found",
                alert: profile.duplicate_rows > 0,
            },
            {
                label: "Flagged columns",
                value: profile.flagged_fields,
                hint: profile.flagged_fields ? "review anomalies" : "all clean",
                alert: profile.flagged_fields > 0,
            },
        ];

        $("stats").innerHTML = tiles
            .map(
                (t) => `
            <div class="stat${t.alert ? " alert" : ""}">
                <div class="stat-label">${escapeHtml(t.label)}</div>
                <div class="stat-value">${escapeHtml(t.value)}</div>
                <div class="stat-hint">${escapeHtml(t.hint)}</div>
            </div>`
            )
            .join("");
    }

    function renderProfile(profile) {
        const tbody = $("profileTable").querySelector("tbody");

        tbody.innerHTML = profile.fields
            .map((f) => {
                const badge = KIND_BADGE[f.kind] || "badge-string";
                const missingTxt = f.missing
                    ? `${f.missing} (${f.missing_pct}%)`
                    : "0";
                const issues = f.anomalies.length
                    ? f.anomalies
                          .map(
                              (a) =>
                                  `<span class="badge badge-alert" style="margin:1px 3px 1px 0">${escapeHtml(a)}</span>`
                          )
                          .join("")
                    : '<span class="badge badge-datetime">OK</span>';

                return `
                <tr>
                    <td><b>${escapeHtml(f.name)}</b></td>
                    <td><span class="badge ${badge}">${escapeHtml(f.kind)}</span></td>
                    <td>${escapeHtml(f.dtype)}</td>
                    <td class="${f.missing ? "num null" : "num"}">${escapeHtml(missingTxt)}</td>
                    <td class="num">${escapeHtml(f.unique)}</td>
                    <td>${escapeHtml(f.sample == null ? "—" : f.sample)}</td>
                    <td>${issues}</td>
                </tr>`;
            })
            .join("");

        $("profileTag").textContent = profile.flagged_fields
            ? `${profile.flagged_fields} column(s) flagged`
            : "No anomalies detected";

        fillColumnSelects(profile.fields.map((f) => f.name));
    }

    /** Keep the column-dependent selects in step with the current frame. */
    function fillColumnSelects(names) {
        const sortBy = $("sortBy");
        const current = sortBy.value;
        sortBy.innerHTML =
            '<option value="">— leave as-is —</option>' +
            names
                .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
                .join("");
        if (names.includes(current)) sortBy.value = current;
    }

    function renderPreview(preview) {
        const head = $("previewTable").querySelector("thead tr");
        const tbody = $("previewTable").querySelector("tbody");

        head.innerHTML = preview.fields
            .map((f) => `<th title="${escapeHtml(f.kind)}">${escapeHtml(f.name)}</th>`)
            .join("");

        if (!preview.records.length) {
            tbody.innerHTML = `<tr><td class="null" colspan="${preview.fields.length || 1}">No rows to display — every row was filtered out. Relax the row options.</td></tr>`;
        } else {
            tbody.innerHTML = preview.records
                .map((row) => {
                    return (
                        "<tr>" +
                        preview.fields
                            .map((f) => {
                                const v = row[f.name];
                                if (v === null || v === undefined || v === "") {
                                    return '<td class="null">null</td>';
                                }
                                const cls = f.kind === "number" ? ' class="num"' : "";
                                return `<td${cls}>${escapeHtml(v)}</td>`;
                            })
                            .join("") +
                        "</tr>"
                    );
                })
                .join("");
        }

        $("previewCount").textContent =
            `— showing ${preview.shown} of ${preview.total} rows`;
        $("previewTag").textContent = `${preview.total} rows × ${preview.fields.length} cols`;
        $("footSummary").textContent =
            `${preview.total} rows ready — click “Process data” to open the dashboard.`;
    }

    function renderAll(data) {
        renderStats(data.profile);
        renderProfile(data.profile);
        renderPreview(data.preview);
        profileCard.hidden = false;
        previewCard.hidden = false;
    }

    /* --------------------------------------------------------- upload flow */

    function setNavMeta(name, text) {
        $("navFile").textContent = name || "No dataset loaded";
        $("navMeta").textContent = text || "";
    }

    async function uploadBlob(blob, name) {
        $("fileMeta").hidden = false;
        $("fileMeta").innerHTML =
            `Selected: <b>${escapeHtml(name)}</b> · ${(blob.size / 1024).toFixed(1)} KB`;

        const form = new FormData();
        form.append("file", blob, name);

        const resp = await fetch("/upload", { method: "POST", body: form });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            throw new Error(data.error || "Upload failed.");
        }
        // Each new file starts from the server's default restructuring state.
        applyOptions(data.options);
        renderAll(data);
        const shown = (data.profile && data.profile.filename) || name;
        setNavMeta(
            shown,
            `${data.profile.rows} rows × ${data.profile.cols} cols · ` +
                `${data.profile.flagged_fields} flagged`
        );
        toast(
            `Loaded ${shown} — ${data.profile.rows} rows × ` +
                `${data.profile.cols} columns.`,
            "success"
        );
    }

    async function handleFile(file) {
        if (!file) return;

        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (ext !== "csv" && ext !== "xlsx") {
            toast("Unsupported file type. Please choose a .csv or .xlsx file.", "error");
            return;
        }

        try {
            await uploadBlob(file, file.name);
        } catch (err) {
            toast(err.message, "error");
        }
    }

    /* Bundled demo workbook, so the app can be tried without a local file. */
    async function loadSample() {
        const btn = $("sampleBtn");
        if (btn.disabled) return;
        btn.disabled = true;
        const label = btn.innerHTML;
        btn.innerHTML = '<span class="spinner"></span> Loading…';

        const name = "Sample Finance Data.xlsx";
        try {
            const resp = await fetch(
                "/static/" + encodeURIComponent(name),
                { cache: "no-store" }
            );
            if (!resp.ok) {
                throw new Error(
                    "Sample file is not available next to the app " +
                        "(static/Sample Finance Data.xlsx)."
                );
            }
            const blob = await resp.blob();
            await uploadBlob(blob, name);
        } catch (err) {
            toast(err.message, "error");
        } finally {
            btn.disabled = false;
            btn.innerHTML = label;
        }
    }

    /* ------------------------------------------------------ live preview */

    function setPreviewState(text, kind) {
        const el = $("previewState");
        el.hidden = false;
        el.textContent = text;
        el.className = "preview-state" + (kind ? " is-" + kind : "");
    }

    function schedulePreview() {
        if (profileCard.hidden) return;
        setPreviewState("updating…", "busy");
        clearTimeout(previewTimer);
        previewTimer = setTimeout(refreshPreview, 350);
    }

    async function refreshPreview() {
        const seq = ++previewSeq;
        try {
            const data = await postJSON("/preview", readOptions());
            if (seq !== previewSeq) return; // a newer edit already won
            renderAll(data);
            setPreviewState("updated", "ok");
            setTimeout(() => {
                if (seq === previewSeq) $("previewState").hidden = true;
            }, 1400);
        } catch (err) {
            if (seq !== previewSeq) return;
            setPreviewState("failed", "bad");
            toast(err.message, "error");
        }
    }

    /* ------------------------------------------------------------- events */

    ["dragenter", "dragover"].forEach((evt) =>
        dropzone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add("is-over");
        })
    );

    ["dragleave", "drop"].forEach((evt) =>
        dropzone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove("is-over");
        })
    );

    dropzone.addEventListener("drop", (e) => {
        const file = e.dataTransfer && e.dataTransfer.files[0];
        handleFile(file);
    });

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInput.click();
        }
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length) handleFile(fileInput.files[0]);
        fileInput.value = "";
    });

    // Re-profile on any control change. Both `input` and `change` are wired so
    // typing, spinners, paste and programmatic edits all refresh the preview.
    NUMBER_FIELDS.concat(TEXT_FIELDS).forEach((id) =>
        ["input", "change"].forEach((evt) =>
            $(id).addEventListener(evt, schedulePreview)
        )
    );
    BOOL_FIELDS.concat(SELECT_FIELDS).forEach((id) =>
        $(id).addEventListener("change", schedulePreview)
    );

    $("sampleBtn").addEventListener("click", loadSample);

    $("resetBtn").addEventListener("click", () => {
        applyOptions(null);
        clearTimeout(previewTimer);
        schedulePreview();
        toast("Restructuring options reset to their defaults.", "info");
    });

    $("processBtn").addEventListener("click", async () => {
        const btn = $("processBtn");
        if (busy) return;
        busy = true;
        const label = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Processing…';
        try {
            const data = await postJSON("/process", readOptions());
            window.location.href = data.url || "/dashboard";
        } catch (err) {
            toast(err.message, "error");
            busy = false;
            btn.disabled = false;
            btn.innerHTML = label;
        }
    });
})();
