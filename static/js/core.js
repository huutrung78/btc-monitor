/* ═══════════════════════════════════════════════════════════
   Panel Designer — core.js
   State, utilities, API calls
   ═══════════════════════════════════════════════════════════ */
'use strict';

// ── GLOBAL STATE ────────────────────────────────────────────────────────────
window.PD = {
  // SLD data
  file:       null,
  devices:    [],      // [{id, level, name, type, poles, in, icu, idelta, cable, tai, p_kw, confidence, note}]
  panelInfo:  {},      // {name, pe_kw, cos_phi, ijs_a, source}

  // Library
  library:    [],      // flat array loaded from server
  brand:      'ls',

  // Layout
  layoutData: null,    // computed by layout engine
  matched:    [],      // [{dev, match, status, warns}]

  // Enclosure config
  enc: { h:2000, w:800, d:600, mt:80, rs:125, wd:40, wv:60, cb:200 },

  // Project
  projectFile: null,

  // Internal
  _analyzing: false,
};

// ── LOG ──────────────────────────────────────────────────────────────────────
function log(msg, type='') {
  const t   = new Date().toLocaleTimeString('vi', {hour12:false});
  const cls = ({ok:'log-ok', warn:'log-warn', err:'log-err', info:'log-info'})[type] || '';
  const pre = ({ok:'✓ ', warn:'⚠ ', err:'✗ ', info:'→ '})[type] || '  ';
  const el  = document.getElementById('log-box');
  if (!el) return;
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:6px';
  div.innerHTML = `<span style="color:var(--ink5)">${t}</span><span class="${cls}">${pre}${msg}</span>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ── TOAST ────────────────────────────────────────────────────────────────────
function toast(msg, type='ok', duration=2800) {
  let area = document.getElementById('toast-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'toast-area';
    document.body.appendChild(area);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = ({ok:'✓ ', warn:'⚠ ', err:'✗ '})[type] + msg;
  area.appendChild(el);
  setTimeout(() => {
    el.style.cssText = 'opacity:0;transition:opacity .3s';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ── GLOBAL STATUS ────────────────────────────────────────────────────────────
function setStatus(msg, type='ok') {
  const el = document.getElementById('g-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-pill' + (type==='ok' ? '' : ' '+type);
}

// ── TAB NAVIGATION ───────────────────────────────────────────────────────────
function goTab(i) {
  for (let j = 0; j < 5; j++) {
    const t = document.getElementById(`tab-${j}`);
    const p = document.getElementById(`pane-${j}`);
    if (t) t.classList.toggle('active', j === i);
    if (p) p.classList.toggle('active', j === i);
  }
  if (i === 1) LibraryTab.render();
  if (i === 2) { LayoutTab.syncFromSLD(); LayoutTab.renderIfReady(); }
  if (i === 3) ExportTab.render();
  if (i === 4) ProjectTab.render();
}

// ── API HELPERS ──────────────────────────────────────────────────────────────
async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function apiPost(url, data) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── LOAD LIBRARY FROM SERVER ─────────────────────────────────────────────────
async function loadLibrary(brand) {
  try {
    const data = await apiGet(`/api/library?brand=${brand}`);
    PD.library  = data.devices || [];
    PD.brand    = brand;
    log(`Library ${brand.toUpperCase()}: ${PD.library.length} thiết bị`, 'ok');
    return PD.library;
  } catch (e) {
    log(`Load library lỗi: ${e.message}`, 'err');
    return [];
  }
}

// ── BRAND CHANGE ─────────────────────────────────────────────────────────────
async function onBrandChange() {
  const brand = document.getElementById('g-brand').value;
  await loadLibrary(brand);
  LibraryTab.render();
  // Re-match if devices exist
  if (PD.devices.length) {
    MatchEngine.run();
    SLDTab.updateStats();
    ExportTab.render();
  }
}

// ── MATCHING ENGINE ──────────────────────────────────────────────────────────
const MatchEngine = {
  TYPE_MAP: {
    MCB:       ['MCB'],
    MCCB:      ['MCCB'],
    ACB:       ['ACB'],
    RCBO:      ['ELCB','RCCB'],
    RCCB:      ['RCCB','ELCB'],
    ELCB:      ['ELCB'],
    Contactor: ['Contactor'],
  },

  findBest(dev) {
    const want = this.TYPE_MAP[dev.type] || [dev.type];
    const lib  = PD.library;

    // Pool: type match + poles exact + In >= req + Icu >= req
    let pool = lib.filter(d =>
      want.includes(d.t) &&
      d.p === dev.poles  &&
      d.in >= dev.in     &&
      (d.icu || 0) >= (dev.icu || 0)
    );

    // Fallback: relax Icu
    if (!pool.length) {
      pool = lib.filter(d => want.includes(d.t) && d.p === dev.poles && d.in >= dev.in);
    }

    if (!pool.length) return null;

    // Choose: smallest In >= req → lowest price → highest Icu as tiebreak
    // Icu chỉ cần >= yêu cầu, không ưu tiên Icu cao (tránh chọn Susol đắt hơn ABN)
    return pool.reduce((best, cur) => {
      if (cur.in < best.in) return cur;
      if (cur.in > best.in) return best;
      const cp = (cur.g  != null) ? cur.g  : Infinity;
      const bp = (best.g != null) ? best.g : Infinity;
      if (cp < bp) return cur;
      if (cp > bp) return best;
      if ((cur.icu||0) > (best.icu||0)) return cur;
      return best;
    });
  },

  run() {
    PD.matched = PD.devices.map(dev => {
      const m = this.findBest(dev);
      const warns = [];
      if (!m) {
        return { dev, match: null, status: 'NOT_FOUND', warns: ['Không tìm thấy trong thư viện'] };
      }
      if (m.in > dev.in)  warns.push(`Tăng In: ${dev.in}A → ${m.in}A`);
      if ((m.icu||0) < (dev.icu||0)) warns.push(`Icu ${m.icu}kA < yêu cầu ${dev.icu}kA`);
      return {
        dev, match: m,
        status: warns.length ? (warns.some(w=>w.includes('Icu')) ? '⚠ Cảnh báo' : '↑ Tăng cỡ') : 'OK',
        warns
      };
    });
    const ok = PD.matched.filter(r => r.status === 'OK').length;
    log(`Matching: ${ok}/${PD.devices.length} khớp chính xác`, 'ok');
    return PD.matched;
  },

  getGrouped() {
    const g = {};
    (PD.matched || []).forEach(({ dev, match, status, warns }) => {
      if (!match) {
        const k = 'NOTFOUND_' + dev.id;
        g[k] = g[k] || { match: null, dev, qty: 0, names: [], status, warns: [] };
        g[k].qty++; g[k].names.push(dev.name);
        return;
      }
      const k = match.ma;
      g[k] = g[k] || { match, dev, qty: 0, names: [], status, warns: [] };
      g[k].qty++;
      g[k].names.push(dev.name);
      g[k].warns = [...new Set([...g[k].warns, ...warns])];
    });
    return g;
  }
};

// ── DXF GENERATOR (CLIENT-SIDE FALLBACK) ────────────────────────────────────
function buildDXFPayload() {
  if (!PD.layoutData) return null;
  const { placed, W, H, WV, CB, enc, name } = PD.layoutData;
  return {
    name: name || 'panel',
    layout: { placed, W, H, WV, CB: CB || PD.enc.cb, name }
  };
}

// ── DOWNLOAD HELPER ──────────────────────────────────────────────────────────
function download(content, filename, mime='text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(c => `"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  download('\ufeff' + csv, filename, 'text/csv;charset=utf-8');
}

