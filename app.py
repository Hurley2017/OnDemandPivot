"""
OnDemandPivot - Local Data Analysis Dashboard
Flask backend + Pandas/PyArrow data layer + Perspective JS frontend.
Packaged as a single .exe with PyInstaller.

Run in development:  python app.py
Run packaged:        double-click OnDemandPivot.exe (starts server + opens browser)
"""

import csv
import io
import json
import math
import os
import re
import socket
import sys
import tempfile
import threading
import time
import webbrowser

import numpy as np
import pandas as pd
import pyarrow as pa
from flask import Flask, Response, jsonify, render_template, request
from openpyxl import Workbook
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

ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".xlsb"}
# Excel formats we can open, and the pandas engine each one needs.
EXCEL_ENGINES = {".xlsx": "openpyxl", ".xlsb": "pyxlsb"}
UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "ondemandpivot")
PREVIEW_ROWS = 100  # sent to the browser; the table shows ~20 and scrolls
PREVIEW_COLS = 60   # display cap only; the dashboard always gets every column
# Above this many cells a .xlsx export is swapped for CSV (see /api/export/*).
EXCEL_CELL_BUDGET = 500_000

# Banding every other row means a styled cell object for half the sheet, which
# costs real time. Above this many cells the workbook keeps the themed header
# (one row) and drops the banding.
EXCEL_BANDING_BUDGET = 120_000

# What the exported workbook looks like when the caller names no colour.
EXCEL_DEFAULT_PRIMARY = "#db0011"


def _excel_theme(primary):
    """
    Colours for the exported sheet, derived from the dashboard's palette.

    The header takes the palette's primary and its text flips to black when that
    colour is too pale to carry white — the same rule the on-screen grid uses, so
    the workbook and the dashboard agree.
    """
    raw = (primary or "").strip()
    if not re.fullmatch(r"#?[0-9a-fA-F]{6}", raw or ""):
        raw = EXCEL_DEFAULT_PRIMARY
    primary = raw if raw.startswith("#") else "#" + raw
    hex_only = primary.lstrip("#").upper()

    r, g, b = (int(hex_only[i:i + 2], 16) / 255 for i in (0, 2, 4))

    def linear(channel):
        return channel / 12.92 if channel <= 0.03928 else (
            ((channel + 0.055) / 1.055) ** 2.4
        )

    luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    on_primary = "1A1A1A" if luminance > 0.45 else "FFFFFF"

    def tint(channel, amount):
        return round((channel + (1 - channel) * amount) * 255)

    zebra = "".join(f"{tint(c, 0.955):02X}" for c in (r, g, b))
    return {"primary": hex_only, "on_primary": on_primary, "zebra": zebra}


def _write_themed_sheet(sheet, frame, theme):
    """Write the frame with the dashboard's header colour and row banding."""
    from openpyxl.cell import WriteOnlyCell
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    header_font = Font(bold=True, color=theme["on_primary"], size=10)
    header_fill = PatternFill("solid", fgColor=theme["primary"])
    header_align = Alignment(horizontal="left", vertical="center")

    head = []
    for name in frame.columns:
        cell = WriteOnlyCell(sheet, value=str(name))
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_align
        head.append(cell)
    sheet.append(head)

    cells_total = len(frame) * max(1, frame.shape[1])
    band = cells_total <= EXCEL_BANDING_BUDGET
    zebra_fill = PatternFill("solid", fgColor=theme["zebra"]) if band else None

    for index, row in enumerate(frame.itertuples(index=False, name=None)):
        values = list(row)
        if band and index % 2 == 1:
            cells = []
            for value in values:
                cell = WriteOnlyCell(sheet, value=value)
                cell.fill = zebra_fill
                cells.append(cell)
            sheet.append(cells)
        else:
            sheet.append(values)

    # Widths guessed from the header, so the sheet opens readable.
    for position, name in enumerate(frame.columns, start=1):
        letter = get_column_letter(position)
        sheet.column_dimensions[letter].width = min(
            42, max(11, len(str(name)) + 3)
        )


app = Flask(
    __name__,
    template_folder=TEMPLATE_DIR,
    static_folder=STATIC_DIR,
)
# 100 MB uploads, plus headroom for posting a large view back for export.
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024
app.config["SECRET_KEY"] = "ondemandpivot-local-only"
# Never let a browser serve a stale stylesheet/script after an update.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


def asset_version(filename: str) -> str:
    """File mtime used as a cache-busting query string in the templates."""
    try:
        return str(int(os.path.getmtime(os.path.join(STATIC_DIR, filename))))
    except OSError:
        return "0"


app.jinja_env.globals["asset_version"] = asset_version

