"""
OnDemandPivot - Local Data Analysis Dashboard
Flask backend + Pandas/PyArrow data layer + Perspective JS frontend.
Packaged as a single .exe with PyInstaller.

Run in development:  python app.py
Run packaged:        double-click OnDemandPivot.exe (starts server + opens browser)
"""

import csv
import json
import math
import os
import re
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import webbrowser

import numpy as np
import pandas as pd
import pyarrow as pa
from flask import Flask, Response, jsonify, render_template, request
from werkzeug.utils import secure_filename

# ---------------------------------------------------------------------------
# Paths (PyInstaller onefile extracts bundled data to a temp dir via sys._MEIPASS)
# ---------------------------------------------------------------------------


def resource_path(relative_path: str) -> str:
    """Resolve a bundled resource path for both dev and frozen (PyInstaller) runs."""
    if getattr(sys, "frozen", False):
        base_path = sys._MEIPASS  # noqa: SLF001 - PyInstaller-provided attribute
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)


TEMPLATE_DIR = resource_path("templates")
STATIC_DIR = resource_path("static")

HOST = "127.0.0.1"
DEFAULT_PORT = 5000
APP_NAME = "Client Profitability Analytics"

ALLOWED_EXTENSIONS = {".csv", ".xlsx"}
UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "ondemandpivot")
PREVIEW_ROWS = 100

app = Flask(
    __name__,
    template_folder=TEMPLATE_DIR,
    static_folder=STATIC_DIR,
)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB upload cap
app.config["SECRET_KEY"] = "ondemandpivot-local-only"

# In-memory session store for the uploaded dataframe and its column profile.
# Single-user, local app -> a module-level dict is sufficient (no DB needed).
SESSION_DATA = {
    "path": None,          # path of the uploaded file on disk
    "filename": None,
    "raw_df": None,        # as-parsed (after skip-rows + name normalisation)
    "df": None,            # cleaned frame after restructuring options
    "processed_df": None,  # final frame handed to Perspective
    "options": {},         # last-applied restructuring options
    "profile": None,       # column summary: dtypes, missing values, anomalies
}


# ---------------------------------------------------------------------------
# Data helpers: parsing, cleaning, profiling, Arrow serialisation
# ---------------------------------------------------------------------------


