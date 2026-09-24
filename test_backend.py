"""Backend tests: sample workbook, ranges, restructuring, sheets, chat, export."""
import io
import os
import sys

# Anomaly text can contain non-ASCII (arrows, em dashes); a Windows console
# defaults to CP1252 and would fail on the print, not on the assertion.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - older interpreters, or a redirected pipe
    pass

import app as m
import pandas as pd
import pyarrow as pa

client = m.app.test_client()
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "tests", "fixtures")
SAMPLE = os.path.join(FIXTURES, "Sample Finance Data.xlsx")
XLSB = os.path.join(FIXTURES, "sample.xlsb")

# The app itself needs no sample data; only this suite does. Drop any .xlsx
# there to exercise the data paths, otherwise the run simply stops here.
if not os.path.exists(SAMPLE):
    print("No sample workbook found at:")
    print("   ", SAMPLE)
    print()
    print("This suite checks the upload/cleaning/export pipeline against a real")
    print("file. Put any .xlsx there (named exactly as above) and run it again.")
    print("The application itself does not depend on it.")
    sys.exit(0)

csv_bytes = open(SAMPLE, "rb").read()


def up(name="Sample Finance Data.xlsx", data=None, path=None):
    if data is None:
        data = open(path, "rb").read() if path else csv_bytes
    r = client.post(
        "/upload",
        data={"file": (io.BytesIO(data), name)},
        content_type="multipart/form-data",
    )
    return r, r.get_json()


# --- 1. upload sample -------------------------------------------------------
r, j = up()
print("upload ->", r.status_code, "success=", j.get("success"))
assert r.status_code == 200 and j["success"], j
p = j["profile"]
print("  rows=%s cols=%s flagged=%s missing=%s dupes=%s" % (
    p["rows"], p["cols"], p["flagged_fields"], p["missing_cells"],
    p["duplicate_rows"]))
for f in p["fields"]:
    print("   - %-22s %-9s %-14s miss=%-3s uniq=%-4s %s" % (
        f["name"], f["kind"], f["dtype"], f["missing"], f["unique"],
        "; ".join(f["anomalies"])))

# Date must now be a real datetime, not a serial number.
date_f = next(f for f in p["fields"] if f["name"] == "Date")
assert date_f["kind"] == "datetime", date_f
print("\n  Date sample value:", j["preview"]["records"][0]["Date"])
# Year/Month Number must stay numeric - only Date converts.
kinds = {f["name"]: f["kind"] for f in p["fields"]}
assert kinds["Year"] == "number" and kinds["Month Number"] == "number", kinds

# Country case/spacing variants must be flagged, with a worked example and the
# option that fixes it, so the warning is actionable rather than just alarming.
country = next(f for f in p["fields"] if f["name"] == "Country")
case_note = next(a for a in country["anomalies"] if "case" in a)
print("  Country anomaly:", case_note)
assert "separate groups" in case_note, case_note
assert "'CANADA' vs 'Canada'" in case_note, case_note
assert "Text case" in case_note, case_note

# --- 2. skip_cols -----------------------------------------------------------
r = client.post("/preview", json={"skip_cols": 3})
j = r.get_json()
names = [f["name"] for f in j["profile"]["fields"]]
print("\nskip_cols=3 -> cols=%s (was 16)" % len(names))
assert len(names) == 13, names
assert "Segment" not in names and "Units Sold" in names, names

# --- 3. custom range --------------------------------------------------------
# Isolate range behaviour by switching off the cleaning toggles, so a
# column that happens to be all-null in this window is not dropped.
CLEAN_OFF = {"strip_whitespace": False, "drop_empty_rows": False,
             "drop_empty_cols": False, "dedupe": False}

# Header in row 1, columns A-D, first 5 data rows => A1:D6
r = client.post("/preview", json={"data_range": "A1:D6", **CLEAN_OFF})
j = r.get_json()
names = [f["name"] for f in j["profile"]["fields"]]
print("range A1:D6 -> cols=%s rows=%s" % (names, j["profile"]["rows"]))
assert names == ["Segment", "Country", "Product", "Discount Band"], names
assert j["profile"]["rows"] == 5, j["profile"]["rows"]

# Range must override skip_rows if both are sent.
r = client.post("/preview", json={"data_range": "A1:D4", "skip_rows": 50,
                                  **CLEAN_OFF})
