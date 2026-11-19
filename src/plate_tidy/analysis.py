"""Assay normalization, Zhang Z'-factor QC, 4PL Hill curve fitting, qPCR ddCt, and tidy exports."""

from __future__ import annotations

import csv
import io
import math
import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set, Tuple

from .models import PlateLayout, iter_plate_wells, split_well
from .parser import ReadBlock


@dataclass
class TidyRow:
    plate_id: str
    block_id: str
    well: str
    row: str
    col: int
    role: str
    sample: str
    treatment: str
    concentration: Optional[float]
    unit: str
    bio_rep: str
    tech_rep: int
    raw_value: Optional[float]
    status: str
    bg_subtracted: Optional[float] = None
    pct_control: Optional[float] = None
    delta_ct: Optional[float] = None
    dd_ct: Optional[float] = None
    fold_change: Optional[float] = None


@dataclass
class AssayQC:
    block_id: str
    blank_mean: float
    blank_sd: float
    blank_n: int
    neg_ctrl_mean: float
    neg_ctrl_sd: float
    neg_ctrl_cv_pct: Optional[float]
    neg_ctrl_n: int
    pos_ctrl_mean: Optional[float]
    pos_ctrl_sd: Optional[float]
    pos_ctrl_n: int
    signal_to_background: Optional[float]
    z_prime: Optional[float]
    z_prime_rating: str
    notes: List[str] = field(default_factory=list)


@dataclass
class DoseResponseCurve:
    series_label: str
    sample: str
    treatment: str
    unit: str
    bottom: float
    top: float
    ic50: float  # Relative IC50 / EC50 (inflection point)
    abs_ic50: Optional[float]  # Exact concentration crossing y = 50%
    hill_slope: float
    r_squared: float
    doses: List[float]
    mean_responses: List[float]
    sd_responses: List[float]
    n_replicates: List[int]


@dataclass
class BlockAnalysis:
    block_id: str
    rows: List[TidyRow]
    qc: AssayQC
    curves: List[DoseResponseCurve]


def _mean_sd(vals: Sequence[float]) -> Tuple[float, float]:
    if not vals:
        return 0.0, 0.0
    m = statistics.fmean(vals)
    sd = statistics.stdev(vals) if len(vals) >= 2 else 0.0
    return m, sd


def eval_4pl(x: float, bottom: float, top: float, log_ic50: float, hill: float) -> float:
    """Evaluate 4-parameter logistic Hill equation at concentration x > 0."""
    if x <= 0:
        return top if hill > 0 else bottom
    log_x = math.log10(x)
    exponent = max(-60.0, min(60.0, hill * (log_x - log_ic50)))
    return bottom + (top - bottom) / (1.0 + math.pow(10.0, exponent))


