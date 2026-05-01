/**
 * Users management.
 */
import { apiGet, apiPost, apiPatch, apiDelete, apiPut } from '../api.js';
import { showSpinner, showToast } from '../utils.js';
import { t, getLang } from '../i18n.js';

export async function render(container) {
  showSpinner(container);
  let [users, allPerms] = [[], []];
  try {
    [users, allPerms] = await Promise.all([apiGet('/auth/users'), apiGet('/auth/permissions')]);
  } catch { }

  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl">
        <div class="row align-items-center">
          <div class="col"><h2 class="page-title">${t('users.title')}</h2></div>
          <div class="col-auto ms-auto">
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#user-modal">
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
                <th>${t('label.status', {})}</th>
                <th>${t('users.col_lastlogin')}</th>
                <th></th>
              </tr></thead>
              <tbody id="users-tbody">${renderRows(users)}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Create user modal -->
    <div class="modal modal-blur fade" id="user-modal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header"><h5 class="modal-title">${t('users.modal_title')}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-2"><label class="form-label">Username</label>
              <input id="u-username" type="text" class="form-control" /></div>
            <div class="mb-2"><label class="form-label">${t('label.password', {})}</label>
              <input id="u-password" type="password" class="form-control" /></div>
            <div class="mb-2"><label class="form-label">Email</label>
              <input id="u-email" type="email" class="form-control" /></div>
            <div class="mb-3">
              <label class="form-check">
                <input id="u-superuser" type="checkbox" class="form-check-input" />
                <span class="form-check-label">${t('users.superuser')}</span>
              </label>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-link" data-bs-dismiss="modal">${t('users.cancel')}</button>
            <button id="u-submit" class="btn btn-primary">${t('users.create')}</button>
          </div>
        </div>
      </div>
    </div>`;

  container.querySelector('#u-submit').addEventListener('click', async () => {
    try {
      await apiPost('/auth/users', {
        username: container.querySelector('#u-username').value,
        password: container.querySelector('#u-password').value,
        email: container.querySelector('#u-email').value || null,
        is_superuser: container.querySelector('#u-superuser').checked,
      });
      showToast(t('users.created'), 'success');
      document.querySelector('#user-modal [data-bs-dismiss="modal"]').click();
      render(container);
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });

  container.querySelector('#users-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, username, active } = btn.dataset;
    if (action === 'toggle') {
      try {
        await apiPatch(`/auth/users/${username}`, { is_active: active === 'true' ? false : true });
        showToast(t('users.status_updated'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
    } else if (action === 'delete') {
      if (!confirm(t('users.confirm_delete', { username }))) return;
      try {
        await apiDelete(`/auth/users/${username}`);
        showToast(t('users.deleted'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
    }
  });
}

function renderRows(users) {
  const lang = getLang();
  const dateLocale = lang === 'it' ? 'it-IT' : 'en-GB';
  if (!users.length) return `<tr><td colspan="6" class="text-center text-muted py-4">${t('users.none')}</td></tr>`;
  return users.map(u => `
    <tr>
      <td><strong>${u.username}</strong>${u.is_protected ? ` <span class="badge bg-blue-lt">${t('users.protected')}</span>` : ''}</td>
      <td>${u.email || '—'}</td>
      <td>${u.is_superuser ? `<span class="badge bg-red">${t('users.role_admin')}</span>` : `<span class="badge bg-secondary">${t('users.role_user')}</span>`}</td>
      <td>${u.is_active ? `<span class="badge bg-success-lt">${t('users.status_active')}</span>` : `<span class="badge bg-danger-lt">${t('users.status_disabled')}</span>`}</td>
      <td>${u.last_login ? new Date(u.last_login+'Z').toLocaleDateString(dateLocale) : '—'}</td>
      <td class="text-end d-flex gap-1 justify-content-end">
        <button class="btn btn-sm btn-ghost-secondary" data-action="toggle"
                data-username="${u.username}" data-active="${u.is_active}">
          <i class="ti ${u.is_active ? 'ti-lock' : 'ti-lock-open'}"></i>
        </button>
        ${!u.is_protected ? `<button class="btn btn-sm btn-ghost-danger" data-action="delete" data-username="${u.username}">
          <i class="ti ti-trash"></i>
        </button>` : ''}
      </td>
    </tr>`).join('');
}
