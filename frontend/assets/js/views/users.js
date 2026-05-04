import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, relativeTime, showToast, confirmDialog } from '../utils.js';
import { openDrawer } from '../shell/drawer.js';
import { getUser } from '../app.js';

let _users = [], _perms = [];

export async function render(container, params) {
  container.innerHTML = `
    <div class="hub-page-header">
      <h1 class="hub-page-title">${t('users.title')}</h1>
      <button class="btn btn-primary btn-sm" id="new-user-btn">
        <i class="ti ti-user-plus me-1"></i>${t('users.new_user')}
      </button>
    </div>
    <div id="users-table"></div>`;

  document.getElementById('new-user-btn')?.addEventListener('click', showInviteModal);
  await loadAll();

  if (params?.length && params[0]) {
    openUserDrawer(params[0]);
  }
}

async function loadAll() {
  try {
    [_users, _perms] = await Promise.all([
      apiGet('/auth/users'),
      apiGet('/auth/permissions').catch(() => []),
    ]);
    _users = _users || [];
    _perms = _perms || [];
    renderTable();
  } catch (_) {
    document.getElementById('users-table').innerHTML =
      `<div class="alert alert-danger">${t('msg.error')}</div>`;
  }
}

function renderTable() {
  const el = document.getElementById('users-table');
  if (!el) return;

  if (!_users.length) {
    el.innerHTML = `<div class="data-table"><div class="data-table-empty"><i class="ti ti-users"></i>${t('users.none')}</div></div>`;
    return;
  }

  el.innerHTML = `<div class="data-table"><table>
    <thead><tr>
      <th>${t('users.col_username')}</th>
      <th>${t('users.col_email')}</th>
      <th>${t('users.col_role')}</th>
      <th>${t('users.col_2fa')}</th>
      <th>${t('users.col_lastlogin')}</th>
      <th>${t('users.col_status')}</th>
      <th></th>
    </tr></thead>
    <tbody>${_users.map(u => `<tr class="clickable" data-username="${escapeHtml(u.username)}">
      <td>
        <strong>${escapeHtml(u.username)}</strong>
        ${u.is_protected ? `<span class="hub-badge muted ms-1" style="font-size:10px">${t('users.protected')}</span>` : ''}
        ${u.is_superuser ? `<span class="hub-badge info ms-1" style="font-size:10px">${t('users.superuser')}</span>` : ''}
      </td>
      <td>${escapeHtml(u.email || '—')}</td>
      <td>${u.is_superuser ? t('users.role_admin') : t('users.role_user')}</td>
      <td>${u.totp_enabled ? (u.totp_enforced ? t('users.2fa_enforced_label') : t('users.2fa_on')) : t('users.2fa_off')}</td>
      <td>${relativeTime(u.last_login)}</td>
      <td><span class="hub-badge ${u.is_active ? 'online' : 'offline'}">${u.is_active ? t('users.status_active') : t('users.status_disabled')}</span></td>
      <td style="text-align:right" onclick="event.stopPropagation()">
        ${!u.is_protected ? `
          <button class="btn btn-sm btn-ghost-secondary toggle-btn" data-username="${escapeHtml(u.username)}" data-active="${u.is_active}">
            <i class="ti ${u.is_active ? 'ti-eye-off' : 'ti-eye'}" style="font-size:14px"></i>
          </button>
          <button class="btn btn-sm btn-ghost-danger del-btn" data-username="${escapeHtml(u.username)}">
            <i class="ti ti-trash" style="font-size:14px"></i>
          </button>` : ''}
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;

  el.querySelectorAll('tbody tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => {
      window.location.hash = `users/${tr.dataset.username}`;
      openUserDrawer(tr.dataset.username);
    });
  });

  el.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const activate = btn.dataset.active === 'true' ? false : true;
      try {
        await apiPatch(`/auth/users/${btn.dataset.username}`, { is_active: activate });
        showToast(t('users.status_updated'), 'success');
        await loadAll();
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    });
  });

  el.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog(t('users.delete'), t('users.confirm_delete', { username: btn.dataset.username }), { okLabel: t('users.delete') });
      if (!ok) return;
      try {
        await apiDelete(`/auth/users/${btn.dataset.username}`);
        showToast(t('users.deleted'), 'success');
        await loadAll();
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    });
  });
}

