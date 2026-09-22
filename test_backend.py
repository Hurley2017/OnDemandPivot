"""Backend tests: sample workbook, ranges, restructuring, sheets, chat, export."""
import io
import os
import sys

import app as m
import pyarrow as pa

client = m.app.test_client()
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "tests", "fixtures")
SAMPLE = os.path.join(FIXTURES, "Sample Finance Data.xlsx")
XLSB = os.path.join(FIXTURES, "sample.xlsb")
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

# Country case/spacing variants must be flagged.
country = next(f for f in p["fields"] if f["name"] == "Country")
assert any("case/spacing" in a for a in country["anomalies"]), country
print("  Country anomalies:", country["anomalies"])

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
r = client.post("/api/chat", json={"query": "hi"})
j = r.get_json()
print("\nchat no creds ->", r.status_code, j)
assert j.get("placeholder") and "No model is connected" in j["reply"]

for payload in [
    {"query": "", "endpoint": "x", "api_key": "y"},
    {"query": "hi", "endpoint": "  ", "api_key": "  "},
    {"query": "hi", "endpoint": "", "api_key": "sk-something"},
]:
    r = client.post("/api/chat", json=payload)
    print("chat ->", payload, "=>", r.status_code, r.get_json())

# Unreachable endpoint must fail gracefully with 502, not blow up.
r = client.post("/api/chat", json={
    "query": "hi",
    "endpoint": "http://127.0.0.1:9/v1",
    "api_key": "sk-test",
})
j = r.get_json()
print("chat bad endpoint ->", r.status_code, str(j)[:160])
assert r.status_code == 502 and j["success"] is False

# Endpoint normalisation (base URL, full URL, bare host, trailing slash).
for e, want in [
    ("https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"),
    ("https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"),
    ("https://api.openai.com/v1/", "https://api.openai.com/v1/chat/completions"),
    ("api.openai.com/v1", "https://api.openai.com/v1/chat/completions"),
]:
    got = m._normalise_chat_endpoint(e)
    status = "ok " if got == want else "FAIL"
    print("  %s %-45s -> %s" % (status, e, got))
    assert got == want, (e, got, want)

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
print("\nopen-ended ranges:")
# Cleaning is disabled so the shapes reflect the range alone (raw = 711 rows).
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

print("\nALL BACKEND TESTS PASSED")
