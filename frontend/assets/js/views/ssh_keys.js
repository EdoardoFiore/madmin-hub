/**
 * SSH Keys — vault CRUD + assignment push/revoke.
 */
import { apiGet, apiPost, apiDelete } from '../api.js';
import { showSpinner, showToast, relativeTime } from '../utils.js';
import { t } from '../i18n.js';

export async function render(container) {
  showSpinner(container);
  let [keys, assignments, instances, groups] = [[], [], [], []];
  try {
    [keys, assignments, instances, groups] = await Promise.all([
      apiGet('/ssh/keys'),
      apiGet('/ssh/assignments'),
      apiGet('/instances').catch(() => []),
      apiGet('/groups').catch(() => []),
    ]);
  } catch (e) {
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-danger">${t('ssh.load_error')}</div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl"><h2 class="page-title">${t('ssh.vault_title')}</h2></div>
    </div>
    <div class="page-body">
      <div class="container-xl">

        <!-- Keys -->
        <div class="row row-cards mb-4">
          <div class="col-lg-4">
            <div class="card h-100">
              <div class="card-header"><h3 class="card-title">${t('ssh.add_title')}</h3></div>
              <div class="card-body">
                <div class="mb-2">
                  <label class="form-label">${t('ssh.label_name')}</label>
                  <input id="k-name" type="text" class="form-control" placeholder="${t('ssh.vault_title')}" />
                </div>
                <div class="mb-2">
                  <label class="form-label">${t('ssh.label_pubkey')}</label>
                  <textarea id="k-pubkey" class="form-control text-mono" rows="4"
                    placeholder="ssh-rsa AAAA…"></textarea>
                </div>
                <div class="mb-3">
                  <label class="form-label">${t('ssh.label_notes')}</label>
                  <input id="k-notes" type="text" class="form-control" />
                </div>
                <button id="k-add" class="btn btn-primary w-100">${t('ssh.add_btn')}</button>
              </div>
            </div>
          </div>
          <div class="col-lg-8">
            <div class="card h-100">
              <div class="card-header"><h3 class="card-title">${t('ssh.list_title')}</h3></div>
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr>
                    <th>${t('label.name', {})}</th>
                    <th>${t('ssh.col_fingerprint')}</th>
                    <th>${t('ssh.col_owner')}</th>
                    <th>${t('ssh.col_created')}</th>
                    <th></th>
                  </tr></thead>
                  <tbody id="keys-tbody">${renderKeyRows(keys)}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- Assignments -->
        <div class="card">
          <div class="card-header d-flex align-items-center">
            <h3 class="card-title mb-0">${t('ssh.assign_title')}</h3>
            <button class="btn btn-primary btn-sm ms-auto" data-bs-toggle="modal" data-bs-target="#assign-modal">
              <i class="ti ti-plus me-1"></i>${t('ssh.new_assign')}
            </button>
          </div>
          <div class="table-responsive">
            <table class="table table-vcenter card-table">
              <thead><tr>
                <th>${t('ssh.col_key')}</th>
                <th>${t('ssh.col_target')}</th>
                <th>${t('ssh.col_user')}</th>
                <th>${t('ssh.col_status')}</th>
                <th>${t('ssh.col_push')}</th>
                <th></th>
              </tr></thead>
              <tbody id="assign-tbody">${renderAssignRows(assignments, keys, instances, groups)}</tbody>
            </table>
          </div>
        </div>

        <!-- Assign modal -->
        <div class="modal modal-blur fade" id="assign-modal" tabindex="-1">
          <div class="modal-dialog">
            <div class="modal-content">
              <div class="modal-header"><h5 class="modal-title">${t('ssh.modal_title')}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <div class="mb-2">
                  <label class="form-label">${t('ssh.label_key')}</label>
                  <select id="a-key" class="form-select">
                    ${keys.map(k => `<option value="${k.id}">${k.name} (${k.fingerprint.substring(0,20)}…)</option>`).join('')}
                  </select>
                </div>
                <div class="mb-2">
                  <label class="form-label">${t('ssh.label_target')}</label>
                  <select id="a-type" class="form-select mb-1">
                    <option value="instance">${t('ssh.target_instance')}</option>
                    <option value="group">${t('ssh.target_group')}</option>
                  </select>
                  <select id="a-instance" class="form-select">
                    ${instances.map(i => `<option value="${i.id}">${i.name}</option>`).join('')}
                  </select>
                  <select id="a-group" class="form-select d-none">
                    ${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
                  </select>
                </div>
                <div class="mb-2">
                  <label class="form-label">${t('ssh.label_linux_user')}</label>
                  <input id="a-user" type="text" class="form-control" value="madmin" />
                </div>
                <div class="mb-2">
                  <label class="form-label">${t('ssh.label_allowed_ips')}</label>
                  <textarea id="a-ips" class="form-control text-mono" rows="2"
                    placeholder="192.168.1.0/24&#10;10.0.0.1"></textarea>
                </div>
              </div>
              <div class="modal-footer">
                <button class="btn btn-link" data-bs-dismiss="modal">${t('ssh.cancel')}</button>
                <button id="a-submit" class="btn btn-primary">${t('ssh.push_btn')}</button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>`;

  // Toggle target selector
  container.querySelector('#a-type').addEventListener('change', (e) => {
    container.querySelector('#a-instance').classList.toggle('d-none', e.target.value === 'group');
    container.querySelector('#a-group').classList.toggle('d-none', e.target.value === 'instance');
  });

  // Add key
  container.querySelector('#k-add').addEventListener('click', async () => {
    const name = container.querySelector('#k-name').value.trim();
    const pubkey = container.querySelector('#k-pubkey').value.trim();
    if (!name || !pubkey) { showToast(t('ssh.name_required'), 'warning'); return; }
    try {
      await apiPost('/ssh/keys', { name, public_key: pubkey, notes: container.querySelector('#k-notes').value });
      showToast(t('ssh.key_added'), 'success');
      render(container);
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });

  // Push assignment
  container.querySelector('#a-submit').addEventListener('click', async () => {
    const type = container.querySelector('#a-type').value;
    const targetId = type === 'instance'
      ? container.querySelector('#a-instance').value
      : container.querySelector('#a-group').value;
    const ips = container.querySelector('#a-ips').value.split('\n').map(s => s.trim()).filter(Boolean);
    try {
      await apiPost('/ssh/assignments', {
        ssh_key_id: container.querySelector('#a-key').value,
        target_type: type,
        target_id: targetId,
        target_user: container.querySelector('#a-user').value,
        allow_source_ips: ips,
      });
      showToast(t('ssh.key_pushed'), 'success');
      document.querySelector('#assign-modal')?.querySelector('[data-bs-dismiss="modal"]')?.click();
      render(container);
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });

  // Delete key
  container.querySelector('#keys-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="delete-key"]');
    if (!btn) return;
    if (!confirm(t('ssh.confirm_delete_key'))) return;
    try {
      await apiDelete(`/ssh/keys/${btn.dataset.id}`);
      showToast(t('ssh.key_deleted'), 'success');
      render(container);
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });

  // Revoke assignment
  container.querySelector('#assign-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="revoke-assign"]');
    if (!btn) return;
    if (!confirm(t('ssh.confirm_revoke'))) return;
    try {
      await apiDelete(`/ssh/assignments/${btn.dataset.id}`);
      showToast(t('ssh.revoked'), 'success');
      render(container);
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });
}

function renderKeyRows(keys) {
  if (!keys.length) return `<tr><td colspan="5" class="text-muted text-center py-4">${t('ssh.none_keys')}</td></tr>`;
  return keys.map(k => `
    <tr>
      <td><strong>${k.name}</strong></td>
      <td class="text-mono small">${k.fingerprint}</td>
      <td>${k.owner || '—'}</td>
      <td>${relativeTime(k.created_at)}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-ghost-danger" data-action="delete-key" data-id="${k.id}">
          <i class="ti ti-trash"></i>
        </button>
      </td>
    </tr>`).join('');
}

function renderAssignRows(assignments, keys, instances, groups) {
  if (!assignments.length) return `<tr><td colspan="6" class="text-muted text-center py-4">${t('ssh.none_assign')}</td></tr>`;
  return assignments.map(a => {
    const key = keys.find(k => k.id === a.ssh_key_id);
    const targetLabel = a.target_type === 'instance'
      ? (instances.find(i => i.id === a.target_id)?.name || a.target_id.substring(0, 8))
      : (groups.find(g => g.id === a.target_id)?.name || a.target_id.substring(0, 8));
    const statusBadge = {
      pending: `<span class="badge bg-warning-lt">${t('ssh.assign_status.pending')}</span>`,
      active:  `<span class="badge bg-success-lt">${t('ssh.assign_status.active')}</span>`,
      revoked: `<span class="badge bg-danger-lt">${t('ssh.assign_status.revoked')}</span>`,
    }[a.status] || a.status;
    return `<tr>
      <td>${key?.name || '—'}</td>
      <td><i class="ti ti-${a.target_type === 'instance' ? 'server' : 'folders'} me-1"></i>${targetLabel}</td>
      <td class="text-mono small">${a.target_user}</td>
      <td>${statusBadge}</td>
      <td>${relativeTime(a.pushed_at)}</td>
      <td class="text-end">
        ${a.status === 'active' ? `<button class="btn btn-sm btn-ghost-danger" data-action="revoke-assign" data-id="${a.id}"><i class="ti ti-key-off"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');
}
