import { apiGet, apiPost, apiPatch, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { debounce, escapeHtml, relativeTime, statusBadge, showToast, confirmDialog } from '../utils.js';
import { openDrawer } from '../shell/drawer.js';

let _instances = [], _groups = [], _tags = [];
let _selected = new Set();
let _filters = { search: '', group: '', tag: '', status: '' };

export async function render(container, params) {
  container.innerHTML = `
    <div class="hub-page-header">
      <div>
        <h1 class="hub-page-title">${t('instances.title')}</h1>
      </div>
    </div>
    <div id="inst-stats" class="row g-3 mb-3"></div>
    <div class="filter-bar mb-0" id="inst-filter">
      <div class="filter-bar-search">
        <i class="ti ti-search"></i>
        <input type="text" id="inst-search" class="form-control" placeholder="${t('instances.search')}" value="${escapeHtml(_filters.search)}" />
      </div>
      <select id="inst-group" class="form-select" style="width:auto">
        <option value="">${t('instances.all_groups')}</option>
      </select>
      <select id="inst-tag" class="form-select" style="width:auto">
        <option value="">${t('instances.all_tags')}</option>
      </select>
      <select id="inst-status" class="form-select" style="width:auto">
        <option value="">${t('instances.all_statuses')}</option>
        <option value="online">${t('status.online')}</option>
        <option value="offline">${t('status.offline')}</option>
        <option value="pending">${t('status.pending')}</option>
        <option value="revoked">${t('status.revoked')}</option>
      </select>
      <button class="filter-bar-clear" id="inst-clear">${t('instances.bulk_clear')}</button>
    </div>
    <div id="inst-table"></div>
    <div class="bulk-bar hidden" id="bulk-bar">
      <span id="bulk-count"></span>
      <button class="btn btn-sm btn-outline-secondary" id="bulk-move">${t('instances.bulk_move_group')}</button>
      <button class="btn btn-sm btn-outline-secondary" id="bulk-tag">${t('instances.bulk_add_tag')}</button>
      <button class="btn btn-sm btn-danger" id="bulk-revoke">${t('instances.bulk_revoke')}</button>
      <button class="btn btn-sm btn-ghost-secondary" id="bulk-clear">${t('instances.bulk_clear')}</button>
    </div>`;

  await loadAll();
  wireFilters();

  // If route has an ID, open the drawer
  if (params?.length && params[0]) {
    openInstanceDrawer(params[0]);
  }
}

async function loadAll() {
  try {
    [_instances, _groups, _tags] = await Promise.all([
      apiGet('/instances'),
      apiGet('/groups'),
      apiGet('/tags'),
    ]);
    _instances = _instances || [];
    _groups = _groups || [];
    _tags = _tags || [];
    renderStats();
    populateFilters();
    renderTable();
  } catch (err) {
    document.getElementById('inst-table').innerHTML =
      `<div class="alert alert-danger mt-2">${t('instances.load_error')}</div>`;
  }
}

function renderStats() {
  const total   = _instances.length;
  const online  = _instances.filter(i => i.ws_connected).length;
  const offline = _instances.filter(i => !i.ws_connected && i.enrollment_status === 'active').length;
  const pending = _instances.filter(i => i.enrollment_status === 'pending').length;

  document.getElementById('inst-stats').innerHTML = [
    stat(t('dashboard.total'),   total,   'ti-server',       'primary'),
    stat(t('status.online'),     online,  'ti-circle-check', 'success'),
    stat(t('status.offline'),    offline, 'ti-circle-x',     'danger'),
    stat(t('status.pending'),    pending, 'ti-clock',        'warning'),
  ].join('');
}

function stat(label, value, icon, color) {
  return `<div class="col-6 col-sm-3">
    <div class="stat-card">
      <div class="stat-card-icon ${color}"><i class="ti ${icon}"></i></div>
      <div class="stat-card-body">
        <div class="stat-card-value">${value}</div>
        <div class="stat-card-label">${escapeHtml(label)}</div>
      </div>
    </div>
  </div>`;
}

function populateFilters() {
  const groupSel = document.getElementById('inst-group');
  const tagSel   = document.getElementById('inst-tag');
  if (!groupSel || !tagSel) return;

  _groups.forEach(g => {
    groupSel.insertAdjacentHTML('beforeend', `<option value="${g.id}">${escapeHtml(g.name)}</option>`);
  });
  _tags.forEach(tg => {
    tagSel.insertAdjacentHTML('beforeend', `<option value="${tg.name}">${escapeHtml(tg.name)}</option>`);
  });

  groupSel.value = _filters.group;
  tagSel.value   = _filters.tag;
  document.getElementById('inst-status').value = _filters.status;
}

function wireFilters() {
  const search = document.getElementById('inst-search');
  const group  = document.getElementById('inst-group');
  const tag    = document.getElementById('inst-tag');
  const status = document.getElementById('inst-status');
  const clear  = document.getElementById('inst-clear');

  search?.addEventListener('input', debounce(e => { _filters.search = e.target.value; renderTable(); }));
  group?.addEventListener('change',  e => { _filters.group  = e.target.value; renderTable(); });
  tag?.addEventListener('change',    e => { _filters.tag    = e.target.value; renderTable(); });
  status?.addEventListener('change', e => { _filters.status = e.target.value; renderTable(); });
  clear?.addEventListener('click',   () => {
    _filters = { search: '', group: '', tag: '', status: '' };
    if (search) search.value = '';
    if (group)  group.value  = '';
    if (tag)    tag.value    = '';
    if (status) status.value = '';
    renderTable();
  });

  // Bulk bar buttons
  document.getElementById('bulk-clear')?.addEventListener('click', () => {
    _selected.clear(); renderTable();
  });
  document.getElementById('bulk-revoke')?.addEventListener('click', bulkRevoke);
  document.getElementById('bulk-move')?.addEventListener('click',   bulkMove);
  document.getElementById('bulk-tag')?.addEventListener('click',    bulkAddTag);
}

function filtered() {
  return _instances.filter(i => {
    if (_filters.search && !i.hostname?.toLowerCase().includes(_filters.search.toLowerCase())) return false;
    if (_filters.group && i.group_id !== _filters.group) return false;
    if (_filters.tag) {
      const iTags = Array.isArray(i.tags) ? i.tags : [];
      if (!iTags.some(tg => (typeof tg === 'string' ? tg : tg.name) === _filters.tag)) return false;
    }
    if (_filters.status) {
      if (_filters.status === 'online'  && !i.ws_connected) return false;
      if (_filters.status === 'offline' && (i.ws_connected || i.enrollment_status !== 'active')) return false;
      if (_filters.status === 'pending' && i.enrollment_status !== 'pending') return false;
      if (_filters.status === 'revoked' && i.enrollment_status !== 'revoked') return false;
    }
    return true;
  });
}

function renderTable() {
  const rows = filtered();
  const el = document.getElementById('inst-table');
  if (!el) return;

  updateBulkBar();

  if (!rows.length) {
    el.innerHTML = `<div class="data-table mt-2">
      <div class="data-table-empty">
        <i class="ti ti-server-off"></i>${t('instances.none_found')}
      </div></div>`;
    return;
  }

  const groupMap = Object.fromEntries(_groups.map(g => [g.id, g]));

  const thead = `<tr>
    <th style="width:36px"><input type="checkbox" id="chk-all" class="form-check-input" /></th>
    <th>${t('instances.col_status')}</th>
    <th>${t('instances.col_name')}</th>
    <th>${t('instances.col_group')}</th>
    <th>${t('instances.col_version')}</th>
    <th>${t('instances.col_contact')}</th>
    <th>${t('instances.col_tags')}</th>
  </tr>`;

  const tbody = rows.map(inst => {
    const group = groupMap[inst.group_id];
    const tags  = (Array.isArray(inst.tags) ? inst.tags : [])
      .map(tg => {
        const name = typeof tg === 'string' ? tg : tg.name;
        const color = typeof tg === 'object' ? tg.color : '#adb5bd';
        return `<span class="tag-chip" style="background:${escapeHtml(color)}22;color:${escapeHtml(color)}">${escapeHtml(name)}</span>`;
      }).join('');
    const checked = _selected.has(inst.id) ? 'checked' : '';
    const selected = _selected.has(inst.id) ? 'selected' : '';
    return `<tr class="clickable ${selected}" data-id="${inst.id}">
      <td onclick="event.stopPropagation()">
        <input type="checkbox" class="form-check-input row-chk" data-id="${inst.id}" ${checked} />
      </td>
      <td>${statusBadge(inst.ws_connected, inst.enrollment_status)}</td>
      <td><strong>${escapeHtml(inst.hostname || inst.id)}</strong>${inst.ip_address ? `<br><small class="text-muted" style="font-size:11px">${escapeHtml(inst.ip_address)}</small>` : ''}</td>
      <td>${group ? `<span class="group-badge" style="border-color:${escapeHtml(group.color||'#adb5bd')}">${escapeHtml(group.name)}</span>` : '<span class="text-muted">—</span>'}</td>
      <td><span class="text-mono">${escapeHtml(inst.version || '—')}</span></td>
      <td>${relativeTime(inst.last_seen_at)}</td>
      <td>${tags || '—'}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `<div class="data-table mt-2">
    <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
    <div class="data-table-footer">
      <span>${rows.length} ${t('audit.total_results')}</span>
    </div>
  </div>`;

  // Row click → drawer
  el.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.id;
      window.location.hash = `instances/${id}`;
      openInstanceDrawer(id);
    });
  });

  // Checkboxes
  document.getElementById('chk-all')?.addEventListener('change', e => {
    rows.forEach(i => e.target.checked ? _selected.add(i.id) : _selected.delete(i.id));
    renderTable();
  });
  el.querySelectorAll('.row-chk').forEach(chk => {
    chk.addEventListener('change', e => {
      e.target.checked ? _selected.add(e.target.dataset.id) : _selected.delete(e.target.dataset.id);
      updateBulkBar();
    });
  });
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  if (!bar) return;
  if (_selected.size > 0) {
    bar.classList.remove('hidden');
    const cnt = document.getElementById('bulk-count');
    if (cnt) cnt.textContent = t('instances.bulk_selected', { n: _selected.size });
  } else {
    bar.classList.add('hidden');
  }
}

async function bulkRevoke() {
  const n = _selected.size;
  const ok = await confirmDialog(t('instances.bulk_revoke'), t('instances.confirm_bulk_revoke', { n }), { okLabel: t('instances.bulk_revoke') });
  if (!ok) return;
  await apiPost('/instances/bulk', { instance_ids: [..._selected], action: 'revoke' });
  _selected.clear();
  showToast(t('instances.bulk_done'), 'success');
  await loadAll();
}

async function bulkMove() {
  const opts = `<option value="">${escapeHtml(t('instances.no_group'))}</option>` +
    _groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  const groupId = await new Promise(resolve => {
    const m = document.createElement('div');
    m.className = 'modal fade';
    m.innerHTML = `<div class="modal-dialog modal-sm modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title">${t('instances.bulk_move_group')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body"><select id="bm-group" class="form-select">${opts}</select></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
          <button type="button" class="btn btn-primary" id="bm-ok">${t('modal.save')}</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(m);
    const modal = new window.bootstrap.Modal(m);
    let val = undefined;
    m.querySelector('#bm-ok').onclick = () => { val = m.querySelector('#bm-group').value; modal.hide(); };
    m.addEventListener('hidden.bs.modal', () => { m.remove(); resolve(val); }, { once: true });
    modal.show();
  });
  if (groupId === undefined) return;
  await apiPost('/instances/bulk', { instance_ids: [..._selected], action: 'set_group', group_id: groupId || null });
  _selected.clear();
  showToast(t('instances.bulk_done'), 'success');
  await loadAll();
}

async function bulkAddTag() {
  const { inputDialog } = await import('../utils.js');
  const tag = await inputDialog(t('instances.bulk_add_tag'), '', { placeholder: t('instances.prompt_tag') });
  if (!tag) return;
  await apiPost('/instances/bulk', { instance_ids: [..._selected], action: 'add_tag', tag });
  _selected.clear();
  showToast(t('instances.bulk_done'), 'success');
  await loadAll();
}

async function openInstanceDrawer(id) {
  const inst = _instances.find(i => i.id === id);
  const title = inst?.hostname || id;
  await openDrawer({
    title,
    closeHash: '#instances',
    render: async (body) => {
      const mod = await import('./instance_drawer.js');
      await mod.render(body, id);
    },
  });
}