def fit_4pl_curve(
    series_label: str,
    sample: str,
    treatment: str,
    unit: str,
    dose_points: Dict[float, List[float]],
) -> Optional[DoseResponseCurve]:
    """Fit a 4-parameter logistic Hill curve via deterministic grid + Nelder-Mead simplex."""
    positive_doses = sorted(d for d in dose_points if d > 0 and dose_points[d])
    if len(positive_doses) < 4:
        return None

    xs: List[float] = []
    ys: List[float] = []
    doses_summary: List[float] = []
    means_summary: List[float] = []
    sds_summary: List[float] = []
    ns_summary: List[int] = []

    for d in positive_doses:
        pts = dose_points[d]
        xs.extend([d] * len(pts))
        ys.extend(pts)
        m, sd = _mean_sd(pts)
        doses_summary.append(d)
        means_summary.append(m)
        sds_summary.append(sd)
        ns_summary.append(len(pts))

    y_min, y_max = min(means_summary), max(means_summary)
    if abs(y_max - y_min) < 1e-6:
        return None

    log_min = math.log10(positive_doses[0])
    log_max = math.log10(positive_doses[-1])
    direction = 1.0 if means_summary[0] >= means_summary[-1] else -1.0
    span = max(abs(y_max - y_min), 20.0)
    mid_log = 0.5 * (log_min + log_max)

    def sse(params: Sequence[float]) -> float:
        b, t, lic, h = params[0], params[1], params[2], params[3]
        penalty = 0.0
        if b < y_min - 0.5 * span or b > y_max + 0.2 * span:
            penalty += 1e6 * ((b - y_min) ** 2)
        if t > y_max + 0.5 * span or t < y_min - 0.2 * span:
            penalty += 1e6 * ((t - y_max) ** 2)
        if abs(h) < 0.2 or abs(h) > 6.0:
            penalty += 1e5 * ((abs(h) - 3.0) ** 2)
        if lic < log_min - 2.0 or lic > log_max + 2.0:
            penalty += 1e5 * ((lic - mid_log) ** 2)

        err = 0.0
        for x_val, y_val in zip(xs, ys):
            diff = y_val - eval_4pl(x_val, b, t, lic, h)
            err += diff * diff
        return err + penalty

    best_p: List[float] = [max(0.0, y_min), max(100.0, y_max), mid_log, direction]
    best_loss = sse(best_p)
    for frac in (0.15, 0.32, 0.50, 0.68, 0.85):
        lic_cand = log_min + frac * (log_max - log_min)
        for h_mag in (0.6, 1.0, 1.5, 2.5):
            for sgn in (direction, -direction):
                cand = [y_min, y_max, lic_cand, h_mag * sgn]
                loss = sse(cand)
                if loss < best_loss:
                    best_loss = loss
                    best_p = cand

    step_y = max(2.0, 0.08 * abs(y_max - y_min))
    steps = (step_y, step_y, 0.25, 0.25)
    # Cache (loss, vertex) pairs so each simplex iteration evaluates sse only on candidate moves
    scored_simplex: List[Tuple[float, List[float]]] = [(best_loss, list(best_p))]
    for j in range(4):
        pt = list(best_p)
        pt[j] += steps[j]
        scored_simplex.append((sse(pt), pt))

    for _ in range(260):
        scored_simplex.sort(key=lambda item: item[0])
        f_best, best_v = scored_simplex[0]
        f_second = scored_simplex[-2][0]
        f_worst, worst_v = scored_simplex[-1]
        if abs(f_worst - f_best) < 1e-7:
            break

        centroid = [sum(scored_simplex[i][1][j] for i in range(4)) / 4.0 for j in range(4)]
        reflected = [centroid[j] + (centroid[j] - worst_v[j]) for j in range(4)]
        f_ref = sse(reflected)

        if f_best <= f_ref < f_second:
            scored_simplex[-1] = (f_ref, reflected)
        elif f_ref < f_best:
            expanded = [centroid[j] + 2.0 * (reflected[j] - centroid[j]) for j in range(4)]
            f_exp = sse(expanded)
            scored_simplex[-1] = (f_exp, expanded) if f_exp < f_ref else (f_ref, reflected)
        else:
            contracted = [centroid[j] + 0.5 * (worst_v[j] - centroid[j]) for j in range(4)]
            f_con = sse(contracted)
            if f_con < f_worst:
                scored_simplex[-1] = (f_con, contracted)
            else:
                for i in range(1, 5):
                    shrunk = [best_v[j] + 0.5 * (scored_simplex[i][1][j] - best_v[j]) for j in range(4)]
                    scored_simplex[i] = (sse(shrunk), shrunk)

    scored_simplex.sort(key=lambda item: item[0])
    bottom, top, log_ic50, hill = scored_simplex[0][1]
    if bottom > top:
        bottom, top = top, bottom
        hill = -hill

    ic50 = math.pow(10.0, log_ic50)
    y_bar = statistics.fmean(ys)
    ss_tot = sum((y - y_bar) ** 2 for y in ys)
    ss_res = sum((y - eval_4pl(x, bottom, top, log_ic50, hill)) ** 2 for x, y in zip(xs, ys))
    r2 = max(0.0, 1.0 - (ss_res / ss_tot)) if ss_tot > 0 else 0.0

    abs_ic50: Optional[float] = None
    if bottom < 50.0 < top and abs(hill) > 1e-4:
        ratio = (top - 50.0) / (50.0 - bottom)
        if ratio > 0:
            abs_ic50 = math.pow(10.0, log_ic50 + math.log10(ratio) / hill)

    return DoseResponseCurve(
        series_label=series_label,
        sample=sample,
        treatment=treatment,
        unit=unit,
        bottom=round(bottom, 2),
        top=round(top, 2),
        ic50=ic50,
        abs_ic50=abs_ic50,
        hill_slope=round(hill, 3),
        r_squared=round(r2, 4),
        doses=doses_summary,
        mean_responses=[round(m, 2) for m in means_summary],
        sd_responses=[round(s, 2) for s in sds_summary],
        n_replicates=ns_summary,
    )


