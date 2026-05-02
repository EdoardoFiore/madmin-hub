import { apiGet, apiPost, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, relativeTime, showToast, confirmDialog } from '../utils.js';

export async function render(container, params) {
  const tab = params?.[0] || 'ssh';

  container.innerHTML = `
    <div class="hub-page-header">
      <h1 class="hub-page-title">${t('inventory.title')}</h1>
    </div>
    <div class="hub-tabs" id="inv-tabs">
      <button class="hub-tab ${tab === 'ssh'  ? 'active' : ''}" data-tab="ssh">${t('inventory.tab_ssh')}</button>
      <button class="hub-tab ${tab === 'tags' ? 'active' : ''}" data-tab="tags">${t('inventory.tab_tags')}</button>
    </div>
    <div id="inv-panel"></div>`;

  const panel = document.getElementById('inv-panel');

  async function switchTab(t2) {
    window.location.hash = `inventory/${t2}`;
    container.querySelectorAll('.hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t2));
    panel.innerHTML = '<div class="hub-loader"></div>';
    if (t2 === 'tags') await renderTags(panel);
    if (t2 === 'ssh')  await renderSshKeys(panel);
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
                <button class="btn btn-sm btn-ghost-danger del-tag" data-id="${tg.id}" data-name="${escapeHtml(tg.name)}">
                  <i class="ti ti-trash" style="font-size:14px"></i>
                </button>
              </td>
            </tr>`).join('')}
            </tbody></table>`
        }
      </div>`;

    panel.querySelector('#new-tag-btn')?.addEventListener('click', () => showNewTagModal(panel));
    panel.querySelectorAll('.tag-row').forEach(row => {
      row.addEventListener('click', () => {
        window.__pendingTagFilter = row.dataset.name;
        window.location.hash = 'instances';
      });
    });
    panel.querySelectorAll('.del-tag').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog(t('inventory.tag_confirm_del'), btn.dataset.name, { okLabel: t('msg.deleted') });
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

// ── SSH Keys ──────────────────────────────────────────────────────────────────

async function renderSshKeys(panel) {
  try {
    const [keys, assignments] = await Promise.all([
      apiGet('/ssh/keys'),
      apiGet('/ssh/assignments'),
    ]);
    const keyList  = keys || [];
    const asgList  = assignments || [];

    // Compute scope per key
    function scope(keyId) {
      const asgns = asgList.filter(a => a.ssh_key_id === keyId);
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
              <th>${t('inventory.col_key_name')}</th>
              <th>${t('inventory.col_key_fp')}</th>
              <th>${t('inventory.col_key_scope')}</th>
              <th>${t('inventory.col_key_created')}</th>
              <th></th>
            </tr></thead><tbody>
            ${keyList.map(k => `<tr>
              <td><strong>${escapeHtml(k.name)}</strong>${k.notes ? `<br><small class="text-muted" style="font-size:11px">${escapeHtml(k.notes)}</small>` : ''}</td>
              <td><span class="text-mono">${escapeHtml(k.fingerprint || '—')}</span></td>
              <td><span class="hub-badge info">${escapeHtml(scope(k.id))}</span></td>
              <td>${relativeTime(k.created_at)}</td>
              <td style="text-align:right">
                <button class="btn btn-sm btn-ghost-danger del-key" data-id="${k.id}">
                  <i class="ti ti-trash" style="font-size:14px"></i>
                </button>
              </td>
            </tr>`).join('')}
            </tbody></table>`
        }
      </div>`;

    panel.querySelector('#new-key-btn')?.addEventListener('click', () => showNewKeyModal(panel));
    panel.querySelectorAll('.del-key').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog(t('inventory.key_confirm_del'), '', { okLabel: t('msg.deleted') });
        if (!ok) return;
        try {
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
