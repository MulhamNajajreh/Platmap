"""Command-line interface for plate-tidy."""

from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path
from typing import List, Optional

from . import __version__
from .analysis import analyze_block, format_prism_xy_tsv, write_tidy_csv
from .calculator import calculate_master_mixes, calculate_serial_dilutions
from .models import PlateLayout, infer_plate_format, split_well
from .parser import ReadBlock, parse_reader_file
from .report import write_html_report


def _infer_blank_layout(blocks: List[ReadBlock], plate_id: str) -> PlateLayout:
    max_r, max_c = 0, 0
    for b in blocks:
        for wid in b.measurements:
            _, c1, r0, _ = split_well(wid)
            max_r = max(max_r, r0 + 1)
            max_c = max(max_c, c1)
    return PlateLayout(
        plate_id=plate_id,
        plate_format=infer_plate_format(max_r, max_c, min_format=96),
        assay_type="generic",
    )


def cmd_parse(args: argparse.Namespace) -> int:
    raw_path = Path(args.input)
    if not raw_path.exists():
        print(f"error: input file not found: {raw_path}", file=sys.stderr)
        return 1

    blocks = parse_reader_file(raw_path)
    layout = PlateLayout.load(Path(args.layout)) if args.layout else _infer_blank_layout(blocks, raw_path.stem)

    if args.assay_type:
        layout.assay_type = args.assay_type
    if args.housekeeping:
        layout.housekeeping_target = args.housekeeping

    analyses = [analyze_block(layout, b) for b in blocks]
    out_csv = Path(args.output) if args.output else raw_path.with_name(f"{raw_path.stem}_tidy.csv")
    write_tidy_csv(analyses, out_csv)

    print(f"Parsed {len(blocks)} block(s) from {raw_path.name} -> {out_csv}")
    for a in analyses:
        qc = a.qc
        z_txt = f"{qc.z_prime:.3f} ({qc.z_prime_rating})" if qc.z_prime is not None else qc.z_prime_rating
        print(f"  [{a.block_id}] {len(a.rows)} wells | Z' = {z_txt}")
        for c in a.curves:
            abs_txt = f", Abs IC50 = {c.abs_ic50:.4g} {c.unit}" if c.abs_ic50 is not None else ""
            print(
                f"    {c.series_label}: Rel IC50 = {c.ic50:.4g} {c.unit}{abs_txt} "
                f"(Hill = {c.hill_slope:+.2f}, R^2 = {c.r_squared:.3f})"
            )

    if args.prism:
        prism_path = Path(args.prism)
        prism_path.parent.mkdir(parents=True, exist_ok=True)
        prism_path.write_text(format_prism_xy_tsv(analyses[0]), encoding="utf-8")
        print(f"Wrote Prism TSV ({analyses[0].block_id}) -> {prism_path}")

    if args.html:
        html_path = Path(args.html)
        write_html_report(layout, analyses, html_path)
        print(f"Wrote HTML report -> {html_path}")

    return 0


def cmd_recipe(args: argparse.Namespace) -> int:
    layout = PlateLayout.load(Path(args.layout))
    if args.well_vol is not None:
        layout.well_volume_ul = args.well_vol

    print(f"Bench Protocol: {layout.plate_id} ({layout.plate_format}-well, {layout.well_volume_ul:g} uL/well)\n")

    warnings = layout.audit()
    if warnings:
        print("Layout notes:")
        for w in warnings:
            print(f"  - [{w.code}] {w.message}")
        print()

    mm_groups = calculate_master_mixes(layout, overage_pct=args.overage, spike_factor=args.spike_factor)
    print(f"1. Master-mix volumes (+{args.overage:g}% overage):")
    for g in mm_groups:
        print(f"  {g.group_name}: {g.well_count} wells ({g.wells_preview}) -> {g.total_volume_ul:g} uL ({g.effective_wells:g}x)")
        for cname, per_w, tot_u in g.components:
            print(f"    - {cname}: {per_w:g} uL/well -> {tot_u:g} uL")
    print()

    plans = calculate_serial_dilutions(
        layout,
        stock_conc=args.stock_conc,
        stock_unit=args.stock_unit,
        spike_factor=args.spike_factor,
        overage_pct=args.overage,
        vehicle_name=args.vehicle,
    )
    if plans:
        print(f"2. Serial dilutions (Stock: {args.stock_conc:g} {args.stock_unit}, {args.spike_factor:g}x working):")
        for p in plans:
            print(f"\n  {p.treatment} ({p.unit})")
            if p.predilution_note:
                print(f"    Note: {p.predilution_note}")
            if p.vehicle_note:
                print(f"    Note: {p.vehicle_note}")
            for warn in p.warnings:
                print(f"    Warning: {warn}")
            if p.steps:
                print(f"    {'Tube':<8} {'Well Conc':<14} {'Wells':<7} {'Prepare':<11} {'Transfer In':<36} {'+ Diluent':<12}")
                print("    " + "-" * 90)
                for s in p.steps:
                    src_str = f"{s.transfer_in_ul:g} uL from {s.source_label}"
                    print(
                        f"    {s.label:<8} {s.target_well_conc:<8g} {s.unit:<5} {s.wells_count:<7d} "
                        f"{s.total_prepare_ul:<8g} uL {src_str:<36} {s.diluent_ul:g} uL"
                    )
    return 0


