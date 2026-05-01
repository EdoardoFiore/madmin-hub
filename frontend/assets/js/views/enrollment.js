/**
 * Enrollment — generate tokens, show history with copy button.
 */
import { apiGet, apiPost, apiDelete } from '../api.js';
import { showSpinner, relativeTime, showToast, escapeHtml } from '../utils.js';
import { t } from '../i18n.js';

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
        <h2 class="page-title">${t('enrollment.title')}</h2>
      </div>
    </div>
    <div class="page-body">
      <div class="container-xl">
        <div class="row row-cards">
          <!-- Create new token -->
          <div class="col-lg-4">
            <div class="card">
              <div class="card-header"><h3 class="card-title">${t('enrollment.generate_title')}</h3></div>
              <div class="card-body">
                <div class="mb-2">
                  <label class="form-label">${t('enrollment.group_label')}</label>
                  <select id="e-group" class="form-select">
                    <option value="">${t('enrollment.no_group')}</option>
                    ${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
                  </select>
                </div>
                <button id="e-create" class="btn btn-primary w-100">${t('enrollment.generate_btn')}</button>
                <div id="e-result" class="mt-3 d-none">
                  <div class="alert alert-success">
                    <div class="mb-1 fw-bold">${t('enrollment.token_msg')}</div>
                    <div class="token-display" id="e-token-val"></div>
                    <button class="btn btn-sm btn-success mt-2" id="e-copy-btn">
                      <i class="ti ti-copy me-1"></i>${t('enrollment.copy')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Token history -->
          <div class="col-lg-8">
            <div class="card">
              <div class="card-header"><h3 class="card-title">${t('enrollment.recent_title')}</h3></div>
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr>
                    <th>${t('enrollment.col_created')}</th>
                    <th>${t('enrollment.col_expiry')}</th>
                    <th>${t('enrollment.col_status')}</th>
                    <th>${t('enrollment.col_instance')}</th>
                    <th></th>
                  </tr></thead>
                  <tbody id="tokens-tbody">${renderRows(tokens)}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- Instructions -->
        <div class="card mt-4">
          <div class="card-header"><h3 class="card-title">${t('enrollment.how_title')}</h3></div>
          <div class="card-body">
            <ol class="mb-0">
              <li>${t('enrollment.step1')}</li>
              <li>${t('enrollment.step2')}</li>
              <li>${t('enrollment.step3')}</li>
              <li>${t('enrollment.step4')}</li>
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
        showToast(t('enrollment.token_copied'), 'success');
      });
      const newTokens = await apiGet('/enrollment/tokens');
      container.querySelector('#tokens-tbody').innerHTML = renderRows(newTokens);
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });

  container.querySelector('#tokens-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="revoke"]');
    if (!btn) return;
    try {
      await apiDelete(`/enrollment/tokens/${btn.dataset.id}`);
      showToast(t('enrollment.token_revoked'), 'success');
      render(container);
    } catch { showToast(t('msg.error', {}), 'error'); }
  });
}

function renderRows(tokens) {
  if (!tokens.length) return `<tr><td colspan="5" class="text-center text-muted py-4">${t('enrollment.none')}</td></tr>`;
  return tokens.map(tok => {
    const used = tok.is_used;
    const expired = tok.is_expired;
    const status = used    ? `<span class="badge bg-success-lt">${t('status.used')}</span>`
                 : expired ? `<span class="badge bg-danger-lt">${t('status.expired')}</span>`
                 :           `<span class="badge bg-warning-lt">${t('status.valid')}</span>`;
    return `<tr>
      <td>${relativeTime(tok.created_at)}</td>
      <td>${new Date(tok.expires_at + 'Z').toLocaleTimeString()}</td>
      <td>${status}</td>
      <td>${tok.used_by_instance_id ? `<span class="text-mono small">${tok.used_by_instance_id.substring(0,8)}…</span>` : '—'}</td>
      <td class="text-end">
        ${!used && !expired ? `<button class="btn btn-sm btn-ghost-danger" data-action="revoke" data-id="${tok.id}"><i class="ti ti-x"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');
}
