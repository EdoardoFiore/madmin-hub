import { apiGet, apiPost, apiPatch, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, relativeTime, showToast, confirmDialog, statusBadge } from '../utils.js';

let _groups = [], _selected = null;

export async function render(container, params) {
  container.innerHTML = `
    <div class="hub-page-header">
      <h1 class="hub-page-title">${t('groups.title')}</h1>
      <button class="btn btn-primary btn-sm" id="new-group-btn">
        <i class="ti ti-plus me-1"></i>${t('groups.new_group')}
      </button>
    </div>
    <div class="split-view" id="groups-split">
      <div id="groups-list-panel"></div>
      <div id="groups-detail-panel" style="background:var(--hub-surface-2);border:1px solid var(--hub-border);border-radius:var(--hub-radius);padding:20px">
        <div style="text-align:center;color:var(--tblr-secondary);padding:40px;font-size:13px">
          <i class="ti ti-folders" style="font-size:32px;display:block;margin-bottom:8px;opacity:.4"></i>
          ${t('groups.select_prompt')}
        </div>
      </div>
    </div>`;

  document.getElementById('new-group-btn')?.addEventListener('click', showCreateModal);
  await loadGroups();

  if (params?.length && params[0]) {
    selectGroup(params[0]);
  }
}

async function loadGroups() {
  try {
    _groups = await apiGet('/groups') || [];
    renderList();
  } catch (_) {}
}

function renderList() {
  const panel = document.getElementById('groups-list-panel');
  if (!panel) return;

  if (!_groups.length) {
    panel.innerHTML = `<div class="data-table" style="padding:20px;text-align:center;color:var(--tblr-secondary);font-size:13px">
      <i class="ti ti-folders" style="font-size:32px;display:block;margin-bottom:8px;opacity:.4"></i>${t('groups.none')}
    </div>`;
    return;
  }

  panel.innerHTML = `<div class="data-table" style="padding:8px">
    ${_groups.map(g => `
      <div class="split-list-item ${_selected === g.id ? 'active' : ''}" data-id="${g.id}">
        <span style="width:10px;height:10px;border-radius:50%;background:${escapeHtml(g.color||'#adb5bd')};flex-shrink:0"></span>
        <div style="flex:1;min-width:0">
          <div class="name">${escapeHtml(g.name)}</div>
          <div class="meta">${g.member_count ?? '—'} istanze</div>
        </div>
        <div style="display:flex;gap:4px" onclick="event.stopPropagation()">
          <button class="btn btn-sm btn-ghost-secondary edit-btn" data-id="${g.id}" title="${t('groups.edit')}"><i class="ti ti-pencil" style="font-size:14px"></i></button>
          <button class="btn btn-sm btn-ghost-danger del-btn" data-id="${g.id}" title="${t('groups.delete')}"><i class="ti ti-trash" style="font-size:14px"></i></button>
        </div>
      </div>`).join('')}
  </div>`;

  panel.querySelectorAll('.split-list-item').forEach(el => {
    el.addEventListener('click', () => selectGroup(el.dataset.id));
  });
  panel.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => showEditModal(_groups.find(g => g.id === btn.dataset.id)));
  });
  panel.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteGroup(btn.dataset.id));
  });
}

function selectGroup(id) {
  _selected = id;
  renderList();
  const group = _groups.find(g => g.id === id);
  if (!group) return;
  renderDetail(group);
}

