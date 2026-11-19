"""Bench-ready master-mix and serial-dilution calculators with pipetting guardrails."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .models import PlateLayout, split_well

UNIT_TO_MICROMOLAR: Dict[str, float] = {
    "M": 1e6,
    "MM": 1e3,
    "UM": 1.0,
    "NM": 1e-3,
    "PM": 1e-6,
}


def _norm_molar_unit(u: str) -> str:
    # Note: 'µ'.upper() and 'μ'.upper() become Greek Capital Mu 'Μ' (\u039c) in Unicode
    s = u.strip().replace("\u00b5", "u").replace("\u03bc", "u").replace("\u039c", "U")
    return s.upper()


def convert_conc(value: float, from_unit: str, to_unit: str) -> Optional[float]:
    """Convert molar units when compatible; return None if non-molar (e.g. ng/mL vs uM)."""
    fu = _norm_molar_unit(from_unit)
    tu = _norm_molar_unit(to_unit)
    if fu == tu:
        return value
    if fu in UNIT_TO_MICROMOLAR and tu in UNIT_TO_MICROMOLAR:
        in_um = value * UNIT_TO_MICROMOLAR[fu]
        return in_um / UNIT_TO_MICROMOLAR[tu]
    return None


@dataclass
class ReagentComponent:
    name: str
    per_well_ul: float


@dataclass
class MasterMixGroup:
    group_name: str
    well_count: int
    wells_preview: str
    overage_pct: float
    effective_wells: float
    total_volume_ul: float
    components: List[Tuple[str, float, float]]  # (name, per_well_ul, total_ul)


@dataclass
class DilutionStep:
    step_index: int
    label: str
    target_well_conc: float
    tube_working_conc: float
    unit: str
    wells_count: int
    dispense_per_well_ul: float
    total_prepare_ul: float
    source_label: str
    transfer_in_ul: float
    diluent_ul: float


@dataclass
class SerialDilutionPlan:
    treatment: str
    unit: str
    stock_conc: float
    stock_unit: str
    spike_factor: float  # e.g. 1.0 for direct 1X replacement, 10.0 for 10X spike-in
    predilution_note: str
    vehicle_note: str
    steps: List[DilutionStep] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


def calculate_master_mixes(
    layout: PlateLayout,
    components: Optional[List[ReagentComponent]] = None,
    group_by: str = "role_or_target",  # "all_active" | "treatment" | "sample" | "role_or_target"
    overage_pct: float = 15.0,
    min_dead_ul: float = 20.0,
    spike_factor: float = 1.0,
) -> List[MasterMixGroup]:
    """Compute master-mix tube totals grouped by assay target/treatment or plate-wide."""
    if not components:
        if layout.assay_type == "qpcr":
            v = layout.well_volume_ul or 10.0
            components = [
                ReagentComponent("2X qPCR SYBR Master Mix", round(0.50 * v, 2)),
                ReagentComponent("Fwd + Rev Primer Mix (10 uM)", round(0.08 * v, 2)),
                ReagentComponent("Nuclease-Free Water", round(0.22 * v, 2)),
                ReagentComponent("cDNA Template (added per well)", round(0.20 * v, 2)),
            ]
        else:
            v = layout.well_volume_ul or 100.0
            base_v = v * (1.0 - 1.0 / spike_factor) if spike_factor > 1.0 else v
            components = [
                ReagentComponent("Cell Suspension / Assay Media", round(base_v, 2)),
            ]

    buckets: Dict[str, List[str]] = {}
    for wid, w in layout.wells.items():
        if not w.is_active_assay_well:
            continue
        if group_by == "all_active":
            key = "All Active Assay Wells"
        elif group_by == "sample":
            key = "Cell-Free Blank" if w.role == "blank" else (w.sample or w.role.upper())
        elif group_by == "treatment":
            key = w.treatment or w.role.upper()
        else:
            if layout.assay_type == "qpcr":
                key = w.treatment or w.role.upper()
            elif w.role == "blank":
                key = "Cell-Free Blank / Media"
            else:
                key = w.sample or "Assay Wells"
        buckets.setdefault(key, []).append(wid)

    # Sort wells naturally (A1..H12)
    for k in buckets:
        buckets[k].sort(key=lambda x: (split_well(x)[2], split_well(x)[3]))

    per_well_sum = sum(c.per_well_ul for c in components)
    results: List[MasterMixGroup] = []
    for key in sorted(buckets.keys()):
        wells = buckets[key]
        n = len(wells)
        eff_wells = n * (1.0 + overage_pct / 100.0)
        raw_total = eff_wells * per_well_sum
        if raw_total - (n * per_well_sum) < min_dead_ul and per_well_sum > 0:
            raw_total = (n * per_well_sum) + min_dead_ul
            eff_wells = raw_total / per_well_sum

        comp_rows = [
            (c.name, c.per_well_ul, round(c.per_well_ul * eff_wells, 2))
            for c in components
        ]
        preview = ", ".join(wells[:5]) + (f" (+{n - 5} more)" if n > 5 else "")
        results.append(
            MasterMixGroup(
                group_name=key,
                well_count=n,
                wells_preview=preview,
                overage_pct=overage_pct,
                effective_wells=round(eff_wells, 2),
                total_volume_ul=round(sum(r[2] for r in comp_rows), 2),
                components=comp_rows,
            )
        )
    return results


def calculate_serial_dilutions(
    layout: PlateLayout,
    stock_conc: float = 10.0,
    stock_unit: str = "mM",
    spike_factor: float = 1.0,
    overage_pct: float = 20.0,
    dead_volume_ul: float = 30.0,
    vehicle_name: str = "DMSO",
) -> List[SerialDilutionPlan]:
    """Generate backwards-recurrence serial dilution recipes for every multi-dose treatment."""
    by_treat: Dict[Tuple[str, str], Dict[float, int]] = {}
    for w in layout.wells.values():
        if w.role not in ("sample", "pos_ctrl", "standard"):
            continue
        if not w.treatment or w.concentration is None or w.concentration <= 0:
            continue
        key = (w.treatment, w.unit or "uM")
        dose = round(float(w.concentration), 9)
        by_treat.setdefault(key, {})
        by_treat[key][dose] = by_treat[key].get(dose, 0) + 1

    dispense_ul = (layout.well_volume_ul or 100.0) / max(spike_factor, 1.0)
    plans: List[SerialDilutionPlan] = []

    for (treat, unit), dose_counts in sorted(by_treat.items()):
        doses_desc = sorted(dose_counts.keys(), reverse=True)
        if len(doses_desc) < 2:
            continue

        plan = SerialDilutionPlan(
            treatment=treat,
            unit=unit,
            stock_conc=stock_conc,
            stock_unit=stock_unit,
            spike_factor=spike_factor,
            predilution_note="",
            vehicle_note="",
        )

        stock_in_plate_unit = convert_conc(stock_conc, stock_unit, unit)
        if stock_in_plate_unit is None:
            plan.warnings.append(
                f"Stock unit ({stock_unit}) and plate unit ({unit}) are non-molar or incompatible; assuming numeric ratio in {unit}."
            )
            stock_in_plate_unit = stock_conc

        top_working_conc = doses_desc[0] * spike_factor
        if stock_in_plate_unit <= top_working_conc:
            plan.warnings.append(
                f"Stock concentration ({stock_conc} {stock_unit} = {stock_in_plate_unit:g} {unit}) "
                f"must exceed top tube concentration ({top_working_conc:g} {unit})."
            )
            plans.append(plan)
            continue

        # Backwards recurrence from lowest dose (index k-1) up to top dose (index 0)
        k = len(doses_desc)
        transfer_to_next = [0.0] * k
        total_prepare = [0.0] * k

        for i in range(k - 1, -1, -1):
            n_wells = dose_counts[doses_desc[i]]
            needed_dispense = n_wells * dispense_ul * (1.0 + overage_pct / 100.0) + dead_volume_ul
            total_prepare[i] = needed_dispense + transfer_to_next[i]
            if i > 0:
                c_prev = doses_desc[i - 1] * spike_factor
                c_curr = doses_desc[i] * spike_factor
                transfer_to_next[i - 1] = total_prepare[i] * (c_curr / c_prev)

        # Check Tube 1 stock pipette volume; auto-insert pre-dilution if < 1.5 uL
        effective_stock_conc = stock_in_plate_unit
        effective_stock_label = f"Master Stock ({stock_conc:g} {stock_unit})"
        raw_stock_ul = total_prepare[0] * (top_working_conc / effective_stock_conc)

        if raw_stock_ul < 1.5:
            # Suggest clean 1:10 or 1:100 intermediate stock
            pre_factor = 10.0 if raw_stock_ul * 10.0 >= 1.5 else 100.0
            if raw_stock_ul * pre_factor < 1.5:
                pre_factor = 1000.0
            inter_conc = stock_in_plate_unit / pre_factor
            if inter_conc > top_working_conc * 1.2:
                effective_stock_conc = inter_conc
                effective_stock_label = f"1:{int(pre_factor)} Working Stock ({inter_conc:g} {unit})"
                pre_vol = 50.0 if pre_factor == 10.0 else 200.0
                src_u = pre_vol / pre_factor
                if src_u < 2.0:
                    src_u = 2.0
                    pre_vol = src_u * pre_factor
                plan.predilution_note = (
                    f"Pipetting guardrail: direct spike from {stock_conc:g} {stock_unit} would require "
                    f"{raw_stock_ul:.2f} uL (<1.5 uL). First make {effective_stock_label}: "
                    f"{src_u:.1f} uL Master Stock + {pre_vol - src_u:.1f} uL {vehicle_name}/diluent."
                )
            else:
                plan.warnings.append(
                    f"Tube 1 requires {raw_stock_ul:.2f} uL of stock (<1.5 uL); consider scaling up Tube 1 volume."
                )

        # Vehicle (DMSO) consistency check
        final_top_vehicle_pct = 100.0 * (doses_desc[0] / stock_in_plate_unit)
        if final_top_vehicle_pct >= 0.01:
            tube_vehicle_pct = final_top_vehicle_pct * spike_factor
            plan.vehicle_note = (
                f"Constant-{vehicle_name} tip: Tube 1 contains {tube_vehicle_pct:.3g}% {vehicle_name} "
                f"({final_top_vehicle_pct:.3g}% final in well). Prepare serial-dilution diluent with "
                f"{tube_vehicle_pct:.3g}% {vehicle_name} so all doses match your {final_top_vehicle_pct:.3g}% {vehicle_name} negative control."
            )
        if final_top_vehicle_pct > 0.5:
            plan.warnings.append(
                f"High final {vehicle_name} warning: top dose {doses_desc[0]:g} {unit} delivers "
                f"{final_top_vehicle_pct:.2f}% {vehicle_name} in-well (>0.5% is cytotoxic to many cell lines)."
            )

        # Build step rows
        for i, dose in enumerate(doses_desc):
            working_c = dose * spike_factor
            if i == 0:
                vin = total_prepare[0] * (working_c / effective_stock_conc)
                src = effective_stock_label
            else:
                prev_working = doses_desc[i - 1] * spike_factor
                vin = total_prepare[i] * (working_c / prev_working)
                src = f"Tube {i} ({doses_desc[i - 1]:g} {unit})"
                if vin < 2.0:
                    plan.warnings.append(
                        f"Tube {i + 1} transfer volume is {vin:.2f} uL (<2.0 uL); increase dead volume or reduce dilution ratio."
                    )
            vdil = total_prepare[i] - vin
            plan.steps.append(
                DilutionStep(
                    step_index=i + 1,
                    label=f"Tube {i + 1}",
                    target_well_conc=dose,
                    tube_working_conc=working_c,
                    unit=unit,
                    wells_count=dose_counts[dose],
                    dispense_per_well_ul=round(dispense_ul, 2),
                    total_prepare_ul=round(total_prepare[i], 1),
                    source_label=src,
                    transfer_in_ul=round(vin, 2),
                    diluent_ul=round(vdil, 2),
                )
            )
        plans.append(plan)

    return plans
