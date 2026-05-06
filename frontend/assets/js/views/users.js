import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, relativeTime, showToast, confirmDialog, debounce } from '../utils.js';
import { getUser } from '../app.js';

let _users = [];
let _allPerms = [];
let _filterText = '';
let _filterStatus = '';
let _filter2fa = '';

const PERM_GROUPS = [
  { key: 'users.perm_group_hub',      slugs: ['hub.view', 'hub.manage', 'hub.ssh'] },
  { key: 'users.perm_group_users',    slugs: ['users.view', 'users.manage'] },
  { key: 'users.perm_group_perms',    slugs: ['permissions.manage'] },
  { key: 'users.perm_group_settings', slugs: ['settings.view', 'settings.manage'] },
  { key: 'users.perm_group_log',      slugs: ['logs.view'] },
];

const PERM_DESC = {
  'hub.view':           'Visualizzazione Hub',
  'hub.manage':         'Gestione Hub',
  'hub.ssh':            'Accesso SSH agli Hub',
  'users.view':         'Visualizzazione utenti',
  'users.manage':       'Gestione utenti',
  'permissions.manage': 'Gestione permessi',
  'settings.view':      'Visualizzazione impostazioni',
  'settings.manage':    'Gestione impostazioni',
  'logs.view':          'Visualizzazione dei log',
};

export async function render(container) {
  container.innerHTML = `
    <div class="hub-page-header">
      <div>
        <h1 class="hub-page-title">${t('users.title')}</h1>
        <p style="margin:2px 0 0;font-size:13px;color:var(--tblr-secondary)">${t('users.subtitle') || 'Gestisci gli utenti e i loro permessi'}</p>
      </div>
      <button class="btn btn-primary btn-sm" id="new-user-btn">
        <i class="ti ti-user-plus me-1"></i>${t('users.new_user')}
      </button>
    </div>

    <div class="filter-bar" id="users-filter-bar">
      <div class="filter-bar-search">
        <i class="ti ti-search"></i>
        <input type="text" id="uf-search" class="form-control" placeholder="${t('topbar.search_placeholder') || 'Cerca...'}" />
      </div>
      <select id="uf-status" class="form-select" style="width:auto">
        <option value="">${t('users.filter_status')}: ${t('users.filter_all')}</option>
        <option value="active">${t('users.status_active')}</option>
        <option value="disabled">${t('users.status_disabled')}</option>
      </select>
      <select id="uf-2fa" class="form-select" style="width:auto">
        <option value="">2FA: ${t('users.filter_all')}</option>
        <option value="on">${t('users.2fa_on')}</option>
        <option value="off">${t('users.2fa_off')}</option>
      </select>
    </div>

    <div id="users-table"></div>`;

  document.getElementById('new-user-btn')?.addEventListener('click', () => showUserModal(null));

  const search = document.getElementById('uf-search');
  search?.addEventListener('input', debounce(e => { _filterText = e.target.value.trim().toLowerCase(); renderTable(); }, 200));
  document.getElementById('uf-status')?.addEventListener('change', e => { _filterStatus = e.target.value; renderTable(); });
  document.getElementById('uf-2fa')?.addEventListener('change', e => { _filter2fa = e.target.value; renderTable(); });

  await loadAll();
}

async function loadAll() {
  try {
    const cur = getUser();
    const canManagePerms = cur?.is_superuser || (Array.isArray(cur?.permissions) && cur.permissions.includes('permissions.manage'));
    [_users, _allPerms] = await Promise.all([
      apiGet('/auth/users'),
      canManagePerms ? apiGet('/auth/permissions').catch(() => []) : Promise.resolve([]),
    ]);
    _users = _users || [];
    _allPerms = _allPerms || [];
    renderTable();
  } catch (_) {
    document.getElementById('users-table').innerHTML =
      `<div class="alert alert-danger">${t('msg.error')}</div>`;
  }
}