# In-memory session store for the uploaded dataframe and its column profile.
# Single-user, local app -> a module-level dict is sufficient (no DB needed).
SESSION_DATA = {
    "path": None,          # path of the uploaded file on disk
    "filename": None,      # filesystem-safe name used on disk
    "display_name": None,  # the name the user actually picked
    "raw_df": None,        # as-parsed (after skip-rows + name normalisation)
    "df": None,            # cleaned frame after restructuring options
    "processed_df": None,  # final frame handed to Perspective
    "options": {},         # last-applied restructuring options
    "profile": None,       # column summary: dtypes, missing values, anomalies
    "sheets": [],          # worksheet names when the upload is Excel
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


# One side of a range: optional column letters, optional row number, each with
# an optional '$' anchor.  "B3", "B", "3" and "" are all valid sides, so the
# parser accepts Excel's open-ended forms: A:C, 2:5, B3:H, A1:.
_RANGE_SIDE_RE = re.compile(r"^\s*\$?([A-Z]{1,3})?\$?(\d{1,7})?\s*$", re.IGNORECASE)
_RANGE_RE = re.compile(r"^(.*?):(.*)$")

# Excel serial day 1 = 1900-01-01, 2958465 = 9999-12-31.
_EXCEL_SERIAL_MAX = 2958465


def _parse_range_side(side: str):
    """Split one side of a range into (column_index, row_number), either may be None."""
    match = _RANGE_SIDE_RE.match(side or "")
    if not match:
        return None
    letters, digits = match.groups()
    col = _col_letters_to_index(letters) if letters else None
    row = int(digits) if digits else None
    return col, row


def _parse_range(spec: str, skip_rows: int = 0) -> dict:
    """
    Parse an Excel-style range for power users who already know where their
    table lives.

    Both sides may omit the column letters, the row number, or both, so all of
    Excel's shapes work:

        A1:D6    bounded block
        A:C      columns A..C, header on the first row (or skip-rows)
        B3:H     columns B..H, header on row 3, to the end of the sheet
        2:5      rows 2..5, every column
        B3       a single cell / column starting at row 3

    Returns a dict, or raises ValueError with a message the UI shows verbatim:
        header_row  0-based row index of the header line
        start_col   0-based first column index (inclusive)
        end_col     0-based last column index (inclusive), None = last column
        nrows       data rows to read after the header, or None = all
        row_bounded whether the range pinned any row information
    """
    text = (spec or "").strip()
    if not text:
        raise ValueError("Range is empty.")

    match = _RANGE_RE.match(text)
    if not match:
        # A bare cell such as "B3": one column, header on that row, all rows
        # below it. "B" alone means column B with the usual header row.
        side = _parse_range_side(text)
        if side is None or side == (None, None):
            raise ValueError(
                f"Range '{text}' is not valid. Use Excel notation such as "
                "B3:H500, A:C or 2:5."
            )
        col, row = side
        return {
            "header_row": max(0, (row or 1) - 1) if row else max(0, int(skip_rows or 0)),
            "start_col": 0 if col is None else col,
            "end_col": 0 if col is None else col,
            "nrows": None,
            "row_bounded": row is not None,
        }

    left, right = match.groups()

    a = _parse_range_side(left)
    b = _parse_range_side(right)
    if a is None or b is None or (a == (None, None) and b == (None, None)):
        raise ValueError(
            f"Range '{text}' is not valid. Use Excel notation such as "
            "B3:H500, A:C or 2:5."
        )

    (col_a, row_a), (col_b, row_b) = a, b

    # Columns: either bound may be omitted -> open on that side.
    if col_a is None and col_b is None:
        start_col, end_col = 0, None
    else:
        start_col = 0 if col_a is None else col_a
        end_col = start_col if col_b is None else col_b
        if start_col > end_col:  # tolerate a right-to-left drag
            start_col, end_col = end_col, start_col

    # Rows: Excel row 1 is the header line for our purposes.
    row_bounded = row_a is not None or row_b is not None
    if not row_bounded:
        header_row = max(0, int(skip_rows or 0))
        nrows = None
    else:
        header_row = max(0, (row_a or 1) - 1)
        if row_b is None:
            nrows = None
        else:
            last_row = max(row_a or 1, row_b) - 1
            nrows = max(0, last_row - header_row)

    return {
        "header_row": header_row,
        "start_col": start_col,
        "end_col": end_col,
        "nrows": nrows,
        "row_bounded": row_bounded,
    }


def _read_csv_tolerant(
    path: str, skip_rows: int, nrows: int | None = None, header: bool = True
) -> pd.DataFrame:
    """
    Fallback parser for CSVs that defeat `pd.read_csv`'s header inference:
    banner/title rows above the header, a non-comma delimiter, or ragged
    rows. Re-read from the detected header line with bad rows skipped.
    """
    header_idx = skip_rows
    delim = ","
    if header:
        header_idx, delim = _detect_header(path, skip_rows)
    return pd.read_csv(
        path,
        sep=delim,
        skiprows=header_idx,
        nrows=None if nrows is None else nrows,
        header=0 if header else None,
        low_memory=False,
        on_bad_lines="skip",
    )


def _list_sheets(path: str) -> list:
    """Sheet names for an Excel upload (empty list for CSV)."""
    engine = EXCEL_ENGINES.get(os.path.splitext(path)[1].lower())
    if not engine:
        return []
    try:
        with pd.ExcelFile(path, engine=engine) as book:
            return [str(name) for name in book.sheet_names]
    except Exception:  # noqa: BLE001 - a broken workbook surfaces on read
        return []


def _read_file(
    path: str,
    skip_rows: int = 0,
    skip_cols: int = 0,
    data_range: str = "",
    has_header: bool = True,
    sheet: str = "",
) -> pd.DataFrame:
    """
    Parse the stored upload.

    Controls, in precedence order:
      data_range  Excel notation ('B3:H500', 'A:C', '2:5') - when given it
                  defines the header row, the column block and the row limit.
      skip_rows   rows to drop above the header (only if no range given)
      skip_cols   columns to drop from the left of whatever was read
      has_header  when False the first row is data and columns are auto-named
      sheet       which worksheet to read (.xlsx / .xlsb); '' = first sheet
    """
    skip_rows = max(0, int(skip_rows or 0))
    skip_cols = max(0, int(skip_cols or 0))
    has_header = True if has_header is None else bool(has_header)

    spec = None
    if (data_range or "").strip():
        spec = _parse_range(data_range, skip_rows)
        # A range that names rows states its own header position.
        if spec["row_bounded"]:
            skip_rows = spec["header_row"]
    nrows = spec["nrows"] if spec else None

    # Without a header row the range's first row is data, not the header.
    if not has_header and spec is not None and spec["row_bounded"]:
        nrows = None if nrows is None else nrows + 1

    ext = os.path.splitext(path)[1].lower()

    if ext in EXCEL_ENGINES:
        with pd.ExcelFile(path, engine=EXCEL_ENGINES[ext]) as book:
            names = [str(n) for n in book.sheet_names]
            if not names:
                raise ValueError("The workbook has no worksheets.")
            target = sheet if sheet in names else names[0]
            df = book.parse(
                target,
                skiprows=skip_rows,
                nrows=nrows,
                header=0 if has_header else None,
            )
    elif ext == ".csv":
        try:
            df = pd.read_csv(
                path,
                skiprows=skip_rows,
                nrows=nrows,
                header=0 if has_header else None,
                low_memory=False,
            )
            # A lone column usually means the delimiter was guessed wrong
            # rather than a genuinely single-column file, so retry the sniffer.
            if df.shape[1] > 1:
                pass
            else:
                df = _read_csv_tolerant(path, skip_rows, nrows, has_header)
        except (pd.errors.ParserError, pd.errors.EmptyDataError, UnicodeError):
            df = _read_csv_tolerant(path, skip_rows, nrows, has_header)
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    # Column block from an explicit range, otherwise "drop the first N".
    # Applied after the read because pandas' integer `usecols` semantics
    # relative to `skiprows` are ambiguous - iloc is unambiguous.
    if spec is not None:
        end_col = (
            len(df.columns)
            if spec["end_col"] is None
            else min(spec["end_col"] + 1, len(df.columns))
        )
        df = df.iloc[:, spec["start_col"]:end_col]
    if skip_cols:
        df = df.iloc[:, skip_cols:]

    if not has_header:
        # Auto-name the columns and make sure the frame is rectangular.
        df = df.reset_index(drop=True)
        df.columns = [f"Column {i + 1}" for i in range(df.shape[1])]

    return _normalize_columns(df)


DEFAULT_OPTIONS = {
    # -- structure ---------------------------------------------------------
    "skip_rows": 0,
    "skip_cols": 0,
    "skip_last_rows": 0,
    "skip_last_cols": 0,
    "data_range": "",
    "sheet": "",
    "has_header": True,
    "promote_first_row": False,
    "transpose": False,
    # -- rows --------------------------------------------------------------
    "drop_empty_rows": True,
    "drop_rows_with_null": False,
    "dedupe": True,
    "dedupe_keep": "first",
    "sort_by": "",
    "sort_desc": False,
    # -- columns -----------------------------------------------------------
    "drop_empty_cols": True,
    "drop_constant_cols": False,
    "drop_duplicate_cols": False,
    "max_missing_pct": 0.0,
    "drop_cols": "",
    "normalize_col_names": False,
    # -- values ------------------------------------------------------------
    "strip_whitespace": True,
    "text_case": "none",
    "coerce_numbers": False,
    "fill_missing": "none",
    "round_decimals": -1,
    "replace_find": "",
    "replace_with": "",
}


def _is_text_series(series: pd.Series) -> bool:
    return (
        series.dtype == object
        or isinstance(series.dtype, pd.StringDtype)
        or pd.api.types.is_string_dtype(series.dtype)
    )


def _text_columns(df: pd.DataFrame) -> list:
    return [c for c in df.columns if _is_text_series(df[c])]


def _numeric_columns(df: pd.DataFrame) -> list:
    return [
        c
        for c in df.columns
        if pd.api.types.is_numeric_dtype(df[c])
        and not pd.api.types.is_bool_dtype(df[c])
    ]


# Tokens that mean "nothing" in a financial table. They are set aside before a
# column is tested, so a mostly-numeric column with a few nil markers still
# converts instead of staying text.
_NUMERIC_PLACEHOLDERS = {
    "", "-", "--", "---", "\u2013", "\u2014", "\u2212",
    "n/a", "na", "nil", "none", "nan",
}

# How much of a column must parse before it is treated as numeric. Real
# financial statements interleave section headings ("Balance sheet date") with
# the figures, so a strict cut-off leaves obviously numeric columns as text.
# Anything that does not parse becomes a null rather than being mangled.
_NUMERIC_COERCE_THRESHOLD = 0.8


def _case_variant_examples(series: pd.Series, folded: pd.Series) -> str:
    """
    Name up to two real collisions so the warning shows what it means.

    'CANADA' and 'Canada' teach the reader far more than "6 value(s)" does.
    """
    pairs = []
    for key, group in series.groupby(folded):
        variants = list(dict.fromkeys(str(v) for v in group.dropna()))
        if len(variants) > 1:
            pairs.append(" vs ".join(repr(v) for v in variants[:2]))
        if len(pairs) == 2:
            break
    return "; ".join(pairs)


def _coerce_numeric_text(series: pd.Series) -> pd.Series:
    """
    Turn text-encoded numbers into real numbers.

    Handles currency symbols, thousands separators, surrounding spaces,
    accounting negatives ("(1,234.50)"), percent signs and the nil markers
    financial tables use ("-", "n/a", "nil"). A column is only converted when
    at least `_NUMERIC_COERCE_THRESHOLD` of its non-placeholder values parse,
    so free text is never mangled; everything else becomes null.
    """
    if not _is_text_series(series):
        return series

    text = series.astype(str).str.strip()
    is_placeholder = text.str.lower().isin(_NUMERIC_PLACEHOLDERS)
    candidates = text[~is_placeholder & series.notna()]
    if not len(candidates):
        return series

    looks_numeric = candidates.str.match(
        r"^\s*[$£€¥]?\s*-?\(?[\d,.\s]+\)?\s*%?$", na=False
    )
    if float(looks_numeric.mean()) < _NUMERIC_COERCE_THRESHOLD:
        return series

    cleaned = (
        text.str.replace(r"[$£€¥\s]", "", regex=True)
        # Thousands separators: a comma sitting between digits and followed by
        # exactly three more. `pd.to_numeric` cannot parse "1,234", so leaving
        # them in made every comma-formatted column silently stay text. A comma
        # followed by fewer digits is left alone, so a decimal comma survives.
        .str.replace(r"(?<=\d),(?=\d{3}(?:\D|$))", "", regex=True)
        .str.replace(r"^\((.*)\)$", r"-\1", regex=True)
        .str.replace(r"%", "", regex=True)
    )
    converted = pd.to_numeric(cleaned, errors="coerce")
    # A nil marker is a missing value, not the text "-".
    converted[is_placeholder] = np.nan

    parsed = converted[~is_placeholder & series.notna()].notna().sum()
    if float(parsed) < len(candidates) * _NUMERIC_COERCE_THRESHOLD:
        return series
    return converted


def _snake_name(name: str) -> str:
    """'Gross Sales ($)' -> 'gross_sales'."""
    text = str(name).strip().lower()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s\-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text or "column"


def _apply_options(df: pd.DataFrame, options: dict) -> pd.DataFrame:
    """
    Apply the user-facing restructuring/cleaning toggles to a parsed frame.

    Order is deliberate: structure first, then columns, then values, then rows,
    then sorting - so each stage sees a frame the user would recognise.
    """
    opts = {**DEFAULT_OPTIONS, **(options or {})}
    if df is None or df.shape[1] == 0:
        return df

    # ---------------------------------------------------------- structure
    if opts.get("transpose"):
        df = df.T.reset_index(drop=True)
        df.columns = [f"Column {i + 1}" for i in range(df.shape[1])]

    last_rows = max(0, int(opts.get("skip_last_rows") or 0))
    if last_rows:
        df = df.iloc[: max(0, len(df) - last_rows)]

    last_cols = max(0, int(opts.get("skip_last_cols") or 0))
    if last_cols:
        df = df.iloc[:, : max(0, df.shape[1] - last_cols)]

    if opts.get("promote_first_row") and len(df):
        df.columns = [str(v) for v in df.iloc[0]]
        df = df.iloc[1:]
        df = _normalize_columns(df.reset_index(drop=True))

    if df.shape[1] == 0:
        return df

    # ------------------------------------------------------------ columns
    drop_cols = [
        c.strip()
        for c in re.split(r"[,\n;]", str(opts.get("drop_cols") or ""))
        if c.strip()
    ]
    if drop_cols:
        wanted = {c.lower() for c in drop_cols}
        wanted_norm = {_snake_name(c) for c in drop_cols}
        keep = [
            c
            for c in df.columns
            if str(c).strip().lower() not in wanted
            and _snake_name(c) not in wanted_norm
        ]
        df = df[keep]

    if opts.get("drop_empty_cols"):
        df = df.dropna(axis=1, how="all")

    threshold = float(opts.get("max_missing_pct") or 0)
    if threshold > 0 and df.shape[1]:
        missing_pct = df.isna().mean() * 100.0
        df = df.loc[:, missing_pct <= threshold]

    if opts.get("drop_constant_cols") and df.shape[1]:
        keep = [c for c in df.columns if df[c].nunique(dropna=True) > 1]
        df = df[keep]

    if opts.get("drop_duplicate_cols") and df.shape[1] > 1:
        keep, seen = [], set()
        for c in df.columns:
            key = tuple(df[c].astype(str).fillna("\0").tolist())
            if key in seen:
                continue
            seen.add(key)
            keep.append(c)
        df = df[keep]

    if df.shape[1] == 0:
        return df

    # ------------------------------------------------------------- values
    if opts.get("strip_whitespace"):
        for col in _text_columns(df):
            s = df[col]
            mask = s.map(lambda v: isinstance(v, str))
            if mask.any():
                df.loc[mask, col] = s[mask].str.strip()

    if opts.get("coerce_numbers"):
        for col in _text_columns(df):
            df[col] = _coerce_numeric_text(df[col])

    case = str(opts.get("text_case") or "none").lower()
    if case in {"lower", "upper", "title"}:
        for col in _text_columns(df):
            s = df[col]
            mask = s.map(lambda v: isinstance(v, str))
            if not mask.any():
                continue
            text = s[mask]
            if case == "lower":
                df.loc[mask, col] = text.str.lower()
            elif case == "upper":
                df.loc[mask, col] = text.str.upper()
            else:
                df.loc[mask, col] = text.str.title()

    find = str(opts.get("replace_find") or "")
    if find:
        replace_with = str(opts.get("replace_with") or "")
        for col in _text_columns(df):
            s = df[col]
            mask = s.map(lambda v: isinstance(v, str) and find in v)
            if mask.any():
                df.loc[mask, col] = s[mask].str.replace(
                    find, replace_with, regex=False
                )

    decimals = int(opts.get("round_decimals", -1))
    if decimals >= 0:
        for col in _numeric_columns(df):
            df[col] = df[col].round(decimals)

    fill = str(opts.get("fill_missing") or "none").lower()
    if fill != "none":
        if fill == "zero":
            for col in _numeric_columns(df):
                df[col] = df[col].fillna(0)
        elif fill == "unknown":
            for col in _text_columns(df):
                df[col] = df[col].fillna("Unknown")
        elif fill in {"ffill", "bfill"}:
            df = df.ffill() if fill == "ffill" else df.bfill()
        elif fill in {"mean", "median"}:
            for col in _numeric_columns(df):
                value = (
                    df[col].mean() if fill == "mean" else df[col].median()
                )
                if pd.notna(value):
                    df[col] = df[col].fillna(value)
        elif fill == "mode":
            for col in df.columns:
                modes = df[col].mode(dropna=True)
                if len(modes):
                    df[col] = df[col].fillna(modes.iloc[0])

    # --------------------------------------------------------------- rows
    if opts.get("drop_empty_rows"):
        df = df.dropna(how="all")

    if opts.get("drop_rows_with_null"):
        df = df.dropna(how="any")

    if opts.get("dedupe") and len(df):
        keep = "last" if str(opts.get("dedupe_keep")) == "last" else "first"
        df = df.drop_duplicates(keep=keep)

    # ------------------------------------------------------------- naming
    if opts.get("normalize_col_names") and df.shape[1]:
        taken: set = set()
        df.columns = [_unique_name(_snake_name(c), taken) for c in df.columns]

    # ------------------------------------------------------------- sorting
    sort_by = str(opts.get("sort_by") or "").strip()
    if sort_by and df.shape[1]:
        match = next(
            (c for c in df.columns if str(c).strip().lower() == sort_by.lower()),
            None,
        )
        if match is not None and len(df):
            df = df.sort_values(
                by=match,
                ascending=not bool(opts.get("sort_desc")),
                kind="stable",
                na_position="last",
            )

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


# Excel's own vocabulary, so the profile reads naturally to spreadsheet users.
_EXCEL_KINDS = {
    "number": "Number",
    "string": "Text",
    "category": "Text",
    "datetime": "Date",
    "timedelta": "Time",
    "boolean": "Boolean",
}


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
                examples = _case_variant_examples(as_str, folded)
                anomalies.append(
                    f"{raw_unique - folded_unique} value(s) differ only by "
                    f"case or spacing and become separate groups"
                    + (f" (e.g. {examples})" if examples else "")
                    + " — fix with Values → Text case"
                )

    if re.match(r"^Unnamed:\s*\d+$", str(name)):
        anomalies.append(
            "Auto-generated header (header row may be misaligned)"
        )

    return {
        "name": str(name),
        "dtype": str(series.dtype),
        "kind": kind,
        # What Excel would call this column, for people who think in Excel.
        "excel": _EXCEL_KINDS.get(kind, "Text"),
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

    by_kind: dict = {}
    for f in fields:
        by_kind[f["kind"]] = by_kind.get(f["kind"], 0) + 1

    # Constant (single-value) columns and columns carrying outlier flags.
    constant_cols = 0
    outlier_cols = 0
    complete_cols = 0
    for f in fields:
        if f.get("unique") == 1:
            constant_cols += 1
        if any("outlier" in a for a in f.get("anomalies", [])):
            outlier_cols += 1
        if not f.get("missing"):
            complete_cols += 1

    # Span of the first real date column, when the frame has one.
    date_min = date_max = None
    for f in fields:
        if f["kind"] != "datetime":
            continue
        series = df[f["name"]]
        try:
            lo, hi = series.min(), series.max()
        except (TypeError, ValueError):
            continue
        if pd.notna(lo) and pd.notna(hi):
            date_min = pd.Timestamp(lo).isoformat()
            date_max = pd.Timestamp(hi).isoformat()
            break

    try:
        memory_bytes = int(df.memory_usage(deep=True).sum())
    except (TypeError, ValueError):
        memory_bytes = 0

    path = SESSION_DATA.get("path")
    try:
        file_bytes = os.path.getsize(path) if path else 0
    except OSError:
        file_bytes = 0

    # Shape of the file itself, not of the frame being displayed. Fixed at
    # upload time so restructuring never moves it.
    source_shape = SESSION_DATA.get("source_shape") or [n_rows, n_cols]

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
        # -- extended summary (the dashboard shows these when present) ------
        "cells": int(total_cells),
        "complete_cols": complete_cols,
        "constant_cols": constant_cols,
        "outlier_cols": outlier_cols,
        "numeric_cols": by_kind.get("number", 0),
        "text_cols": by_kind.get("string", 0) + by_kind.get("category", 0),
        "date_cols": by_kind.get("datetime", 0) + by_kind.get("timedelta", 0),
        "bool_cols": by_kind.get("boolean", 0),
        "date_min": date_min,
        "date_max": date_max,
        "memory_bytes": memory_bytes,
        "file_bytes": file_bytes,
        "source_rows": int(source_shape[0]),
        "source_cols": int(source_shape[1]),
    }


def _df_preview(
    df: pd.DataFrame, n: int = PREVIEW_ROWS, max_cols: int = PREVIEW_COLS
) -> dict:
    """
    First N rows as JSON-safe records for the preview table.

    Wide frames (a transposed sheet can carry hundreds of columns) are trimmed
    for display only - the full frame still feeds the dashboard - because
    building tens of thousands of DOM cells makes the page feel stuck.
    """
    total_cols = int(df.shape[1])
    head = df.head(n)
    if total_cols > max_cols:
        head = head.iloc[:, :max_cols]

    records = json.loads(
        head.to_json(orient="records", date_format="iso", date_unit="ms")
    )
    fields = [
        {"name": str(col), "kind": _column_kind(df[col])}
        for col in head.columns
    ]
    return {
        "fields": fields,
        "records": records,
        "shown": len(records),
        "total": int(len(df)),
        "cols_shown": int(head.shape[1]),
        "cols_total": total_cols,
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


_INT_OPTIONS = ("skip_rows", "skip_cols", "skip_last_rows", "skip_last_cols")
_BOOL_OPTIONS = (
    "has_header",
    "promote_first_row",
    "transpose",
    "strip_whitespace",
    "drop_empty_rows",
    "drop_rows_with_null",
    "drop_empty_cols",
    "drop_constant_cols",
    "drop_duplicate_cols",
    "dedupe",
    "sort_desc",
    "coerce_numbers",
    "normalize_col_names",
)
_TEXT_OPTIONS = (
    "data_range",
    "sheet",
    "drop_cols",
    "sort_by",
    "text_case",
    "fill_missing",
    "dedupe_keep",
    "replace_find",
    "replace_with",
)


def _recapture_source_shape_if_sheet_changed(options: dict) -> None:
    """
    Recapture the source shape when the worksheet changes.

    `source_shape` is the worksheet's own dimensions, independent of any
    restructuring, so it is read back with the structural options cleared.
    Merely clearing it would let the next rebuild capture whatever `skip_rows`
    and `data_range` happen to be set to.
    """
    if options.get("sheet") == (SESSION_DATA.get("options") or {}).get("sheet"):
        return
    try:
        fresh = _read_file(
            SESSION_DATA["path"],
            skip_rows=0,
            skip_cols=0,
            data_range="",
            has_header=True,
            sheet=options.get("sheet", ""),
        )
        SESSION_DATA["source_shape"] = [int(len(fresh)), int(fresh.shape[1])]
    except Exception:  # noqa: BLE001 - a bad sheet is reported by _rebuild
        SESSION_DATA["source_shape"] = None


def _merge_options(payload: dict | None) -> dict:
    """Coerce a JSON payload from the browser into a validated option dict."""
    opts = dict(DEFAULT_OPTIONS)
    payload = payload or {}

    for key in _INT_OPTIONS:
        try:
            opts[key] = max(0, int(payload.get(key, 0) or 0))
        except (TypeError, ValueError):
            opts[key] = 0

    for key in _BOOL_OPTIONS:
        if key in payload:
            opts[key] = bool(payload[key])

    for key in _TEXT_OPTIONS:
        if key in payload:
            opts[key] = str(payload.get(key) or "").strip()

    try:
        opts["round_decimals"] = int(payload.get("round_decimals", -1))
    except (TypeError, ValueError):
        opts["round_decimals"] = -1
    if opts["round_decimals"] < -1 or opts["round_decimals"] > 12:
        opts["round_decimals"] = -1

    try:
        opts["max_missing_pct"] = float(payload.get("max_missing_pct", 0) or 0)
    except (TypeError, ValueError):
        opts["max_missing_pct"] = 0.0
    opts["max_missing_pct"] = min(100.0, max(0.0, opts["max_missing_pct"]))

    if opts["dedupe_keep"] not in {"first", "last"}:
        opts["dedupe_keep"] = "first"
    if opts["text_case"] not in {"none", "lower", "upper", "title"}:
        opts["text_case"] = "none"
    if opts["fill_missing"] not in {
        "none",
        "zero",
        "unknown",
        "ffill",
        "bfill",
        "mean",
        "median",
        "mode",
    }:
        opts["fill_missing"] = "none"

    return opts


def _rebuild(options: dict) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """Re-read the upload and return (raw, cleaned, profile)."""
    raw = _read_file(
        SESSION_DATA["path"],
        skip_rows=options["skip_rows"],
        skip_cols=options.get("skip_cols", 0),
        data_range=options.get("data_range", ""),
        has_header=options.get("has_header", True),
        sheet=options.get("sheet", ""),
    )
    # The upload handler clears this before its first _rebuild(), which runs
    # with every structural option at its default - so the first read really is
    # the file's own shape. Later rebuilds leave it alone.
    if SESSION_DATA.get("source_shape") is None:
        SESSION_DATA["source_shape"] = [int(len(raw)), int(raw.shape[1])]

    cleaned = _apply_options(raw.copy(), options)
    cleaned = _infer_excel_serial_dates(cleaned)
    cleaned = _infer_datetimes(cleaned)
    profile = _build_profile(
        cleaned,
        SESSION_DATA.get("display_name") or SESSION_DATA.get("filename"),
    )
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
        return _err("Only .csv, .xlsx and .xlsb files are supported.")

    display_name = os.path.basename(file.filename)
    filename = secure_filename(file.filename) or f"upload{ext}"
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = os.path.join(
        UPLOAD_DIR, f"{int(time.time() * 1000)}_{filename}"
    )
    file.save(path)

    options = dict(DEFAULT_OPTIONS)
    sheets = _list_sheets(path)
    if sheets:
        options["sheet"] = sheets[0]
    # The file's own dimensions, captured before any restructuring. These stay
    # fixed for the life of the upload, so the header can report the source
    # while the preview reports the transformed frame.
    SESSION_DATA["source_shape"] = None
    # _rebuild() reads from SESSION_DATA["path"], so register the new file
    # first; a parse failure clears it again below.
    SESSION_DATA.update(
        {
            "path": path,
            "filename": filename,
            "display_name": display_name,
            "sheets": sheets,
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
                "display_name": None,
                "raw_df": None,
                "df": None,
                "processed_df": None,
                "profile": None,
                "sheets": [],
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
            "sheets": SESSION_DATA.get("sheets") or [],
        }
    )


@app.route("/api/session")
def api_session():
    """
    Describe the upload currently held in memory.

    The import page calls this on load, so coming back from the dashboard (or
    simply reloading) restores the file that is already open instead of
    presenting an empty drop zone.
    """
    profile = SESSION_DATA.get("profile")
    frame = SESSION_DATA.get("df")
    if not SESSION_DATA.get("path") or profile is None or frame is None:
        return jsonify({"success": True, "loaded": False})

    return jsonify(
        {
            "success": True,
            "loaded": True,
            "filename": (
                SESSION_DATA.get("display_name") or SESSION_DATA.get("filename")
            ),
            "profile": profile,
            "preview": _df_preview(frame),
            "options": SESSION_DATA.get("options") or dict(DEFAULT_OPTIONS),
            "sheets": SESSION_DATA.get("sheets") or [],
            "processed": SESSION_DATA.get("processed_df") is not None,
        }
    )


@app.route("/api/reset", methods=["POST"])
def api_reset():
    """Forget the uploaded file (used by the import page's Clear button)."""
    SESSION_DATA.update(
        {
            "path": None,
            "filename": None,
            "display_name": None,
            "raw_df": None,
            "df": None,
            "processed_df": None,
            "options": {},
            "profile": None,
            "sheets": [],
        }
    )
    return jsonify({"success": True})


@app.route("/preview", methods=["POST"])
def preview():
    """
    Apply restructuring options (skip first N rows, strip whitespace, drop
    empty rows/columns, dedupe) and return a refreshed profile + preview.
    """
    if not SESSION_DATA.get("path"):
        return _err("No upload in session. Please upload a file.", 404)

    options = _merge_options(request.get_json(silent=True))
    # The source-file facts are captured on the first read and never move, so
    # they must be recaptured when the worksheet changes — otherwise the header
    # keeps reporting the previous sheet's dimensions.
    _recapture_source_shape_if_sheet_changed(options)
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
            "sheets": SESSION_DATA.get("sheets") or [],
        }
    )