// ── PROJECT SAVE / LOAD ──────────────────────────────────────────────────────
async function saveProject(name) {
  name = name || document.getElementById('cfg-name')?.value || 'untitled';
  const payload = {
    name,
    brand: PD.brand,
    devices: PD.devices,
    panelInfo: PD.panelInfo,
    enc: PD.enc,
  };
  try {
    const r = await apiPost('/api/projects', payload);
    PD.projectFile = r.file;
    toast(`Đã lưu dự án: ${name}`, 'ok');
    log(`Project saved: ${r.file}`, 'ok');
  } catch (e) {
    toast('Lưu thất bại: ' + e.message, 'err');
  }
}

async function loadProject(filename) {
  try {
    const data = await apiGet(`/api/projects/${filename}`);
    PD.devices    = data.devices    || [];
    PD.panelInfo  = data.panelInfo  || {};
    PD.enc        = { ...PD.enc, ...data.enc };
    if (data.brand) {
      document.getElementById('g-brand').value = data.brand;
      await loadLibrary(data.brand);
    }
    // Sync enc inputs
    ['h','w','d','mt','rs','wd','wv','cb'].forEach(k => {
      const el = document.getElementById(`enc-${k}`);
      if (el && PD.enc[k]) el.value = PD.enc[k];
    });
    if (data.name) {
      const el = document.getElementById('cfg-name');
      if (el) el.value = data.name;
    }
    MatchEngine.run();
    SLDTab.renderTable();
    SLDTab.updateStats();
    goTab(0);
    toast(`Đã mở: ${data.name}`, 'ok');
    log(`Project loaded: ${filename}`, 'ok');
  } catch (e) {
    toast('Mở thất bại: ' + e.message, 'err');
  }
}

