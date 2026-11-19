"""Microplate geometries, well metadata models, layout IO, and spatial layout checks."""

from __future__ import annotations

import csv
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

PLATE_GEOMETRIES: Dict[int, Tuple[int, int]] = {
    6: (2, 3),
    12: (3, 4),
    24: (4, 6),
    48: (6, 8),
    96: (8, 12),
    384: (16, 24),
}

VALID_ROLES = (
    "sample",
    "neg_ctrl",
    "pos_ctrl",
    "blank",
    "standard",
    "moat",
    "empty",
)

WELL_RE = re.compile(r"^\s*([A-Za-z]{1,2})\s*0*([1-9][0-9]*)\s*$")


def row_index_to_label(idx: int) -> str:
    """Convert 0-based row index (0 -> A, 15 -> P, 26 -> AA)."""
    if idx < 0:
        raise ValueError(f"Negative row index: {idx}")
    label = ""
    n = idx
    while True:
        n, rem = divmod(n, 26)
        label = chr(ord("A") + rem) + label
        if n == 0:
            break
        n -= 1
    return label


def row_label_to_index(label: str) -> int:
    """Convert row label (A -> 0, P -> 15) to 0-based index."""
    clean = label.strip().upper()
    if not clean or not clean.isalpha():
        raise ValueError(f"Invalid row label: {label!r}")
    idx = 0
    for ch in clean:
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx - 1


def normalize_well_id(well: str) -> str:
    """Normalize 'A01', 'a1', ' B 12 ' -> 'A1', 'B12'."""
    m = WELL_RE.match(well or "")
    if not m:
        raise ValueError(f"Invalid well coordinate: {well!r}")
    return f"{m.group(1).upper()}{int(m.group(2))}"


def split_well(well: str) -> Tuple[str, int, int, int]:
    """Return (row_label, col_1based, row_0based, col_0based)."""
    norm = normalize_well_id(well)
    m = WELL_RE.match(norm)
    assert m is not None
    row_lbl = m.group(1)
    col_1 = int(m.group(2))
    return row_lbl, col_1, row_label_to_index(row_lbl), col_1 - 1


def infer_plate_format(max_row: int, max_col: int, min_format: int = 96) -> int:
    """Infer smallest standard SBS plate format fitting (max_row, max_col)."""
    for fmt, (nr, nc) in sorted(PLATE_GEOMETRIES.items()):
        if fmt >= min_format and max_row <= nr and max_col <= nc:
            return fmt
    return 384


def iter_plate_wells(plate_format: int) -> Iterable[str]:
    """Yield canonical well IDs in row-major order (A1..H12)."""
    if plate_format not in PLATE_GEOMETRIES:
        raise ValueError(
            f"Unsupported plate format {plate_format}; choose from {sorted(PLATE_GEOMETRIES)}"
        )
    n_rows, n_cols = PLATE_GEOMETRIES[plate_format]
    for r in range(n_rows):
        rlbl = row_index_to_label(r)
        for c in range(1, n_cols + 1):
            yield f"{rlbl}{c}"


@dataclass
class WellAssignment:
    well: str
    role: str = "empty"
    sample: str = ""
    treatment: str = ""
    concentration: Optional[float] = None
    unit: str = ""
    bio_rep: str = ""
    notes: str = ""

    def __post_init__(self) -> None:
        self.well = normalize_well_id(self.well)
        self.role = (self.role or "empty").strip().lower()
        if self.role not in VALID_ROLES:
            raise ValueError(f"Invalid role {self.role!r} for well {self.well}")
        if self.concentration is not None and self.concentration != "":
            self.concentration = float(self.concentration)
        else:
            self.concentration = None

    @property
    def is_active_assay_well(self) -> bool:
        return self.role in ("sample", "neg_ctrl", "pos_ctrl", "blank", "standard")

    def condition_key(self) -> Tuple[str, str, str, Optional[float], str, str]:
        return (
            self.role,
            self.sample,
            self.treatment,
            self.concentration,
            self.unit,
            self.bio_rep,
        )


