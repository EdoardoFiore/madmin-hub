/**
 * Enrollment — generate tokens, show history with copy button.
 */
import { apiGet, apiPost, apiDelete } from '../api.js';
import { showSpinner, relativeTime, showToast, escapeHtml } from '../utils.js';

export async function render(container) {
  showSpinner(container);
  let [tokens, groups] = [[], []];
  try {
    [tokens, groups] = await Promise.all([
      apiGet('/enrollment/tokens'),
      apiGet('/groups'),
    ]);
  } catch { }

  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl">
        <h2 class="page-title">Enrollment token</h2>
      </div>
    </div>
    <div class="page-body">
      <div class="container-xl">
        <div class="row row-cards">
          <!-- Create new token -->
          <div class="col-lg-4">
            <div class="card">
              <div class="card-header"><h3 class="card-title">Genera token</h3></div>
              <div class="card-body">
                <div class="mb-2">
                  <label class="form-label">Gruppo (opzionale)</label>
                  <select id="e-group" class="form-select">
                    <option value="">Nessun gruppo</option>
                    ${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
                  </select>
                </div>
                <button id="e-create" class="btn btn-primary w-100">Genera token (15 min)</button>
                <div id="e-result" class="mt-3 d-none">
                  <div class="alert alert-success">
                    <div class="mb-1 fw-bold">Token generato — copia ora, non verrà mostrato di nuovo:</div>
                    <div class="token-display" id="e-token-val"></div>
                    <button class="btn btn-sm btn-success mt-2" id="e-copy-btn">
                      <i class="ti ti-copy me-1"></i>Copia
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Token history -->
          <div class="col-lg-8">
            <div class="card">
              <div class="card-header"><h3 class="card-title">Token recenti</h3></div>
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr><th>Creato</th><th>Scadenza</th><th>Stato</th><th>Istanza</th><th></th></tr></thead>
                  <tbody id="tokens-tbody">${renderRows(tokens)}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- Instructions -->
        <div class="card mt-4">
          <div class="card-header"><h3 class="card-title">Come usare il token</h3></div>
          <div class="card-body">
            <ol class="mb-0">
              <li>Attiva il modulo <strong>agent</strong> sull'istanza MADMIN target (abilitato di default)</li>
              <li>Nella view <strong>Hub Agent</strong> dell'istanza, incolla l'URL di Hub e il token</li>
              <li>Clicca <strong>Registra istanza</strong></li>
              <li>L'istanza comparirà qui in pochi secondi con stato <em>Online</em></li>
            </ol>
          </div>
        </div>
      </div>
    </div>`;

  container.querySelector('#e-create').addEventListener('click', async () => {
    const groupId = container.querySelector('#e-group').value || null;
    try {
      const data = await apiPost('/enrollment/tokens', {
        target_group_id: groupId,
        default_tags: [],
      });
      const tokenVal = container.querySelector('#e-token-val');
      tokenVal.textContent = data.token;
      container.querySelector('#e-result').classList.remove('d-none');
      container.querySelector('#e-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(data.token);
        showToast('Token copiato', 'success');
      });
      // Refresh table
      const newTokens = await apiGet('/enrollment/tokens');
      container.querySelector('#tokens-tbody').innerHTML = renderRows(newTokens);
    } catch (e) { showToast(e.detail || 'Errore', 'error'); }
  });

  container.querySelector('#tokens-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="revoke"]');
    if (!btn) return;
    try {
      await apiDelete(`/enrollment/tokens/${btn.dataset.id}`);
      showToast('Token revocato', 'success');
      render(container);
    } catch { showToast('Errore', 'error'); }
  });
}

function renderRows(tokens) {
  if (!tokens.length) return '<tr><td colspan="5" class="text-center text-muted py-4">Nessun token</td></tr>';
  return tokens.map(t => {
    const used = t.is_used;
    const expired = t.is_expired;
    const status = used ? '<span class="badge bg-success-lt">Usato</span>'
                 : expired ? '<span class="badge bg-danger-lt">Scaduto</span>'
                 : '<span class="badge bg-warning-lt">Valido</span>';
    return `<tr>
      <td>${relativeTime(t.created_at)}</td>
      <td>${new Date(t.expires_at + 'Z').toLocaleTimeString()}</td>
      <td>${status}</td>
      <td>${t.used_by_instance_id ? `<span class="text-mono small">${t.used_by_instance_id.substring(0,8)}…</span>` : '—'}</td>
      <td class="text-end">
        ${!used && !expired ? `<button class="btn btn-sm btn-ghost-danger" data-action="revoke" data-id="${t.id}"><i class="ti ti-x"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');
}