// ── SHOW MODAL ───────────────────────────────────────────────────────────────
function showModal(html, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">${html}</div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  if (onConfirm) {
    const btn = overlay.querySelector('[data-confirm]');
    if (btn) btn.addEventListener('click', () => { onConfirm(); overlay.remove(); });
  }
  const cancel = overlay.querySelector('[data-cancel]');
  if (cancel) cancel.addEventListener('click', () => overlay.remove());
  return overlay;
}

// ── DEMO DATA ────────────────────────────────────────────────────────────────
function loadDemo() {
  PD.panelInfo = { name:'1AP-SC6', pe_kw:59, cos_phi:0.8, ijs_a:101, source:'Tủ tổng MDB' };
  PD.devices   = [
    {id:'CB_TONG',level:0,name:'CB tổng 1AP-SC6',type:'MCCB',poles:3,in:125,icu:10,idelta:null,cable:'',tai:'Tủ phân phối',p_kw:59,confidence:'high',note:'MCCB-160/8P 125A'},
    {id:'N1', level:1,name:'N1 — Bơm nước máy',  type:'RCBO',poles:4,in:32,icu:6,idelta:30,cable:'CXV-4×4+E-1×4',tai:'Bơm nước máy', p_kw:7.5,confidence:'high',note:''},
    {id:'N2', level:1,name:'N2 — Bơm nước máy',  type:'RCBO',poles:4,in:32,icu:6,idelta:30,cable:'CXV-4×4+E-1×4',tai:'Bơm nước máy', p_kw:7.5,confidence:'high',note:'Giống N1'},
    {id:'N3', level:1,name:'N3 — Sưởi ấm',       type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'CXV-4×2.5+E-1×2.5',tai:'Sưởi ấm',  p_kw:5.5,confidence:'high',note:''},
    {id:'N4', level:1,name:'N4 — Sưởi ấm',       type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'CXV-4×2.5+E-1×2.5',tai:'Sưởi ấm',  p_kw:5.5,confidence:'high',note:''},
    {id:'N5', level:1,name:'N5 — Sưởi ấm',       type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'CXV-4×2.5+E-1×2.5',tai:'Sưởi ấm',  p_kw:5.5,confidence:'high',note:''},
    {id:'N6', level:1,name:'N6 — Sưởi ấm',       type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'CXV-4×2.5+E-1×2.5',tai:'Sưởi ấm',  p_kw:5.5,confidence:'high',note:''},
    {id:'N7', level:1,name:'N7 — Sưởi ấm',       type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'CXV-4×2.5+E-1×2.5',tai:'Sưởi ấm',  p_kw:5.5,confidence:'high',note:''},
    {id:'N8', level:1,name:'N8 — Sưởi ấm',       type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'CXV-4×2.5+E-1×2.5',tai:'Sưởi ấm',  p_kw:5.5,confidence:'high',note:''},
    {id:'N9', level:1,name:'N9 — Sưởi ấm',       type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'CXV-4×2.5+E-1×2.5',tai:'Sưởi ấm',  p_kw:5.5,confidence:'high',note:''},
    {id:'N10',level:1,name:'N10 — Sưởi ấm',      type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'CXV-4×2.5+E-1×2.5',tai:'Sưởi ấm',  p_kw:5.5,confidence:'high',note:''},
    {id:'N11',level:1,name:'N11 — Dự phòng',     type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'',tai:'Spare',p_kw:0,confidence:'high',note:''},
    {id:'N12',level:1,name:'N12 — Dự phòng',     type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'',tai:'Spare',p_kw:0,confidence:'high',note:''},
    {id:'N13',level:1,name:'N13 — Dự phòng',     type:'RCBO',poles:4,in:16,icu:6,idelta:30,cable:'',tai:'Spare',p_kw:0,confidence:'medium',note:''},
  ];
  const nameEl = document.getElementById('cfg-name');
  if (nameEl) nameEl.value = PD.panelInfo.name;
  MatchEngine.run();
  SLDTab.renderTable();
  SLDTab.updateStats();
  toast('Demo 1AP-SC6 — 14 thiết bị', 'ok');
  log('Demo loaded: 14 thiết bị 1AP-SC6', 'ok');
}

// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  log('Panel Designer v1.1 khởi động', 'ok');
  await loadLibrary('ls');
  log(`Library LS Electric: ${PD.library.length} thiết bị`, 'info');

  // Sync enc inputs → PD.enc on change
  ['h','w','d','mt','rs','wd','wv','cb'].forEach(k => {
    const el = document.getElementById(`enc-${k}`);
    if (el) el.addEventListener('input', () => {
      PD.enc[k] = +el.value || PD.enc[k];
    });
  });
});