function applyFilters(users) {
  return users.filter(u => {
    if (_filterText && !u.username.toLowerCase().includes(_filterText) && !(u.email || '').toLowerCase().includes(_filterText)) return false;
    if (_filterStatus === 'active' && !u.is_active) return false;
    if (_filterStatus === 'disabled' && u.is_active) return false;
    if (_filter2fa === 'on' && !u.totp_enabled) return false;
    if (_filter2fa === 'off' && u.totp_enabled) return false;
    return true;
  });
}

function twoFaBadge(u) {
  if (u.totp_locked) return `<span class="hub-badge revoked" style="font-size:11px">${t('account.2fa_locked')}</span>`;
  if (u.totp_enabled) return `<span class="hub-badge info" style="font-size:11px">${u.totp_enforced ? t('users.2fa_enforced_label') : t('users.2fa_on')}</span>`;
  return `<span class="hub-badge offline" style="font-size:11px">${t('users.2fa_off')}</span>`;
}

function renderTable() {
  const el = document.getElementById('users-table');
  if (!el) return;
  const cur = getUser();
  const canManage = cur?.is_superuser || (Array.isArray(cur?.permissions) && cur.permissions.includes('users.manage'));

  const filtered = applyFilters(_users);

  if (!filtered.length) {
    el.innerHTML = `<div class="data-table"><div class="data-table-empty"><i class="ti ti-users"></i>${t('users.none')}</div></div>`;
    return;
  }

  el.innerHTML = `<div class="data-table"><table>
    <thead><tr>
      <th>${t('users.col_username')}</th>
      <th>${t('users.col_email')}</th>
      <th>${t('users.col_status')}</th>
      <th>${t('users.col_2fa')}</th>
      <th>${t('users.col_role')}</th>
      <th>${t('users.col_lastlogin')}</th>
      <th style="width:120px"></th>
    </tr></thead>
    <tbody>
    ${filtered.map(u => {
      const isSelf = cur && u.username === cur.username;
      const rowStyle = isSelf ? 'opacity:.55' : '';
      const rowTitle = isSelf ? `title="${t('users.self_disabled_hint')}"` : '';
      return `<tr class="${isSelf || !canManage ? '' : 'clickable'}" data-username="${escapeHtml(u.username)}" style="${rowStyle}" ${rowTitle}>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:32px;height:32px;border-radius:50%;background:rgba(var(--hub-primary-rgb),.12);color:var(--hub-primary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">
            ${escapeHtml((u.username || 'U').charAt(0).toUpperCase())}
          </div>
          <div>
            <strong>${escapeHtml(u.username)}</strong>
            ${u.is_protected ? `<span class="hub-badge revoked ms-1" style="font-size:10px">${t('users.protected')}</span>` : ''}
            ${isSelf ? `<span class="hub-badge info ms-1" style="font-size:10px">${t('users.self_label')}</span>` : ''}
          </div>
        </div>
      </td>
      <td style="color:var(--tblr-secondary);font-size:13px">${escapeHtml(u.email || '—')}</td>
      <td><span class="hub-badge ${u.is_active ? 'online' : 'offline'}">${u.is_active ? t('users.status_active') : t('users.status_disabled')}</span></td>
      <td>${twoFaBadge(u)}</td>
      <td style="font-size:13px">${u.is_superuser ? `<span style="color:var(--hub-primary);font-weight:600">${t('users.role_admin')}</span>` : t('users.role_user')}</td>
      <td style="font-size:12px;color:var(--tblr-secondary)">${relativeTime(u.last_login)}</td>
      <td style="text-align:right" onclick="event.stopPropagation()">
        ${canManage && !isSelf ? `
          <button class="btn btn-sm btn-ghost-secondary edit-btn" data-username="${escapeHtml(u.username)}" title="${t('users.edit')}">
            <i class="ti ti-pencil" style="font-size:14px"></i>
          </button>` : ''}
        ${canManage && !u.is_protected && !isSelf ? `
          <button class="btn btn-sm btn-ghost-danger del-btn" data-username="${escapeHtml(u.username)}" title="${t('users.delete')}">
            <i class="ti ti-trash" style="font-size:14px"></i>
          </button>` : ''}
      </td>
    </tr>`;
    }).join('')}
    </tbody>
  </table></div>`;

  el.querySelectorAll('tbody tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => {
      const u = _users.find(x => x.username === tr.dataset.username);
      if (u && canManage) showUserModal(u);
    });
  });

  el.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const u = _users.find(x => x.username === btn.dataset.username);
      if (u) showUserModal(u);
    });
  });

  el.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog(t('users.delete'), t('users.confirm_delete', { username: btn.dataset.username }), { okLabel: t('users.delete'), okClass: 'btn-danger' });
      if (!ok) return;
      try {
        await apiDelete(`/auth/users/${btn.dataset.username}`);
        showToast(t('users.deleted'), 'success');
        await loadAll();
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    });
  });
}

