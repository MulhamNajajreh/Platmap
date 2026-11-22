"""Standalone HTML report generator with editorial scientific styling and circular SBS well maps."""

from __future__ import annotations

import html
import math
from pathlib import Path
from typing import List, Optional, Sequence

from .analysis import BlockAnalysis, DoseResponseCurve, eval_4pl
from .models import LayoutWarning, PlateLayout, row_index_to_label

SERIES_PALETTE = [
    "#b84a27",  # Terracotta
    "#28536b",  # Petrol slate
    "#3d7054",  # Botanical green
    "#7a4970",  # Plum
    "#9c6f22",  # Ochre
    "#446491",  # Ultramarine
]


def _heat_color(t: float) -> str:
    """Warm paper-to-petrol-ink sequential scale for t in [0, 1]."""
    t = max(0.0, min(1.0, t))
    stops = [
        (0.0, (242, 239, 231)),
        (0.35, (169, 200, 192)),
        (0.70, (66, 125, 118)),
        (1.0, (26, 61, 64)),
    ]
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t <= t1:
            u = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            r = int(round(c0[0] + u * (c1[0] - c0[0])))
            g = int(round(c0[1] + u * (c1[1] - c0[1])))
            b = int(round(c0[2] + u * (c1[2] - c0[2])))
            return f"rgb({r},{g},{b})"
    return "rgb(26,61,64)"


def _render_plate_heatmap_svg(layout: PlateLayout, analysis: BlockAnalysis) -> str:
    n_rows, n_cols = layout.dimensions
    pitch = 34 if layout.plate_format <= 96 else 20
    radius = 13.5 if layout.plate_format <= 96 else 7.8
    pad_left, pad_top = 36, 30
    width = pad_left + n_cols * pitch + 16
    height = pad_top + n_rows * pitch + 16

    raw_by_well = {r.well: r.raw_value for r in analysis.rows if r.raw_value is not None}
    vals = list(raw_by_well.values())
    v_min = min(vals) if vals else 0.0
    v_max = max(vals) if vals else 1.0
    span = (v_max - v_min) if v_max > v_min else 1.0

    parts = [
        f'<svg viewBox="0 0 {width} {height}" width="100%" style="max-width:{max(500, width)}px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">',
        f'<rect x="2" y="2" width="{width - 4}" height="{height - 4}" rx="8" fill="#f7f5ef" stroke="#d5d0c5" stroke-width="1.2"/>',
    ]
    for c in range(1, n_cols + 1):
        cx = pad_left + (c - 0.5) * pitch
        parts.append(f'<text x="{cx}" y="20" text-anchor="middle" font-size="10.5" fill="#6b675e" font-weight="600">{c}</text>')

    for r in range(n_rows):
        rlbl = row_index_to_label(r)
        cy = pad_top + (r + 0.5) * pitch
        parts.append(f'<text x="18" y="{cy + 3.5}" text-anchor="middle" font-size="10.5" fill="#6b675e" font-weight="600">{rlbl}</text>')
        for c in range(1, n_cols + 1):
            wid = f"{rlbl}{c}"
            w = layout.get_well(wid)
            val = raw_by_well.get(wid)
            cx = pad_left + (c - 0.5) * pitch
            if val is not None:
                t = (val - v_min) / span
                fill = _heat_color(t)
                txt_fill = "#fcfbf9" if t > 0.52 else "#1c1b18"
            else:
                fill = "#ece9e0" if w.role != "moat" else "#e6eaeb"
                txt_fill = "#8a867c"
            title_txt = html.escape(
                f"{wid} ({w.role}) {w.sample} {w.treatment} "
                f"{'' if w.concentration is None else f'{w.concentration:g} {w.unit}'} -> "
                f"{'N/A' if val is None else f'{val:g}'}"
            )
            parts.append(
                f'<g><title>{title_txt}</title>'
                f'<circle cx="{cx}" cy="{cy}" r="{radius}" fill="{fill}" stroke="#c6c0b4" stroke-width="1"/>'
            )
            if pitch >= 30 and w.role in ("neg_ctrl", "pos_ctrl", "blank"):
                mark = {"neg_ctrl": "0", "pos_ctrl": "+", "blank": "–"}[w.role]
                parts.append(
                    f'<text x="{cx}" y="{cy + 3.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="{txt_fill}">{mark}</text>'
                )
            parts.append("</g>")
    parts.append("</svg>")
    return "".join(parts)


