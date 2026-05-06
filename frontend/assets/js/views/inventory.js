import { apiGet, apiPost, apiPatch, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, relativeTime, showToast, confirmDialog } from '../utils.js';

export async function render(container, params) {
  const tab = params?.[0] || 'ssh';

  container.innerHTML = `
    <div class="hub-page-header">
      <h1 class="hub-page-title">${t('inventory.title')}</h1>
    </div>
    <div class="hub-tabs" id="inv-tabs">
      <button class="hub-tab ${tab === 'ssh'     ? 'active' : ''}" data-tab="ssh">${t('inventory.tab_ssh')}</button>
      <button class="hub-tab ${tab === 'tags'    ? 'active' : ''}" data-tab="tags">${t('inventory.tab_tags')}</button>
      <button class="hub-tab ${tab === 'storage' ? 'active' : ''}" data-tab="storage">${t('inventory.tab_storage')}</button>
    </div>
    <div id="inv-panel"></div>`;

  const panel = document.getElementById('inv-panel');

  async function switchTab(t2) {
    window.location.hash = `inventory/${t2}`;
    container.querySelectorAll('.hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t2));
    panel.innerHTML = '<div class="hub-loader"></div>';
    if (t2 === 'tags')    await renderTags(panel);
    if (t2 === 'ssh')     await renderSshKeys(panel);
    if (t2 === 'storage') await renderStorage(panel);
  }

  container.querySelectorAll('.hub-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  await switchTab(tab);
}

// ── Tags ──────────────────────────────────────────────────────────────────────

async function renderTags(panel) {
  try {
    const [tags, instances] = await Promise.all([
      apiGet('/tags'),
      apiGet('/instances'),
    ]);
    const tagList = tags || [];
    const instList = instances || [];

    // Compute usage counts
    const counts = {};
    instList.forEach(inst => {
      const iTags = Array.isArray(inst.tags) ? inst.tags : [];
      iTags.forEach(tg => {
        const name = typeof tg === 'string' ? tg : tg.name;
        counts[name] = (counts[name] || 0) + 1;
      });
    });

    panel.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
        <button class="btn btn-primary btn-sm" id="new-tag-btn">
          <i class="ti ti-plus me-1"></i>${t('inventory.new_tag')}
        </button>
      </div>
      <div class="data-table">
        ${!tagList.length
          ? `<div class="data-table-empty"><i class="ti ti-tags"></i>${t('inventory.tags_none')}</div>`
          : `<table><thead><tr>
              <th>${t('inventory.col_tag_name')}</th>
              <th>${t('inventory.col_tag_usage')}</th>
              <th>${t('inventory.col_tag_created')}</th>
              <th></th>
            </tr></thead><tbody>
            ${tagList.map(tg => `<tr class="clickable tag-row" data-name="${escapeHtml(tg.name)}" title="${t('inventory.tag_click_filter')}">
              <td><span class="tag-chip" style="background:${escapeHtml(tg.color||'#adb5bd')}22;color:${escapeHtml(tg.color||'#adb5bd')}">${escapeHtml(tg.name)}</span></td>
              <td>${counts[tg.name] || 0}</td>
              <td>${relativeTime(tg.created_at)}</td>
              <td style="text-align:right" onclick="event.stopPropagation()">
                <button class="btn btn-sm btn-ghost-secondary edit-tag" data-id="${tg.id}" data-name="${escapeHtml(tg.name)}" data-color="${escapeHtml(tg.color||'#206bc4')}">
                  <i class="ti ti-pencil" style="font-size:14px"></i>
                </button>
                <button class="btn btn-sm btn-ghost-danger del-tag" data-id="${tg.id}" data-name="${escapeHtml(tg.name)}">
                  <i class="ti ti-trash" style="font-size:14px"></i>
                </button>
              </td>
            </tr>`).join('')}
            </tbody></table>`
        }
      </div>`;

    panel.querySelector('#new-tag-btn')?.addEventListener('click', () => showNewTagModal(panel));
    panel.querySelectorAll('.edit-tag').forEach(btn => {
      btn.addEventListener('click', () => showEditTagModal(panel, { id: btn.dataset.id, name: btn.dataset.name, color: btn.dataset.color }));
    });
    panel.querySelectorAll('.tag-row').forEach(row => {
      row.addEventListener('click', () => {
        window.__pendingTagFilter = row.dataset.name;
        window.location.hash = 'instances';
      });
    });
    panel.querySelectorAll('.del-tag').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog(t('inventory.tag_confirm_del'), btn.dataset.name, { okLabel: t('modal.delete') });
        if (!ok) return;
        try {
          await apiDelete(`/tags/${btn.dataset.id}`);
          showToast(t('inventory.tag_deleted'), 'success');
          await renderTags(panel);
        } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
      });
    });
  } catch (_) {
    panel.innerHTML = `<div class="alert alert-danger">${t('msg.error')}</div>`;
  }
}

function showNewTagModal(panel) {
  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  modalEl.innerHTML = `<div class="modal-dialog modal-sm modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${t('inventory.new_tag')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div class="mb-3"><label class="form-label">${t('inventory.tag_name')}</label>
          <input type="text" id="tf-name" class="form-control" /></div>
        <div class="mb-3"><label class="form-label">${t('inventory.tag_color')}</label>
          <input type="color" id="tf-color" class="form-control form-control-color" value="#206bc4" /></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="tf-save">${t('modal.create')}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl);
  m.show();
  modalEl.querySelector('#tf-save').addEventListener('click', async () => {
    const name = modalEl.querySelector('#tf-name').value.trim();
    if (!name) return;
    try {
      await apiPost('/tags', { name, color: modalEl.querySelector('#tf-color').value });
      showToast(t('inventory.tag_created'), 'success');
      m.hide();
      await renderTags(panel);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}

function showEditTagModal(panel, tag) {
  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  modalEl.innerHTML = `<div class="modal-dialog modal-sm modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${t('inventory.tag_edit')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div class="mb-3"><label class="form-label">${t('inventory.tag_name')}</label>
          <input type="text" id="te-name" class="form-control" value="${escapeHtml(tag.name)}" /></div>
        <div class="mb-3"><label class="form-label">${t('inventory.tag_color')}</label>
          <input type="color" id="te-color" class="form-control form-control-color" value="${escapeHtml(tag.color)}" /></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="te-save">${t('modal.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl);
  m.show();
  modalEl.querySelector('#te-save').addEventListener('click', async () => {
    const name = modalEl.querySelector('#te-name').value.trim();
    if (!name) return;
    try {
      await apiPatch(`/tags/${tag.id}`, { name, color: modalEl.querySelector('#te-color').value });
      showToast(t('msg.saved'), 'success');
      m.hide();
      await renderTags(panel);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}

// ── SSH Keys ──────────────────────────────────────────────────────────────────

async function renderSshKeys(panel) {
  try {
    const [keys, assignments] = await Promise.all([
      apiGet('/ssh/keys'),
      apiGet('/ssh/assignments'),
    ]);
    const keyList  = keys || [];
    const asgList  = assignments || [];

    function activeAsgns(keyId) {
      return asgList.filter(a => a.ssh_key_id === keyId && a.status !== 'revoked');
    }

    function scope(keyId) {
      const asgns = activeAsgns(keyId);
      if (!asgns.length) return t('inventory.key_scope_vault');
      const hasGroup    = asgns.some(a => a.target_type === 'group');
      const hasInstance = asgns.some(a => a.target_type === 'instance');
      if (hasGroup)    return t('inventory.key_scope_groups');
      if (hasInstance) return t('inventory.key_scope_instances');
      return t('inventory.key_scope_vault');
    }

    panel.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
        <button class="btn btn-primary btn-sm" id="new-key-btn">
          <i class="ti ti-plus me-1"></i>${t('inventory.add_key')}
        </button>
      </div>
      <div class="data-table">
        ${!keyList.length
          ? `<div class="data-table-empty"><i class="ti ti-key"></i>${t('inventory.ssh_none')}</div>`
          : `<table><thead><tr>
              <th style="width:24px"></th>
              <th>${t('inventory.col_key_name')}</th>
              <th>${t('inventory.col_key_fp')}</th>
              <th>${t('inventory.col_key_scope')}</th>
              <th>${t('inventory.col_key_created')}</th>
              <th></th>
            </tr></thead><tbody id="ssh-keys-tbody">
            ${keyList.map(k => {
              const active = activeAsgns(k.id);
              return `<tr class="key-row" data-key-id="${k.id}">
                <td style="padding:6px 4px">
                  ${active.length
                    ? `<button class="btn btn-sm btn-ghost-secondary toggle-asgn" data-key-id="${k.id}" title="${t('inventory.key_assignments')}" style="padding:2px 5px">
                        <i class="ti ti-chevron-right" style="font-size:13px"></i>
                      </button>`
                    : ''}
                </td>
                <td><strong>${escapeHtml(k.name)}</strong>${k.notes ? `<br><small class="text-muted" style="font-size:11px">${escapeHtml(k.notes)}</small>` : ''}</td>
                <td><span class="text-mono" style="font-size:11px">${escapeHtml(k.fingerprint || '—')}</span></td>
                <td><span class="hub-badge info">${escapeHtml(scope(k.id))}</span>${active.length ? `<span class="ms-1" style="font-size:11px;color:var(--tblr-secondary)">(${active.length})</span>` : ''}</td>
                <td>${relativeTime(k.created_at)}</td>
                <td style="text-align:right">
                  <button class="btn btn-sm btn-ghost-secondary edit-key" data-id="${k.id}" data-name="${escapeHtml(k.name)}" data-notes="${escapeHtml(k.notes||'')}">
                    <i class="ti ti-pencil" style="font-size:14px"></i>
                  </button>
                  <button class="btn btn-sm btn-ghost-danger del-key" data-id="${k.id}" data-name="${escapeHtml(k.name)}" data-active-count="${active.length}">
                    <i class="ti ti-trash" style="font-size:14px"></i>
                  </button>
                </td>
              </tr>
              <tr class="asgn-row" id="asgn-row-${k.id}" style="display:none">
                <td></td>
                <td colspan="5" style="padding:0 0 6px 8px">
                  <div style="background:var(--hub-surface-2,var(--hub-surface));border:1px solid var(--hub-border);border-radius:var(--hub-radius-sm);padding:8px 12px;font-size:12px">
                    <div style="font-weight:600;margin-bottom:6px;color:var(--tblr-secondary)">${t('inventory.key_assignments')}</div>
                    ${!active.length
                      ? `<div style="color:var(--tblr-secondary)">${t('inventory.key_asgn_none')}</div>`
                      : `<table style="width:100%;border-collapse:collapse">
                          <thead><tr style="color:var(--tblr-secondary)">
                            <th style="padding:3px 8px 3px 0;font-weight:500">${t('inventory.key_asgn_target')}</th>
                            <th style="padding:3px 8px 3px 0;font-weight:500">${t('inventory.key_asgn_user')}</th>
                            <th style="padding:3px 8px 3px 0;font-weight:500">${t('ssh.col_status')}</th>
                            <th style="padding:3px 8px 3px 0;font-weight:500">${t('inventory.key_asgn_expires')}</th>
                            <th></th>
                          </tr></thead>
                          <tbody>
                            ${active.map(a => `<tr data-asgn-id="${a.id}">
                              <td style="padding:3px 8px 3px 0">
                                <span class="hub-badge ${a.target_type === 'group' ? 'info' : 'default'}" style="font-size:10px">${escapeHtml(a.target_type)}</span>
                                <span class="text-mono ms-1" style="font-size:11px">${escapeHtml(a.target_id.slice(0,8))}…</span>
                              </td>
                              <td style="padding:3px 8px 3px 0"><span class="text-mono">${escapeHtml(a.target_user || 'root')}</span></td>
                              <td style="padding:3px 8px 3px 0"><span class="hub-badge ${a.status}">${escapeHtml(a.status)}</span></td>
                              <td style="padding:3px 8px 3px 0">${a.expires_at ? relativeTime(a.expires_at) : '—'}</td>
                              <td style="text-align:right">
                                <button class="btn btn-sm btn-ghost-danger revoke-asgn-btn" data-id="${a.id}" title="${t('inventory.key_asgn_revoke')}">
                                  <i class="ti ti-x" style="font-size:12px"></i>
                                </button>
                              </td>
                            </tr>`).join('')}
                          </tbody>
                        </table>`
                    }
                  </div>
                </td>
              </tr>`;
            }).join('')}
            </tbody></table>`
        }
      </div>`;

    panel.querySelector('#new-key-btn')?.addEventListener('click', () => showNewKeyModal(panel));

    panel.querySelectorAll('.toggle-asgn').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = document.getElementById(`asgn-row-${btn.dataset.keyId}`);
        if (!row) return;
        const open = row.style.display !== 'none';
        row.style.display = open ? 'none' : '';
        btn.querySelector('i').className = open ? 'ti ti-chevron-right' : 'ti ti-chevron-down';
        btn.style.cssText = open ? 'padding:2px 5px' : 'padding:2px 5px;color:var(--hub-primary,#206bc4)';
      });
    });

    panel.querySelectorAll('.revoke-asgn-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog(t('ssh.confirm_revoke'), '', { okLabel: t('inventory.key_asgn_revoke'), okClass: 'btn-danger' });
        if (!ok) return;
        try {
          await apiDelete(`/ssh/assignments/${btn.dataset.id}`);
          showToast(t('inventory.key_asgn_revoked'), 'success');
          await renderSshKeys(panel);
        } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
      });
    });

    panel.querySelectorAll('.edit-key').forEach(btn => {
      btn.addEventListener('click', () => showEditKeyModal(panel, { id: btn.dataset.id, name: btn.dataset.name, notes: btn.dataset.notes }));
    });

    if (window.__pendingKeyFocus) {
      const focusId = window.__pendingKeyFocus;
      window.__pendingKeyFocus = null;
      const keyRow = panel.querySelector(`.key-row[data-key-id="${focusId}"]`);
      if (keyRow) {
        keyRow.querySelector('.toggle-asgn')?.click();
        keyRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        keyRow.style.outline = '2px solid var(--hub-primary, #206bc4)';
        keyRow.style.borderRadius = 'var(--hub-radius-sm)';
        setTimeout(() => { keyRow.style.outline = ''; keyRow.style.borderRadius = ''; }, 2000);
      }
    }

    panel.querySelectorAll('.del-key').forEach(btn => {
      btn.addEventListener('click', async () => {
        const activeCount = parseInt(btn.dataset.activeCount || '0', 10);
        const body = activeCount > 0
          ? t('inventory.key_confirm_del_active').replace('{n}', activeCount)
          : btn.dataset.name;
        const ok = await confirmDialog(t('inventory.key_confirm_del'), body, { okLabel: t('modal.delete'), okClass: activeCount > 0 ? 'btn-danger' : undefined });
        if (!ok) return;
        try {
          if (activeCount > 0) {
            const asgns = asgList.filter(a => a.ssh_key_id === btn.dataset.id && a.status !== 'revoked');
            for (const a of asgns) {
              await apiDelete(`/ssh/assignments/${a.id}`);
            }
          }
          await apiDelete(`/ssh/keys/${btn.dataset.id}`);
          showToast(t('inventory.key_deleted'), 'success');
          await renderSshKeys(panel);
        } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
      });
    });
  } catch (_) {
    panel.innerHTML = `<div class="alert alert-danger">${t('msg.error')}</div>`;
  }
}