// ── Permissions tab content ───────────────────────────────────────────────────

function buildRolePermsTab(modalEl, grantedSet, isAdminChecked) {
  const canManagePerms = !!_allPerms.length;

  const roleSelect = `
    <div style="margin-bottom:16px">
      <label class="form-label" style="font-size:13px;font-weight:600">${t('users.field_role')}</label>
      <select id="um-role" class="form-select" style="max-width:280px">
        <option value="user" ${!isAdminChecked ? 'selected' : ''}>${t('users.role_user')}</option>
        <option value="admin" ${isAdminChecked ? 'selected' : ''}>${t('users.role_admin')}</option>
      </select>
      <div style="font-size:12px;color:var(--tblr-secondary);margin-top:4px">${t('users.role_hint')}</div>
    </div>`;

  if (!canManagePerms && !isAdminChecked) {
    return `${roleSelect}
      <div style="padding:20px;text-align:center;color:var(--tblr-secondary);font-size:13px;background:var(--hub-surface);border:1px dashed var(--hub-border);border-radius:6px">
        <i class="ti ti-lock" style="font-size:24px;display:block;margin-bottom:8px;opacity:.4"></i>
        Permesso <code>permissions.manage</code> necessario per gestire i singoli slug.
      </div>`;
  }

  if (isAdminChecked) {
    return `${roleSelect}
      <div class="alert alert-info py-2 px-3" style="font-size:13px;margin:0">
        <i class="ti ti-shield-check me-1"></i>${t('users.perm_admin_full')}
      </div>`;
  }

  const groupsHtml = PERM_GROUPS.map(g => {
    const items = g.slugs.map(slug => `
      <label class="d-flex align-items-center gap-2 perm-item" style="cursor:pointer;font-size:13px;padding:4px 0">
        <input type="checkbox" class="form-check-input perm-chk" data-slug="${escapeHtml(slug)}"
          ${grantedSet.has(slug) ? 'checked' : ''} />
        <span>
          <span class="text-mono" style="font-size:11px;color:var(--hub-primary)">${escapeHtml(slug)}</span>
          <span style="color:var(--tblr-secondary);margin-left:4px;font-size:12px">— ${escapeHtml(PERM_DESC[slug] || slug)}</span>
        </span>
      </label>`).join('');

    return `<div class="perm-group" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--tblr-secondary)">${t(g.key)}</span>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;color:var(--tblr-secondary)">
          <input type="checkbox" class="form-check-input group-select-all" data-group="${escapeHtml(g.key)}" style="width:12px;height:12px" />
          ${t('users.perm_select_all')}
        </label>
      </div>
      <div style="padding-left:4px">${items}</div>
    </div>`;
  }).join('');

  return `${roleSelect}<div id="perms-container">${groupsHtml}</div>`;
}

