/**
 * Audit log — filter card, pagination, row expand.
 */
import { apiGet } from '../api.js';
import { showSpinner, escapeHtml } from '../utils.js';
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
            <select id="f-method" class="form-select form-select-sm" style="max-width:110px">
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
            <input id="f-from" type="date" class="form-control form-control-sm" style="max-width:140px" title="${t('audit.f_from')}" />
            <input id="f-to" type="date" class="form-control form-control-sm" style="max-width:140px" title="${t('audit.f_to')}" />
            <input id="f-search" type="text" class="form-control form-control-sm" placeholder="${t('audit.f_search')}" style="max-width:180px" />
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
          <div class="card-footer d-flex align-items-center justify-content-between">
            <div id="audit-info" class="text-muted small"></div>
            <div class="d-flex gap-1 align-items-center">
              <button id="pg-prev" class="btn btn-sm btn-outline-secondary">&laquo;</button>
              <span id="pg-label" class="text-muted small mx-2"></span>
              <button id="pg-next" class="btn btn-sm btn-outline-secondary">&raquo;</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const dateLocale = getLang() === 'it' ? 'it-IT' : 'en-GB';
  let page = 1;
  const perPage = 50;
  let totalPages = 1;

  async function load() {
    const tbody = container.querySelector('#audit-tbody');
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-3"><div class="spinner-border spinner-border-sm"></div></td></tr>`;

    const params = new URLSearchParams({ page, per_page: perPage });
    const user   = container.querySelector('#f-user').value.trim();
    const method = container.querySelector('#f-method').value;
    const cat    = container.querySelector('#f-cat').value;
    const from   = container.querySelector('#f-from').value;
    const to     = container.querySelector('#f-to').value;
    const search = container.querySelector('#f-search').value.trim();

    if (user)   params.set('username', user);
    if (method) params.set('method', method);
    if (cat)    params.set('category', cat);
    if (from)   params.set('from_date', from + 'T00:00:00');
    if (to)     params.set('to_date', to + 'T23:59:59');
    if (search) params.set('search', search);

    let data;
    try {
      data = await apiGet(`/logs/audit?${params}`);
    } catch {
      tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-center py-4">${t('msg.error')}</td></tr>`;
      return;
    }

    const items = data.items || data;
    const total = data.total ?? items.length;
    totalPages = Math.max(1, Math.ceil(total / perPage));

    container.querySelector('#audit-info').textContent = `${total} ${t('audit.total_results')}`;
    container.querySelector('#pg-label').textContent = `${page} / ${totalPages}`;
    container.querySelector('#pg-prev').disabled = page <= 1;
    container.querySelector('#pg-next').disabled = page >= totalPages;

    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-muted text-center py-4">${t('audit.no_results')}</td></tr>`;
      return;
    }

    tbody.innerHTML = items.map(r => {
      const bodyPreview = r.request_body ? escapeHtml(r.request_body.substring(0, 120)) : null;
      return `
      <tr class="audit-row" style="cursor:pointer" data-row-id="${r.id}">
        <td class="text-muted small">${new Date(r.timestamp+'Z').toLocaleString(dateLocale)}</td>
        <td>${escapeHtml(r.username)}</td>
        <td><span class="badge bg-${methodColor(r.method)}-lt">${r.method}</span></td>
        <td class="text-mono small text-truncate" style="max-width:240px" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}</td>
        <td><span class="badge bg-${r.status_code < 400 ? 'success' : 'danger'}-lt">${r.status_code}</span></td>
        <td class="text-muted small">${r.duration_ms}</td>
        <td class="text-muted small">${escapeHtml(r.client_ip)}</td>
      </tr>
      ${bodyPreview ? `<tr class="audit-detail d-none" data-detail-id="${r.id}">
        <td colspan="7" class="py-1 px-3 bg-muted-lt">
          <small class="text-muted fw-semibold">Request body: </small>
          <code class="small">${bodyPreview}${r.request_body?.length > 120 ? '…' : ''}</code>
        </td>
      </tr>` : ''}`;
    }).join('');
  }

  // Row expand toggle
  container.querySelector('#audit-tbody').addEventListener('click', (e) => {
    const row = e.target.closest('.audit-row');
    if (!row) return;
    const detail = container.querySelector(`.audit-detail[data-detail-id="${row.dataset.rowId}"]`);
    if (detail) detail.classList.toggle('d-none');
  });

  container.querySelector('#f-apply').addEventListener('click', () => { page = 1; load(); });
  container.querySelector('#pg-prev').addEventListener('click', () => { if (page > 1) { page--; load(); } });
  container.querySelector('#pg-next').addEventListener('click', () => { if (page < totalPages) { page++; load(); } });
  container.querySelector('#f-export').addEventListener('click', (e) => {
    e.preventDefault();
    window.open('/api/logs/audit/export', '_blank');
  });

  await load();
}

function methodColor(m) {
  return { GET: 'secondary', POST: 'blue', PATCH: 'yellow', PUT: 'orange', DELETE: 'red' }[m] || 'secondary';
}
