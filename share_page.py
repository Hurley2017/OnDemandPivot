"""
Build a standalone page that carries the whole workbench.

The point of this file is that a colleague without the app can still *use* the
view — drag fields onto shelves, filter, sort, change the chart — rather than
only look at it. That needs the real engine, so the real engine travels inside
the page:

  * the four vendor bundles, as blob modules
  * both WASM binaries, base64
  * the CSS, the dashboard markup and the dashboard script
  * the data and the view configuration

Two things make it work from a bare file:// page, where nothing can be fetched:

  1. the dashboard's four static imports are rewritten to dynamic imports of the
     blob URLs, so the module graph resolves without a server
  2. `fetch` is wrapped before any module runs, and answers the handful of URLs
     the app asks for — both WASMs and the API calls — from what is inlined

Nothing is left to the network. The page is complete on its own, which is also
why it is a large file: the engine is not small.
"""
import base64
import json
import os
import re

# Where the vendored pieces live, relative to this file.
VENDOR = {
    "perspective": "static/vendor/perspective/cdn/perspective.js",
    "viewer": "static/vendor/perspective/cdn/perspective-viewer.js",
    "datagrid": "static/vendor/perspective/cdn/perspective-viewer-datagrid.js",
    "charts": "static/vendor/perspective/cdn/perspective-viewer-charts.js",
}

CSS = [
    "static/vendor/perspective/cdn/pro.css",
    "static/vendor/perspective/cdn/perspective-viewer-datagrid.min.css",
    "static/vendor/fonts/fonts.css",
    "static/css/style.css",
]

SERVER_WASM = "static/vendor/perspective/wasm/perspective-server.wasm"
VIEWER_WASM = "static/vendor/perspective/wasm/perspective-viewer.wasm"


def _patch_vendor(name: str, source: str) -> str:
    """
    Fix the one thing that cannot work from a page with no origin.

    The viewer bundle works out where its WASM lives by resolving a relative
    path against its own module URL:

        new URL("../wasm/perspective-viewer.wasm", import.meta.url)

    That is fine over http, but here the module is a blob and the page has a
    null origin, so `new URL` throws before anything can intercept the fetch.
    Replacing the expression with the bare filename leaves `fetch` to ask for a
    name the page's shim answers directly.
    """
    if name != "viewer":
        return source

    patched, count = re.subn(
        r'new\s+URL\(\s*"\.\./wasm/perspective-viewer\.wasm"\s*,\s*'
        r'import\.meta\.url\s*\)',
        '"perspective-viewer.wasm"',
        source,
    )
    if not count:
        raise RuntimeError(
            "the viewer bundle no longer contains the expected WASM URL "
            "expression; the standalone page would silently fail to load"
        )
    return patched


def _b64(path: str) -> str:
    with open(path, "rb") as fh:
        return base64.b64encode(fh.read()).decode("ascii")


def _b64_bytes(blob: bytes) -> str:
    return base64.b64encode(blob).decode("ascii")


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _strip_asset_tags(html: str) -> str:
    """Drop every <link>/<script src> — the page carries those inline."""
    html = re.sub(r"<link\b[^>]*>", "", html, flags=re.I)
    html = re.sub(r"<script\b[^>]*\bsrc=[^>]*>\s*</script>", "", html, flags=re.I)
    return html


def _rewrite_imports(script: str) -> str:
    """
    Turn the dashboard's four static vendor imports into dynamic blob imports.

    A static import specifier resolves against the module's own URL, which is a
    blob: — relative paths are meaningless there. Loading them dynamically from
    blob URLs the page created is what makes the graph resolve with no server.
    """
    # Matched by hand rather than one clever regex: the four lines differ, and a
    # wrong one silently produces a page that does nothing.
    lines = script.split("\n")
    out = []
    saw_default = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("import ") and "vendor/perspective" in stripped:
            if "perspective.js" in stripped and " from " in stripped:
                saw_default = True
            continue
        out.append(line)

    prelude = (
        "// Vendors loaded from blob URLs, since a file:// page cannot resolve\n"
        "// relative specifiers. The page created these before this module ran.\n"
        "const __v = window.__cpaVendors;\n"
        "const __mods = await Promise.all([\n"
        "    import(__v.perspective), import(__v.viewer),\n"
        "    import(__v.datagrid), import(__v.charts),\n"
        "]);\n"
        + ("const perspective = __mods[0].default;\n" if saw_default else "")
    )
    return prelude + "\n".join(out)


