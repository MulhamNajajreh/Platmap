"""Zero-dependency parser for microplate reader & qPCR exports (.xlsx, .csv, .tsv, .txt)."""

from __future__ import annotations

import csv
import io
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from .models import WELL_RE, normalize_well_id, row_label_to_index, split_well

OVERFLOW_TOKENS = {"OVER", "OVRFLW", "OVERFLOW", "SAT", "SATURATED", "++++", "*****", "INF", "#NUM!"}
UNDETERMINED_TOKENS = {"UNDETERMINED", "NO CT", "NO CQ", "N/A", "NA", "NAN", "-", "--", "BLANK", ""}

WELL_HEADER_NAMES = {
    "well",
    "well position",
    "well id",
    "well_id",
    "wellpos",
    "position",
    "pos",
}

VALUE_HEADER_PRIORITY = (
    "cq",
    "ct",
    "cp",
    "raw data",
    "value",
    "signal",
    "luminescence",
    "rlu",
    "rfu",
    "absorbance",
    "od",
    "od600",
    "od450",
    "fluorescence",
    "mean",
    "measurement",
    "counts",
    "read 1",
)


@dataclass
class WellMeasurement:
    well: str
    value: Optional[float]
    status: str = "OK"  # "OK" | "OVERFLOW" | "UNDETERMINED"
    extra: Optional[Dict[str, str]] = None


@dataclass
class ReadBlock:
    block_id: str
    source_sheet: str
    format_detected: str  # "matrix" | "table"
    measurements: Dict[str, WellMeasurement]


def _parse_numeric_token(raw: str) -> Tuple[Optional[float], str]:
    s = (raw or "").strip()
    if not s:
        return None, "UNDETERMINED"
    up = s.upper()
    if up in OVERFLOW_TOKENS or up.startswith("OVR"):
        return None, "OVERFLOW"
    if up in UNDETERMINED_TOKENS or "UNDETERMINED" in up:
        return None, "UNDETERMINED"
    cleaned = s.replace(" ", "")
    if "," in cleaned and "." not in cleaned and re.match(r"^[-+]?\d+,\d+$", cleaned):
        cleaned = cleaned.replace(",", ".")
    else:
        cleaned = cleaned.replace(",", "")
    try:
        return float(cleaned), "OK"
    except ValueError:
        return None, "UNDETERMINED"


def _xlsx_col_to_index(cell_ref: str) -> Tuple[int, int]:
    """Convert Excel cell ref like 'BC14' -> (row_0based=13, col_0based=54)."""
    m = re.match(r"^([A-Za-z]+)(\d+)$", cell_ref)
    if not m:
        return 0, 0
    col_s, row_s = m.group(1).upper(), m.group(2)
    return int(row_s) - 1, row_label_to_index(col_s)


