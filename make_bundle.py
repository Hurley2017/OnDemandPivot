"""
Build one self-extracting .txt bundle of the whole project.

The output is a single text file that is *also* a runnable Python program, so it
can be carried to a machine that forbids .py files in transit and unpacked there
with nothing but Python itself:

    python OnDemandPivot-Bundle.txt

Everything git tracks is included (so test fixtures and local sample data are
excluded by construction). The payload is a zip, base64-encoded, which keeps
every byte — including CRLF endings — exactly as it is here.

Regenerate with:  python make_bundle.py [output.txt]
"""
import base64
import io
import os
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "OnDemandPivot-Bundle.txt")

SKIP_PREFIX = (".git", "tests/fixtures/")

files = subprocess.run(
    ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
).stdout.split()
files = [f for f in files if not f.startswith(SKIP_PREFIX)]

buffer = io.BytesIO()
raw_total = 0
with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for rel in sorted(files):
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.isfile(path):
            continue
        blob = open(path, "rb").read()
        raw_total += len(blob)
        # Zip stores the bytes; a fixed date keeps rebuilds reproducible.
        info = zipfile.ZipInfo(rel, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        zf.writestr(info, blob)

payload = base64.b64encode(buffer.getvalue()).decode("ascii")

# The payload is wrapped so no single line is enormous; the reader strips the
# newlines before decoding.
WRAP = 96
lines = [payload[i:i + WRAP] for i in range(0, len(payload), WRAP)]

TEMPLATE = '''#!/usr/bin/env python3
"""
OnDemandPivot - self-extracting source bundle.

Carry this one .txt file. Nothing else is needed: it is a Python program as
well as a text file, so it can be run straight from its own name.

    python OnDemandPivot-Bundle.txt [output-dir]

It unpacks the whole project (app, dashboard, vendored Perspective engine and
font - everything) into ./OnDemandPivot by default. Then:

    cd OnDemandPivot
    pip install -r requirements.txt
    python app.py

Nothing is downloaded at runtime: the app serves every asset from disk, so it
works on a machine with no internet access.

Files: {count}    Uncompressed: {raw:,} bytes    Bundle: {bundle:,} bytes
"""

import base64
import os
import sys
import zipfile
from io import BytesIO

PAYLOAD = """\\
{payload}
"""


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    out = argv[0] if argv else "OnDemandPivot"

    data = base64.b64decode("".join(PAYLOAD.split()))
    with zipfile.ZipFile(BytesIO(data)) as archive:
        names = archive.namelist()
        archive.extractall(out)

    print("Unpacked %d files into %s" % (len(names), os.path.abspath(out)))
    print()
    print("Next:")
    print("    cd %s" % out)
    print("    pip install -r requirements.txt")
    print("    python app.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''

text = TEMPLATE.format(
    count=len(files),
    raw=raw_total,
    bundle=len(payload),
    payload="\n".join(lines),
)

with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(text)

print(f"wrote {OUT}")
print(f"  files: {len(files)}")
print(f"  uncompressed: {raw_total:,} bytes")
print(f"  bundle: {os.path.getsize(OUT):,} bytes")
print("  transferable as .txt, runnable with: python", os.path.basename(OUT))
