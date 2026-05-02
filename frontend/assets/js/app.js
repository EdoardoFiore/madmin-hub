/**
 * MADMIN Hub — app boot.
 * Flow: check token → getCurrentUser → applyTheme → loadBranding → buildSidebar → buildTopbar → router.start()
 */
import { getCurrentUser, logout, apiGet } from './api.js';
import { t, getLang, setLang } from './i18n.js';
import { loadBranding, applyBranding } from './branding.js';
import { start as routerStart } from './router.js';
import { initDrawer } from './shell/drawer.js';

const TOKEN_KEY = 'hub_token';

let _user = null;

export function getUser() { return _user; }

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(user) {
  try {
    const prefs = typeof user.preferences === 'string'
      ? JSON.parse(user.preferences || '{}')
      : (user.preferences || {});
    if (prefs.dark_mode) {
      document.documentElement.setAttribute('data-bs-theme', 'dark');
      const icon = document.getElementById('theme-icon');
      if (icon) { icon.className = 'ti ti-moon'; }
    }
  } catch (_) {}
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  document.documentElement.setAttribute('data-bs-theme', isDark ? 'light' : 'dark');
  const icon = document.getElementById('theme-icon');
  if (icon) icon.className = isDark ? 'ti ti-sun' : 'ti ti-moon';
  if (_user) {
    try {
      const prefs = typeof _user.preferences === 'string'
        ? JSON.parse(_user.preferences || '{}')
        : (_user.preferences || {});
      prefs.dark_mode = !isDark;
      _user.preferences = prefs;
    } catch (_) {}
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

const SECTIONS = [
  {
    items: [
      { route: 'dashboard', icon: 'ti-layout-dashboard', key: 'nav.dashboard' },
    ],
  },
  {
    header: 'nav.section.infrastructure',
    items: [
      { route: 'instances', icon: 'ti-server',  key: 'nav.instances' },
      { route: 'groups',    icon: 'ti-folders', key: 'nav.groups' },
      { route: 'inventory', icon: 'ti-tags',    key: 'nav.inventory' },
    ],
  },
  {
    header: 'nav.section.provisioning',
    items: [
      { route: 'enrollment', icon: 'ti-key', key: 'nav.enrollment', perm: 'hub.manage' },
    ],
  },
  {
    header: 'nav.section.access',
    items: [
      { route: 'users', icon: 'ti-users', key: 'nav.users', perm: 'users.view' },
    ],
  },
  {
    header: 'nav.section.observability',
    items: [
      { route: 'audit', icon: 'ti-file-text', key: 'nav.audit', perm: 'logs.view' },
    ],
  },
];

const FOOTER_ITEMS = [
  { route: 'settings', icon: 'ti-settings', key: 'nav.settings', perm: 'settings.view' },
];

function hasPermission(user, perm) {
  if (!perm) return true;
  if (user.is_superuser) return true;
  return Array.isArray(user.permissions) && user.permissions.includes(perm);
}

function buildSidebar(user) {
  const nav = document.getElementById('sidebar-nav');
  const footer = document.getElementById('sidebar-footer');
  if (!nav) return;

  nav.innerHTML = '';

  for (const section of SECTIONS) {
    const visible = section.items.filter(item => hasPermission(user, item.perm));
    if (!visible.length) continue;

    if (section.header) {
      nav.insertAdjacentHTML('beforeend',
        `<div class="hub-nav-section">${t(section.header)}</div>`);
    }

    for (const item of visible) {
      nav.insertAdjacentHTML('beforeend', `
        <a class="hub-nav-item" href="#${item.route}" data-route="${item.route}">
          <i class="ti ${item.icon}"></i>
          <span class="hub-nav-item-label">${t(item.key)}</span>
        </a>`);
    }
  }

  if (footer) {
    footer.innerHTML = '';
    for (const item of FOOTER_ITEMS) {
      if (!hasPermission(user, item.perm)) continue;
      footer.insertAdjacentHTML('beforeend', `
        <a class="hub-nav-item" href="#${item.route}" data-route="${item.route}">
          <i class="ti ${item.icon}"></i>
          <span class="hub-nav-item-label">${t(item.key)}</span>
        </a>`);
    }
  }
}

// ── Topbar ────────────────────────────────────────────────────────────────────

function buildTopbar(user) {
  const nameEl   = document.getElementById('user-name-display');
  const roleEl   = document.getElementById('user-role-display');
  const avatarEl = document.getElementById('user-avatar');
  const ddName   = document.getElementById('dd-username');
  const ddEmail  = document.getElementById('dd-email');
  const lbl      = document.getElementById('lbl-logout');
  const searchEl = document.getElementById('topbar-search');

  if (nameEl) nameEl.textContent = user.username;
  if (roleEl) roleEl.textContent = user.is_superuser ? 'Admin' : t('users.role_user');
  if (avatarEl) avatarEl.textContent = (user.username || 'U').charAt(0).toUpperCase();
  if (ddName) ddName.textContent = user.username;
  if (ddEmail && user.email) ddEmail.textContent = user.email;
  if (lbl) lbl.textContent = t('user.logout');
  if (searchEl) searchEl.placeholder = t('topbar.search_placeholder');

  document.getElementById('lbl-alerts-title')?.textContent && (document.getElementById('lbl-alerts-title').textContent = t('alerts.title'));

  // Sidebar collapse toggle
  const toggle = document.getElementById('topbar-toggle');
  if (toggle) {
    toggle.onclick = () => {
      const shell = document.getElementById('hub-shell');
      if (window.innerWidth <= 992) {
        shell.classList.toggle('mobile-open');
      } else {
        const collapsed = shell.classList.toggle('collapsed');
        try {
          const prefs = typeof _user.preferences === 'string'
            ? JSON.parse(_user.preferences || '{}')
            : (_user.preferences || {});
          prefs.sidebar_collapsed = collapsed;
          _user.preferences = prefs;
        } catch (_) {}
      }
    };
  }

  // Restore collapsed state
  try {
    const prefs = typeof user.preferences === 'string'
      ? JSON.parse(user.preferences || '{}')
      : (user.preferences || {});
    if (prefs.sidebar_collapsed) document.getElementById('hub-shell')?.classList.add('collapsed');
  } catch (_) {}

  // Mobile backdrop
  document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
    document.getElementById('hub-shell')?.classList.remove('mobile-open');
  });

  // Theme toggle
  document.getElementById('topbar-theme-btn')?.addEventListener('click', toggleTheme);

  // Language toggle
  const langBtn = document.getElementById('topbar-lang-btn');
  if (langBtn) {
    const cur = getLang();
    langBtn.textContent = cur === 'it' ? 'EN' : 'IT';
    langBtn.title = cur === 'it' ? 'Switch to English' : "Passa all'italiano";
    langBtn.onclick = () => {
      setLang(cur === 'it' ? 'en' : 'it');
      window.location.reload();
    };
  }

  // Logout
  document.getElementById('dd-logout')?.addEventListener('click', (e) => {
    e.preventDefault(); logout();
  });

  // Alerts
  initAlerts();

  // Search (client-side nav — type to jump)
  if (searchEl) {
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = searchEl.value.trim().toLowerCase();
        if (!q) return;
        const routes = ['instances', 'groups', 'users', 'audit', 'enrollment', 'inventory', 'settings', 'dashboard'];
        const match = routes.find(r => r.startsWith(q));
        if (match) { window.location.hash = match; searchEl.value = ''; searchEl.blur(); }
      }
    });
  }
}

