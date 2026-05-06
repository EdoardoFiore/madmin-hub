/**
 * MADMIN Hub — app boot.
 * Flow: check token → getCurrentUser → applyTheme → loadBranding → buildSidebar → buildTopbar → router.start()
 */
import { getCurrentUser, logout, apiGet } from './api.js';
import { t, getLang, setLang } from './i18n.js';
import { loadBranding, applyBranding } from './branding.js';
import { start as routerStart } from './router.js';
import { initDrawer } from './shell/drawer.js';
import { debounce } from './utils.js';

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
  const lblAccount = document.getElementById('lbl-account');
  if (lblAccount) lblAccount.textContent = t('topbar.profile');
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

  // Profile
  document.getElementById('dd-account')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const { openProfileModal } = await import('./views/profile_modal.js');
    openProfileModal();
  });

  // Logout
  document.getElementById('dd-logout')?.addEventListener('click', (e) => {
    e.preventDefault(); logout();
  });

  // Alerts
  initAlerts();

  // Omnisearch
  if (searchEl) {
    searchEl.placeholder = t('search.placeholder');
    let _cache = null;
    let _lastResults = [];
    let _activeIdx = -1;

    const wrap = document.getElementById('topbar-search-wrap');
    const dropdown = document.createElement('div');
    dropdown.id = 'omni-dropdown';
    dropdown.style.cssText = [
      'display:none;position:absolute;z-index:9999',
      'width:100%',
      'background:var(--hub-surface,#fff)',
      'border:1px solid var(--hub-border)',
      'border-radius:var(--hub-radius)',
      'box-shadow:0 8px 32px rgba(0,0,0,.16)',
      'max-height:480px;overflow-y:auto',
      'top:calc(100% + 6px);left:0',
    ].join(';');
    if (wrap) wrap.appendChild(dropdown);

    const NAV_ITEMS = [
      ...SECTIONS.flatMap(s => s.items),
      ...FOOTER_ITEMS,
    ].filter(item => hasPermission(user, item.perm));

    async function ensureCache() {
      if (_cache) return;
      const [instances, groups, sshKeys] = await Promise.all([
        apiGet('/instances').catch(() => []),
        apiGet('/groups').catch(() => []),
        apiGet('/ssh/keys').catch(() => []),
      ]);
      const tagMap = new Map();
      (instances || []).forEach(inst => {
        (inst.tags || []).forEach(tg => {
          const name = typeof tg === 'string' ? tg : tg.name;
          const color = typeof tg === 'object' ? (tg.color || '#adb5bd') : '#adb5bd';
          if (!tagMap.has(name)) tagMap.set(name, { name, color });
        });
      });
      _cache = { instances: instances || [], groups: groups || [], tags: [...tagMap.values()], sshKeys: sshKeys || [] };
    }

    function buildResults(q) {
      const ql = q.toLowerCase();
      const res = [];
      const inst = _cache.instances.filter(i => (i.name||'').toLowerCase().includes(ql) || (i.ip_address||'').toLowerCase().includes(ql)).slice(0, 3);
      if (inst.length) { res.push({ type:'cat', catType:'instance', label: t('search.cat_instances') }); inst.forEach(i => res.push({ type:'instance', id:i.id, label:i.name||i.id, sub:i.ip_address||'' })); }
      const grps = _cache.groups.filter(g => g.name.toLowerCase().includes(ql)).slice(0, 3);
      if (grps.length) { res.push({ type:'cat', catType:'group', label: t('search.cat_groups') }); grps.forEach(g => res.push({ type:'group', id:g.id, label:g.name, color:g.color })); }
      const tags = _cache.tags.filter(tg => tg.name.toLowerCase().includes(ql)).slice(0, 3);
      if (tags.length) { res.push({ type:'cat', catType:'tag', label: t('search.cat_tags') }); tags.forEach(tg => res.push({ type:'tag', name:tg.name, label:tg.name, color:tg.color })); }
      const menu = NAV_ITEMS.filter(item => t(item.key).toLowerCase().includes(ql)).slice(0, 3);
      if (menu.length) { res.push({ type:'cat', catType:'menu', label: t('search.cat_menu') }); menu.forEach(item => res.push({ type:'menu', route:item.route, label:t(item.key), icon:item.icon })); }
      const keys = _cache.sshKeys.filter(k => k.name.toLowerCase().includes(ql)).slice(0, 3);
      if (keys.length) { res.push({ type:'cat', catType:'sshkey', label: t('search.cat_ssh') }); keys.forEach(k => res.push({ type:'sshkey', id:k.id, label:k.name, sub:k.fingerprint||'' })); }
      return res;
    }

    const _typeColor = {
      instance: 'var(--tblr-azure,#4299e1)',
      group:    'var(--tblr-purple,#ae3ec9)',
      tag:      'var(--tblr-green,#2fb344)',
      menu:     'var(--tblr-secondary,#6c757d)',
      sshkey:   'var(--tblr-orange,#f76707)',
    };

    function renderDropdown(results) {
      _activeIdx = -1;
      if (!results.length) {
        dropdown.innerHTML = `<div style="padding:14px 16px;font-size:13px;color:var(--tblr-secondary);text-align:center">${t('search.no_results')}</div>`;
        dropdown.style.display = 'block';
        return;
      }
      let firstCat = true;
      dropdown.innerHTML = results.map((r, i) => {
        if (r.type === 'cat') {
          const color = _typeColor[r.catType] || 'var(--tblr-secondary)';
          const sep = firstCat ? '' : `<div style="height:1px;background:var(--hub-border);margin:4px 0"></div>`;
          firstCat = false;
          return `${sep}<div style="padding:8px 14px 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${color};border-left:3px solid ${color};margin-left:6px;padding-left:10px">${escHtml(r.label)}</div>`;
        }
        const icon = r.type==='instance'?'ti-server':r.type==='group'?'ti-folders':r.type==='tag'?'ti-tag':r.type==='menu'?(r.icon||'ti-layout-dashboard'):'ti-key';
        const iconColor = _typeColor[r.type] || 'var(--tblr-secondary)';
        return `<div class="omni-result" data-idx="${i}" style="position:relative;padding:8px 14px 8px 40px;cursor:pointer;font-size:13px;transition:background .1s;line-height:1.4">
          <i class="ti ${escHtml(icon)}" style="position:absolute;left:13px;top:50%;transform:translateY(-50%);font-size:15px;color:${iconColor};line-height:1"></i>
          <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.label)}</div>
          ${r.sub ? `<div style="font-size:11px;color:var(--tblr-secondary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.sub)}</div>` : ''}
        </div>`;
      }).join('');
      dropdown.innerHTML += `<div style="height:6px"></div>`;
      dropdown.style.display = 'block';
      dropdown.querySelectorAll('.omni-result').forEach(el => {
        el.addEventListener('mouseenter', () => setActive(parseInt(el.dataset.idx)));
        el.addEventListener('click', () => selectResult(_lastResults[parseInt(el.dataset.idx)]));
      });
    }

    function setActive(idx) {
      _activeIdx = idx;
      dropdown.querySelectorAll('.omni-result').forEach(el => {
        el.style.background = parseInt(el.dataset.idx) === idx ? 'var(--hub-surface-2, rgba(0,0,0,.05))' : '';
      });
    }

    function navigateTo(hash) {
      if (window.location.hash === '#' + hash) window.dispatchEvent(new Event('hashchange'));
      else window.location.hash = hash;
    }

    function selectResult(r) {
      if (!r || r.type === 'cat') return;
      dropdown.style.display = 'none';
      searchEl.value = '';
      searchEl.blur();
      if (r.type === 'instance')   { navigateTo(`instances/${r.id}`); }
      else if (r.type === 'group') { window.__pendingGroupFilter = r.id; navigateTo('instances'); }
      else if (r.type === 'tag')   { window.__pendingTagFilter = r.name; navigateTo('instances'); }
      else if (r.type === 'menu')  { navigateTo(r.route); }
      else if (r.type === 'sshkey') { window.__pendingKeyFocus = r.id; navigateTo('inventory/ssh'); }
    }

    const debouncedSearch = debounce(async (q) => {
      if (q.length < 2) { dropdown.style.display = 'none'; return; }
      await ensureCache();
      _lastResults = buildResults(q);
      renderDropdown(_lastResults);
    }, 200);

    searchEl.addEventListener('input', e => debouncedSearch(e.target.value.trim()));
    searchEl.addEventListener('keydown', e => {
      if (dropdown.style.display === 'none') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = _lastResults.findIndex((r, i) => i > _activeIdx && r.type !== 'cat');
        if (next >= 0) setActive(next);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        let prev = -1;
        for (let i = _activeIdx - 1; i >= 0; i--) { if (_lastResults[i]?.type !== 'cat') { prev = i; break; } }
        if (prev >= 0) setActive(prev);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_activeIdx >= 0) selectResult(_lastResults[_activeIdx]);
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
      }
    });
    document.addEventListener('click', e => { if (wrap && !wrap.contains(e.target)) dropdown.style.display = 'none'; });
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