def analyze_block(layout: PlateLayout, block: ReadBlock) -> BlockAnalysis:
    """Merge plate layout metadata with reader measurements and compute QC & curves."""
    tech_idx_map = layout.tech_replicate_indices()

    blank_vals: List[float] = []
    neg_vals_all: List[float] = []
    neg_vals_by_sample: Dict[str, List[float]] = {}
    zero_dose_by_sample: Dict[str, List[float]] = {}
    zero_dose_all: List[float] = []
    pos_vals_all: List[float] = []

    for wid in iter_plate_wells(layout.plate_format):
        w = layout.get_well(wid)
        meas = block.measurements.get(wid)
        if meas is None or meas.value is None:
            continue
        if w.role == "blank":
            blank_vals.append(meas.value)
        elif w.role == "neg_ctrl":
            neg_vals_all.append(meas.value)
            if w.sample:
                neg_vals_by_sample.setdefault(w.sample, []).append(meas.value)
        elif w.role == "pos_ctrl":
            pos_vals_all.append(meas.value)
        elif w.role == "sample" and w.concentration is not None and w.concentration == 0:
            zero_dose_all.append(meas.value)
            if w.sample:
                zero_dose_by_sample.setdefault(w.sample, []).append(meas.value)

    qc_notes: List[str] = []
    # Graceful fallback if user marked 0-dose vehicle wells as 'sample' rather than 'neg_ctrl'
    if not neg_vals_all and zero_dose_all:
        neg_vals_all = zero_dose_all
        neg_vals_by_sample = zero_dose_by_sample
        qc_notes.append("Used 0-concentration sample wells as the 100% vehicle baseline.")

    blank_mean, blank_sd = _mean_sd(blank_vals)
    neg_mean, neg_sd = _mean_sd(neg_vals_all)
    pos_mean, pos_sd = _mean_sd(pos_vals_all)

    neg_cv = (100.0 * neg_sd / abs(neg_mean)) if (len(neg_vals_all) >= 2 and abs(neg_mean) > 1e-9) else None

    low_ref_vals = pos_vals_all if len(pos_vals_all) >= 2 else blank_vals
    z_prime: Optional[float] = None
    z_rating = "N/A (need >=2 high & low control wells)"
    sb_ratio: Optional[float] = None

    if blank_vals and abs(blank_mean) > 1e-9 and neg_vals_all:
        sb_ratio = round(neg_mean / blank_mean, 2)
    elif pos_vals_all and abs(pos_mean) > 1e-9 and neg_vals_all:
        sb_ratio = round(neg_mean / pos_mean, 2)

    if len(neg_vals_all) >= 2 and len(low_ref_vals) >= 2:
        low_m, low_sd = _mean_sd(low_ref_vals)
        denom = abs(neg_mean - low_m)
        if denom > 1e-9:
            z_prime = round(1.0 - (3.0 * (neg_sd + low_sd) / denom), 3)
            if z_prime >= 0.5:
                z_rating = "Excellent (Z' >= 0.5)"
            elif z_prime >= 0.0:
                z_rating = "Marginal (0 <= Z' < 0.5)"
            else:
                z_rating = "Poor (Z' < 0; overlapping controls)"

    if neg_cv is not None and neg_cv > 15.0:
        qc_notes.append(f"High negative-control variability (CV = {neg_cv:.1f}% > 15%); check pipetting or edge evaporation.")
    if z_prime is not None and z_prime < 0.5:
        qc_notes.append(f"Narrow assay window (Z' = {z_prime:.2f}); verify positive/blank dynamic range.")

    qc = AssayQC(
        block_id=block.block_id,
        blank_mean=round(blank_mean, 4),
        blank_sd=round(blank_sd, 4),
        blank_n=len(blank_vals),
        neg_ctrl_mean=round(neg_mean, 4),
        neg_ctrl_sd=round(neg_sd, 4),
        neg_ctrl_cv_pct=round(neg_cv, 2) if neg_cv is not None else None,
        neg_ctrl_n=len(neg_vals_all),
        pos_ctrl_mean=round(pos_mean, 4) if pos_vals_all else None,
        pos_ctrl_sd=round(pos_sd, 4) if pos_vals_all else None,
        pos_ctrl_n=len(pos_vals_all),
        signal_to_background=sb_ratio,
        z_prime=z_prime,
        z_prime_rating=z_rating,
        notes=qc_notes,
    )

    global_neg_net = (neg_mean - blank_mean) if neg_vals_all else None
    sample_neg_net: Dict[str, float] = {
        smp: _mean_sd(vals)[0] - blank_mean for smp, vals in neg_vals_by_sample.items()
    }

    rows: List[TidyRow] = []
    for wid in iter_plate_wells(layout.plate_format):
        w = layout.get_well(wid)
        meas = block.measurements.get(wid)
        if w.role == "empty" and (meas is None or meas.value is None):
            continue

        rlbl, c1, _, _ = split_well(wid)
        raw_v = meas.value if meas is not None else None
        status = meas.status if meas is not None else "MISSING"

        eff_sample = w.sample
        eff_treat = w.treatment
        if meas and meas.extra:
            if not eff_sample and meas.extra.get("instrument_sample"):
                eff_sample = meas.extra["instrument_sample"]
            if not eff_treat and meas.extra.get("instrument_target"):
                eff_treat = meas.extra["instrument_target"]

        bg_sub: Optional[float] = None
        pct_ctrl: Optional[float] = None
        if raw_v is not None and layout.assay_type != "qpcr":
            bg_sub = round(raw_v - blank_mean, 4)
            ref_net = sample_neg_net.get(eff_sample, global_neg_net)
            if ref_net is not None and abs(ref_net) > 1e-9:
                pct_ctrl = round(100.0 * (bg_sub / ref_net), 2)

        rows.append(
            TidyRow(
                plate_id=layout.plate_id,
                block_id=block.block_id,
                well=wid,
                row=rlbl,
                col=c1,
                role=w.role,
                sample=eff_sample,
                treatment=eff_treat,
                concentration=w.concentration,
                unit=w.unit,
                bio_rep=w.bio_rep,
                tech_rep=tech_idx_map.get(wid, 0),
                raw_value=raw_v,
                status=status,
                bg_subtracted=bg_sub,
                pct_control=pct_ctrl,
            )
        )

    if layout.assay_type == "qpcr":
        _apply_qpcr_ddct(layout, rows)

    curves: List[DoseResponseCurve] = []
    if layout.assay_type != "qpcr":
        grouped: Dict[Tuple[str, str, str], Dict[float, List[float]]] = {}
        for r in rows:
            if r.role not in ("sample", "standard") or r.concentration is None or r.concentration <= 0:
                continue
            y_metric = r.pct_control if r.pct_control is not None else r.bg_subtracted
            if y_metric is None:
                continue
            key = (r.sample, r.treatment, r.unit or "uM")
            grouped.setdefault(key, {}).setdefault(r.concentration, []).append(y_metric)

        for (smp, trt, unt), dose_pts in sorted(grouped.items()):
            label = f"{smp} + {trt}" if smp and trt else (trt or smp or "Series")
            curve = fit_4pl_curve(label, smp, trt, unt, dose_pts)
            if curve is not None:
                curves.append(curve)

    return BlockAnalysis(block_id=block.block_id, rows=rows, qc=qc, curves=curves)


