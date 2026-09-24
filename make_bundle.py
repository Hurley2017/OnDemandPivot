"""
Build a single self-contained text bundle of the whole project.

Everything git tracks is included (so the test fixtures and any local sample
data are excluded by construction), with binary assets base64-encoded so the
result is one plain .txt that survives email or a chat window.

Reconstruct with:  python extract_bundle.py OnDemandPivot-Bundle.txt <outdir>
"""
import base64
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.expanduser("~"), "Desktop", "OnDemandPivot-Bundle.txt")

TEXT_EXT = {".py", ".js", ".css", ".html", ".md", ".txt", ".json",
            ".yml", ".yaml", ".cfg", ".ini", ".toml", ".gitignore", ""}

files = subprocess.run(
    ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
).stdout.split()

# Skip the things that make no sense in a bundle or are not source.
SKIP = (".git", "tests/fixtures/")
files = [f for f in files if not f.startswith(SKIP)]

total = 0
chunks = []
for rel in sorted(files):
    path = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.isfile(path):
        continue
    blob = open(path, "rb").read()
    total += len(blob)
    ext = os.path.splitext(rel)[1].lower()
    is_text = ext in TEXT_EXT
    if is_text:
        try:
            body = blob.decode("utf-8")
            kind = "text"
        except UnicodeDecodeError:
            is_text = False
    if not is_text:
        body = base64.b64encode(blob).decode("ascii")
        kind = "base64"

    chunks.append(
        f"### FILE: {rel}\n"
        f"### SIZE: {len(blob)} bytes\n"
        f"### ENCODING: {kind}\n"
        f"{body}\n"
        f"### END FILE\n"
    )

header = (
    "OnDemandPivot — full source bundle\n"
    "Generated for transfer to an offline machine. Every file needed to run\n"
    "the app is here, including the vendored Perspective engine and font, so\n"
    "nothing is fetched at runtime.\n"
    "\n"
    "To rebuild the project:\n"
    "    python extract_bundle.py OnDemandPivot-Bundle.txt OnDemandPivot\n"
    "    cd OnDemandPivot\n"
    "    pip install -r requirements.txt\n"
    "    python app.py\n"
    "\n"
    f"Files: {len(chunks)}    Bytes: {total:,}\n"
    "=" * 72 + "\n"
)

with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(header)
    fh.write("\n".join(chunks))

print(f"wrote {OUT}")
print(f"  files: {len(chunks)}")
print(f"  source bytes: {total:,}")
print(f"  bundle size: {os.path.getsize(OUT):,} bytes")
