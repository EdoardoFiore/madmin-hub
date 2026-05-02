import { apiGet } from '../api.js';
import { t } from '../i18n.js';
import { debounce, escapeHtml, actionLabel, showToast } from '../utils.js';

const PAGE_SIZE = 50;

let _filters = { search: '', user: '', action: '', from: '', to: '', period: '24h' };
let _offset = 0, _total = 0, _rows = [];

export async function render(container) {
  // Compute default time range from period
  _offset = 0; _rows = [];
  const now = new Date();

  container.innerHTML = `
    <div class="hub-page-header">
      <h1 class="hub-page-title">${t('audit.title')}</h1>
      <button class="btn btn-sm btn-outline-secondary" id="audit-export">
        <i class="ti ti-download me-1"></i>${t('audit.export_csv')}
      </button>
    </div>
    <div class="filter-bar mb-0" id="audit-filter">
      <div class="filter-bar-search">
        <i class="ti ti-search"></i>
        <input type="text" id="af-search" class="form-control" placeholder="${t('audit.f_search')}" />
      </div>
      <input type="text" id="af-user" class="form-control" style="width:140px" placeholder="${t('audit.f_user')}" />
      <select id="af-action" class="form-select" style="width:auto">
        <option value="">${t('audit.f_action')}</option>
        <option value="write">WRITE</option>
        <option value="read">READ</option>
        <option value="agent_ws">Agent WS</option>
      </select>
      <select id="af-period" class="form-select" style="width:auto">
        <option value="1h">${t('audit.period_1h')}</option>
        <option value="24h" selected>${t('audit.period_24h')}</option>
        <option value="7d">${t('audit.period_7d')}</option>
        <option value="30d">${t('audit.period_30d')}</option>
        <option value="custom">${t('audit.period_custom')}</option>
      </select>
      <span id="custom-range" style="display:none;align-items:center;gap:6px">
        <input type="datetime-local" id="af-from" class="form-control" style="width:200px" />
        <input type="datetime-local" id="af-to"   class="form-control" style="width:200px" />
      </span>
      <button class="filter-bar-clear" id="af-clear">${t('instances.bulk_clear')}</button>
    </div>
    <div id="audit-table"></div>
    <div id="audit-loadmore" style="text-align:center;padding:16px;display:none">
      <button class="btn btn-sm btn-outline-secondary" id="audit-more-btn">${t('audit.load_more')}</button>
    </div>`;

  wireFilters(container);
  document.getElementById('audit-export')?.addEventListener('click', exportCsv);
  await loadAudit(true);
}