def _render_curves_svg(curves: Sequence[DoseResponseCurve]) -> str:
    if not curves:
        return ""
    width, height = 640, 350
    ml, mr, mt, mb = 56, 24, 22, 50
    pw, ph = width - ml - mr, height - mt - mb

    all_doses = [d for c in curves for d in c.doses if d > 0]
    log_min = math.floor(math.log10(min(all_doses)) * 2.0) / 2.0 - 0.25
    log_max = math.ceil(math.log10(max(all_doses)) * 2.0) / 2.0 + 0.25

    all_y = [m + sd for c in curves for m, sd in zip(c.mean_responses, c.sd_responses)] + [0.0, 105.0]
    y_min = min(0.0, min(m - sd for c in curves for m, sd in zip(c.mean_responses, c.sd_responses)))
    y_max = max(115.0, max(all_y) * 1.05)

    def sx(log_x: float) -> float:
        return ml + (log_x - log_min) / (log_max - log_min) * pw

    def sy(yv: float) -> float:
        return mt + ph - (yv - y_min) / (y_max - y_min) * ph

    parts = [
        f'<svg viewBox="0 0 {width} {height}" width="100%" style="max-width:660px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#fcfbf9;border:1px solid #dedad0;border-radius:6px;">'
    ]

    for y_tick in (0, 25, 50, 75, 100):
        if y_min <= y_tick <= y_max:
            yp = sy(y_tick)
            dash = 'stroke-dasharray="4,4"' if y_tick == 50 else ""
            stroke = "#a8a296" if y_tick == 50 else "#ebe8e0"
            parts.append(f'<line x1="{ml}" y1="{yp:.1f}" x2="{ml + pw}" y2="{yp:.1f}" stroke="{stroke}" stroke-width="1" {dash}/>')
            parts.append(f'<text x="{ml - 8}" y="{yp + 3.5:.1f}" text-anchor="end" font-size="10.5" fill="#5c5952">{y_tick}%</text>')

    for exp_i in range(int(math.floor(log_min)), int(math.ceil(log_max)) + 1):
        if log_min <= exp_i <= log_max:
            xp = sx(float(exp_i))
            parts.append(f'<line x1="{xp:.1f}" y1="{mt}" x2="{xp:.1f}" y2="{mt + ph}" stroke="#ebe8e0" stroke-width="1"/>')
            lbl = f"10^{exp_i}" if abs(exp_i) >= 3 else f"{10 ** exp_i:g}"
            parts.append(f'<text x="{xp:.1f}" y="{mt + ph + 17}" text-anchor="middle" font-size="10.5" fill="#5c5952">{lbl}</text>')

    parts.append(f'<line x1="{ml}" y1="{mt}" x2="{ml}" y2="{mt + ph}" stroke="#2c2a26" stroke-width="1.25"/>')
    parts.append(f'<line x1="{ml}" y1="{mt + ph}" x2="{ml + pw}" y2="{mt + ph}" stroke="#2c2a26" stroke-width="1.25"/>')
    unit_lbl = (curves[0].unit or "uM").replace("uM", "µM")
    parts.append(f'<text x="{ml + pw / 2}" y="{height - 10}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#1c1b18">Concentration ({html.escape(unit_lbl)})</text>')
    parts.append(f'<text x="15" y="{mt + ph / 2}" transform="rotate(-90 15 {mt + ph / 2})" text-anchor="middle" font-size="11.5" font-weight="600" fill="#1c1b18">% of Vehicle Control</text>')

    for idx, c in enumerate(curves):
        color = SERIES_PALETTE[idx % len(SERIES_PALETTE)]
        lic = math.log10(c.ic50)
        pts = [
            f"{sx(log_min + (step / 120.0) * (log_max - log_min)):.1f},{sy(eval_4pl(10.0 ** (log_min + (step / 120.0) * (log_max - log_min)), c.bottom, c.top, lic, c.hill_slope)):.1f}"
            for step in range(121)
        ]
        parts.append(f'<polyline fill="none" stroke="{color}" stroke-width="2.2" points="{" ".join(pts)}"/>')

        for d, m, sd in zip(c.doses, c.mean_responses, c.sd_responses):
            xp = sx(math.log10(d))
            yp = sy(m)
            if sd > 0:
                y_hi, y_lo = sy(min(y_max, m + sd)), sy(max(y_min, m - sd))
                parts.append(f'<line x1="{xp:.1f}" y1="{y_hi:.1f}" x2="{xp:.1f}" y2="{y_lo:.1f}" stroke="{color}" stroke-width="1.2"/>')
                parts.append(f'<line x1="{xp - 3:.1f}" y1="{y_hi:.1f}" x2="{xp + 3:.1f}" y2="{y_hi:.1f}" stroke="{color}" stroke-width="1.2"/>')
                parts.append(f'<line x1="{xp - 3:.1f}" y1="{y_lo:.1f}" x2="{xp + 3:.1f}" y2="{y_lo:.1f}" stroke="{color}" stroke-width="1.2"/>')
            parts.append(f'<circle cx="{xp:.1f}" cy="{yp:.1f}" r="3.8" fill="{color}" stroke="#fcfbf9" stroke-width="1.1"/>')

    parts.append("</svg>")
    return "".join(parts)