def _apply_qpcr_ddct(layout: PlateLayout, rows: List[TidyRow]) -> None:
    """Compute dCt, ddCt, and 2^(-ddCt) fold change in-place on TidyRows."""
    hk = layout.housekeeping_target.strip().upper()
    if not hk:
        present = {r.treatment.upper(): r.treatment for r in rows if r.treatment}
        for cand in ("GAPDH", "ACTB", "RPLP0", "B2M", "HPRT1", "18S"):
            if cand in present:
                hk = cand
                break
    if not hk:
        return

    hk_cq_by_sample_rep: Dict[Tuple[str, str], List[float]] = {}
    hk_cq_by_sample: Dict[str, List[float]] = {}
    for r in rows:
        if r.raw_value is None or r.role in ("blank", "moat", "empty"):
            continue
        if r.treatment.strip().upper() == hk:
            hk_cq_by_sample_rep.setdefault((r.sample, r.bio_rep), []).append(r.raw_value)
            hk_cq_by_sample.setdefault(r.sample, []).append(r.raw_value)

    for r in rows:
        if r.raw_value is None or r.role in ("blank", "moat", "empty"):
            continue
        hk_list = hk_cq_by_sample_rep.get((r.sample, r.bio_rep)) or hk_cq_by_sample.get(r.sample)
        if hk_list:
            r.delta_ct = round(r.raw_value - statistics.fmean(hk_list), 4)

    targets = sorted({r.treatment for r in rows if r.delta_ct is not None and r.treatment.upper() != hk})
    for tgt in targets:
        tgt_rows = [r for r in rows if r.treatment == tgt and r.delta_ct is not None]
        ref_rows = [r for r in tgt_rows if r.role == "neg_ctrl"]
        if not ref_rows:
            ref_rows = [
                r
                for r in tgt_rows
                if any(tok in r.sample.upper() for tok in ("WT", "CTRL", "CONTROL", "DMSO", "VEH", "UNTREATED"))
            ]
        if not ref_rows and tgt_rows:
            first_smp = sorted({r.sample for r in tgt_rows})[0]
            ref_rows = [r for r in tgt_rows if r.sample == first_smp]

        if not ref_rows:
            continue
        calibrator_dct = statistics.fmean(r.delta_ct for r in ref_rows if r.delta_ct is not None)
        for r in tgt_rows:
            assert r.delta_ct is not None
            ddct = r.delta_ct - calibrator_dct
            r.dd_ct = round(ddct, 4)
            r.fold_change = round(math.pow(2.0, -ddct), 4)