def cmd_audit(args: argparse.Namespace) -> int:
    layout = PlateLayout.load(Path(args.layout))
    warnings = layout.audit()
    print(f"Audit: {layout.plate_id} ({layout.plate_format}-well)")
    if not warnings:
        print("  No layout issues flagged.")
        return 0
    for w in warnings:
        print(f"  [{w.severity.upper()}] {w.code}: {w.message}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    web_dir = Path(__file__).resolve().parents[2] / "web"
    if not web_dir.exists():
        print(f"error: web directory not found at {web_dir}", file=sys.stderr)
        return 1

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(web_dir))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        url = f"http://127.0.0.1:{args.port}"
        print(f"Serving plate-tidy at {url} (Ctrl+C to stop)")
        if not args.no_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="plate-tidy",
        description="Microplate designer, master-mix/dilution calculator, and plate-reader parser.",
    )
    p.add_argument("--version", action="version", version=f"plate-tidy {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    p_parse = sub.add_parser("parse", help="Parse plate-reader or qPCR export (.xlsx/.csv/.tsv/.txt) into tidy CSV")
    p_parse.add_argument("input", help="Raw export file (.xlsx, .csv, .tsv, .txt)")
    p_parse.add_argument("-l", "--layout", help="Plate layout file (.plate.json or .csv)")
    p_parse.add_argument("-o", "--output", help="Output tidy CSV path (default: <input>_tidy.csv)")
    p_parse.add_argument("--prism", help="GraphPad Prism TSV output path")
    p_parse.add_argument("--html", help="Standalone HTML report path")
    p_parse.add_argument("--assay-type", choices=["viability", "qpcr", "elisa", "generic"], help="Override assay mode")
    p_parse.add_argument("--housekeeping", help="Reference gene for qPCR ddCt (e.g. GAPDH)")
    p_parse.set_defaults(func=cmd_parse)

    p_rec = sub.add_parser("recipe", help="Print master-mix and serial-dilution bench protocol")
    p_rec.add_argument("layout", help="Plate layout file (.plate.json or .csv)")
    p_rec.add_argument("--well-vol", type=float, help="Final assay volume per well in uL")
    p_rec.add_argument("--stock-conc", type=float, default=10.0, help="Master stock concentration (default: 10)")
    p_rec.add_argument("--stock-unit", default="mM", help="Master stock unit (default: mM)")
    p_rec.add_argument("--spike-factor", type=float, default=1.0, help="Working concentration factor (1 = 1x, 10 = 10x)")
    p_rec.add_argument("--overage", type=float, default=15.0, help="Dead-volume overage percent (default: 15)")
    p_rec.add_argument("--vehicle", default="DMSO", help="Solvent name (default: DMSO)")
    p_rec.set_defaults(func=cmd_recipe)

    p_aud = sub.add_parser("audit", help="Check layout for edge exposure, missing controls, and singletons")
    p_aud.add_argument("layout", help="Plate layout file (.plate.json or .csv)")
    p_aud.set_defaults(func=cmd_audit)

    p_srv = sub.add_parser("serve", help="Serve the local web interface")
    p_srv.add_argument("-p", "--port", type=int, default=8765, help="Local port (default: 8765)")
    p_srv.add_argument("--no-browser", action="store_true", help="Do not open browser automatically")
    p_srv.set_defaults(func=cmd_serve)

    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
