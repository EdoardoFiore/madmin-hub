/**
 * Groups — list, create, delete.
 */
import { apiGet, apiPost, apiDelete } from '../api.js';
import { showSpinner, showToast } from '../utils.js';
import { t } from '../i18n.js';

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
                    <th></th>
                  </tr></thead>
                  <tbody id="groups-tbody">${renderRows(groups)}</tbody>
                </table>
              </div>
            </div>
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
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });

  container.querySelector('#groups-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="delete"]');
    if (!btn) return;
    if (!confirm(t('groups.confirm_delete'))) return;
    try {
      await apiDelete(`/groups/${btn.dataset.id}`);
      showToast(t('groups.deleted'), 'success');
      render(container);
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });
}

function renderRows(groups) {
  if (!groups.length) return `<tr><td colspan="4" class="text-center text-muted py-4">${t('groups.none')}</td></tr>`;
  return groups.map(g => `
    <tr>
      <td><strong>${g.name}</strong></td>
      <td>${g.description || '—'}</td>
      <td><span class="badge" style="background:${g.color};color:#fff">${g.color}</span></td>
      <td class="text-end">
        <button class="btn btn-sm btn-ghost-danger" data-action="delete" data-id="${g.id}">
          <i class="ti ti-trash"></i>
        </button>
      </td>
    </tr>`).join('');
}
