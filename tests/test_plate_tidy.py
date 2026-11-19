"""Unit tests for plate-tidy models, calculator, .xlsx/CSV parser, Z' QC, 4PL & ddCt."""

from __future__ import annotations

import math
import tempfile
import unittest
import zipfile
from pathlib import Path

from plate_tidy.analysis import analyze_block, format_prism_xy_tsv, format_tidy_csv
from plate_tidy.calculator import calculate_master_mixes, calculate_serial_dilutions
from plate_tidy.models import PlateLayout, WellAssignment, normalize_well_id, row_index_to_label
from plate_tidy.parser import parse_reader_file
from plate_tidy.report import generate_html_report


def _build_minimal_xlsx(path: Path, shared_strings: list[str], rows_xml: str) -> None:
    """Construct a valid ECMA-376 .xlsx archive using only stdlib zipfile."""
    workbook_rels = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""
    workbook_xml = """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Tecan_Spark" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""
    ss_items = "".join(f"<si><t>{s}</t></si>" for s in shared_strings)
    ss_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(shared_strings)}" uniqueCount="{len(shared_strings)}">{ss_items}</sst>"""
    sheet_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>{rows_xml}</sheetData>
</worksheet>"""
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        zf.writestr("xl/workbook.xml", workbook_xml)
        zf.writestr("xl/sharedStrings.xml", ss_xml)
        zf.writestr("xl/worksheets/sheet1.xml", sheet_xml)


class TestModelsAndAudit(unittest.TestCase):
    def test_well_normalization_and_edge_audit(self) -> None:
        self.assertEqual(normalize_well_id("a01"), "A1")
        self.assertEqual(normalize_well_id(" P 24 "), "P24")

        layout = PlateLayout(
            plate_id="EdgeTest",
            plate_format=96,
            assay_type="viability",
            wells={
                "A1": WellAssignment(well="A01", role="sample", sample="A549", treatment="DrugX", concentration=1.0, unit="uM"),
            },
        )
        codes = {w.code for w in layout.audit()}
        self.assertIn("EDGE_EFFECT_RISK", codes)
        self.assertIn("MISSING_NEG_CTRL", codes)
        self.assertIn("SINGLETON_REPLICATES", codes)

    def test_csv_layout_import(self) -> None:
        csv_txt = "well,role,sample,treatment,concentration,unit,bio_rep\nB02,sample,A549,Olaparib,10,uM,Rep1\nB03,neg_ctrl,A549,DMSO,0,uM,Rep1\n"
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "layout.csv"
            p.write_text(csv_txt, encoding="utf-8")
            layout = PlateLayout.load(p)
            self.assertEqual(layout.get_well("B2").sample, "A549")
            self.assertEqual(layout.get_well("B2").concentration, 10.0)
            self.assertEqual(layout.get_well("B3").role, "neg_ctrl")


class TestCalculator(unittest.TestCase):
    def test_backwards_recurrence_and_predilution_guardrail(self) -> None:
        wells = {}
        doses = [1.0, 0.2, 0.04, 0.008]
        for r_idx in range(1, 4):
            rl = row_index_to_label(r_idx)
            for c_idx, d in enumerate(doses, start=2):
                wid = f"{rl}{c_idx}"
                wells[wid] = WellAssignment(
                    well=wid, role="sample", sample="HeLa", treatment="PotentDrug", concentration=d, unit="uM"
                )
        layout = PlateLayout(plate_id="CalcTest", plate_format=96, well_volume_ul=100.0, wells=wells)

        plans = calculate_serial_dilutions(layout, stock_conc=100.0, stock_unit="mM", spike_factor=1.0, overage_pct=20.0, dead_volume_ul=30.0)
        self.assertEqual(len(plans), 1)
        plan = plans[0]
        self.assertIn("Pipetting guardrail", plan.predilution_note)
        self.assertEqual(len(plan.steps), 4)

        step1, step2 = plan.steps[0], plan.steps[1]
        expected_dispense_1 = 3 * 100.0 * 1.20 + 30.0
        self.assertAlmostEqual(step1.total_prepare_ul, expected_dispense_1 + step2.transfer_in_ul, places=1)
        self.assertGreaterEqual(step1.transfer_in_ul, 1.5)

        mm = calculate_master_mixes(layout, overage_pct=15.0, spike_factor=10.0)
        self.assertEqual(mm[0].well_count, 12)
        self.assertEqual(mm[0].components[0][1], 90.0)

        # Verify Unicode micro-sign ('µM' U+00B5 and 'μM' U+03BC) conversion against 'mM' stock
        wells["B2"].unit = "\u00b5M"
        wells["B3"].unit = "\u00b5M"
        wells["B4"].unit = "\u00b5M"
        wells["B5"].unit = "\u00b5M"
        micro_plans = calculate_serial_dilutions(layout, stock_conc=10.0, stock_unit="mM", spike_factor=10.0)
        self.assertGreaterEqual(len(micro_plans[0].steps), 2)


class TestParserAndAnalysis(unittest.TestCase):
    def test_xlsx_matrix_parsing_without_third_party_deps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            xlsx_path = Path(tmp) / "tecan_export.xlsx"
            shared = ["Luminescence (RLU)", "A", "B", "OVER"]
            rows_xml = """
              <row r="2"><c r="A2" t="s"><v>0</v></c></row>
              <row r="4">
                <c r="B4"><v>1</v></c><c r="C4"><v>2</v></c><c r="D4"><v>3</v></c>
              </row>
              <row r="5">
                <c r="A5" t="s"><v>1</v></c>
                <c r="B5"><v>10500</v></c><c r="C5"><v>5200</v></c><c r="D5" t="s"><v>3</v></c>
              </row>
              <row r="6">
                <c r="A6" t="s"><v>2</v></c>
                <c r="B6"><v>10300</v></c><c r="C6"><v>5100</v></c><c r="D6"><v>120</v></c>
              </row>
            """
            _build_minimal_xlsx(xlsx_path, shared, rows_xml)
            blocks = parse_reader_file(xlsx_path)
            self.assertEqual(len(blocks), 1)
            b = blocks[0]
            self.assertEqual(b.block_id, "Luminescence (RLU)")
            self.assertEqual(b.measurements["A1"].value, 10500.0)
            self.assertIsNone(b.measurements["A3"].value)
            self.assertEqual(b.measurements["A3"].status, "OVERFLOW")
            self.assertEqual(b.measurements["B3"].value, 120.0)

    def test_partial_plate_scan_and_multi_block_dedup(self) -> None:
        raw = "\n".join(
            [
                "Kinetic Read",
                ",2,3,4",
                "B,1000,500,250",
                "C,1020,490,260",
                "",
                "Kinetic Read",
                ",2,3,4",
                "B,2000,1000,500",
                "C,2050,980,510",
            ]
        )
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "partial.csv"
            p.write_text(raw, encoding="utf-8")
            blocks = parse_reader_file(p)
            self.assertEqual(len(blocks), 2)
            self.assertEqual(blocks[0].block_id, "Kinetic Read (1)")
            self.assertEqual(blocks[1].block_id, "Kinetic Read (2)")
            self.assertEqual(blocks[0].measurements["B2"].value, 1000.0)
            self.assertEqual(blocks[1].measurements["C4"].value, 510.0)

    def test_zero_dose_sample_fallback_normalization(self) -> None:
        raw = ",1,2,3\nA,500,1000,1000\nB,520,1020,980\n"
        wells = {
            "A1": WellAssignment(well="A1", role="sample", sample="WT", treatment="Drug", concentration=10.0, unit="uM"),
            "B1": WellAssignment(well="B1", role="sample", sample="WT", treatment="Drug", concentration=10.0, unit="uM"),
            "A2": WellAssignment(well="A2", role="sample", sample="WT", treatment="Drug", concentration=0.0, unit="uM"),
            "B2": WellAssignment(well="B2", role="sample", sample="WT", treatment="Drug", concentration=0.0, unit="uM"),
        }
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "zero_fallback.csv"
            p.write_text(raw, encoding="utf-8")
            blocks = parse_reader_file(p)
            layout = PlateLayout(plate_id="ZeroTest", plate_format=96, assay_type="viability", wells=wells)
            res = analyze_block(layout, blocks[0])
            rmap = {r.well: r for r in res.rows}
            self.assertAlmostEqual(rmap["A1"].pct_control or 0.0, 50.0, delta=1.5)
            self.assertTrue(any("0-concentration" in n for n in res.qc.notes))

    def test_4pl_ic50_recovery_and_z_prime_qc(self) -> None:
        wells = {}
        measurements_lines = ["BioTek Gen5 Export", "Plate Type,96 WELL", "", "Luminescence 578nm", ",1,2,3,4,5,6,7,8,9,10,11,12"]
        doses = [10.0 / (3.0 ** i) for i in range(8)]

        for r in range(8):
            rl = row_index_to_label(r)
            row_vals = [rl]
            for c in range(1, 13):
                wid = f"{rl}{c}"
                if r in (0, 7) or c in (1, 12):
                    wells[wid] = WellAssignment(well=wid, role="moat", treatment="PBS")
                    row_vals.append("150")
                elif c <= 9:
                    d = doses[c - 2]
                    smp = "WT" if r <= 3 else "KO"
                    true_ic50 = 3.0 if smp == "WT" else 0.05
                    wells[wid] = WellAssignment(well=wid, role="sample", sample=smp, treatment="Olaparib", concentration=d, unit="uM")
                    pct = 5.0 + 95.0 / (1.0 + (d / true_ic50) ** 1.2)
                    sig = 200.0 + 99800.0 * (pct / 100.0)
                    row_vals.append(f"{sig:.1f}")
                elif c == 10:
                    smp = "WT" if r <= 3 else "KO"
                    wells[wid] = WellAssignment(well=wid, role="neg_ctrl", sample=smp, treatment="DMSO", concentration=0.0, unit="uM")
                    row_vals.append("100000" if r % 2 == 0 else "101500")
                elif c == 11 and r <= 3:
                    wells[wid] = WellAssignment(well=wid, role="pos_ctrl", sample="WT", treatment="Stauro", concentration=1.0, unit="uM")
                    row_vals.append("500" if r % 2 == 0 else "540")
                else:
                    wells[wid] = WellAssignment(well=wid, role="blank", treatment="Media")
                    row_vals.append("200")
            measurements_lines.append(",".join(row_vals))

        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "ctg.csv"
            csv_path.write_text("\n".join(measurements_lines) + "\n", encoding="utf-8")
            blocks = parse_reader_file(csv_path)
            layout = PlateLayout(plate_id="SynthLethal", plate_format=96, assay_type="viability", wells=wells)
            res = analyze_block(layout, blocks[0])

            self.assertIsNotNone(res.qc.z_prime)
            assert res.qc.z_prime is not None
            self.assertGreater(res.qc.z_prime, 0.90)
            self.assertEqual(len(res.curves), 2)

            by_sample = {c.sample: c for c in res.curves}
            self.assertAlmostEqual(math.log10(by_sample["WT"].ic50), math.log10(3.0), delta=0.08)
            self.assertAlmostEqual(math.log10(by_sample["KO"].ic50), math.log10(0.05), delta=0.08)
            self.assertGreater(by_sample["KO"].r_squared, 0.99)

            tidy_txt = format_tidy_csv([res])
            self.assertIn("SynthLethal", tidy_txt)
            prism_txt = format_prism_xy_tsv(res)
            self.assertIn("KO + Olaparib_Rep1", prism_txt)
            html_txt = generate_html_report(layout, [res])
            self.assertIn("<svg", html_txt)

    def test_qpcr_quantstudio_ddct(self) -> None:
        qs_text = "\n".join(
            [
                "* Instrument Type = QuantStudio 6 Flex",
                "* Chemistry = SYBR_GREEN",
                "",
                "[Results]",
                "Well,Well Position,Sample Name,Target Name,Task,Reporter,Cq",
                "1,A01,WT,GAPDH,UNKNOWN,SYBR,18.0",
                "2,A02,WT,GAPDH,UNKNOWN,SYBR,18.0",
                "3,A03,WT,BRCA1,UNKNOWN,SYBR,22.0",
                "4,A04,WT,BRCA1,UNKNOWN,SYBR,22.0",
                "5,B01,KO,GAPDH,UNKNOWN,SYBR,18.5",
                "6,B02,KO,GAPDH,UNKNOWN,SYBR,18.5",
                "7,B03,KO,BRCA1,UNKNOWN,SYBR,25.5",
                "8,B04,KO,BRCA1,UNKNOWN,SYBR,25.5",
                "9,C01,NTC,BRCA1,NTC,SYBR,Undetermined",
            ]
        )
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "quantstudio.csv"
            p.write_text(qs_text, encoding="utf-8")
            blocks = parse_reader_file(p)
            wells = {
                w: WellAssignment(well=w, role="neg_ctrl" if w.startswith("A") else ("blank" if w.startswith("C") else "sample"))
                for w in ("A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "C1")
            }
            layout = PlateLayout(plate_id="qPCR_Test", plate_format=96, assay_type="qpcr", housekeeping_target="GAPDH", wells=wells)
            res = analyze_block(layout, blocks[0])
            row_map = {r.well: r for r in res.rows}
            self.assertAlmostEqual(row_map["A3"].fold_change or 0.0, 1.0, places=3)
            self.assertAlmostEqual(row_map["B3"].fold_change or 0.0, 0.125, places=3)
            self.assertEqual(row_map["C1"].status, "UNDETERMINED")


if __name__ == "__main__":
    unittest.main()
