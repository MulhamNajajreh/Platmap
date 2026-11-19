/* UI controller: plate grid interaction, multi-series dilution builder, protocol sheet, and exports. */
(function (global) {
  "use strict";

  const PT = global.PlateTidy;
  let dragState = null;

  function syncTopControls() {
    document.getElementById("inp-plate-id").value = PT.state.plate_id;
    document.getElementById("sel-format").value = String(PT.state.plate_format);
    document.getElementById("sel-assay").value = PT.state.assay_type;
    document.getElementById("inp-well-vol").value = String(PT.state.well_volume_ul);
    document.getElementById("inp-hk").value = PT.state.housekeeping_target;
    document.getElementById("hk-field-wrap").style.display = PT.state.assay_type === "qpcr" ? "inline-flex" : "none";
    document.getElementById("lbl-assign-treat").textContent = PT.state.assay_type === "qpcr" ? "Target gene" : "Compound / Treatment";
    document.getElementById("row-assign-dose").style.display = PT.state.assay_type === "qpcr" ? "none" : "grid";
  }

  function formatSelectionRange() {
    const size = PT.state.selected.size;
    if (!size) return "No wells selected — drag on the plate first";
    const coords = [...PT.state.selected].map(PT.splitWell);
    const rMin = Math.min(...coords.map((x) => x.r0)), rMax = Math.max(...coords.map((x) => x.r0));
    const cMin = Math.min(...coords.map((x) => x.c0)), cMax = Math.max(...coords.map((x) => x.c0));
    const rectSize = (rMax - rMin + 1) * (cMax - cMin + 1);
    if (size === 1) return `Selected: ${[...PT.state.selected][0]}`;
    if (size === rectSize) {
      return `Selected: ${PT.rowIdxToLabel(rMin)}${cMin + 1}–${PT.rowIdxToLabel(rMax)}${cMax + 1} (${size} wells)`;
    }
    return `Selected: ${size} wells`;
  }

  function populateInspectorFromSelection() {
    document.getElementById("selection-summary").textContent = formatSelectionRange();
    updateSerialPreview();
    if (!PT.state.selected.size) return;
    const w = PT.state.wells[[...PT.state.selected][0]];
    if (!w) return;
    document.getElementById("assign-role").value = w.role;
    document.getElementById("assign-sample").value = w.sample || "";
    document.getElementById("assign-treat").value = w.treatment || "";
    document.getElementById("assign-conc").value = w.concentration != null ? String(w.concentration) : "";
    if (w.unit) document.getElementById("assign-unit").value = PT.fmtUnit(w.unit);
    document.getElementById("assign-biorep").value = w.bio_rep || "";
  }

  function describeWellReadout(wid) {
    const w = PT.getWell(wid);
    const block = PT.state.readBlocks[PT.state.activeBlockIdx];
    const m = block && block.measurements ? block.measurements[wid] : null;

    if (w.role === "empty" && (!m || m.value == null)) {
      return { left: `<code>${wid}</code> · Empty`, right: "" };
    }
    const roleLabel = {
      sample: "Sample",
      neg_ctrl: "Vehicle ctrl",
      pos_ctrl: "Positive ctrl",
      blank: "Blank",
      standard: "Standard",
      moat: "Buffer moat",
      empty: "Empty",
    }[w.role];

    const parts = [`<code>${wid}</code>`, roleLabel];
    if (w.sample) parts.push(PT.esc(w.sample));
    if (w.treatment) parts.push(PT.esc(w.treatment));
    if (w.concentration != null && w.role !== "neg_ctrl") {
      parts.push(`<code>${PT.fmtNum(w.concentration, 4)} ${PT.esc(PT.fmtUnit(w.unit))}</code>`);
    }
    if (w.bio_rep) parts.push(PT.esc(w.bio_rep));

    let right = "";
    if (m && m.value != null) right = `Raw: <code>${PT.fmtNum(m.value, 6)}</code>`;
    else if (m && m.status !== "OK") right = PT.esc(m.status);
    return { left: parts.join(" · "), right };
  }

  function updateReadoutBar(hoverWid) {
    const pEl = document.getElementById("readout-primary");
    const sEl = document.getElementById("readout-secondary");
    if (hoverWid || PT.state.selected.size === 1) {
      const target = hoverWid || [...PT.state.selected][0];
      const info = describeWellReadout(target);
      pEl.innerHTML = info.left;
      sEl.innerHTML = info.right;
      return;
    }
    if (PT.state.selected.size > 1) {
      pEl.textContent = formatSelectionRange();
      sEl.textContent = "Press Delete to clear or assign on the right";
      return;
    }
    const counts = { sample: 0, neg_ctrl: 0, pos_ctrl: 0, blank: 0, moat: 0 };
    Object.values(PT.state.wells).forEach((w) => {
      if (counts[w.role] != null) counts[w.role]++;
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!total) {
      pEl.textContent = "Drag across wells to select, or click row/column labels.";
      sEl.textContent = "";
    } else {
      const summary = [];
      if (counts.sample) summary.push(`${counts.sample} sample`);
      if (counts.neg_ctrl) summary.push(`${counts.neg_ctrl} vehicle`);
      if (counts.pos_ctrl) summary.push(`${counts.pos_ctrl} pos ctrl`);
      if (counts.blank) summary.push(`${counts.blank} blank`);
      if (counts.moat) summary.push(`${counts.moat} moat`);
      pEl.textContent = summary.join(" · ");
      sEl.textContent = "Hover any well to inspect";
    }
  }

  function renderPlate() {
    const [nRows, nCols] = PT.GEOMETRIES[PT.state.plate_format];
    const { names: sampleNames, map: sampleColors, keyForWell } = PT.buildSampleColorMap();
    const doseRanges = PT.buildDoseRanges();

    const legendBar = document.getElementById("sample-legend-bar");
    legendBar.innerHTML = !sampleNames.length
      ? `<span>No samples assigned yet</span>`
      : `<span>Series:</span>` +
        sampleNames
          .map(
            (nm) =>
              `<button type="button" class="sample-chip" data-sample="${PT.esc(nm)}" title="Select all ${PT.esc(nm)} wells"><span class="swatch-dot" style="background:${sampleColors[nm].hex}"></span>${PT.esc(nm)}</button>`
          )
          .join("");

    let html = `<div class="plate-chassis"><table class="sbs-grid fmt-${PT.state.plate_format}"><thead><tr>`;
    html += `<th class="hdr-corner" data-action="all" title="Select all wells">A1</th>`;
    for (let c = 1; c <= nCols; c++) {
      html += `<th class="hdr-col" data-col="${c - 1}" title="Select column ${c}">${c}</th>`;
    }
    html += `</tr></thead><tbody>`;

    for (let r = 0; r < nRows; r++) {
      const rlbl = PT.rowIdxToLabel(r);
      html += `<tr><th class="hdr-row" data-row="${r}" title="Select row ${rlbl}">${rlbl}</th>`;
      for (let c = 1; c <= nCols; c++) {
        const wid = `${rlbl}${c}`;
        const w = PT.getWell(wid);
        const selCls = PT.state.selected.has(wid) ? " selected" : "";

        let circleCls = "well-circle";
        let styleStr = "";
        let innerTxt = "";

        const keyName = keyForWell(w);
        const pal = keyName && sampleColors[keyName] ? sampleColors[keyName] : { hex: "#4a4740", rgb: [74, 71, 64] };

        if (w.role === "moat") {
          circleCls += " is-moat";
        } else if (w.role === "blank") {
          circleCls += " is-blank";
          innerTxt = "–";
        } else if (w.role === "neg_ctrl") {
          styleStr = `background:#ffffff;border:2px solid ${pal.hex};color:${pal.hex};`;
          innerTxt = "0";
        } else if (w.role === "pos_ctrl") {
          styleStr = `background:#f9ebe5;border:2px solid #9e3a26;color:#9e3a26;`;
          innerTxt = "+";
        } else if (w.role === "standard") {
          styleStr = `background:${PT.tintRgb(pal.rgb, 0.3)};border:1.5px solid ${pal.hex};color:#1c1b18;`;
          innerTxt = "St";
        } else if (w.role === "sample") {
          let alpha = 0.52;
          if (w.concentration != null && w.concentration > 0) {
            const dr = doseRanges[`${w.sample || ""}|${w.treatment || "_default"}`];
            alpha = dr && dr.max > dr.min ? 0.22 + 0.68 * ((Math.log10(w.concentration) - dr.min) / (dr.max - dr.min)) : 0.65;
          } else if (w.concentration === 0) {
            alpha = 0.12;
          }
          const fill = PT.tintRgb(pal.rgb, alpha);
          const textCol = alpha > 0.58 ? "#fcfbf9" : "#1c1b18";
          styleStr = `background:${fill};border-color:${pal.hex};color:${textCol};`;

          if (PT.state.plate_format <= 96) {
            innerTxt = w.concentration != null && PT.state.assay_type !== "qpcr"
              ? PT.fmtNum(w.concentration, 2)
              : (w.treatment || w.sample || "").slice(0, 4);
          }
        }

        html += `<td class="well-socket${selCls}" data-well="${wid}" data-r="${r}" data-c="${c - 1}"><div class="${circleCls}" style="${styleStr}">${PT.esc(innerTxt)}</div></td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;

    document.getElementById("plate-grid-container").innerHTML = html;
    document.getElementById("btn-undo").disabled = PT.state.undoStack.length === 0;

    const wellCount = Object.keys(PT.state.wells).length;
    document.getElementById("layout-empty-hint").textContent = wellCount > 0
      ? "Need sample data to test the workflow?"
      : "Blank plate — drag across wells to start designing, or preview with sample data:";
    document.getElementById("autosave-indicator").textContent = wellCount > 0 ? `${wellCount} wells assigned` : "Empty plate";

    const notes = PT.auditLayout();
    document.getElementById("layout-audit-banner").innerHTML = notes.length
      ? `<div class="notice-bar"><ul>${notes.map((n) => `<li>${PT.esc(n)}</li>`).join("")}</ul></div>`
      : "";

    populateInspectorFromSelection();
    updateReadoutBar(null);
  }

  function renderSerialSeriesEditor() {
    const container = document.getElementById("sd-series-list");
    const rows = PT.state.serialSeries;
    const disableDel = rows.length <= 1 ? "disabled" : "";
    container.innerHTML = rows
      .map(
        (s, idx) => `
        <div class="sd-series-row" data-idx="${idx}">
          <input type="text" class="sds-sample" value="${PT.esc(s.sample)}" placeholder="Cell line(s)" title="Comma-separate for multiple (e.g. WT, KO)"/>
          <input type="text" class="sds-treat" value="${PT.esc(s.treatment)}" placeholder="Compound(s)" title="Comma-separate for multiple"/>
          <input type="number" class="sds-top" value="${s.top}" step="any" min="0" title="Top dose"/>
          <button type="button" class="subtle sd-del" ${disableDel} title="Remove row">×</button>
        </div>`
      )
      .join("");
    updateSerialPreview();
  }

  function expandSerialSeries() {
    const out = [];
    PT.state.serialSeries.forEach((row) => {
      const samples = String(row.sample || "").split(",").map((x) => x.trim()).filter(Boolean);
      const treats = String(row.treatment || "").split(",").map((x) => x.trim()).filter(Boolean);
      const sList = samples.length ? samples : [""];
      const tList = treats.length ? treats : ["Compound"];
      const top = parseFloat(row.top) > 0 ? parseFloat(row.top) : 10;
      sList.forEach((smp) => {
        tList.forEach((trt) => out.push({ sample: smp, treatment: trt, top }));
      });
    });
    return out;
  }

  function computeSerialPlacement() {
    const [nRows, nCols] = PT.GEOMETRIES[PT.state.plate_format];
    const series = expandSerialSeries();
    const dir = document.getElementById("sd-dir").value;
    const repsRaw = document.getElementById("sd-reps").value;
    const factor = Math.max(1.05, parseFloat(document.getElementById("sd-factor").value) || 3);
    const unit = document.getElementById("sd-unit").value.trim() || "µM";
    const zeroLast = document.getElementById("sd-zero-last").checked;

    document.getElementById("lbl-sd-reps").textContent = dir === "cols" ? "Rows per series" : "Cols per series";

    let rMin, rMax, cMin, cMax, usedDefaultBox = false;
    if (PT.state.selected.size > 0) {
      const coords = [...PT.state.selected].map(PT.splitWell);
      rMin = Math.min(...coords.map((x) => x.r0));
      rMax = Math.max(...coords.map((x) => x.r0));
      cMin = Math.min(...coords.map((x) => x.c0));
      cMax = Math.max(...coords.map((x) => x.c0));
      if (dir === "cols" && cMax === cMin) {
        cMax = PT.state.plate_format >= 96 && cMin > 0 ? Math.max(cMin, nCols - 2) : nCols - 1;
      } else if (dir === "rows" && rMax === rMin) {
        rMax = PT.state.plate_format >= 96 && rMin > 0 ? Math.max(rMin, nRows - 2) : nRows - 1;
      }
    } else {
      usedDefaultBox = true;
      const inset = PT.state.plate_format >= 96 ? 1 : 0;
      rMin = inset;
      rMax = nRows - 1 - inset;
      cMin = inset;
      cMax = nCols - 1 - inset;
    }

    const K = series.length;
    const maxLanes = dir === "cols" ? nRows : nCols;
    const startLane = dir === "cols" ? rMin : cMin;
    const selLanes = dir === "cols" ? rMax - rMin + 1 : cMax - cMin + 1;
    const repsPerSeries = repsRaw !== "auto" ? parseInt(repsRaw, 10) || 1 : selLanes >= K ? Math.floor(selLanes / K) : 1;

    const nSteps = dir === "cols" ? cMax - cMin + 1 : rMax - rMin + 1;
    const doseSteps = zeroLast && nSteps >= 2 ? nSteps - 1 : nSteps;

    const blocks = [];
    let overflowed = false;
    series.forEach((s, idx) => {
      const lStart = startLane + idx * repsPerSeries;
      const lEndRaw = lStart + repsPerSeries - 1;
      if (lStart >= maxLanes) {
        overflowed = true;
        return;
      }
      const lEnd = Math.min(maxLanes - 1, lEndRaw);
      if (lEnd < lEndRaw) overflowed = true;

      const lowDose = Number((s.top / Math.pow(factor, Math.max(0, doseSteps - 1))).toPrecision(3));
      const rangeLbl =
        dir === "cols"
          ? lStart === lEnd
            ? `Row ${PT.rowIdxToLabel(lStart)} · Cols ${cMin + 1}–${cMax + 1}`
            : `Rows ${PT.rowIdxToLabel(lStart)}–${PT.rowIdxToLabel(lEnd)} · Cols ${cMin + 1}–${cMax + 1}`
          : lStart === lEnd
          ? `Col ${lStart + 1} · Rows ${PT.rowIdxToLabel(rMin)}–${PT.rowIdxToLabel(rMax)}`
          : `Cols ${lStart + 1}–${lEnd + 1} · Rows ${PT.rowIdxToLabel(rMin)}–${PT.rowIdxToLabel(rMax)}`;

      blocks.push({ series: s, lStart, lEnd, lowDose, rangeLbl });
    });

    return { dir, rMin, rMax, cMin, cMax, nSteps, factor, unit, zeroLast, usedDefaultBox, overflowed, blocks };
  }

  function updateSerialPreview() {
    const box = document.getElementById("sd-preview-box");
    if (!box) return;
    const plan = computeSerialPlacement();
    if (!plan || !plan.blocks.length) {
      box.textContent = "Add at least one compound series above.";
      return;
    }
    const header = plan.usedDefaultBox
      ? `<div style="margin-bottom:4px;color:var(--ink-muted);">No selection — placing in inner plate (or drag wells to choose):</div>`
      : "";
    const lines = plan.blocks.map((b) => {
      const sName = b.series.sample ? `${PT.esc(b.series.sample)} · ${PT.esc(b.series.treatment)}` : PT.esc(b.series.treatment);
      const vehSuf = plan.zeroLast && plan.nSteps >= 2 ? " + Veh" : "";
      return `<div><code>${b.rangeLbl}</code>: ${sName} (${PT.fmtNum(b.series.top, 3)} → ${b.lowDose} ${PT.esc(plan.unit)}${vehSuf})</div>`;
    });
    if (plan.overflowed) {
      lines.push(`<div style="color:var(--danger-ink);margin-top:3px;">Exceeds plate edge — reduce series count or replicates per series.</div>`);
    }
    box.innerHTML = header + lines.join("");
  }

  function refreshSelectionHighlight() {
    document.querySelectorAll("#plate-grid-container td.well-socket").forEach((td) => {
      td.classList.toggle("selected", PT.state.selected.has(td.getAttribute("data-well")));
    });
    populateInspectorFromSelection();
    updateReadoutBar(null);
  }

  function selectRect(rA, cA, rB, cB, additive) {
    if (!additive) PT.state.selected.clear();
    const rMin = Math.min(rA, rB), rMax = Math.max(rA, rB);
    const cMin = Math.min(cA, cB), cMax = Math.max(cA, cB);
    for (let r = rMin; r <= rMax; r++) {
      const rlbl = PT.rowIdxToLabel(r);
      for (let c = cMin; c <= cMax; c++) PT.state.selected.add(`${rlbl}${c + 1}`);
    }
    refreshSelectionHighlight();
  }

  function clearSelectedWells() {
    if (!PT.state.selected.size) return;
    PT.pushUndo();
    PT.state.selected.forEach((wid) => delete PT.state.wells[wid]);
    PT.saveDraft();
    renderAll();
  }

  function renderReagentEditor() {
    const spike = parseFloat(document.getElementById("calc-spike").value) || 1;
    document.getElementById("reagent-rows-container").innerHTML = PT.getEffectiveReagents(spike)
      .map(
        (r, idx) => `
        <div class="reagent-row" data-idx="${idx}">
          <input type="text" class="rg-name" value="${PT.esc(r.name)}" placeholder="Reagent name"/>
          <input type="number" class="rg-vol" value="${r.per_well_ul}" step="any" min="0"/>
          <button type="button" class="subtle rg-del" title="Remove">×</button>
        </div>`
      )
      .join("");
  }

  function renderProtocol() {
    const overagePct = parseFloat(document.getElementById("calc-overage").value) || 15;
    const deadUl = parseFloat(document.getElementById("calc-dead-ul").value) || 30;
    const stockConc = parseFloat(document.getElementById("calc-stock-conc").value) || 10;
    const stockUnit = document.getElementById("calc-stock-unit").value;
    const spikeFactor = parseFloat(document.getElementById("calc-spike").value) || 1;
    const vehicle = document.getElementById("calc-vehicle").value.trim() || "DMSO";

    const mixes = PT.computeMasterMixes(overagePct, spikeFactor);
    const mmDiv = document.getElementById("master-mix-output");
    if (!mixes.length) {
      mmDiv.innerHTML = `<p style="color:var(--ink-muted);margin:4px 0;">Assign wells on the Layout tab first.</p>`;
    } else {
      let html = `<table class="clean-table"><thead><tr><th style="width:34px;"></th><th>Group</th><th>Wells</th><th>Component breakdown</th><th>Total (+${overagePct}%)</th></tr></thead><tbody>`;
      mixes.forEach((m) => {
        const compTxt = m.components.map((c) => `${PT.esc(c.name)}: <strong>${c.total_ul} µL</strong> (${c.per_well_ul} µL/w)`).join("<br/>");
        html += `<tr class="checkable-row" style="cursor:pointer;"><td class="mono">☐</td><td><strong>${PT.esc(m.name)}</strong></td><td class="mono">${m.wellCount}</td><td>${compTxt}</td><td class="mono"><strong>${m.totalUl.toFixed(1)} µL</strong></td></tr>`;
      });
      mmDiv.innerHTML = html + `</tbody></table>`;
    }

    const plans = PT.computeSerialDilutions({ stockConc, stockUnit, spikeFactor, overagePct, deadUl, vehicle });
    const sdDiv = document.getElementById("serial-dilution-output");
    if (!plans.length) {
      sdDiv.innerHTML = `<p style="color:var(--ink-muted);margin:4px 0;">No multi-concentration series on this plate yet.</p>`;
      return;
    }

    sdDiv.innerHTML = plans
      .map((p) => {
        let out = `<div style="margin-bottom:18px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
            <h3 style="font-size:13.5px;margin:0;">${PT.esc(p.treatment)} (${PT.esc(p.unit)})</h3>
            <div style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--ink-secondary);" class="no-print">
              <span>Stock:</span>
              <input type="number" class="cmp-stock-conc" data-treat="${PT.esc(p.treatment)}" value="${p.stockConc}" step="any" style="width:72px;padding:3px 6px;font-size:12px;"/>
              <select class="cmp-stock-unit" data-treat="${PT.esc(p.treatment)}" style="padding:3px 5px;font-size:12px;">
                ${["mM", "µM", "nM", "M"].map((u) => `<option value="${u}" ${p.stockUnit === u ? "selected" : ""}>${u}</option>`).join("")}
              </select>
            </div>
          </div>`;
        if (p.error) return out + `<div class="notice-bar">${PT.esc(p.error)}</div></div>`;
        if (p.notes.length) {
          out += `<div class="notice-bar" style="margin:0 0 10px 0;"><ul>${p.notes.map((n) => `<li>${PT.esc(n)}</li>`).join("")}</ul></div>`;
        }
        out += `<table class="clean-table"><thead><tr><th style="width:34px;"></th><th>Tube</th><th>Well conc</th><th>Tube (${spikeFactor}×)</th><th>Wells</th><th>Prepare</th><th>Transfer in</th><th>+ Diluent</th></tr></thead><tbody>`;
        p.steps.forEach((s) => {
          out += `<tr class="checkable-row" style="cursor:pointer;"><td class="mono">☐</td><td><strong>${s.tube}</strong></td><td class="mono">${PT.fmtNum(s.wellConc, 4)} ${PT.esc(p.unit)}</td><td class="mono">${PT.fmtNum(s.tubeConc, 4)} ${PT.esc(p.unit)}</td><td class="mono">${s.wells} × ${PT.fmtNum(s.dispenseUl, 3)} µL</td><td class="mono">${s.totalUl.toFixed(1)} µL</td><td class="mono"><strong>${s.transferUl.toFixed(2)} µL</strong> from ${PT.esc(s.source)}</td><td class="mono"><strong>${s.diluentUl.toFixed(2)} µL</strong></td></tr>`;
        });
        return out + `</tbody></table></div>`;
      })
      .join("");
  }

  function renderAnalysis() {
    const emptyBox = document.getElementById("analysis-empty-state");
    const resWrap = document.getElementById("analysis-results");
    const blockWrap = document.getElementById("read-block-wrap");

    if (!PT.state.readBlocks.length) {
      emptyBox.style.display = "block";
      resWrap.style.display = "none";
      blockWrap.style.display = "none";
      return;
    }

    emptyBox.style.display = "none";
    resWrap.style.display = "block";
    blockWrap.style.display = PT.state.readBlocks.length > 1 ? "inline-flex" : "none";

    document.getElementById("sel-read-block").innerHTML = PT.state.readBlocks
      .map((b, i) => `<option value="${i}" ${i === PT.state.activeBlockIdx ? "selected" : ""}>${PT.esc(b.block_id)}</option>`)
      .join("");

    const res = PT.analyzeActiveBlock();
    if (!res) return;

    const zTxt = res.qc.zPrime != null ? res.qc.zPrime.toFixed(2) : "—";
    const cvTxt = res.qc.negCv != null ? `${res.qc.negCv.toFixed(1)}%` : "—";
    const sbTxt = res.qc.sb != null ? `${res.qc.sb.toFixed(1)}×` : "—";
    document.getElementById("qc-kpi-grid").innerHTML = `
      <div class="qc-item"><span>Z'-factor</span><strong>${zTxt}</strong></div>
      <div class="qc-item"><span>Vehicle CV</span><strong>${cvTxt}</strong></div>
      <div class="qc-item"><span>Blank mean</span><strong>${PT.fmtNum(res.qc.blankMean, 4) || "0"}</strong></div>
      <div class="qc-item"><span>Signal / Blank</span><strong>${sbTxt}</strong></div>
    `;
    document.getElementById("qc-notes-box").innerHTML = res.qc.notes.length
      ? `<div class="notice-bar" style="margin:0 0 12px 0;"><ul>${res.qc.notes.map((n) => `<li>${PT.esc(n)}</li>`).join("")}</ul></div>`
      : "";

    document.getElementById("heatmap-container").innerHTML = PT.renderHeatmapSvg(res);

    const fig = PT.renderFigureView(res);
    document.getElementById("plot-card-title").textContent = fig.title;
    PT.state.lastSvgMarkup = fig.svg;
    document.getElementById("plot-svg-container").innerHTML = fig.svg || `<p style="color:var(--ink-muted);">${PT.esc(fig.emptyMsg || "")}</p>`;
    document.getElementById("curve-fit-table-wrap").innerHTML = fig.tableHtml;

    document.getElementById("tidy-row-count").textContent = String(res.rows.length);
    const normTitle = PT.state.assay_type === "qpcr" ? "Fold (2^-ΔΔCt)" : "% Control";
    let tbl = `<thead><tr><th>Well</th><th>Role</th><th>Sample</th><th>Compound / Target</th><th>Conc</th><th>Rep</th><th>Raw</th><th>Net</th><th>${normTitle}</th></tr></thead><tbody>`;
    res.rows.slice(0, 150).forEach((r) => {
      const normTxt = PT.state.assay_type === "qpcr"
        ? (r.fold_change != null ? r.fold_change.toFixed(3) : "—")
        : (r.pct_control != null ? `${r.pct_control.toFixed(1)}%` : "—");
      tbl += `<tr><td class="mono"><strong>${r.well}</strong></td><td>${PT.esc(r.role)}</td><td>${PT.esc(r.sample)}</td><td>${PT.esc(r.treatment)}</td><td class="mono">${r.concentration != null ? `${PT.fmtNum(r.concentration, 3)} ${PT.esc(r.unit)}` : ""}</td><td class="mono">${r.tech_rep || ""}</td><td class="mono">${r.raw_value != null ? PT.fmtNum(r.raw_value, 6) : PT.esc(r.status)}</td><td class="mono">${r.bg_subtracted != null ? PT.fmtNum(r.bg_subtracted, 5) : ""}</td><td class="mono"><strong>${normTxt}</strong></td></tr>`;
    });
    document.getElementById("tidy-preview-table").innerHTML = tbl + `</tbody>`;
  }

  function loadExampleDataset() {
    PT.pushUndo();
    PT.state.plate_id = "Olaparib_BRCA1_96w";
    PT.state.plate_format = 96;
    PT.state.assay_type = "viability";
    PT.state.well_volume_ul = 100;
    PT.state.wells = {};
    PT.state.selected.clear();

    const doses = Array.from({ length: 8 }, (_, i) => Number((10 / Math.pow(3, i)).toPrecision(4)));
    for (let r = 0; r < 8; r++) {
      const rl = PT.rowIdxToLabel(r);
      for (let c = 1; c <= 12; c++) {
        const wid = `${rl}${c}`;
        if (r === 0 || r === 7 || c === 1 || c === 12) {
          PT.state.wells[wid] = { well: wid, role: "moat", sample: "", treatment: "PBS", concentration: null, unit: "", bio_rep: "" };
        } else if (c <= 9) {
          const cellLine = r <= 3 ? "BRCA1-WT" : "BRCA1-KO";
          PT.state.wells[wid] = { well: wid, role: "sample", sample: cellLine, treatment: "Olaparib", concentration: doses[c - 2], unit: "µM", bio_rep: "Rep 1" };
        } else if (c === 10) {
          const cellLine = r <= 3 ? "BRCA1-WT" : "BRCA1-KO";
          PT.state.wells[wid] = { well: wid, role: "neg_ctrl", sample: cellLine, treatment: "0.1% DMSO", concentration: 0, unit: "µM", bio_rep: "Rep 1" };
        } else if (r <= 3) {
          PT.state.wells[wid] = { well: wid, role: "pos_ctrl", sample: "BRCA1-WT", treatment: "Staurosporine", concentration: 1, unit: "µM", bio_rep: "Rep 1" };
        } else {
          PT.state.wells[wid] = { well: wid, role: "blank", sample: "", treatment: "Media", concentration: null, unit: "", bio_rep: "" };
        }
      }
    }

    let seed = 42;
    const pseudoNorm = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      const u1 = Math.max(1e-6, seed / 4294967296);
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * (seed / 4294967296));
    };

    const measurements = {};
    Object.keys(PT.state.wells).forEach((wid) => {
      const w = PT.state.wells[wid];
      let rlu = 180 + Math.round(pseudoNorm() * 16);
      if (w.role === "blank") rlu = 220 + Math.round(pseudoNorm() * 14);
      else if (w.role === "pos_ctrl") rlu = 940 + Math.round(pseudoNorm() * 80);
      else if (w.role === "neg_ctrl") {
        const base = w.sample === "BRCA1-WT" ? 125000 : 108000;
        rlu = Math.round(base * (1 + pseudoNorm() * 0.032));
      } else if (w.role === "sample") {
        const isWt = w.sample === "BRCA1-WT";
        const base = isWt ? 125000 : 108000;
        const pct = (isWt ? 8 : 3) + (isWt ? 92 : 97) / (1 + Math.pow(w.concentration / (isWt ? 4.2 : 0.045), isWt ? 1.15 : 1.35));
        rlu = Math.round(220 + (base - 220) * (pct / 100) * (1 + pseudoNorm() * 0.032));
      }
      measurements[wid] = { value: Math.max(50, rlu), status: "OK" };
    });

    PT.state.serialSeries = [
      { sample: "BRCA1-WT", treatment: "Olaparib", top: 10 },
      { sample: "BRCA1-KO", treatment: "Olaparib", top: 10 },
    ];
    PT.state.readBlocks = [{ block_id: "CellTiter-Glo Luminescence (RLU)", measurements }];
    PT.state.activeBlockIdx = 0;
    syncTopControls();
    renderSerialSeriesEditor();
    renderAll();
  }

  function downloadBlob(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function showParserStatus(msg) {
    const el = document.getElementById("parser-status-msg");
    el.style.display = msg ? "block" : "none";
    el.textContent = msg || "";
  }

  async function handleReaderFile(file) {
    showParserStatus("");
    try {
      let blocks = [];
      if (file.name.toLowerCase().endsWith(".xlsx")) {
        const sheets = await PT.readXlsxArrayBuffer(await file.arrayBuffer());
        sheets.forEach((s) => {
          blocks = blocks.concat(PT.detectBlocksFromGrid(s.name, s.grid));
        });
      } else {
        const txt = await file.text();
        blocks = PT.detectBlocksFromGrid(file.name.replace(/\.[^.]+$/, ""), PT.parseDelimitedText(txt));
      }
      if (!blocks.length) {
        showParserStatus(`No microplate grid (e.g. A–H × 1–12) or Well column found in "${file.name}".`);
        return;
      }
      PT.state.readBlocks = blocks;
      PT.state.activeBlockIdx = 0;
      renderAnalysis();
    } catch (err) {
      showParserStatus(`Could not read "${file.name}": ${err.message}`);
    }
  }

  function renderAll() {
    renderPlate();
    renderProtocol();
    renderAnalysis();
  }

  function init() {
    PT.loadDraft();
    syncTopControls();

    document.querySelectorAll(".view-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".view-pane").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById(tab.getAttribute("data-view")).classList.add("active");
        renderProtocol();
        renderAnalysis();
      });
    });

    const btnSingle = document.getElementById("mode-btn-single");
    const btnSerial = document.getElementById("mode-btn-serial");
    btnSingle.addEventListener("click", () => {
      btnSingle.classList.add("active");
      btnSerial.classList.remove("active");
      document.getElementById("pane-mode-single").style.display = "flex";
      document.getElementById("pane-mode-serial").style.display = "none";
    });
    btnSerial.addEventListener("click", () => {
      btnSerial.classList.add("active");
      btnSingle.classList.remove("active");
      document.getElementById("pane-mode-serial").style.display = "flex";
      document.getElementById("pane-mode-single").style.display = "none";
    });

    const gridWrap = document.getElementById("plate-grid-container");
    gridWrap.addEventListener("mousedown", (e) => {
      const td = e.target.closest("td.well-socket");
      const colH = e.target.closest("th.hdr-col");
      const rowH = e.target.closest("th.hdr-row");
      const corner = e.target.closest("th.hdr-corner");
      const [nRows, nCols] = PT.GEOMETRIES[PT.state.plate_format];
      const add = e.shiftKey || e.metaKey || e.ctrlKey;

      if (corner) return selectRect(0, 0, nRows - 1, nCols - 1, false);
      if (colH) return selectRect(0, parseInt(colH.dataset.col, 10), nRows - 1, parseInt(colH.dataset.col, 10), add);
      if (rowH) return selectRect(parseInt(rowH.dataset.row, 10), 0, parseInt(rowH.dataset.row, 10), nCols - 1, add);
      if (td) {
        e.preventDefault();
        const r = parseInt(td.dataset.r, 10), c = parseInt(td.dataset.c, 10);
        dragState = { r, c, add, prior: new Set(PT.state.selected) };
        selectRect(r, c, r, c, add);
      }
    });

    gridWrap.addEventListener("mouseover", (e) => {
      const td = e.target.closest("td.well-socket");
      if (td) updateReadoutBar(td.dataset.well);
      if (!dragState || !td) return;
      const r = parseInt(td.dataset.r, 10), c = parseInt(td.dataset.c, 10);
      PT.state.selected = dragState.add ? new Set(dragState.prior) : new Set();
      selectRect(dragState.r, dragState.c, r, c, true);
    });

    gridWrap.addEventListener("mouseleave", () => updateReadoutBar(null));
    global.addEventListener("mouseup", () => {
      dragState = null;
    });

    document.getElementById("sample-legend-bar").addEventListener("click", (e) => {
      const chip = e.target.closest(".sample-chip");
      if (!chip) return;
      const nm = chip.dataset.sample;
      const { keyForWell } = PT.buildSampleColorMap();
      PT.state.selected.clear();
      Object.values(PT.state.wells).forEach((w) => {
        if (keyForWell(w) === nm) PT.state.selected.add(w.well);
      });
      refreshSelectionHighlight();
    });

    global.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (PT.popUndo()) {
          syncTopControls();
          renderAll();
        }
      } else if ((e.key === "Delete" || e.key === "Backspace") && PT.state.selected.size > 0) {
        e.preventDefault();
        clearSelectedWells();
      } else if (e.key === "Escape") {
        PT.state.selected.clear();
        refreshSelectionHighlight();
      }
    });

    document.getElementById("inp-plate-id").addEventListener("input", (e) => {
      PT.state.plate_id = e.target.value.trim() || "Untitled_Plate";
      PT.saveDraft();
    });
    document.getElementById("sel-format").addEventListener("change", (e) => {
      PT.pushUndo();
      PT.state.plate_format = parseInt(e.target.value, 10);
      PT.state.selected.clear();
      PT.saveDraft();
      renderAll();
    });
    document.getElementById("sel-assay").addEventListener("change", (e) => {
      PT.state.assay_type = e.target.value;
      PT.state.customReagents = null;
      syncTopControls();
      PT.saveDraft();
      renderAll();
    });
    document.getElementById("inp-well-vol").addEventListener("input", (e) => {
      PT.state.well_volume_ul = parseFloat(e.target.value) || 100;
      PT.saveDraft();
      renderProtocol();
    });
    document.getElementById("inp-hk").addEventListener("input", (e) => {
      PT.state.housekeeping_target = e.target.value.trim();
      PT.saveDraft();
      renderAnalysis();
    });

    document.getElementById("btn-apply-wells").addEventListener("click", () => {
      if (!PT.state.selected.size) return;
      PT.pushUndo();
      const role = document.getElementById("assign-role").value;
      const sample = document.getElementById("assign-sample").value.trim();
      const treat = document.getElementById("assign-treat").value.trim();
      const concRaw = document.getElementById("assign-conc").value.trim();
      const conc = concRaw === "" ? null : parseFloat(concRaw);
      const unit = document.getElementById("assign-unit").value.trim();
      const bioRep = document.getElementById("assign-biorep").value.trim();

      PT.state.selected.forEach((wid) => {
        PT.state.wells[wid] = { well: wid, role, sample, treatment: treat, concentration: conc, unit, bio_rep: bioRep };
      });
      PT.saveDraft();
      renderAll();
    });

    document.getElementById("btn-add-sd-series").addEventListener("click", () => {
      const last = PT.state.serialSeries[PT.state.serialSeries.length - 1] || { sample: "", treatment: "", top: 10 };
      PT.state.serialSeries.push({ sample: last.sample, treatment: "", top: last.top });
      renderSerialSeriesEditor();
    });

    document.getElementById("sd-series-list").addEventListener("input", () => {
      PT.state.serialSeries = [...document.querySelectorAll("#sd-series-list .sd-series-row")].map((el) => ({
        sample: el.querySelector(".sds-sample").value,
        treatment: el.querySelector(".sds-treat").value,
        top: el.querySelector(".sds-top").value,
      }));
      updateSerialPreview();
    });

    document.getElementById("sd-series-list").addEventListener("click", (e) => {
      const del = e.target.closest(".sd-del");
      if (!del || PT.state.serialSeries.length <= 1) return;
      PT.state.serialSeries.splice(parseInt(del.closest(".sd-series-row").dataset.idx, 10), 1);
      renderSerialSeriesEditor();
    });

    ["sd-unit", "sd-factor", "sd-dir", "sd-reps", "sd-zero-last"].forEach((id) => {
      document.getElementById(id).addEventListener("input", updateSerialPreview);
      document.getElementById(id).addEventListener("change", updateSerialPreview);
    });

    document.getElementById("btn-paint-serial").addEventListener("click", () => {
      const plan = computeSerialPlacement();
      if (!plan || !plan.blocks.length) return;
      PT.pushUndo();

      plan.blocks.forEach((b) => {
        const outerMin = b.lStart, outerMax = b.lEnd;
        const innerMin = plan.dir === "cols" ? plan.cMin : plan.rMin;
        const innerMax = plan.dir === "cols" ? plan.cMax : plan.rMax;

        for (let lane = outerMin; lane <= outerMax; lane++) {
          for (let pos = innerMin; pos <= innerMax; pos++) {
            const stepIdx = pos - innerMin;
            const r = plan.dir === "cols" ? lane : pos;
            const c = plan.dir === "cols" ? pos : lane;
            const wid = `${PT.rowIdxToLabel(r)}${c + 1}`;
            if (plan.zeroLast && stepIdx === plan.nSteps - 1 && plan.nSteps >= 2) {
              PT.state.wells[wid] = { well: wid, role: "neg_ctrl", sample: b.series.sample, treatment: "Vehicle", concentration: 0, unit: plan.unit, bio_rep: "Rep 1" };
            } else {
              const dose = Number((b.series.top / Math.pow(plan.factor, stepIdx)).toPrecision(4));
              PT.state.wells[wid] = { well: wid, role: "sample", sample: b.series.sample, treatment: b.series.treatment, concentration: dose, unit: plan.unit, bio_rep: "Rep 1" };
            }
          }
        }
      });

      PT.saveDraft();
      renderAll();
    });

    document.getElementById("btn-pbs-moat").addEventListener("click", () => {
      PT.pushUndo();
      const [nRows, nCols] = PT.GEOMETRIES[PT.state.plate_format];
      for (let r = 0; r < nRows; r++) {
        const rl = PT.rowIdxToLabel(r);
        for (let c = 1; c <= nCols; c++) {
          if (r === 0 || r === nRows - 1 || c === 1 || c === nCols) {
            PT.state.wells[`${rl}${c}`] = { well: `${rl}${c}`, role: "moat", sample: "", treatment: "PBS", concentration: null, unit: "", bio_rep: "" };
          }
        }
      }
      PT.saveDraft();
      renderAll();
    });

    document.getElementById("btn-clear-selected").addEventListener("click", clearSelectedWells);

    document.getElementById("btn-undo").addEventListener("click", () => {
      if (PT.popUndo()) {
        syncTopControls();
        renderAll();
      }
    });

    document.getElementById("btn-clear-all").addEventListener("click", () => {
      PT.pushUndo();
      PT.state.plate_id = "Untitled_Plate";
      PT.state.wells = {};
      PT.state.readBlocks = [];
      PT.state.selected.clear();
      PT.saveDraft();
      syncTopControls();
      renderAll();
    });

    ["calc-stock-conc", "calc-stock-unit", "calc-spike", "calc-overage", "calc-dead-ul", "calc-vehicle"].forEach((id) => {
      document.getElementById(id).addEventListener("input", renderProtocol);
      document.getElementById(id).addEventListener("change", renderProtocol);
    });

    document.getElementById("serial-dilution-output").addEventListener("change", (e) => {
      const target = e.target.closest(".cmp-stock-conc, .cmp-stock-unit");
      if (!target) return;
      const wrap = target.parentElement;
      PT.state.compoundStocks[target.dataset.treat] = {
        conc: parseFloat(wrap.querySelector(".cmp-stock-conc").value) || 10,
        unit: wrap.querySelector(".cmp-stock-unit").value,
      };
      renderProtocol();
    });

    document.getElementById("view-protocol").addEventListener("click", (e) => {
      const tr = e.target.closest("tr.checkable-row");
      if (!tr) return;
      tr.classList.toggle("step-checked");
      const box = tr.querySelector("td");
      if (box) box.textContent = tr.classList.contains("step-checked") ? "☑" : "☐";
    });

    document.getElementById("btn-toggle-reagents").addEventListener("click", () => {
      const wrap = document.getElementById("reagent-editor-wrap");
      const open = wrap.style.display === "none";
      wrap.style.display = open ? "block" : "none";
      if (open) renderReagentEditor();
    });

    document.getElementById("btn-add-reagent").addEventListener("click", () => {
      const spike = parseFloat(document.getElementById("calc-spike").value) || 1;
      PT.state.customReagents = PT.getEffectiveReagents(spike).concat([{ name: "Reagent", per_well_ul: 5 }]);
      PT.saveDraft();
      renderReagentEditor();
      renderProtocol();
    });

    document.getElementById("btn-reset-reagents").addEventListener("click", () => {
      PT.state.customReagents = null;
      PT.saveDraft();
      renderReagentEditor();
      renderProtocol();
    });

    document.getElementById("reagent-rows-container").addEventListener("input", () => {
      PT.state.customReagents = [...document.querySelectorAll("#reagent-rows-container .reagent-row")].map((el) => ({
        name: el.querySelector(".rg-name").value.trim() || "Component",
        per_well_ul: parseFloat(el.querySelector(".rg-vol").value) || 0,
      }));
      PT.saveDraft();
      renderProtocol();
    });

    document.getElementById("reagent-rows-container").addEventListener("click", (e) => {
      const del = e.target.closest(".rg-del");
      if (!del) return;
      const idx = parseInt(del.closest(".reagent-row").dataset.idx, 10);
      const spike = parseFloat(document.getElementById("calc-spike").value) || 1;
      const next = PT.getEffectiveReagents(spike).slice();
      next.splice(idx, 1);
      PT.state.customReagents = next.length ? next : null;
      PT.saveDraft();
      renderReagentEditor();
      renderProtocol();
    });

    const dz = document.getElementById("reader-dropzone");
    const fReader = document.getElementById("file-reader-input");
    dz.addEventListener("click", () => fReader.click());
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      if (e.dataTransfer.files.length) handleReaderFile(e.dataTransfer.files[0]);
    });
    fReader.addEventListener("change", (e) => {
      if (e.target.files.length) handleReaderFile(e.target.files[0]);
      e.target.value = "";
    });

    document.getElementById("btn-toggle-paste").addEventListener("click", () => {
      const d = document.getElementById("paste-drawer");
      d.style.display = d.style.display === "none" ? "block" : "none";
    });

    document.getElementById("btn-parse-pasted").addEventListener("click", () => {
      const blocks = PT.detectBlocksFromGrid("Pasted_Readout", PT.parseDelimitedText(document.getElementById("paste-raw-area").value));
      if (!blocks.length) {
        showParserStatus("Could not detect an A–H × 1–12 matrix or Well,Value columns in pasted text.");
        return;
      }
      showParserStatus("");
      PT.state.readBlocks = blocks;
      PT.state.activeBlockIdx = 0;
      renderAnalysis();
    });

    document.getElementById("sel-read-block").addEventListener("change", (e) => {
      PT.state.activeBlockIdx = parseInt(e.target.value, 10) || 0;
      renderAnalysis();
    });

    document.getElementById("sel-heatmap-metric").addEventListener("change", (e) => {
      PT.state.heatmapMetric = e.target.value;
      renderAnalysis();
    });

    const fLayout = document.getElementById("file-import-layout");
    document.getElementById("btn-import-layout").addEventListener("click", () => fLayout.click());
    fLayout.addEventListener("change", async (e) => {
      if (!e.target.files.length) return;
      const f = e.target.files[0];
      try {
        PT.importLayoutText(f.name, await f.text());
        syncTopControls();
        renderAll();
      } catch (err) {
        showParserStatus(`Layout import failed: ${err.message}`);
      }
      e.target.value = "";
    });

    document.getElementById("btn-export-layout").addEventListener("click", () => {
      const payload = {
        schema: "plate-tidy/v1",
        plate_id: PT.state.plate_id,
        plate_format: PT.state.plate_format,
        assay_type: PT.state.assay_type,
        well_volume_ul: PT.state.well_volume_ul,
        housekeeping_target: PT.state.housekeeping_target,
        wells: Object.values(PT.state.wells).filter((w) => w.role !== "empty"),
      };
      downloadBlob(`${PT.state.plate_id}.plate.json`, JSON.stringify(payload, null, 2) + "\n", "application/json");
    });

    document.getElementById("btn-dl-tidy").addEventListener("click", () => {
      const res = PT.analyzeActiveBlock();
      if (res) downloadBlob(`${PT.state.plate_id}_tidy.csv`, PT.buildTidyCsv(res), "text/csv");
    });

    document.getElementById("btn-dl-prism").addEventListener("click", () => {
      const res = PT.analyzeActiveBlock();
      if (res) downloadBlob(`${PT.state.plate_id}_prism.tsv`, PT.buildPrismTsv(res), "text/tab-separated-values");
    });

    document.getElementById("btn-dl-svg").addEventListener("click", () => {
      if (PT.state.lastSvgMarkup) downloadBlob(`${PT.state.plate_id}_figure.svg`, PT.state.lastSvgMarkup, "image/svg+xml");
    });

    document.getElementById("btn-print-card").addEventListener("click", () => {
      renderProtocol();
      document.getElementById("print-sheet").innerHTML = `
        <div class="surface-card">
          <h2>${PT.esc(PT.state.plate_id)} (${PT.state.plate_format}-well · ${PT.state.well_volume_ul} µL/well)</h2>
          ${document.getElementById("sample-legend-bar").innerHTML}
          <div style="margin-top:8px;">${document.getElementById("plate-grid-container").innerHTML}</div>
        </div>
        <div class="surface-card"><h3>1. Master Mixes</h3>${document.getElementById("master-mix-output").innerHTML}</div>
        <div class="surface-card"><h3>2. Serial Dilutions</h3>${document.getElementById("serial-dilution-output").innerHTML}</div>
      `;
      global.print();
    });

    document.getElementById("btn-load-demo").addEventListener("click", loadExampleDataset);
    renderSerialSeriesEditor();
    renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);
})(window);
