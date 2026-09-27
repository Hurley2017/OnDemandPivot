"""
Inject a real, live Excel PivotTable into a saved workbook.

openpyxl has no PivotTable API, so the OOXML parts are written by hand and
patched into the zip after the fact:

    xl/pivotCache/pivotCacheDefinition1.xml   what data the pivot reads
    xl/pivotTables/pivotTable1.xml            the pivot's own definition
    plus the relationships and content-type overrides both need

The cache is deliberately minimal and marked refreshOnLoad, so Excel rebuilds
the records from the worksheet range the moment the file opens. That is far
safer than shipping a cache we computed ourselves: there is nothing stale to
disagree with, and much less XML to get wrong.
"""
import re
import shutil
import zipfile

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"

PIVOT_CACHE_TYPE = ("application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.pivotCacheDefinition+xml")
PIVOT_TABLE_TYPE = ("application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.pivotTable+xml")
PIVOT_CACHE_REL = ("http://schemas.openxmlformats.org/officeDocument/2006/"
                   "relationships/pivotCacheDefinition")
PIVOT_TABLE_REL = ("http://schemas.openxmlformats.org/officeDocument/2006/"
                   "relationships/pivotTable")


def _xml_escape(value) -> str:
    return (str(value)
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _sheet_part_name(workbook_xml: str, rels_xml: str, sheet_name: str):
    """
    Map a sheet name to its part, e.g. 'Pivot' -> 'xl/worksheets/sheet3.xml'.

    Attributes are read one by one rather than matched in a fixed order:
    openpyxl and Excel do not agree on how a `<sheet>` element is ordered, and
    a position-dependent regex silently fails on one of them.
    """
    for tag in re.findall(r"<sheet\b[^>]*/?>", workbook_xml):
        attrs = dict(re.findall(r'([\w:]+)="([^"]*)"', tag))
        if attrs.get("name") != sheet_name:
            continue
        rid = attrs.get("r:id") or attrs.get("id")
        if not rid:
            continue
        for rel in re.findall(r"<Relationship\b[^>]*/?>", rels_xml):
            rel_attrs = dict(re.findall(r'([\w:]+)="([^"]*)"', rel))
            if rel_attrs.get("Id") != rid:
                continue
            target = rel_attrs.get("Target", "").lstrip("/")
            if target.startswith("xl/"):
                return target
            return "xl/" + target
    return None


def add_pivot_table(path, sheet_name, data_sheet, ref, columns, config, theme):
    """
    Patch a saved .xlsx so it carries a live PivotTable on its own sheet.

    Returns True when the parts went in, False when anything about the file was
    not what we expected. A False is harmless — the workbook simply arrives
    without the pivot, exactly as it was before this existed.
    """
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            parts = {n: zf.read(n) for n in names}
    except Exception:  # noqa: BLE001
        return False

    try:
        workbook = parts["xl/workbook.xml"].decode("utf-8")
        wb_rels = parts["xl/_rels/workbook.xml.rels"].decode("utf-8")
        content_types = parts["[Content_Types].xml"].decode("utf-8")
    except KeyError:
        return False

    sheet_part = _sheet_part_name(workbook, wb_rels, sheet_name)
    if not sheet_part:
        return False

    cache, pivot = build_pivot_parts(data_sheet, ref, columns, config, theme)

    # The pivot table's own relationship points at the cache.
    pivot_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<Relationships xmlns="{NS_PKG_REL}">'
        f'<Relationship Id="rId1" Type="{PIVOT_CACHE_REL}" '
        f'Target="../pivotCache/pivotCacheDefinition1.xml"/>'
        f'</Relationships>'
    )

    # The sheet owns the pivot table.
    sheet_rels_name = "xl/worksheets/_rels/" + sheet_part.split("/")[-1] + ".rels"
    existing = parts.get(sheet_rels_name, b"").decode("utf-8")
    if existing:
        sheet_rels = re.sub(
            r"</Relationships>",
            f'<Relationship Id="rIdPivot" Type="{PIVOT_TABLE_REL}" '
            f'Target="../pivotTables/pivotTable1.xml"/></Relationships>',
            existing,
        )
    else:
        sheet_rels = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<Relationships xmlns="{NS_PKG_REL}">'
            f'<Relationship Id="rIdPivot" Type="{PIVOT_TABLE_REL}" '
            f'Target="../pivotTables/pivotTable1.xml"/>'
            f'</Relationships>'
        )

    # The workbook owns the cache; give it an rId that cannot clash.
    used = set(re.findall(r'Id="rId(\d+)"', wb_rels))
    next_id = max((int(u) for u in used), default=0) + 1
    wb_rels = re.sub(
        r"</Relationships>",
        f'<Relationship Id="rId{next_id}" Type="{PIVOT_CACHE_REL}" '
        f'Target="pivotCache/pivotCacheDefinition1.xml"/></Relationships>',
        wb_rels,
    )

    content_types = re.sub(
        r"</Types>",
        f'<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" '
        f'ContentType="{PIVOT_CACHE_TYPE}"/>'
        f'<Override PartName="/xl/pivotTables/pivotTable1.xml" '
        f'ContentType="{PIVOT_TABLE_TYPE}"/></Types>',
        content_types,
    )

    parts["xl/pivotCache/pivotCacheDefinition1.xml"] = cache.encode("utf-8")
    parts["xl/pivotTables/pivotTable1.xml"] = pivot.encode("utf-8")
    parts["xl/pivotTables/_rels/pivotTable1.xml.rels"] = pivot_rels.encode("utf-8")
    parts[sheet_rels_name] = sheet_rels.encode("utf-8")
    parts["xl/_rels/workbook.xml.rels"] = wb_rels.encode("utf-8")
    parts["[Content_Types].xml"] = content_types.encode("utf-8")

    tmp = str(path) + ".pivot"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
        for name in names:
            out.writestr(name, parts[name])
        for extra in ("xl/pivotCache/pivotCacheDefinition1.xml",
                      "xl/pivotTables/pivotTable1.xml",
                      "xl/pivotTables/_rels/pivotTable1.xml.rels"):
            out.writestr(extra, parts[extra])
    shutil.move(tmp, path)
    return True