function showNewKeyModal(panel) {
  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  modalEl.innerHTML = `<div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${t('inventory.add_key')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div class="mb-3"><label class="form-label">${t('inventory.key_name')}</label>
          <input type="text" id="kf-name" class="form-control" /></div>
        <div class="mb-3"><label class="form-label">${t('inventory.key_pubkey')}</label>
          <textarea id="kf-pub" class="form-control text-mono" rows="4" style="font-size:12px"></textarea></div>
        <div class="mb-3"><label class="form-label">${t('inventory.key_notes')}</label>
          <input type="text" id="kf-notes" class="form-control" /></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="kf-save">${t('modal.create')}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl);
  m.show();
  modalEl.querySelector('#kf-save').addEventListener('click', async () => {
    const name = modalEl.querySelector('#kf-name').value.trim();
    const pub  = modalEl.querySelector('#kf-pub').value.trim();
    if (!name || !pub) return;
    try {
      await apiPost('/ssh/keys', { name, public_key: pub, notes: modalEl.querySelector('#kf-notes').value.trim() });
      showToast(t('inventory.key_added'), 'success');
      m.hide();
      await renderSshKeys(panel);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}

function showEditKeyModal(panel, key) {
  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  modalEl.innerHTML = `<div class="modal-dialog modal-sm modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">${t('inventory.key_edit')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div class="mb-3"><label class="form-label">${t('inventory.key_name')}</label>
          <input type="text" id="ke-name" class="form-control" value="${escapeHtml(key.name)}" /></div>
        <div class="mb-3"><label class="form-label">${t('inventory.key_notes')}</label>
          <input type="text" id="ke-notes" class="form-control" value="${escapeHtml(key.notes)}" /></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
        <button type="button" class="btn btn-primary" id="ke-save">${t('modal.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl);
  m.show();
  modalEl.querySelector('#ke-save').addEventListener('click', async () => {
    const name = modalEl.querySelector('#ke-name').value.trim();
    if (!name) return;
    try {
      await apiPatch(`/ssh/keys/${key.id}`, { name, notes: modalEl.querySelector('#ke-notes').value.trim() || null });
      showToast(t('msg.saved'), 'success');
      m.hide();
      await renderSshKeys(panel);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}

// ── Storage repos ──────────────────────────────────────────────────────────────

const REPO_TYPES = [
  { value: 'local', label: () => t('inventory.repo_type_local') },
  { value: 'sftp',  label: () => t('inventory.repo_type_sftp') },
  { value: 'ftp',   label: () => t('inventory.repo_type_ftp') },
  { value: 'scp',   label: () => t('inventory.repo_type_scp') },
];

function repoTypeLabel(type) {
  return REPO_TYPES.find(r => r.value === type)?.label() || type;
}

function repoHostDisplay(repo) {
  if (repo.type === 'local') return repo.local_path || t('inventory.repo_local_path').split('(')[0].trim();
  return `${repo.host || '—'}${repo.port ? ':' + repo.port : ''}`;
}

async function renderStorage(panel) {
  try {
    const repos = await apiGet('/backups/repos');

    panel.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
        <button class="btn btn-primary btn-sm" id="new-repo-btn">
          <i class="ti ti-plus me-1"></i>${t('inventory.new_repo')}
        </button>
      </div>
      <div class="data-table">
        ${!repos.length
          ? `<div class="data-table-empty"><i class="ti ti-database"></i>${t('inventory.storage_none')}</div>`
          : `<table><thead><tr>
              <th>${t('inventory.col_repo_name')}</th>
              <th>${t('inventory.col_repo_type')}</th>
              <th>${t('inventory.col_repo_host')}</th>
              <th>${t('inventory.col_repo_default')}</th>
              <th></th>
            </tr></thead><tbody>
            ${repos.map(repo => `<tr>
              <td><strong>${escapeHtml(repo.name)}</strong></td>
              <td><span class="hub-badge pending">${escapeHtml(repoTypeLabel(repo.type))}</span></td>
              <td style="font-family:monospace;font-size:12px">${escapeHtml(repoHostDisplay(repo))}</td>
              <td>${repo.is_default ? '<span class="hub-badge online">✓</span>' : ''}</td>
              <td style="text-align:right">
                <button class="btn btn-sm btn-ghost-secondary test-repo-btn me-1" data-id="${repo.id}" title="${t('inventory.repo_test')}">
                  <i class="ti ti-plug" style="font-size:14px"></i>
                </button>
                <button class="btn btn-sm btn-ghost-secondary edit-repo-btn me-1" data-id="${repo.id}">
                  <i class="ti ti-pencil" style="font-size:14px"></i>
                </button>
                ${!repo.is_default ? `<button class="btn btn-sm btn-ghost-danger del-repo-btn" data-id="${repo.id}" data-name="${escapeHtml(repo.name)}">
                  <i class="ti ti-trash" style="font-size:14px"></i>
                </button>` : ''}
              </td>
            </tr>`).join('')}
            </tbody></table>`
        }
      </div>`;

    panel.querySelector('#new-repo-btn')?.addEventListener('click', () => showRepoModal(panel));

    panel.querySelectorAll('.test-repo-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="ti ti-loader-2 ti-spin" style="font-size:14px"></i>';
        try {
          const r = await apiPost(`/backups/repos/${btn.dataset.id}/test`, {});
          showToast(r.ok ? `${t('inventory.repo_test_ok')}: ${r.detail}` : `${t('inventory.repo_test_fail')}: ${r.detail}`, r.ok ? 'success' : 'error');
        } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
        btn.disabled = false;
        btn.innerHTML = orig;
      });
    });

    panel.querySelectorAll('.edit-repo-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const repo = repos.find(r => r.id === btn.dataset.id);
        if (repo) await showRepoModal(panel, repo);
      });
    });

    panel.querySelectorAll('.del-repo-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog(`${t('inventory.repo_confirm_del')} "${escapeHtml(btn.dataset.name)}"?`, '', { okLabel: t('modal.delete'), okClass: 'btn-danger' });
        if (!ok) return;
        try {
          await apiDelete(`/backups/repos/${btn.dataset.id}`);
          showToast(t('inventory.repo_deleted'), 'success');
          await renderStorage(panel);
        } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
      });
    });

  } catch (e) {
    panel.innerHTML = `<div class="alert alert-danger">${t('msg.error')}</div>`;
  }
}

function repoFormHtml(repo) {
  const type = repo?.type || 'local';
  const isRemote = type !== 'local';
  return `
    <div class="mb-3">
      <label class="form-label">${t('inventory.repo_name')} *</label>
      <input type="text" id="rf-name" class="form-control" value="${escapeHtml(repo?.name || '')}" required />
    </div>
    <div class="mb-3">
      <label class="form-label">${t('inventory.repo_type')} *</label>
      <select id="rf-type" class="form-select">
        ${REPO_TYPES.map(rt => `<option value="${rt.value}" ${type === rt.value ? 'selected' : ''}>${rt.label()}</option>`).join('')}
      </select>
    </div>
    <div id="rf-remote-fields" style="display:${isRemote ? 'block' : 'none'}">
      <div class="row g-2 mb-3">
        <div class="col-8">
          <label class="form-label">${t('inventory.repo_host')}</label>
          <input type="text" id="rf-host" class="form-control" value="${escapeHtml(repo?.host || '')}" />
        </div>
        <div class="col-4">
          <label class="form-label">${t('inventory.repo_port')}</label>
          <input type="number" id="rf-port" class="form-control" value="${repo?.port || ''}" />
        </div>
      </div>
      <div class="mb-3">
        <label class="form-label">${t('inventory.repo_user')}</label>
        <input type="text" id="rf-user" class="form-control" value="${escapeHtml(repo?.username || '')}" />
      </div>
      <div class="mb-3">
        <label class="form-label">${t('inventory.repo_password')}${repo?.has_password ? ' <span class="text-muted">(lascia vuoto per mantenere)</span>' : ''}</label>
        <input type="password" id="rf-pass" class="form-control" placeholder="${repo?.has_password ? '••••••••' : ''}" />
      </div>
      <div class="mb-3">
        <label class="form-label">${t('inventory.repo_path')}</label>
        <input type="text" id="rf-path" class="form-control" value="${escapeHtml(repo?.remote_path || '/backups')}" />
      </div>
    </div>
    <div id="rf-local-fields" style="display:${!isRemote ? 'block' : 'none'}">
      <div class="mb-3">
        <label class="form-label">${t('inventory.repo_local_path')}</label>
        <input type="text" id="rf-local-path" class="form-control" value="${escapeHtml(repo?.local_path || '')}" />
      </div>
    </div>
    <div class="mb-3">
      <label class="form-label">${t('inventory.repo_retention')}</label>
      <input type="number" id="rf-retention" class="form-control" value="${repo?.retention_days ?? 30}" min="1" />
    </div>
    <div class="mb-3 form-check">
      <input type="checkbox" id="rf-default" class="form-check-input" ${repo?.is_default ? 'checked' : ''} />
      <label class="form-check-label" for="rf-default">${t('inventory.repo_is_default')}</label>
    </div>`;
}

async function showRepoModal(panel, repo) {
  const isEdit = !!repo;
  const modalEl = document.createElement('div');
  modalEl.innerHTML = `
    <div class="modal fade" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${isEdit ? t('inventory.repo_edit') : t('inventory.new_repo')}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">${repoFormHtml(repo)}</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
            <button type="button" class="btn btn-primary" id="repo-save-btn">${isEdit ? t('modal.save') : t('modal.create')}</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modalEl);
  const m = new bootstrap.Modal(modalEl.querySelector('.modal'));

  // Toggle remote/local fields based on type selection
  modalEl.querySelector('#rf-type')?.addEventListener('change', e => {
    const isRemote = e.target.value !== 'local';
    modalEl.querySelector('#rf-remote-fields').style.display = isRemote ? 'block' : 'none';
    modalEl.querySelector('#rf-local-fields').style.display = isRemote ? 'none' : 'block';
  });

  modalEl.querySelector('#repo-save-btn')?.addEventListener('click', async () => {
    const name = modalEl.querySelector('#rf-name').value.trim();
    const type = modalEl.querySelector('#rf-type').value;
    if (!name) return;

    const payload = {
      name,
      type,
      retention_days: parseInt(modalEl.querySelector('#rf-retention').value) || 30,
      is_default: modalEl.querySelector('#rf-default').checked,
      remote_path: modalEl.querySelector('#rf-path')?.value.trim() || '/backups',
      local_path: modalEl.querySelector('#rf-local-path')?.value.trim() || null,
    };
    if (type !== 'local') {
      payload.host = modalEl.querySelector('#rf-host').value.trim() || null;
      payload.port = parseInt(modalEl.querySelector('#rf-port').value) || null;
      payload.username = modalEl.querySelector('#rf-user').value.trim() || null;
      const pw = modalEl.querySelector('#rf-pass').value;
      if (pw) payload.password = pw;
    }

    try {
      if (isEdit) {
        await apiPatch(`/backups/repos/${repo.id}`, payload);
        showToast(t('inventory.repo_saved'), 'success');
      } else {
        await apiPost('/backups/repos', payload);
        showToast(t('inventory.repo_created'), 'success');
      }
      m.hide();
      await renderStorage(panel);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  m.show();
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}