function showInviteModal() {
  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  modalEl.innerHTML = `<div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${t('users.modal_title')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div class="mb-3"><label class="form-label">${t('users.field_username')} *</label>
          <input type="text" id="uf-username" class="form-control" autocomplete="off" /></div>
        <div class="mb-3"><label class="form-label">${t('users.field_email')}</label>
          <input type="email" id="uf-email" class="form-control" /></div>
        <div class="mb-3"><label class="form-label">${t('users.field_password')} *</label>
          <input type="password" id="uf-password" class="form-control" autocomplete="new-password" /></div>
        <div class="mb-3"><label class="form-label">${t('users.field_password_confirm')} *</label>
          <input type="password" id="uf-password-confirm" class="form-control" autocomplete="new-password" /></div>
        <div class="mb-3"><label class="form-label">${t('users.field_role')}</label>
          <select id="uf-role" class="form-select">
            <option value="user">${t('users.role_user')}</option>
            <option value="admin">${t('users.role_admin')}</option>
          </select></div>
        <div id="uf-error" class="alert alert-danger" style="display:none;margin:0 0 8px;font-size:13px;padding:8px 12px"></div>
        <hr style="margin:8px 0">
        <div>
          <div style="font-size:12px;font-weight:600;color:var(--tblr-secondary);margin-bottom:6px;cursor:pointer" id="uf-perms-toggle">
            <i class="ti ti-chevron-right" id="uf-perms-icon"></i> ${t('users.permissions')}
          </div>
          <div id="uf-perms-section" style="display:none;padding-left:8px">
            ${_perms.map(p => {
              const slug = typeof p === 'string' ? p : p.slug;
              return `<label class="d-flex align-items-center gap-2 mb-1" style="cursor:pointer;font-size:12px">
                <input type="checkbox" class="form-check-input uf-perm-chk" data-slug="${escapeHtml(slug)}" />
                <span class="text-mono">${escapeHtml(slug)}</span>
              </label>`;
            }).join('')}
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="uf-create">${t('modal.create')}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl);
  m.show();

  modalEl.querySelector('#uf-perms-toggle')?.addEventListener('click', () => {
    const sec = modalEl.querySelector('#uf-perms-section');
    const icon = modalEl.querySelector('#uf-perms-icon');
    const hidden = sec.style.display === 'none';
    sec.style.display = hidden ? 'block' : 'none';
    icon.className = hidden ? 'ti ti-chevron-down' : 'ti ti-chevron-right';
  });

  modalEl.querySelector('#uf-create').addEventListener('click', async () => {
    const errEl   = modalEl.querySelector('#uf-error');
    const showErr = msg => { errEl.textContent = msg; errEl.style.display = ''; };
    errEl.style.display = 'none';

    const username = modalEl.querySelector('#uf-username').value.trim();
    const password = modalEl.querySelector('#uf-password').value;
    const confirm  = modalEl.querySelector('#uf-password-confirm').value;

    if (!username || !password) { showErr(t('users.username_pwd_required')); return; }
    if (password !== confirm)   { showErr(t('users.pwd_mismatch')); return; }
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      showErr('Password debole: minimo 8 caratteri, una maiuscola, una cifra, un carattere speciale.');
      return;
    }

    const isAdmin = modalEl.querySelector('#uf-role').value === 'admin';
    try {
      await apiPost('/auth/users', {
        username, password,
        email: modalEl.querySelector('#uf-email').value.trim() || null,
        is_superuser: isAdmin,
      });
      const selectedPerms = [...modalEl.querySelectorAll('.uf-perm-chk:checked')].map(c => c.dataset.slug);
      if (selectedPerms.length && !isAdmin) {
        await apiPut(`/auth/users/${username}/permissions`, { permissions: selectedPerms }).catch(() => {});
      }
      showToast(t('users.created'), 'success');
      m.hide();
      await loadAll();
    } catch (e) { showErr(e.detail || t('msg.error')); }
  });

  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}

async function openUserDrawer(username) {
  await openDrawer({
    title: username,
    closeHash: '#users',
    render: async (body) => {
      body.innerHTML = '<div class="hub-loader"></div>';
      const user = await apiGet(`/auth/users/${username}`).catch(() => null);
      if (!user) { body.innerHTML = `<p style="padding:20px;font-size:13px;color:var(--tblr-secondary)">${t('msg.error')}</p>`; return; }

      const userPerms = await apiGet(`/auth/users/${username}/permissions`).catch(() => []);

      body.innerHTML = `
        <div class="hub-tabs">
          <button class="hub-tab active" data-tab="general">${t('users.tab_general')}</button>
          <button class="hub-tab" data-tab="perms">${t('users.tab_permissions')}</button>
        </div>
        <div id="udr-panel"></div>`;

      const panel = body.querySelector('#udr-panel');

      async function switchTab(tab) {
        body.querySelectorAll('.hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        if (tab === 'general') renderUserGeneral(panel, user);
        if (tab === 'perms')   renderUserPerms(panel, user, userPerms);
      }

      body.querySelectorAll('.hub-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
      switchTab('general');
    },
  });
}

function renderUserGeneral(panel, user) {
  const row = (label, val) => `<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--hub-border);font-size:13px">
    <div style="width:120px;color:var(--tblr-secondary);flex-shrink:0">${escapeHtml(label)}</div>
    <div style="flex:1">${val}</div>
  </div>`;

  panel.innerHTML = `<div style="padding-top:4px">
    ${row(t('users.field_username'), `<strong>${escapeHtml(user.username)}</strong>`)}
    ${row(t('users.field_email'),    escapeHtml(user.email || '—'))}
    ${row(t('users.col_role'),       user.is_superuser ? t('users.role_admin') : t('users.role_user'))}
    ${row(t('users.col_2fa'),        user.totp_enabled ? (user.totp_enforced ? t('users.2fa_enforced_label') : t('users.2fa_on')) : t('users.2fa_off'))}
    ${row(t('users.col_lastlogin'),  relativeTime(user.last_login))}
    ${row(t('users.col_status'),     `<span class="hub-badge ${user.is_active ? 'online' : 'offline'}">${user.is_active ? t('users.status_active') : t('users.status_disabled')}</span>`)}
    </div>
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      ${getUser()?.username === user.username ? `<button class="btn btn-sm btn-outline-secondary" id="udr-change-pwd">${t('users.change_password')}</button>` : ''}
      ${!user.is_protected && user.totp_enabled ? `<button class="btn btn-sm btn-outline-warning" id="udr-reset-2fa">${t('users.reset_2fa')}</button>` : ''}
    </div>`;

  panel.querySelector('#udr-reset-2fa')?.addEventListener('click', async () => {
    const ok = await confirmDialog(t('users.reset_2fa'), t('users.confirm_reset_2fa', { username: user.username }), { okLabel: t('users.reset_2fa'), okClass: 'btn-warning' });
    if (!ok) return;
    try {
      await apiDelete(`/auth/users/${user.username}/2fa`);
      showToast(t('users.reset_2fa_done'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  panel.querySelector('#udr-change-pwd')?.addEventListener('click', () => {
    const m = document.createElement('div');
    m.className = 'modal fade';
    m.innerHTML = `<div class="modal-dialog modal-sm modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">${t('users.change_password')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body">
          <div class="mb-3"><label class="form-label">${t('users.field_current_pwd')}</label>
            <input type="password" id="cp-current" class="form-control" autocomplete="current-password" /></div>
          <div class="mb-3"><label class="form-label">${t('users.field_password')}</label>
            <input type="password" id="cp-new" class="form-control" autocomplete="new-password" /></div>
          <div class="mb-3"><label class="form-label">${t('users.field_password_confirm')}</label>
            <input type="password" id="cp-confirm" class="form-control" autocomplete="new-password" /></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
          <button type="button" class="btn btn-primary" id="cp-save">${t('modal.save')}</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(m);
    const modal = new window.bootstrap.Modal(m);
    modal.show();
    m.querySelector('#cp-save').addEventListener('click', async () => {
      const current = m.querySelector('#cp-current').value;
      const newPwd  = m.querySelector('#cp-new').value;
      const confirm = m.querySelector('#cp-confirm').value;
      if (!current || !newPwd) { showToast(t('users.username_pwd_required'), 'error'); return; }
      if (newPwd !== confirm) { showToast(t('users.pwd_mismatch'), 'error'); return; }
      try {
        await apiPost('/auth/me/password', { current_password: current, new_password: newPwd });
        showToast(t('users.password_changed'), 'success');
        modal.hide();
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    });
    m.addEventListener('hidden.bs.modal', () => m.remove());
  });
}

