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

    window.CPA = { toast, escapeHtml, dismiss };
})();
