/* ═══════════════════════════════════════════════════════════
   Panel Designer — sld.js   (Tab 0: SLD Reader)
   ═══════════════════════════════════════════════════════════ */
'use strict';

const SLDTab = {

  _dxfPanels: [],      // panels detected from DXF
  _dxfResults: [],     // AI results per panel
  _currentPanel: 0,    // current panel index

  // ── UPLOAD ZONE ────────────────────────────────────────────────────────────
  initUpload() {
    const dz = document.getElementById('drop-zone');
    const fi = document.getElementById('file-input');
    if (!dz || !fi) return;

    fi.addEventListener('change', e => this.handleFile(e.target.files[0]));
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag');
      if (e.dataTransfer.files[0]) this.handleFile(e.dataTransfer.files[0]);
    });
  },

  handleFile(file) {
    if (!file) return;
    PD.file = file;
    const ext = file.name.split('.').pop().toLowerCase();
    const extColor = {jpg:'#1e3a6e',jpeg:'#1e3a6e',png:'#1e4a2e',pdf:'#3a1010',dxf:'#1a3a1a',dwg:'#1a3a1a'};

    document.getElementById('chip-area').innerHTML = `
      <div class="file-chip">
        <div class="chip-ext" style="background:${extColor[ext]||'#222'}">${ext.toUpperCase()}</div>
        <div class="chip-info">
          <div class="chip-name">${file.name}</div>
          <div class="chip-size">${(file.size/1024).toFixed(1)} KB</div>
        </div>
        <button class="btn btn-sm btn-danger" onclick="SLDTab.clearFile()">✕</button>
      </div>`;

    if (['jpg','jpeg','png'].includes(ext)) {
      const reader = new FileReader();
      reader.onload = ev => {
        PD.fileDataURL = ev.target.result;
        document.getElementById('prev-area').innerHTML =
          `<img src="${ev.target.result}" style="width:100%;max-height:160px;object-fit:contain;border-radius:var(--r);border:1px solid var(--ink3);display:block;margin-top:8px">`;
      };
      reader.readAsDataURL(file);
    } else if (ext === 'pdf') {
      const reader = new FileReader();
      reader.onload = ev => { PD.fileDataURL = ev.target.result; };
      reader.readAsDataURL(file);
      document.getElementById('prev-area').innerHTML =
        `<div style="margin-top:6px;font-size:10px;color:var(--mist);font-family:var(--mono)">📄 PDF ready</div>`;
    } else if (ext === 'dxf') {
      PD.fileDataURL = null;
      document.getElementById('prev-area').innerHTML =
        `<div style="margin-top:6px;font-size:10px;color:var(--volt);font-family:var(--mono)">⚡ DXF — auto-detect multiple panels</div>`;
    } else {
      PD.fileDataURL = null;
      document.getElementById('prev-area').innerHTML =
        `<div style="margin-top:6px;font-size:10px;color:var(--amber)">⚠ Unsupported format</div>`;
    }
    document.getElementById('btn-ai').disabled = false;
    log(`File: ${file.name}`, 'ok');
  },

  clearFile() {
    PD.file = null; PD.fileDataURL = null;
    this._dxfPanels = []; this._dxfResults = [];
    document.getElementById('chip-area').innerHTML = '';
    document.getElementById('prev-area').innerHTML = '';
    document.getElementById('file-input').value   = '';
    document.getElementById('btn-ai').disabled = true;
    document.getElementById('dxf-panel-bar')?.remove();
  },

  // ── AI ANALYSIS ────────────────────────────────────────────────────────────
  async startAI() {
    if (!PD.file || PD._analyzing) return;
    const ext = PD.file.name.split('.').pop().toLowerCase();

    if (ext === 'dxf') {
      await this.startDXF();
      return;
    }

    if (!PD.fileDataURL) { toast('File not ready, please try again', 'warn'); return; }

    PD._analyzing = true;
    const btn = document.getElementById('btn-ai');
    btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border:2px solid var(--ink);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></div> SERVER is analyzing...';
    btn.disabled = true;
    setStatus('SERVER is analyzing...', 'warn');
    this.showAnalyzing();

    try {
      const formData = new FormData();
      formData.append('file', PD.file);
      formData.append('panel_name', document.getElementById('cfg-name')?.value || 'Panel');
      formData.append('context', '');

      log('Sending to server...', 'info');
      const resp = await fetch('/api/analyze', { method: 'POST', body: formData });
      const data = await resp.json();

      if (!data.ok) throw new Error(data.error || 'Server error');

      PD.devices   = data.devices  || [];
      PD.panelInfo = data.panel    || {};

      if (PD.panelInfo.name) {
        const el = document.getElementById('cfg-name');
        if (el) el.value = PD.panelInfo.name;
      }

      MatchEngine.run();
      this.renderTable();
      this.updateStats();
      log(`Extracted: ${PD.devices.length} devices`, 'ok');
      toast(`✓ Detected ${PD.devices.length} devices`, 'ok');
      setStatus('Ready');

    } catch (err) {
      log(`Error: ${err.message} `, 'err');
      toast('Error AI: ' + err.message, 'err');
      setStatus('Error', 'err');
      loadDemo();
    } finally {
      PD._analyzing = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Re-analyze`;
      btn.disabled = false;
    }
  },

  // ── DXF MULTI-PANEL FLOW ───────────────────────────────────────────────────
  async startDXF() {
    if (!PD.file || PD._analyzing) return;
    PD._analyzing = true;
    const btn = document.getElementById('btn-ai');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border:2px solid var(--ink);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite"></div> Scanning DXF...';
    setStatus('Scanning DXF...', 'warn');

    try {
      // Step 1: parse DXF for panels
      const fd1 = new FormData();
      fd1.append('file', PD.file);
      log('Scanning DXF for panels...', 'info');
      const r1 = await fetch('/api/parse-dxf', { method: 'POST', body: fd1 });
      const d1 = await r1.json();
      if (!d1.ok) throw new Error(d1.error);

      this._dxfPanels  = d1.panels;
      this._dxfResults = [];
      log(`Found ${d1.panel_count} panels: ${d1.panels.map(p=>p.name).join(', ')}`, 'ok');
      toast(`Found ${d1.panel_count} panels — — processing...`, 'ok');

      // Show progress per panel
      this.showDXFProgress(d1.panels);

      // Step 2: analyze each panel
      const fd2 = new FormData();
      fd2.append('file', PD.file);
      log('Sending panels to server...', 'info');
      const r2 = await fetch('/api/analyze-dxf-panels', { method: 'POST', body: fd2 });
      const d2 = await r2.json();
      if (!d2.ok) throw new Error(d2.error);

      this._dxfResults = d2.results;

      // Show first panel
      this._currentPanel = 0;
      this.showDXFPanelBar();
      this.loadDXFPanel(0);

      const ok = d2.results.filter(r => r.ok).length;
      log(`Done: ${ok}/${d2.total_panels} panels OK`, 'ok');
      toast(`✓ Completed ${ok}/${d2.total_panels} panels`, 'ok');
      setStatus('Ready');

    } catch (err) {
      log(`Error DXF: ${err.message}`, 'err');
      toast('Error: ' + err.message, 'err');
      setStatus('Error', 'err');
    } finally {
      PD._analyzing = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Re-analyze`;
      btn.disabled = false;
    }
  },

  showDXFProgress(panels) {
    const wrap = document.getElementById('sld-result');
    if (!wrap) return;
    const items = panels.map(p => `
      <div id="dxf-prog-${p.name}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--ink2);border-radius:6px;border:1px solid var(--ink3)">
        <div class="spinner" style="width:14px;height:14px;border:2px solid var(--ink);border-top-color:var(--volt);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0"></div>
        <div>
          <div style="font-weight:600;font-size:12px;color:var(--fog)">${p.name}</div>
          <div style="font-size:10px;color:var(--mist)">${p.pe||''} ${p.ijs||''} — ${p.device_count} devices expected</div>
        </div>
        <div id="dxf-prog-status-${p.name}" style="margin-left:auto;font-size:10px;color:var(--mist)">Waiting...</div>
      </div>`).join('');
    wrap.innerHTML = `
      <div style="padding:16px;display:flex;flex-direction:column;gap:8px">
        <div style="font-family:var(--head);font-size:13px;font-weight:600;color:var(--fog);margin-bottom:4px">
          🖥 SERVER analyzing ${panels.length} panels...
        </div>
        ${items}
      </div>`;
  },

  showDXFPanelBar() {
    // Remove old bar
    document.getElementById('dxf-panel-bar')?.remove();

    const results = this._dxfResults;
    if (!results.length) return;

    // Insert above sld-result
    const wrap = document.getElementById('sld-result');
    if (!wrap) return;

    const bar = document.createElement('div');
    bar.id = 'dxf-panel-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--ink2);border-bottom:1px solid var(--ink3);flex-wrap:wrap;flex-shrink:0';

    bar.innerHTML = `
      <span style="font-size:10px;color:var(--mist);font-family:var(--mono);margin-right:4px">TỦ:</span>
      ${results.map((r,i) => `
        <button id="dxf-tab-${i}" onclick="SLDTab.loadDXFPanel(${i})"
          class="btn btn-sm ${i===0?'btn-primary':''}"
          style="font-size:10px;padding:3px 10px;${r.ok?'':'opacity:.5'}">
          ${r.panel_name} ${r.ok ? '✓' : '✗'}
          <span style="font-size:9px;opacity:.7">(${r.devices?.length||0})</span>
        </button>`).join('')}
      <button onclick="SLDTab.exportAllExcel()"
        class="btn btn-sm" style="margin-left:auto;background:var(--volt);color:#000;font-size:10px;font-weight:600">
        ⬇ Export all Excel
      </button>`;

    wrap.parentNode.insertBefore(bar, wrap);
  },

  loadDXFPanel(idx) {
    const results = this._dxfResults;
    if (!results[idx]) return;
    this._currentPanel = idx;

    // Update active tab
    results.forEach((_, i) => {
      const btn = document.getElementById(`dxf-tab-${i}`);
      if (btn) btn.className = `btn btn-sm ${i===idx?'btn-primary':''}`;
    });

    const r = results[idx];
    if (!r.ok) {
      document.getElementById('sld-result').innerHTML =
        `<div class="empty"><div class="empty-icon">⚠</div><div class="empty-title">Error reading panel ${r.panel_name}</div><div class="empty-sub">${r.error||''}</div></div>`;
      return;
    }

    // Load panel data into PD
    PD.devices   = r.devices  || [];
    PD.panelInfo = r.panel    || {};

    const el = document.getElementById('cfg-name');
    if (el) el.value = r.panel_name;

    MatchEngine.run();
    this.renderTable();
    this.updateStats();
    log(`Xem panels: ${r.panel_name} — ${PD.devices.length} devices`, 'ok');
  },

  async exportAllExcel() {
    if (!this._dxfResults.length) { toast('No data yet', 'warn'); return; }
    const filename = PD.file ? PD.file.name.replace(/\.[^.]+$/,'') : 'BOM_ToanBo';
    const discount = +(document.getElementById('discount-pct')?.value) || 0;
    const brandLabel = (PD.brand || 'ls').toUpperCase();

    // Save PD state, run match per panel, then restore
    const _devSaved = PD.devices, _matSaved = PD.matched, _piSaved = PD.panelInfo;

    const panels = this._dxfResults
      .filter(r => r.ok)
      .map(r => {
        PD.devices = r.devices || [];
        MatchEngine.run();
        const grouped = MatchEngine.getGrouped();
        const bom_input = [], bom_output = [];
        Object.values(grouped).forEach(({ match, dev, qty, names, status }) => {
          if (!match && !dev) return;
          const m = match || {}, d = dev || {};
          const row = {
            ten:      m.n  || `${d.type||''} ${d.poles||''}P ${d.in||''}A${d.icu ? ' '+d.icu+'kA' : ''}`.trim(),
            model:    m.n  || '',
            ma_sp:    m.ma || '',
            hang:     match ? brandLabel : '',
            sl:       qty,
            don_gia:  m.g  || 0,
            confidence: d.confidence || 'high',
            note:     d.note || '',
            circuits: (names || []).join(', '),
            status,
          };
          if ((d.level ?? 1) === 0) bom_input.push(row);
          else bom_output.push(row);
        });
        return { name: r.panel_name, panel: r.panel || {}, bom_input, bom_output };
      });

    PD.devices = _devSaved; PD.matched = _matSaved; PD.panelInfo = _piSaved;

    if (!panels.length) { toast('No panels processed successfully', 'err'); return; }

    try {
      log(`Exporting Excel ${panels.length} panels...`, 'info');
      const resp = await fetch('/api/export-excel-multi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panels, filename, discount })
      });
      if (!resp.ok) throw new Error('Excel export failed');
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `${filename}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
      toast(`✓ Exported ${filename}.xlsx (${panels.length} panels)`, 'ok');
      log(`Excel export OK: ${panels.length} sheets`, 'ok');
    } catch (err) {
      toast('Export error: ' + err.message, 'err');
    }
  },

  // ── SHOW ANALYZING ─────────────────────────────────────────────────────────
  showAnalyzing() {
    const wrap = document.getElementById('sld-result');
    if (!wrap) return;
    wrap.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:20px">
        <div class="ai-anim">
          <div class="ai-ring"></div><div class="ai-ring"></div><div class="ai-ring"></div>
          <div class="ai-center">🖥</div>
        </div>
        <div style="font-family:var(--head);font-size:14px;font-weight:500;color:var(--fog)">SERVER is analyzing...</div>
        <div style="width:240px">
          <div class="prog-bar"><div class="prog-fill" id="ai-prog" style="width:0%"></div></div>
        </div>
        <div style="font-family:var(--mono);font-size:9px;color:var(--mist)" id="ai-sub">Initializing...</div>
      </div>`;

    let p = 0;
    const msgs = ['Detecting CB symbols...','Reading In, Icu specs...','Identifying poles & type...','Matching to database...'];
    const iv = setInterval(() => {
      p = Math.min(p + Math.random() * 12 + 3, 92);
      const ep = document.getElementById('ai-prog');
      const es = document.getElementById('ai-sub');
      if (ep) ep.style.width = p + '%';
      if (es) es.textContent = msgs[Math.min(Math.floor(p / 20), msgs.length-1)];
      if (p >= 92) clearInterval(iv);
    }, 350);
  },

  // ── DEVICE TABLE ────────────────────────────────────────────────────────────
  renderTable() {
    const wrap = document.getElementById('sld-result');
    if (!wrap) return;

    if (!PD.devices.length) {
      wrap.innerHTML = `
        <div class="empty">
          <div class="empty-icon">📋</div>
          <div class="empty-title">Waiting for SLD</div>
          <div class="empty-sub">Upload image/PDF/DXF</div>
        </div>`;
      return;
    }

    const CB_TYPES = ['MCB','MCCB','ACB','RCCB','RCBO','ELCB','Contactor'];
    const rows = PD.devices.map((d, i) => {
      const matched = (PD.matched[i] || {});
      const stBadge = matched.status === 'OK' ? 'b-ok' :
                      matched.status === 'NOT_FOUND' ? 'b-err' : 'b-warn';
      const matchName = matched.match?.n || '—';
      return `<tr class="${d.level === 0 ? 'root-row' : ''}">
        <td class="mono" style="color:var(--mist);font-size:9px">${i+1}</td>
        <td><div style="width:18px;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:9px;font-family:var(--mono);font-weight:700;background:${d.level===0?'rgba(0,229,160,.15)':'var(--ink3)'};color:${d.level===0?'var(--volt)':'var(--fog)'}">${d.level}</div></td>
        <td><input value="${d.name||''}" oninput="PD.devices[${i}].name=this.value" style="min-width:170px"></td>
        <td><select onchange="PD.devices[${i}].type=this.value;SLDTab.reMatch()">
          ${CB_TYPES.map(t=>`<option ${d.type===t?'selected':''}>${t}</option>`).join('')}
        </select></td>
        <td><select onchange="PD.devices[${i}].poles=+this.value;SLDTab.reMatch()" style="width:46px">
          ${[1,2,3,4].map(p=>`<option ${d.poles===p?'selected':''}>${p}P</option>`).join('')}
        </select></td>
        <td><input type="number" value="${d.in||''}" oninput="PD.devices[${i}].in=+this.value;SLDTab.reMatch()" style="width:52px"></td>
        <td><input type="number" value="${d.icu||''}" oninput="PD.devices[${i}].icu=+this.value;SLDTab.reMatch()" style="width:48px"></td>
        <td><input type="number" value="${d.idelta||''}" placeholder="—" oninput="PD.devices[${i}].idelta=+this.value||null" style="width:48px"></td>
        <td><input value="${d.cable||''}" oninput="PD.devices[${i}].cable=this.value" class="mono" style="font-size:10px;min-width:130px"></td>
        <td><input type="number" value="${d.p_kw||''}" placeholder="0" oninput="PD.devices[${i}].p_kw=+this.value" style="width:50px"></td>
        <td><span class="badge ${stBadge}" style="font-size:9px">${matched.status||'—'}</span></td>
        <td style="white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:var(--mist)">${matchName}</td>
        <td><button onclick="PD.devices.splice(${i},1);SLDTab.reMatch();SLDTab.renderTable();SLDTab.updateStats()"
          class="btn btn-sm btn-danger" style="padding:3px 7px">✕</button></td>
      </tr>`;
    }).join('');

    wrap.innerHTML = `
      <div style="overflow-x:auto;flex:1">
        <table class="data-tbl">
          <thead><tr>
            <th style="width:30px">#</th>
            <th style="width:28px">Lv</th>
            <th style="min-width:180px">Circuit / Load</th>
            <th style="width:80px">Type</th>
            <th style="width:48px">Poles</th>
            <th style="width:60px">In (A)</th>
            <th style="width:56px">Icu (kA)</th>
            <th style="width:56px">IΔ (mA)</th>
            <th style="min-width:140px">Cable</th>
            <th style="width:58px">P (kW)</th>
            <th style="width:80px">Match</th>
            <th style="min-width:160px">Model LS</th>
            <th style="width:32px"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  reMatch() {
    MatchEngine.run();
    this.updateStats();
  },

  updateStats() {
    const devs = PD.devices;
    const main   = devs.find(d => d.level === 0);
    const branch = devs.filter(d => d.level > 0).length;
    const hi     = devs.filter(d => d.confidence === 'high').length;
    const ok     = (PD.matched || []).filter(r => r.status === 'OK').length;

    document.getElementById('s-total').textContent  = devs.length || '—';
    document.getElementById('s-branch').textContent = branch || '—';
    document.getElementById('s-main').textContent   = main ? main.in + 'A' : '—';
    document.getElementById('s-match').textContent  = devs.length ? `${ok}/${devs.length}` : '—';

    const badge = document.getElementById('tab-0-badge');
    if (badge) { badge.textContent = devs.length; badge.style.display = devs.length ? '' : 'none'; }
  },

  addRow() {
    PD.devices.push({
      id: 'NEW_' + Date.now(), level: 1, name: 'New branch',
      type: 'MCB', poles: 3, in: 16, icu: 6, idelta: null,
      cable: '', tai: '', p_kw: 0, confidence: 'medium', note: ''
    });
    MatchEngine.run();
    this.renderTable();
    this.updateStats();
  },

};

// Init when DOM ready
document.addEventListener('DOMContentLoaded', () => SLDTab.initUpload());