@dataclass
class LayoutWarning:
    code: str
    severity: str  # "warn" | "info"
    message: str


@dataclass
class PlateLayout:
    plate_id: str = "Plate_1"
    plate_format: int = 96
    assay_type: str = "viability"  # "viability" | "qpcr" | "elisa" | "generic"
    well_volume_ul: float = 100.0
    housekeeping_target: str = ""
    wells: Dict[str, WellAssignment] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.plate_format not in PLATE_GEOMETRIES:
            raise ValueError(f"Unsupported plate format: {self.plate_format}")
        normalized: Dict[str, WellAssignment] = {}
        for w in self.wells.values():
            if isinstance(w, dict):
                w = WellAssignment(**w)
            normalized[w.well] = w
        self.wells = normalized

    @property
    def dimensions(self) -> Tuple[int, int]:
        return PLATE_GEOMETRIES[self.plate_format]

    def get_well(self, well_id: str) -> WellAssignment:
        norm = normalize_well_id(well_id)
        return self.wells.get(norm, WellAssignment(well=norm, role="empty"))

    def tech_replicate_indices(self) -> Dict[str, int]:
        """Compute 1-based technical replicate index within identical condition_key."""
        counts: Dict[Tuple[str, str, str, Optional[float], str, str], int] = {}
        out: Dict[str, int] = {}
        for wid in iter_plate_wells(self.plate_format):
            w = self.get_well(wid)
            if not w.is_active_assay_well:
                out[wid] = 0
                continue
            key = w.condition_key()
            counts[key] = counts.get(key, 0) + 1
            out[wid] = counts[key]
        return out

    def audit(self) -> List[LayoutWarning]:
        """Check layout for perimeter evaporation exposure, missing controls, and singletons."""
        warnings: List[LayoutWarning] = []
        n_rows, n_cols = self.dimensions
        active = [w for w in self.wells.values() if w.is_active_assay_well]
        if not active:
            warnings.append(
                LayoutWarning("EMPTY_LAYOUT", "warn", "No active assay wells assigned.")
            )
            return warnings

        if self.plate_format in (96, 384):
            edge_active = [
                w.well
                for w in active
                if split_well(w.well)[2] in (0, n_rows - 1) or split_well(w.well)[3] in (0, n_cols - 1)
            ]
            if edge_active:
                pct = 100.0 * len(edge_active) / len(active)
                warnings.append(
                    LayoutWarning(
                        "EDGE_EFFECT_RISK",
                        "warn",
                        f"{len(edge_active)}/{len(active)} ({pct:.0f}%) active wells sit on the outer perimeter "
                        f"(e.g. {', '.join(edge_active[:4])}). Consider a sterile buffer moat for >=24 h incubations.",
                    )
                )

        roles_present = {w.role for w in active}
        has_zero_sample = any(w.role == "sample" and w.concentration == 0 for w in active)
        if self.assay_type in ("viability", "elisa") and "neg_ctrl" not in roles_present and not has_zero_sample:
            warnings.append(
                LayoutWarning(
                    "MISSING_NEG_CTRL",
                    "warn",
                    "No 'neg_ctrl' (vehicle 100% reference) wells defined for % Control normalization.",
                )
            )
        if self.assay_type in ("viability", "elisa") and "blank" not in roles_present:
            warnings.append(
                LayoutWarning(
                    "MISSING_BLANK",
                    "info",
                    "No 'blank' wells defined; background subtraction defaults to 0.",
                )
            )
        if self.assay_type == "qpcr" and not self.housekeeping_target:
            treatments = {w.treatment.upper() for w in active if w.treatment}
            if not treatments.intersection({"GAPDH", "ACTB", "B2M", "RPLP0", "HPRT1", "18S"}):
                warnings.append(
                    LayoutWarning(
                        "MISSING_HOUSEKEEPING",
                        "warn",
                        "No reference/housekeeping target designated for ddCt normalization.",
                    )
                )

        cond_counts: Dict[Tuple[str, str, str, Optional[float], str, str], List[str]] = {}
        for w in active:
            if w.role == "sample":
                cond_counts.setdefault(w.condition_key(), []).append(w.well)
        singletons = [wells[0] for wells in cond_counts.values() if len(wells) == 1]
        if singletons:
            warnings.append(
                LayoutWarning(
                    "SINGLETON_REPLICATES",
                    "info",
                    f"{len(singletons)} condition(s) have n=1 well (e.g. {', '.join(singletons[:4])}); n>=3 replicates recommended.",
                )
            )

        return warnings

    def to_dict(self) -> dict:
        ordered_wells = [
            asdict(self.wells[wid])
            for wid in iter_plate_wells(self.plate_format)
            if wid in self.wells and self.wells[wid].role != "empty"
        ]
        return {
            "schema": "plate-tidy/v1",
            "plate_id": self.plate_id,
            "plate_format": self.plate_format,
            "assay_type": self.assay_type,
            "well_volume_ul": self.well_volume_ul,
            "housekeeping_target": self.housekeeping_target,
            "wells": ordered_wells,
        }

    def save_json(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2) + "\n", encoding="utf-8")

    @classmethod
    def from_dict(cls, data: dict) -> "PlateLayout":
        raw_wells = data.get("wells", [])
        well_map: Dict[str, WellAssignment] = {}
        if isinstance(raw_wells, list):
            for item in raw_wells:
                w = WellAssignment(**item)
                well_map[w.well] = w
        elif isinstance(raw_wells, dict):
            for wid, item in raw_wells.items():
                payload = dict(item)
                payload.setdefault("well", wid)
                w = WellAssignment(**payload)
                well_map[w.well] = w
        return cls(
            plate_id=str(data.get("plate_id", "Plate_1")),
            plate_format=int(data.get("plate_format", 96)),
            assay_type=str(data.get("assay_type", "viability")),
            well_volume_ul=float(data.get("well_volume_ul", 100.0)),
            housekeeping_target=str(data.get("housekeeping_target", "")),
            wells=well_map,
        )

    @classmethod
    def load(cls, path: Path) -> "PlateLayout":
        """Load layout from .json or .csv."""
        if path.suffix.lower() == ".csv":
            return cls.load_csv(path)
        return cls.from_dict(json.loads(path.read_text(encoding="utf-8")))

    @classmethod
    def load_csv(cls, path: Path, min_format: int = 96) -> "PlateLayout":
        well_map: Dict[str, WellAssignment] = {}
        max_row, max_col = 0, 0
        with path.open("r", encoding="utf-8-sig", newline="") as fh:
            for raw_row in csv.DictReader(fh):
                row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw_row.items() if k}
                wid = row.get("well") or row.get("well_id") or row.get("well position") or ""
                if not wid:
                    continue
                conc_raw = row.get("concentration") or row.get("conc") or row.get("dose") or ""
                w = WellAssignment(
                    well=wid,
                    role=(row.get("role") or row.get("type") or "sample").lower(),
                    sample=row.get("sample") or row.get("cell_line") or row.get("cell line") or "",
                    treatment=row.get("treatment") or row.get("compound") or row.get("target") or "",
                    concentration=float(conc_raw) if conc_raw else None,
                    unit=row.get("unit") or row.get("units") or "",
                    bio_rep=row.get("bio_rep") or row.get("biorep") or row.get("replicate") or "",
                    notes=row.get("notes") or "",
                )
                _, c1, r0, _ = split_well(w.well)
                max_row = max(max_row, r0 + 1)
                max_col = max(max_col, c1)
                well_map[w.well] = w

        return cls(
            plate_id=path.stem,
            plate_format=infer_plate_format(max_row, max_col, min_format=min_format),
            wells=well_map,
        )