def read_xlsx_sheets(path: Path) -> List[Tuple[str, List[List[str]]]]:
    """Read all worksheets from an .xlsx file using only Python stdlib."""
    sheets_out: List[Tuple[str, List[List[str]]]] = []
    with zipfile.ZipFile(path, "r") as zf:
        names = set(zf.namelist())
        shared_strings: List[str] = []
        if "xl/sharedStrings.xml" in names:
            ss_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in ss_root.iter():
                if si.tag.endswith("}si") or si.tag == "si":
                    parts = [
                        (t.text or "")
                        for t in si.iter()
                        if t.tag.endswith("}t") or t.tag == "t"
                    ]
                    shared_strings.append("".join(parts))

        sheet_targets: List[Tuple[str, str]] = []
        if "xl/workbook.xml" in names and "xl/_rels/workbook.xml.rels" in names:
            rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
            rid_to_target: Dict[str, str] = {}
            for rel in rels_root.iter():
                if rel.tag.endswith("}Relationship") or rel.tag == "Relationship":
                    rid = rel.attrib.get("Id", "")
                    tgt = rel.attrib.get("Target", "").lstrip("/")
                    if not tgt.startswith("xl/"):
                        tgt = f"xl/{tgt}"
                    rid_to_target[rid] = tgt

            wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
            for sh in wb_root.iter():
                if sh.tag.endswith("}sheet") or sh.tag == "sheet":
                    sname = sh.attrib.get("name", "Sheet")
                    rid = next(
                        (v for k, v in sh.attrib.items() if k.endswith("}id") or k == "r:id"),
                        "",
                    )
                    tgt = rid_to_target.get(rid, "")
                    if tgt in names:
                        sheet_targets.append((sname, tgt))

        if not sheet_targets:
            ws_files = sorted(n for n in names if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
            sheet_targets = [(Path(w).stem, w) for w in ws_files]

        for sname, target in sheet_targets:
            ws_root = ET.fromstring(zf.read(target))
            cells: Dict[Tuple[int, int], str] = {}
            max_r, max_c = -1, -1
            for row_el in ws_root.iter():
                if not (row_el.tag.endswith("}row") or row_el.tag == "row"):
                    continue
                r_fallback = int(row_el.attrib.get("r", "1")) - 1
                c_cursor = 0
                for c_el in row_el:
                    if not (c_el.tag.endswith("}c") or c_el.tag == "c"):
                        continue
                    ref = c_el.attrib.get("r", "")
                    if ref:
                        r_idx, c_idx = _xlsx_col_to_index(ref)
                        c_cursor = c_idx + 1
                    else:
                        r_idx, c_idx = r_fallback, c_cursor
                        c_cursor += 1

                    ctype = c_el.attrib.get("t", "")
                    val_str = ""
                    if ctype == "inlineStr":
                        val_str = "".join(
                            (t.text or "")
                            for t in c_el.iter()
                            if t.tag.endswith("}t") or t.tag == "t"
                        )
                    else:
                        v_el = next(
                            (ch for ch in c_el if ch.tag.endswith("}v") or ch.tag == "v"),
                            None,
                        )
                        if v_el is not None and v_el.text is not None:
                            raw_v = v_el.text
                            if ctype == "s":
                                idx = int(raw_v)
                                val_str = shared_strings[idx] if 0 <= idx < len(shared_strings) else raw_v
                            else:
                                val_str = raw_v
                    if val_str != "":
                        cells[(r_idx, c_idx)] = val_str
                        max_r = max(max_r, r_idx)
                        max_c = max(max_c, c_idx)

            grid = [[cells.get((r, c), "") for c in range(max_c + 1)] for r in range(max_r + 1)]
            sheets_out.append((sname, grid))

    return sheets_out


def read_delimited_grid(text: str) -> List[List[str]]:
    """Parse CSV, TSV, or semicolon-delimited text into a 2D string grid."""
    lines = [ln for ln in text.splitlines() if ln.strip() != "" or "\t" in ln or "," in ln]
    if not lines:
        return []
    sample = lines[:40]
    tab_hits = sum(ln.count("\t") for ln in sample)
    comma_hits = sum(ln.count(",") for ln in sample)
    semi_hits = sum(ln.count(";") for ln in sample)
    if tab_hits >= comma_hits and tab_hits >= semi_hits and tab_hits > 0:
        delim = "\t"
    elif semi_hits > comma_hits and semi_hits > 0:
        delim = ";"
    else:
        delim = ","
    return [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text), delimiter=delim)]


def _detect_col_header(row: Sequence[str]) -> Optional[Tuple[int, List[int]]]:
    """Detect consecutive integer column headers (1..12, 01..24, or partial scans like 2..11)."""
    for start_idx in range(min(4, len(row))):
        tok = row[start_idx].strip()
        if not re.match(r"^0*[1-9]\d?$", tok):
            continue
        first_col = int(tok)
        if first_col < 1 or first_col > 48:
            continue
        cols: List[int] = [first_col]
        expected = first_col + 1
        for j in range(start_idx + 1, len(row)):
            cell = row[j].strip()
            if expected <= 48 and re.match(rf"^0*{expected}$", cell):
                cols.append(expected)
                expected += 1
            else:
                break
        if len(cols) >= 3:
            return start_idx, cols
    return None


