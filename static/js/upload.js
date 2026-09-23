/* Client Profitability Analytics — import page: drop, profile, restructure. */
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
    const SELECT_FIELDS = ["sheetSelect", "textCase", "fillMissing", "dedupeKeep", "sortBy"];
    const TEXT_FIELDS = ["dataRange", "dropCols", "replaceFind", "replaceWith"];

    /* control id -> backend option name */
    const OPTION_MAP = {
        skipRows: "skip_rows",
        skipCols: "skip_cols",
        skipLastRows: "skip_last_rows",
        skipLastCols: "skip_last_cols",
        dataRange: "data_range",
        sheetSelect: "sheet",
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
            } else if (value !== undefined && value !== null && value !== "") {
                el.value = value;
            } else if (el.tagName === "SELECT" && el.options.length) {
                // Never leave a select blank: fall back to its first choice.
                el.selectedIndex = 0;
            } else {
                el.value = el.defaultValue;
            }
        });
        window.CPA.refreshSelects();
    }

    /** Populate the worksheet picker; hide it entirely for CSV uploads. */
    function renderSheets(sheets, chosen) {
        const field = $("sheetField");
        const select = $("sheetSelect");
        const list = Array.isArray(sheets) ? sheets : [];

        if (list.length <= 1) {
            field.hidden = true;
            select.innerHTML = list.length
                ? `<option value="${escapeHtml(list[0])}">${escapeHtml(list[0])}</option>`
                : "";
            return;
        }

        field.hidden = false;
        select.innerHTML = list
            .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
            .join("");
        if (chosen && list.includes(chosen)) select.value = chosen;
        window.CPA.refreshSelects();
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
        window.CPA.refreshSelects();
    }

    function renderPreview(preview) {
        const head = $("previewTable").querySelector("thead tr");
        const tbody = $("previewTable").querySelector("tbody");

        head.innerHTML = preview.fields
            .map((f) => `<th title="${escapeHtml(f.kind)}">${escapeHtml(f.name)}</th>`)
            .join("");

        if (!preview.records.length) {
            tbody.innerHTML = `<tr><td class="null" colspan="${preview.fields.length || 1}">No rows left — every row was filtered out. Relax the row options or the range.</td></tr>`;
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

        const colNote =
            preview.cols_total && preview.cols_shown < preview.cols_total
                ? ` · first ${preview.cols_shown} of ${preview.cols_total} columns`
                : "";
        $("previewCount").textContent =
            `showing ${preview.shown} of ${preview.total} rows${colNote}`;
        $("previewTag").textContent =
            `${preview.total} rows × ${preview.cols_total || preview.fields.length} cols`;
        $("footSummary").textContent =
            `${preview.total} rows × ${preview.fields.length} columns ready to explore.`;
    }

    function renderAll(data) {
        renderStats(data.profile);
        renderProfile(data.profile);
        renderPreview(data.preview);
        profileCard.hidden = false;
        previewCard.hidden = false;
    }

    /* --------------------------------------------------------- upload flow */

    function setNavMeta(name, text, size) {
        $("navFile").textContent = name || "No dataset loaded";
        $("navMeta").textContent = text || "Import & structure";
        $("fileTag").textContent = name
            ? name + (size ? ` · ${size}` : "")
            : "No file selected";
    }

    function showClear(on) {
        $("clearFileBtn").hidden = !on;
    }

    /** Drop the selected file and everything derived from it. */
    async function clearFile() {
        try {
            await postJSON("/api/reset", {});
        } catch (_err) {
            /* the local UI is cleared either way */
        }
        profileCard.hidden = true;
        previewCard.hidden = true;
        fileInput.value = "";
        applyOptions(null);
        showClear(false);
        setNavMeta(null, null);
        clearTimeout(previewTimer);
        previewSeq += 1; // abandon any preview still in flight
        toast("File cleared. Choose another one to continue.", "info");
    }

    async function uploadBlob(blob, name) {
        const form = new FormData();
        form.append("file", blob, name);

        const resp = await fetch("/upload", { method: "POST", body: form });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            throw new Error(data.error || "Upload failed.");
        }

        renderSheets(data.sheets, data.options && data.options.sheet);
        applyOptions(data.options);
        renderAll(data);
        showClear(true);

        const shown = (data.profile && data.profile.filename) || name;
        const sheetNote =
            data.sheets && data.sheets.length > 1
                ? ` · ${data.sheets.length} sheets`
                : "";
        setNavMeta(
            shown,
            `${data.profile.rows} rows × ${data.profile.cols} cols · ` +
                `${data.profile.flagged_fields} flagged${sheetNote}`,
            `${(blob.size / 1024).toFixed(1)} KB`
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
        if (ext !== "csv" && ext !== "xlsx" && ext !== "xlsb") {
            toast("Unsupported file type. Choose a .csv, .xlsx or .xlsb file.", "error");
            return;
        }

        try {
            await uploadBlob(file, file.name);
        } catch (err) {
            toast(err.message, "error");
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

    window.CPA.initCollapsibles();
    window.CPA.enhanceSelects();

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

    $("clearFileBtn").addEventListener("click", (e) => {
        e.stopPropagation(); // the drop zone behind it opens the file picker
        clearFile();
    });

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
        btn.innerHTML = '<span class="spinner"></span> Preparing…';
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