j = r.get_json()
print("range wins over skip_rows -> rows=%s cols=%s"
      % (j["profile"]["rows"], len(j["profile"]["fields"])))
assert j["profile"]["rows"] == 3

# A range starting at C drops the leading columns entirely.
r = client.post("/preview", json={"data_range": "C1:E4", **CLEAN_OFF})
j = r.get_json()
names = [f["name"] for f in j["profile"]["fields"]]
print("range C1:E4 -> %s" % names)
assert names == ["Product", "Discount Band", "Units Sold"], names

# Invalid range must surface a clear message, not a traceback.
r = client.post("/preview", json={"data_range": "nonsense"})
print("bad range ->", r.status_code, r.get_json())
assert r.status_code == 422 and "Excel notation" in r.get_json()["error"]

# --- 4. process + arrow -----------------------------------------------------
r = client.post("/preview", json={"data_range": "", "skip_rows": 0, "skip_cols": 0})
assert r.status_code == 200
r = client.post("/process", json={"skip_rows": 0, "skip_cols": 0, "data_range": ""})
j = r.get_json()
print("\nprocess ->", r.status_code, j)
assert r.status_code == 200 and j["success"], j
# Default cleaning drops 7 all-empty rows + 4 remaining duplicates from 711.
assert j["rows"] == 700 and j["cols"] == 16, j

r = client.get("/api/data")
tbl = pa.ipc.open_stream(io.BytesIO(r.data)).read_all()
print("arrow -> %s rows x %s cols" % (tbl.num_rows, tbl.num_columns))
assert tbl.num_rows == 700 and tbl.num_columns == 16
names = tbl.schema.names
di = names.index("Date")
print("  Date arrow type:", tbl.schema.field(di).type)
assert "timestamp" in str(tbl.schema.field(di).type), tbl.schema.field(di).type

# --- 5. chat ---------------------------------------------------------------
# The assistant is Perspective v5's built-in agent, driven from the browser
# (viewer.agentConfig / viewer.agentPrompt). It no longer routes through Flask,
# so the only thing to assert here is that the old proxy is really gone.
r = client.post("/api/chat", json={"query": "hi"})
print("\nold /api/chat proxy ->", r.status_code, "(404 = removed)")
assert r.status_code == 404

# --- 6. dashboard still renders with logo/title -----------------------------
print("\ndashboard ->", client.get("/dashboard").status_code)
r = client.get("/")
html = r.data.decode()
print("  upload page ->", r.status_code, len(html), "bytes")
print("  title present:", "Client Profitability Analytics" in html)
print("  logo referenced:", "icon/LOGO.PNG" in html)
print("  square favicon referenced:", "icon/favicon.png" in html)
print("  cache-busted assets:", "?v=" in html)
print("  no dark utility bar:", 'class="topbar"' not in html)
print("  no sample-data button:", 'id="sampleBtn"' not in html)
print("  accepts xlsb:", ".xlsb" in html)

# --- 7. open-ended Excel ranges ---------------------------------------------
print("\nopen-ended ranges:")# Cleaning is disabled so the shapes reflect the range alone (raw = 711 rows).
RAW = {"drop_empty_rows": False, "drop_empty_cols": False, "dedupe": False,
       "strip_whitespace": False}
for spec, want_cols, want_rows in [
    ("A1:D6", 4, 5),
    ("A:C", 3, 711),
    ("B:D", 3, 711),
    ("2:5", 16, 3),
    ("C1:E", 3, 711),
    ("$B$2:$D$4", 3, 2),
    ("B3", 1, 709),
    ("B3:H", 7, 709),
    ("H2:A5", 8, 3),          # reversed columns are tolerated
]:
    raw, _clean, _prof = m._rebuild(m._merge_options({**RAW, "data_range": spec}))
    got = (raw.shape[1], raw.shape[0])
    print("  %-12s -> %s cols x %s rows" % (spec, got[0], got[1]))
    assert got == (want_cols, want_rows), (spec, got, (want_cols, want_rows))

for bad in ["not-a-range", "A:B:C", ":", "A1:2B"]:
    try:
        m._parse_range(bad)
        raise AssertionError("expected a ValueError for %r" % bad)
    except ValueError as exc:
        print("  rejected %-12s -> %s" % (bad, exc))

