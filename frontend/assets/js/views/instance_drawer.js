import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, relativeTime, fmtDate, showToast, confirmDialog, formatBytes, fmtPercent, actionLabel } from '../utils.js';

export async function render(body, id) {
  if (!id) { body.innerHTML = `<p>${t('instance.missing_id')}</p>`; return; }

  body.innerHTML = `
    <div class="hub-tabs" id="idr-tabs">
      <button class="hub-tab active" data-tab="info">${t('instance.tab_info')}</button>
      <button class="hub-tab" data-tab="actions">${t('instance.tab_actions')}</button>
      <button class="hub-tab" data-tab="ssh">${t('instance.tab_ssh')}</button>
      <button class="hub-tab" data-tab="audit">${t('instance.tab_audit')}</button>
    </div>
    <div id="idr-panel"></div>`;

  let _inst = null;
  const panel = body.querySelector('#idr-panel');

  async function switchTab(tab) {
    body.querySelectorAll('.hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    panel.innerHTML = '<div class="hub-loader"></div>';
    try {
      if (tab === 'info')    await renderInfo(panel, id, _inst);
      if (tab === 'actions') await renderActions(panel, id, _inst);
      if (tab === 'ssh')     await renderSsh(panel, id);
      if (tab === 'audit')   await renderAudit(panel, id);
    } catch (e) {
      panel.innerHTML = `<div style="color:var(--hub-status-offline);padding:20px;font-size:13px">${t('instance.load_error')}</div>`;
    }
  }

  body.querySelectorAll('.hub-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Load instance data first
  _inst = await apiGet(`/instances/${id}`);
  await switchTab('info');
}

async function renderInfo(panel, id, inst) {
  if (!inst) inst = await apiGet(`/instances/${id}`);

  const [groups] = await Promise.all([
    apiGet('/groups').catch(() => []),
  ]);

  const group = inst.group_id
    ? (groups.find(g => g.id === inst.group_id) || await apiGet(`/groups/${inst.group_id}`).catch(() => null))
    : null;

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;font-size:13px">
      ${infoRow(t('instance.id'),            `<span class="text-mono">${escapeHtml(inst.id)}</span>`)}
      ${infoRow(t('label.status'),           statusBadge(inst.ws_connected, inst.enrollment_status))}
      ${infoRow(t('instances.col_version'),  `<span class="text-mono">${escapeHtml(inst.version || '—')}</span>`)}
      ${infoRow('IP',                        escapeHtml(inst.ip_address || '—'))}
      ${infoRow(t('instances.col_contact'),  relativeTime(inst.last_seen_at))}
      ${infoRow(t('instance.fingerprint'),   `<span class="text-mono" style="font-size:11px;word-break:break-all">${escapeHtml(inst.fingerprint || '—')}</span>`)}
      ${infoRow(t('instance.enroll_status'), escapeHtml(inst.enrollment_status || '—'))}
      ${infoRowEditable(t('label.group'), group
        ? `<span class="group-badge" style="border-color:${escapeHtml(group.color||'#adb5bd')}">${escapeHtml(group.name)}</span>`
        : '—',
        `<select id="idr-group-sel" class="form-select form-select-sm" style="max-width:200px">
          <option value="">${t('instances.no_group')}</option>
          ${groups.map(g => `<option value="${g.id}" ${inst.group_id === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-primary ms-1" id="idr-group-save">${t('modal.save')}</button>`
      )}
      ${infoRow(t('instances.col_tags'),     (inst.tags?.length
        ? inst.tags.map(tg => `<span class="tag-chip" style="background:${escapeHtml(tg.color||'#adb5bd')}22;color:${escapeHtml(tg.color||'#adb5bd')}">${escapeHtml(tg.name)}</span>`).join('')
        : '—') + `<button class="btn btn-sm btn-ghost-secondary ms-1" id="idr-edit-tags" style="font-size:11px;padding:1px 6px"><i class="ti ti-plus"></i></button>`)}
    </div>

    <!-- Telemetry chart -->
    <div style="margin-top:20px">
      <div style="font-weight:600;font-size:13px;margin-bottom:12px">${t('instance.telemetry')}</div>
      <div id="idr-tele-bars"></div>
      <div id="idr-chart" style="margin-top:12px"></div>
    </div>`;

  // Group save handler
  panel.querySelector('#idr-group-save')?.addEventListener('click', async () => {
    const sel = panel.querySelector('#idr-group-sel');
    try {
      await apiPatch(`/instances/${id}`, { group_id: sel.value || null });
      showToast(t('msg.saved'), 'success');
      inst.group_id = sel.value || null;
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  // Tag edit handler
  panel.querySelector('#idr-edit-tags')?.addEventListener('click', async () => {
    const allTags = await apiGet('/tags').catch(() => []);
    showTagEditModal(allTags, inst.tags || [], async (selectedIds) => {
      try {
        const tagNames = selectedIds.map(tid => allTags.find(tg => tg.id === tid)?.name).filter(Boolean);
        await apiPut(`/instances/${id}/tags`, { tag_names: tagNames });
        showToast(t('msg.saved'), 'success');
        inst = await apiGet(`/instances/${id}`);
        await renderInfo(panel, id, inst);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    });
  });

  // Load and render telemetry
  try {
    const latest = await apiGet(`/instances/${id}/telemetry/latest`).catch(() => null);
    if (latest) {
      const bars = document.getElementById('idr-tele-bars');
      if (bars) {
        bars.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${teleBar('CPU', fmtPercent(latest.cpu_percent), latest.cpu_percent)}
            ${teleBar('RAM', fmtPercent(latest.ram_percent), latest.ram_percent)}
            ${teleBar(t('instance.disk'), fmtPercent(latest.disk_percent), latest.disk_percent)}
            ${teleBar('Net ↑', formatBytes(latest.net_out_bps || 0) + '/s', 0)}
          </div>`;
      }
    }
    // Timeseries chart
    const series = await apiGet(`/instances/${id}/telemetry?hours=1`);
    if (Array.isArray(series) && series.length > 1 && window.ApexCharts) {
      const cats = series.map(p => fmtDate(p.ts));
      const chartEl = document.getElementById('idr-chart');
      if (chartEl) {
        if (chartEl._chart) chartEl._chart.destroy();
        chartEl._chart = new window.ApexCharts(chartEl, {
          chart: { type: 'line', height: 140, toolbar: { show: false }, sparkline: { enabled: false } },
          series: [
            { name: 'CPU %',  data: series.map(p => +(p.cpu_percent    || 0).toFixed(1)) },
            { name: 'RAM %',  data: series.map(p => +(p.ram_percent    || 0).toFixed(1)) },
            { name: 'Disk %', data: series.map(p => +(p.disk_percent   || 0).toFixed(1)) },
          ],
          xaxis: { categories: cats, labels: { show: false } },
          yaxis: { min: 0, max: 100, labels: { formatter: v => v + '%' } },
          stroke: { width: 2, curve: 'smooth' },
          colors: ['#206bc4', '#2fb344', '#f59f00'],
          legend: { show: true, position: 'top', fontSize: '11px' },
          grid: { borderColor: 'var(--hub-border)' },
          tooltip: { theme: document.documentElement.getAttribute('data-bs-theme') },
        });
        chartEl._chart.render();
      }
    }
  } catch (_) {}
}