function renderDetail(group) {
  const panel = document.getElementById('groups-detail-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <span style="width:14px;height:14px;border-radius:50%;background:${escapeHtml(group.color||'#adb5bd')}"></span>
      <h2 style="font-size:18px;font-weight:600;margin:0">${escapeHtml(group.name)}</h2>
      ${group.description ? `<span style="color:var(--tblr-secondary);font-size:13px">— ${escapeHtml(group.description)}</span>` : ''}
    </div>
    <div class="hub-tabs" id="grp-tabs">
      <button class="hub-tab active" data-tab="instances">${t('groups.tab_instances')}</button>
      <button class="hub-tab" data-tab="ssh">${t('groups.tab_ssh')}</button>
    </div>
    <div id="grp-panel"></div>`;

  const gPanel = panel.querySelector('#grp-panel');
  async function switchTab(tab) {
    panel.querySelectorAll('.hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    gPanel.innerHTML = '<div class="hub-loader"></div>';
    if (tab === 'instances') await renderGroupInstances(gPanel, group.id);
    if (tab === 'ssh')       await renderGroupSsh(gPanel, group.id);
  }

  panel.querySelectorAll('.hub-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  switchTab('instances');
}

async function renderGroupInstances(panel, groupId) {
  try {
    const all = await apiGet('/instances') || [];
    const members = all.filter(i => i.group_id === groupId);
    if (!members.length) {
      panel.innerHTML = `<div style="text-align:center;padding:30px;color:var(--tblr-secondary);font-size:13px">${t('groups.no_members')}</div>`;
      return;
    }
    panel.innerHTML = `<div class="data-table mt-2"><table>
      <thead><tr><th>${t('instances.col_status')}</th><th>${t('instances.col_name')}</th><th>${t('instances.col_contact')}</th></tr></thead>
      <tbody>${members.map(i => `<tr class="clickable" onclick="window.location.hash='instances/${i.id}'">
        <td>${statusBadge(i.ws_connected, i.enrollment_status)}</td>
        <td><strong>${escapeHtml(i.hostname || i.id)}</strong></td>
        <td>${relativeTime(i.last_seen_at)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  } catch (_) {
    panel.innerHTML = `<div class="alert alert-danger">${t('groups.load_error')}</div>`;
  }
}

async function renderGroupSsh(panel, groupId) {
  try {
    const assignments = await apiGet(`/ssh/assignments?target_id=${groupId}&target_type=group`) || [];
    if (!assignments.length) {
      panel.innerHTML = `<div style="text-align:center;padding:30px;color:var(--tblr-secondary);font-size:13px">${t('ssh.none_assign')}</div>`;
      return;
    }
    panel.innerHTML = `<div class="data-table mt-2"><table>
      <thead><tr><th>${t('ssh.col_key')}</th><th>${t('ssh.col_user')}</th><th>${t('ssh.col_status')}</th></tr></thead>
      <tbody>${assignments.map(a => `<tr>
        <td>${escapeHtml(a.key_name || a.ssh_key_id)}</td>
        <td><span class="text-mono">${escapeHtml(a.linux_user || '—')}</span></td>
        <td><span class="hub-badge ${a.status}">${escapeHtml(a.status)}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  } catch (_) {
    panel.innerHTML = `<div class="alert alert-danger">${t('groups.load_error')}</div>`;
  }
}

// ── Modals ────────────────────────────────────────────────────────────────────

function groupFormHtml(g = {}) {
  return `
    <div class="mb-3">
      <label class="form-label">${t('groups.label_name')} *</label>
      <input type="text" id="gf-name" class="form-control" value="${escapeHtml(g.name||'')}" />
    </div>
    <div class="mb-3">
      <label class="form-label">${t('groups.label_desc')}</label>
      <input type="text" id="gf-desc" class="form-control" value="${escapeHtml(g.description||'')}" />
    </div>
    <div class="mb-3">
      <label class="form-label">${t('groups.label_color')}</label>
      <input type="color" id="gf-color" class="form-control form-control-color" value="${g.color||'#206bc4'}" />
    </div>`;
}

async function showCreateModal() {
  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  modalEl.innerHTML = `<div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${t('groups.new_group')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">${groupFormHtml()}</div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="gf-save">${t('modal.create')}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl);
  m.show();
  modalEl.querySelector('#gf-save').addEventListener('click', async () => {
    const name = modalEl.querySelector('#gf-name').value.trim();
    if (!name) { showToast(t('groups.name_required'), 'error'); return; }
    try {
      await apiPost('/groups', { name, description: modalEl.querySelector('#gf-desc').value.trim(), color: modalEl.querySelector('#gf-color').value });
      showToast(t('groups.created'), 'success');
      m.hide();
      await loadGroups();
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}

async function showEditModal(group) {
  if (!group) return;
  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  modalEl.innerHTML = `<div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${t('groups.edit')}: ${escapeHtml(group.name)}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">${groupFormHtml(group)}</div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="gf-save">${t('modal.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl);
  m.show();
  modalEl.querySelector('#gf-save').addEventListener('click', async () => {
    try {
      await apiPatch(`/groups/${group.id}`, {
        name: modalEl.querySelector('#gf-name').value.trim(),
        description: modalEl.querySelector('#gf-desc').value.trim(),
        color: modalEl.querySelector('#gf-color').value,
      });
      showToast(t('groups.saved'), 'success');
      m.hide();
      await loadGroups();
      if (_selected === group.id) selectGroup(group.id);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}

async function deleteGroup(id) {
  const group = _groups.find(g => g.id === id);
  const ok = await confirmDialog(t('groups.delete') + ': ' + (group?.name || id), t('groups.confirm_delete'), { okLabel: t('groups.delete') });
  if (!ok) return;
  try {
    await apiDelete(`/groups/${id}`);
    showToast(t('groups.deleted'), 'success');
    if (_selected === id) _selected = null;
    await loadGroups();
  } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
}
