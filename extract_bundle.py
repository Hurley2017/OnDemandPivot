"""
Unpack a bundle made by make_bundle.py.

Reads as bytes and splits on the record markers, so a file with CRLF endings
comes back with its carriage returns intact.

    python extract_bundle.py OnDemandPivot-Bundle.txt [outdir]
"""
import base64
import os
import sys

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else "OnDemandPivot"

raw = open(src, "rb").read()
start = raw.find(b"### FILE: ")
if start < 0:
    raise SystemExit("no file records found")

MARK_FILE = b"### FILE: "
MARK_SIZE = b"### SIZE: "
MARK_ENC = b"### ENCODING: "
MARK_END = b"### END FILE\n"

records = raw[start:].split(MARK_END)
count = 0
for record in records:
    # Records after the first are preceded by the newline that joined them.
    record = record.lstrip(b"\n")
    if not record.startswith(MARK_FILE):
        continue

    nl = record.index(b"\n")
    rel = record[len(MARK_FILE):nl].decode("utf-8")
    rest = record[nl + 1:]

    nl = rest.index(b"\n")
    size = int(rest[len(MARK_SIZE):nl].split()[0])
    rest = rest[nl + 1:]

    nl = rest.index(b"\n")
    enc = rest[len(MARK_ENC):nl].decode("ascii")
    body = rest[nl + 1:]

    # The writer puts exactly one newline between the body and the end marker.
    if body.endswith(b"\n"):
        body = body[:-1]

    data = base64.b64decode(body) if enc == "base64" else body
    if len(data) != size:
        raise SystemExit(
            f"{rel}: size mismatch, got {len(data)} want {size}"
        )

    target = os.path.join(out, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    with open(target, "wb") as fh:
        fh.write(data)
    count += 1

print(f"extracted {count} files to {out}")
