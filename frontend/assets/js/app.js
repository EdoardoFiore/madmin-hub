/**
 * MADMIN Hub SPA — hash-based router, auth guard, sidebar.
 */
import { getCurrentUser, logout } from './api.js';
import { t, getLang, setLang } from './i18n.js';

const TOKEN_KEY = 'hub_token';

// ── Route → view module map ───────────────────────────────────────────────────
const ROUTES = {
  dashboard:     () => import('./views/dashboard.js'),
  instances:     () => import('./views/instances.js'),
  instance:      () => import('./views/instance_detail.js'),
  groups:        () => import('./views/groups.js'),
  enrollment:    () => import('./views/enrollment.js'),
  'ssh-keys':    () => import('./views/ssh_keys.js'),
  users:         () => import('./views/users.js'),
  settings:      () => import('./views/settings.js'),
  audit:         () => import('./views/audit.js'),
};

// ── Menu definition ──────────────────────────────────────────────────────────
const MENU = [
  { key: 'nav.dashboard',  icon: 'ti-home',       route: 'dashboard' },
  { key: 'nav.instances',  icon: 'ti-server',     route: 'instances' },
  { key: 'nav.groups',     icon: 'ti-folders',    route: 'groups' },
  { key: 'nav.enrollment', icon: 'ti-key',        route: 'enrollment', perm: 'hub.manage' },
  { key: 'nav.ssh_keys',   icon: 'ti-lock-open',  route: 'ssh-keys',   perm: 'hub.ssh' },
  null, // divider
  { key: 'nav.users',      icon: 'ti-users',      route: 'users',      perm: 'users.view' },
  { key: 'nav.audit',      icon: 'ti-file-text',  route: 'audit',      perm: 'logs.view' },
  { key: 'nav.settings',   icon: 'ti-settings',   route: 'settings',   perm: 'settings.view' },
];

let currentUser = null;
const container = document.getElementById('main-content');

// ── Router ────────────────────────────────────────────────────────────────────

function parseRoute() {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  const [route, ...params] = hash.split('/');
  return { route, params };
}

async function navigate() {
  const { route, params } = parseRoute();
  const loader = ROUTES[route];

  if (!loader) {
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-warning">${t('app.view_not_found', { name: route })}</div></div>`;
    return;
  }

  setActiveMenu(route);

  try {
    const mod = await loader();
    await mod.render(container, params);
  } catch (err) {
    console.error('Route render error:', err);
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-danger">${t('app.view_load_error')}</div></div>`;
  }
}

window.addEventListener('hashchange', navigate);

// ── Sidebar ───────────────────────────────────────────────────────────────────

function buildMenu(user) {
  const ul = document.getElementById('sidebar-nav');
  if (!ul) return;
  ul.innerHTML = '';

  for (const item of MENU) {
    if (item === null) {
      ul.insertAdjacentHTML('beforeend', '<li class="nav-item mt-2"><hr class="my-1" /></li>');
      continue;
    }
    if (item.perm && !user.is_superuser && !user.permissions.includes(item.perm)) continue;
    ul.insertAdjacentHTML('beforeend', `
      <li class="nav-item" id="nav-${item.route}">
        <a class="nav-link" href="#${item.route}">
          <span class="nav-link-icon d-md-none d-lg-flex">
            <i class="ti ${item.icon}"></i>
          </span>
          <span class="nav-link-title">${t(item.key)}</span>
        </a>
      </li>`);
  }
}

function setActiveMenu(route) {
  document.querySelectorAll('#sidebar-nav .nav-link').forEach(el => el.classList.remove('active'));
  const li = document.getElementById(`nav-${route}`);
  if (li) li.querySelector('.nav-link').classList.add('active');
}

// ── Dark mode ─────────────────────────────────────────────────────────────────

function applyTheme(user) {
  try {
    const prefs = JSON.parse(user.preferences || '{}');
    if (prefs.dark_mode) {
      document.documentElement.setAttribute('data-bs-theme', 'dark');
    }
  } catch (_) {}
}

// ── Username badge ────────────────────────────────────────────────────────────

function renderUserBadge(user) {
  const el = document.getElementById('user-badge');
  if (el) el.textContent = user.username;
  const label = document.getElementById('sidebar-connectedas');
  if (label) label.textContent = t('sidebar.logged_as');
}

// ── Language switcher ─────────────────────────────────────────────────────────

function buildLangSwitcher() {
  const el = document.getElementById('lang-switcher');
  if (!el) return;
  const current = getLang();
  const next = current === 'it' ? 'en' : 'it';
  el.textContent = current === 'it' ? '🇬🇧 EN' : '🇮🇹 IT';
  el.title = current === 'it' ? 'Switch to English' : 'Passa all\'italiano';
  el.onclick = (e) => {
    e.preventDefault();
    setLang(next);
    window.location.reload();
  };
}

// ── Logout ────────────────────────────────────────────────────────────────────

document.getElementById('logout-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  document.documentElement.lang = getLang();

  if (!localStorage.getItem(TOKEN_KEY)) {
    window.location.href = '/login';
    return;
  }

  try {
    currentUser = await getCurrentUser();
    if (!currentUser) return;
  } catch (_) {
    window.location.href = '/login';
    return;
  }

  applyTheme(currentUser);
  buildMenu(currentUser);
  renderUserBadge(currentUser);
  buildLangSwitcher();
  await navigate();
}

init();

// Export for views that need current user
export function getUser() { return currentUser; }
