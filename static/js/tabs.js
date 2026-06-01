/* ═══════════════════════════════════════════════════════════
   Panel Designer — tabs.js
   LibraryTab, ExportTab, ProjectTab
   ═══════════════════════════════════════════════════════════ */
'use strict';

// ── LIBRARY TAB ──────────────────────────────────────────────────────────────
const LibraryTab = {
  render() {
    const type  = document.getElementById('lib-type')?.value  || '';
    const imin  = +document.getElementById('lib-imin')?.value || 0;
    const imax  = +document.getElementById('lib-imax')?.value || 9999;
    const poles = document.getElementById('lib-poles')?.value || '';
    const q     = (document.getElementById('lib-q')?.value || '').toLowerCase();
    const brand = document.getElementById('g-brand')?.value   || 'ls';

    document.getElementById('lib-brand-lbl').textContent = brand.toUpperCase();

    const list = PD.library.filter(d => {
      if (type  && d.t  !== type)  return false;
      if (d.in  <  imin || d.in > imax) return false;
      if (poles && d.p  !== +poles) return false;
      if (q && !(d.n + ' ' + d.ma).toLowerCase().includes(q)) return false;
      return true;
    });

    document.getElementById('lib-count').textContent = list.length;
    const tbody = document.getElementById('lib-tbody');
    if (!tbody) return;

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:24px;color:var(--mist)">Không có thiết bị phù hợp</td></tr>`;
      return;
    }

    const typeBadge = t => {
      const cls = {ACB:'b-acb',MCCB:'b-mccb',MCB:'b-mcb',RCCB:'b-rcbo',RCBO:'b-rcbo',ELCB:'b-elcb',Contactor:'b-cont'}[t]||'b-mcb';
      return `<span class="badge ${cls}">${t}</span>`;
    };

    tbody.innerHTML = list.map((d, i) => `
      <tr>
        <td style="font-weight:500">${d.n}</td>
        <td class="mono" style="color:var(--mist);font-size:10px">${d.ma}</td>
        <td>${typeBadge(d.t)}</td>
        <td style="text-align:center">${d.p}P</td>
        <td style="text-align:center">${d.in}</td>
        <td style="text-align:center">${d.icu || '—'}</td>
        <td style="text-align:center">${d.h}</td>
        <td style="text-align:center">${d.w}</td>
        <td style="text-align:center">${d.d}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:10px">${d.g ? d.g.toLocaleString('vi') + 'đ' : '—'}</td>
        <td>
          <div style="display:flex;gap:4px">
            <button class="btn btn-sm btn-ghost" onclick="LibraryTab.useDevice(${PD.library.indexOf(d)})" title="Thêm vào SLD">+</button>
            <button class="btn btn-sm btn-danger" onclick="LibraryTab.deleteDevice('${d.ma}')" title="Xóa">✕</button>
          </div>
        </td>
      </tr>`).join('');
  },

  useDevice(idx) {
    const d = PD.library[idx];
    if (!d) return;
    PD.devices.push({
      id: 'LIB_' + Date.now(), level: 1,
      name: d.n, type: d.t, poles: d.p,
      in: d.in, icu: d.icu, idelta: d.idelta || null,
      cable: '', tai: '', p_kw: 0,
      confidence: 'high', note: ''
    });
    MatchEngine.run();
    SLDTab.renderTable();
    SLDTab.updateStats();
    goTab(0);
    toast('Thêm: ' + d.n, 'ok');
  },

  async deleteDevice(ma) {
    const brand = document.getElementById('g-brand')?.value || 'ls';
    try {
      await fetch(`/api/library/${brand}/${encodeURIComponent(ma)}`, { method: 'DELETE' });
      PD.library = PD.library.filter(d => d.ma !== ma);
      this.render();
      toast('Đã xóa thiết bị', 'ok');
    } catch (e) {
      toast('Lỗi xóa: ' + e.message, 'err');
    }
  },

  toggleAddForm() {
    const f = document.getElementById('add-lib-form');
    if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
  },

  async saveNewDevice() {
    const brand = document.getElementById('g-brand')?.value || 'ls';
    const device = {
      ma:  document.getElementById('af-code')?.value || 'CUSTOM_' + Date.now(),
      n:   document.getElementById('af-name')?.value || 'Custom',
      t:   document.getElementById('af-type')?.value || 'MCB',
      p:   +(document.getElementById('af-poles')?.value) || 3,
      in:  +(document.getElementById('af-in')?.value)    || 16,
      icu: +(document.getElementById('af-icu')?.value)   || 6,
      h:   +(document.getElementById('af-h')?.value)     || 86,
      w:   +(document.getElementById('af-w')?.value)     || 27,
      d:   +(document.getElementById('af-d')?.value)     || 73,
      g:   +(document.getElementById('af-price')?.value) || 0,
      series: 'Custom',
    };
    try {
      await apiPost('/api/library', { brand, device });
      PD.library.push(device);
      this.render();
      this.toggleAddForm();
      toast('Đã thêm: ' + device.n, 'ok');
      log('Thiết bị mới lưu vào DB', 'ok');
    } catch (e) {
      toast('Lỗi lưu: ' + e.message, 'err');
    }
  },
};

