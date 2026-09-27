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
                         "optNormalizeCols", "optCoerceNumbers"];
    const SELECT_FIELDS = ["textCase", "fillMissing", "dedupeKeep"];
    const TEXT_FIELDS = ["dataRange", "dropCols", "dedupeCols",
                         "replaceFind", "replaceWith"];

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
        dedupeCols: "dedupe_cols",
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

    /**
     * The sort keys, in priority order: [{column, desc}, ...].
     *
     * Sorting by several columns cannot be expressed by one <select>, so this is
     * its own small state: a picker adds a column, each pill toggles its own
     * direction, and the order of the pills is the tie-break order.
     */
    let sortSpecs = [];

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
        // The worksheet is chosen from its own panel rather than a control that
        // lives inside one of the option groups.
        payload.sheet = currentSheet();
        // Sorting travels as ordered [column, direction] pairs.
        payload.sort_by = sortSpecs.map((s) => [s.column, s.desc ? "desc" : "asc"]);
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
                  "dedupeCols"],
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

        // Restoring a session or a fresh upload brings its sort keys with it.
        sortSpecs = Array.isArray(opts.sort_by)
            ? opts.sort_by
                  .filter((s) => Array.isArray(s) && s[0])
                  .map((s) => ({
                      column: String(s[0]),
                      desc: String(s[1] || "asc").toLowerCase() === "desc",
                  }))
            : [];

        window.CPA.refreshSelects();
    }

    /**
     * The worksheet picker, as a pop-up panel like the other option groups.
     *
     * A workbook can hold dozens of sheets, so they are listed as buttons in a
     * scrollable panel rather than squeezed into a dropdown — and the header
     * keeps a read-only note of which one is open.
     */
    let chosenSheet = "";

    function renderSheets(sheets, chosen) {
        const btn = $("sheetBtn");
        const list = $("sheetList");
        const field = $("sheetField");
        const names = Array.isArray(sheets) ? sheets : [];

        if (chosen && names.includes(chosen)) chosenSheet = chosen;
        if (!chosenSheet && names.length) chosenSheet = names[0];

        // A single-sheet workbook has nothing to choose.
        if (btn) btn.hidden = names.length <= 1;
        if (field) field.hidden = names.length <= 1;
        const tag = $("sheetTag");
        if (tag) tag.textContent = chosenSheet || "—";

        if (!list) return;
        const count = $("sheetCount");
        if (count) count.textContent = `${names.length} sheets`;

        list.textContent = "";
        if (!names.length) {
            const empty = document.createElement("p");
            empty.className = "fields-hint";
            empty.textContent = "This file has no worksheets.";
            list.appendChild(empty);
            return;
        }

        names.forEach((name) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "sheet-option" +
                (name === chosenSheet ? " is-active" : "");
            item.dataset.sheet = name;
            item.textContent = name;
            item.addEventListener("click", () => {
                if (name === chosenSheet) return;
                chosenSheet = name;
                // Mark the choice, then let the normal preview path re-read it.
                list.querySelectorAll(".sheet-option").forEach((el) =>
                    el.classList.toggle("is-active", el.dataset.sheet === name)
                );
                if (tag) tag.textContent = name;
                markModifiedGroups();
                schedulePreview();
            });
            list.appendChild(item);
        });
    }

    /** The sheet the user has picked, for the option payload. */
    function currentSheet() {
        return chosenSheet;
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
        window.CPA.setDocumentTitle(profile && profile.filename);
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

    /**
     * Keep the column-dependent controls in step with the current frame.
     *
     * Columns can disappear as the options are applied, so a sort key that no
     * longer exists is dropped rather than left to fail silently.
     */
    function fillColumnSelects(names) {
        const live = new Set(names);
        const before = sortSpecs.length;
        sortSpecs = sortSpecs.filter((s) => live.has(s.column));
        if (sortSpecs.length !== before) renderSortPills();
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
        columnNames = (data.profile.fields || []).map((f) => f.name);
        renderSortPills();
        profileCard.hidden = false;
        previewCard.hidden = false;
        markModifiedGroups();
    }

    /* The frame's column names, refreshed on every rebuild. They drive the sort
       picker and the suggestions in the text boxes. */
    let columnNames = [];

    /* ------------------------------------------------------------- sorting */

    /**
     * Draw the sort keys as ordered pills.
     *
     * One <select> cannot express "sort by these three, in this order, one of
     * them descending", so the keys are pills: the first sorts, the rest break
     * its ties in order, and each pill toggles its own direction when clicked.
     */
    function renderSortPills() {
        const host = $("sortPills");
        const picker = $("sortAdd");
        if (!host || !picker) return;

        host.textContent = "";
        if (!sortSpecs.length) {
            const empty = document.createElement("span");
            empty.className = "pick-empty";
            empty.textContent = "No sort — rows keep their file order.";
            host.appendChild(empty);
        }

        sortSpecs.forEach((spec, index) => {
            const pill = document.createElement("button");
            pill.type = "button";
            pill.className = "pick-pill" + (spec.desc ? " is-desc" : "");
            pill.title = "Click to switch between ascending and descending";

            const order = document.createElement("span");
            order.className = "pick-order";
            order.textContent = String(index + 1);
            pill.appendChild(order);

            const name = document.createElement("span");
            name.className = "pick-name";
            name.textContent = spec.column;
            name.title = spec.column;
            pill.appendChild(name);

            const dir = document.createElement("span");
            dir.className = "pick-dir";
            dir.textContent = spec.desc ? "Z–A" : "A–Z";
            pill.appendChild(dir);

            pill.addEventListener("click", () => {
                spec.desc = !spec.desc;
                renderSortPills();
                schedulePreview();
            });

            const drop = document.createElement("span");
            drop.className = "pick-drop";
            drop.textContent = "\u00d7";
            drop.setAttribute("role", "button");
            drop.setAttribute("aria-label", "Remove " + spec.column + " from the sort");
            drop.addEventListener("click", (event) => {
                event.stopPropagation();
                sortSpecs.splice(index, 1);
                renderSortPills();
                schedulePreview();
            });
            pill.appendChild(drop);

            host.appendChild(pill);
        });

        // Offer only what is not already a sort key.
        const used = new Set(sortSpecs.map((s) => s.column));
        const options = columnNames.filter((n) => !used.has(n));

        picker.textContent = "";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = options.length
            ? "+ add a column to sort by"
            : "every column is already a sort key";
        picker.appendChild(none);
        options.forEach((name) => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            picker.appendChild(opt);
        });
        picker.disabled = !options.length;
        window.CPA.refreshSelects();
    }

    /* --------------------------------------------------------- suggestions */

    /**
     * Complete the token being typed in a comma-separated column box.
     *
     * Only the token under the caret is replaced, so "Account, Da" offers the
     * columns beginning with "Da" and leaves "Account," alone. Matching ignores
     * case, and columns already named in the box are not offered again.
     */
    function initSuggest(inputId) {
        const input = $(inputId);
        if (!input) return;

        const wrap = input.parentElement;
        wrap.style.position = "relative";
        const panel = document.createElement("div");
        panel.className = "suggest-panel";
        panel.hidden = true;
        wrap.appendChild(panel);

        const close = () => { panel.hidden = true; };

        const tokenAt = (value, caret) => {
            const before = value.slice(0, caret);
            const start = Math.max(
                before.lastIndexOf(","),
                before.lastIndexOf(";"),
                before.lastIndexOf("\n")
            ) + 1;
            return { start, text: value.slice(start).trim() };
        };

        const refresh = () => {
            const caret = input.selectionStart || input.value.length;
            const { start, text } = tokenAt(input.value, caret);
            if (!text) { close(); return; }

            const used = new Set(
                input.value.split(/[,\n;]/)
                    .map((s) => s.trim().toLowerCase())
                    .filter(Boolean)
            );
            const needle = text.toLowerCase();
            const matches = columnNames
                .filter((n) => n.toLowerCase().includes(needle))
                .filter((n) => !used.has(n.toLowerCase()))
                .slice(0, 8);
            if (!matches.length) { close(); return; }

            panel.textContent = "";
            matches.forEach((name) => {
                const item = document.createElement("button");
                item.type = "button";
                item.className = "suggest-item";
                item.textContent = name;
                // mousedown, not click: the input's blur would close the panel
                // before a click ever landed.
                item.addEventListener("mousedown", (event) => {
                    event.preventDefault();
                    const at = input.selectionStart || input.value.length;
                    const tail = input.value.slice(at);
                    input.value = input.value.slice(0, start) + name + tail;
                    input.focus();
                    close();
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                });
                panel.appendChild(item);
            });
            panel.hidden = false;
        };

        input.addEventListener("input", refresh);
        input.addEventListener("focus", refresh);
        input.addEventListener("keydown", (event) => {
            if (event.key === "Escape") close();
        });
        input.addEventListener("blur", () => setTimeout(close, 140));
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
        if (!on) {
            setBusy(null);
            window.CPA.setDocumentTitle(null);
        }
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

        // A shared view arrives already structured and already configured, so
        // there is nothing to prepare here — go straight to it.
        if (data.shared) {
            toast(
                data.view && data.view.note
                    ? `Opening the shared view — “${data.view.note}”.`
                    : "Opening the shared view.",
                "success"
            );
            window.location.href = "/dashboard";
            return;
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
        if (ext !== "csv" && ext !== "xlsx" && ext !== "xlsb"
                && ext !== "pivotview") {
            toast("Unsupported file type. Choose a .csv, .xlsx, .xlsb or "
                  + ".pivotview file.", "error");
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

    // Sorting: the picker appends a key, the pills own the rest.
    $("sortAdd").addEventListener("change", (event) => {
        const name = event.target.value;
        if (!name) return;
        sortSpecs.push({ column: name, desc: false });
        renderSortPills();
        schedulePreview();
    });
    initSuggest("dropCols");
    initSuggest("dedupeCols");

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