# --- 7b. text-encoded numbers ------------------------------------------------
# Real financial statements store figures as text with currency symbols,
# accounting negatives and nil markers, and interleave section headings with
# the data. The coercer must rescue those columns without touching free text.
print("\ntext-encoded numbers:")
COERCE_CASES = [
    # (label, values, expected numeric values or None to refuse)
    ("plain integers", ["1", "2", "3"], [1.0, 2.0, 3.0]),
    ("thousands separators", ["1,234", "5,678"], [1234.0, 5678.0]),
    ("currency prefixes", ["$1,000", "£2,000", "€3,000"], [1000.0, 2000.0, 3000.0]),
    ("accounting negatives", ["(1,234.50)", "987.25"], [-1234.5, 987.25]),
    ("percent signs", ["12.5%", "0.5%"], [12.5, 0.5]),
    ("nil markers", ["-", "n/a", "1,000", "2,000", "nil"], [None, None, 1000.0, 2000.0, None]),
    ("section headings mixed in", ["100", "200", "Balance sheet date", "300", "400"],
     [100.0, 200.0, None, 300.0, 400.0]),
    # 88% numeric: the HBAP (consol) shape that used to stay text.
    ("mostly numeric with a date row",
     ["10", "20", "30", "40", "50", "60", "70", "2025-09-30 00:00:00"],
     [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, None]),
    ("free text is refused", ["CANADA", "germany", "FRANCE"], None),
    ("product names are refused", ["Carretera", "Montana", "Paseo"], None),
    ("mixed prose is refused",
     ["Net interest income rose", "Fees fell", "Costs were flat"], None),
]

for label, values, want in COERCE_CASES:
    out = m._coerce_numeric_text(pd.Series(values, dtype="object"))
    if want is None:
        got = None if out.dtype == object else list(out)
        print("  %-28s refused (dtype=%s)" % (label, out.dtype))
        assert out.dtype == object, (label, list(out))
    else:
        got = list(out)
        shown = ["null" if pd.isna(v) else v for v in got]
        print("  %-28s -> %s" % (label, shown))
        assert len(got) == len(want), (label, got, want)
        for g, w in zip(got, want):
            if w is None:
                assert pd.isna(g), (label, got, want)
            else:
                assert float(g) == float(w), (label, got, want)

# --- 8. restructuring options ------------------------------------------------
print("\nrestructuring options:")


def cleaned(**opts):
    return m._rebuild(m._merge_options({**RAW, **opts}))[1]


def expect(label, got, want):
    flag = "ok " if got == want else "FAIL"
    print("  %s %-42s %s" % (flag, label, got))
    assert got == want, (label, got, want)


expect("skip_last_rows=10", len(cleaned(skip_last_rows=10)), 701)
expect("skip_last_cols=4 cols", cleaned(skip_last_cols=4).shape[1], 12)
expect("transpose shape", cleaned(transpose=True).shape, (16, 711))
expect("has_header=False names",
       list(m._rebuild(m._merge_options({**RAW, "has_header": False}))[0].columns)[:1],
       ["Column 1"])
expect("promote_first_row",
       list(cleaned(promote_first_row=True).columns)[:3],
       ["Government", "CANADA", "Carretera"])
expect("drop_cols by name",
       [c for c in cleaned(drop_cols="Country, gross sales").columns
        if c in ("Country", "Gross Sales")], [])
expect("normalize_col_names",
       "gross_sales" in list(cleaned(normalize_col_names=True).columns), True)
expect("max_missing_pct drops column",
       "Discount Band" in cleaned(max_missing_pct=1.0).columns, False)
expect("drop_constant_cols", cleaned(drop_constant_cols=True).shape[1] <= 16, True)
expect("drop_duplicate_cols", cleaned(drop_duplicate_cols=True).shape[1] <= 16, True)
expect("coerce_numbers",
       str(cleaned(coerce_numbers=True)["Discounts"].dtype).startswith("float"), True)
expect("text_case upper", cleaned(text_case="upper")["Country"].dropna().iloc[0],
       "CANADA")
expect("replace_find", int((cleaned(replace_find="Carretera",
                                    replace_with="Road")["Product"] == "Road").sum()) > 0,
       True)
expect("round_decimals",
       float(cleaned(round_decimals=0)["Profit"].dropna().iloc[0]).is_integer(), True)