def build(dashboard_html, data_arrow, profile, config, palette, note, source,
          root):
    """
    Assemble the standalone page.

    `dashboard_html` is the rendered dashboard markup; everything else is
    inlined into it.
    """
    vendors = {}
    for name, path in VENDOR.items():
        source = _read(os.path.join(root, path))
        vendors[name] = _b64_bytes(
            _patch_vendor(name, source).encode("utf-8"))
    css = "\n".join(_read(os.path.join(root, p)) for p in CSS)
    # The stylesheets carry url(../fonts/...) references; the fonts themselves
    # are a separate download, and the page falls back to the system stack.
    css = re.sub(r"url\([^)]*inter[^)]*\)", "none", css, flags=re.I)

    script = _rewrite_imports(_read(os.path.join(root, "static/js/dashboard.js")))
    ui_script = _read(os.path.join(root, "static/js/ui.js"))

    markup = _strip_asset_tags(dashboard_html)

    return _PAGE.format(
        title=json.dumps((source or "Shared view").rsplit(".", 1)[0]),
        css=css,
        markup=markup,
        ui_script=ui_script,
        script=script,
        vendors=json.dumps(vendors),
        server_wasm=_b64(os.path.join(root, SERVER_WASM)),
        viewer_wasm=_b64(os.path.join(root, VIEWER_WASM)),
        arrow=_b64_bytes(data_arrow),
        profile=json.dumps(profile),
        config=json.dumps(config),
        palette=json.dumps(palette or []),
        note=json.dumps(note or ""),
    )


_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<!--
  The whole workbench, standing on its own.

  This file carries the engine, the interface, the data and the view, so it
  needs no server, no install and no network. It is here because a view is more
  useful when it can be changed than when it can only be read.
-->
<style>
{css}
/* Standalone page: the site header's action is not relevant here, and the
   assistant needs an endpoint that may not exist on this machine. */
.site-header .header-meta-actions {{ display: none; }}
.ai-btn, .chat-dock, #chatToggle {{ display: none !important; }}
body {{ background: #f2f2f2; }}
</style>
</head>
<body>

{markup}

<script>
/* ---------------------------------------------------------------- shims */
/* Installed before any module loads. A file:// page cannot fetch anything, so
   the handful of URLs the app asks for are answered from what is inlined. */
(function () {{
  var B64 = {{
    server: "{server_wasm}",
    viewer: "{viewer_wasm}"
  }};
  var APIS = {{
    "/api/data": null,
    "/api/kpis": null,
    "/api/session": null,
    "/api/shared": null
  }};

  function bytes(b64) {{
    var raw = atob(b64), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }}

  function json(body, status) {{
    return new Response(JSON.stringify(body), {{
      status: status || 200,
      headers: {{ "Content-Type": "application/json" }}
    }});
  }}

  var dataArrow = bytes("{arrow}");
  var profile = {profile};
  var config = {config};
  var palette = {palette};
  var note = {note};

  APIS["/api/data"] = function () {{
    return new Response(dataArrow, {{
      headers: {{ "Content-Type": "application/vnd.apache.arrow.stream" }}
    }});
  }};
  APIS["/api/kpis"] = function () {{
    return json({{ success: true, profile: profile }});
  }};
  APIS["/api/session"] = function () {{
    return json({{ success: true, loaded: true, processed: true,
                   filename: {title}, profile: profile,
                   options: {{}}, sheets: [],
                   preview: {{ fields: [], records: [], shown: 0, total: 0 }} }});
  }};
  APIS["/api/shared"] = function () {{
    return json({{ success: true, shared: {{ config: config, palette: palette,
                                             note: note, reshaped: [],
                                             source: {{}} }} }});
  }};

  window.__cpaServerWasm = function () {{
    return bytes(B64.server).buffer;
  }};

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {{
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("perspective-server.wasm") >= 0) {{
      return Promise.resolve(new Response(bytes(B64.server), {{
        headers: {{ "Content-Type": "application/wasm" }}
      }}));
    }}
    if (url.indexOf("perspective-viewer.wasm") >= 0) {{
      return Promise.resolve(new Response(bytes(B64.viewer), {{
        headers: {{ "Content-Type": "application/wasm" }}
      }}));
    }}
    for (var path in APIS) {{
      if (url === path || url.indexOf(path + "?") === 0) {{
        return Promise.resolve(APIS[path]());
      }}
    }}
    // Anything else would be a real request, and this page has no server.
    if (url.indexOf("blob:") === 0 || url.indexOf("data:") === 0) {{
      return realFetch ? realFetch(input, init) : Promise.reject(url);
    }}
    return Promise.reject(new Error("This standalone page has no server for " + url));
  }};

  /* The vendor bundles, as blob URLs the modules will import by name. */
  var VENDORS = {vendors};
  window.__cpaVendors = {{}};
  Object.keys(VENDORS).forEach(function (name) {{
    var raw = atob(VENDORS[name]);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    window.__cpaVendors[name] = URL.createObjectURL(
      new Blob([arr], {{ type: "text/javascript" }}));
  }});
}})();
</script>

<script>{ui_script}</script>

<!-- The dashboard module. Its imports were rewritten to the blob URLs above,
     so it resolves with no server behind it. -->
<script type="module">
{script}
</script>
</body>
</html>
"""
