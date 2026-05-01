/**
 * Instances list — filter, bulk-select, bulk-ops, detail nav.
 */
import { apiGet, apiDelete, apiPost } from '../api.js';
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
  // Collect unique tags for tag filter
  const allTags = [...new Set(instances.flatMap(i => i.tags || []))].sort();

  container.innerHTML = `
    <div class="page-header d-print-none">
      <div class="container-xl">
        <div class="row g-2 align-items-center">
          <div class="col"><h2 class="page-title">${t('instances.title')}</h2></div>
          <div class="col-auto ms-auto d-flex gap-2 flex-wrap">
            <select id="filter-group" class="form-select form-select-sm" style="min-width:140px">
              <option value="">${t('instances.all_groups')}</option>
              ${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
            </select>
            <select id="filter-tag" class="form-select form-select-sm" style="min-width:120px">
              <option value="">${t('instances.all_tags')}</option>
              ${allTags.map(tag => `<option value="${tag}">${tag}</option>`).join('')}
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

        <!-- Bulk action bar -->
        <div id="bulk-bar" class="alert alert-info d-none mb-3">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span id="bulk-count" class="fw-bold"></span>
            <button class="btn btn-sm btn-outline-secondary" data-bulk="move-group">${t('instances.bulk_move_group')}</button>
            <button class="btn btn-sm btn-outline-secondary" data-bulk="add-tag">${t('instances.bulk_add_tag')}</button>
            <button class="btn btn-sm btn-outline-secondary" data-bulk="remove-tag">${t('instances.bulk_remove_tag')}</button>
            <button class="btn btn-sm btn-outline-danger" data-bulk="revoke">${t('instances.bulk_revoke')}</button>
            <button class="btn btn-sm btn-ghost-secondary ms-auto" id="bulk-clear">✕</button>
          </div>
        </div>

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
                  <th style="width:36px"><input type="checkbox" class="form-check-input" id="select-all" /></th>
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
  const tagFilter = container.querySelector('#filter-tag');
  const selectAll = container.querySelector('#select-all');
  const bulkBar = container.querySelector('#bulk-bar');
  const bulkCount = container.querySelector('#bulk-count');

  let filtered = [...instances];

  function reFilter() {
    const q = searchInput.value.toLowerCase();
    const gid = groupFilter.value;
    const tag = tagFilter.value;
    filtered = instances.filter(i =>
      (!q || i.name.toLowerCase().includes(q)) &&
      (!gid || i.group_id === gid) &&
      (!tag || (i.tags || []).includes(tag))
    );
    tbody.innerHTML = renderRows(filtered, groups);
    selectAll.checked = false;
    updateBulkBar();
    bindRowActions();
  }

  function getSelectedIds() {
    return [...tbody.querySelectorAll('input.row-check:checked')].map(el => el.dataset.id);
  }

  function updateBulkBar() {
    const sel = getSelectedIds();
    if (sel.length) {
      bulkBar.classList.remove('d-none');
      bulkCount.textContent = t('instances.bulk_selected', { n: sel.length });
    } else {
      bulkBar.classList.add('d-none');
    }
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
        } catch { showToast(t('msg.error'), 'error'); }
      })
    );
  }

  selectAll.addEventListener('change', () => {
    tbody.querySelectorAll('input.row-check').forEach(el => { el.checked = selectAll.checked; });
    updateBulkBar();
  });
  tbody.addEventListener('change', (e) => {
    if (e.target.classList.contains('row-check')) updateBulkBar();
  });
  container.querySelector('#bulk-clear').addEventListener('click', () => {
    tbody.querySelectorAll('input.row-check').forEach(el => el.checked = false);
    selectAll.checked = false;
    updateBulkBar();
  });

  bulkBar.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn) return;
    const op = btn.dataset.bulk;
    const ids = getSelectedIds();
    if (!ids.length) return;

    if (op === 'move-group') {
      const groupOptions = groups.map(g => `${g.id}: ${g.name}`).join('\n');
      const gid = prompt(`${t('instances.bulk_move_group')}\n\n${groupOptions}\n\n${t('instances.enter_group_id')}`);
      if (gid === null) return;
      try {
        await apiPost('/instances/bulk', { instance_ids: ids, action: 'set_group', value: gid || null });
        showToast(t('instances.bulk_done'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }

    } else if (op === 'add-tag') {
      const tag = prompt(t('instances.prompt_tag'));
      if (!tag) return;
      try {
        await apiPost('/instances/bulk', { instance_ids: ids, action: 'add_tag', value: tag });
        showToast(t('instances.bulk_done'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }

    } else if (op === 'remove-tag') {
      const tag = prompt(t('instances.prompt_remove_tag'));
      if (!tag) return;
      try {
        await apiPost('/instances/bulk', { instance_ids: ids, action: 'remove_tag', value: tag });
        showToast(t('instances.bulk_done'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }

    } else if (op === 'revoke') {
      if (!confirm(t('instances.confirm_bulk_revoke', { n: ids.length }))) return;
      try {
        await apiPost('/instances/bulk', { instance_ids: ids, action: 'revoke' });
        showToast(t('instances.bulk_done'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    }
  });

  searchInput.addEventListener('input', reFilter);
  groupFilter.addEventListener('change', reFilter);
  tagFilter.addEventListener('change', reFilter);
  bindRowActions();
}

function renderRows(items, groups) {
  if (!items.length) return `<tr><td colspan="8" class="text-center text-muted py-4">${t('instances.none_found')}</td></tr>`;
  return items.map(i => {
    const group = groups.find(g => g.id === i.group_id);
    return `<tr>
      <td><input type="checkbox" class="form-check-input row-check" data-id="${i.id}" /></td>
      <td>${statusBadge(i.ws_connected, i.enrollment_status)}</td>
      <td><strong class="text-body">${i.name}</strong><br><small class="text-muted text-mono">${i.fingerprint.substring(0,16)}…</small></td>
      <td>${group ? `<a href="#groups/${group.id}"><span class="badge" style="background:${group.color}20;color:${group.color}">${group.name}</span></a>` : '—'}</td>
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