def _unique_name(name: str, taken: set) -> str:
    """Return `name`, suffixed with _2/_3... if already used."""
    if name not in taken:
        taken.add(name)
        return name
    i = 2
    while f"{name}_{i}" in taken:
        i += 1
    final = f"{name}_{i}"
    taken.add(final)
    return final


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Collapse newlines/duplicate/blank headers into safe, unique string names."""
    taken: set = set()
    names = []
    for col in df.columns:
        name = str(col).replace("\n", " ").replace("\r", " ")
        name = re.sub(r"\s+", " ", name).strip()
        if not name or name.lower() == "nan":
            name = "(unnamed)"
        names.append(_unique_name(name, taken))
    df.columns = names
    return df


def _detect_header(path: str, skip_rows: int, max_scan: int = 300):
    """
    Locate the real header line of a messy CSV and guess its delimiter.

    `pd.read_csv` infers columns from line 1, so a file that opens with a
    title/banner row ("Q3 Sales Report") makes the tokenizer fail with
    "Expected 1 fields in line 4, saw 3". The header is almost always the
    first line carrying the widest field count, so scan for that instead.
    Returns (header_line_index, delimiter).
    """
    raw: list[str] = []
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as fh:
            for i, line in enumerate(fh):
                if i >= max_scan:
                    break
                raw.append(line)
    except OSError:
        return skip_rows, ","

    sample = "".join(raw)
    try:
        delim = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        delim = ","

    counts: list[int] = []
    for line in raw:
        if not line.strip():
            counts.append(0)
            continue
        try:
            counts.append(len(next(csv.reader([line], delimiter=delim))))
        except csv.Error:
            counts.append(0)

    widest = max(counts) if counts else 0
    if widest >= 2:
        for i, count in enumerate(counts):
            if count == widest and i >= skip_rows:
                return i, delim
    return skip_rows, delim


def _col_letters_to_index(letters: str) -> int:
    """Excel column letters -> 0-based index.  'A'->0, 'C'->2, 'AA'->26."""
    n = 0
    for ch in letters.upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


_RANGE_RE = re.compile(
    r"^\s*\$?([A-Z]{1,3})\$?(\d{1,7})\s*:\s*\$?([A-Z]{1,3})\$?(\d{1,7})\s*$",
    re.IGNORECASE,
)

# Excel serial day 1 = 1900-01-01, 2958465 = 9999-12-31.
_EXCEL_SERIAL_MAX = 2958465


def _parse_range(spec: str) -> dict:
    """
    Parse an Excel-style range such as 'B3:H500' for power users who already
    know where their table lives.

    Returns a dict describing the block, or raises ValueError with a message
    the UI can show verbatim:
        header_row  0-based row index of the header line
        start_col   0-based first column index (inclusive)
        end_col     0-based last column index (inclusive)
        nrows       data rows to read after the header, or None
    """
    text = (spec or "").strip()
    if not text:
        raise ValueError("Range is empty.")

    match = _RANGE_RE.match(text)
    if not match:
        raise ValueError(
            f"Range '{text}' is not valid. Use Excel notation like B3:H500."
        )

    c1, r1, c2, r2 = match.groups()
    start_col = _col_letters_to_index(c1)
    end_col = _col_letters_to_index(c2)
    start_row = int(r1) - 1  # Excel rows are 1-based; row 1 is the header
    end_row = int(r2) - 1

    if start_col > end_col:
        start_col, end_col = end_col, start_col
    if start_row > end_row:
        raise ValueError(
            f"Range '{text}' ends above where it starts (row {r1} > row {r2})."
        )

    return {
        "header_row": start_row,
        "start_col": start_col,
        "end_col": end_col,
        # Rows after the header, inclusive of the end row.
        "nrows": end_row - start_row,
    }


def _read_csv_tolerant(
    path: str, skip_rows: int, nrows: int | None = None
) -> pd.DataFrame:
    """
    Fallback parser for CSVs that defeat `pd.read_csv`'s header inference:
    banner/title rows above the header, a non-comma delimiter, or ragged
    rows. Re-read from the detected header line with bad rows skipped.
    """
    header_idx, delim = _detect_header(path, skip_rows)
    return pd.read_csv(
        path,
        sep=delim,
        skiprows=header_idx,
        nrows=None if nrows is None else nrows,
        low_memory=False,
        on_bad_lines="skip",
    )


def _read_file(
    path: str,
    skip_rows: int = 0,
    skip_cols: int = 0,
    data_range: str = "",
) -> pd.DataFrame:
    """
    Parse the stored upload.

    Three independent controls, in precedence order:
      data_range  Excel notation like 'B3:H500' - when given it defines the
                  header row, the column block and the row limit itself.
      skip_rows   rows to drop above the header (only if no range given)
      skip_cols   columns to drop from the left of whatever was read
    """
    skip_rows = max(0, int(skip_rows or 0))
    skip_cols = max(0, int(skip_cols or 0))

    spec = None
    if (data_range or "").strip():
        spec = _parse_range(data_range)
        # A range states its own header position, so it supersedes skip_rows.
        skip_rows = spec["header_row"]
    nrows = spec["nrows"] if spec else None

    ext = os.path.splitext(path)[1].lower()

    if ext == ".xlsx":
        df = pd.read_excel(
            path, skiprows=skip_rows, nrows=nrows, engine="openpyxl"
        )
    elif ext == ".csv":
        try:
            df = pd.read_csv(
                path, skiprows=skip_rows, nrows=nrows, low_memory=False
            )
            # A lone column usually means the delimiter was guessed wrong
            # rather than a genuinely single-column file, so retry the sniffer.
            if df.shape[1] > 1:
                pass
            else:
                df = _read_csv_tolerant(path, skip_rows, nrows)
        except (pd.errors.ParserError, pd.errors.EmptyDataError, UnicodeError):
            df = _read_csv_tolerant(path, skip_rows, nrows)
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    # Column block from an explicit range, otherwise "drop the first N".
    # Applied after the read because pandas' integer `usecols` semantics
    # relative to `skiprows` are ambiguous - iloc is unambiguous.
    if spec is not None:
        end_col = min(spec["end_col"] + 1, len(df.columns))
        df = df.iloc[:, spec["start_col"]:end_col]
    if skip_cols:
        df = df.iloc[:, skip_cols:]

    return _normalize_columns(df)


DEFAULT_OPTIONS = {
    "skip_rows": 0,
    "skip_cols": 0,
    "data_range": "",
    "strip_whitespace": True,
    "drop_empty_rows": True,
    "drop_empty_cols": True,
    "dedupe": True,
}


def _apply_options(df: pd.DataFrame, options: dict) -> pd.DataFrame:
    """Apply the user-facing restructuring/cleaning toggles to a parsed frame."""
    opts = {**DEFAULT_OPTIONS, **(options or {})}

    if opts.get("strip_whitespace"):
        for col in df.columns:
            if df[col].dtype == object or isinstance(
                df[col].dtype, pd.StringDtype
            ):
                s = df[col]
                # Only strip genuine strings; leave everything else untouched.
                mask = s.map(lambda v: isinstance(v, str))
                if mask.any():
                    df.loc[mask, col] = s[mask].str.strip()

    if opts.get("drop_empty_rows"):
        df = df.dropna(how="all")

    if opts.get("drop_empty_cols"):
        df = df.dropna(axis=1, how="all")

    if opts.get("dedupe") and len(df):
        df = df.drop_duplicates()

    return df.reset_index(drop=True)


def _infer_datetimes(df: pd.DataFrame) -> pd.DataFrame:
    """
    Promote text columns that are overwhelmingly date-like to real datetimes.

    Pandas does not parse dates during `read_csv`, which would leave the
    dashboard sorting "2024-9-30" *after* "2024-10-01". Only columns whose
    values actually look like dates are converted, so free-text fields
    (names, regions, notes) are left untouched.
    """
    for col in df.columns:
        series = df[col]
        if not (
            series.dtype == object
            or isinstance(series.dtype, pd.StringDtype)
            or pd.api.types.is_string_dtype(series.dtype)
        ):
            continue

        non_null = series.dropna()
        if not len(non_null):
            continue

        as_str = non_null.astype(str)
        # Require a date separator/time marker before even attempting a parse,
        # which cheaply rules out categorical text.
        looks_datey = as_str.str.contains(r"[-/:]", regex=True, na=False)
        if not bool(looks_datey.all()) or int(looks_datey.sum()) < len(non_null):
            continue

        try:
            parsed = pd.to_datetime(series, errors="coerce", format="mixed")
        except (ValueError, TypeError):
            continue

        parsed_non_null = parsed.notna().sum()
        original_non_null = int(series.notna().sum())
        if original_non_null and parsed_non_null >= original_non_null * 0.95:
            df[col] = parsed

    return df


def _infer_excel_serial_dates(df: pd.DataFrame) -> pd.DataFrame:
    """
    Convert Excel serial numbers stored in a date-named column to datetimes.

    Excel writes dates as a day count from 1899-12-30, so a column literally
    called "Date" can come back as float 41640.0 - which Perspective would
    happily chart as an ordinary number instead of a time axis.

    Deliberately conservative: the column name must say date/day AND the
    values must all sit inside a plausible serial window (1970-01-01 to
    ~2118), so "Year" (2014) and "Month Number" (1-12) are left alone.
    """
    for col in df.columns:
        series = df[col]
        if not pd.api.types.is_numeric_dtype(series):
            continue
        if pd.api.types.is_bool_dtype(series):
            continue
        if not re.search(r"\b(date|day)\b", str(col), re.IGNORECASE):
            continue

        non_null = series.dropna()
        if len(non_null) < 2:
            continue

        values = non_null.to_numpy(dtype="float64", copy=False)
        # Excel serial for 1970-01-01 .. ~2118-04; anything outside is not a
        # date we are willing to guess at.
        if not (values.min() >= 25569 and values.max() <= 80000):
            continue
        # Serial days are whole numbers; keep centred/scaled metrics out.
        if not bool(np.allclose(values, np.round(values))):
            continue

        df[col] = pd.to_datetime(series, unit="D", origin="1899-12-30")

    return df


def _column_kind(series: pd.Series) -> str:
    """Map a pandas dtype to a coarse 'KPI kind' used by the UI."""
    dtype = series.dtype
    if pd.api.types.is_bool_dtype(dtype):
        return "boolean"
    if pd.api.types.is_numeric_dtype(dtype):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(dtype):
        return "datetime"
    if isinstance(dtype, pd.CategoricalDtype):
        return "category"
    if pd.api.types.is_timedelta64_dtype(dtype):
        return "timedelta"
    return "string"


def _safe_float(value):
    """JSON-safe float (NaN/Inf -> None), rounded for display."""
    if value is None or value is pd.NaT:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(out) or math.isinf(out):
        return None
    return round(out, 4)


def _profile_column(name: str, series: pd.Series, n_rows: int) -> dict:
    """Build the per-column KPI record: dtype, kind, missing, anomalies, stats."""
    kind = _column_kind(series)
    missing = int(series.isna().sum())
    missing_pct = round((missing / n_rows * 100.0), 2) if n_rows else 0.0
    unique = int(series.nunique(dropna=True))
    anomalies: list[str] = []

    non_null = series.dropna()
    sample = None
    if len(non_null):
        first = non_null.iloc[0]
        sample = str(first)[:80]

    stats: dict = {}

    if n_rows == 0:
        anomalies.append("Column contains no rows")
    elif missing == n_rows:
        anomalies.append("All values are missing")
    elif missing:
        anomalies.append(f"{missing} missing value(s)")

    if missing_pct > 50 and missing < n_rows:
        anomalies.append(f"High missing rate ({missing_pct}%)")

    if kind == "number":
        inf_mask = series.isin([np.inf, -np.inf])
        inf_count = int(inf_mask.sum())
        if inf_count:
            anomalies.append(f"{inf_count} infinite value(s)")
            series = series.replace([np.inf, -np.inf], np.nan)
            non_null = series.dropna()

        if unique == 1 and len(non_null):
            anomalies.append("Constant column (one distinct value)")
        elif unique == 0:
            anomalies.append("No usable numeric values")

        if len(non_null) >= 8:
            q1, q3 = non_null.quantile(0.25), non_null.quantile(0.75)
            iqr = q3 - q1
            if pd.notna(iqr) and iqr > 0:
                lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
                outliers = int(((non_null < lo) | (non_null > hi)).sum())
                if outliers:
                    anomalies.append(
                        f"{outliers} potential outlier(s) (IQR rule)"
                    )

        if len(non_null):
            stats = {
                "min": _safe_float(non_null.min()),
                "max": _safe_float(non_null.max()),
                "mean": _safe_float(non_null.mean()),
                "sum": _safe_float(non_null.sum()),
            }
    else:
        if unique == 1 and len(non_null):
            anomalies.append("Constant column (one distinct value)")

        if kind in ("string", "category") and len(non_null):
            as_str = non_null.astype(str)
            padded = int((as_str != as_str.str.strip()).sum())
            if padded:
                anomalies.append(
                    f"{padded} value(s) with leading/trailing whitespace"
                )
            lengths = as_str.str.len()
            if len(lengths) and lengths.max() > 200:
                anomalies.append(
                    f"Very long text values (max {int(lengths.max())} chars)"
                )

            # Same word spelled with different case/spacing splits into
            # separate groups ("CANADA" vs "germany" vs "Germany"), which
            # silently fragments any pivot grouped on this column.
            folded = as_str.str.strip().str.casefold()
            raw_unique = int(as_str.nunique())
            folded_unique = int(folded.nunique())
            if raw_unique > 1 and 0 < folded_unique < raw_unique:
                anomalies.append(
                    f"{raw_unique - folded_unique} value(s) differ only by "
                    f"case/spacing - they will group separately"
                )

    if re.match(r"^Unnamed:\s*\d+$", str(name)):
        anomalies.append(
            "Auto-generated header (header row may be misaligned)"
        )

    return {
        "name": str(name),
        "dtype": str(series.dtype),
        "kind": kind,
        "missing": missing,
        "missing_pct": missing_pct,
        "unique": unique,
        "sample": sample,
        "stats": stats,
        "anomalies": anomalies,
    }


def _build_profile(df: pd.DataFrame, filename: str | None = None) -> dict:
    """Whole-frame summary plus one record per column."""
    n_rows = int(len(df))
    n_cols = int(len(df.columns))
    missing_cells = int(df.isna().sum().sum())
    total_cells = n_rows * n_cols
    dupes = int(df.duplicated().sum()) if n_rows else 0

    fields = [
        _profile_column(str(col), df[col], n_rows) for col in df.columns
    ]
    flagged = sum(1 for f in fields if f["anomalies"])

    return {
        "filename": filename,
        "rows": n_rows,
        "cols": n_cols,
        "missing_cells": missing_cells,
        "missing_pct": (
            round(missing_cells / total_cells * 100.0, 2)
            if total_cells
            else 0.0
        ),
        "duplicate_rows": dupes,
        "flagged_fields": flagged,
        "fields": fields,
    }


def _df_preview(df: pd.DataFrame, n: int = PREVIEW_ROWS) -> dict:
    """First N rows as JSON-safe records for the preview table."""
    head = df.head(n)
    records = json.loads(
        head.to_json(orient="records", date_format="iso", date_unit="ms")
    )
    fields = [
        {"name": str(col), "kind": _column_kind(df[col])}
        for col in df.columns
    ]
    return {
        "fields": fields,
        "records": records,
        "shown": len(records),
        "total": int(len(df)),
    }


def _prepare_for_arrow(df: pd.DataFrame) -> pd.DataFrame:
    """
    Coerce a frame so `pa.Table.from_pandas` cannot fail on mixed/odd dtypes.
    Arrow has no notion of a heterogeneous `object` column, so those are
    normalised to text (or numeric when the coercion is lossless).
    """
    out = df.copy()
    out.columns = [str(c) for c in out.columns]

    for col in list(out.columns):
        series = out[col]
        dtype = series.dtype

        if isinstance(dtype, pd.CategoricalDtype):
            out[col] = series.astype("string")
            continue

        if pd.api.types.is_timedelta64_dtype(dtype):
            out[col] = series.dt.total_seconds()
            continue

        if pd.api.types.is_datetime64_any_dtype(dtype):
            try:
                if getattr(series.dt, "tz", None) is not None:
                    out[col] = series.dt.tz_localize(None)
            except (TypeError, AttributeError):
                out[col] = series.astype("datetime64[ns]")
            continue

        if dtype == object:
            non_null = series.dropna()
            if non_null.empty:
                out[col] = series.astype("string")
            elif bool(non_null.map(lambda v: isinstance(v, str)).all()):
                out[col] = series.astype("string")
            else:
                numeric = pd.to_numeric(series, errors="coerce")
                # Keep the numeric view only if it did not swallow real data.
                recovered = int(numeric.notna().sum())
                if recovered >= max(1, int(non_null.notna().sum()) * 0.9):
                    out[col] = numeric
                else:
                    out[col] = series.map(
                        lambda v: v if isinstance(v, str) else str(v)
                    ).astype("string")

    return out


def _df_to_arrow_stream(df: pd.DataFrame) -> bytes:
    """
    Serialise a DataFrame to the Apache Arrow IPC *streaming* format, which is
    the wire format Perspective's JS client consumes via `worker.table(buf)`.
    """
    table = pa.Table.from_pandas(
        _prepare_for_arrow(df), preserve_index=False
    )
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue().to_pybytes()


def _err(message: str, status: int = 400):
    return jsonify({"success": False, "error": message}), status


def _merge_options(payload: dict | None) -> dict:
    opts = dict(DEFAULT_OPTIONS)
    payload = payload or {}
    for key in ("skip_rows", "skip_cols"):
        try:
            opts[key] = max(0, int(payload.get(key, 0) or 0))
        except (TypeError, ValueError):
            opts[key] = 0
    opts["data_range"] = str(payload.get("data_range", "") or "").strip()
    for key in ("strip_whitespace", "drop_empty_rows", "drop_empty_cols", "dedupe"):
        if key in payload:
            opts[key] = bool(payload[key])
    return opts


def _rebuild(options: dict) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """Re-read the upload and return (raw, cleaned, profile)."""
    raw = _read_file(
        SESSION_DATA["path"],
        skip_rows=options["skip_rows"],
        skip_cols=options.get("skip_cols", 0),
        data_range=options.get("data_range", ""),
    )
    cleaned = _apply_options(raw.copy(), options)
    cleaned = _infer_excel_serial_dates(cleaned)
    cleaned = _infer_datetimes(cleaned)
    profile = _build_profile(cleaned, SESSION_DATA.get("filename"))
    return raw, cleaned, profile


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    """Upload page: drag-and-drop zone for .csv / .xlsx files."""
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    """
    Accept the uploaded file, parse it with Pandas, and return a JSON summary:
    column names (KPIs), data types, missing-value counts, anomalies and a
    preview table.  Frontend sends multipart/form-data with field 'file'.
    """
    file = request.files.get("file")
    if file is None or not file.filename:
        return _err("No file selected.")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return _err("Only .csv and .xlsx files are supported.")

    filename = secure_filename(file.filename) or f"upload{ext}"
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = os.path.join(
        UPLOAD_DIR, f"{int(time.time() * 1000)}_{filename}"
    )
    file.save(path)

    options = dict(DEFAULT_OPTIONS)
    # _rebuild() reads from SESSION_DATA["path"], so register the new file
    # first; a parse failure clears it again below.
    SESSION_DATA.update(
        {
            "path": path,
            "filename": filename,
            "raw_df": None,
            "df": None,
            "processed_df": None,
            "options": options,
            "profile": None,
        }
    )

    try:
        raw, cleaned, profile = _rebuild(options)
    except Exception as exc:  # malformed CSV/XLSX
        SESSION_DATA.update(
            {
                "path": None,
                "filename": None,
                "raw_df": None,
                "df": None,
                "processed_df": None,
                "profile": None,
            }
        )
        return _err(f"Could not parse file: {exc}", status=422)

    if cleaned.shape[1] == 0:
        return _err(
            "The file has no usable columns after cleaning.", status=422
        )

    SESSION_DATA.update(
        {
            "raw_df": raw,
            "df": cleaned,
            "profile": profile,
        }
    )

    return jsonify(
        {
            "success": True,
            "filename": filename,
            "profile": profile,
            "preview": _df_preview(cleaned),
            "options": options,
        }
    )


@app.route("/preview", methods=["POST"])
def preview():
    """
    Apply restructuring options (skip first N rows, strip whitespace, drop
    empty rows/columns, dedupe) and return a refreshed profile + preview.
    """
    if not SESSION_DATA.get("path"):
        return _err("No upload in session. Please upload a file.", 404)

    options = _merge_options(request.get_json(silent=True))
    try:
        raw, cleaned, profile = _rebuild(options)
    except Exception as exc:
        return _err(f"Could not re-parse file: {exc}", status=422)

    SESSION_DATA.update(
        {
            "raw_df": raw,
            "df": cleaned,
            "options": options,
            "profile": profile,
        }
    )

    return jsonify(
        {
            "success": True,
            "profile": profile,
            "preview": _df_preview(cleaned),
            "options": options,
        }
    )


@app.route("/process", methods=["POST"])
def process():
    """Finalize cleaning, store the processed dataframe, then send the client
    to the dashboard."""
    if not SESSION_DATA.get("path"):
        return _err("No upload in session. Please upload a file.", 404)

    options = _merge_options(request.get_json(silent=True))
    try:
        raw, cleaned, profile = _rebuild(options)
    except Exception as exc:
        return _err(f"Could not process file: {exc}", status=422)

    if cleaned.empty or cleaned.shape[1] == 0:
        return _err(
            "Nothing left to analyse - every row/column was removed. "
            "Try disabling 'Drop empty rows/columns'.",
            status=422,
        )

    # Fail fast if the frame cannot be Arrow-serialised for Perspective.
    try:
        _df_to_arrow_stream(cleaned)
    except Exception as exc:
        return _err(f"Data cannot be converted for the dashboard: {exc}", 500)

    SESSION_DATA.update(
        {
            "raw_df": raw,
            "df": cleaned,
            "processed_df": cleaned,
            "options": options,
            "profile": profile,
        }
    )

    return jsonify(
        {
            "success": True,
            "url": "/dashboard",
            "rows": int(len(cleaned)),
            "cols": int(cleaned.shape[1]),
        }
    )


@app.route("/dashboard")
def dashboard():
    """Main dashboard: Perspective viewer + KPI side panel + AI chat window."""
    if SESSION_DATA.get("processed_df") is None:
        return index()
    profile = SESSION_DATA.get("profile") or {}
    return render_template(
        "dashboard.html",
        filename=SESSION_DATA.get("filename") or "dataset",
        rows=int(len(SESSION_DATA["processed_df"])),
        cols=int(SESSION_DATA["processed_df"].shape[1]),
        flagged=int(profile.get("flagged_fields", 0)),
    )


@app.route("/api/data")
def api_data():
    """Serialize the processed dataframe to Apache Arrow (IPC streaming format)
    and stream it to the frontend for `perspective.worker().table(buf)`."""
    df = SESSION_DATA.get("processed_df")
    if df is None:
        return _err("No processed dataset. Upload a file first.", 404)

    try:
        payload = _df_to_arrow_stream(df)
    except Exception as exc:
        return _err(f"Arrow serialisation failed: {exc}", 500)

    return Response(
        payload,
        mimetype="application/vnd.apache.arrow.stream",
        headers={"Cache-Control": "no-store"},
    )


@app.route("/api/kpis")
def api_kpis():
    """Return the column profile (dtypes, missing values, anomalies) for the
    dashboard's KPI side panel."""
    profile = SESSION_DATA.get("profile")
    if profile is None:
        return _err("No dataset loaded. Upload a file first.", 404)
    return jsonify({"success": True, "profile": profile})


