/**
 * Instances list — compact rows, collapsible group sections, chip filters, bulk ops.
 */
import { apiGet, apiDelete, apiPost } from '../api.js';
import { showSpinner, statusBadge, relativeTime, showToast, confirmDialog, selectDialog } from '../utils.js';
import { t } from '../i18n.js';

const LS_COLLAPSED = 'hub_groups_collapsed';

export async function render(container) {
  showSpinner(container);

  let fleetData = null, groups = [], tags = [];
  try {
    [fleetData, groups, tags] = await Promise.all([
      apiGet('/dashboard/fleet'),
      apiGet('/groups'),
      apiGet('/tags').catch(() => []),
    ]);
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
          <div class="col-auto ms-auto">
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
          <!-- Filters row -->
          <div class="card-header flex-column flex-sm-row gap-2">
            <div class="input-group input-group-sm" style="max-width:220px">
              <span class="input-group-text"><i class="ti ti-search"></i></span>
              <input type="search" id="search-input" class="form-control" placeholder="${t('instances.search')}" />
            </div>
            <div class="d-flex flex-wrap gap-1 ms-sm-2" id="group-chips"></div>
            <div class="d-flex flex-wrap gap-1" id="tag-chips"></div>
          </div>
          <div class="table-responsive">
            <table class="table table-sm table-vcenter card-table instances-table">
              <thead>
                <tr>
                  <th style="width:30px"><input type="checkbox" class="form-check-input" id="select-all" /></th>
                  <th style="width:16px"></th>
                  <th>${t('instances.col_name')}</th>
                  <th>${t('instances.col_group')}</th>
                  <th>${t('instances.col_tags')}</th>
                  <th>${t('instances.col_version')}</th>
                  <th>${t('instances.col_contact')}</th>
                  <th style="width:60px"></th>
                </tr>
              </thead>
              <tbody id="instances-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

  const tbody = container.querySelector('#instances-tbody');
  const searchInput = container.querySelector('#search-input');
  const selectAll = container.querySelector('#select-all');
  const bulkBar = container.querySelector('#bulk-bar');
  const bulkCount = container.querySelector('#bulk-count');

  // Chip filter state
  let activeGroups = new Set();
  let activeTags = new Set();

  // Build group chips
  const groupChipsEl = container.querySelector('#group-chips');
  if (groups.length) {
    groupChipsEl.innerHTML = groups.map(g => `
      <button class="badge group-chip" data-gid="${g.id}"
        style="background:${g.color}22;border:1px solid ${g.color};color:${g.color};cursor:pointer">
        <i class="ti ti-folder me-1"></i>${g.name}
      </button>`).join('');
    groupChipsEl.querySelectorAll('.group-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const gid = chip.dataset.gid;
        if (activeGroups.has(gid)) {
          activeGroups.delete(gid);
          chip.style.background = `${groups.find(g=>g.id===gid)?.color}22`;
        } else {
          activeGroups.add(gid);
          chip.style.background = groups.find(g=>g.id===gid)?.color || '#206bc4';
          chip.style.color = '#fff';
        }
        reRender();
      });
    });
  }

  // Build tag chips (filter by name for compatibility with both string and object tags)
  const tagChipsEl = container.querySelector('#tag-chips');
  if (tags.length) {
    tagChipsEl.innerHTML = tags.map(tag => `
      <button class="badge tag-chip" data-tname="${tag.name}"
        style="background:${tag.color}22;border:1px solid ${tag.color};color:${tag.color};cursor:pointer">
        ${tag.name}
      </button>`).join('');
    tagChipsEl.querySelectorAll('.tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tname = chip.dataset.tname;
        const tagObj = tags.find(t => t.name === tname);
        if (activeTags.has(tname)) {
          activeTags.delete(tname);
          chip.style.background = `${tagObj?.color}22`;
          chip.style.color = tagObj?.color || '#6c757d';
        } else {
          activeTags.add(tname);
          chip.style.background = tagObj?.color || '#6c757d';
          chip.style.color = '#fff';
        }
        reRender();
      });
    });
  }

  const collapsed = new Set(JSON.parse(localStorage.getItem(LS_COLLAPSED) || '[]'));

  function saveCollapsed() {
    localStorage.setItem(LS_COLLAPSED, JSON.stringify([...collapsed]));
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

  function reRender() {
    const q = searchInput.value.toLowerCase();
    let filtered = instances.filter(i => {
      if (q && !i.name.toLowerCase().includes(q)) return false;
      if (activeGroups.size && !activeGroups.has(i.group_id || '')) return false;
      if (activeTags.size) {
        const iTagNames = new Set((i.tags || []).map(tag => typeof tag === 'object' ? tag.name : tag));
        if (![...activeTags].some(name => iTagNames.has(name))) return false;
      }
      return true;
    });

    // Group by group_id
    const grouped = new Map();
    grouped.set(null, []);
    for (const g of groups) grouped.set(g.id, []);
    for (const i of filtered) {
      const gid = i.group_id || null;
      if (!grouped.has(gid)) grouped.set(gid, []);
      grouped.get(gid).push(i);
    }

    let html = '';
    // Ungrouped first
    const ungrouped = grouped.get(null) || [];
    if (ungrouped.length) {
      html += `<tbody class="group-members" data-group="null">`;
      html += ungrouped.map(i => rowHtml(i, groups)).join('');
      html += `</tbody>`;
    }
    // Then each group
    for (const g of groups) {
      const members = grouped.get(g.id) || [];
      if (!members.length) continue;
      const isCollapsed = collapsed.has(g.id);
      html += `
        <tbody class="group-section">
          <tr class="group-header" data-group="${g.id}" style="cursor:pointer">
            <td colspan="8" class="py-1">
              <i class="ti ti-chevron-${isCollapsed ? 'right' : 'down'} me-1 small toggle-icon"></i>
              <span class="badge me-1" style="background:${g.color}22;border-left:3px solid ${g.color};color:${g.color};border-radius:4px;padding:3px 6px">
                <i class="ti ti-folder me-1"></i>${g.name}
              </span>
              <span class="text-muted small">${members.length} istanze · ${members.filter(i=>i.ws_connected).length} online</span>
            </td>
          </tr>
        </tbody>
        <tbody class="group-members${isCollapsed ? ' d-none' : ''}" data-group="${g.id}">
          ${members.map(i => rowHtml(i, groups)).join('')}
        </tbody>`;
    }

    if (!html) {
      html = `<tbody><tr><td colspan="8" class="text-center text-muted py-4">${t('instances.none_found')}</td></tr></tbody>`;
    }

    tbody.innerHTML = html;
    selectAll.checked = false;
    updateBulkBar();
    bindRowEvents();
  }

  function bindRowEvents() {
    // Group header toggle
    tbody.querySelectorAll('.group-header').forEach(row => {
      row.addEventListener('click', () => {
        const gid = row.dataset.group;
        const membersEl = tbody.querySelector(`.group-members[data-group="${gid}"]`);
        if (!membersEl) return;
        const icon = row.querySelector('.toggle-icon');
        if (membersEl.classList.contains('d-none')) {
          membersEl.classList.remove('d-none');
          icon?.classList.replace('ti-chevron-right', 'ti-chevron-down');
          collapsed.delete(gid);
        } else {
          membersEl.classList.add('d-none');
          icon?.classList.replace('ti-chevron-down', 'ti-chevron-right');
          collapsed.add(gid);
        }
        saveCollapsed();
      });
    });

    // Clickable rows → detail
    tbody.querySelectorAll('tr[data-instance-id]').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-stop-nav]')) return;
        window.location.hash = `instance/${row.dataset.instanceId}`;
      });
    });

    // Revoke buttons
    tbody.querySelectorAll('[data-action="revoke"]').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await confirmDialog(t('instances.confirm_revoke'), '', { okClass: 'btn-danger' })) return;
        try {
          await apiDelete(`/instances/${el.dataset.id}`);
          showToast(t('instances.revoked'), 'success');
          render(container);
        } catch { showToast(t('msg.error'), 'error'); }
      });
    });
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
      const opts = [
        { value: '', label: '— Nessun gruppo —' },
        ...groups.map(g => ({ value: g.id, label: g.name, hint: g.description || undefined })),
      ];
      const sel = await selectDialog(t('instances.bulk_move_group'), '', opts, { okLabel: 'Sposta' });
      if (sel === null) return;
      try {
        await apiPost('/instances/bulk', { instance_ids: ids, action: 'set_group', value: sel.value || null });
        showToast(t('instances.bulk_done'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }

    } else if (op === 'add-tag') {
      const opts = tags.map(tag => ({ value: tag.name, label: tag.name, hint: tag.color }));
      const sel = await selectDialog(t('instances.bulk_add_tag'), '', opts, { okLabel: 'Aggiungi', allowCreate: true });
      if (!sel) return;
      try {
        await apiPost('/instances/bulk', { instance_ids: ids, action: 'add_tag', value: sel.label || sel.value });
        showToast(t('instances.bulk_done'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }

    } else if (op === 'remove-tag') {
      const selInstances = instances.filter(i => ids.includes(i.id));
      const selTagNames = [...new Set(selInstances.flatMap(i => (i.tags || []).map(tag => typeof tag === 'object' ? tag.name : tag)))];
      const opts = selTagNames.map(name => {
        const tagObj = tags.find(t => t.name === name);
        return { value: name, label: name };
      });
      if (!opts.length) { showToast('Nessun tag da rimuovere', 'warning'); return; }
      const sel = await selectDialog(t('instances.bulk_remove_tag'), '', opts, { okLabel: 'Rimuovi' });
      if (!sel) return;
      try {
        await apiPost('/instances/bulk', { instance_ids: ids, action: 'remove_tag', value: sel.value });
        showToast(t('instances.bulk_done'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }

    } else if (op === 'revoke') {
      if (!await confirmDialog(t('instances.confirm_bulk_revoke', { n: ids.length }), '', { okClass: 'btn-danger' })) return;
      try {
        await apiPost('/instances/bulk', { instance_ids: ids, action: 'revoke' });
        showToast(t('instances.bulk_done'), 'success');
        render(container);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    }
  });

  searchInput.addEventListener('input', reRender);
  reRender();
}

function rowHtml(i, groups) {
  const tagItems = (i.tags || []);
  const tagHtml = tagItems.length
    ? tagItems.map(tag => {
        if (typeof tag === 'object') return `<span class="badge me-1" style="background:${tag.color}22;color:${tag.color};border:1px solid ${tag.color}20">${tag.name}</span>`;
        return `<span class="badge bg-azure-lt me-1">${tag}</span>`;
      }).join('')
    : '—';

  const groupObj = i.group ? i.group : groups.find(g => g.id === i.group_id);
  const groupHtml = groupObj
    ? `<span class="badge" style="background:${groupObj.color}22;color:${groupObj.color};border-left:3px solid ${groupObj.color};border-radius:4px;padding:2px 5px">${groupObj.name}</span>`
    : '—';

  const statusDot = i.enrollment_status === 'revoked'
    ? `<span class="status-dot" style="background:#cd201f" title="Revocata"></span>`
    : i.ws_connected
      ? `<span class="status-dot" style="background:#2fb344" title="Online"></span>`
      : `<span class="status-dot" style="background:#999" title="Offline"></span>`;

  return `<tr data-instance-id="${i.id}" style="cursor:pointer">
    <td data-stop-nav><input type="checkbox" class="form-check-input row-check" data-id="${i.id}" /></td>
    <td>${statusDot}</td>
    <td><strong class="text-body">${i.name}</strong><br><small class="text-muted font-monospace" style="font-size:.7rem">${i.fingerprint.substring(0,12)}…</small></td>
    <td>${groupHtml}</td>
    <td>${tagHtml}</td>
    <td class="text-muted small">${i.version || '—'}</td>
    <td class="text-muted small">${relativeTime(i.last_seen_at)}</td>
    <td data-stop-nav>
      ${i.enrollment_status !== 'revoked' ? `<button class="btn btn-sm btn-ghost-danger" data-action="revoke" data-id="${i.id}" title="${t('instances.confirm_revoke')}"><i class="ti ti-ban"></i></button>` : ''}
    </td>
  </tr>`;
}
