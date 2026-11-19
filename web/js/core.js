/* Core plate geometry, state, undo history, localStorage draft persistence, and layout IO. */
(function (global) {
  "use strict";

  const PT = (global.PlateTidy = global.PlateTidy || {});

  PT.GEOMETRIES = {
    6: [2, 3],
    12: [3, 4],
    24: [4, 6],
    48: [6, 8],
    96: [8, 12],
    384: [16, 24],
  };

  // Curated 10-hue colorblind-distinct mineral/botanical palette [R, G, B]
  PT.SAMPLE_PALETTE = [
    { hex: "#b84a27", rgb: [184, 74, 39] },  // Terracotta
    { hex: "#28536b", rgb: [40, 83, 107] },  // Petrol slate
    { hex: "#3d7054", rgb: [61, 112, 84] },  // Botanical green
    { hex: "#7a4970", rgb: [122, 73, 112] }, // Plum
    { hex: "#9c6f22", rgb: [156, 111, 34] }, // Ochre
    { hex: "#446491", rgb: [68, 100, 145] }, // Ultramarine
    { hex: "#a33c53", rgb: [163, 60, 83] },  // Crimson berry
    { hex: "#2d7873", rgb: [45, 120, 115] }, // Deep verdigris
    { hex: "#6b6e2e", rgb: [107, 110, 46] }, // Moss olive
    { hex: "#634b85", rgb: [99, 75, 133] },  // Iris slate
  ];

  PT.UNIT_TO_UM = { M: 1e6, MM: 1e3, UM: 1.0, NM: 1e-3, PM: 1e-6 };

  PT.normMolarUnit = function (u) {
    // '\u00b5'.toUpperCase() becomes '\u039c' (Greek Capital Mu) in JS; normalize all micro variants to 'U'
    return String(u || "")
      .trim()
      .replace(/[\u00b5\u03bc\u039c]/g, "U")
      .toUpperCase();
  };

  const STORAGE_KEY = "plate_tidy_draft_v3";
  const MAX_UNDO = 30;

  PT.state = {
    plate_id: "Untitled_Plate",
    plate_format: 96,
    assay_type: "viability",
    well_volume_ul: 100,
    housekeeping_target: "GAPDH",
    wells: {},
    customReagents: null, // null = auto from assay_type, else [{ name, per_well_ul }]
    compoundStocks: {},
    serialSeries: [{ sample: "", treatment: "", top: 10, unit: "µM" }],
    selected: new Set(),
    undoStack: [],
    readBlocks: [],
    activeBlockIdx: 0,
    heatmapMetric: "raw",
    lastSvgMarkup: "",
  };

  PT.rowIdxToLabel = function (idx) {
    let label = "";
    let n = idx;
    while (true) {
      const rem = n % 26;
      n = Math.floor(n / 26);
      label = String.fromCharCode(65 + rem) + label;
      if (n === 0) break;
      n -= 1;
    }
    return label;
  };

  PT.rowLabelToIdx = function (lbl) {
    const s = lbl.trim().toUpperCase();
    let idx = 0;
    for (let i = 0; i < s.length; i++) {
      idx = idx * 26 + (s.charCodeAt(i) - 64);
    }
    return idx - 1;
  };

  PT.normalizeWellId = function (raw) {
    const m = /^\s*([A-Za-z]{1,2})\s*0*([1-9][0-9]*)\s*$/.exec(raw || "");
    if (!m) return null;
    return m[1].toUpperCase() + String(parseInt(m[2], 10));
  };

  PT.splitWell = function (wid) {
    const m = /^([A-Z]+)([0-9]+)$/.exec(wid);
    const r0 = PT.rowLabelToIdx(m[1]);
    const c1 = parseInt(m[2], 10);
    return { rowLbl: m[1], col1: c1, r0: r0, c0: c1 - 1 };
  };

  PT.getWell = function (wid) {
    return (
      PT.state.wells[wid] || {
        well: wid,
        role: "empty",
        sample: "",
        treatment: "",
        concentration: null,
        unit: "",
        bio_rep: "",
      }
    );
  };

  PT.esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  PT.fmtNum = function (v, sigFigs) {
    if (v == null || Number.isNaN(v)) return "";
    return Number(Number(v).toPrecision(sigFigs || 4)).toString();
  };

  PT.fmtUnit = function (u) {
    return String(u || "").replace(/^uM$/i, "µM").replace(/^uL$/i, "µL");
  };

  // Undo & Persistence
  PT.pushUndo = function () {
    const snap = JSON.stringify({
      plate_format: PT.state.plate_format,
      wells: PT.state.wells,
    });
    const stack = PT.state.undoStack;
    if (stack.length && stack[stack.length - 1] === snap) return;
    stack.push(snap);
    if (stack.length > MAX_UNDO) stack.shift();
  };

  PT.popUndo = function () {
    if (!PT.state.undoStack.length) return false;
    const prev = JSON.parse(PT.state.undoStack.pop());
    PT.state.plate_format = prev.plate_format;
    PT.state.wells = prev.wells;
    PT.saveDraft();
    return true;
  };

  PT.saveDraft = function () {
    try {
      const payload = {
        plate_id: PT.state.plate_id,
        plate_format: PT.state.plate_format,
        assay_type: PT.state.assay_type,
        well_volume_ul: PT.state.well_volume_ul,
        housekeeping_target: PT.state.housekeeping_target,
        customReagents: PT.state.customReagents,
        wells: PT.state.wells,
      };
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {
      // Ignore storage quota / private-mode errors
    }
  };

  PT.loadDraft = function () {
    try {
      global.localStorage.removeItem("plate_tidy_draft_v2");
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d || !PT.GEOMETRIES[d.plate_format]) return false;
      PT.state.plate_id = d.plate_id || "Untitled_Plate";
      PT.state.plate_format = Number(d.plate_format);
      PT.state.assay_type = d.assay_type || "viability";
      PT.state.well_volume_ul = Number(d.well_volume_ul || 100);
      PT.state.housekeeping_target = d.housekeeping_target || "GAPDH";
      PT.state.customReagents = Array.isArray(d.customReagents) ? d.customReagents : null;
      PT.state.wells = d.wells || {};
      return Object.keys(PT.state.wells).length > 0;
    } catch (_) {
      return false;
    }
  };

  // Series color map + log-dose tinting (distinguishes both cell lines and compounds)
  PT.buildSampleColorMap = function () {
    const [nRows, nCols] = PT.GEOMETRIES[PT.state.plate_format];
    const activeTreatments = new Set();
    Object.values(PT.state.wells).forEach((w) => {
      if ((w.role === "sample" || w.role === "standard") && w.treatment) {
        activeTreatments.add(w.treatment);
      }
    });
    const multiCompound = activeTreatments.size > 1;

    function keyForWell(w) {
      if (!w || w.role === "empty" || w.role === "moat" || w.role === "blank" || w.role === "pos_ctrl") return "";
      if (w.role === "neg_ctrl") {
        return !multiCompound && w.sample ? w.sample : "";
      }
      if (multiCompound && w.sample && w.treatment) {
        return `${w.sample} · ${w.treatment}`;
      }
      return w.sample || w.treatment || "";
    }

    const names = [];
    const seen = new Set();
    for (let r = 0; r < nRows; r++) {
      const rl = PT.rowIdxToLabel(r);
      for (let c = 1; c <= nCols; c++) {
        const w = PT.state.wells[`${rl}${c}`];
        const key = keyForWell(w);
        if (key && !seen.has(key)) {
          seen.add(key);
          names.push(key);
        }
      }
    }
    const map = {};
    names.forEach((nm, idx) => {
      map[nm] = PT.SAMPLE_PALETTE[idx % PT.SAMPLE_PALETTE.length];
    });
    return { names, map, keyForWell };
  };

  PT.buildDoseRanges = function () {
    const ranges = {};
    Object.values(PT.state.wells).forEach((w) => {
      if (w.role !== "sample" || w.concentration == null || w.concentration <= 0) return;
      const key = `${w.sample || ""}|${w.treatment || "_default"}`;
      const lv = Math.log10(w.concentration);
      if (!ranges[key]) ranges[key] = { min: lv, max: lv };
      else {
        if (lv < ranges[key].min) ranges[key].min = lv;
        if (lv > ranges[key].max) ranges[key].max = lv;
      }
    });
    return ranges;
  };

  PT.tintRgb = function (rgb, alpha) {
    // Blend over warm off-white (#faf9f5) so text contrast is predictable
    const bg = [250, 249, 245];
    const r = Math.round(bg[0] + alpha * (rgb[0] - bg[0]));
    const g = Math.round(bg[1] + alpha * (rgb[1] - bg[1]));
    const b = Math.round(bg[2] + alpha * (rgb[2] - bg[2]));
    return `rgb(${r},${g},${b})`;
  };

  // Layout Audit (concise, non-robotic guidance)
  PT.auditLayout = function () {
    const [nRows, nCols] = PT.GEOMETRIES[PT.state.plate_format];
    const active = Object.values(PT.state.wells).filter((w) =>
      ["sample", "neg_ctrl", "pos_ctrl", "blank", "standard"].includes(w.role)
    );
    if (!active.length) return [];

    const notes = [];
    if (PT.state.plate_format === 96 || PT.state.plate_format === 384) {
      const edge = active.filter((w) => {
        const { r0, c0 } = PT.splitWell(w.well);
        return r0 === 0 || r0 === nRows - 1 || c0 === 0 || c0 === nCols - 1;
      });
      if (edge.length > 0) {
        const pct = Math.round((100 * edge.length) / active.length);
        notes.push(
          `${edge.length} assay wells (${pct}%) sit on the outer edge (${edge
            .slice(0, 4)
            .map((x) => x.well)
            .join(", ")}). For ≥24 h incubations, edge evaporation can skew viability — use "Edge Moat (PBS)" if outer wells are spare.`
        );
      }
    }

    const roles = new Set(active.map((w) => w.role));
    const hasZeroSample = active.some((w) => w.role === "sample" && w.concentration === 0);
    if ((PT.state.assay_type === "viability" || PT.state.assay_type === "elisa") && !roles.has("neg_ctrl") && !hasZeroSample) {
      notes.push("No Vehicle / Negative control wells marked yet — needed to normalize % of control.");
    }

    const counts = {};
    active
      .filter((w) => w.role === "sample")
      .forEach((w) => {
        const k = `${w.sample}|${w.treatment}|${w.concentration}|${w.unit}|${w.bio_rep}`;
        counts[k] = (counts[k] || 0) + 1;
      });
    const singletons = Object.values(counts).filter((n) => n === 1).length;
    if (singletons > 0) {
      notes.push(`${singletons} condition(s) have n = 1 well; triplicates (n ≥ 3) help catch pipetting outliers.`);
    }
    return notes;
  };

  // Layout Import (.plate.json OR .csv)
  PT.importLayoutText = function (filename, text) {
    PT.pushUndo();
    if (filename.toLowerCase().endsWith(".csv")) {
      const grid = PT.parseDelimitedText(text);
      if (grid.length < 2) throw new Error("CSV layout appears empty.");
      const hdr = grid[0].map((h) => h.trim().toLowerCase());
      const colIdx = (names) => hdr.findIndex((h) => names.includes(h));
      const iWell = colIdx(["well", "well_id", "well position"]);
      if (iWell < 0) throw new Error("CSV layout needs a 'well' column.");
      const iRole = colIdx(["role", "type"]);
      const iSmp = colIdx(["sample", "cell_line", "cell line"]);
      const iTrt = colIdx(["treatment", "compound", "target"]);
      const iConc = colIdx(["concentration", "conc", "dose"]);
      const iUnit = colIdx(["unit", "units"]);
      const iRep = colIdx(["bio_rep", "biorep", "replicate"]);

      const wells = {};
      let maxR = 0, maxC = 0;
      for (let r = 1; r < grid.length; r++) {
        const row = grid[r];
        const wid = PT.normalizeWellId(row[iWell] || "");
        if (!wid) continue;
        const { r0, col1 } = PT.splitWell(wid);
        if (r0 + 1 > maxR) maxR = r0 + 1;
        if (col1 > maxC) maxC = col1;
        const cStr = iConc >= 0 ? (row[iConc] || "").trim() : "";
        wells[wid] = {
          well: wid,
          role: (iRole >= 0 && row[iRole] ? row[iRole].trim().toLowerCase() : "sample"),
          sample: iSmp >= 0 ? (row[iSmp] || "").trim() : "",
          treatment: iTrt >= 0 ? (row[iTrt] || "").trim() : "",
          concentration: cStr !== "" && Number.isFinite(Number(cStr)) ? Number(cStr) : null,
          unit: iUnit >= 0 ? (row[iUnit] || "").trim() : "",
          bio_rep: iRep >= 0 ? (row[iRep] || "").trim() : "",
        };
      }
      let fmt = 96;
      for (const cand of [6, 12, 24, 48, 96, 384]) {
        const [nr, nc] = PT.GEOMETRIES[cand];
        if (maxR <= nr && maxC <= nc && cand >= 96) {
          fmt = cand;
          break;
        }
      }
      PT.state.plate_id = filename.replace(/\.csv$/i, "");
      PT.state.plate_format = fmt;
      PT.state.wells = wells;
    } else {
      const data = JSON.parse(text);
      PT.state.plate_id = data.plate_id || "Untitled_Plate";
      PT.state.plate_format = Number(data.plate_format || 96);
      PT.state.assay_type = data.assay_type || "viability";
      PT.state.well_volume_ul = Number(data.well_volume_ul || 100);
      PT.state.housekeeping_target = data.housekeeping_target || "GAPDH";
      PT.state.wells = {};
      (data.wells || []).forEach((w) => {
        const wid = PT.normalizeWellId(w.well);
        if (wid && w.role !== "empty") {
          PT.state.wells[wid] = Object.assign({}, w, { well: wid });
        }
      });
    }
    PT.state.selected.clear();
    PT.saveDraft();
  };
})(window);