DEFAULT_MODEL = "gpt-4o-mini"
LLM_TIMEOUT_SECONDS = 60


def _normalise_chat_endpoint(endpoint: str) -> str:
    """
    Accept either a base URL (https://api.openai.com/v1) or a full
    /chat/completions URL and always return the full URL.
    """
    url = endpoint.strip().rstrip("/")
    if not url:
        return ""
    if not re.match(r"^https?://", url, re.IGNORECASE):
        url = "https://" + url
    if not url.endswith("/chat/completions"):
        url = url + "/chat/completions"
    return url


def _call_openai_compatible(
    endpoint: str, api_key: str, model: str, query: str
) -> str:
    """
    Proxy a chat completion to a user-supplied OpenAI-compatible endpoint.

    This runs server-side so the browser never has to surface CORS
    restrictions, and so the key only ever travels over loopback.
    """
    body = json.dumps(
        {
            "model": model or DEFAULT_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are the AI Data Assistant inside a local data "
                        "analysis dashboard. Answer concisely. If you do not "
                        "have the underlying data, say so rather than "
                        "inventing figures."
                    ),
                },
                {"role": "user", "content": query},
            ],
            "temperature": 0.2,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        _normalise_chat_endpoint(endpoint),
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            # Also covers endpoints that ignore the header entirely.
            "Authorization": f"Bearer {api_key}",
            "x-api-key": api_key,
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(
            f"Endpoint returned HTTP {exc.code}: {detail or exc.reason}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach endpoint: {exc.reason}") from exc
    except TimeoutError as exc:
        raise RuntimeError(
            f"Endpoint did not respond within {LLM_TIMEOUT_SECONDS}s."
        ) from exc

    # OpenAI shape: choices[0].message.content
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        # Anthropic shape: content[0].text
        blocks = payload.get("content")
        if isinstance(blocks, list) and blocks:
            content = blocks[0].get("text")
        else:
            raise RuntimeError(
                "Endpoint response had no recognizable message content."
            ) from None

    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("Endpoint returned an empty message.")
    return content.strip()