def _is_valid_row_label(token: str) -> Optional[int]:
    clean = token.strip().upper()
    if not clean or len(clean) > 2 or not clean.isalpha():
        return None
    idx = row_label_to_index(clean)
    return idx if 0 <= idx < 32 else None


def _dedup_block_ids(blocks: List[ReadBlock]) -> List[ReadBlock]:
    counts: Dict[str, int] = {}
    for b in blocks:
        counts[b.block_id] = counts.get(b.block_id, 0) + 1
    seen: Dict[str, int] = {}
    for b in blocks:
        if counts[b.block_id] > 1:
            seen[b.block_id] = seen.get(b.block_id, 0) + 1
            b.block_id = f"{b.block_id} ({seen[b.block_id]})"
    return blocks


def _extract_matrix_blocks(sheet_name: str, grid: List[List[str]]) -> List[ReadBlock]:
    blocks: List[ReadBlock] = []
    n_lines = len(grid)
    r = 0

    while r < n_lines:
        col_hdr = _detect_col_header(grid[r])
        if col_hdr is None:
            r += 1
            continue

        start_col_idx, col_nums = col_hdr
        if start_col_idx == 0:
            if r + 1 < n_lines and grid[r + 1] and _is_valid_row_label(grid[r + 1][0]) is not None:
                data_col_offset = 1
            else:
                r += 1
                continue
        else:
            data_col_offset = start_col_idx

        label_col_idx = data_col_offset - 1

        block_title = ""
        for back in range(r - 1, max(-1, r - 5), -1):
            non_empty = [c.strip() for c in grid[back] if c.strip()]
            if len(non_empty) == 1 and not _detect_col_header(grid[back]):
                cand = non_empty[0].rstrip(":")
                if cand and len(cand) <= 80:
                    block_title = cand
                    break
            elif len(non_empty) == 2 and non_empty[0].lower() in ("read", "wavelength", "measurement", "name", "block"):
                block_title = f"{non_empty[0]}: {non_empty[1]}"
                break

        measurements: Dict[str, WellMeasurement] = {}
        matched_rows = 0
        last_row_idx = -1
        scan_r = r + 1

        while scan_r < n_lines:
            line = grid[scan_r]
            if not any(c.strip() for c in line):
                if matched_rows >= 2:
                    break
                scan_r += 1
                continue

            if len(line) <= label_col_idx:
                break

            raw_lbl = line[label_col_idx].strip().upper()
            row_idx = _is_valid_row_label(raw_lbl)
            if row_idx is None or row_idx <= last_row_idx:
                break
            # Prevent matching arbitrary prose tables far apart
            if last_row_idx >= 0 and (row_idx - last_row_idx) > 2:
                break

            last_row_idx = row_idx
            for offset, col_1 in enumerate(col_nums):
                c_pos = data_col_offset + offset
                raw_cell = line[c_pos] if c_pos < len(line) else ""
                val, status = _parse_numeric_token(raw_cell)
                wid = f"{raw_lbl}{col_1}"
                if val is not None or status == "OVERFLOW" or raw_cell.strip() != "":
                    measurements[wid] = WellMeasurement(well=wid, value=val, status=status)

            matched_rows += 1
            scan_r += 1

        if matched_rows >= 2 and measurements:
            blocks.append(
                ReadBlock(
                    block_id=block_title or sheet_name,
                    source_sheet=sheet_name,
                    format_detected="matrix",
                    measurements=measurements,
                )
            )
            r = scan_r
        else:
            r += 1

    return _dedup_block_ids(blocks)