@app.route("/process", methods=["POST"])
def process():
    """Finalize cleaning, store the processed dataframe, then send the client
    to the dashboard."""
    if not SESSION_DATA.get("path"):
        return _err("No upload in session. Please upload a file.", 404)

    options = _merge_options(request.get_json(silent=True))
    _recapture_source_shape_if_sheet_changed(options)
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


def _read_export_frame():
    """Decode the Arrow view the browser posted, or return (None, error)."""
    raw = request.get_data()
    if not raw:
        return None, _err("Nothing to export.", 400)
    try:
        with pa.ipc.open_stream(pa.BufferReader(raw)) as reader:
            table = reader.read_all()
    except Exception as exc:  # noqa: BLE001 - surface the parser message
        return None, _err(f"Could not read the exported view: {exc}", 400)
    if table.num_rows == 0 or table.num_columns == 0:
        return None, _err("The current view has no rows to export.", 422)
    try:
        return table.to_pandas(), None
    except Exception as exc:  # noqa: BLE001
        return None, _err(f"Could not convert the view to a table: {exc}", 500)


@app.route("/api/export/csv", methods=["POST"])
def api_export_csv():
    """Same view as /api/export/xlsx, written as CSV (fast at any size)."""
    frame, error = _read_export_frame()
    if error is not None:
        return error

    buffer = io.StringIO()
    frame.to_csv(buffer, index=False)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="view-{stamp}.csv"',
            "Cache-Control": "no-store",
        },
    )


