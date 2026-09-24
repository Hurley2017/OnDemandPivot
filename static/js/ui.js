/* OnDemandPivot — shared UI helpers: toast popups + escaping. */
(function () {
    "use strict";

    const ICONS = {
        error: "!",
        success: "✓",
        warn: "!",
        info: "i",
    };

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function host() {
        let el = document.getElementById("toastHost");
        if (!el) {
            el = document.createElement("div");
            el.id = "toastHost";
            el.className = "toast-host";
            el.setAttribute("role", "status");
            el.setAttribute("aria-live", "polite");
            document.body.appendChild(el);
        }
        return el;
    }

    /**
     * Show a popup message. Repeating the same text just restarts its timer
     * instead of stacking duplicates (the preview re-runs on every keystroke).
     */
    function toast(message, kind, timeout) {
        const text = String(message == null ? "" : message).trim();
        if (!text) return null;

        const type = ICONS[kind] ? kind : "info";
        const life = timeout || (type === "error" ? 8000 : 4000);
        const parent = host();

        const existing = [...parent.children].find(
            (c) => c.dataset.message === text
        );
        if (existing) {
            clearTimeout(Number(existing.dataset.timer));
            existing.dataset.timer = String(
                setTimeout(() => dismiss(existing), life)
            );
            return existing;
        }

        const el = document.createElement("div");
        el.className = "toast toast-" + type;
        el.dataset.message = text;
        el.innerHTML =
            '<span class="toast-icon" aria-hidden="true">' +
            escapeHtml(ICONS[type]) +
            "</span>" +
            '<span class="toast-text"></span>' +
            '<button class="toast-close" type="button" aria-label="Dismiss">×</button>';
        el.querySelector(".toast-text").textContent = text;

        el.querySelector(".toast-close").addEventListener("click", () =>
            dismiss(el)
        );
        parent.appendChild(el);

        // Keep the stack short on small screens.
        while (parent.children.length > 4) {
            parent.removeChild(parent.firstElementChild);
        }

        el.dataset.timer = String(setTimeout(() => dismiss(el), life));
        return el;
    }

    function dismiss(el) {
        if (!el || !el.parentNode) return;
        clearTimeout(Number(el.dataset.timer));
        el.classList.add("toast-out");
        setTimeout(() => el.remove(), 180);
    }

    /**
     * Wire every `.group-toggle` button to the panel named in its
     * aria-controls attribute. Collapsing sections are plain buttons so they
     * can be styled, animated and keyboard-driven like any other control.
     */
    function initCollapsibles(root) {
        const scope = root || document;
        scope.querySelectorAll(".group-toggle").forEach((btn) => {
            if (btn.dataset.bound === "1") return;
            btn.dataset.bound = "1";

            const panel = document.getElementById(
                btn.getAttribute("aria-controls") || ""
            );
            if (!panel) return;

            const setOpen = (open) => {
                btn.setAttribute("aria-expanded", open ? "true" : "false");
                panel.hidden = !open;
            };

            // Honour the markup's initial state.
            setOpen(btn.getAttribute("aria-expanded") !== "false");

            btn.addEventListener("click", () => {
                setOpen(btn.getAttribute("aria-expanded") !== "true");
            });
        });
    }

    /* ------------------------------------------------------------ selects */

    /**
     * Replace every native <select> with a styled listbox. The real select is
     * kept (hidden) so value handling, `change` events and form semantics are
     * unchanged; only the presentation is ours.
     */
    function enhanceSelects(root) {
        const scope = root || document;
        scope.querySelectorAll("select").forEach((sel) => {
            if (sel.dataset.enhanced === "1" || sel.multiple) return;
            sel.dataset.enhanced = "1";

            const wrap = document.createElement("div");
            wrap.className = "cselect";
            sel.parentNode.insertBefore(wrap, sel);
            wrap.appendChild(sel);
            sel.classList.add("cselect-native");
            sel.setAttribute("tabindex", "-1");

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "cselect-button";
            btn.setAttribute("aria-haspopup", "listbox");
            btn.setAttribute("aria-expanded", "false");
            btn.innerHTML =
                '<span class="cselect-label"></span><span class="cselect-arrow"></span>';

            const panel = document.createElement("div");
            panel.className = "cselect-panel";
            panel.hidden = true;
            panel.setAttribute("role", "listbox");

            wrap.appendChild(btn);
            wrap.appendChild(panel);

            const label = btn.querySelector(".cselect-label");

            const build = () => {
                panel.innerHTML = "";
                const addOption = (opt) => {
                    const item = document.createElement("button");
                    item.type = "button";
                    item.className = "cselect-option";
                    item.dataset.value = opt.value;
                    item.textContent = opt.textContent;
                    item.setAttribute("role", "option");
                    if (opt.value === sel.value) item.classList.add("is-selected");
                    item.addEventListener("click", () => {
                        sel.value = opt.value;
                        sync();
                        close();
                        sel.dispatchEvent(new Event("change", { bubbles: true }));
                    });
                    panel.appendChild(item);
                };

                [...sel.children].forEach((child) => {
                    if (child.tagName === "OPTGROUP") {
                        const head = document.createElement("div");
                        head.className = "cselect-group";
                        head.textContent = child.label;
                        panel.appendChild(head);
                        [...child.children].forEach(addOption);
                    } else if (child.tagName === "OPTION") {
                        addOption(child);
                    }
                });
            };

            function sync() {
                const opt = sel.selectedOptions && sel.selectedOptions[0];
                label.textContent = opt ? opt.textContent : "";
                btn.disabled = sel.disabled;
                panel.querySelectorAll(".cselect-option").forEach((el) => {
                    el.classList.toggle("is-selected", el.dataset.value === sel.value);
                });
            }

            function open() {
                build();
                sync();
                panel.hidden = false;
                btn.setAttribute("aria-expanded", "true");
                wrap.classList.add("is-open");
                const cur = panel.querySelector(".cselect-option.is-selected");
                if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
            }

            function close() {
                panel.hidden = true;
                btn.setAttribute("aria-expanded", "false");
                wrap.classList.remove("is-open");
            }

            btn.addEventListener("click", (event) => {
                event.stopPropagation();
                if (panel.hidden) open();
                else close();
            });

            btn.addEventListener("keydown", (event) => {
                if (event.key === "Escape") {
                    close();
                    return;
                }
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                if (panel.hidden) {
                    open();
                    return;
                }
                const items = [...panel.querySelectorAll(".cselect-option")];
                const at = items.findIndex((el) => el.classList.contains("is-selected"));
                const next = Math.min(
                    items.length - 1,
                    Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1))
                );
                if (items[next]) items[next].click();
            });

            document.addEventListener("click", (event) => {
                if (!wrap.contains(event.target)) close();
            });

            sel.addEventListener("change", sync);
            sel._cselectSync = sync;
            build();
            sync();
        });
    }

    /** Re-read the underlying selects (call after rebuilding their options). */
    function refreshSelects() {
        document.querySelectorAll("select").forEach((sel) => {
            if (sel._cselectSync) sel._cselectSync();
        });
    }

    /**
     * A row of buttons that each pop up one panel, replacing a stack of
     * always-visible sections. One panel at a time; click away or press Escape
     * to close.
     */
    function initGroupBar(root) {
        const scope = root || document;
        const bar = scope.querySelector(".group-bar");
        if (!bar) return;

        const buttons = [...bar.querySelectorAll(".group-btn")];

        const closeAll = () => {
            buttons.forEach((btn) => {
                btn.setAttribute("aria-expanded", "false");
                const panel = document.getElementById(btn.dataset.panel || "");
                if (panel) panel.hidden = true;
            });
        };

        buttons.forEach((btn) => {
            const panel = document.getElementById(btn.dataset.panel || "");
            if (!panel) return;

            btn.addEventListener("click", (event) => {
                event.stopPropagation();
                const wasOpen = btn.getAttribute("aria-expanded") === "true";
                closeAll();
                if (!wasOpen) {
                    btn.setAttribute("aria-expanded", "true");
                    panel.hidden = false;
                    const focusable = panel.querySelector("input, select");
                    if (focusable) focusable.focus({ preventScroll: true });
                }
            });

            panel.addEventListener("click", (event) => event.stopPropagation());

            // A close button in the panel head, added once.
            const head = panel.querySelector(".panel-head");
            if (head && !head.querySelector(".panel-close")) {
                const close = document.createElement("button");
                close.type = "button";
                close.className = "panel-close";
                close.setAttribute("aria-label", "Close this panel");
                close.textContent = "×";
                close.addEventListener("click", (event) => {
                    event.stopPropagation();
                    closeAll();
                    btn.focus({ preventScroll: true });
                });
                head.appendChild(close);
            }
        });

        document.addEventListener("click", closeAll);
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") closeAll();
        });
    }

    /**
     * The browser tab reads "CP Analytics - <file>", or just "CP Analytics"
     * before anything is loaded. Kept here so both pages title themselves the
     * same way.
     */
    function setDocumentTitle(filename) {
        const name = (filename || "").trim();
        document.title = name ? `CP Analytics - ${name}` : "CP Analytics";
    }

    window.CPA = {
        toast,
        escapeHtml,
        setDocumentTitle,
        dismiss,
        initCollapsibles,
        initGroupBar,
        enhanceSelects,
        refreshSelects,
    };
})();
