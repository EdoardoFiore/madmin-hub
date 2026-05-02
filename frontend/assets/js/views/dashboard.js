import { apiGet } from '../api.js';
import { t } from '../i18n.js';
import { relativeTime, fmtDate, escapeHtml, actionLabel } from '../utils.js';
import { getUser } from '../app.js';

export async function render(container) {
  container.innerHTML = `
    <div class="hub-page-header">
      <div>
        <h1 class="hub-page-title">${t('dashboard.title')}</h1>
      </div>
      <button class="btn btn-sm btn-outline-secondary" id="dash-refresh">
        <i class="ti ti-refresh me-1"></i>${t('dashboard.refresh')}
      </button>
    </div>
    <div id="dash-content"><div class="hub-loader"></div></div>`;

  document.getElementById('dash-refresh')?.addEventListener('click', () => loadDashboard(container));
  await loadDashboard(container);
}

async function loadDashboard(container) {
  const el = document.getElementById('dash-content');
  if (!el) return;
  el.innerHTML = '<div class="hub-loader"></div>';

  try {
    const [fleet, alerts, health] = await Promise.all([
      apiGet('/dashboard/fleet'),
      apiGet('/dashboard/alerts').catch(() => []),
      apiGet('/health').catch(() => null),
    ]);

    const { total = 0, online = 0, offline = 0, groups_count = 0, active_tokens_count = 0,
            recent_activity = [] } = fleet || {};

    el.innerHTML = `
      <!-- Stat cards -->
      <div class="row g-3 mb-4">
        ${statCard(t('dashboard.total'),   total,          'ti-server',      'primary')}
        ${statCard(t('dashboard.online'),  online,         'ti-circle-check','success')}
        ${statCard(t('dashboard.offline'), offline,        'ti-circle-x',    'danger')}
        ${statCard(t('dashboard.groups'),  groups_count,   'ti-folders',     'warning')}
        ${statCard(t('dashboard.active_tokens'), active_tokens_count, 'ti-key', 'muted')}
      </div>

      <div class="row g-3">
        <!-- Left column: donut + activity -->
        <div class="col-lg-7">
          <!-- Fleet donut -->
          <div class="data-table mb-3" style="padding:20px">
            <div style="font-weight:600;font-size:14px;margin-bottom:16px">${t('dashboard.donut_label')}</div>
            ${total > 0
              ? `<div class="donut-wrap" style="height:200px"><div id="dash-donut"></div><div class="donut-center"><div class="num">${total}</div><div class="label">${t('dashboard.total')}</div></div></div>`
              : `<div class="data-table-empty"><i class="ti ti-server-off"></i>${t('dashboard.no_instances')}</div>`
            }
          </div>

          <!-- Recent activity -->
          <div class="data-table" style="padding:16px">
            <div style="font-weight:600;font-size:14px;margin-bottom:12px">${t('dashboard.activity')}</div>
            ${recent_activity.length
              ? `<div class="activity-feed">${recent_activity.slice(0, 15).map(a => activityItem(a)).join('')}</div>`
              : `<div style="text-align:center;padding:20px;color:var(--tblr-secondary);font-size:13px">${t('dashboard.no_activity')}</div>`
            }
          </div>
        </div>

        <!-- Right column: health + alerts + quick actions -->
        <div class="col-lg-5">
          <!-- System health -->
          <div class="data-table mb-3" style="padding:16px">
            <div style="font-weight:600;font-size:14px;margin-bottom:12px">${t('dashboard.health')}</div>
            ${healthCard(health)}
          </div>

          <!-- Alerts -->
          <div class="data-table mb-3" style="padding:16px">
            <div style="font-weight:600;font-size:14px;margin-bottom:12px">${t('dashboard.alerts')}</div>
            ${alertsPanel(alerts)}
          </div>

          <!-- Quick actions -->
          <div class="data-table" style="padding:16px">
            <div style="font-weight:600;font-size:14px;margin-bottom:12px">${t('dashboard.quick_actions')}</div>
            <div class="row g-2">
              ${quickAction('ti-key',       t('nav.enrollment'),  '#enrollment')}
              ${quickAction('ti-users',     t('nav.users'),       '#users')}
              ${quickAction('ti-server',    t('nav.instances'),   '#instances')}
              ${quickAction('ti-file-text', t('nav.audit'),       '#audit')}
            </div>
          </div>
        </div>
      </div>`;

    // Render donut
    if (total > 0 && window.ApexCharts) {
      const donutEl = document.getElementById('dash-donut');
      if (donutEl) {
        new window.ApexCharts(donutEl, {
          chart: { type: 'donut', width: 200, height: 200, sparkline: { enabled: true } },
          series: [online, offline],
          labels: [t('status.online'), t('status.offline')],
          colors: ['#2fb344', '#d63939'],
          legend: { show: false },
          dataLabels: { enabled: false },
          plotOptions: { pie: { donut: { size: '72%' } } },
          tooltip: { y: { formatter: v => v } },
        }).render();
      }
    }
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="alert alert-danger">${t('dashboard.load_error')}</div>`;
  }
}

function statCard(label, value, icon, color) {
  return `<div class="col-6 col-sm-4 col-xl">
    <div class="stat-card">
      <div class="stat-card-icon ${color}"><i class="ti ${icon}"></i></div>
      <div class="stat-card-body">
        <div class="stat-card-value">${value}</div>
        <div class="stat-card-label">${escapeHtml(label)}</div>
      </div>
    </div>
  </div>`;
}

function healthCard(health) {
  if (!health) return `<div style="font-size:13px;color:var(--tblr-secondary)">—</div>`;
  const ok = health.status === 'healthy';
  return `<div style="display:flex;flex-direction:column;gap:8px;font-size:13px">
    <div style="display:flex;justify-content:space-between">
      <span>Status</span>
      <span class="hub-badge ${ok ? 'online' : 'offline'}">${health.status}</span>
    </div>
    <div style="display:flex;justify-content:space-between">
      <span>Database</span>
      <span class="hub-badge ${health.database === 'connected' ? 'online' : 'offline'}">${health.database}</span>
    </div>
    <div style="display:flex;justify-content:space-between">
      <span>Version</span>
      <span style="color:var(--tblr-secondary)">${escapeHtml(health.version || '—')}</span>
    </div>
  </div>`;
}

function alertsPanel(alerts) {
  if (!alerts?.length) {
    return `<div style="text-align:center;padding:12px;color:var(--tblr-secondary);font-size:13px">${t('alerts.none')}</div>`;
  }
  return alerts.slice(0, 5).map(a => `
    <div class="alert-list-item ${a.severity}" style="margin-bottom:6px">
      <span class="alert-icon"><i class="ti ${severityIcon(a.severity)}"></i></span>
      <div>
        <div style="font-size:13px;font-weight:500">${escapeHtml(a.label)}</div>
        <div style="font-size:11px;color:var(--tblr-secondary)">${a.type}</div>
      </div>
    </div>`).join('');
}

function activityItem(a) {
  return `<div class="activity-feed-item">
    <div class="activity-feed-icon">${actionLabel(a.method)}</div>
    <div class="activity-feed-text">
      <strong>${escapeHtml(a.username || '—')}</strong> ${escapeHtml(a.path || '')}
      <div class="activity-feed-time">${relativeTime(a.timestamp)}</div>
    </div>
  </div>`;
}

function quickAction(icon, label, href) {
  return `<div class="col-6">
    <a href="${href}" class="quick-action">
      <i class="ti ${icon}"></i>
      <span>${escapeHtml(label)}</span>
    </a>
  </div>`;
}

function severityIcon(s) {
  return s === 'danger' ? 'ti-alert-circle' : s === 'warning' ? 'ti-alert-triangle' : 'ti-info-circle';
}