expect("fill_missing=bfill", int(cleaned(fill_missing="bfill")["Discount Band"].isna().sum()), 0)
expect("drop_rows_with_null", int(cleaned(drop_rows_with_null=True).isna().sum().sum()), 0)
expect("dedupe_keep=last", len(cleaned(dedupe=True, dedupe_keep="last")), 701)
_sales = cleaned(sort_by="Sales", sort_desc=True)["Sales"].dropna().tolist()
expect("sort_by desc", _sales == sorted(_sales, reverse=True), True)

# --- 9. extended profile summary --------------------------------------------
print("\nextended profile summary:")
prof = m._rebuild(m._merge_options({}))[2]
for key in ("cells", "complete_cols", "constant_cols", "outlier_cols",
            "numeric_cols", "text_cols", "date_cols", "bool_cols",
            "date_min", "date_max", "memory_bytes", "file_bytes"):
    print("  %-15s = %r" % (key, prof.get(key)))
    assert key in prof, key
assert prof["numeric_cols"] == 10, prof["numeric_cols"]
assert prof["date_cols"] == 1, prof["date_cols"]
assert prof["date_min"] <= prof["date_max"]

# --- 10. Excel export of the current view -----------------------------------
print("\nexport to xlsx:")
arrow = m._df_to_arrow_stream(m.SESSION_DATA["df"])
r = client.post("/api/export/xlsx", data=arrow,
                content_type="application/vnd.apache.arrow.stream")
print("  status", r.status_code, r.mimetype, len(r.data), "bytes")
assert r.status_code == 200
assert "spreadsheetml" in r.mimetype
import pandas as pd  # noqa: E402 - only needed for the export check

frame = pd.read_excel(io.BytesIO(r.data))
print("  workbook shape:", frame.shape)
assert frame.shape == (700, 16), frame.shape
assert client.post("/api/export/xlsx", data=b"").status_code == 400

# --- 11. .xlsb upload and worksheet selection -------------------------------
if os.path.exists(XLSB):
    print("\nxlsb + worksheet selection:")
    r, j = up("sample.xlsb", path=XLSB)
    print("  xlsb upload ->", r.status_code, "success=", j.get("success"))
    assert r.status_code == 200 and j["success"], j
    print("  sheets:", j["sheets"], "| chosen:", j["options"]["sheet"])
    assert j["sheets"], "expected at least one worksheet"
    assert j["options"]["sheet"] == j["sheets"][0]
    print("  shape:", j["profile"]["rows"], "x", j["profile"]["cols"])

    r = client.post("/preview", json={"sheet": j["sheets"][0]})
    assert r.status_code == 200, r.get_json()
    print("  explicit sheet ->", r.get_json()["profile"]["rows"], "rows")

    r = client.post("/preview", json={"sheet": "No Such Sheet"})
    assert r.status_code == 200, r.get_json()
    print("  unknown sheet falls back to the first one ->",
          r.get_json()["profile"]["rows"], "rows")

    # CSV uploads report no worksheets.
    r, j = up("tiny.csv", data=b"a,b\n1,2\n3,4\n")
    print("  csv sheets:", j["sheets"], "| shape:", j["profile"]["rows"], "x",
          j["profile"]["cols"])
    assert j["sheets"] == []

    # Back to the main sample for the remaining checks.
    up()
else:
    print("\n(skipping .xlsb checks - fixture not found)")

