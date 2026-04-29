/**
 * MADMIN Hub SPA — hash-based router, auth guard, sidebar.
 */
import { getCurrentUser, logout } from './api.js';

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
  { label: 'Dashboard',   icon: 'ti-home',          route: 'dashboard' },
  { label: 'Istanze',     icon: 'ti-server',        route: 'instances' },
  { label: 'Gruppi',      icon: 'ti-folders',       route: 'groups' },
  { label: 'Enrollment',  icon: 'ti-key',           route: 'enrollment', perm: 'hub.manage' },
  { label: 'SSH Keys',    icon: 'ti-lock-open',     route: 'ssh-keys',   perm: 'hub.ssh' },
  null, // divider
  { label: 'Utenti',      icon: 'ti-users',         route: 'users',      perm: 'users.view' },
  { label: 'Audit Log',   icon: 'ti-file-text',     route: 'audit',      perm: 'logs.view' },
  { label: 'Impostazioni',icon: 'ti-settings',      route: 'settings',   perm: 'settings.view' },
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
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-warning">Vista "${route}" non trovata.</div></div>`;
    return;
  }

  setActiveMenu(route);

  try {
    const mod = await loader();
    await mod.render(container, params);
  } catch (err) {
    console.error('Route render error:', err);
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-danger">Errore caricamento vista.</div></div>`;
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
          <span class="nav-link-title">${item.label}</span>
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
}

// ── Logout ────────────────────────────────────────────────────────────────────

document.getElementById('logout-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
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
  await navigate();
}

init();

// Export for views that need current user
export function getUser() { return currentUser; }
