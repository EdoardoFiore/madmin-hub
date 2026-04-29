/**
 * Groups — list, create, delete.
 */
import { apiGet, apiPost, apiDelete } from '../api.js';
import { showSpinner, showToast } from '../utils.js';

export async function render(container) {
  showSpinner(container);
  let groups = [];
  try { groups = await apiGet('/groups'); } catch { }

  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl">
        <h2 class="page-title">Gruppi</h2>
      </div>
    </div>
    <div class="page-body">
      <div class="container-xl">
        <div class="row row-cards">
          <div class="col-lg-4">
            <div class="card">
              <div class="card-header"><h3 class="card-title">Nuovo gruppo</h3></div>
              <div class="card-body">
                <div class="mb-2">
                  <label class="form-label">Nome</label>
                  <input id="g-name" type="text" class="form-control" />
                </div>
                <div class="mb-2">
                  <label class="form-label">Descrizione</label>
                  <input id="g-desc" type="text" class="form-control" />
                </div>
                <div class="mb-3">
                  <label class="form-label">Colore</label>
                  <input id="g-color" type="color" class="form-control form-control-color" value="#206bc4" />
                </div>
                <button id="g-create" class="btn btn-primary w-100">Crea gruppo</button>
              </div>
            </div>
          </div>
          <div class="col-lg-8">
            <div class="card">
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr><th>Nome</th><th>Descrizione</th><th>Colore</th><th></th></tr></thead>
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
    if (!name) { showToast('Nome obbligatorio', 'warning'); return; }
    try {
      await apiPost('/groups', {
        name,
        description: container.querySelector('#g-desc').value,
        color: container.querySelector('#g-color').value,
      });
      showToast('Gruppo creato', 'success');
      render(container);
    } catch (e) { showToast(e.detail || 'Errore', 'error'); }
  });

  container.querySelector('#groups-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="delete"]');
    if (!btn) return;
    if (!confirm('Eliminare gruppo? Le istanze verranno sganciate.')) return;
    try {
      await apiDelete(`/groups/${btn.dataset.id}`);
      showToast('Eliminato', 'success');
      render(container);
    } catch (e) { showToast(e.detail || 'Errore', 'error'); }
  });
}

function renderRows(groups) {
  if (!groups.length) return '<tr><td colspan="4" class="text-center text-muted py-4">Nessun gruppo</td></tr>';
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
