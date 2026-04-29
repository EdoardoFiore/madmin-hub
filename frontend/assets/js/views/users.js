/**
 * Users management — port from MADMIN pattern.
 */
import { apiGet, apiPost, apiPatch, apiDelete, apiPut } from '../api.js';
import { showSpinner, showToast } from '../utils.js';

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
          <div class="col"><h2 class="page-title">Utenti</h2></div>
          <div class="col-auto ms-auto">
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#user-modal">
              <i class="ti ti-plus me-1"></i>Nuovo utente
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
              <thead><tr><th>Username</th><th>Email</th><th>Ruolo</th><th>Stato</th><th>Ultimo accesso</th><th></th></tr></thead>
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
          <div class="modal-header"><h5 class="modal-title">Nuovo utente</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-2"><label class="form-label">Username</label>
              <input id="u-username" type="text" class="form-control" /></div>
            <div class="mb-2"><label class="form-label">Password</label>
              <input id="u-password" type="password" class="form-control" /></div>
            <div class="mb-2"><label class="form-label">Email</label>
              <input id="u-email" type="email" class="form-control" /></div>
            <div class="mb-3">
              <label class="form-check">
                <input id="u-superuser" type="checkbox" class="form-check-input" />
                <span class="form-check-label">Superuser</span>
              </label>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-link" data-bs-dismiss="modal">Annulla</button>
            <button id="u-submit" class="btn btn-primary">Crea</button>
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
      showToast('Utente creato', 'success');
      document.querySelector('#user-modal [data-bs-dismiss="modal"]').click();
      render(container);
    } catch (e) { showToast(e.detail || 'Errore', 'error'); }
  });

  container.querySelector('#users-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, username, active } = btn.dataset;
    if (action === 'toggle') {
      try {
        await apiPatch(`/auth/users/${username}`, { is_active: active === 'true' ? false : true });
        showToast('Stato aggiornato', 'success');
        render(container);
      } catch (e) { showToast(e.detail || 'Errore', 'error'); }
    } else if (action === 'delete') {
      if (!confirm(`Eliminare ${username}?`)) return;
      try {
        await apiDelete(`/auth/users/${username}`);
        showToast('Eliminato', 'success');
        render(container);
      } catch (e) { showToast(e.detail || 'Errore', 'error'); }
    }
  });
}

function renderRows(users) {
  if (!users.length) return '<tr><td colspan="6" class="text-center text-muted py-4">Nessun utente</td></tr>';
  return users.map(u => `
    <tr>
      <td><strong>${u.username}</strong>${u.is_protected ? ' <span class="badge bg-blue-lt">protetto</span>' : ''}</td>
      <td>${u.email || '—'}</td>
      <td>${u.is_superuser ? '<span class="badge bg-red">Admin</span>' : '<span class="badge bg-secondary">Utente</span>'}</td>
      <td>${u.is_active ? '<span class="badge bg-success-lt">Attivo</span>' : '<span class="badge bg-danger-lt">Disabilitato</span>'}</td>
      <td>${u.last_login ? new Date(u.last_login+'Z').toLocaleDateString('it-IT') : '—'}</td>
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