function renderUserPerms(panel, user, userPerms) {
  if (user.is_superuser) {
    panel.innerHTML = `<div style="padding:20px;text-align:center;color:var(--tblr-secondary);font-size:13px">Superuser — accesso completo</div>`;
    return;
  }
  if (!_perms.length) {
    panel.innerHTML = `<div style="padding:16px;color:var(--tblr-secondary);font-size:13px"><i class="ti ti-lock me-1"></i>Permesso <code>permissions.manage</code> necessario per gestire i permessi.</div>`;
    return;
  }
  const grantedSet = new Set(userPerms.map(p => typeof p === 'string' ? p : p.slug));
  panel.innerHTML = `<div style="padding-top:8px;display:flex;flex-direction:column;gap:6px">
    ${_perms.map(p => {
      const slug = typeof p === 'string' ? p : p.slug;
      const has  = grantedSet.has(slug);
      return `<label class="d-flex align-items-center gap-2" style="cursor:pointer;font-size:13px">
        <input type="checkbox" class="form-check-input perm-chk" data-slug="${escapeHtml(slug)}" ${has ? 'checked' : ''} />
        <span class="text-mono" style="font-size:12px">${escapeHtml(slug)}</span>
      </label>`;
    }).join('')}
    <button class="btn btn-sm btn-primary mt-2" id="udr-save-perms">${t('modal.save')}</button>
  </div>`;

  panel.querySelector('#udr-save-perms')?.addEventListener('click', async () => {
    const slugs = [...panel.querySelectorAll('.perm-chk:checked')].map(c => c.dataset.slug);
    try {
      await apiPut(`/auth/users/${user.username}/permissions`, { permissions: slugs });
      showToast(t('msg.saved'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
}
