import { apiGet, apiPost } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, relativeTime, fmtDate, showToast, formatBytes, fmtPercent, actionLabel } from '../utils.js';

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

  const group = inst.group_id ? await apiGet(`/groups/${inst.group_id}`).catch(() => null) : null;

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;font-size:13px">
      ${infoRow(t('instance.id'),            `<span class="text-mono">${escapeHtml(inst.id)}</span>`)}
      ${infoRow(t('label.status'),           statusBadge(inst.ws_connected, inst.enrollment_status))}
      ${infoRow(t('instances.col_version'),  `<span class="text-mono">${escapeHtml(inst.version || '—')}</span>`)}
      ${infoRow('IP',                        escapeHtml(inst.ip_address || '—'))}
      ${infoRow(t('instances.col_contact'),  relativeTime(inst.last_seen_at))}
      ${infoRow(t('instance.fingerprint'),   `<span class="text-mono" style="font-size:11px;word-break:break-all">${escapeHtml(inst.fingerprint || '—')}</span>`)}
      ${infoRow(t('instance.enroll_status'), escapeHtml(inst.enrollment_status || '—'))}
      ${infoRow(t('label.group'),            group ? `<span class="group-badge" style="border-color:${escapeHtml(group.color||'#adb5bd')}">${escapeHtml(group.name)}</span>` : '—')}
    </div>

    <!-- Telemetry chart -->
    <div style="margin-top:20px">
      <div style="font-weight:600;font-size:13px;margin-bottom:12px">${t('instance.telemetry')}</div>
      <div id="idr-tele-bars"></div>
      <div id="idr-chart" style="margin-top:12px"></div>
    </div>`;

  // Load and render telemetry
  try {
    const tele = await apiGet(`/instances/${id}/telemetry?limit=1`);
    const latest = Array.isArray(tele) ? tele[0] : null;
    if (latest) {
      const bars = document.getElementById('idr-tele-bars');
      if (bars) {
        bars.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${teleBar('CPU', fmtPercent(latest.cpu_percent), latest.cpu_percent)}
            ${teleBar('RAM', fmtPercent(latest.memory_percent), latest.memory_percent)}
            ${teleBar(t('instance.disk'), fmtPercent(latest.disk_percent), latest.disk_percent)}
            ${teleBar('Net ↑', formatBytes((latest.net_sent_bytes || 0) / 60) + '/s', 0)}
          </div>`;
      }
    }
    // Timeseries chart
    const series = await apiGet(`/instances/${id}/telemetry?limit=20`);
    if (Array.isArray(series) && series.length > 1 && window.ApexCharts) {
      const cats = series.map(p => fmtDate(p.timestamp));
      new window.ApexCharts(document.getElementById('idr-chart'), {
        chart: { type: 'line', height: 140, toolbar: { show: false }, sparkline: { enabled: false } },
        series: [
          { name: 'CPU %', data: series.map(p => +(p.cpu_percent || 0).toFixed(1)) },
          { name: 'RAM %', data: series.map(p => +(p.memory_percent || 0).toFixed(1)) },
        ],
        xaxis: { categories: cats, labels: { show: false } },
        yaxis: { min: 0, max: 100, labels: { formatter: v => v + '%' } },
        stroke: { width: 2, curve: 'smooth' },
        colors: ['#206bc4', '#2fb344'],
        legend: { show: true, position: 'top', fontSize: '11px' },
        grid: { borderColor: 'var(--hub-border)' },
        tooltip: { theme: document.documentElement.getAttribute('data-bs-theme') },
      }).render();
    }
  } catch (_) {}
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

async function renderActions(panel, id, inst) {
  if (!inst) inst = await apiGet(`/instances/${id}`);
  const online = inst?.ws_connected;

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;padding-top:4px">
      <button class="btn btn-outline-primary" id="act-reload">
        <i class="ti ti-refresh me-2"></i>${t('instance.cmd_reload')}
      </button>
      <button class="btn btn-outline-secondary" id="act-backup">
        <i class="ti ti-cloud-upload me-2"></i>${t('instance.cmd_backup')}
      </button>
    </div>
    <div id="act-result" style="margin-top:12px"></div>`;

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
}

async function renderSsh(panel, id) {
  const assignments = await apiGet(`/ssh/assignments?instance_id=${id}`).catch(() => []);
  if (!assignments?.length) {
    panel.innerHTML = `<div style="text-align:center;padding:30px;color:var(--tblr-secondary);font-size:13px"><i class="ti ti-lock" style="font-size:28px;display:block;margin-bottom:8px;opacity:.4"></i>${t('ssh.none_assign')}</div>`;
    return;
  }
  panel.innerHTML = `<div class="data-table" style="margin-top:8px">
    <table><thead><tr>
      <th>${t('ssh.col_key')}</th>
      <th>${t('ssh.col_user')}</th>
      <th>${t('ssh.col_status')}</th>
    </tr></thead><tbody>
    ${assignments.map(a => `<tr>
      <td>${escapeHtml(a.key_name || a.ssh_key_id)}</td>
      <td><span class="text-mono">${escapeHtml(a.linux_user || '—')}</span></td>
      <td><span class="hub-badge ${a.status}">${escapeHtml(a.status)}</span></td>
    </tr>`).join('')}
    </tbody></table></div>`;
}

async function renderAudit(panel, id) {
  const logs = await apiGet(`/logs/audit?resource=/instances/${id}&limit=30`).catch(() => ({ items: [] }));
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