TIDY_COLUMNS = [
    "plate_id",
    "block_id",
    "well",
    "row",
    "col",
    "role",
    "sample",
    "treatment",
    "concentration",
    "unit",
    "bio_rep",
    "tech_rep",
    "raw_value",
    "status",
    "bg_subtracted",
    "pct_control",
    "delta_ct",
    "dd_ct",
    "fold_change",
]


def format_tidy_csv(analyses: Sequence[BlockAnalysis]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(TIDY_COLUMNS)
    for analysis in analyses:
        for r in analysis.rows:
            writer.writerow(
                [
                    r.plate_id,
                    r.block_id,
                    r.well,
                    r.row,
                    r.col,
                    r.role,
                    r.sample,
                    r.treatment,
                    "" if r.concentration is None else f"{r.concentration:g}",
                    r.unit,
                    r.bio_rep,
                    r.tech_rep if r.tech_rep > 0 else "",
                    "" if r.raw_value is None else r.raw_value,
                    r.status,
                    "" if r.bg_subtracted is None else r.bg_subtracted,
                    "" if r.pct_control is None else r.pct_control,
                    "" if r.delta_ct is None else r.delta_ct,
                    "" if r.dd_ct is None else r.dd_ct,
                    "" if r.fold_change is None else r.fold_change,
                ]
            )
    return buf.getvalue()


def write_tidy_csv(analyses: Sequence[BlockAnalysis], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(format_tidy_csv(analyses), encoding="utf-8")


def format_prism_xy_tsv(analysis: BlockAnalysis) -> str:
    """Format GraphPad Prism-ready XY side-by-side replicate table (or grouped categorical table)."""
    series_map: Dict[str, Dict[float, List[float]]] = {}
    max_reps_per_series: Dict[str, int] = {}
    all_doses: Set[float] = set()

    for r in analysis.rows:
        if r.role not in ("sample", "standard") or r.concentration is None:
            continue
        val = r.pct_control if r.pct_control is not None else (r.bg_subtracted if r.bg_subtracted is not None else r.raw_value)
        if val is None:
            continue
        lbl = f"{r.sample} + {r.treatment}".strip(" +") or "Group"
        series_map.setdefault(lbl, {}).setdefault(r.concentration, []).append(val)
        all_doses.add(r.concentration)

    if not series_map:
        cat_map: Dict[str, List[float]] = {}
        for r in analysis.rows:
            if not (r.sample or r.treatment):
                continue
            val = r.fold_change if r.fold_change is not None else (r.pct_control if r.pct_control is not None else r.raw_value)
            if val is None:
                continue
            lbl = f"{r.sample} | {r.treatment}".strip(" |")
            cat_map.setdefault(lbl, []).append(val)
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter="\t", lineterminator="\n")
        max_n = max((len(v) for v in cat_map.values()), default=1)
        writer.writerow(["Condition"] + [f"Rep_{i + 1}" for i in range(max_n)])
        for cond, vals in sorted(cat_map.items()):
            writer.writerow([cond] + vals + [""] * (max_n - len(vals)))
        return buf.getvalue()

    series_names = sorted(series_map.keys())
    for sname in series_names:
        max_reps_per_series[sname] = max(len(v) for v in series_map[sname].values())

    header = ["Concentration", "Log10_Conc"]
    for sname in series_names:
        for rep_i in range(max_reps_per_series[sname]):
            header.append(f"{sname}_Rep{rep_i + 1}")

    buf = io.StringIO()
    writer = csv.writer(buf, delimiter="\t", lineterminator="\n")
    writer.writerow(header)
    for d in sorted(all_doses):
        log_d = f"{math.log10(d):.4f}" if d > 0 else ""
        row_out: List[object] = [f"{d:g}", log_d]
        for sname in series_names:
            vals = series_map[sname].get(d, [])
            n_cols = max_reps_per_series[sname]
            row_out.extend(vals + [""] * (n_cols - len(vals)))
        writer.writerow(row_out)
    return buf.getvalue()