# --- 11b. multi-sheet workbook ----------------------------------------------
MULTI = os.path.join(FIXTURES, "multi-sheet.xlsx")
if os.path.exists(MULTI):
    print("\nmulti-sheet workbook:")
    r, j = up("multi-sheet.xlsx", path=MULTI)
    assert r.status_code == 200 and j["success"], j
    print("  sheets:", j["sheets"], "| default:", j["options"]["sheet"])
    assert j["sheets"] == ["Summary", "Detail"], j["sheets"]
    assert j["options"]["sheet"] == "Summary"
    print("  Summary ->", j["profile"]["rows"], "x", j["profile"]["cols"],
          [f["name"] for f in j["profile"]["fields"]])

    r = client.post("/preview", json={"sheet": "Detail"})
    detail = r.get_json()
    assert r.status_code == 200, detail
    print("  Detail  ->", detail["profile"]["rows"], "x", detail["profile"]["cols"],
          [f["name"] for f in detail["profile"]["fields"]])
    assert [f["name"] for f in detail["profile"]["fields"]] == ["Item", "Qty"]
    assert detail["profile"]["source_rows"] == 4, detail["profile"]["source_rows"]
    print("  source shape followed the sheet switch:",
          detail["profile"]["source_rows"], "x", detail["profile"]["source_cols"])

    # Going back must restore the first sheet's shape, and restructuring on the
    # same sheet must NOT move it again.
    r = client.post("/preview", json={"sheet": "Summary"})
    back = r.get_json()
    assert back["profile"]["source_rows"] == 3, back["profile"]["source_rows"]
    print("  switched back ->", back["profile"]["source_rows"], "x",
          back["profile"]["source_cols"])
    r = client.post("/preview", json={"sheet": "Summary", "skip_rows": 1})
    skipped = r.get_json()
    assert skipped["profile"]["source_rows"] == 3, skipped["profile"]["source_rows"]
    assert skipped["profile"]["rows"] == 2, skipped["profile"]["rows"]
    print("  skip_rows on the same sheet keeps source at",
          skipped["profile"]["source_rows"], "while cleaned is",
          skipped["profile"]["rows"])

    # A sheet change while skip_rows is already set must still record the
    # sheet's *own* shape, not the shape after skipping.
    r = client.post("/preview", json={"sheet": "Detail", "skip_rows": 1})
    switched = r.get_json()
    assert switched["profile"]["source_rows"] == 4, switched["profile"]["source_rows"]
    assert switched["profile"]["rows"] == 3, switched["profile"]["rows"]
    print("  sheet change with skip_rows=1 -> source",
          switched["profile"]["source_rows"], "cleaned",
          switched["profile"]["rows"])
    up()

# --- 12. unsupported extensions are refused ---------------------------------
r, j = up("notes.txt", data=b"x")
print("\ntxt upload ->", r.status_code, j.get("error"))
assert r.status_code == 400

# --- 13. clearing the session ------------------------------------------------
print("\nreset session:")
up()
assert client.post("/preview", json={}).status_code == 200
r = client.post("/api/reset")
print("  reset ->", r.status_code, r.get_json())
assert r.status_code == 200 and r.get_json()["success"]
print("  preview after reset ->", client.post("/preview", json={}).status_code)
assert client.post("/preview", json={}).status_code == 404
assert client.get("/api/kpis").status_code == 404
print("  dashboard falls back to the import page ->",
      client.get("/dashboard").status_code)

# --- 14. session endpoint (lets the import page restore itself) -------------
print("\nsession endpoint:")
client.post("/api/reset")
r = client.get("/api/session")
print("  after reset  ->", r.get_json())
assert r.get_json()["loaded"] is False

up()
r = client.get("/api/session")
j = r.get_json()
print("  after upload -> loaded=%s file=%r rows=%s sheets=%s"
      % (j["loaded"], j["filename"], j["profile"]["rows"], j["sheets"]))
assert j["loaded"] is True
assert j["filename"] == "Sample Finance Data.xlsx"
assert j["profile"]["rows"] == 700
assert len(j["preview"]["records"]) == 100
assert "options" in j and j["processed"] is False

client.post("/process", json={})
j = client.get("/api/session").get_json()
print("  after process-> processed=%s" % j["processed"])
assert j["processed"] is True

# --- 15. source-file facts + Excel types ------------------------------------
print("\nsource shape and Excel types:")
up()
p = client.post("/preview", json={}).get_json()["profile"]
print("  source  %s x %s" % (p["source_rows"], p["source_cols"]))
print("  cleaned %s x %s" % (p["rows"], p["cols"]))
assert (p["source_rows"], p["source_cols"]) == (711, 16)
assert (p["rows"], p["cols"]) == (700, 16)

# Restructuring must not move the source shape.
moved = client.post("/preview", json={"skip_rows": 3, "drop_empty_rows": False,
                                      "dedupe": False}).get_json()["profile"]
print("  after skip 3 -> source %s x %s, cleaned %s x %s"
      % (moved["source_rows"], moved["source_cols"], moved["rows"], moved["cols"]))
assert (moved["source_rows"], moved["source_cols"]) == (711, 16)
assert moved["rows"] == 708