def build_pivot_parts(sheet_name, ref, columns, config, theme):
    """
    The XML for the cache and the pivot, plus what the rels need.

    `config` is the dashboard's view config, so the pivot mirrors what the
    person actually built: their row fields, their column fields, their
    measures and aggregates.
    """
    group = [c for c in (config.get("group_by") or []) if c in columns]
    split = [c for c in (config.get("split_by") or []) if c in columns]
    measures = [c for c in (config.get("columns") or []) if c in columns]
    aggregates = config.get("aggregates") or {}

    # Excel's aggregation names differ from Perspective's.
    agg_map = {"sum": "sum", "avg": "average", "count": "count",
               "min": "min", "max": "max", "median": "median",
               "stddev": "stdDev", "var": "var", "count_distinct": "count"}

    index = {name: i for i, name in enumerate(columns)}

    fields_xml = []
    for name in columns:
        fields_xml.append(f'<cacheField name="{_xml_escape(name)}" numFmtId="0">'
                          f'<sharedItems count="0"/></cacheField>')

    cache = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<pivotCacheDefinition xmlns="{NS_MAIN}" xmlns:r="{NS_REL}" '
        f'r:id="rId1" refreshOnLoad="1" recordCount="0">'
        f'<cacheSource type="worksheet"><worksheetSource '
        f'ref="{_xml_escape(ref)}" sheet="{_xml_escape(sheet_name)}"/>'
        f'</cacheSource>'
        f'<cacheFields count="{len(columns)}">{"".join(fields_xml)}</cacheFields>'
        f'</pivotCacheDefinition>'
    )

    # One pivotField per source field, marking its role.
    pivot_fields = []
    for i, name in enumerate(columns):
        if name in group:
            pivot_fields.append(f'<pivotField axis="axisRow" showAll="0">'
                                f'<items count="0"/></pivotField>')
        elif name in split:
            pivot_fields.append(f'<pivotField axis="axisCol" showAll="0">'
                                f'<items count="0"/></pivotField>')
        elif name in measures:
            pivot_fields.append('<pivotField dataField="1" showAll="0"/>')
        else:
            pivot_fields.append('<pivotField showAll="0"/>')

    row_fields = "".join(f'<field x="{index[n]}"/>' for n in group)
    col_fields = "".join(f'<field x="{index[n]}"/>' for n in split)
    data_fields = "".join(
        f'<dataField name="{_xml_escape(n)}" fld="{index[n]}" '
        f'subtotal="{agg_map.get(aggregates.get(n, "sum"), "sum")}" baseField="0" '
        f'baseItem="0"/>'
        for n in measures
    )

    # A generous placeholder: Excel recalculates the real extent on refresh.
    rows_guess = max(4, len(group) + 3)
    cols_guess = max(3, len(split) + 1)
    last_col = chr(ord("A") + min(25, cols_guess))
    location = f"A3:{last_col}{rows_guess + 12}"

    pivot = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<pivotTableDefinition xmlns="{NS_MAIN}" name="CP View" '
        f'cacheId="1" applyNumberFormats="0" applyBorderFormats="0" '
        f'applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" '
        f'applyWidthHeightFormats="1" dataCaption="Values" '
        f'useAutoFormatting="1" itemPrintTitles="1" createdVersion="6" '
        f'minRefreshableVersion="3" indent="0" outline="1" outlineData="1" '
        f'multipleFieldFilters="1" compact="0" compactData="0" gridDropZones="1">'
        f'<location ref="{location}" firstHeaderRow="1" firstDataRow="1" '
        f'firstDataCol="1" rowPageCount="0" colPageCount="0"/>'
        f'<pivotFields count="{len(columns)}">{"".join(pivot_fields)}</pivotFields>'
        f'<rowFields count="{len(group)}">{row_fields}</rowFields>'
        f'<rowItems count="0"/>'
        + (f'<colFields count="{len(split)}">{col_fields}</colFields>'
           f'<colItems count="0"/>' if split else "")
        + f'<dataFields count="{len(measures)}">{data_fields}</dataFields>'
        f'<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" '
        f'showColHeaders="1" showRowStripes="0" showColStripes="0" '
        f'showLastColumn="0"/>'
        f'</pivotTableDefinition>'
    )
    return cache, pivot