function wirePermsTab(modalEl) {
  modalEl.querySelectorAll('.group-select-all').forEach(chk => {
    const groupKey = chk.dataset.group;
    const group = PERM_GROUPS.find(g => g.key === groupKey);
    if (!group) return;
    chk.addEventListener('change', () => {
      group.slugs.forEach(slug => {
        const c = modalEl.querySelector(`.perm-chk[data-slug="${slug}"]`);
        if (c) c.checked = chk.checked;
      });
    });
  });

  modalEl.querySelectorAll('.perm-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      const slug = chk.dataset.slug;
      const group = PERM_GROUPS.find(g => g.slugs.includes(slug));
      if (!group) return;
      const groupAll = modalEl.querySelector(`.group-select-all[data-group="${group.key}"]`);
      if (groupAll) {
        const all = group.slugs.every(s => modalEl.querySelector(`.perm-chk[data-slug="${s}"]`)?.checked);
        groupAll.checked = all;
      }
    });
  });
}

// ── Create / Edit Modal ───────────────────────────────────────────────────────

async function showUserModal(user) {
  const isEdit = !!user;
  const grantedSet = new Set(isEdit ? (user.permissions || []).map(p => typeof p === 'string' ? p : p.slug) : []);
  let roleIsAdmin = isEdit ? !!user.is_superuser : false;

  const tabs = isEdit
    ? `<button class="hub-tab active" data-tab="general">${t('users.tab_general')}</button>
       <button class="hub-tab" data-tab="perms">${t('users.tab_role_permissions')}</button>
       <button class="hub-tab" data-tab="security">${t('users.tab_security')}</button>`
    : `<button class="hub-tab active" data-tab="general">${t('users.tab_general')}</button>
       <button class="hub-tab" data-tab="perms">${t('users.tab_role_permissions')}</button>`;

  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  modalEl.innerHTML = `<div class="modal-dialog modal-dialog-centered modal-lg">
    <div class="modal-content">
      <div class="modal-header" style="padding-bottom:0;border-bottom:none">
        <div>
          <h5 class="modal-title">${isEdit ? escapeHtml(user.username) : t('users.modal_title')}</h5>
          ${isEdit ? `<div style="font-size:12px;color:var(--tblr-secondary)">${escapeHtml(user.email || '')}</div>` : ''}
        </div>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="hub-tabs" style="padding:0 16px">
        ${tabs}
      </div>
      <div class="modal-body" id="um-panel" style="min-height:320px;padding-top:12px"></div>
      <div class="modal-footer" id="um-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="um-save">${isEdit ? t('modal.save') : t('modal.create')}</button>
      </div>
    </div>
  </div>`;

  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl);
  m.show();

  const panel = modalEl.querySelector('#um-panel');

  // Persisted form state across tab switches (password fields are NOT preserved
  // for safety — re-entered if needed)
  const formState = {
    username: '',
    email: isEdit ? (user.email || '') : '',
    password: '',
    password_confirm: '',
    is_active: isEdit ? !!user.is_active : true,
    totp_enforced: isEdit ? !!user.totp_enforced : false,
  };

  function captureGeneral() {
    if (!isEdit) formState.username = panel.querySelector('#um-username')?.value.trim() || '';
    formState.email = panel.querySelector('#um-email')?.value.trim() || '';
    formState.password = panel.querySelector('#um-password')?.value || '';
    formState.password_confirm = panel.querySelector('#um-password-confirm')?.value || '';
    if (isEdit) formState.is_active = panel.querySelector('#um-active')?.checked ?? true;
  }

  function captureRole() {
    const sel = panel.querySelector('#um-role');
    if (sel) roleIsAdmin = sel.value === 'admin';
    if (!roleIsAdmin) {
      // Capture currently checked perms into grantedSet
      grantedSet.clear();
      panel.querySelectorAll('.perm-chk:checked').forEach(c => grantedSet.add(c.dataset.slug));
    }
  }

  function captureSecurity() {
    const en = panel.querySelector('#um-2fa-enforced');
    if (en) formState.totp_enforced = en.checked;
  }

  function renderGeneral() {
    panel.innerHTML = `
      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label">${t('users.field_username')} ${!isEdit ? '*' : ''}</label>
          ${isEdit
            ? `<input type="text" class="form-control" value="${escapeHtml(user.username)}" readonly style="background:var(--hub-surface);color:var(--tblr-secondary)" />`
            : `<input type="text" id="um-username" class="form-control" autocomplete="off" placeholder="es. mario.rossi" />`}
        </div>
        <div class="col-md-6">
          <label class="form-label">${t('users.field_email')}</label>
          <input type="email" id="um-email" class="form-control" placeholder="es. nome@azienda.it" />
        </div>
        <div class="col-md-6">
          <label class="form-label">${t('users.field_password')} ${!isEdit ? '*' : `<span style="font-size:11px;color:var(--tblr-secondary)">(${t('users.pwd_leave_blank')})</span>`}</label>
          <input type="password" id="um-password" class="form-control" autocomplete="new-password" />
        </div>
        <div class="col-md-6">
          <label class="form-label">${t('users.field_password_confirm')} ${!isEdit ? '*' : ''}</label>
          <input type="password" id="um-password-confirm" class="form-control" autocomplete="new-password" />
        </div>
        ${isEdit ? `<div class="col-md-6">
          <label class="d-flex align-items-center gap-2" style="cursor:pointer;font-size:14px;margin-top:30px">
            <input type="checkbox" id="um-active" class="form-check-input" ${formState.is_active ? 'checked' : ''} style="width:18px;height:18px" />
            ${t('users.active_label')}
          </label>
        </div>` : ''}
        <div class="col-12">
          <div id="um-error" class="alert alert-danger py-2" style="display:none;font-size:13px;margin:0"></div>
        </div>
      </div>`;

    // Restore persisted values via DOM properties (safer than HTML interpolation)
    const unameEl = panel.querySelector('#um-username');
    if (unameEl) unameEl.value = formState.username;
    const emailEl = panel.querySelector('#um-email');
    if (emailEl) emailEl.value = formState.email;
    const pwdEl = panel.querySelector('#um-password');
    if (pwdEl) pwdEl.value = formState.password;
    const pwdConfEl = panel.querySelector('#um-password-confirm');
    if (pwdConfEl) pwdConfEl.value = formState.password_confirm;
  }

  function renderPerms() {
    panel.innerHTML = buildRolePermsTab(modalEl, grantedSet, roleIsAdmin);
    const sel = panel.querySelector('#um-role');
    sel?.addEventListener('change', () => {
      // Capture current selection before re-render
      if (!roleIsAdmin) {
        grantedSet.clear();
        panel.querySelectorAll('.perm-chk:checked').forEach(c => grantedSet.add(c.dataset.slug));
      }
      roleIsAdmin = sel.value === 'admin';
      renderPerms();
    });
    wirePermsTab(modalEl);
  }

  function renderSecurity() {
    if (!isEdit) return;
    const remaining = user.backup_codes_remaining ?? 0;
    panel.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card" style="border:1px solid var(--hub-border);border-radius:var(--hub-radius);padding:16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px">
            <i class="ti ti-shield" style="color:var(--hub-primary)"></i> ${t('account.2fa_section')}
          </div>
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
            <span style="font-size:13px;color:var(--tblr-secondary)">${t('users.col_status')}:</span>
            ${
              user.totp_locked
                ? `<span class="hub-badge revoked">${t('account.2fa_locked')}</span>`
                : (user.totp_enabled
                    ? `<span class="hub-badge online">${t('account.2fa_enabled')}</span>`
                    : `<span class="hub-badge offline">${t('account.2fa_disabled')}</span>`)
            }
          </div>
          ${user.totp_enabled ? `<div style="font-size:12px;color:var(--tblr-secondary);margin-bottom:12px">${t('account.codes_remaining', { n: remaining })}</div>` : ''}
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:8px">
            <label class="d-flex align-items-center gap-2" style="cursor:pointer;font-size:13px">
              <input type="checkbox" id="um-2fa-enforced" class="form-check-input" ${formState.totp_enforced ? 'checked' : ''} />
              ${t('users.2fa_required')}
            </label>
            ${(user.totp_enabled || user.totp_locked) && !user.is_protected ? `
              <button class="btn btn-sm btn-outline-warning" id="um-reset-2fa">
                <i class="ti ti-refresh me-1"></i>${t('users.reset_2fa')}
              </button>` : ''}
          </div>
          <div style="font-size:11px;color:var(--tblr-secondary);margin-top:10px">${t('users.reset_2fa_hint')}</div>
        </div>
      </div>`;

    panel.querySelector('#um-reset-2fa')?.addEventListener('click', async () => {
      const ok = await confirmDialog(t('users.reset_2fa'), t('users.reset_2fa_confirm', { username: user.username }), { okLabel: t('users.reset_2fa'), okClass: 'btn-warning' });
      if (!ok) return;
      try {
        await apiDelete(`/auth/users/${user.username}/2fa`);
        showToast(t('users.reset_2fa_done'), 'success');
        user.totp_enabled = false;
        user.totp_locked = false;
        user.backup_codes_remaining = 0;
        renderSecurity();
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    });
  }

  function switchTab(tab) {
    // Capture state from previous tab before re-render
    const prev = [...modalEl.querySelectorAll('.hub-tab')].find(b => b.classList.contains('active'))?.dataset.tab;
    if (prev === 'general')  captureGeneral();
    if (prev === 'perms')    captureRole();
    if (prev === 'security') captureSecurity();

    modalEl.querySelectorAll('.hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'general')  renderGeneral();
    if (tab === 'perms')    renderPerms();
    if (tab === 'security') renderSecurity();
  }

  modalEl.querySelectorAll('.hub-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  switchTab('general');

  modalEl.querySelector('#um-save')?.addEventListener('click', async () => {
    // Always capture state from active tab
    const activeTab = [...modalEl.querySelectorAll('.hub-tab')].find(b => b.classList.contains('active'))?.dataset.tab;
    if (activeTab === 'general')  captureGeneral();
    if (activeTab === 'perms')    captureRole();
    if (activeTab === 'security') captureSecurity();

    const errEl = panel.querySelector('#um-error');
    const showErr = msg => {
      if (errEl) { errEl.textContent = msg; errEl.style.display = ''; }
      else showToast(msg, 'error');
    };
    if (errEl) errEl.style.display = 'none';

    const username = isEdit ? user.username : formState.username;
    const email    = formState.email || null;
    const password = formState.password;
    const confirm  = formState.password_confirm;
    const isActive = isEdit ? formState.is_active : true;
    const totpEnforced = isEdit ? formState.totp_enforced : false;

    if (!isEdit && !username) { showErr(t('users.username_pwd_required')); return; }
    if (!isEdit && !password) { showErr(t('users.username_pwd_required')); return; }
    if (password && password !== confirm) { showErr(t('users.pwd_mismatch')); return; }

    try {
      if (!isEdit) {
        await apiPost('/auth/users', { username, password, email, is_superuser: roleIsAdmin });
        if (_allPerms.length && !roleIsAdmin && grantedSet.size) {
          await apiPut(`/auth/users/${username}/permissions`, { permissions: [...grantedSet] }).catch(() => {});
        }
        showToast(t('users.created'), 'success');
      } else {
        const payload = { is_superuser: roleIsAdmin, is_active: isActive, totp_enforced: totpEnforced };
        if (email !== user.email) payload.email = email;
        if (password) payload.password = password;
        await apiPatch(`/auth/users/${user.username}`, payload);
        if (_allPerms.length) {
          const slugs = roleIsAdmin ? [] : [...grantedSet];
          await apiPut(`/auth/users/${user.username}/permissions`, { permissions: slugs }).catch(() => {});
        }
        showToast(t('users.saved'), 'success');
      }
      m.hide();
      await loadAll();
    } catch (e) { showErr(e.detail || t('msg.error')); }
  });

  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}