function showTagEditModal(allTags, currentTags, onSave) {
  const currentIds = new Set(currentTags.map(t => t.id));
  const selected = new Set(currentIds);

  const m = document.createElement('div');
  m.className = 'modal fade';
  m.innerHTML = `<div class="modal-dialog modal-sm modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${t('instances.col_tags')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${allTags.map(tg => `
            <span class="tag-chip tag-chip-sel ${selected.has(tg.id) ? 'active' : ''}"
              data-id="${tg.id}"
              style="cursor:pointer;background:${escapeHtml(tg.color||'#adb5bd')}22;color:${escapeHtml(tg.color||'#adb5bd')};opacity:${selected.has(tg.id) ? 1 : 0.5}">
              ${escapeHtml(tg.name)}
            </span>`).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="te-save">${t('modal.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(m);
  const modal = new window.bootstrap.Modal(m);
  modal.show();

  m.querySelectorAll('.tag-chip-sel').forEach(chip => {
    chip.addEventListener('click', () => {
      const tid = chip.dataset.id;
      if (selected.has(tid)) {
        selected.delete(tid);
        chip.style.opacity = '0.5';
        chip.classList.remove('active');
      } else {
        selected.add(tid);
        chip.style.opacity = '1';
        chip.classList.add('active');
      }
    });
  });

  m.querySelector('#te-save').addEventListener('click', async () => {
    await onSave([...selected]);
    modal.hide();
  });
  m.addEventListener('hidden.bs.modal', () => m.remove());
}

function teleBar(label, value, pct) {
  const color = pct > 85 ? '#d63939' : pct > 65 ? '#f59f00' : '#2fb344';
  return `<div style="background:var(--hub-surface);padding:10px;border-radius:var(--hub-radius-sm);border:1px solid var(--hub-border)">
    <div style="font-size:11px;color:var(--tblr-secondary);margin-bottom:4px">${escapeHtml(label)}</div>
    <div style="font-size:15px;font-weight:700">${escapeHtml(value)}</div>
    ${pct ? `<div style="height:3px;background:var(--hub-border);border-radius:2px;margin-top:6px"><div style="height:3px;width:${Math.min(pct,100)}%;background:${color};border-radius:2px"></div></div>` : ''}
  </div>`;
}

function statusBadge(ws, status) {
  if (status === 'revoked') return `<span class="hub-badge revoked">Revocata</span>`;
  if (status === 'pending') return `<span class="hub-badge pending">In attesa</span>`;
  if (ws) return `<span class="hub-badge online"><span class="status-dot online"></span>Online</span>`;
  return `<span class="hub-badge offline"><span class="status-dot offline"></span>Offline</span>`;
}

function infoRow(label, value) {
  return `<div style="display:flex;gap:12px;align-items:flex-start;border-bottom:1px solid var(--hub-border);padding-bottom:10px">
    <div style="width:120px;color:var(--tblr-secondary);flex-shrink:0;font-size:12px;padding-top:2px">${escapeHtml(label)}</div>
    <div style="flex:1;word-break:break-word">${value}</div>
  </div>`;
}

function infoRowEditable(label, display, editHtml) {
  return `<div style="display:flex;gap:12px;align-items:flex-start;border-bottom:1px solid var(--hub-border);padding-bottom:10px">
    <div style="width:120px;color:var(--tblr-secondary);flex-shrink:0;font-size:12px;padding-top:2px">${escapeHtml(label)}</div>
    <div style="flex:1;word-break:break-word">${editHtml || display}</div>
  </div>`;
}

async function renderActions(panel, id, inst) {
  if (!inst) inst = await apiGet(`/instances/${id}`);
  const online = inst?.ws_connected;

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      <!-- Rename -->
      <div>
        <label class="form-label" style="font-size:12px;color:var(--tblr-secondary)">${t('instance.label_rename')}</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="act-name" class="form-control form-control-sm" value="${escapeHtml(inst?.name || '')}" />
          <button class="btn btn-sm btn-primary" id="act-save-name">${t('modal.save')}</button>
        </div>
      </div>
      <hr style="margin:4px 0">
      <button class="btn btn-outline-primary" id="act-reload">
        <i class="ti ti-refresh me-2"></i>${t('instance.cmd_reload')}
      </button>
      <button class="btn btn-outline-secondary" id="act-backup">
        <i class="ti ti-cloud-upload me-2"></i>${t('instance.cmd_backup')}
      </button>
      <hr style="margin:4px 0">
      <button class="btn btn-outline-secondary" id="act-assign-ssh">
        <i class="ti ti-key me-2"></i>${t('instance.assign_ssh')}
      </button>
    </div>
    <div id="act-result" style="margin-top:12px"></div>`;

  panel.querySelector('#act-save-name')?.addEventListener('click', async () => {
    const name = panel.querySelector('#act-name').value.trim();
    if (!name) return;
    try {
      await apiPatch(`/instances/${id}`, { name });
      showToast(t('msg.saved'), 'success');
      if (inst) inst.name = name;
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  async function sendCmd(cmd) {
    const res = document.getElementById('act-result');
    if (!online) {
      if (res) res.innerHTML = `<div class="alert alert-warning py-2" style="font-size:13px">${t('instance.cmd_queued')}</div>`;
    }
    try {
      const r = await apiPost(`/instances/${id}/exec/${cmd}`, {});
      if (res) res.innerHTML = `<div class="alert alert-success py-2" style="font-size:13px">${t('instance.cmd_done', { result: JSON.stringify(r) })}</div>`;
    } catch (e) {
      if (res) res.innerHTML = `<div class="alert alert-danger py-2" style="font-size:13px">${escapeHtml(e.detail || 'Errore')}</div>`;
    }
  }

  panel.querySelector('#act-reload')?.addEventListener('click', () => sendCmd('info'));
  panel.querySelector('#act-backup')?.addEventListener('click', () => sendCmd('backup'));
  panel.querySelector('#act-assign-ssh')?.addEventListener('click', () => showSshAssignModal(id, 'instance'));
}

async function renderSsh(panel, id) {
  const assignments = await apiGet(`/ssh/assignments?target_id=${id}`).catch(() => []);
  const active = (assignments || []).filter(a => a.status !== 'revoked');

  if (!active.length) {
    panel.innerHTML = `<div style="text-align:center;padding:30px;color:var(--tblr-secondary);font-size:13px"><i class="ti ti-lock" style="font-size:28px;display:block;margin-bottom:8px;opacity:.4"></i>${t('ssh.none_assign')}</div>
    <div style="text-align:center;margin-top:8px">
      <button class="btn btn-sm btn-outline-secondary" id="ssh-assign-btn"><i class="ti ti-key me-1"></i>${t('instance.assign_ssh')}</button>
    </div>`;
    panel.querySelector('#ssh-assign-btn')?.addEventListener('click', () => showSshAssignModal(id, 'instance').then(() => renderSsh(panel, id)));
    return;
  }

  panel.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button class="btn btn-sm btn-outline-secondary" id="ssh-assign-btn"><i class="ti ti-key me-1"></i>${t('instance.assign_ssh')}</button>
    </div>
    <div class="data-table" style="margin-top:8px">
    <table><thead><tr>
      <th>${t('ssh.col_key')}</th>
      <th>${t('ssh.col_user')}</th>
      <th>${t('ssh.col_status')}</th>
      <th></th>
    </tr></thead><tbody>
    ${active.map(a => `<tr>
      <td>${escapeHtml(a.key_name || a.ssh_key_id)}</td>
      <td><span class="text-mono">${escapeHtml(a.linux_user || a.target_user || '—')}</span></td>
      <td><span class="hub-badge ${a.status}">${escapeHtml(a.status)}</span></td>
      <td style="text-align:right">
        <button class="btn btn-sm btn-ghost-danger revoke-ssh-btn" data-id="${a.id}" title="${t('ssh.confirm_revoke')}">
          <i class="ti ti-trash" style="font-size:13px"></i>
        </button>
      </td>
    </tr>`).join('')}
    </tbody></table></div>`;

  panel.querySelector('#ssh-assign-btn')?.addEventListener('click', async () => {
    await showSshAssignModal(id, 'instance');
    await renderSsh(panel, id);
  });

  panel.querySelectorAll('.revoke-ssh-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog(t('ssh.confirm_revoke'), '', { okLabel: t('ssh.revoked'), okClass: 'btn-danger' });
      if (!ok) return;
      try {
        await apiDelete(`/ssh/assignments/${btn.dataset.id}`);
        showToast(t('ssh.revoked'), 'success');
        await renderSsh(panel, id);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    });
  });
}

async function renderAudit(panel, id) {
  const logs = await apiGet(`/logs/audit?resource=/instances/${id}&category=write&limit=30`).catch(() => ({ items: [] }));
  const items = logs?.items || logs || [];
  if (!items.length) {
    panel.innerHTML = `<div style="text-align:center;padding:30px;color:var(--tblr-secondary);font-size:13px"><i class="ti ti-file-off" style="font-size:28px;display:block;margin-bottom:8px;opacity:.4"></i>${t('audit.no_results')}</div>`;
    return;
  }
  panel.innerHTML = `<div class="data-table" style="margin-top:8px">
    <table><thead><tr>
      <th>${t('audit.col_ts')}</th>
      <th>${t('audit.col_user')}</th>
      <th>${t('audit.col_action')}</th>
    </tr></thead><tbody>
    ${items.map(a => `<tr>
      <td style="white-space:nowrap;font-size:11px">${escapeHtml(a.timestamp ? new Date(a.timestamp+'Z').toLocaleString() : '—')}</td>
      <td>${escapeHtml(a.username || '—')}</td>
      <td>${actionLabel(a.method)}</td>
    </tr>`).join('')}
    </tbody></table></div>`;
}

export async function showSshAssignModal(targetId, targetType) {
  const keys = await apiGet('/ssh/keys').catch(() => []);
  if (!keys?.length) {
    showToast(t('ssh.no_keys'), 'warning');
    return;
  }
  const m = document.createElement('div');
  m.className = 'modal fade';
  m.innerHTML = `<div class="modal-dialog modal-sm modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${t('instance.assign_ssh')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div class="mb-3"><label class="form-label">${t('ssh.col_key')}</label>
          <select id="sa-key" class="form-select">
            ${keys.map(k => `<option value="${k.id}">${escapeHtml(k.name)}</option>`).join('')}
          </select></div>
        <div class="mb-3"><label class="form-label">${t('ssh.linux_user')}</label>
          <input type="text" id="sa-user" class="form-control" value="root" /></div>
        <div class="mb-3"><label class="form-label">${t('ssh.expires')}</label>
          <select id="sa-expires" class="form-select form-select-sm">
            <option value="">${t('ssh.expires_never')}</option>
            <option value="7d">${t('ssh.expires_7d')}</option>
            <option value="30d">${t('ssh.expires_30d')}</option>
          </select></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="sa-ok">${t('modal.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(m);
  const modal = new window.bootstrap.Modal(m);
  modal.show();
  m.querySelector('#sa-ok').addEventListener('click', async () => {
    const ssh_key_id = m.querySelector('#sa-key').value;
    const target_user = m.querySelector('#sa-user').value.trim() || 'root';
    const expiresVal = m.querySelector('#sa-expires').value;
    let expires_at = null;
    if (expiresVal) {
      const days = parseInt(expiresVal);
      const d = new Date();
      d.setDate(d.getDate() + days);
      expires_at = d.toISOString();
    }
    try {
      await apiPost('/ssh/assignments', { ssh_key_id, target_type: targetType, target_id: targetId, target_user, expires_at });
      showToast(t('ssh.assigned'), 'success');
      modal.hide();
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
  m.addEventListener('hidden.bs.modal', () => m.remove());
}