def generate_html_report(
    layout: PlateLayout,
    analyses: Sequence[BlockAnalysis],
    layout_warnings: Optional[Sequence[LayoutWarning]] = None,
) -> str:
    warnings = list(layout_warnings) if layout_warnings is not None else layout.audit()
    warn_html = ""
    if warnings:
        items = "".join(f"<li>{html.escape(w.message)}</li>" for w in warnings)
        warn_html = f'<div class="notice"><strong>Layout notes:</strong><ul>{items}</ul></div>'

    sections: List[str] = []
    for analysis in analyses:
        qc = analysis.qc
        heatmap_svg = _render_plate_heatmap_svg(layout, analysis)
        curves_svg = _render_curves_svg(analysis.curves)

        curve_rows = ""
        for idx, c in enumerate(analysis.curves):
            color = SERIES_PALETTE[idx % len(SERIES_PALETTE)]
            unit_disp = html.escape(c.unit.replace("uM", "µM"))
            abs_str = f"{c.abs_ic50:.4g} {unit_disp}" if c.abs_ic50 is not None else "—"
            curve_rows += (
                f"<tr>"
                f'<td><span class="swatch" style="background:{color}"></span><strong>{html.escape(c.series_label)}</strong></td>'
                f"<td class='num'>{c.ic50:.4g} {unit_disp}</td>"
                f"<td class='num'>{abs_str}</td>"
                f"<td class='num'>{c.hill_slope:+.2f}</td>"
                f"<td class='num'>{c.bottom:.1f}% – {c.top:.1f}%</td>"
                f"<td class='num'>{c.r_squared:.3f}</td>"
                f"</tr>"
            )

        curve_block = ""
        if analysis.curves:
            curve_block = f"""
            <div style="margin-top:22px;">
              <h3>Dose–Response Curves (4PL Hill Fit)</h3>
              {curves_svg}
              <table style="margin-top:12px;">
                <thead>
                  <tr>
                    <th>Condition</th>
                    <th>Rel. IC₅₀ / EC₅₀</th>
                    <th>Abs. IC₅₀ (50%)</th>
                    <th>Hill Slope</th>
                    <th>Span</th>
                    <th>R²</th>
                  </tr>
                </thead>
                <tbody>{curve_rows}</tbody>
              </table>
            </div>
            """

        z_str = f"{qc.z_prime:.3f}" if qc.z_prime is not None else "—"
        cv_str = f"{qc.neg_ctrl_cv_pct:.1f}%" if qc.neg_ctrl_cv_pct is not None else "—"
        sb_str = f"{qc.signal_to_background:.1f}×" if qc.signal_to_background is not None else "—"

        sections.append(
            f"""
            <section class="panel">
              <h2>{html.escape(analysis.block_id)}</h2>
              <div class="metrics">
                <div><span>Z'-factor</span><strong>{z_str}</strong><small>{html.escape(qc.z_prime_rating)}</small></div>
                <div><span>Vehicle Ctrl (CV)</span><strong>{qc.neg_ctrl_mean:g} ({cv_str})</strong><small>n = {qc.neg_ctrl_n}</small></div>
                <div><span>Blank Mean ± SD</span><strong>{qc.blank_mean:g} ± {qc.blank_sd:g}</strong><small>n = {qc.blank_n}</small></div>
                <div><span>Signal / Blank</span><strong>{sb_str}</strong><small>Dynamic range</small></div>
              </div>
              <h3>Spatial Signal Map</h3>
              {heatmap_svg}
              {curve_block}
            </section>
            """
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>{html.escape(layout.plate_id)} — PlateMap</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f2ec; color: #1c1b18; margin: 0; padding: 28px 20px; font-variant-numeric: tabular-nums; }}
    .wrap {{ max-width: 940px; margin: 0 auto; }}
    header {{ border-bottom: 1px solid #d5d0c5; padding-bottom: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: baseline; }}
    h1 {{ margin: 0; font-size: 21px; font-weight: 600; letter-spacing: -0.01em; }}
    .meta {{ color: #5c5952; font-size: 13px; }}
    h2 {{ margin: 0 0 14px 0; font-size: 16px; font-weight: 600; }}
    h3 {{ margin: 0 0 8px 0; font-size: 13.5px; font-weight: 600; color: #3d3b36; }}
    .panel {{ background: #fbfaf7; border: 1px solid #dedad0; border-radius: 8px; padding: 20px; margin-bottom: 20px; }}
    .notice {{ background: #f8f3e6; border: 1px solid #dfd2b0; border-radius: 6px; padding: 10px 14px; margin-bottom: 18px; font-size: 13px; color: #4f4222; }}
    .notice ul {{ margin: 4px 0 0 0; padding-left: 18px; }}
    .metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 18px; border-top: 1px solid #e7e3da; border-bottom: 1px solid #e7e3da; padding: 12px 0; }}
    .metrics span {{ display: block; font-size: 11.5px; color: #6b675e; }}
    .metrics strong {{ display: block; font-size: 15px; margin-top: 2px; }}
    .metrics small {{ font-size: 11px; color: #8a867c; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
    th, td {{ padding: 7px 8px; border-bottom: 1px solid #e7e3da; text-align: left; }}
    th {{ font-weight: 600; color: #5c5952; font-size: 12px; }}
    td.num {{ font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }}
    .swatch {{ display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; }}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>{html.escape(layout.plate_id)}</h1>
      <span class="meta">{layout.plate_format}-well plate · {html.escape(layout.assay_type)} · {layout.well_volume_ul:g} µL/well</span>
    </header>
    {warn_html}
    {"".join(sections)}
  </div>
</body>
</html>
"""


def write_html_report(
    layout: PlateLayout,
    analyses: Sequence[BlockAnalysis],
    path: Path,
    layout_warnings: Optional[Sequence[LayoutWarning]] = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(generate_html_report(layout, analyses, layout_warnings), encoding="utf-8")
