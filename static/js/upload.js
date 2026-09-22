/* OnDemandPivot — upload page: drag & drop, profiling, preview, processing. */
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);

    const dropzone = $("dropzone");
    const fileInput = $("fileInput");
    const alertBox = $("alert");
    const profileCard = $("profileCard");
    const previewCard = $("previewCard");

    let busy = false;
    let previewTimer = null;

    /* ---------------------------------------------------------------- utils */

    function showError(message) {
        alertBox.textContent = message;
        alertBox.hidden = false;
    }

    function clearError() {
        alertBox.hidden = true;
        alertBox.textContent = "";
    }

    function setBusy(button, on) {
        button.disabled = on;
        button.dataset.label = button.dataset.label || button.innerHTML;
        button.innerHTML = on ? '<span class="spinner"></span> Working…' : button.dataset.label;
    }

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    const KIND_BADGE = {
        number: "badge-number",
        string: "badge-string",
        datetime: "badge-datetime",
        boolean: "badge-boolean",
        category: "badge-string",
        timedelta: "badge-datetime",
    };

    function readOptions() {
        return {
            skip_rows: parseInt($("skipRows").value, 10) || 0,
            skip_cols: parseInt($("skipCols").value, 10) || 0,
            data_range: ($("dataRange").value || "").trim(),
            strip_whitespace: $("optStrip").checked,
            drop_empty_rows: $("optDropRows").checked,
            drop_empty_cols: $("optDropCols").checked,
            dedupe: $("optDedupe").checked,
        };
    }

    /* Put every restructuring control back to its default state. */
    function applyOptionDefaults(options) {
        const opts = options || {};
        $("skipRows").value = opts.skip_rows || 0;
        $("skipCols").value = opts.skip_cols || 0;
        $("dataRange").value = opts.data_range || "";
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
            throw new Error("Server returned an unreadable response.");
        }
        if (!resp.ok || !data.success) {
            throw new Error((data && data.error) || "Request failed.");
        }
        return data;
    }

    /* ------------------------------------------------------------ rendering */

    function renderStats(profile) {
        const tiles = [
            { label: "Rows", value: profile.rows, hint: "after cleaning" },
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
    }

    function renderPreview(preview) {
        const head = $("previewTable").querySelector("thead tr");
        const tbody = $("previewTable").querySelector("tbody");

        head.innerHTML = preview.fields
            .map((f) => `<th title="${escapeHtml(f.kind)}">${escapeHtml(f.name)}</th>`)
            .join("");

        if (!preview.records.length) {
            tbody.innerHTML = `<tr><td class="null" colspan="${preview.fields.length || 1}">No rows to display.</td></tr>`;
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
            `showing ${preview.shown} of ${preview.total} rows`;
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
        applyOptionDefaults(data.options);
        renderAll(data);
    }

    async function handleFile(file) {
        if (!file) return;
        clearError();

        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (ext !== "csv" && ext !== "xlsx") {
            showError("Unsupported file type. Please choose a .csv or .xlsx file.");
            return;
        }

        try {
            await uploadBlob(file, file.name);
        } catch (err) {
            showError(err.message);
        }
    }

    /* Bundled demo workbook, so the app can be tried without a local file. */
    async function loadSample() {
        const btn = $("sampleBtn");
        if (btn.disabled) return;
        clearError();
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
            showError(err.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = label;
        }
    }

    /* Debounced re-profile whenever a restructuring control changes. */
    async function schedulePreview() {
        if (!profileCard.hidden) {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(refreshPreview, 320);
        }
    }

    async function refreshPreview() {
        try {
            const data = await postJSON("/preview", readOptions());
            clearError();
            renderAll(data);
        } catch (err) {
            showError(err.message);
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

    // Re-profile on any control change (debounced).
    ["skipRows", "skipCols", "dataRange"].forEach((id) =>
        $(id).addEventListener("input", schedulePreview)
    );
    ["optStrip", "optDropRows", "optDropCols", "optDedupe"].forEach((id) =>
        $(id).addEventListener("change", schedulePreview)
    );

    $("sampleBtn").addEventListener("click", loadSample);

    $("resetBtn").addEventListener("click", () => {
        profileCard.hidden = true;
        previewCard.hidden = true;
        $("fileMeta").hidden = true;
        applyOptionDefaults(null);
        clearError();
        window.scrollTo({ top: 0, behavior: "smooth" });
    });

    $("processBtn").addEventListener("click", async () => {
        const btn = $("processBtn");
        if (busy) return;
        busy = true;
        setBusy(btn, true);
        clearError();
        try {
            const data = await postJSON("/process", readOptions());
            window.location.href = data.url || "/dashboard";
        } catch (err) {
            showError(err.message);
            busy = false;
            setBusy(btn, false);
        }
    });
})();