// ── Alerts polling ────────────────────────────────────────────────────────────

let _alertsOpen = false;
let _alertsTimer = null;

function initAlerts() {
  const btn = document.getElementById('topbar-alerts-btn');
  const panel = document.getElementById('alerts-panel');
  const backdrop = document.getElementById('alerts-backdrop');
  const closeBtn = document.getElementById('alerts-close');

  function openAlerts() {
    _alertsOpen = true;
    if (panel) panel.style.transform = 'translateX(0)';
    if (backdrop) { backdrop.style.opacity = '1'; backdrop.style.pointerEvents = 'auto'; }
    fetchAlerts();
  }

  function closeAlerts() {
    _alertsOpen = false;
    if (panel) panel.style.transform = 'translateX(120%)';
    if (backdrop) { backdrop.style.opacity = '0'; backdrop.style.pointerEvents = 'none'; }
  }

  btn?.addEventListener('click', () => _alertsOpen ? closeAlerts() : openAlerts());
  closeBtn?.addEventListener('click', closeAlerts);
  backdrop?.addEventListener('click', closeAlerts);

  // Poll every 60s when visible
  async function pollAlerts() {
    if (!document.hidden) await fetchAlertsCount();
    _alertsTimer = setTimeout(pollAlerts, 60000);
  }
  fetchAlertsCount();
  pollAlerts();
}

async function fetchAlertsCount() {
  try {
    const alerts = await apiGet('/dashboard/alerts');
    const count = Array.isArray(alerts) ? alerts.length : 0;
    const el = document.getElementById('alerts-count');
    if (el) { el.textContent = count; el.style.display = count ? '' : 'none'; }
  } catch (_) {}
}

async function fetchAlerts() {
  const list = document.getElementById('alerts-list');
  if (!list) return;
  list.innerHTML = '<div class="hub-loader"></div>';
  try {
    const alerts = await apiGet('/dashboard/alerts');
    if (!alerts?.length) {
      list.innerHTML = `<div style="text-align:center;color:var(--tblr-secondary);padding:20px;font-size:13px">${t('alerts.none')}</div>`;
      return;
    }
    list.innerHTML = alerts.map(a => `
      <div class="alert-list-item ${a.severity}">
        <span class="alert-icon"><i class="ti ${severityIcon(a.severity)}"></i></span>
        <div>
          <div style="font-size:13px;font-weight:500">${escHtml(a.label)}</div>
          <div style="font-size:11px;color:var(--tblr-secondary)">${a.ref_type} · ${a.type}</div>
        </div>
      </div>`).join('');
  } catch (_) {
    list.innerHTML = `<div style="text-align:center;color:var(--hub-status-offline);font-size:13px;padding:16px">${t('msg.error')}</div>`;
  }
}

function severityIcon(s) {
  return s === 'danger' ? 'ti-alert-circle' : s === 'warning' ? 'ti-alert-triangle' : 'ti-info-circle';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  document.documentElement.lang = getLang();

  if (!localStorage.getItem(TOKEN_KEY)) {
    window.location.href = '/login';
    return;
  }

  try {
    _user = await getCurrentUser();
    if (!_user) { window.location.href = '/login'; return; }
  } catch (_) {
    window.location.href = '/login';
    return;
  }

  applyTheme(_user);
  await loadBranding();
  buildSidebar(_user);
  buildTopbar(_user);
  initDrawer();

  routerStart();
}

init();
