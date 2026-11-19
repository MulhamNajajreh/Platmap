/* Bench calculators, 4PL curve fitting, Zhang Z'-factor QC, qPCR ddCt, and CSV/Prism exporters. */
(function (global) {
  "use strict";

  const PT = (global.PlateTidy = global.PlateTidy || {});

  PT.meanSd = function (arr) {
    if (!arr.length) return [0, 0];
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    if (arr.length < 2) return [m, 0];
    const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
    return [m, Math.sqrt(v)];
  };

  PT.defaultReagents = function (spikeFactor) {
    const v = PT.state.well_volume_ul || 100;
    if (PT.state.assay_type === "qpcr") {
      return [
        { name: "2× qPCR SYBR Master Mix", per_well_ul: Number((0.5 * v).toFixed(2)) },
        { name: "Fwd + Rev Primer Mix (10 µM)", per_well_ul: Number((0.08 * v).toFixed(2)) },
        { name: "Nuclease-Free H₂O", per_well_ul: Number((0.22 * v).toFixed(2)) },
        { name: "cDNA Template (per well)", per_well_ul: Number((0.2 * v).toFixed(2)) },
      ];
    }
    const sf = spikeFactor || 1;
    const baseV = sf > 1 ? v * (1 - 1 / sf) : v;
    return [{ name: "Cell Suspension / Assay Media", per_well_ul: Number(baseV.toFixed(2)) }];
  };

  PT.getEffectiveReagents = function (spikeFactor) {
    return PT.state.customReagents && PT.state.customReagents.length
      ? PT.state.customReagents
      : PT.defaultReagents(spikeFactor);
  };

  PT.computeMasterMixes = function (overagePct, spikeFactor) {
    const active = Object.values(PT.state.wells).filter((w) =>
      ["sample", "neg_ctrl", "pos_ctrl", "blank", "standard"].includes(w.role)
    );
    if (!active.length) return [];

    const reagents = PT.getEffectiveReagents(spikeFactor);
    const perWellSum = reagents.reduce((s, r) => s + (Number(r.per_well_ul) || 0), 0);

    const buckets = {};
    active.forEach((w) => {
      let key;
      if (w.role === "blank") {
        key = "Cell-Free Blank / Media";
      } else if (PT.state.assay_type === "qpcr") {
        key = w.treatment || "Target Master Mix";
      } else {
        key = w.sample || "Assay Wells";
      }
      (buckets[key] = buckets[key] || []).push(w.well);
    });

    return Object.keys(buckets)
      .sort()
      .map((name) => {
        const n = buckets[name].length;
        let effWells = n * (1 + overagePct / 100);
        if (perWellSum > 0 && (effWells - n) * perWellSum < 20) {
          effWells = (n * perWellSum + 20) / perWellSum;
        }
        const comps = reagents.map((c) => ({
          name: c.name,
          per_well_ul: c.per_well_ul,
          total_ul: Number((c.per_well_ul * effWells).toFixed(1)),
        }));
        const totalUl = comps.reduce((s, c) => s + c.total_ul, 0);
        return { name, wellCount: n, effWells, totalUl, components: comps };
      });
  };

  PT.computeSerialDilutions = function (opts) {
    const { stockConc, stockUnit, spikeFactor, overagePct, deadUl, vehicle } = opts;
    const active = Object.values(PT.state.wells).filter((w) =>
      ["sample", "pos_ctrl", "standard"].includes(w.role)
    );

    const byTreat = {};
    active.forEach((w) => {
      if (!w.treatment || w.concentration == null || w.concentration <= 0) return;
      const u = PT.fmtUnit(w.unit || "µM");
      const k = `${w.treatment}|||${u}`;
      byTreat[k] = byTreat[k] || {};
      const d = Number(Number(w.concentration).toPrecision(9));
      byTreat[k][d] = (byTreat[k][d] || 0) + 1;
    });

    const doseAddUl = (PT.state.well_volume_ul || 100) / Math.max(spikeFactor, 1);
    const plans = [];

    Object.keys(byTreat)
      .sort()
      .forEach((k) => {
        const [treat, unit] = k.split("|||");
        const counts = byTreat[k];
        const doses = Object.keys(counts)
          .map(Number)
          .sort((a, b) => b - a);
        if (doses.length < 2) return;

        const ovr = (PT.state.compoundStocks && PT.state.compoundStocks[treat]) || null;
        const cStockConc = ovr && ovr.conc > 0 ? Number(ovr.conc) : stockConc;
        const cStockUnit = (ovr && ovr.unit) || stockUnit;

        let stockInUnit = cStockConc;
        const fu = PT.normMolarUnit(cStockUnit), tu = PT.normMolarUnit(unit);
        if (PT.UNIT_TO_UM[fu] && PT.UNIT_TO_UM[tu]) {
          stockInUnit = (cStockConc * PT.UNIT_TO_UM[fu]) / PT.UNIT_TO_UM[tu];
        }

        const topWorking = doses[0] * spikeFactor;
        if (stockInUnit <= topWorking) {
          plans.push({
            treatment: treat,
            unit,
            stockConc: cStockConc,
            stockUnit: cStockUnit,
            error: `Master stock (${cStockConc} ${cStockUnit}) must exceed top working tube (${PT.fmtNum(topWorking, 4)} ${unit}).`,
            notes: [],
            steps: [],
          });
          return;
        }

        const len = doses.length;
        const transferNext = new Array(len).fill(0);
        const totalPrep = new Array(len).fill(0);

        for (let i = len - 1; i >= 0; i--) {
          const dispenseNeed = counts[doses[i]] * doseAddUl * (1 + overagePct / 100) + deadUl;
          totalPrep[i] = dispenseNeed + transferNext[i];
          if (i > 0) {
            transferNext[i - 1] = totalPrep[i] * ((doses[i] * spikeFactor) / (doses[i - 1] * spikeFactor));
          }
        }

        const notes = [];
        let effStockConc = stockInUnit;
        let effStockLbl = `Stock (${cStockConc} ${cStockUnit})`;
        const rawTube1Ul = totalPrep[0] * (topWorking / effStockConc);

        if (rawTube1Ul < 1.5) {
          const preF = rawTube1Ul * 10 >= 1.5 ? 10 : rawTube1Ul * 100 >= 1.5 ? 100 : 1000;
          const interC = stockInUnit / preF;
          if (interC > topWorking * 1.2) {
            effStockConc = interC;
            effStockLbl = `1:${preF} working stock (${PT.fmtNum(interC, 4)} ${unit})`;
            const preVol = preF === 10 ? 50 : 200;
            const sUl = Math.max(2, preVol / preF);
            const totPre = sUl * preF;
            notes.push(
              `Direct spike would require ${rawTube1Ul.toFixed(2)} µL (<1.5 µL). First prepare ${effStockLbl}: ${sUl.toFixed(1)} µL Master Stock + ${(totPre - sUl).toFixed(1)} µL diluent.`
            );
          }
        }

        const finalVehPct = 100 * (doses[0] / stockInUnit);
        if (finalVehPct >= 0.005) {
          const tubeVehPct = finalVehPct * spikeFactor;
          notes.push(
            `Top dose delivers ${PT.fmtNum(finalVehPct, 3)}% ${vehicle} in-well. Use diluent containing ${PT.fmtNum(tubeVehPct, 3)}% ${vehicle} for Tubes 2–${len} so vehicle remains constant.`
          );
        }
        if (finalVehPct > 0.5) {
          notes.push(`Caution: final in-well ${vehicle} at top dose is ${finalVehPct.toFixed(2)}% (>0.5% can reduce cell viability).`);
        }

        const steps = doses.map((d, i) => {
          const wConc = d * spikeFactor;
          const vIn = i === 0 ? totalPrep[0] * (wConc / effStockConc) : totalPrep[i] * (wConc / (doses[i - 1] * spikeFactor));
          const src = i === 0 ? effStockLbl : `Tube ${i}`;
          return {
            tube: `Tube ${i + 1}`,
            wellConc: d,
            tubeConc: wConc,
            wells: counts[d],
            dispenseUl: doseAddUl,
            totalUl: totalPrep[i],
            transferUl: vIn,
            source: src,
            diluentUl: totalPrep[i] - vIn,
          };
        });

        plans.push({ treatment: treat, unit, stockConc: cStockConc, stockUnit: cStockUnit, error: null, notes, steps });
      });

    return plans;
  };

  PT.eval4PL = function (x, bottom, top, logIc50, hill) {
    if (x <= 0) return hill > 0 ? top : bottom;
    const exp = Math.max(-50, Math.min(50, hill * (Math.log10(x) - logIc50)));
    return bottom + (top - bottom) / (1 + Math.pow(10, exp));
  };

  PT.fit4PL = function (label, sample, treatment, unit, doseMap) {
    const doses = Object.keys(doseMap)
      .map(Number)
      .filter((d) => d > 0 && doseMap[d].length > 0)
      .sort((a, b) => a - b);
    if (doses.length < 4) return null;

    const xs = [], ys = [], means = [], sds = [];
    doses.forEach((d) => {
      doseMap[d].forEach((v) => {
        xs.push(d);
        ys.push(v);
      });
      const [m, s] = PT.meanSd(doseMap[d]);
      means.push(m);
      sds.push(s);
    });

    const yMin = Math.min(...means), yMax = Math.max(...means);
    if (Math.abs(yMax - yMin) < 1e-6) return null;
    const logMin = Math.log10(doses[0]), logMax = Math.log10(doses[doses.length - 1]);
    const midLog = 0.5 * (logMin + logMax);
    const dir = means[0] >= means[means.length - 1] ? 1 : -1;
    const span = Math.max(Math.abs(yMax - yMin), 20);

    function sse(p) {
      const [b, t, lic, h] = p;
      let pen = 0;
      if (b < yMin - 0.5 * span || b > yMax + 0.2 * span) pen += 1e6 * Math.pow(b - yMin, 2);
      if (t > yMax + 0.5 * span || t < yMin - 0.2 * span) pen += 1e6 * Math.pow(t - yMax, 2);
      if (Math.abs(h) < 0.2 || Math.abs(h) > 6.0) pen += 1e5 * Math.pow(Math.abs(h) - 3, 2);
      if (lic < logMin - 2 || lic > logMax + 2) pen += 1e5 * Math.pow(lic - midLog, 2);
      let err = 0;
      for (let i = 0; i < xs.length; i++) {
        const diff = ys[i] - PT.eval4PL(xs[i], b, t, lic, h);
        err += diff * diff;
      }
      return err + pen;
    }

    let bestP = [yMin, yMax, midLog, dir];
    let bestLoss = sse(bestP);
    [0.15, 0.32, 0.5, 0.68, 0.85].forEach((f) => {
      const lic = logMin + f * (logMax - logMin);
      [0.6, 1.0, 1.5, 2.5].forEach((hm) => {
        [dir, -dir].forEach((sg) => {
          const cand = [yMin, yMax, lic, hm * sg];
          const l = sse(cand);
          if (l < bestLoss) {
            bestLoss = l;
            bestP = cand;
          }
        });
      });
    });

    const stepY = Math.max(2, 0.08 * Math.abs(yMax - yMin));
    const steps = [stepY, stepY, 0.25, 0.25];
    const simplex = [{ f: bestLoss, v: bestP.slice() }];
    for (let j = 0; j < 4; j++) {
      const pt = bestP.slice();
      pt[j] += steps[j];
      simplex.push({ f: sse(pt), v: pt });
    }

    for (let iter = 0; iter < 240; iter++) {
      simplex.sort((a, b) => a.f - b.f);
      const fBest = simplex[0].f, fSecond = simplex[3].f, fWorst = simplex[4].f;
      if (Math.abs(fWorst - fBest) < 1e-7) break;
      const cent = [0, 1, 2, 3].map((j) => (simplex[0].v[j] + simplex[1].v[j] + simplex[2].v[j] + simplex[3].v[j]) / 4);
      const worstV = simplex[4].v;
      const refl = cent.map((c, j) => c + (c - worstV[j]));
      const fRef = sse(refl);

      if (fBest <= fRef && fRef < fSecond) {
        simplex[4] = { f: fRef, v: refl };
      } else if (fRef < fBest) {
        const exp = cent.map((c, j) => c + 2 * (refl[j] - c));
        const fExp = sse(exp);
        simplex[4] = fExp < fRef ? { f: fExp, v: exp } : { f: fRef, v: refl };
      } else {
        const cont = cent.map((c, j) => c + 0.5 * (worstV[j] - c));
        const fCon = sse(cont);
        if (fCon < fWorst) {
          simplex[4] = { f: fCon, v: cont };
        } else {
          const base = simplex[0].v;
          for (let i = 1; i < 5; i++) {
            const sh = base.map((b, j) => b + 0.5 * (simplex[i].v[j] - b));
            simplex[i] = { f: sse(sh), v: sh };
          }
        }
      }
    }

    simplex.sort((a, b) => a.f - b.f);
    let [bottom, top, logIc50, hill] = simplex[0].v;
    if (bottom > top) {
      const tmp = bottom;
      bottom = top;
      top = tmp;
      hill = -hill;
    }
    const ic50 = Math.pow(10, logIc50);
    const [yMean] = PT.meanSd(ys);
    const ssTot = ys.reduce((s, y) => s + Math.pow(y - yMean, 2), 0);
    const ssRes = ys.reduce((s, y, i) => s + Math.pow(y - PT.eval4PL(xs[i], bottom, top, logIc50, hill), 2), 0);
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

    let absIc50 = null;
    if (bottom < 50 && top > 50 && Math.abs(hill) > 1e-4) {
      const ratio = (top - 50) / (50 - bottom);
      if (ratio > 0) absIc50 = Math.pow(10, logIc50 + Math.log10(ratio) / hill);
    }

    return { label, sample, treatment, unit: PT.fmtUnit(unit), bottom, top, ic50, absIc50, hill, r2, doses, means, sds };
  };

  PT.analyzeActiveBlock = function () {
    if (!PT.state.readBlocks.length) return null;
    const block = PT.state.readBlocks[PT.state.activeBlockIdx] || PT.state.readBlocks[0];
    const [nRows, nCols] = PT.GEOMETRIES[PT.state.plate_format];

    const blankVals = [], posAll = [];
    let negAll = [], negBySample = {};
    const zeroAll = [], zeroBySample = {};

    const orderedWids = [];
    for (let r = 0; r < nRows; r++) {
      const rlbl = PT.rowIdxToLabel(r);
      for (let c = 1; c <= nCols; c++) orderedWids.push(`${rlbl}${c}`);
    }

    orderedWids.forEach((wid) => {
      const w = PT.getWell(wid);
      const m = block.measurements[wid];
      if (!m || m.value == null) return;
      if (w.role === "blank") blankVals.push(m.value);
      else if (w.role === "neg_ctrl") {
        negAll.push(m.value);
        if (w.sample) (negBySample[w.sample] = negBySample[w.sample] || []).push(m.value);
      } else if (w.role === "pos_ctrl") posAll.push(m.value);
      else if (w.role === "sample" && w.concentration === 0) {
        zeroAll.push(m.value);
        if (w.sample) (zeroBySample[w.sample] = zeroBySample[w.sample] || []).push(m.value);
      }
    });

    const qcNotes = [];
    if (!negAll.length && zeroAll.length) {
      negAll = zeroAll;
      negBySample = zeroBySample;
      qcNotes.push("Normalized to 0-dose sample wells as the 100% baseline.");
    }

    const [blankMean, blankSd] = PT.meanSd(blankVals);
    const [negMean, negSd] = PT.meanSd(negAll);
    const lowRef = posAll.length >= 2 ? posAll : blankVals;
    const [lowMean, lowSd] = PT.meanSd(lowRef);

    let zPrime = null;
    if (negAll.length >= 2 && lowRef.length >= 2 && Math.abs(negMean - lowMean) > 1e-9) {
      zPrime = 1 - (3 * (negSd + lowSd)) / Math.abs(negMean - lowMean);
    }
    const negCv = negAll.length >= 2 && Math.abs(negMean) > 1e-9 ? (100 * negSd) / Math.abs(negMean) : null;
    const sb = blankVals.length && Math.abs(blankMean) > 1e-9 && negAll.length ? negMean / blankMean : null;

    if (negCv != null && negCv > 15) qcNotes.push(`Vehicle control CV is ${negCv.toFixed(1)}% (>15%); check pipetting or edge wells.`);
    if (zPrime != null && zPrime < 0.5) qcNotes.push(`Assay window Z' = ${zPrime.toFixed(2)} (<0.5).`);

    const globalNegNet = negAll.length ? negMean - blankMean : null;
    const sampleNegNet = {};
    Object.keys(negBySample).forEach((s) => {
      sampleNegNet[s] = PT.meanSd(negBySample[s])[0] - blankMean;
    });

    const techCounter = {};
    const rows = [];
    orderedWids.forEach((wid) => {
      const w = PT.getWell(wid);
      const m = block.measurements[wid];
      if (w.role === "empty" && (!m || m.value == null)) return;
      const effSample = w.sample || (m && m.extra && m.extra.instrument_sample) || "";
      const effTreat = w.treatment || (m && m.extra && m.extra.instrument_target) || "";
      const condKey = `${w.role}|${effSample}|${effTreat}|${w.concentration}|${w.unit}|${w.bio_rep}`;
      const techRep = ["sample", "neg_ctrl", "pos_ctrl", "blank", "standard"].includes(w.role)
        ? (techCounter[condKey] = (techCounter[condKey] || 0) + 1)
        : 0;

      const raw = m ? m.value : null;
      const status = m ? m.status : "MISSING";
      let bgSub = null, pctCtrl = null;
      if (raw != null && PT.state.assay_type !== "qpcr") {
        bgSub = raw - blankMean;
        const ref = sampleNegNet[effSample] != null ? sampleNegNet[effSample] : globalNegNet;
        if (ref != null && Math.abs(ref) > 1e-9) pctCtrl = (100 * bgSub) / ref;
      }
      const { rowLbl, col1 } = PT.splitWell(wid);
      rows.push({
        plate_id: PT.state.plate_id,
        block_id: block.block_id,
        well: wid,
        row: rowLbl,
        col: col1,
        role: w.role,
        sample: effSample,
        treatment: effTreat,
        concentration: w.concentration,
        unit: PT.fmtUnit(w.unit),
        bio_rep: w.bio_rep,
        tech_rep: techRep,
        raw_value: raw,
        status,
        bg_subtracted: bgSub,
        pct_control: pctCtrl,
        delta_ct: null,
        dd_ct: null,
        fold_change: null,
      });
    });

    if (PT.state.assay_type === "qpcr") {
      const hk = (PT.state.housekeeping_target || "GAPDH").trim().toUpperCase();
      const hkMap = {};
      rows.forEach((r) => {
        if (r.raw_value != null && r.treatment.toUpperCase() === hk && r.role !== "blank") {
          (hkMap[r.sample] = hkMap[r.sample] || []).push(r.raw_value);
        }
      });
      rows.forEach((r) => {
        if (r.raw_value != null && hkMap[r.sample] && r.role !== "blank") {
          r.delta_ct = r.raw_value - PT.meanSd(hkMap[r.sample])[0];
        }
      });
      const targets = [...new Set(rows.filter((r) => r.delta_ct != null && r.treatment.toUpperCase() !== hk).map((r) => r.treatment))];
      targets.forEach((tgt) => {
        const tRows = rows.filter((r) => r.treatment === tgt && r.delta_ct != null);
        let refRows = tRows.filter((r) => r.role === "neg_ctrl" || /WT|CTRL|CONTROL|VEH|DMSO/i.test(r.sample));
        if (!refRows.length && tRows.length) {
          const s0 = tRows[0].sample;
          refRows = tRows.filter((r) => r.sample === s0);
        }
        if (refRows.length) {
          const cal = PT.meanSd(refRows.map((r) => r.delta_ct))[0];
          tRows.forEach((r) => {
            r.dd_ct = r.delta_ct - cal;
            r.fold_change = Math.pow(2, -r.dd_ct);
          });
        }
      });
    }

    const curves = [];
    if (PT.state.assay_type !== "qpcr") {
      const grouped = {};
      rows.forEach((r) => {
        if (!["sample", "standard"].includes(r.role) || r.concentration == null || r.concentration <= 0) return;
        const y = r.pct_control != null ? r.pct_control : r.bg_subtracted;
        if (y == null) return;
        const k = `${r.sample}|||${r.treatment}|||${r.unit || "µM"}`;
        grouped[k] = grouped[k] || {};
        (grouped[k][r.concentration] = grouped[k][r.concentration] || []).push(y);
      });
      Object.keys(grouped)
        .sort()
        .forEach((k) => {
          const [smp, trt, unt] = k.split("|||");
          const lbl = smp && trt ? `${smp} + ${trt}` : trt || smp || "Series";
          const fit = PT.fit4PL(lbl, smp, trt, unt, grouped[k]);
          if (fit) curves.push(fit);
        });
    }

    return {
      block_id: block.block_id,
      rows,
      qc: { blankMean, blankSd, blankN: blankVals.length, negMean, negCv, negN: negAll.length, sb, zPrime, notes: qcNotes },
      curves,
    };
  };

  PT.buildTidyCsv = function (res) {
    const cols = ["plate_id", "block_id", "well", "row", "col", "role", "sample", "treatment", "concentration", "unit", "bio_rep", "tech_rep", "raw_value", "status", "bg_subtracted", "pct_control", "delta_ct", "dd_ct", "fold_change"];
    const lines = [cols.join(",")];
    res.rows.forEach((r) => {
      lines.push(
        cols
          .map((k) => {
            const v = r[k];
            if (v == null || v === "") return "";
            const s = typeof v === "number" ? Number(v.toFixed(6)).toString() : String(v);
            return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(",")
      );
    });
    return lines.join("\n") + "\n";
  };

  PT.buildPrismTsv = function (res) {
    const series = {};
    const allDoses = new Set();
    res.rows.forEach((r) => {
      if (!["sample", "standard"].includes(r.role) || r.concentration == null) return;
      const y = r.pct_control != null ? r.pct_control : r.bg_subtracted != null ? r.bg_subtracted : r.raw_value;
      if (y == null) return;
      const k = `${r.sample} + ${r.treatment}`.replace(/^\s*\+\s*|\s*\+\s*$/g, "") || "Group";
      series[k] = series[k] || {};
      (series[k][r.concentration] = series[k][r.concentration] || []).push(Number(y.toFixed(3)));
      allDoses.add(r.concentration);
    });

    const sNames = Object.keys(series).sort();
    if (!sNames.length) {
      // Categorical / qPCR fallback table
      const cat = {};
      res.rows.forEach((r) => {
        if (["blank", "moat", "empty"].includes(r.role)) return;
        const y = r.fold_change != null ? r.fold_change : r.pct_control != null ? r.pct_control : r.raw_value;
        if (y == null) return;
        const lbl = `${r.sample} | ${r.treatment}`.replace(/^\s*\|\s*|\s*\|\s*$/g, "") || r.role;
        (cat[lbl] = cat[lbl] || []).push(Number(y.toFixed(4)));
      });
      const cKeys = Object.keys(cat).sort();
      const maxN = Math.max(1, ...cKeys.map((k) => cat[k].length));
      const hdr = ["Condition"];
      for (let i = 1; i <= maxN; i++) hdr.push(`Rep_${i}`);
      const out = [hdr.join("\t")];
      cKeys.forEach((k) => {
        const row = [k];
        for (let i = 0; i < maxN; i++) row.push(cat[k][i] != null ? cat[k][i] : "");
        out.push(row.join("\t"));
      });
      return out.join("\n") + "\n";
    }

    const maxReps = {};
    sNames.forEach((s) => {
      maxReps[s] = Math.max(...Object.values(series[s]).map((a) => a.length));
    });
    const hdr = ["Concentration", "Log10_Conc"];
    sNames.forEach((s) => {
      for (let i = 1; i <= maxReps[s]; i++) hdr.push(`${s}_Rep${i}`);
    });
    const lines = [hdr.join("\t")];
    [...allDoses]
      .sort((a, b) => a - b)
      .forEach((d) => {
        const row = [d, d > 0 ? Math.log10(d).toFixed(4) : ""];
        sNames.forEach((s) => {
          const arr = series[s][d] || [];
          for (let i = 0; i < maxReps[s]; i++) row.push(arr[i] != null ? arr[i] : "");
        });
        lines.push(row.join("\t"));
      });
    return lines.join("\n") + "\n";
  };
})(window);