// ── EXPORT TAB ────────────────────────────────────────────────────────────────
const ExportTab = {
  render() {
    MatchEngine.run();
    this.renderBOM();
  },

  renderBOM() {
    const grouped = MatchEngine.getGrouped();
    const tbody   = document.getElementById('bom-tbody');
    if (!tbody) return;

    let total = 0, i = 0;
    const rows = Object.values(grouped).map(({ match, dev, qty, names, status, warns }) => {
      i++;
      if (!match) {
        return `<tr style="background:rgba(255,71,87,.04)">
          <td class="mono" style="color:var(--mist)">${i}</td>
          <td colspan="8" style="color:var(--red)">✗ ${dev.name} — Không tìm thấy trong thư viện</td>
          <td><span class="badge b-err">NOT_FOUND</span></td>
        </tr>`;
      }
      const sub = (match.g || 0) * qty;
      total += sub;
      const rowBg = status === 'OK' ? '' : (status.includes('Tăng') ? 'rgba(245,166,35,.03)' : '');
      return `<tr style="background:${rowBg}">
        <td class="mono" style="color:var(--mist);font-size:10px">${i}</td>
        <td class="mono" style="color:var(--mist);font-size:10px">${match.ma}</td>
        <td style="font-weight:500">${match.n}</td>
        <td><span class="badge ${match.t==='ACB'?'b-acb':match.t==='MCCB'?'b-mccb':match.t==='MCB'?'b-mcb':'b-rcbo'}">${match.t}</span></td>
        <td style="text-align:center">${match.p}P</td>
        <td style="text-align:center">${match.in}</td>
        <td class="mono" style="font-size:10px">${match.h}×${match.w}×${match.d}mm</td>
        <td style="text-align:center;font-weight:700;color:var(--volt)">${qty}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:10px">${match.g ? match.g.toLocaleString('vi')+'đ' : '—'}</td>
        <td style="text-align:right;font-family:var(--mono);font-size:10px;font-weight:600;color:${sub?'var(--volt)':'var(--mist)'}">${sub ? sub.toLocaleString('vi')+'đ' : '—'}</td>
        <td style="font-size:10px;color:var(--mist)">${warns.length ? `<span style="color:var(--amber)" title="${warns.join(', ')}">⚠</span>` : '✓'}</td>
      </tr>`;
    }).join('');

    tbody.innerHTML = rows || `<tr><td colspan="11" style="text-align:center;padding:24px;color:var(--mist)">Chưa có dữ liệu — Upload SLD hoặc nhấn Demo</td></tr>`;

    const totalVAT = Math.round(total * 1.1);
    const totalEl  = document.getElementById('bom-total');
    if (totalEl && total > 0) {
      totalEl.innerHTML = `
        <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--ink3)">
          <span>Tổng chưa VAT: <strong style="color:var(--volt)">${total.toLocaleString('vi')}đ</strong></span>
          <span>Tổng + VAT 10%: <strong style="color:var(--amber)">${totalVAT.toLocaleString('vi')}đ</strong></span>
          <span style="color:var(--mist)">${i} dòng BOM · ${PD.devices.length} thiết bị</span>
        </div>`;
    } else if (totalEl) {
      totalEl.innerHTML = `<span style="color:var(--mist);font-size:11px">Thư viện LS có giá VNĐ. Schneider chưa cập nhật giá.</span>`;
    }
  },

  exportCSV() {
    MatchEngine.run();
    const grouped = MatchEngine.getGrouped();
    const rows = [['STT','Mã SP','Model','Loại','Cực','In(A)','Icu(kA)','H×W×D(mm)','Số lượng','Đơn giá(VNĐ)','Thành tiền(VNĐ)','Mạch áp dụng','Trạng thái']];
    let stt = 0;
    Object.values(grouped).forEach(({ match, dev, qty, names, status }) => {
      stt++;
      const m = match || {};
      rows.push([
        stt, m.ma||'', m.n||dev.name, m.t||dev.type,
        (m.p||dev.poles)+'P', m.in||dev.in, m.icu||dev.icu,
        `${m.h||''}×${m.w||''}×${m.d||''}mm`,
        qty, m.g||0, (m.g||0)*qty,
        names.join(' | '), status
      ]);
    });
    downloadCSV(rows, (document.getElementById('cfg-name')?.value || 'Panel') + '_BOM.csv');
    toast('Xuất BOM CSV', 'ok');
    log('Xuất BOM CSV OK', 'ok');
  },

  updateDiscountPreview() {
    const pct = +(document.getElementById('discount-pct')?.value) || 0;
    const el  = document.getElementById('discount-preview');
    if (el) el.textContent = pct > 0 ? `Giá mua = Giá gốc × ${(100-pct)}%` : 'Không chiết khấu';
  },

  async exportExcel() {
    const name = document.getElementById('cfg-name')?.value || 'Panel';
    const discount = +(document.getElementById('discount-pct')?.value) || 0;
    if (!PD.devices.length) { toast('Chưa có dữ liệu thiết bị', 'warn'); return; }
    try {
      // Build BOM từ matched data để gửi model/mã/giá lên server
      MatchEngine.run();
      const grouped = MatchEngine.getGrouped();
      const brandLabel = (PD.brand || 'ls').toUpperCase();
      const bom_input = [], bom_output = [];
      Object.values(grouped).forEach(({ match, dev, qty, names, status }) => {
        if (!match && !dev) return;
        const m = match || {}; const d = dev || {};
        const row = {
          ten: m.n || `${d.type||''} ${d.poles||''}P ${d.in||''}A${d.icu?' '+d.icu+'kA':''}`.trim(),
          model: m.n || '', ma_sp: m.ma || '', hang: match ? brandLabel : '',
          sl: qty, don_gia: m.g || 0, circuits: (names||[]).join(', '), status,
        };
        if ((d.level ?? 1) === 0) bom_input.push(row); else bom_output.push(row);
      });
      log('Xuất Excel 1 tủ: ' + name + (discount ? ` (CK ${discount}%)` : ''), 'info');
      const resp = await fetch('/api/export/excel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, bom_input, bom_output, panel: PD.panelInfo, discount })
      });
      if (!resp.ok) throw new Error('Lỗi server');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name + '.xlsx';
      a.click(); URL.revokeObjectURL(url);
      toast('✓ Xuất ' + name + '.xlsx', 'ok');
    } catch (err) { toast('Lỗi xuất Excel: ' + err.message, 'err'); }
  },

  async exportExcelMulti() {
    const results = (typeof SLDTab !== 'undefined' && Array.isArray(SLDTab._dxfResults))
      ? SLDTab._dxfResults : [];
    const okResults = results.filter(r => r.ok);
    if (!okResults.length) { log('Không có DXF multi — xuất 1 tủ', 'warn'); await this.exportExcel(); return; }

    // Lưu PD state, chạy match+group cho từng tủ, rồi restore
    const _devSaved = PD.devices, _matSaved = PD.matched, _piSaved = PD.panelInfo;
    const brandLabel = (PD.brand || 'ls').toUpperCase();

    const panels = okResults.map(r => {
      PD.devices = r.devices || [];
      MatchEngine.run();
      const grouped = MatchEngine.getGrouped();

      const bom_input = [], bom_output = [];
      Object.values(grouped).forEach(({ match, dev, qty, names, status }) => {
        if (!match && !dev) return;
        const m = match || {};
        const d = dev   || {};
        const row = {
          ten:      m.n  || `${d.type||''} ${d.poles||''}P ${d.in||''}A${d.icu ? ' '+d.icu+'kA' : ''}`.trim(),
          model:    m.n  || '',
          ma_sp:    m.ma || '',
          hang:     match ? brandLabel : '',
          sl:       qty,
          don_gia:  m.g  || 0,
          circuits: (names || []).join(', '),
          status,
        };
        if ((d.level ?? 1) === 0) bom_input.push(row);
        else bom_output.push(row);
      });

      return { name: r.panel_name, panel: r.panel || {}, bom_input, bom_output };
    });

    PD.devices = _devSaved; PD.matched = _matSaved; PD.panelInfo = _piSaved;

    const filename = PD.file ? PD.file.name.replace(/\.[^.]+$/, '') : 'BOM_ToanBo';
    const discount = +(document.getElementById('discount-pct')?.value) || 0;
    log('Xuất Excel ' + panels.length + ' tủ: ' + panels.map(p => p.name).join(', ') + (discount ? ` (CK ${discount}%)` : ''), 'info');
    try {
      const resp = await fetch('/api/export-excel-multi', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panels, filename, discount })
      });
      if (!resp.ok) { const t = await resp.text(); throw new Error(t); }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename + '.xlsx'; a.click(); URL.revokeObjectURL(url);
      toast('✓ Xuất ' + filename + '.xlsx — ' + panels.length + ' tủ', 'ok');
      log('Xuất Excel multi OK', 'ok');
    } catch (err) { toast('Lỗi xuất Excel: ' + err.message, 'err'); log('ERR: ' + err.message, 'err'); }
  },

  exportSVG() {
    if (!PD.layoutData) { toast('Chạy Layout trước', 'warn'); return; }
    const svg = LayoutTab.getFrontSVG();
    if (!svg) { toast('Không có SVG', 'err'); return; }
    download('<?xml version="1.0" encoding="utf-8"?>\n' + svg,
      (PD.layoutData.name || 'Panel') + '_layout.svg', 'image/svg+xml');
    toast('Xuất SVG OK', 'ok');
  },

  exportJSON() {
    const data = {
      panel:   { name: document.getElementById('cfg-name')?.value, ...PD.panelInfo },
      enc:     PD.enc,
      brand:   PD.brand,
      devices: PD.devices,
    };
    download(JSON.stringify(data, null, 2),
      (data.panel.name || 'Panel') + '_data.json', 'application/json');
    toast('Xuất JSON OK', 'ok');
  },
};

