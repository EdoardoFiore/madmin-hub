/**
 * Instances list — table with filter by group/tag, status badge, click → detail.
 */
import { apiGet, apiDelete } from '../api.js';
import { showSpinner, statusBadge, relativeTime, showToast } from '../utils.js';
import { t } from '../i18n.js';

export async function render(container) {
  showSpinner(container);

  let [fleetData, groups] = [null, []];
  try {
    [fleetData, groups] = await Promise.all([apiGet('/dashboard/fleet'), apiGet('/groups')]);
  } catch {
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-danger">${t('instances.load_error')}</div></div>`;
    return;
  }

  const instances = fleetData.instances;

  container.innerHTML = `
    <div class="page-header d-print-none">
      <div class="container-xl">
        <div class="row g-2 align-items-center">
          <div class="col"><h2 class="page-title">${t('instances.title')}</h2></div>
          <div class="col-auto ms-auto d-flex gap-2">
            <select id="filter-group" class="form-select form-select-sm" style="min-width:150px">
              <option value="">${t('instances.all_groups')}</option>
              ${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
            </select>
            <button class="btn btn-primary btn-sm" onclick="location.hash='enrollment'">
              <i class="ti ti-plus me-1"></i>${t('instances.new_enrollment')}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="page-body">
      <div class="container-xl">
        <div class="card">
          <div class="card-header">
            <div class="input-group input-group-flat" style="max-width:280px">
              <span class="input-group-text"><i class="ti ti-search"></i></span>
              <input type="search" id="search-input" class="form-control" placeholder="${t('instances.search')}" />
            </div>
          </div>
          <div class="table-responsive">
            <table class="table table-vcenter card-table">
              <thead>
                <tr>
                  <th>${t('instances.col_status')}</th>
                  <th>${t('instances.col_name')}</th>
                  <th>${t('instances.col_group')}</th>
                  <th>${t('instances.col_version')}</th>
                  <th>${t('instances.col_contact')}</th>
                  <th>${t('instances.col_tags')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="instances-tbody">
                ${renderRows(instances, groups)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

  const tbody = container.querySelector('#instances-tbody');
  const searchInput = container.querySelector('#search-input');
  const groupFilter = container.querySelector('#filter-group');

  function reFilter() {
    const q = searchInput.value.toLowerCase();
    const gid = groupFilter.value;
    const filtered = instances.filter(i =>
      (!q || i.name.toLowerCase().includes(q)) &&
      (!gid || i.group_id === gid)
    );
    tbody.innerHTML = renderRows(filtered, groups);
    bindRowActions();
  }

  function bindRowActions() {
    tbody.querySelectorAll('[data-action="detail"]').forEach(el =>
      el.addEventListener('click', () => { window.location.hash = `instance/${el.dataset.id}`; })
    );
    tbody.querySelectorAll('[data-action="revoke"]').forEach(el =>
      el.addEventListener('click', async () => {
        if (!confirm(t('instances.confirm_revoke'))) return;
        try {
          await apiDelete(`/instances/${el.dataset.id}`);
          showToast(t('instances.revoked'), 'success');
          render(container);
        } catch { showToast(t('msg.error', {}), 'error'); }
      })
    );
  }

  searchInput.addEventListener('input', reFilter);
  groupFilter.addEventListener('change', reFilter);
  bindRowActions();
}

function renderRows(items, groups) {
  if (!items.length) return `<tr><td colspan="7" class="text-center text-muted py-4">${t('instances.none_found')}</td></tr>`;
  return items.map(i => {
    const group = groups.find(g => g.id === i.group_id);
    return `<tr>
      <td>${statusBadge(i.ws_connected, i.enrollment_status)}</td>
      <td><strong class="text-body">${i.name}</strong><br><small class="text-muted text-mono">${i.fingerprint.substring(0,16)}…</small></td>
      <td>${group ? `<span class="badge" style="background:${group.color}20;color:${group.color}">${group.name}</span>` : '—'}</td>
      <td>${i.version || '—'}</td>
      <td>${relativeTime(i.last_seen_at)}</td>
      <td>${(i.tags || []).map(tag => `<span class="badge bg-azure-lt me-1">${tag}</span>`).join('') || '—'}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-primary me-1" data-action="detail" data-id="${i.id}">
          <i class="ti ti-eye"></i>
        </button>
        ${i.enrollment_status !== 'revoked' ? `
        <button class="btn btn-sm btn-outline-danger" data-action="revoke" data-id="${i.id}">
          <i class="ti ti-ban"></i>
        </button>` : ''}
      </td>
    </tr>`;
  }).join('');
}
