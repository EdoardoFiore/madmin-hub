/**
 * Users management — list, create, edit, toggle, delete, reset 2FA, permissions.
 */
import { apiGet, apiPost, apiPatch, apiDelete, apiPut } from '../api.js';
import { showSpinner, showToast } from '../utils.js';
import { t, getLang } from '../i18n.js';

let _users = [];
let _allPerms = [];
let _editTarget = null; // username being edited

export async function render(container) {
  showSpinner(container);
  try {
    [_users, _allPerms] = await Promise.all([apiGet('/auth/users'), apiGet('/auth/permissions')]);
  } catch { _users = []; _allPerms = []; }

  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl">
        <div class="row align-items-center">
          <div class="col"><h2 class="page-title">${t('users.title')}</h2></div>
          <div class="col-auto ms-auto">
            <button class="btn btn-primary" id="btn-new-user">
              <i class="ti ti-plus me-1"></i>${t('users.new_user')}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="page-body">
      <div class="container-xl">
        <div class="card">
          <div class="table-responsive">
            <table class="table table-vcenter card-table">
              <thead><tr>
                <th>Username</th>
                <th>Email</th>
                <th>${t('users.col_role')}</th>
                <th>2FA</th>
                <th>${t('label.status')}</th>
                <th>${t('users.col_lastlogin')}</th>
                <th></th>
              </tr></thead>
              <tbody id="users-tbody">${renderRows(_users)}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Create / Edit user modal -->
    <div class="modal modal-blur fade" id="user-modal" tabindex="-1">
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="user-modal-title">${t('users.modal_title')}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="row">
              <div class="col-md-6">
                <div class="mb-2">
                  <label class="form-label">Username</label>
                  <input id="u-username" type="text" class="form-control" />
                </div>
                <div class="mb-2">
                  <label class="form-label" id="u-pwd-label">${t('label.password')}</label>
                  <input id="u-password" type="password" class="form-control" placeholder="" />
                  <small id="u-pwd-hint" class="text-muted d-none">${t('users.pwd_leave_blank')}</small>
                </div>
                <div class="mb-2">
                  <label class="form-label">Email</label>
                  <input id="u-email" type="email" class="form-control" />
                </div>
              </div>
              <div class="col-md-6">
                <label class="form-label">${t('users.col_role')}</label>
                <div class="mb-2">
                  <label class="form-check">
                    <input id="u-superuser" type="checkbox" class="form-check-input" />
                    <span class="form-check-label">${t('users.superuser')}</span>
                  </label>
                </div>
                <div class="mb-2">
                  <label class="form-check">
                    <input id="u-active" type="checkbox" class="form-check-input" checked />
                    <span class="form-check-label">${t('users.status_active')}</span>
                  </label>
                </div>
                <div class="mb-3">
                  <label class="form-check">
                    <input id="u-2fa-enforced" type="checkbox" class="form-check-input" />
                    <span class="form-check-label">${t('users.2fa_enforced')}</span>
                  </label>
                </div>
              </div>
            </div>
            <div id="perms-section">
              <hr class="my-2" />
              <label class="form-label">${t('users.permissions')}</label>
              <div id="perms-grid" class="row row-cols-2 row-cols-md-3 g-1">
                ${renderPermsGrid([], _allPerms)}
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-link" data-bs-dismiss="modal">${t('users.cancel')}</button>
            <button id="u-submit" class="btn btn-primary">${t('users.create')}</button>
          </div>
        </div>
      </div>
    </div>`;

  container.querySelector('#btn-new-user').addEventListener('click', () => openCreateModal(container));
  container.querySelector('#u-submit').addEventListener('click', () => submitUser(container));
  container.querySelector('#u-superuser').addEventListener('change', (e) => {
    container.querySelector('#perms-section').style.display = e.target.checked ? 'none' : '';
  });

  container.querySelector('#users-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, username } = btn.dataset;

    if (action === 'edit') {
      const user = _users.find(u => u.username === username);
      if (user) openEditModal(container, user);

    } else if (action === 'toggle') {
      const user = _users.find(u => u.username === username);
      try {
        await apiPatch(`/auth/users/${username}`, { is_active: !user.is_active });
        showToast(t('users.status_updated'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }

    } else if (action === 'reset-pwd') {
      const newPwd = prompt(t('users.prompt_new_pwd'));
      if (!newPwd) return;
      try {
        await apiPatch(`/auth/users/${username}`, { password: newPwd });
        showToast(t('users.password_reset_done'), 'success');
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }

    } else if (action === 'reset-2fa') {
      if (!confirm(t('users.confirm_reset_2fa', { username }))) return;
      try {
        await apiDelete(`/auth/users/${username}/2fa`);
        showToast(t('users.reset_2fa_done'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }

    } else if (action === 'perms') {
      const user = _users.find(u => u.username === username);
      if (user) openEditModal(container, user, true);

    } else if (action === 'delete') {
      if (!confirm(t('users.confirm_delete', { username }))) return;
      try {
        await apiDelete(`/auth/users/${username}`);
        showToast(t('users.deleted'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    }
  });
}

function openCreateModal(container) {
  _editTarget = null;
  container.querySelector('#user-modal-title').textContent = t('users.modal_title');
  container.querySelector('#u-username').value = '';
  container.querySelector('#u-username').disabled = false;
  container.querySelector('#u-password').value = '';
  container.querySelector('#u-email').value = '';
  container.querySelector('#u-superuser').checked = false;
  container.querySelector('#u-active').checked = true;
  container.querySelector('#u-2fa-enforced').checked = false;
  container.querySelector('#u-pwd-hint').classList.add('d-none');
  container.querySelector('#u-submit').textContent = t('users.create');
  container.querySelector('#perms-grid').innerHTML = renderPermsGrid([], _allPerms);
  container.querySelector('#perms-section').style.display = '';
  bootstrap.Modal.getOrCreateInstance(container.querySelector('#user-modal')).show();
}

function openEditModal(container, user, focusPerms = false) {
  _editTarget = user.username;
  container.querySelector('#user-modal-title').textContent = t('users.edit');
  container.querySelector('#u-username').value = user.username;
  container.querySelector('#u-username').disabled = true;
  container.querySelector('#u-password').value = '';
  container.querySelector('#u-pwd-hint').classList.remove('d-none');
  container.querySelector('#u-email').value = user.email || '';
  container.querySelector('#u-superuser').checked = user.is_superuser;
  container.querySelector('#u-active').checked = user.is_active;
  container.querySelector('#u-2fa-enforced').checked = user.totp_enforced;
  container.querySelector('#u-submit').textContent = t('users.save');
  container.querySelector('#perms-grid').innerHTML = renderPermsGrid(user.permissions || [], _allPerms);
  container.querySelector('#perms-section').style.display = user.is_superuser ? 'none' : '';
  bootstrap.Modal.getOrCreateInstance(container.querySelector('#user-modal')).show();
  if (focusPerms) {
    setTimeout(() => container.querySelector('#perms-grid')?.scrollIntoView({ behavior: 'smooth' }), 300);
  }
}

async function submitUser(container) {
  const username = container.querySelector('#u-username').value.trim();
  const password = container.querySelector('#u-password').value;
  const email = container.querySelector('#u-email').value || null;
  const is_superuser = container.querySelector('#u-superuser').checked;
  const is_active = container.querySelector('#u-active').checked;
  const totp_enforced = container.querySelector('#u-2fa-enforced').checked;

  try {
    if (_editTarget) {
      // Edit existing
      const patch = { email, is_superuser, is_active, totp_enforced };
      if (password) patch.password = password;
      await apiPatch(`/auth/users/${_editTarget}`, patch);

      // Update permissions if not superuser
      if (!is_superuser) {
        const checked = [...container.querySelectorAll('#perms-grid input[type=checkbox]:checked')]
          .map(el => el.value);
        await apiPut(`/auth/users/${_editTarget}/permissions`, { permissions: checked });
      }
      showToast(t('users.saved'), 'success');
    } else {
      // Create new
      if (!username || !password) { showToast(t('users.username_pwd_required'), 'warning'); return; }
      await apiPost('/auth/users', { username, password, email, is_superuser });
      if (!is_superuser) {
        const checked = [...container.querySelectorAll('#perms-grid input[type=checkbox]:checked')]
          .map(el => el.value);
        if (checked.length) await apiPut(`/auth/users/${username}/permissions`, { permissions: checked });
      }
      showToast(t('users.created'), 'success');
    }
    bootstrap.Modal.getOrCreateInstance(container.querySelector('#user-modal')).hide();
    render(container);
  } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
}

function renderPermsGrid(userPerms, allPerms) {
  if (!allPerms.length) return '';
  return allPerms.map(p => `
    <div class="col">
      <label class="form-check">
        <input type="checkbox" class="form-check-input" value="${p.slug}"
          ${userPerms.includes(p.slug) ? 'checked' : ''} />
        <span class="form-check-label small">${p.slug}</span>
      </label>
    </div>`).join('');
}

function renderRows(users) {
  const lang = getLang();
  const dateLocale = lang === 'it' ? 'it-IT' : 'en-GB';
  if (!users.length) return `<tr><td colspan="7" class="text-center text-muted py-4">${t('users.none')}</td></tr>`;
  return users.map(u => `
    <tr>
      <td><strong>${u.username}</strong>${u.is_protected ? ` <span class="badge bg-blue-lt">${t('users.protected')}</span>` : ''}</td>
      <td>${u.email || '—'}</td>
      <td>${u.is_superuser ? `<span class="badge bg-red">${t('users.role_admin')}</span>` : `<span class="badge bg-secondary">${t('users.role_user')}</span>`}</td>
      <td>${u.totp_enabled
        ? `<span class="badge bg-success-lt" title="2FA on"><i class="ti ti-shield-check"></i></span>`
        : (u.totp_enforced
          ? `<span class="badge bg-warning-lt" title="${t('users.2fa_enforced')}"><i class="ti ti-shield-exclamation"></i></span>`
          : `<span class="badge bg-secondary-lt"><i class="ti ti-shield-off"></i></span>`)
      }</td>
      <td>${u.is_active ? `<span class="badge bg-success-lt">${t('users.status_active')}</span>` : `<span class="badge bg-danger-lt">${t('users.status_disabled')}</span>`}</td>
      <td>${u.last_login ? new Date(u.last_login+'Z').toLocaleDateString(dateLocale) : '—'}</td>
      <td class="text-end">
        <div class="d-flex gap-1 justify-content-end">
          <button class="btn btn-sm btn-ghost-primary" data-action="edit" data-username="${u.username}" title="${t('users.edit')}">
            <i class="ti ti-edit"></i>
          </button>
          <button class="btn btn-sm btn-ghost-secondary" data-action="toggle" data-username="${u.username}" title="${u.is_active ? t('users.disable') : t('users.enable')}">
            <i class="ti ${u.is_active ? 'ti-lock' : 'ti-lock-open'}"></i>
          </button>
          ${u.totp_enabled ? `<button class="btn btn-sm btn-ghost-warning" data-action="reset-2fa" data-username="${u.username}" title="${t('users.reset_2fa')}">
            <i class="ti ti-shield-x"></i>
          </button>` : ''}
          ${!u.is_protected ? `<button class="btn btn-sm btn-ghost-danger" data-action="delete" data-username="${u.username}" title="${t('users.delete')}">
            <i class="ti ti-trash"></i>
          </button>` : ''}
        </div>
      </td>
    </tr>`).join('');
}
