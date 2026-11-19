/* Client-side reader parser for .xlsx (OpenXML ZIP), .csv, .tsv, and .txt exports. */
(function (global) {
  "use strict";

  const PT = (global.PlateTidy = global.PlateTidy || {});

  const OVERFLOW = new Set(["OVER", "OVRFLW", "OVERFLOW", "SAT", "SATURATED", "++++", "*****", "INF", "#NUM!"]);
  const UNDETERMINED = new Set(["UNDETERMINED", "NO CT", "NO CQ", "N/A", "NA", "NAN", "-", "--", "BLANK"]);

  PT.parseNumericToken = function (raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return { value: null, status: "UNDETERMINED" };
    const up = s.toUpperCase();
    if (OVERFLOW.has(up) || up.startsWith("OVR")) return { value: null, status: "OVERFLOW" };
    if (UNDETERMINED.has(up) || up.includes("UNDETERMINED")) return { value: null, status: "UNDETERMINED" };

    let cleaned = s.replace(/\s+/g, "");
    if (cleaned.includes(",") && !cleaned.includes(".") && /^[-+]?\d+,\d+$/.test(cleaned)) {
      cleaned = cleaned.replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
    const v = Number(cleaned);
    return Number.isFinite(v) ? { value: v, status: "OK" } : { value: null, status: "UNDETERMINED" };
  };

  PT.parseDelimitedText = function (text) {
    const lines = text.split(/\r?\n/);
    let tabs = 0, commas = 0, semis = 0;
    for (let i = 0; i < Math.min(40, lines.length); i++) {
      tabs += (lines[i].match(/\t/g) || []).length;
      commas += (lines[i].match(/,/g) || []).length;
      semis += (lines[i].match(/;/g) || []).length;
    }
    const delim = tabs >= commas && tabs >= semis && tabs > 0 ? "\t" : semis > commas && semis > 0 ? ";" : ",";
    return lines.map((line) => {
      const out = [];
      let cur = "", inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQ = !inQ;
          }
        } else if (ch === delim && !inQ) {
          out.push(cur.trim());
          cur = "";
        } else {
          cur += ch;
        }
      }
      out.push(cur.trim());
      return out;
    });
  };

  PT.readXlsxArrayBuffer = async function (buf) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    let eocdPos = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos < 0) throw new Error("Not a valid .xlsx workbook.");
    const cdCount = view.getUint16(eocdPos + 10, true);
    const cdOffset = view.getUint32(eocdPos + 16, true);

    const entries = {};
    let ptr = cdOffset;
    const dec = new TextDecoder("utf-8");
    for (let idx = 0; idx < cdCount; idx++) {
      if (view.getUint32(ptr, true) !== 0x02014b50) break;
      const method = view.getUint16(ptr + 10, true);
      const compSize = view.getUint32(ptr + 20, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localHdrOffset = view.getUint32(ptr + 42, true);
      const name = dec.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      entries[name] = { method, compSize, localHdrOffset };
      ptr += 46 + nameLen + extraLen + commentLen;
    }

    async function extractText(name) {
      const e = entries[name];
      if (!e) return null;
      const lNameLen = view.getUint16(e.localHdrOffset + 26, true);
      const lExtraLen = view.getUint16(e.localHdrOffset + 28, true);
      const start = e.localHdrOffset + 30 + lNameLen + lExtraLen;
      const slice = bytes.subarray(start, start + e.compSize);
      if (e.method === 0) return dec.decode(slice);
      if (e.method === 8 && typeof DecompressionStream !== "undefined") {
        const ds = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        writer.write(slice);
        writer.close();
        return dec.decode(await new Response(ds.readable).arrayBuffer());
      }
      throw new Error("Browser lacks DecompressionStream for compressed .xlsx; please export as .csv.");
    }

    const dom = new DOMParser();
    const sharedStrings = [];
    const ssXml = await extractText("xl/sharedStrings.xml");
    if (ssXml) {
      const doc = dom.parseFromString(ssXml, "application/xml");
      const sis = doc.getElementsByTagName("si");
      for (let i = 0; i < sis.length; i++) {
        const ts = sis[i].getElementsByTagName("t");
        let txt = "";
        for (let j = 0; j < ts.length; j++) txt += ts[j].textContent || "";
        sharedStrings.push(txt);
      }
    }

    const sheetPaths = Object.keys(entries)
      .filter((n) => n.startsWith("xl/worksheets/sheet") && n.endsWith(".xml"))
      .sort();

    const sheets = [];
    for (const sPath of sheetPaths) {
      const xmlTxt = await extractText(sPath);
      if (!xmlTxt) continue;
      const doc = dom.parseFromString(xmlTxt, "application/xml");
      const rows = doc.getElementsByTagName("row");
      const cellMap = {};
      let maxR = -1, maxC = -1;

      for (let i = 0; i < rows.length; i++) {
        const rFallback = (parseInt(rows[i].getAttribute("r") || "1", 10) || 1) - 1;
        const cs = rows[i].getElementsByTagName("c");
        let cCursor = 0;
        for (let j = 0; j < cs.length; j++) {
          const cEl = cs[j];
          const ref = cEl.getAttribute("r") || "";
          let rIdx = rFallback, cIdx = cCursor;
          const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
          if (m) {
            cIdx = PT.rowLabelToIdx(m[1]);
            rIdx = parseInt(m[2], 10) - 1;
            cCursor = cIdx + 1;
          } else {
            cCursor++;
          }
          const tAttr = cEl.getAttribute("t") || "";
          let val = "";
          if (tAttr === "inlineStr") {
            const ts = cEl.getElementsByTagName("t");
            for (let k = 0; k < ts.length; k++) val += ts[k].textContent || "";
          } else {
            const vEls = cEl.getElementsByTagName("v");
            if (vEls.length > 0) {
              const rawV = vEls[0].textContent || "";
              val = tAttr === "s" ? sharedStrings[parseInt(rawV, 10)] || rawV : rawV;
            }
          }
          if (val !== "") {
            cellMap[`${rIdx},${cIdx}`] = val;
            if (rIdx > maxR) maxR = rIdx;
            if (cIdx > maxC) maxC = cIdx;
          }
        }
      }
      const grid = [];
      for (let r = 0; r <= maxR; r++) {
        const rowArr = [];
        for (let c = 0; c <= maxC; c++) rowArr.push(cellMap[`${r},${c}`] || "");
        grid.push(rowArr);
      }
      sheets.push({ name: sPath.split("/").pop().replace(".xml", ""), grid });
    }
    return sheets;
  };

  function validRowIdx(token) {
    const clean = (token || "").trim().toUpperCase();
    if (!clean || clean.length > 2 || !/^[A-Z]+$/.test(clean)) return null;
    const idx = PT.rowLabelToIdx(clean);
    return idx >= 0 && idx < 32 ? idx : null;
  }

  function dedupBlockIds(blocks) {
    const counts = {};
    blocks.forEach((b) => {
      counts[b.block_id] = (counts[b.block_id] || 0) + 1;
    });
    const seen = {};
    blocks.forEach((b) => {
      if (counts[b.block_id] > 1) {
        seen[b.block_id] = (seen[b.block_id] || 0) + 1;
        b.block_id = `${b.block_id} (${seen[b.block_id]})`;
      }
    });
    return blocks;
  }

  PT.detectBlocksFromGrid = function (sheetName, grid) {
    const blocks = [];
    let r = 0;

    // 1. Scan for full or partial 2D plate matrices
    while (r < grid.length) {
      const row = grid[r] || [];
      let hdrStart = -1, colNums = [];
      for (let s = 0; s < Math.min(4, row.length); s++) {
        const tok = (row[s] || "").trim();
        if (!/^0*[1-9]\d?$/.test(tok)) continue;
        const firstCol = parseInt(tok, 10);
        if (firstCol < 1 || firstCol > 48) continue;
        const cols = [firstCol];
        let exp = firstCol + 1;
        for (let j = s + 1; j < row.length; j++) {
          if (exp <= 48 && new RegExp(`^0*${exp}$`).test((row[j] || "").trim())) {
            cols.push(exp);
            exp++;
          } else break;
        }
        if (cols.length >= 3) {
          hdrStart = s;
          colNums = cols;
          break;
        }
      }

      if (hdrStart < 0) {
        r++;
        continue;
      }

      let dataOffset = hdrStart;
      if (hdrStart === 0) {
        if (r + 1 < grid.length && validRowIdx((grid[r + 1] || [])[0]) != null) {
          dataOffset = 1;
        } else {
          r++;
          continue;
        }
      }
      const lblCol = dataOffset - 1;

      let title = "";
      for (let b = r - 1; b >= Math.max(0, r - 4); b--) {
        const nonEmpty = (grid[b] || []).map((x) => x.trim()).filter(Boolean);
        if (nonEmpty.length === 1 && nonEmpty[0].length < 75) {
          title = nonEmpty[0].replace(/:$/, "");
          break;
        }
      }

      const measurements = {};
      let matchedRows = 0;
      let lastRowIdx = -1;
      let scan = r + 1;

      while (scan < grid.length) {
        const ln = grid[scan] || [];
        if (ln.every((x) => !x.trim())) {
          if (matchedRows >= 2) break;
          scan++;
          continue;
        }
        const rawLbl = (ln[lblCol] || "").trim().toUpperCase();
        const rIdx = validRowIdx(rawLbl);
        if (rIdx == null || rIdx <= lastRowIdx) break;
        if (lastRowIdx >= 0 && rIdx - lastRowIdx > 2) break;

        lastRowIdx = rIdx;
        colNums.forEach((c1, idx) => {
          const rawCell = ln[dataOffset + idx] || "";
          const parsed = PT.parseNumericToken(rawCell);
          const wid = `${rawLbl}${c1}`;
          if (parsed.value != null || parsed.status === "OVERFLOW" || rawCell.trim() !== "") {
            measurements[wid] = parsed;
          }
        });
        matchedRows++;
        scan++;
      }

      if (matchedRows >= 2 && Object.keys(measurements).length > 0) {
        blocks.push({ block_id: title || sheetName, measurements });
        r = scan;
      } else {
        r++;
      }
    }

    if (blocks.length > 0) return dedupBlockIds(blocks);

    // 2. Fallback: Long Well Table (QuantStudio / CFX / Tabular)
    const wellHeaders = new Set(["well", "well position", "well id", "well_id", "position", "pos"]);
    const prioCols = ["cq", "ct", "cp", "raw data", "value", "signal", "luminescence", "rlu", "rfu", "absorbance", "od", "mean"];

    for (let i = 0; i < grid.length; i++) {
      const low = (grid[i] || []).map((c) => c.trim().toLowerCase().replace(/\s+/g, " "));
      const candWCols = [];
      low.forEach((h, idx) => {
        if (wellHeaders.has(h)) candWCols.push(idx);
      });
      if (!candWCols.length) continue;

      candWCols.sort((a, b) => (low[a] === "well position" ? -1 : low[b] === "well position" ? 1 : a - b));
      let wCol = -1;
      for (const cIdx of candWCols) {
        let hits = 0;
        for (let p = i + 1; p < Math.min(grid.length, i + 10); p++) {
          if (PT.normalizeWellId((grid[p] || [])[cIdx] || "")) hits++;
        }
        if (hits >= 1) {
          wCol = cIdx;
          break;
        }
      }
      if (wCol < 0) continue;

      const tCol = low.findIndex((h, idx) => idx !== wCol && ["target", "target name", "gene", "detector"].includes(h));
      const sCol = low.findIndex((h, idx) => idx !== wCol && ["sample", "sample name", "sample id"].includes(h));

      let vCol = -1;
      for (const p of prioCols) {
        vCol = low.findIndex((h, idx) => idx !== wCol && (h === p || h.startsWith(p + " ") || h.startsWith(p + "(")));
        if (vCol >= 0) break;
      }
      if (vCol < 0) {
        vCol = low.findIndex((h, idx) => idx !== wCol && idx !== tCol && idx !== sCol && h && !["row", "col", "column", "task"].includes(h));
      }
      if (vCol < 0) continue;

      const measurements = {};
      let validCount = 0;
      for (let d = i + 1; d < grid.length; d++) {
        const row = grid[d] || [];
        const wid = PT.normalizeWellId(row[wCol] || "");
        if (!wid) continue;
        const parsed = PT.parseNumericToken(row[vCol] || "");
        parsed.extra = {};
        if (tCol >= 0 && row[tCol]) parsed.extra.instrument_target = row[tCol].trim();
        if (sCol >= 0 && row[sCol]) parsed.extra.instrument_sample = row[sCol].trim();
        measurements[wid] = parsed;
        validCount++;
      }
      if (validCount >= 2) {
        return [{ block_id: `${sheetName} (${grid[i][vCol] || "Signal"})`, measurements }];
      }
    }
    return [];
  };
})(window);
