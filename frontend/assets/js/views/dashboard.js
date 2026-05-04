import { apiGet } from '../api.js';
import { t } from '../i18n.js';
import { relativeTime, fmtDate, escapeHtml } from '../utils.js';
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

    const { summary = {}, recent_activity = [] } = fleet || {};
    const { total = 0, online = 0, offline = 0,
            groups: groups_count = 0, active_tokens: active_tokens_count = 0 } = summary;

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
            ${(online > 0 || offline > 0)
              ? `<div class="donut-wrap" style="height:200px"><div id="dash-donut"></div><div class="donut-center"><div class="num">${total}</div><div class="label">${t('dashboard.total')}</div></div></div>`
              : `<div class="data-table-empty"><i class="ti ti-server-off"></i>${t('dashboard.no_instances')}</div>`
            }
          </div>

          <!-- Recent activity -->
          <div class="data-table" style="padding:16px">
            <div style="font-weight:600;font-size:14px;margin-bottom:12px">${t('dashboard.activity')}</div>
            ${recent_activity.length
              ? `<div class="activity-feed" style="max-height:320px;overflow-y:auto">${recent_activity.slice(0, 15).map(a => activityItem(a)).join('')}</div>`
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

    // Render donut — guard against zero-value series (causes ApexCharts SVG NaN errors)
    if ((online > 0 || offline > 0) && window.ApexCharts) {
      const donutEl = document.getElementById('dash-donut');
      if (donutEl) {
        new window.ApexCharts(donutEl, {
          chart: { type: 'donut', width: 200, height: 200, sparkline: { enabled: true } },
          series: [Math.max(online, 0.01), Math.max(offline, 0.01)],
          labels: [t('status.online'), t('status.offline')],
          colors: ['#2fb344', '#d63939'],
          legend: { show: false },
          dataLabels: { enabled: false },
          plotOptions: { pie: { donut: { size: '72%' } } },
          tooltip: { y: { formatter: v => Math.round(v) } },
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

function tryParseBody(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

function humanizeActivity(a) {
  const m = a.method;
  const p = a.path;
  const body = tryParseBody(a.body);
  const segs = p.replace(/^\/api\//, '').split('/');

  const name = body?.name ? ` <span class="text-muted fst-italic">"${escapeHtml(body.name)}"</span>` : '';

  // Instances
  if (p === '/api/agents/enroll')
    return { icon: 'ti-server', text: t('activity.instance_enrolled') };
  if (segs[0] === 'instances' && segs[2] === 'tags')
    return { icon: 'ti-tag', text: t('activity.instance_tags') };
  if (p === '/api/instances/bulk')
    return { icon: 'ti-server', text: t('activity.instance_bulk') };
  if (segs[0] === 'instances' && segs[1] && m === 'PATCH')
    return { icon: 'ti-server', text: t('activity.instance_updated') };
  if (segs[0] === 'instances' && segs[1] && m === 'DELETE')
    return { icon: 'ti-server', text: t('activity.instance_deleted') };

  // Groups
  if (segs[0] === 'groups' && m === 'POST')
    return { icon: 'ti-folders', text: t('activity.group_created') + name };
  if (segs[0] === 'groups' && m === 'PATCH')
    return { icon: 'ti-folders', text: t('activity.group_updated') + name };
  if (segs[0] === 'groups' && m === 'DELETE')
    return { icon: 'ti-folders', text: t('activity.group_deleted') };

  // Enrollment tokens
  if (segs[0] === 'enrollment' && segs[1] === 'tokens' && m === 'POST')
    return { icon: 'ti-key', text: t('activity.token_created') + name };
  if (segs[0] === 'enrollment' && segs[1] === 'tokens' && m === 'DELETE')
    return { icon: 'ti-key', text: t('activity.token_revoked') };

  // Tags
  if (segs[0] === 'tags' && m === 'POST')
    return { icon: 'ti-tag', text: t('activity.tag_created') + name };
  if (segs[0] === 'tags' && m === 'PATCH')
    return { icon: 'ti-tag', text: t('activity.tag_updated') + name };
  if (segs[0] === 'tags' && m === 'DELETE')
    return { icon: 'ti-tag', text: t('activity.tag_deleted') };

  // SSH
  if (segs[0] === 'ssh' && segs[1] === 'keys' && m === 'POST')
    return { icon: 'ti-lock', text: t('activity.ssh_key_added') + name };
  if (segs[0] === 'ssh' && segs[1] === 'keys' && m === 'PATCH')
    return { icon: 'ti-lock', text: t('activity.ssh_key_updated') };
  if (segs[0] === 'ssh' && segs[1] === 'keys' && m === 'DELETE')
    return { icon: 'ti-lock', text: t('activity.ssh_key_deleted') };
  if (segs[0] === 'ssh' && segs[1] === 'assignments' && m === 'POST')
    return { icon: 'ti-lock', text: t('activity.ssh_assigned') };
  if (segs[0] === 'ssh' && segs[1] === 'assignments' && m === 'DELETE')
    return { icon: 'ti-lock', text: t('activity.ssh_revoked') };

  // Users (admin ops on other users)
  if (segs[0] === 'auth' && segs[1] === 'users' && segs[3] === '2fa' && m === 'DELETE')
    return { icon: 'ti-shield', text: t('activity.user_2fa_reset', { who: segs[2] }) };
  if (segs[0] === 'auth' && segs[1] === 'users' && segs[3] === 'permissions')
    return { icon: 'ti-user', text: t('activity.user_perms', { who: segs[2] }) };
  if (segs[0] === 'auth' && segs[1] === 'users' && !segs[2] && m === 'POST')
    return { icon: 'ti-user', text: t('activity.user_created', { who: body?.username || '—' }) };
  if (segs[0] === 'auth' && segs[1] === 'users' && segs[2] && m === 'PATCH')
    return { icon: 'ti-user', text: t('activity.user_updated', { who: segs[2] }) };
  if (segs[0] === 'auth' && segs[1] === 'users' && segs[2] && m === 'DELETE')
    return { icon: 'ti-user', text: t('activity.user_deleted', { who: segs[2] }) };

  // Own account
  if (segs[0] === 'auth' && segs[1] === 'me' && segs[2] === 'password')
    return { icon: 'ti-shield', text: t('activity.me_password') };
  if (segs[0] === 'auth' && segs[1] === 'me' && segs[3] === 'enable')
    return { icon: 'ti-shield', text: t('activity.me_2fa_enabled') };
  if (segs[0] === 'auth' && segs[1] === 'me' && segs[2] === '2fa' && m === 'DELETE')
    return { icon: 'ti-shield', text: t('activity.me_2fa_disabled') };

  // Settings
  if (p === '/api/settings/smtp/test')
    return { icon: 'ti-mail', text: t('activity.smtp_test') };
  if (p === '/api/settings/smtp')
    return { icon: 'ti-mail', text: t('activity.smtp_configured') };
  if (p === '/api/settings/system')
    return { icon: 'ti-settings', text: t('activity.settings_updated') };

  // Filter login noise
  if (p === '/api/auth/token' || p === '/api/auth/token/2fa') return null;

  return { icon: 'ti-activity', text: `${m} ${escapeHtml(p)}` };
}

function activityItem(a) {
  const h = humanizeActivity(a);
  if (!h) return '';
  return `<div class="activity-feed-item">
    <div class="activity-feed-icon"><i class="ti ${h.icon}"></i></div>
    <div class="activity-feed-text">
      <strong>${escapeHtml(a.username || '—')}</strong> ${h.text}
      <div class="activity-feed-time">${relativeTime(a.ts)}</div>
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