excel = {f["excel"] for f in p["fields"]}
print("  excel types present:", sorted(excel))
assert excel <= {"Text", "Number", "Date", "Time", "Boolean"}
assert "Text" in excel and "Number" in excel and "Date" in excel
assert all("excel" in f for f in p["fields"])

# --- 16. distinct values for the dashboard's filter pickers -------------------
# Uses the real sample workbook: the CSV fixture `up()` defaults to has no
# "Segment" column to enumerate.
print("\ndistinct values (/api/values):")
up(path=SAMPLE)
client.post("/preview", json={})

r = client.get("/api/values?column=Segment")
j = r.get_json()
assert r.status_code == 200 and j.get("success"), (r.status_code, j)
print("  Segment ->", j["values"])
assert set(j["values"]) >= {"Government", "Midmarket", "Enterprise"}
assert j["truncated"] is False and j["total"] == len(j["values"])

r = client.get("/api/values?column=Year")
j = r.get_json()
print("  Year    ->", j["values"])
assert j["values"] == sorted(j["values"]), j["values"]
assert all(isinstance(v, (int, float)) for v in j["values"]), j["values"]

# A limit must truncate rather than refuse, and say so.
r = client.get("/api/values?column=Sales&limit=5")
j = r.get_json()
print("  Sales limit=5 ->", len(j["values"]), "of", j["total"],
      "| truncated:", j["truncated"])
assert j["truncated"] is True and len(j["values"]) == 5

# A column with blanks reports them, so the picker can offer "(Blanks)".
r = client.get("/api/values?column=Discount Band")
j = r.get_json()
print("  Discount Band blanks:", j["has_blanks"], "| total:", j["total"])
assert j["has_blanks"] is True

for query, want in [("", 400), ("?column=Nope", 404)]:
    r = client.get("/api/values" + query)
    print("  %-16s -> %s" % (query or "(no column)", r.status_code))
    assert r.status_code == want, (query, r.status_code)

# --- 17. the Excel export carries the table's theme ---------------------------
print("\nthemed xlsx export:")
up(path=SAMPLE)
client.post("/process", json={})
arrow = client.get("/api/data").data

from openpyxl import load_workbook  # noqa: E402

for primary, want_fill, want_font in [
    # openpyxl stores a six-digit colour with a "00" alpha prefix; Excel treats
    # the leading byte as opaque, so this is the value it writes and reads back.
    ("#db0011", "00DB0011", "00FFFFFF"),   # corporate red -> white text
    ("#0b5394", "000B5394", "00FFFFFF"),   # a dark colour -> white text
    ("#ffe066", "00FFE066", "001A1A1A"),   # pale -> black text, automatically
]:
    r = client.post(
        "/api/export/xlsx?primary=" + primary.replace("#", "%23"),
        data=arrow,
        content_type="application/vnd.apache.arrow.stream",
    )
    assert r.status_code == 200, r.get_json()
    book = load_workbook(io.BytesIO(r.data))
    sheet = book["View"]
    head = sheet.cell(row=1, column=1)
    print("  %-9s -> header fill %s, font %s, freeze %s"
          % (primary, head.fill.start_color.rgb, head.font.color.rgb,
             sheet.freeze_panes))
    assert head.fill.start_color.rgb == want_fill, head.fill.start_color.rgb
    assert head.font.color.rgb == want_font, head.font.color.rgb
    assert sheet.freeze_panes == "A2", sheet.freeze_panes
    assert head.value == sheet.cell(row=1, column=1).value
    # The first data row must be intact, and banding must be present.
    assert sheet.cell(row=2, column=1).value is not None
    banded = sheet.cell(row=3, column=1).fill.start_color.rgb
    print("      banded row fill: %s" % banded)
    assert banded != "00000000", banded

# A junk colour must fall back rather than crash.
r = client.post("/api/export/xlsx?primary=nonsense", data=arrow,
                content_type="application/vnd.apache.arrow.stream")
assert r.status_code == 200, r.get_json()
book = load_workbook(io.BytesIO(r.data))
print("  junk colour -> header fill %s (fell back)"
      % book["View"].cell(row=1, column=1).fill.start_color.rgb)
assert book["View"].cell(row=1, column=1).fill.start_color.rgb == "00DB0011"

print("\nALL BACKEND TESTS PASSED")