def _extract_table_blocks(sheet_name: str, grid: List[List[str]]) -> List[ReadBlock]:
    """Extract long-format well tables (QuantStudio, Bio-Rad CFX, BMG/Tecan tabular exports)."""
    for r_idx, row in enumerate(grid):
        lowered = [re.sub(r"\s+", " ", c.strip().lower()) for c in row]
        cand_well_cols = [idx for idx, h in enumerate(lowered) if h in WELL_HEADER_NAMES]
        if not cand_well_cols:
            continue

        well_col: Optional[int] = None
        for idx in sorted(cand_well_cols, key=lambda i: 0 if lowered[i] == "well position" else 1):
            matches = sum(
                1
                for peek in grid[r_idx + 1 : r_idx + 10]
                if idx < len(peek) and WELL_RE.match(peek[idx].strip())
            )
            if matches >= 1:
                well_col = idx
                break
        if well_col is None:
            continue

        target_col: Optional[int] = None
        sample_col: Optional[int] = None
        for idx, h in enumerate(lowered):
            if idx == well_col:
                continue
            if h in ("target", "target name", "detector", "gene", "fluor") and target_col is None:
                target_col = idx
            elif h in ("sample", "sample name", "sample id") and sample_col is None:
                sample_col = idx

        val_cols: List[Tuple[int, str]] = []
        for prio in VALUE_HEADER_PRIORITY:
            for idx, h in enumerate(lowered):
                if idx == well_col:
                    continue
                if h == prio or h.startswith(prio + " ") or h.startswith(prio + "("):
                    if all(idx != existing[0] for existing in val_cols):
                        val_cols.append((idx, row[idx].strip() or prio))

        if not val_cols:
            for idx, h in enumerate(lowered):
                if idx in (well_col, target_col, sample_col) or not h:
                    continue
                if h in ("row", "col", "column", "well", "content", "type", "task"):
                    continue
                numeric_hits = 0
                for peek in grid[r_idx + 1 : r_idx + 8]:
                    if idx < len(peek):
                        v, st = _parse_numeric_token(peek[idx])
                        if v is not None or st == "OVERFLOW":
                            numeric_hits += 1
                if numeric_hits >= 2:
                    val_cols.append((idx, row[idx].strip()))

        if not val_cols:
            continue

        primary_col, primary_name = val_cols[0]
        measurements: Dict[str, WellMeasurement] = {}
        valid_wells = 0
        for data_row in grid[r_idx + 1 :]:
            if well_col >= len(data_row):
                continue
            raw_well = data_row[well_col].strip()
            if not WELL_RE.match(raw_well):
                continue
            wid = normalize_well_id(raw_well)
            _, c1, r0, _ = split_well(wid)
            if r0 >= 32 or c1 > 48:
                continue
            raw_val = data_row[primary_col] if primary_col < len(data_row) else ""
            val, status = _parse_numeric_token(raw_val)
            extra: Dict[str, str] = {}
            if target_col is not None and target_col < len(data_row) and data_row[target_col].strip():
                extra["instrument_target"] = data_row[target_col].strip()
            if sample_col is not None and sample_col < len(data_row) and data_row[sample_col].strip():
                extra["instrument_sample"] = data_row[sample_col].strip()
            measurements[wid] = WellMeasurement(
                well=wid,
                value=val,
                status=status,
                extra=extra or None,
            )
            valid_wells += 1

        if valid_wells >= 2:
            return [
                ReadBlock(
                    block_id=f"{sheet_name} ({primary_name})",
                    source_sheet=sheet_name,
                    format_detected="table",
                    measurements=measurements,
                )
            ]

    return []


def parse_reader_file(path: Path) -> List[ReadBlock]:
    """Parse any .xlsx, .csv, .tsv, or .txt plate-reader / qPCR file into ReadBlocks."""
    suffix = path.suffix.lower()
    if suffix == ".xlsx":
        sheets = read_xlsx_sheets(path)
    else:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
        sheets = [(path.stem, read_delimited_grid(text))]

    all_blocks: List[ReadBlock] = []
    for sname, grid in sheets:
        m_blocks = _extract_matrix_blocks(sname, grid)
        if m_blocks:
            all_blocks.extend(m_blocks)
        else:
            all_blocks.extend(_extract_table_blocks(sname, grid))

    if not all_blocks:
        raise ValueError(
            f"Could not detect a microplate matrix (e.g. A-H x 1-12) or Well table in {path.name}."
        )
    return _dedup_block_ids(all_blocks)
