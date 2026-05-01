/**
 * Group detail view — member instances list, bulk ops, edit group inline.
 */
import { apiGet, apiPatch, apiPost } from '../api.js';
import { showSpinner, showToast, statusBadge, relativeTime } from '../utils.js';
import { t } from '../i18n.js';

export async function render(container, params) {
  const groupId = params?.[0];
  if (!groupId) {
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-warning">${t('groups.missing_id')}</div></div>`;
    return;
  }

  showSpinner(container);
  let detail = null;
  try {
    detail = await apiGet(`/groups/${groupId}`);
  } catch {
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-danger">${t('groups.load_error')}</div></div>`;
    return;
  }

  const instances = detail.instances || [];

  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl">
        <div class="row align-items-center">
          <div class="col-auto">
            <a href="#groups" class="btn btn-ghost-secondary btn-sm">
              <i class="ti ti-arrow-left me-1"></i>${t('groups.back')}
            </a>
          </div>
          <div class="col">
            <h2 class="page-title d-flex align-items-center gap-2">
              <span class="badge rounded-circle p-2" style="background:${detail.color}">&nbsp;</span>
              ${detail.name}
              <span class="badge bg-secondary-lt ms-1">${instances.length}</span>
            </h2>
            ${detail.description ? `<div class="text-muted">${detail.description}</div>` : ''}
          </div>
          <div class="col-auto">
            <button class="btn btn-sm btn-outline-secondary" id="btn-edit-group">
              <i class="ti ti-edit me-1"></i>${t('groups.edit')}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="page-body">
      <div class="container-xl">

        <!-- Bulk action bar (hidden until selection) -->
        <div id="bulk-bar" class="alert alert-info d-none mb-3 d-flex align-items-center gap-3">
          <span id="bulk-count"></span>
          <button class="btn btn-sm btn-outline-danger" data-bulk="revoke">${t('instances.bulk_revoke')}</button>
          <button class="btn btn-sm btn-outline-secondary ms-auto" id="bulk-clear">${t('instances.bulk_clear')}</button>
        </div>

        <div class="card">
          <div class="table-responsive">
            <table class="table table-vcenter card-table">
              <thead>
                <tr>
                  <th style="width:36px"><input type="checkbox" class="form-check-input" id="select-all" /></th>
                  <th>${t('instances.col_status')}</th>
                  <th>${t('instances.col_name')}</th>
                  <th>${t('instances.col_version')}</th>
                  <th>${t('instances.col_contact')}</th>
                  <th>${t('instances.col_tags')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="members-tbody">
                ${renderRows(instances)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit group modal -->
    <div class="modal modal-blur fade" id="edit-group-modal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${t('groups.edit')}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-2">
              <label class="form-label">${t('groups.label_name')}</label>
              <input id="eg-name" type="text" class="form-control" value="${detail.name}" />
            </div>
            <div class="mb-2">
              <label class="form-label">${t('groups.label_desc')}</label>
              <input id="eg-desc" type="text" class="form-control" value="${detail.description || ''}" />
            </div>
            <div class="mb-3">
              <label class="form-label">${t('groups.label_color')}</label>
              <input id="eg-color" type="color" class="form-control form-control-color" value="${detail.color}" />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-link" data-bs-dismiss="modal">${t('users.cancel')}</button>
            <button id="eg-save" class="btn btn-primary">${t('groups.save')}</button>
          </div>
        </div>
      </div>
    </div>`;

  // Select all
  const selectAll = container.querySelector('#select-all');
  const bulkBar = container.querySelector('#bulk-bar');
  const bulkCount = container.querySelector('#bulk-count');
  const tbody = container.querySelector('#members-tbody');

  function getSelected() {
    return [...tbody.querySelectorAll('input.row-check:checked')].map(el => el.dataset.id);
  }
  function updateBulkBar() {
    const sel = getSelected();
    if (sel.length) {
      bulkBar.classList.remove('d-none');
      bulkCount.textContent = t('instances.bulk_selected', { n: sel.length });
    } else {
      bulkBar.classList.add('d-none');
    }
  }

  selectAll.addEventListener('change', () => {
    tbody.querySelectorAll('input.row-check').forEach(el => { el.checked = selectAll.checked; });
    updateBulkBar();
  });
  tbody.addEventListener('change', (e) => {
    if (e.target.classList.contains('row-check')) updateBulkBar();
  });
  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="detail"]');
    if (btn) window.location.hash = `instance/${btn.dataset.id}`;
  });

  container.querySelector('#bulk-clear').addEventListener('click', () => {
    tbody.querySelectorAll('input.row-check').forEach(el => el.checked = false);
    selectAll.checked = false;
    updateBulkBar();
  });

  bulkBar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn) return;
    const action = btn.dataset.bulk;
    const ids = getSelected();
    if (!ids.length) return;
    if (!confirm(t('instances.confirm_bulk_action', { n: ids.length }))) return;
    try {
      await apiPost('/instances/bulk', { instance_ids: ids, action });
      showToast(t('instances.bulk_done'), 'success');
      render(container, params);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  // Edit group modal
  container.querySelector('#btn-edit-group').addEventListener('click', () => {
    bootstrap.Modal.getOrCreateInstance(container.querySelector('#edit-group-modal')).show();
  });
  container.querySelector('#eg-save').addEventListener('click', async () => {
    try {
      await apiPatch(`/groups/${groupId}`, {
        name: container.querySelector('#eg-name').value.trim(),
        description: container.querySelector('#eg-desc').value || null,
        color: container.querySelector('#eg-color').value,
      });
      showToast(t('groups.saved'), 'success');
      bootstrap.Modal.getOrCreateInstance(container.querySelector('#edit-group-modal')).hide();
      render(container, params);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
}

function renderRows(instances) {
  if (!instances.length) return `<tr><td colspan="7" class="text-center text-muted py-4">${t('groups.no_members')}</td></tr>`;
  return instances.map(i => `
    <tr>
      <td><input type="checkbox" class="form-check-input row-check" data-id="${i.id}" /></td>
      <td>${statusBadge(i.ws_connected, i.enrollment_status)}</td>
      <td><strong>${i.name}</strong><br><small class="text-muted text-mono">${i.fingerprint.substring(0,16)}…</small></td>
      <td>${i.version || '—'}</td>
      <td>${relativeTime(i.last_seen_at)}</td>
      <td>${(i.tags || []).map(tag => `<span class="badge bg-azure-lt me-1">${tag}</span>`).join('') || '—'}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-ghost-primary" data-action="detail" data-id="${i.id}">
          <i class="ti ti-eye"></i>
        </button>
      </td>
    </tr>`).join('');
}