@app.route("/api/export/xlsx", methods=["POST"])
def api_export_xlsx():
    """
    Convert whatever the dashboard is currently showing into an .xlsx file.

    The browser posts the *view* (already pivoted/aggregated by Perspective)
    as an Arrow IPC stream, so the workbook matches the grid on screen rather
    than the raw upload.
    """
    frame, error = _read_export_frame()
    if error is not None:
        return error

    # Excel's own hard limit; anything larger cannot be represented.
    if len(frame) > 1048575:
        return _err(
            "That view has more than 1,048,575 rows, which Excel cannot hold. "
            "Filter or group the view, or download it as CSV.",
            422,
        )

    # openpyxl writes roughly 50k cells a second, so a very large view would
    # leave the browser waiting minutes. The dashboard switches to CSV above
    # this size; the guard keeps the endpoint honest if called directly.
    if len(frame) * max(1, frame.shape[1]) > EXCEL_CELL_BUDGET:
        return _err(
            "That view is too large for a fast Excel export. Download it as "
            "CSV instead, or group/filter the view first.",
            422,
        )

    buffer = io.BytesIO()
    try:
        # openpyxl's write-only mode streams rows straight to the file instead
        # of building a cell object graph - the difference is minutes versus
        # seconds on a large view. Styling has to use WriteOnlyCell, because a
        # plain Cell is not accepted on that path.
        book = Workbook(write_only=True)
        sheet = book.create_sheet("View")
        sheet.freeze_panes = "A2"

        theme = _excel_theme(request.args.get("primary"))
        _write_themed_sheet(sheet, frame, theme)
        book.save(buffer)
    except Exception as exc:  # noqa: BLE001
        return _err(f"Could not build the workbook: {exc}", 500)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    filename = f"view-{stamp}.xlsx"
    return Response(
        buffer.getvalue(),
        mimetype=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@app.route("/api/kpis")
def api_kpis():
    """Return the column profile (dtypes, missing values, anomalies) for the
    dashboard's KPI side panel."""
    profile = SESSION_DATA.get("profile")
    if profile is None:
        return _err("No dataset loaded. Upload a file first.", 404)
    return jsonify({"success": True, "profile": profile})


@app.route("/api/values")
def api_values():
    """
    Distinct values of one column, for the dashboard's filter pickers.

    Excel offers a checkbox list of the values present in a field; this is the
    same idea. Results are capped so a high-cardinality column (an id, a date)
    cannot flood the picker, and the caller is told when it was truncated so it
    can fall back to typing a value.
    """
    frame = SESSION_DATA.get("processed_df")
    if frame is None:
        frame = SESSION_DATA.get("df")
    if frame is None:
        return _err("No dataset loaded. Upload a file first.", 404)

    column = (request.args.get("column") or "").strip()
    if not column:
        return _err("Which column?")
    if column not in frame.columns:
        return _err(f"Unknown column: {column}", 404)

    try:
        limit = max(1, min(2000, int(request.args.get("limit", 500) or 500)))
    except (TypeError, ValueError):
        limit = 500

    series = frame[column]
    # Nulls are offered as their own choice, the way Excel shows "(Blanks)".
    values = series.dropna().unique().tolist()
    has_blanks = bool(series.isna().any())

    def sort_key(value):
        # Numbers first in numeric order, everything else as text.
        return (0, value, "") if isinstance(value, (int, float)) else (1, 0, str(value))

    try:
        values.sort(key=sort_key)
    except TypeError:
        values = sorted(values, key=lambda v: str(v))

    truncated = len(values) > limit
    shown = values[:limit]

    def jsonable(value):
        if isinstance(value, (int, float, str, bool)) or value is None:
            return value
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return str(value)

    return jsonify({
        "success": True,
        "column": column,
        "values": [jsonable(v) for v in shown],
        "truncated": truncated,
        "has_blanks": has_blanks,
        "total": len(values),
    })


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
