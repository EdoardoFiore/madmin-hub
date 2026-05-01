/**
 * Groups — list with member count, create, edit, delete.
 */
import { apiGet, apiPost, apiPatch, apiDelete } from '../api.js';
import { showSpinner, showToast } from '../utils.js';
import { t } from '../i18n.js';

let _editTarget = null;

export async function render(container) {
  showSpinner(container);
  let groups = [];
  try { groups = await apiGet('/groups'); } catch { }

  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl">
        <h2 class="page-title">${t('groups.title')}</h2>
      </div>
    </div>
    <div class="page-body">
      <div class="container-xl">
        <div class="row row-cards">
          <div class="col-lg-4">
            <div class="card">
              <div class="card-header"><h3 class="card-title">${t('groups.new_group')}</h3></div>
              <div class="card-body">
                <div class="mb-2">
                  <label class="form-label">${t('groups.label_name')}</label>
                  <input id="g-name" type="text" class="form-control" />
                </div>
                <div class="mb-2">
                  <label class="form-label">${t('groups.label_desc')}</label>
                  <input id="g-desc" type="text" class="form-control" />
                </div>
                <div class="mb-3">
                  <label class="form-label">${t('groups.label_color')}</label>
                  <input id="g-color" type="color" class="form-control form-control-color" value="#206bc4" />
                </div>
                <button id="g-create" class="btn btn-primary w-100">${t('groups.create_btn')}</button>
              </div>
            </div>
          </div>
          <div class="col-lg-8">
            <div class="card">
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr>
                    <th>${t('groups.col_name')}</th>
                    <th>${t('groups.col_description')}</th>
                    <th>${t('groups.col_color')}</th>
                    <th>${t('groups.col_members')}</th>
                    <th></th>
                  </tr></thead>
                  <tbody id="groups-tbody">${renderRows(groups)}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit group modal -->
    <div class="modal modal-blur fade" id="group-edit-modal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${t('groups.edit')}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-2">
              <label class="form-label">${t('groups.label_name')}</label>
              <input id="ge-name" type="text" class="form-control" />
            </div>
            <div class="mb-2">
              <label class="form-label">${t('groups.label_desc')}</label>
              <input id="ge-desc" type="text" class="form-control" />
            </div>
            <div class="mb-3">
              <label class="form-label">${t('groups.label_color')}</label>
              <input id="ge-color" type="color" class="form-control form-control-color" />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-link" data-bs-dismiss="modal">${t('users.cancel')}</button>
            <button id="ge-submit" class="btn btn-primary">${t('groups.save')}</button>
          </div>
        </div>
      </div>
    </div>`;

  container.querySelector('#g-create').addEventListener('click', async () => {
    const name = container.querySelector('#g-name').value.trim();
    if (!name) { showToast(t('groups.name_required'), 'warning'); return; }
    try {
      await apiPost('/groups', {
        name,
        description: container.querySelector('#g-desc').value,
        color: container.querySelector('#g-color').value,
      });
      showToast(t('groups.created'), 'success');
      render(container);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  container.querySelector('#groups-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'detail') {
      window.location.hash = `groups/${id}`;
    } else if (action === 'edit') {
      const g = groups.find(g => g.id === id);
      if (!g) return;
      _editTarget = id;
      container.querySelector('#ge-name').value = g.name;
      container.querySelector('#ge-desc').value = g.description || '';
      container.querySelector('#ge-color').value = g.color;
      bootstrap.Modal.getOrCreateInstance(container.querySelector('#group-edit-modal')).show();
    } else if (action === 'delete') {
      if (!confirm(t('groups.confirm_delete'))) return;
      try {
        await apiDelete(`/groups/${id}`);
        showToast(t('groups.deleted'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    }
  });

  container.querySelector('#ge-submit').addEventListener('click', async () => {
    if (!_editTarget) return;
    try {
      await apiPatch(`/groups/${_editTarget}`, {
        name: container.querySelector('#ge-name').value.trim(),
        description: container.querySelector('#ge-desc').value || null,
        color: container.querySelector('#ge-color').value,
      });
      showToast(t('groups.saved'), 'success');
      bootstrap.Modal.getOrCreateInstance(container.querySelector('#group-edit-modal')).hide();
      render(container);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
}

function renderRows(groups) {
  if (!groups.length) return `<tr><td colspan="5" class="text-center text-muted py-4">${t('groups.none')}</td></tr>`;
  return groups.map(g => `
    <tr>
      <td><strong>${g.name}</strong></td>
      <td>${g.description || '—'}</td>
      <td><span class="badge" style="background:${g.color};color:#fff">${g.color}</span></td>
      <td><span class="badge bg-secondary-lt">${g.member_count ?? 0}</span></td>
      <td class="text-end">
        <div class="d-flex gap-1 justify-content-end">
          <button class="btn btn-sm btn-ghost-primary" data-action="detail" data-id="${g.id}" title="${t('groups.detail')}">
            <i class="ti ti-eye"></i>
          </button>
          <button class="btn btn-sm btn-ghost-secondary" data-action="edit" data-id="${g.id}" title="${t('groups.edit')}">
            <i class="ti ti-edit"></i>
          </button>
          <button class="btn btn-sm btn-ghost-danger" data-action="delete" data-id="${g.id}" title="${t('groups.delete')}">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </td>
    </tr>`).join('');
}
