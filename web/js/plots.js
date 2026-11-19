/* SVG renderers for circular plate signal maps, 4PL dose-response curves, and grouped summaries. */
(function (global) {
  "use strict";

  const PT = (global.PlateTidy = global.PlateTidy || {});

  function heatScale(t) {
    const u = Math.max(0, Math.min(1, t));
    const stops = [
      [0.0, [242, 239, 231]],
      [0.35, [169, 200, 192]],
      [0.7, [66, 125, 118]],
      [1.0, [26, 61, 64]],
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      if (u <= stops[i + 1][0]) {
        const f = (u - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
        const c0 = stops[i][1], c1 = stops[i + 1][1];
        return `rgb(${Math.round(c0[0] + f * (c1[0] - c0[0]))},${Math.round(c0[1] + f * (c1[1] - c0[1]))},${Math.round(c0[2] + f * (c1[2] - c0[2]))})`;
      }
    }
    return "rgb(26,61,64)";
  }

  function resolveSeriesHex(sample, treatment, fallbackIdx, colorCtx) {
    const { map, keyForWell } = colorCtx;
    const key = keyForWell({ role: "sample", sample, treatment });
    if (key && map[key]) return map[key].hex;
    return PT.SAMPLE_PALETTE[fallbackIdx % PT.SAMPLE_PALETTE.length].hex;
  }

  PT.renderHeatmapSvg = function (res) {
    const [nRows, nCols] = PT.GEOMETRIES[PT.state.plate_format];
    const pitch = PT.state.plate_format <= 96 ? 32 : 18;
    const rad = PT.state.plate_format <= 96 ? 12.6 : 7.0;
    const pl = 30, pt = 24;
    const wSvg = pl + nCols * pitch + 12, hSvg = pt + nRows * pitch + 12;

    const valMap = {};
    res.rows.forEach((r) => {
      const v =
        PT.state.heatmapMetric === "norm"
          ? PT.state.assay_type === "qpcr"
            ? r.fold_change
            : r.pct_control
          : r.raw_value;
      if (v != null) valMap[r.well] = v;
    });
    const vals = Object.values(valMap);
    const vMin = vals.length ? Math.min(...vals) : 0;
    const vMax = vals.length ? Math.max(...vals) : 1;
    const span = vMax > vMin ? vMax - vMin : 1;

    let hm = `<svg viewBox="0 0 ${wSvg} ${hSvg}" width="100%" style="font-family:var(--sans);">`;
    hm += `<rect x="1" y="1" width="${wSvg - 2}" height="${hSvg - 2}" rx="7" fill="#f3f0e8" stroke="#d5d0c4"/>`;
    for (let c = 1; c <= nCols; c++) {
      hm += `<text x="${pl + (c - 0.5) * pitch}" y="16" text-anchor="middle" font-size="10" fill="#6b675e" font-weight="600">${c}</text>`;
    }
    for (let r = 0; r < nRows; r++) {
      const rlbl = PT.rowIdxToLabel(r);
      const cy = pt + (r + 0.5) * pitch;
      hm += `<text x="15" y="${cy + 3.5}" text-anchor="middle" font-size="10" fill="#6b675e" font-weight="600">${rlbl}</text>`;
      for (let c = 1; c <= nCols; c++) {
        const wid = `${rlbl}${c}`;
        const w = PT.getWell(wid);
        const cx = pl + (c - 0.5) * pitch;
        const v = valMap[wid];
        const t = v != null ? (v - vMin) / span : 0;
        const fill = v != null ? heatScale(t) : "#e8e5dc";
        const fg = t > 0.52 ? "#fcfbf9" : "#1c1b18";
        const unitSuf = PT.state.heatmapMetric === "norm" && PT.state.assay_type !== "qpcr" ? "%" : "";
        const tip = `${wid} (${w.role}) ${w.sample} ${w.treatment} -> ${v != null ? PT.fmtNum(v, 5) + unitSuf : "—"}`;
        hm += `<g><title>${PT.esc(tip)}</title><circle cx="${cx}" cy="${cy}" r="${rad}" fill="${fill}" stroke="#c5bfb2" stroke-width="0.9"/>`;
        if (pitch >= 28 && ["neg_ctrl", "pos_ctrl", "blank"].includes(w.role) && v != null) {
          const mk = { neg_ctrl: "0", pos_ctrl: "+", blank: "–" }[w.role];
          hm += `<text x="${cx}" y="${cy + 3}" text-anchor="middle" font-size="9" font-weight="700" fill="${fg}">${mk}</text>`;
        }
        hm += `</g>`;
      }
    }
    hm += `</svg>`;
    return hm;
  };

  PT.renderFigureView = function (res) {
    const colorCtx = PT.buildSampleColorMap();

    if (res.curves.length > 0) {
      // Order curves to match top-to-bottom plate appearance when possible
      const orderIdx = new Map(colorCtx.names.map((nm, i) => [nm, i]));
      const curves = res.curves.slice().sort((a, b) => {
        const ka = colorCtx.keyForWell({ role: "sample", sample: a.sample, treatment: a.treatment });
        const kb = colorCtx.keyForWell({ role: "sample", sample: b.sample, treatment: b.treatment });
        const ia = orderIdx.has(ka) ? orderIdx.get(ka) : 999;
        const ib = orderIdx.has(kb) ? orderIdx.get(kb) : 999;
        return ia - ib;
      });

      const legendRows = Math.ceil(curves.length / 2);
      const mt = 18 + legendRows * 18;
      const W = 620, H = 320 + legendRows * 18, ml = 54, mr = 22, mb = 48;
      const pw = W - ml - mr, ph = H - mt - mb;

      const allD = curves.flatMap((c) => c.doses);
      const logMin = Math.floor(Math.log10(Math.min(...allD)) * 2) / 2 - 0.25;
      const logMax = Math.ceil(Math.log10(Math.max(...allD)) * 2) / 2 + 0.25;
      const yMin = Math.min(0, ...curves.flatMap((c) => c.means.map((m, i) => m - c.sds[i])));
      const yMax = Math.max(115, Math.max(...curves.flatMap((c) => c.means.map((m, i) => m + c.sds[i]))) * 1.05);

      const sx = (lx) => ml + ((lx - logMin) / (logMax - logMin)) * pw;
      const sy = (yv) => mt + ph - ((yv - yMin) / (yMax - yMin)) * ph;

      let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="background:#fcfbf9;border:1px solid #dedad0;border-radius:6px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">`;

      curves.forEach((c, idx) => {
        const col = resolveSeriesHex(c.sample, c.treatment, idx, colorCtx);
        const lx = ml + (idx % 2) * 270;
        const ly = 16 + Math.floor(idx / 2) * 18;
        svg += `<line x1="${lx}" y1="${ly}" x2="${lx + 16}" y2="${ly}" stroke="${col}" stroke-width="2.2"/>`;
        svg += `<circle cx="${lx + 8}" cy="${ly}" r="3.2" fill="${col}"/>`;
        svg += `<text x="${lx + 22}" y="${ly + 3.5}" font-size="11" font-weight="600" fill="#1c1b18">${PT.esc(c.label)} (IC₅₀ = ${PT.fmtNum(c.ic50, 3)} ${PT.esc(c.unit)})</text>`;
      });

      [0, 25, 50, 75, 100].forEach((yt) => {
        if (yt >= yMin && yt <= yMax) {
          const yp = sy(yt);
          svg += `<line x1="${ml}" y1="${yp.toFixed(1)}" x2="${ml + pw}" y2="${yp.toFixed(1)}" stroke="${yt === 50 ? "#a8a296" : "#ebe8e0"}" ${yt === 50 ? 'stroke-dasharray="4,4"' : ""}/>`;
          svg += `<text x="${ml - 8}" y="${(yp + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#57544d">${yt}%</text>`;
        }
      });

      for (let e = Math.floor(logMin); e <= Math.ceil(logMax); e++) {
        if (e >= logMin && e <= logMax) {
          const xp = sx(e);
          svg += `<line x1="${xp.toFixed(1)}" y1="${mt}" x2="${xp.toFixed(1)}" y2="${mt + ph}" stroke="#ebe8e0"/>`;
          svg += `<text x="${xp.toFixed(1)}" y="${mt + ph + 17}" text-anchor="middle" font-size="10.5" fill="#57544d">${Math.abs(e) >= 3 ? "10^" + e : Math.pow(10, e)}</text>`;
        }
      }

      svg += `<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + ph}" stroke="#2c2a26" stroke-width="1.25"/>`;
      svg += `<line x1="${ml}" y1="${mt + ph}" x2="${ml + pw}" y2="${mt + ph}" stroke="#2c2a26" stroke-width="1.25"/>`;
      svg += `<text x="${ml + pw / 2}" y="${H - 10}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#1c1b18">Concentration (${PT.esc(curves[0].unit)}, log₁₀ scale)</text>`;
      svg += `<text x="15" y="${mt + ph / 2}" transform="rotate(-90 15 ${mt + ph / 2})" text-anchor="middle" font-size="11.5" font-weight="600" fill="#1c1b18">% of Vehicle Control</text>`;

      curves.forEach((c, idx) => {
        const col = resolveSeriesHex(c.sample, c.treatment, idx, colorCtx);
        const lic = Math.log10(c.ic50);
        const pts = [];
        for (let s = 0; s <= 120; s++) {
          const lx = logMin + (s / 120) * (logMax - logMin);
          pts.push(`${sx(lx).toFixed(1)},${sy(PT.eval4PL(Math.pow(10, lx), c.bottom, c.top, lic, c.hill)).toFixed(1)}`);
        }
        svg += `<polyline fill="none" stroke="${col}" stroke-width="2.2" points="${pts.join(" ")}"/>`;
        c.doses.forEach((d, i) => {
          const xp = sx(Math.log10(d)), yp = sy(c.means[i]);
          if (c.sds[i] > 0) {
            const hi = sy(Math.min(yMax, c.means[i] + c.sds[i])), lo = sy(Math.max(yMin, c.means[i] - c.sds[i]));
            svg += `<line x1="${xp.toFixed(1)}" y1="${hi.toFixed(1)}" x2="${xp.toFixed(1)}" y2="${lo.toFixed(1)}" stroke="${col}" stroke-width="1.25"/>`;
            svg += `<line x1="${(xp - 3).toFixed(1)}" y1="${hi.toFixed(1)}" x2="${(xp + 3).toFixed(1)}" y2="${hi.toFixed(1)}" stroke="${col}" stroke-width="1.25"/>`;
            svg += `<line x1="${(xp - 3).toFixed(1)}" y1="${lo.toFixed(1)}" x2="${(xp + 3).toFixed(1)}" y2="${lo.toFixed(1)}" stroke="${col}" stroke-width="1.25"/>`;
          }
          svg += `<circle cx="${xp.toFixed(1)}" cy="${yp.toFixed(1)}" r="3.8" fill="${col}" stroke="#fcfbf9" stroke-width="1.1"/>`;
          svg += `<title>${PT.esc(c.label)} @ ${d} ${PT.esc(c.unit)}: ${c.means[i].toFixed(1)}% ± ${c.sds[i].toFixed(1)}%</title>`;
        });
      });
      svg += `</svg>`;

      let tableHtml = `<table class="clean-table"><thead><tr><th>Condition</th><th>Rel. IC₅₀</th><th>Abs. IC₅₀ (50%)</th><th>Hill</th><th>Span</th><th>R²</th></tr></thead><tbody>`;
      curves.forEach((c, idx) => {
        const col = resolveSeriesHex(c.sample, c.treatment, idx, colorCtx);
        tableHtml += `<tr><td><span class="swatch-dot" style="display:inline-block;background:${col};margin-right:6px;"></span><strong>${PT.esc(c.label)}</strong></td><td class="mono">${PT.fmtNum(c.ic50, 4)} ${PT.esc(c.unit)}</td><td class="mono">${c.absIc50 != null ? PT.fmtNum(c.absIc50, 4) + " " + PT.esc(c.unit) : "—"}</td><td class="mono">${c.hill >= 0 ? "+" : ""}${c.hill.toFixed(2)}</td><td class="mono">${c.bottom.toFixed(1)}–${c.top.toFixed(1)}%</td><td class="mono">${c.r2.toFixed(3)}</td></tr>`;
      });
      tableHtml += `</tbody></table>`;

      return { title: "Dose–Response Curves (4PL Hill)", svg, tableHtml };
    }

    const title = PT.state.assay_type === "qpcr" ? "Relative Expression (2^-ΔΔCt)" : "Condition Summary";
    const metricLbl = PT.state.assay_type === "qpcr" ? "Fold Change (2^-ΔΔCt)" : "Response";
    const groups = {};
    const groupMeta = {};

    res.rows.forEach((r) => {
      if (["blank", "moat", "empty"].includes(r.role)) return;
      const y = PT.state.assay_type === "qpcr" ? r.fold_change : r.pct_control != null ? r.pct_control : r.raw_value;
      if (y == null) return;
      const lbl = `${r.sample} ${r.treatment}`.trim() || r.role;
      (groups[lbl] = groups[lbl] || []).push(y);
      groupMeta[lbl] = { sample: r.sample, treatment: r.treatment };
    });

    const keys = Object.keys(groups);
    if (!keys.length) {
      return {
        title,
        svg: "",
        emptyMsg: "Assign sample/treatment names on the Layout tab to plot group summaries.",
        tableHtml: "",
      };
    }

    const W = Math.max(480, keys.length * 76 + 90), H = 310, ml = 54, mr = 20, mt = 20, mb = 72;
    const pw = W - ml - mr, ph = H - mt - mb;
    const yMax = Math.max(...Object.values(groups).flat()) * 1.15 || 1;
    const sy = (v) => mt + ph - (v / yMax) * ph;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="background:#fcfbf9;border:1px solid #dedad0;border-radius:6px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">`;
    svg += `<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + ph}" stroke="#2c2a26" stroke-width="1.25"/>`;
    svg += `<line x1="${ml}" y1="${mt + ph}" x2="${ml + pw}" y2="${mt + ph}" stroke="#2c2a26" stroke-width="1.25"/>`;
    svg += `<text x="15" y="${mt + ph / 2}" transform="rotate(-90 15 ${mt + ph / 2})" text-anchor="middle" font-size="11.5" font-weight="600" fill="#1c1b18">${PT.esc(metricLbl)}</text>`;

    const stepW = pw / keys.length;
    keys.forEach((k, i) => {
      const [m, sd] = PT.meanSd(groups[k]);
      const cx = ml + (i + 0.5) * stepW;
      const bw = Math.min(34, stepW * 0.55);
      const col = resolveSeriesHex(groupMeta[k].sample, groupMeta[k].treatment, i, colorCtx);
      svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${sy(m).toFixed(1)}" width="${bw}" height="${(mt + ph - sy(m)).toFixed(1)}" fill="${col}" fill-opacity="0.22" stroke="${col}" stroke-width="1.4"/>`;
      if (sd > 0) {
        svg += `<line x1="${cx.toFixed(1)}" y1="${sy(m + sd).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${sy(Math.max(0, m - sd)).toFixed(1)}" stroke="#1c1b18" stroke-width="1.2"/>`;
      }
      groups[k].forEach((pt, j) => {
        svg += `<circle cx="${(cx + ((j % 3) - 1) * 5).toFixed(1)}" cy="${sy(pt).toFixed(1)}" r="3.1" fill="${col}"/>`;
      });
      svg += `<text x="${cx.toFixed(1)}" y="${mt + ph + 16}" transform="rotate(24 ${cx.toFixed(1)} ${mt + ph + 16})" font-size="10.5" fill="#1c1b18">${PT.esc(k)}</text>`;
    });
    svg += `</svg>`;

    return { title, svg, tableHtml: "" };
  };
})(window);
