/* ═══════════════════════════════════════════════════════════
   Panel Designer — layout.js  (Tab 2: Layout Engine + SVG)
   ═══════════════════════════════════════════════════════════ */
'use strict';

const LayoutTab = {
  SCL: 0.24,  // scale: 1mm → 0.24px

  // Device colors by type
  COLORS: {
    ACB:       { s:'#F5A623', f:'rgba(245,166,35,.12)' },
    MCCB:      { s:'#6FA3FF', f:'rgba(74,144,255,.1)' },
    MCB:       { s:'#00E5A0', f:'rgba(0,229,160,.08)' },
    RCCB:      { s:'#C084FC', f:'rgba(192,132,252,.1)' },
    RCBO:      { s:'#C084FC', f:'rgba(192,132,252,.1)' },
    ELCB:      { s:'#C084FC', f:'rgba(192,132,252,.1)' },
    Contactor: { s:'#FF8A94', f:'rgba(255,71,87,.08)' },
  },

  dc(type) { return this.COLORS[type] || this.COLORS.MCB; },

  // ── SYNC ENC FROM SLD TAB ─────────────────────────────────────────────────
  syncFromSLD() {
    ['h','w','d','mt','rs','wd','wv','cb'].forEach(k => {
      const sld = document.getElementById(`cfg-${k}`);
      const ly  = document.getElementById(`enc-${k}`);
      if (sld && ly) ly.value = sld.value;
    });
  },

  renderIfReady() {
    if (PD.devices.length && !PD.layoutData) this.run();
    else if (PD.layoutData) this.renderAll();
  },

  // ── MAIN LAYOUT ENGINE ────────────────────────────────────────────────────
  run() {
    if (!PD.devices.length) { toast('Chưa có thiết bị. Nhấn Demo trước.', 'warn'); return; }

    MatchEngine.run();

    const enc = this.readEnc();
    PD.enc = enc;

    const { H, W, MT, RS, WD, WV, CB, MB } = enc;
    const usableW  = W - WV * 2 - 20;
    const usableH  = H - MT - MB - CB;
    const maxRails = Math.floor(usableH / RS);
    const SCL      = this.SCL;
    const railW    = Math.round(usableW * SCL);
    const GAP      = 3;
    const RAIL_H   = 22;

    // Device pixel width
    const devW = dev => {
      const m = PD.matched.find(r => r.dev === dev)?.match;
      if (m) return Math.max(Math.round(m.w * SCL), 10);
      if (dev.type === 'ACB')  return Math.round(268 * SCL);
      if (dev.type === 'MCCB') return Math.round(105 * SCL);
      return Math.round(27 * SCL * Math.max(dev.poles || 1, 1));
    };

    // Separate main CB and branches
    const mainDevs   = PD.devices.filter(d => d.level === 0);
    const branchDevs = PD.devices.filter(d => d.level > 0);

    let rails = [];

    // Rail 0: main CB(s)
    if (mainDevs.length) {
      const r = { items: [], usedW: 0 };
      mainDevs.forEach(dev => {
        const w = devW(dev) + GAP;
        r.items.push({ dev, x: r.usedW, pw: w - GAP });
        r.usedW += w;
      });
      rails.push(r);
    }

    // Pack branches greedily
    let cur = { items: [], usedW: 0 };
    branchDevs.forEach(dev => {
      const w = devW(dev) + GAP;
      if (cur.usedW + w > railW && cur.items.length) {
        rails.push(cur); cur = { items: [], usedW: 0 };
      }
      cur.items.push({ dev, x: cur.usedW, pw: w - GAP });
      cur.usedW += w;
    });
    if (cur.items.length) rails.push(cur);

    // Assign Y coordinates (absolute mm)
    const placed = rails.map((rail, ri) => ({
      railY: MT + ri * RS,
      items: rail.items.map(({ dev, x, pw }) => ({
        dev, x: WV + x, y: MT + ri * RS, w: pw
      }))
    }));

    const fillPct = Math.min(100, Math.round(rails.length / Math.max(maxRails, 1) * 100));

    PD.layoutData = {
      placed, W, H, MT, RS, WD, WV, CB, MB, usableW, usableH,
      maxRails, fillPct, RAIL_H, SCL,
      name: document.getElementById('cfg-name')?.value || 'Panel',
    };

    this.updateStats(fillPct, rails.length, maxRails);
    this.renderAll();

    document.getElementById('tab-2-badge').style.display = '';
    document.getElementById('ex-svg-ready').innerHTML  = '<span class="badge b-ok">Sẵn sàng</span>';
    document.getElementById('ex-dxf-ready').innerHTML  = '<span class="badge b-ok">Sẵn sàng</span>';
    log(`Layout: ${rails.length}/${maxRails} DIN rail, ${fillPct}% lấp đầy`, 'ok');
    toast('Layout hoàn thành', 'ok');
  },

  readEnc() {
    const g = id => +document.getElementById(id)?.value || 0;
    return {
      H: g('enc-h') || 2000, W: g('enc-w') || 800, D: g('enc-d') || 600,
      MT: g('enc-mt') || 80, RS: g('enc-rs') || 125,
      WD: g('enc-wd') || 40, WV: g('enc-wv') || 60,
      CB: g('enc-cb') || 200, MB: 50,
    };
  },

  updateStats(fillPct, usedRails, maxRails) {
    const prog = document.getElementById('ly-prog');
    const pctEl = document.getElementById('ly-pct');
    const statsEl = document.getElementById('ly-stats');
    const { W, H } = PD.layoutData || {};
    if (prog) {
      prog.style.width = fillPct + '%';
      prog.className = 'prog-fill' + (fillPct > 85 ? ' red' : fillPct > 65 ? ' amber' : '');
    }
    if (pctEl) pctEl.textContent = `Lấp đầy: ${fillPct}%`;
    if (statsEl) statsEl.innerHTML = `
      <div>Thiết bị: <strong>${PD.devices.length}</strong></div>
      <div>DIN rail: <strong>${usedRails}</strong> / ${maxRails}</div>
      <div>Vỏ tủ: <strong>${W}×${H}mm</strong></div>
      <div>Usable W: <strong>${PD.layoutData?.usableW}mm</strong></div>`;
  },

  renderAll() {
    if (!PD.layoutData) return;
    this.drawFront();
    this.drawInner();
    this.drawSLD();
  },

  switchView(i, el) {
    for (let j = 0; j < 3; j++) {
      const v = document.getElementById(`lv-${j}`);
      if (v) v.style.display = j === i ? '' : 'none';
    }
    document.querySelectorAll('.itab').forEach((t, j) => t.classList.toggle('active', j === i));
  },

  // ── DRAW FRONT VIEW ───────────────────────────────────────────────────────
  drawFront() {
    const { placed, W, H, MT, WV, CB, MB, usableW, RAIL_H, SCL, name } = PD.layoutData;
    const tW = Math.round(W * SCL), tH = Math.round(H * SCL);
    const ox = 20, oy = 20;
    let s = '';

    // Cabinet outline
    s += `<rect x="${ox}" y="${oy}" width="${tW}" height="${tH}" rx="4" fill="#0B0F1A" stroke="#3A4560" stroke-width="1.5"/>`;
    s += `<rect x="${ox+3}" y="${oy+3}" width="${tW-6}" height="${tH-6}" rx="2" fill="none" stroke="#1E2535" stroke-width="0.5" stroke-dasharray="4 3"/>`;

    // Side wiring ducts
    const dH = tH - Math.round((MT + MB + CB) * SCL);
    const dY = oy + Math.round(MT * SCL);
    s += `<rect x="${ox+3}" y="${dY}" width="${Math.round(WV*SCL)-2}" height="${dH}" rx="2" fill="#161B27" stroke="#1E2535" stroke-width="0.5"/>`;
    s += `<rect x="${ox+tW-Math.round(WV*SCL)}" y="${dY}" width="${Math.round(WV*SCL)-2}" height="${dH}" rx="2" fill="#161B27" stroke="#1E2535" stroke-width="0.5"/>`;
    s += `<text x="${ox+Math.round(WV*SCL/2)}" y="${dY+dH/2}" text-anchor="middle" dominant-baseline="central" font-size="6" fill="#1E2535" transform="rotate(-90,${ox+Math.round(WV*SCL/2)},${dY+dH/2})">DUCT</text>`;

    // Cable space
    const cY = oy + tH - Math.round(CB * SCL);
    s += `<rect x="${ox+3}" y="${cY}" width="${tW-6}" height="${Math.round(CB*SCL)-3}" rx="2" fill="#0D1117" stroke="#1E2535" stroke-width="0.5"/>`;
    s += `<text x="${ox+tW/2}" y="${cY+Math.round(CB*SCL)/2}" text-anchor="middle" dominant-baseline="central" font-size="9" fill="#3A4560">KHOANG CÁP</text>`;

    // Door handle
    s += `<rect x="${ox+tW-5}" y="${oy+tH/2-14}" width="3" height="28" rx="1.5" fill="#3A4560"/>`;

    // Panel name
    s += `<text x="${ox+tW/2}" y="${oy+12}" text-anchor="middle" font-size="8" font-weight="700" fill="#7A879F">${name}</text>`;

    // Rails + devices
    placed.forEach((row, ri) => {
      const ry = oy + Math.round(row.railY * SCL);
      if (ry + RAIL_H > cY - 2) return;

      // DIN rail bar
      s += `<rect x="${ox+Math.round(WV*SCL)}" y="${ry+RAIL_H-4}" width="${Math.round(usableW*SCL)}" height="3" rx="1" fill="#3A4560" opacity="0.6"/>`;
      s += `<text x="${ox+6}" y="${ry+RAIL_H/2}" dominant-baseline="central" font-size="7" fill="#3A4560">R${ri+1}</text>`;

      // Wiring duct above rail (except first rail)
      if (ri > 0) {
        const wdH = Math.round(PD.layoutData.WD * SCL / 2);
        s += `<rect x="${ox+Math.round(WV*SCL)}" y="${ry-wdH}" width="${Math.round(usableW*SCL)}" height="${wdH-1}" rx="1" fill="#0D1117" stroke="#1E2535" stroke-width="0.5" opacity="0.7"/>`;
      }

      row.items.forEach(({ dev, x, w }) => {
        if (!w) return;
        const c  = this.dc(dev.type);
        const dx = ox + Math.round(x * SCL);
        const dw = Math.max(Math.round(w * SCL), 8);
        const dh = RAIL_H - 4;
        s += `<rect x="${dx}" y="${ry}" width="${dw}" height="${dh}" rx="2" fill="${c.f}" stroke="${c.s}" stroke-width="0.6"/>`;
        if (dw > 14) s += `<text x="${dx+dw/2}" y="${ry+dh/2}" text-anchor="middle" dominant-baseline="central" font-size="${dw>30?7:6}" font-weight="600" fill="${c.s}">${dev.in}A</text>`;
        if (dw > 44) {
          const lbl = dev.name.length > 8 ? dev.name.slice(0,7)+'…' : dev.name;
          s += `<text x="${dx+dw/2}" y="${ry+dh+8}" text-anchor="middle" font-size="5.5" fill="#3A4560">${lbl}</text>`;
        }
      });
    });

    // Dimension lines
    const dimX = ox + tW + 10;
    s += `<line x1="${dimX}" y1="${oy}" x2="${dimX}" y2="${oy+tH}" stroke="#3A4560" stroke-width="0.6"/>`;
    s += `<text x="${dimX+10}" y="${oy+tH/2}" dominant-baseline="central" font-size="8" fill="#7A879F" transform="rotate(90,${dimX+10},${oy+tH/2})">${H}mm</text>`;
    s += `<line x1="${ox}" y1="${oy+tH+10}" x2="${ox+tW}" y2="${oy+tH+10}" stroke="#3A4560" stroke-width="0.6"/>`;
    s += `<text x="${ox+tW/2}" y="${oy+tH+22}" text-anchor="middle" font-size="8" fill="#7A879F">${W}mm</text>`;

    // Legend
    const lx = ox + tW + 28;
    s += `<text x="${lx}" y="${oy+8}" font-size="8" font-weight="700" fill="#7A879F" font-family="Space Grotesk,sans-serif">LEGEND</text>`;
    Object.entries(this.COLORS).forEach(([k, c], i) => {
      s += `<rect x="${lx}" y="${oy+20+i*14}" width="12" height="9" rx="2" fill="${c.f}" stroke="${c.s}" stroke-width="0.6"/>`;
      s += `<text x="${lx+16}" y="${oy+24+i*14}" dominant-baseline="central" font-size="8" fill="#7A879F">${k}</text>`;
    });

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" id="svg-front" width="${tW+130}" height="${tH+60}" viewBox="0 0 ${tW+130} ${tH+60}" style="font-family:'DM Sans',sans-serif">${s}</svg>`;
    const el = document.getElementById('lv-0');
    if (el) el.innerHTML = `<div class="canvas-wrap">${svg}</div>`;
  },

  // ── DRAW INNER DOOR VIEW ──────────────────────────────────────────────────
  drawInner() {
    const { placed, W, H, WV, CB, RAIL_H, SCL, name } = PD.layoutData;
    const tW = Math.round(W * SCL), tH = Math.round(H * SCL);
    const ox = 14, oy = 14, cY = tH - Math.round(CB * SCL);
    let s = '';

    s += `<rect x="${ox}" y="${oy}" width="${tW}" height="${tH}" rx="4" fill="#0B0F1A" stroke="#1E2535" stroke-width="1"/>`;
    s += `<text x="${ox+tW/2}" y="${oy+13}" text-anchor="middle" font-size="8" font-weight="600" fill="#7A879F" font-family="Space Grotesk,sans-serif">${name} — MẶT TRONG CỬA</text>`;

    placed.forEach(row => {
      const ry = oy + Math.round(row.railY * SCL);
      if (ry + RAIL_H > oy + cY - 2) return;
      row.items.forEach(({ dev, x, w }) => {
        if (!w) return;
        const c = this.dc(dev.type);
        const dx = ox + Math.round(x * SCL);
        const dw = Math.max(Math.round(w * SCL), 8);
        const dh = RAIL_H - 4;
        s += `<rect x="${dx}" y="${ry}" width="${dw}" height="${dh}" rx="2" fill="${c.f}" stroke="${c.s}" stroke-width="0.6"/>`;
        if (dw > 22) {
          s += `<text x="${dx+dw/2}" y="${ry+dh/2-3}" text-anchor="middle" dominant-baseline="central" font-size="6" fill="${c.s}">${dev.in}A</text>`;
          if (dw > 40) {
            const nm = dev.name.length > 10 ? dev.name.slice(0,9)+'…' : dev.name;
            s += `<text x="${dx+dw/2}" y="${ry+dh/2+4}" text-anchor="middle" dominant-baseline="central" font-size="5" fill="${c.s}" opacity="0.7">${nm}</text>`;
          }
        }
      });
    });

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tW+28}" height="${tH+28}" viewBox="0 0 ${tW+28} ${tH+28}" style="font-family:'DM Sans',sans-serif">${s}</svg>`;
    const el = document.getElementById('lv-1');
    if (el) el.innerHTML = `<div class="canvas-wrap">${svg}</div>`;
  },

  // ── DRAW SLD DIAGRAM ──────────────────────────────────────────────────────
  drawSLD() {
    const devs    = PD.devices;
    const main    = devs.find(d => d.level === 0);
    const branches= devs.filter(d => d.level > 0);
    const DW = 100, DH = 46;
    const COL= Math.max(116, Math.ceil(700 / Math.max(branches.length, 1)));
    const MX = 20, MY = 20;
    const svgW = Math.max(680, branches.length * COL + MX * 2 + 30);
    const svgH = MY * 2 + DH + 30 + 60 + DH + 44;

    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="font-family:'DM Sans',sans-serif">
      <defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M2 1L8 5L2 9" fill="none" stroke="#3A4560" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </marker></defs>`;

    const cx = svgW / 2, my = MY;

    // Source line
    s += `<line x1="${cx}" y1="${my-18}" x2="${cx}" y2="${my}" stroke="#3A4560" stroke-width="1.2" marker-start="url(#arr)"/>`;
    s += `<text x="${cx+6}" y="${my-9}" dominant-baseline="central" font-size="8" fill="#3A4560">Nguồn vào</text>`;

    // Main CB
    if (main) {
      const c = this.dc(main.type);
      const m = PD.matched.find(r => r.dev === main)?.match;
      s += `<rect x="${cx-DW/2}" y="${my}" width="${DW}" height="${DH}" rx="4" fill="${c.f}" stroke="${c.s}" stroke-width="1"/>`;
      const nm = main.name.length > 16 ? main.name.slice(0,15)+'…' : main.name;
      s += `<text x="${cx}" y="${my+13}" text-anchor="middle" dominant-baseline="central" font-size="8.5" font-weight="600" fill="${c.s}">${nm}</text>`;
      s += `<text x="${cx}" y="${my+26}" text-anchor="middle" dominant-baseline="central" font-size="8" fill="${c.s}">${main.type} ${main.in}A/${main.icu}kA · ${main.poles}P</text>`;
      if (m) s += `<text x="${cx}" y="${my+39}" text-anchor="middle" dominant-baseline="central" font-size="6.5" fill="${c.s}" opacity="0.6">${m.ma}</text>`;
    }

    // Busbar
    const busY = my + DH + 18;
    s += `<line x1="${cx}" y1="${my+DH}" x2="${cx}" y2="${busY-3}" stroke="#3A4560" stroke-width="1.2"/>`;
    s += `<line x1="${MX+16}" y1="${busY}" x2="${svgW-MX-16}" y2="${busY}" stroke="#00E5A0" stroke-width="3" opacity="0.55"/>`;
    s += `<text x="${MX+20}" y="${busY-8}" font-size="7.5" fill="#00E5A0" opacity="0.7" font-weight="700">BUSBAR</text>`;

    // Branches
    const bY = busY + 26;
    branches.forEach((d, i) => {
      const bx  = MX + i * COL + (COL - DW) / 2 + 10;
      const bc  = bx + DW / 2;
      const c   = this.dc(d.type);
      const m   = PD.matched.find(r => r.dev === d)?.match;

      s += `<line x1="${bc}" y1="${busY}" x2="${bc}" y2="${bY-13}" stroke="#1E2535" stroke-width="1"/>`;
      s += `<rect x="${bc-7}" y="${bY-13}" width="14" height="12" rx="2.5" fill="${c.f}" stroke="${c.s}" stroke-width="0.8"/>`;
      s += `<text x="${bc}" y="${bY-7}" text-anchor="middle" dominant-baseline="central" font-size="6" font-weight="700" fill="${c.s}">${d.in}A</text>`;
      s += `<rect x="${bx}" y="${bY}" width="${DW}" height="${DH}" rx="4" fill="${c.f}" stroke="${c.s}" stroke-width="0.8"/>`;

      const nm = d.name.length > 13 ? d.name.slice(0,12)+'…' : d.name;
      s += `<text x="${bc}" y="${bY+13}" text-anchor="middle" dominant-baseline="central" font-size="8" font-weight="500" fill="${c.s}">${nm}</text>`;
      s += `<text x="${bc}" y="${bY+26}" text-anchor="middle" dominant-baseline="central" font-size="7.5" fill="${c.s}">${d.type} ${d.in}A${d.idelta?'/'+d.idelta+'mA':''}</text>`;
      if (d.p_kw) s += `<text x="${bc}" y="${bY+38}" text-anchor="middle" dominant-baseline="central" font-size="6.5" fill="${c.s}" opacity="0.7">${d.p_kw}kW</text>`;
      if (m) s += `<text x="${bc}" y="${bY+DH+10}" text-anchor="middle" font-size="6" fill="#3A4560">${m.ma}</text>`;

      s += `<line x1="${bc}" y1="${bY+DH}" x2="${bc}" y2="${bY+DH+18}" stroke="#1E2535" stroke-width="1" marker-end="url(#arr)"/>`;
      s += `<text x="${bx+3}" y="${bY+8}" font-size="6.5" fill="${c.s}" opacity="0.35">${i+1}</text>`;
    });

    s += `</svg>`;
    const el = document.getElementById('lv-2');
    if (el) el.innerHTML = `<div class="canvas-wrap" style="overflow-x:auto">${s}</div>`;
  },

  // ── GET FRONT SVG FOR EXPORT ──────────────────────────────────────────────
  getFrontSVG() {
    return document.getElementById('svg-front')?.outerHTML || null;
  },

  // ── GENERATE DXF VIA SERVER ───────────────────────────────────────────────
  async exportDXF() {
    if (!PD.layoutData) { toast('Chạy Layout trước', 'warn'); return; }
    try {
      const payload = buildDXFPayload();
      const resp = await fetch('/api/export/dxf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = (PD.layoutData.name || 'panel') + '_layout.dxf';
      a.click(); URL.revokeObjectURL(url);
      toast('Xuất DXF thành công', 'ok');
      log('DXF exported via server', 'ok');
    } catch (e) {
      toast('Lỗi xuất DXF: ' + e.message, 'err');
    }
  },
};
