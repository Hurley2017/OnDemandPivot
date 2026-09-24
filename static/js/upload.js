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

    /* Excel's type names, in the same badge palette as the kind. */
    const EXCEL_BADGE = {
        Number: "badge-number",
        Text: "badge-string",
        Date: "badge-datetime",
        Time: "badge-datetime",
        Boolean: "badge-boolean",
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
    /* Which controls live in which pop-up panel, so a panel can advertise that
       its options differ from the defaults. */
    const GROUP_OPTIONS = {
        grpStructure: ["skipRows", "skipLastRows", "skipCols", "skipLastCols",
                       "dataRange"],
        grpShape: ["optHasHeader", "optPromote", "optTranspose"],
        grpRows: ["optDropRows", "optDropRowsNull", "optDedupe", "dedupeKeep",
                  "sortBy", "sortDesc"],
        grpColumns: ["optDropCols", "optConstantCols", "optDuplicateCols",
                     "optNormalizeCols", "maxMissing", "dropCols"],
        grpValues: ["optStrip", "optCoerceNumbers", "textCase", "fillMissing",
                    "roundDecimals", "replaceFind", "replaceWith"],
    };

    function isDefaultValue(el) {
        if (!el) return true;
        if (el.type === "checkbox") return el.checked === el.defaultChecked;
        // Every select opens on its neutral first option.
        if (el.tagName === "SELECT") return el.selectedIndex <= 0;
        return (el.value || "") === (el.defaultValue || "");
    }

    /** Dot any group whose options have been moved off their defaults. */
    function markModifiedGroups() {
        Object.keys(GROUP_OPTIONS).forEach((panelId) => {
            const btn = document.querySelector(
                '.group-btn[data-panel="' + panelId + '"]'
            );
            if (!btn) return;
            const changed = GROUP_OPTIONS[panelId].some(
                (id) => !isDefaultValue($(id))
            );
            btn.classList.toggle("is-modified", changed);
            btn.title = changed ? "Options differ from the defaults" : "";
        });
    }

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

    /**
     * Populate the worksheet picker in the header; hide it for single-sheet
     * workbooks and for CSV uploads, where there is nothing to choose.
     */
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

    /**
     * The compact facts about the *source file*, shown in the card header.
     * Rows and columns are the file's own shape, captured before any
     * restructuring - the live preview reports the transformed frame, so the
     * two never say the same thing twice.
     */
    function renderStats(profile) {
        const chips = [
            { value: profile.source_rows, label: "rows" },
            { value: profile.source_cols, label: "cols" },
            {
                value: profile.missing_cells,
                label: "missing",
                alert: profile.missing_cells > 0,
            },
            {
                value: profile.duplicate_rows,
                label: "dupes",
                alert: profile.duplicate_rows > 0,
            },
            {
                value: profile.flagged_fields,
                label: "flagged",
                alert: profile.flagged_fields > 0,
            },
        ];

        $("metaChips").innerHTML = chips
            .map(
                (c) =>
                    `<span class="meta-chip${c.alert ? " is-alert" : ""}">` +
                    `<b>${escapeHtml(c.value)}</b> ${escapeHtml(c.label)}</span>`
            )
            .join("");
    }

    function renderProfile(profile) {
        const tbody = $("profileTable").querySelector("tbody");

        tbody.innerHTML = profile.fields
            .map((f) => {
                // The Type column speaks Excel, since that is what users know.
                const excel = f.excel || "Text";
                const badge = EXCEL_BADGE[excel] || "badge-string";
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
                    <td><span class="badge ${badge}">${escapeHtml(excel)}</span></td>
                    <td>${escapeHtml(f.dtype)}</td>
                    <td class="${f.missing ? "num null" : "num"}">${escapeHtml(missingTxt)}</td>
                    <td class="num">${escapeHtml(f.unique)}</td>
                    <td>${issues}</td>
                </tr>`;
            })
            .join("");

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
        const scrollNote = preview.shown > 20 ? " · scroll the table" : "";
        $("previewCount").textContent =
            `${preview.shown} of ${preview.total} rows${colNote}${scrollNote}`;
    }

    function renderAll(data) {
        renderStats(data.profile);
        renderProfile(data.profile);
        renderPreview(data.preview);
        profileCard.hidden = false;
        previewCard.hidden = false;
        markModifiedGroups();
    }

    /** Hide everything that only exists once a file is loaded. */
    function hideLoaded() {
        profileCard.hidden = true;
        previewCard.hidden = true;
    }

    /* --------------------------------------------------------- upload flow */

    /* The only place the file name is shown, now that the site header is bare. */

    /** "251.4 KB" / "12.1 MB" — the workbook block reads as name · size. */
    function sizeLabel(bytes) {
        const n = Number(bytes);
        if (!Number.isFinite(n) || n <= 0) return "";
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    }

    function setFileTag(name, size) {
        const tag = $("fileTag");
        if (!name) {
            tag.textContent = "";
            tag.removeAttribute("title");
            return;
        }
        tag.textContent = name + (size ? ` · ${size}` : "");
        tag.title = name + (size ? ` (${size})` : "");
    }

    /** Swap the drop zone for the file's facts once something is loaded. */
    function showLoaded(on) {
        $("dropzone").hidden = on;
        $("clearFileBtn").hidden = !on;
        $("processBtn").hidden = !on;
        $("wbGroup").hidden = !on;
        $("metaChips").hidden = !on;
        if (!on) setBusy(null);
    }

    /**
     * Reading state for the drop zone. A large workbook can take several
     * seconds to parse and profile, so say so instead of looking frozen.
     */
    function setBusy(name, hint) {
        const busy = $("dzBusy");
        if (!busy) return;
        if (!name) {
            busy.hidden = true;
            return;
        }
        $("dzBusyName").textContent = name;
        $("dzBusyHint").textContent =
            hint || "Profiling every column — large files take a moment.";
        busy.hidden = false;
    }

    /** Drop the selected file and everything derived from it. */
    async function clearFile() {
        try {
            await postJSON("/api/reset", {});
        } catch (_err) {
            /* the local UI is cleared either way */
        }
        hideLoaded();
        fileInput.value = "";
        applyOptions(null);
        showLoaded(false);
        setFileTag(null);
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
        showLoaded(true);

        const shown = (data.profile && data.profile.filename) || name;
        setFileTag(shown, sizeLabel((data.profile || {}).file_bytes || blob.size));
        toast(
            `Loaded ${shown} — ${data.profile.rows} rows × ` +
                `${data.profile.cols} columns.`,
            "success"
        );
    }

    /**
     * Re-attach to an upload the server still holds. Without this, coming back
     * from the dashboard (or a plain reload) looked like a fresh start.
     */
    async function restoreSession() {
        let data;
        try {
            const resp = await fetch("/api/session");
            data = await resp.json();
        } catch (_err) {
            return; // nothing to restore, the drop zone is already there
        }
        if (!data || !data.success || !data.loaded) return;

        renderSheets(data.sheets, data.options && data.options.sheet);
        applyOptions(data.options);
        renderAll(data);
        showLoaded(true);
        setFileTag(data.filename, sizeLabel((data.profile || {}).file_bytes));
    }

    async function handleFile(file) {
        if (!file) return;

        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (ext !== "csv" && ext !== "xlsx" && ext !== "xlsb") {
            toast("Unsupported file type. Choose a .csv, .xlsx or .xlsb file.", "error");
            return;
        }

        // Anything past a few megabytes is worth announcing.
        const size = file.size / 1024 / 1024;
        setBusy(
            file.name,
            size >= 2
                ? `Reading ${size.toFixed(1)} MB — profiling every column, this can take a moment.`
                : "Profiling every column…"
        );

        try {
            await uploadBlob(file, file.name);
            setBusy(null);
        } catch (err) {
            setBusy(null);
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

    const pick = () => fileInput.click();
    dropzone.addEventListener("click", pick);
    $("browseBtn").addEventListener("click", (e) => {
        e.stopPropagation(); // the drop zone behind it would open the picker too
        pick();
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length) handleFile(fileInput.files[0]);
        fileInput.value = "";
    });

    window.CPA.initCollapsibles();
    window.CPA.initGroupBar();
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
        btn.classList.add("is-busy");
        btn.innerHTML = '<span class="spinner"></span> Preparing…';
        try {
            const data = await postJSON("/process", readOptions());
            window.location.href = data.url || "/dashboard";
        } catch (err) {
            toast(err.message, "error");
            busy = false;
            btn.classList.remove("is-busy");
            btn.innerHTML = label;
        }
    });

    // Pick up an upload that is still open on the server.
    restoreSession();
})();
