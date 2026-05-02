/**
 * Hash-based SPA router with drawer-aware navigation.
 * Route patterns:
 *   #dashboard
 *   #instances  /  #instances/:id  (opens drawer)
 *   #groups  /  #groups/:id
 *   #inventory  /  #inventory/:tab
 *   #enrollment
 *   #users  /  #users/:username  (opens drawer)
 *   #audit
 *   #settings  /  #settings/:tab
 */

import { t } from './i18n.js';
import { updatePageTitle } from './branding.js';

const container = () => document.getElementById('main-content');
const loader    = () => document.getElementById('page-loader');

let _currentRoute = null;
let _currentMod   = null;

const ROUTES = {
  dashboard:  { load: () => import('./views/dashboard.js'),   title: 'nav.dashboard' },
  instances:  { load: () => import('./views/instances.js'),   title: 'nav.instances' },
  groups:     { load: () => import('./views/groups.js'),      title: 'nav.groups' },
  inventory:  { load: () => import('./views/inventory.js'),   title: 'nav.inventory' },
  enrollment: { load: () => import('./views/enrollment.js'),  title: 'nav.enrollment' },
  users:      { load: () => import('./views/users.js'),       title: 'nav.users' },
  audit:      { load: () => import('./views/audit.js'),       title: 'nav.audit' },
  settings:   { load: () => import('./views/settings.js'),    title: 'nav.settings' },
};

const ALIASES = { instance: 'instances' };

export function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '') || 'dashboard';
  const parts = hash.split('/');
  let route = parts[0];
  if (ALIASES[route]) route = ALIASES[route];
  const params = parts.slice(1);
  return { route, params };
}

async function navigate() {
  const { route, params } = parseHash();
  const def = ROUTES[route];

  setActiveNav(route);

  if (!def) {
    container().innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--tblr-secondary)">
      <i class="ti ti-alert-circle" style="font-size:32px;display:block;margin-bottom:8px;opacity:.4"></i>
      ${t('app.view_not_found', { name: route })}
    </div>`;
    return;
  }

  updatePageTitle(t(def.title));

  try {
    const loader_el = loader();
    if (loader_el) loader_el.style.display = '';

    const mod = await def.load();
    _currentRoute = route;
    _currentMod   = mod;

    if (loader_el) loader_el.style.display = 'none';

    await mod.render(container(), params);
  } catch (err) {
    console.error('[router] render error', err);
    container().innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--hub-status-offline)">
      <i class="ti ti-alert-triangle" style="font-size:32px;display:block;margin-bottom:8px;opacity:.5"></i>
      ${t('app.view_load_error')}
    </div>`;
  }
}

function setActiveNav(route) {
  document.querySelectorAll('.hub-nav-item').forEach(el => el.classList.remove('active'));
  const el = document.querySelector(`.hub-nav-item[data-route="${route}"]`);
  if (el) el.classList.add('active');
}

export function navigate2(hash) {
  window.location.hash = hash;
}

export function start() {
  window.addEventListener('hashchange', navigate);
  navigate();
}

export function getCurrentRoute() { return _currentRoute; }
export function getCurrentMod() { return _currentMod; }