// ── PROJECT TAB ───────────────────────────────────────────────────────────────
const ProjectTab = {
  async render() {
    const tbody = document.getElementById('project-list');
    if (!tbody) return;

    try {
      const projects = await apiGet('/api/projects');
      if (!projects.length) {
        tbody.innerHTML = `
          <div class="empty" style="padding:30px">
            <div class="empty-icon">📁</div>
            <div class="empty-title">Chưa có dự án</div>
            <div class="empty-sub">Lưu dự án hiện tại để tiếp tục ở phiên sau</div>
          </div>`;
        return;
      }
      tbody.innerHTML = projects.map(p => `
        <div class="project-item" onclick="loadProject('${p.file}')">
          <div style="font-size:24px">📋</div>
          <div style="flex:1">
            <div class="project-name">${p.name}</div>
            <div class="project-meta">${p.file} · ${p.updated?.slice(0,16) || ''}</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();ProjectTab.deleteProject('${p.file}')" title="Xóa">🗑</button>
        </div>`).join('');
    } catch (e) {
      tbody.innerHTML = `<div style="padding:20px;color:var(--mist)">Lỗi tải danh sách: ${e.message}</div>`;
    }
  },

  async saveDialog() {
    const defaultName = document.getElementById('cfg-name')?.value || 'project';
    showModal(`
      <div class="modal-title">💾 Lưu dự án</div>
      <div class="field">
        <label>Tên dự án</label>
        <input id="modal-pname" value="${defaultName}" autofocus>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-cancel>Hủy</button>
        <button class="btn btn-volt" data-confirm>Lưu</button>
      </div>`,
      () => {
        const name = document.getElementById('modal-pname')?.value || defaultName;
        saveProject(name);
      }
    );
  },

  async deleteProject(filename) {
    try {
      await fetch(`/api/projects/${filename}`, { method: 'DELETE' });
      toast('Đã xóa dự án', 'ok');
      this.render();
    } catch (e) {
      toast('Lỗi xóa: ' + e.message, 'err');
    }
  },
};
