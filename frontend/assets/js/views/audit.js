/**
 * Audit log — paginated table with filters.
 */
import { apiGet } from '../api.js';
import { showSpinner } from '../utils.js';
import { t, getLang } from '../i18n.js';

export async function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl"><h2 class="page-title">${t('audit.title')}</h2></div>
    </div>
    <div class="page-body">
      <div class="container-xl">
        <div class="card">
          <div class="card-header flex-wrap gap-2">
            <input id="f-user" type="text" class="form-control form-control-sm" placeholder="${t('audit.f_user')}" style="max-width:140px" />
            <select id="f-method" class="form-select form-select-sm" style="max-width:120px">
              <option value="">${t('audit.f_method')}</option>
              <option>GET</option><option>POST</option><option>PATCH</option>
              <option>PUT</option><option>DELETE</option>
            </select>
            <select id="f-cat" class="form-select form-select-sm" style="max-width:130px">
              <option value="">${t('audit.f_category')}</option>
              <option value="read">${t('audit.cat_read')}</option>
              <option value="write">${t('audit.cat_write')}</option>
              <option value="agent_ws">${t('audit.cat_agent_ws')}</option>
            </select>
            <button id="f-apply" class="btn btn-sm btn-primary">${t('audit.apply')}</button>
            <a id="f-export" href="#" class="btn btn-sm btn-outline-secondary ms-auto">
              <i class="ti ti-download me-1"></i>${t('audit.export_csv')}
            </a>
          </div>
          <div class="table-responsive">
            <table class="table table-vcenter table-sm card-table">
              <thead>
                <tr>
                  <th>${t('audit.col_ts')}</th>
                  <th>${t('audit.col_user')}</th>
                  <th>${t('audit.col_method')}</th>
                  <th>${t('audit.col_path')}</th>
                  <th>${t('audit.col_status')}</th>
                  <th>${t('audit.col_ms')}</th>
                  <th>${t('audit.col_ip')}</th>
                </tr>
              </thead>
              <tbody id="audit-tbody">
                <tr><td colspan="7" class="text-center py-4"><div class="spinner-border spinner-border-sm"></div></td></tr>
              </tbody>
            </table>
          </div>
          <div class="card-footer d-flex justify-content-end">
            <button id="load-more" class="btn btn-sm btn-outline-secondary">${t('audit.load_more')}</button>
          </div>
        </div>
      </div>
    </div>`;

  const dateLocale = getLang() === 'it' ? 'it-IT' : 'en-GB';
  let offset = 0;
  const limit = 100;

  async function load(append = false) {
    const params = new URLSearchParams({ limit, offset });
    const user   = container.querySelector('#f-user').value;
    const method = container.querySelector('#f-method').value;
    const cat    = container.querySelector('#f-cat').value;
    if (user)   params.set('username', user);
    if (method) params.set('method', method);
    if (cat)    params.set('category', cat);

    const rows = await apiGet(`/logs/audit?${params}`);
    const tbody = container.querySelector('#audit-tbody');
    if (!append) tbody.innerHTML = '';
    if (!rows?.length) {
      if (!append) tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-center py-4">${t('audit.no_results')}</td></tr>`;
      return;
    }
    tbody.insertAdjacentHTML('beforeend', rows.map(r => `
      <tr>
        <td class="text-muted small">${new Date(r.timestamp+'Z').toLocaleString(dateLocale)}</td>
        <td>${r.username}</td>
        <td><span class="badge bg-${methodColor(r.method)}-lt">${r.method}</span></td>
        <td class="text-mono small text-truncate" style="max-width:280px">${r.path}</td>
        <td><span class="badge bg-${r.status_code < 400 ? 'success' : 'danger'}-lt">${r.status_code}</span></td>
        <td class="text-muted small">${r.duration_ms}</td>
        <td class="text-muted small">${r.client_ip}</td>
      </tr>`).join(''));
    offset += rows.length;
  }

  await load();

  container.querySelector('#f-apply').addEventListener('click', () => { offset = 0; load(false); });
  container.querySelector('#load-more').addEventListener('click', () => load(true));
  container.querySelector('#f-export').addEventListener('click', (e) => {
    e.preventDefault();
    window.open('/api/logs/audit/export', '_blank');
  });
}

function methodColor(m) {
  return { GET: 'secondary', POST: 'blue', PATCH: 'yellow', PUT: 'orange', DELETE: 'red' }[m] || 'secondary';
}