@app.route("/api/chat", methods=["POST"])
def api_chat():
    """
    AI Data Assistant.

    With endpoint + API key supplied, proxies to the user's own
    OpenAI-compatible model. Without them, returns the placeholder reply so
    the feature stays usable offline.
    """
    payload = request.get_json(silent=True) or {}
    query = (payload.get("query") or "").strip()
    if not query:
        return _err("Empty query.")

    endpoint = (payload.get("endpoint") or "").strip()
    api_key = (payload.get("api_key") or "").strip()
    model = (payload.get("model") or "").strip()

    if not endpoint or not api_key:
        return jsonify(
            {
                "success": True,
                "placeholder": True,
                "reply": f"AI model integration pending. You asked: {query}",
            }
        )

    try:
        reply = _call_openai_compatible(endpoint, api_key, model, query)
    except RuntimeError as exc:
        return _err(str(exc), status=502)
    except Exception as exc:  # noqa: BLE001 - surface anything else verbatim
        return _err(f"Chat request failed: {exc}", status=502)

    return jsonify({"success": True, "reply": reply})


@app.errorhandler(413)
def too_large(_error):
    return jsonify({"success": False, "error": "File too large (max 100 MB)"}), 413


# ---------------------------------------------------------------------------
# Execution & browser auto-open logic
# ---------------------------------------------------------------------------


def find_free_port(preferred: int = DEFAULT_PORT) -> int:
    """Return `preferred` if available, otherwise any free ephemeral port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if sock.connect_ex((HOST, preferred)) != 0:
            return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


def open_browser_later(url: str, delay: float = 1.5) -> None:
    """Wait for the server to come up, then open the default web browser."""
    time.sleep(delay)
    webbrowser.open(url)


def run() -> None:
    port = find_free_port(DEFAULT_PORT)
    url = f"http://{HOST}:{port}"

    # Open the browser from a daemon thread so it never blocks app startup.
    threading.Thread(target=open_browser_later, args=(url,), daemon=True).start()

    print(f" * {APP_NAME} running at {url}")
    print(" * Press Ctrl+C to quit.")
    try:
        # threaded=True keeps Perspective's Arrow fetch and the chat endpoint
        # responsive while other requests are in flight.
        app.run(host=HOST, port=port, debug=False, use_reloader=False, threaded=True)
    except KeyboardInterrupt:
        print("\n * Shutting down.")


if __name__ == "__main__":
    run()