function wireFilters(container) {
  const doSearch = debounce(() => { _offset = 0; _rows = []; loadAudit(true); }, 300);

  container.querySelector('#af-search')?.addEventListener('input', e => { _filters.search = e.target.value; doSearch(); });
  container.querySelector('#af-user')?.addEventListener('input',  e => { _filters.user   = e.target.value; doSearch(); });
  container.querySelector('#af-action')?.addEventListener('change', e => { _filters.action = e.target.value; doSearch(); });
  container.querySelector('#af-period')?.addEventListener('change', e => {
    _filters.period = e.target.value;
    document.getElementById('custom-range').style.display = e.target.value === 'custom' ? 'flex' : 'none';
    doSearch();
  });
  container.querySelector('#af-from')?.addEventListener('change', e => { _filters.from = e.target.value; if (_filters.period === 'custom') doSearch(); });
  container.querySelector('#af-to')?.addEventListener('change',   e => { _filters.to   = e.target.value; if (_filters.period === 'custom') doSearch(); });

  container.querySelector('#af-clear')?.addEventListener('click', () => {
    _filters = { search: '', user: '', action: '', from: '', to: '', period: '24h' };
    ['af-search','af-user'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('af-action').value = '';
    document.getElementById('af-period').value = '24h';
    _offset = 0; _rows = [];
    loadAudit(true);
  });

  container.querySelector('#audit-more-btn')?.addEventListener('click', () => loadAudit(false));
}

function buildQueryParams() {
  const p = new URLSearchParams();
  p.set('limit', String(PAGE_SIZE));
  p.set('offset', String(_offset));
  if (_filters.search) p.set('search', _filters.search);
  if (_filters.user)   p.set('username', _filters.user);
  if (_filters.action) p.set('category', _filters.action);

  if (_filters.period !== 'custom') {
    const now = new Date();
    const fromMs = { '1h': 3600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[_filters.period];
    if (fromMs) {
      p.set('from', new Date(now - fromMs).toISOString());
      p.set('to', now.toISOString());
    }
  } else {
    if (_filters.from) p.set('from', new Date(_filters.from).toISOString());
    if (_filters.to)   p.set('to',   new Date(_filters.to).toISOString());
  }
  return p;
}

async function loadAudit(reset) {
  if (reset) { _offset = 0; _rows = []; }
  try {
    const data = await apiGet(`/logs/audit?${buildQueryParams()}`);
    const items = data?.items || (Array.isArray(data) ? data : []);
    _total = data?.total ?? items.length;
    _rows = reset ? items : [..._rows, ...items];
    _offset = _rows.length;
    renderTable();
  } catch (_) {
    document.getElementById('audit-table').innerHTML =
      `<div class="alert alert-danger mt-2">${t('msg.error')}</div>`;
  }
}

function renderTable() {
  const el = document.getElementById('audit-table');
  const lm = document.getElementById('audit-loadmore');
  if (!el) return;

  if (!_rows.length) {
    el.innerHTML = `<div class="data-table mt-2"><div class="data-table-empty"><i class="ti ti-file-off"></i>${t('audit.no_results')}</div></div>`;
    if (lm) lm.style.display = 'none';
    return;
  }

  el.innerHTML = `<div class="data-table mt-2">
    <table><thead><tr>
      <th>${t('audit.col_ts')}</th>
      <th>${t('audit.col_user')}</th>
      <th>${t('audit.col_action')}</th>
      <th>${t('audit.col_path')}</th>
      <th>${t('audit.col_status')}</th>
      <th>${t('audit.col_ms')}</th>
    </tr></thead>
    <tbody>${_rows.map((r, i) => `<tr class="clickable" data-idx="${i}">
      <td style="white-space:nowrap;font-size:11px">${escapeHtml(r.timestamp ? new Date(r.timestamp + 'Z').toLocaleString() : '—')}</td>
      <td>${escapeHtml(r.username || r.user_id || '—')}</td>
      <td>${actionLabel(r.method)}</td>
      <td style="font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span class="text-mono">${escapeHtml(r.path || '—')}</span></td>
      <td><span class="hub-badge ${r.status_code < 400 ? 'online' : r.status_code < 500 ? 'warning' : 'offline'}" style="font-size:10px">${r.status_code}</span></td>
      <td style="font-size:12px">${r.duration_ms ?? '—'}</td>
    </tr>
    <tr class="expanded-row" id="exp-${i}" style="display:none">
      <td colspan="6" style="font-size:12px;padding:10px 14px">
        <strong>IP:</strong> ${escapeHtml(r.ip_address || '—')}<br>
        ${r.request_body ? `<strong>Body:</strong> <pre style="margin:4px 0;font-size:11px;white-space:pre-wrap;max-height:200px;overflow:auto">${escapeHtml(JSON.stringify(r.request_body, null, 2))}</pre>` : ''}
        ${r.response_summary ? `<strong>Response:</strong> ${escapeHtml(JSON.stringify(r.response_summary))}` : ''}
      </td>
    </tr>`).join('')}
    </tbody></table>
    <div class="data-table-footer">
      <span>${_total} ${t('audit.total_results')}</span>
    </div>
  </div>`;

  // Expand on click
  el.querySelectorAll('tbody tr.clickable').forEach(tr => {
    tr.addEventListener('click', () => {
      const expRow = document.getElementById(`exp-${tr.dataset.idx}`);
      if (expRow) {
        const visible = expRow.style.display !== 'none';
        expRow.style.display = visible ? 'none' : '';
        tr.classList.toggle('selected', !visible);
      }
    });
  });

  if (lm) lm.style.display = _rows.length < _total ? '' : 'none';
}

async function exportCsv() {
  try {
    const p = buildQueryParams();
    p.set('limit', '10000'); p.delete('offset');
    const data = await apiGet(`/logs/audit/export?${p}`);
    const blob = new Blob([data], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `audit_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  } catch (_) { showToast(t('msg.error'), 'error'); }
}
