"""Backend tests against the user's Sample Finance Data.xlsx + range/skip-cols/chat."""
import io
import os
import sys

import app as m
import pyarrow as pa

client = m.app.test_client()
SAMPLE = os.path.join("static", "Sample Finance Data.xlsx")
csv_bytes = open(SAMPLE, "rb").read()


def up(name="Sample Finance Data.xlsx", data=None):
    r = client.post(
        "/upload",
        data={"file": (io.BytesIO(data if data is not None else csv_bytes), name)},
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
assert j.get("placeholder") and "You asked: hi" in j["reply"]

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

print("\nALL BACKEND TESTS PASSED")
