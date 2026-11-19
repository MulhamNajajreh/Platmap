# plate-tidy

Microplate layout designer (`6` to `384` wells), master-mix and serial-dilution calculator, and plate-reader / qPCR parser.

`plate-tidy` pairs a static browser interface (`web/`) with a zero-dependency Python CLI (`src/plate_tidy/`). Both read and write the same `.plate.json` layout format and parse raw `.xlsx`, `.csv`, `.tsv`, and `.txt` exports from BioTek Gen5, Tecan Spark/Magellan, Molecular Devices SoftMax Pro, BMG Labtech, and Applied Biosystems QuantStudio.

## Features

- **Visual plate layout:** Circular SBS plate map with drag selection, multi-row / multi-compound serial-dilution generator, perimeter moat helper, undo (`Cmd/Ctrl+Z`), and spatial edge-effect checks.
- **Bench protocol sheet:** Master-mix volumes with configurable dead-volume overage and editable reagent components, plus backwards-recurrence serial-dilution tubes that account for carry-over transfer volumes, `<1.5 µL` pre-dilution steps, and constant-solvent (`DMSO`) matching.
- **Reader parsing & analysis:** Automatic detection of full or partial 2D plate matrices and tabular well exports, blank subtraction, sample-matched `% Control` normalization, Zhang's `Z'`-factor QC (*J Biomol Screen* 1999), 4-parameter logistic (`4PL`) `IC50`/`EC50` curve fitting, and RT-qPCR `2^(-ΔΔCt)` relative expression.
- **Clean exports:** Tidy long-format `.csv` (for R / Python), XY or grouped replicate `.tsv` (for GraphPad Prism), vector `.svg` plots, and standalone `.html` reports.

## Quickstart

### Web interface

Open `web/index.html` directly in a browser, or serve locally:

```bash
uv run plate-tidy serve
```

Starts on a blank 96-well plate; click **Load Example** under the **Layout** tab to inspect a sample *BRCA1*-WT vs *BRCA1*-KO Olaparib viability dataset, or **Print Protocol** for a single-page bench sheet.

### Command-line interface

Requires Python `>=3.9` (standard library only; no third-party packages).

```bash
# Parse a raw BioTek luminescence export with a plate layout
uv run plate-tidy parse examples/raw_biotek_gen5_ctg.csv \
  --layout examples/dose_response_96.plate.json \
  --output out/ctg_tidy.csv \
  --prism out/ctg_prism.tsv \
  --html out/ctg_report.html

# Parse a QuantStudio qPCR export into ddCt fold-change values
uv run plate-tidy parse examples/raw_quantstudio_qpcr.csv \
  --assay-type qpcr --housekeeping GAPDH \
  --output out/qpcr_tidy.csv

# Print a master-mix and serial-dilution bench protocol
uv run plate-tidy recipe examples/dose_response_96.plate.json \
  --stock-conc 10 --stock-unit mM --spike-factor 10 --overage 15
```

## Tests

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

## License

[MIT](LICENSE)
