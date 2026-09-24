"""
Build one self-extracting, plain-text bundle of the whole project.

Two things have to be true at once:

  * it is ONE .txt, because that is all that may cross the company email, and it
    must unpack with nothing else travelling alongside it;
  * it reads as source, not as a single opaque blob, so it can be eyeballed and
    does not look like an encoded payload to a mail scanner.

So the file is a small Python program followed by the project's files as plain
delimited records inside one raw string. Text files appear verbatim; only true
binaries (the WASM engine, the font, the icons) are base64-encoded.

    python make_bundle.py                       # everything -> Desktop
    python make_bundle.py --source-only OUT     # skip static/vendor

`--source-only` is for routine updates: the vendored Perspective engine and font
are ~4.5 MB and never change between feature work, so leaving them out keeps the
bundle small enough to read straight from GitHub's file view. The machine
receiving an update already has them from the first full bundle.

Everything git tracks is included, so fixtures and local sample data are
excluded by construction.
"""
import base64
import os
import subprocess
import sys

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
SOURCE_ONLY = "--source-only" in sys.argv

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_NAME = ("OnDemandPivot-Update.txt" if SOURCE_ONLY
                else "OnDemandPivot-Bundle.txt")
OUT = ARGS[0] if ARGS else os.path.join(os.path.expanduser("~"), "Desktop",
                                        DEFAULT_NAME)

SKIP_PREFIX = (".git", "tests/fixtures/")
# The vendored engine and font: large, binary, and unchanged between feature
# work. They travel once, in the full bundle.
SOURCE_ONLY_SKIP = ("static/vendor/",)
TEXT_EXT = {".py", ".js", ".css", ".html", ".md", ".txt", ".json",
            ".yml", ".yaml", ".cfg", ".ini", ".toml", ""}

# The payload sits in a raw triple-quoted string, so a file containing the
# closing delimiter cannot be embedded verbatim.
CLOSER = "'''"

files = subprocess.run(
    ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
).stdout.split()
files = [f for f in files if not f.startswith(SKIP_PREFIX)]
if SOURCE_ONLY:
    files = [f for f in files if not f.startswith(SOURCE_ONLY_SKIP)]

records = []
raw_total = 0
encoded_binary = 0
for rel in sorted(files):
    path = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.isfile(path):
        continue
    blob = open(path, "rb").read()
    raw_total += len(blob)

    kind = "text"
    lineend = "lf"
    body = None
    if os.path.splitext(rel)[1].lower() in TEXT_EXT:
        try:
            body = blob.decode("utf-8")
        except UnicodeDecodeError:
            body = None
        # A raw string cannot hold its own terminator, and cannot end on a
        # backslash that would escape it.
        if body is not None and (CLOSER in body or body.rstrip("\n").endswith("\\")):
            body = None
        # Python normalises CRLF inside source, so carriage returns would be
        # lost. Record the convention and normalise the embedded copy; the
        # reader puts them back. A file is only "crlf" when *every* newline is
        # part of a CRLF pair — anything mixed travels as base64 to stay exact.
        if body is not None and "\r\n" in body:
            if body.count("\n") == body.count("\r\n"):
                lineend = "crlf"
                body = body.replace("\r\n", "\n")
            else:
                body = None

    if body is None:
        body = base64.b64encode(blob).decode("ascii")
        kind = "base64"
        lineend = "lf"
        encoded_binary += 1

    records.append(
        f"### FILE: {rel}\n"
        f"### SIZE: {len(blob)}\n"
        f"### ENCODING: {kind}\n"
        f"### LINEENDINGS: {lineend}\n"
        f"{body}\n"
        f"### END FILE"
    )

payload = "\n".join(records)

TEMPLATE = '''#!/usr/bin/env python3
"""
OnDemandPivot - self-extracting source bundle.

Carry this one .txt file; nothing else is needed. It is a Python program as well
as a text file, so it runs straight from its own name:

    python {basename} [output-dir]

It unpacks the project into ./OnDemandPivot by default, then:

    cd OnDemandPivot
    pip install -r requirements.txt
    python app.py

Nothing is downloaded at runtime: the app serves every asset from disk, so it
works on a machine with no internet access.

The project's files follow as plain delimited records. Text files are verbatim;
only true binaries are base64. To read one, search for "### FILE: app.py".

Files: {count}    Text: {text_count}    Binary: {binary_count}
Uncompressed: {raw:,} bytes    This file: {bundle:,} bytes
"""

import base64
import os
import sys

PAYLOAD = r\'\'\'
{payload}
\'\'\'


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    out = argv[0] if argv else "OnDemandPivot"

    marker = "### FILE: "
    endmark = "### END FILE"
    written = 0

    text = PAYLOAD
    while True:
        start = text.find(marker)
        if start < 0:
            break
        stop = text.find(endmark, start)
        if stop < 0:
            break

        record = text[start:stop]
        text = text[stop + len(endmark):]

        lines = record.split("\\n")
        rel = lines[0][len(marker):].strip()
        size = int(lines[1].split(": ", 1)[1])
        encoding = lines[2].split(": ", 1)[1].strip()
        lineend = lines[3].split(": ", 1)[1].strip()

        # Everything after the four header lines, minus the blank we added.
        body = "\\n".join(lines[4:])
        if body.endswith("\\n"):
            body = body[:-1]

        data = base64.b64decode(body) if encoding == "base64" else body.encode("utf-8")
        # Carriage returns cannot survive source, so they are put back here.
        if lineend == "crlf":
            data = data.replace(b"\\n", b"\\r\\n")
        if len(data) != size:
            raise SystemExit(
                "%s: expected %d bytes, rebuilt %d" % (rel, size, len(data))
            )

        target = os.path.join(out, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(data)
        written += 1

    print("Unpacked %d files into %s" % (written, os.path.abspath(out)))
    print()
    print("Next:")
    print("    cd %s" % out)
    print("    pip install -r requirements.txt")
    print("    python app.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''

text_count = len(records) - encoded_binary
text = TEMPLATE.format(
    payload=payload,
    basename=os.path.basename(OUT),
    count=len(records),
    text_count=text_count,
    binary_count=encoded_binary,
    raw=raw_total,
    bundle=len(payload),
)

with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(text)

print(f"wrote {OUT}")
print(f"  files: {len(records)}  (text {text_count}, base64 {encoded_binary})")
print(f"  uncompressed: {raw_total:,} bytes")
print(f"  bundle: {os.path.getsize(OUT):,} bytes")
print("  run with: python", os.path.basename(OUT))
