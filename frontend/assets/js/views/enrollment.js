import { apiGet, apiPost, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, relativeTime, fmtDate, showToast, confirmDialog } from '../utils.js';

let _tokens = [], _groups = [], _hubUrl = null;

export async function render(container) {
  container.innerHTML = `
    <div class="hub-page-header">
      <h1 class="hub-page-title">${t('enrollment.title')}</h1>
      <div id="new-token-wrap">
        <button class="btn btn-primary btn-sm" id="new-token-btn">
          <i class="ti ti-plus me-1"></i>${t('enrollment.new_token')}
        </button>
      </div>
    </div>
    <div id="enrl-table"></div>`;

  await loadAll();

  document.getElementById('new-token-btn')?.addEventListener('click', () => {
    if (!_hubUrl) {
      showToast(t('enrollment.hub_url_missing'), 'warning');
      window.location.hash = 'settings/general';
      return;
    }
    showCreateModal();
  });
}

async function loadAll() {
  try {
    const [tokens, groups, settings] = await Promise.all([
      apiGet('/enrollment/tokens'),
      apiGet('/groups'),
      apiGet('/settings/system').catch(() => null),
    ]);
    _tokens = tokens || [];
    _groups = groups || [];
    _hubUrl = settings?.hub_url || null;

    // Warn if hub_url not set
    const btn = document.getElementById('new-token-btn');
    const wrap = document.getElementById('new-token-wrap');
    if (!_hubUrl && btn) {
      btn.disabled = true;
      btn.title = t('enrollment.hub_url_missing');
      wrap.insertAdjacentHTML('afterbegin', `<div class="alert alert-warning py-2 mb-2" style="font-size:13px">
        <i class="ti ti-alert-triangle me-1"></i>${t('enrollment.hub_url_missing')}
        <a href="#settings/general" class="ms-2">${t('nav.settings')} →</a>
      </div>`);
    }

    renderTable();
  } catch (_) {
    document.getElementById('enrl-table').innerHTML =
      `<div class="alert alert-danger">${t('enrollment.load_error')}</div>`;
  }
}

function statusClass(token) {
  if (token.revoked_at) return 'revoked';
  if (new Date(token.expires_at + 'Z') < new Date()) return 'offline';
  if (token.token_type === 'one_time' && token.used_at) return 'warning';
  return 'online';
}

function statusLabel(token) {
  if (token.revoked_at) return t('status.revoked');
  if (new Date((token.expires_at||'') + 'Z') < new Date()) return t('status.expired');
  if (token.token_type === 'one_time' && token.used_at) return t('status.used');
  return t('status.valid');
}

function renderTable() {
  const el = document.getElementById('enrl-table');
  if (!el) return;

  if (!_tokens.length) {
    el.innerHTML = `<div class="data-table"><div class="data-table-empty"><i class="ti ti-key"></i>${t('enrollment.none')}</div></div>`;
    return;
  }

  const groupMap = Object.fromEntries(_groups.map(g => [g.id, g.name]));

  el.innerHTML = `<div class="data-table"><table>
    <thead><tr>
      <th>${t('enrollment.col_name')}</th>
      <th>${t('enrollment.col_type')}</th>
      <th>${t('enrollment.col_group')}</th>
      <th>${t('enrollment.col_uses')}</th>
      <th>${t('enrollment.col_expiry')}</th>
      <th>${t('enrollment.col_created_by')}</th>
      <th>${t('enrollment.col_status')}</th>
      <th></th>
    </tr></thead>
    <tbody>${_tokens.map((tk, i) => {
      const cls  = statusClass(tk);
      const lbl  = statusLabel(tk);
      const gName = groupMap[tk.target_group_id] || '—';
      const uses = tk.token_type === 'reusable'
        ? `${tk.use_count}/${tk.max_uses}`
        : (tk.used_at ? '1/1' : '0/1');
      const canRevoke = !tk.revoked_at && !tk.is_expired && !(tk.token_type === 'one_time' && tk.used_at);
      return `<tr data-idx="${i}">
        <td><strong>${escapeHtml(tk.name || '—')}</strong></td>
        <td><span class="hub-badge info">${tk.token_type === 'reusable' ? t('enrollment.type_reusable') : t('enrollment.type_one_time')}</span></td>
        <td>${escapeHtml(gName)}</td>
        <td><span class="text-mono">${uses}</span></td>
        <td style="white-space:nowrap;font-size:12px">${fmtDate(tk.expires_at)}</td>
        <td style="font-size:12px">${escapeHtml(tk.created_by || '—')}</td>
        <td><span class="hub-badge ${cls}">${lbl}</span></td>
        <td style="text-align:right">
          ${canRevoke ? `<button class="btn btn-sm btn-ghost-danger revoke-btn" data-id="${tk.id}"><i class="ti ti-ban" style="font-size:14px"></i></button>` : ''}
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;

  el.querySelectorAll('.revoke-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog(t('enrollment.confirm_revoke'), '', { okLabel: t('enrollment.revoke') });
      if (!ok) return;
      try {
        await apiDelete(`/enrollment/tokens/${btn.dataset.id}`);
        showToast(t('enrollment.revoked'), 'success');
        await loadAll();
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    });
  });
}

// ── Create modal ──────────────────────────────────────────────────────────────

function showCreateModal() {
  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  const groupOpts = `<option value="">${t('enrollment.no_group')}</option>` +
    _groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');

  modalEl.innerHTML = `<div class="modal-dialog modal-dialog-centered">
    <div class="modal-content" id="enrl-modal-content">
      <!-- Form view -->
      <div id="enrl-form-view">
        <div class="modal-header"><h5 class="modal-title">${t('enrollment.modal_title')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body">
          <div class="mb-3"><label class="form-label">${t('enrollment.field_name')}</label>
            <input type="text" id="ef-name" class="form-control" placeholder="My token" /></div>
          <div class="mb-3"><label class="form-label">${t('enrollment.field_type')}</label>
            <div class="d-flex gap-3">
              <label class="d-flex align-items-center gap-2" style="cursor:pointer">
                <input type="radio" name="ef-type" value="one_time" checked /> ${t('enrollment.type_one_time')}
              </label>
              <label class="d-flex align-items-center gap-2" style="cursor:pointer">
                <input type="radio" name="ef-type" value="reusable" /> ${t('enrollment.type_reusable')}
              </label>
            </div>
          </div>
          <div class="mb-3" id="ef-max-wrap" style="display:none">
            <label class="form-label">${t('enrollment.field_max_uses')}</label>
            <input type="number" id="ef-max" class="form-control" value="5" min="2" max="100" /></div>
          <div class="mb-3"><label class="form-label">${t('enrollment.field_group')}</label>
            <select id="ef-group" class="form-select">${groupOpts}</select></div>
          <div class="mb-3"><label class="form-label">${t('enrollment.field_tags')}</label>
            <input type="text" id="ef-tags" class="form-control" placeholder="tag1, tag2" /></div>
          <div class="mb-3"><label class="form-label">${t('enrollment.field_ttl')}</label>
            <input type="number" id="ef-ttl" class="form-control" value="15" min="5" max="10080" /></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
          <button type="button" class="btn btn-primary" id="ef-create">${t('modal.create')}</button>
        </div>
      </div>
      <!-- Result view -->
      <div id="enrl-result-view" style="display:none">
        <div class="modal-header"><h5 class="modal-title">${t('enrollment.result_title')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body">
          <div class="alert alert-info py-2 mb-3" style="font-size:13px">${t('enrollment.result_msg')}</div>
          <div class="mb-2" style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">${t('enrollment.install_cmd')}</div>
          <div class="token-preview" id="enrl-cmd-preview" style="font-size:11px"></div>
          <button class="btn btn-sm btn-outline-primary mt-2" id="ef-copy">${t('enrollment.copy')}</button>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-primary" data-bs-dismiss="modal">${t('modal.close')}</button>
        </div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl);
  m.show();

  // Toggle max_uses when reusable selected
  modalEl.querySelectorAll('input[name="ef-type"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('ef-max-wrap').style.display =
        modalEl.querySelector('input[name="ef-type"]:checked').value === 'reusable' ? '' : 'none';
    });
  });

  modalEl.querySelector('#ef-create').addEventListener('click', async () => {
    const typeVal = modalEl.querySelector('input[name="ef-type"]:checked').value;
    const tagsStr = modalEl.querySelector('#ef-tags').value.trim();
    const tags    = tagsStr ? tagsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    const payload = {
      name:            modalEl.querySelector('#ef-name').value.trim() || null,
      token_type:      typeVal,
      max_uses:        typeVal === 'reusable' ? +modalEl.querySelector('#ef-max').value : 1,
      target_group_id: modalEl.querySelector('#ef-group').value || null,
      default_tags:    tags,
      ttl_minutes:     +modalEl.querySelector('#ef-ttl').value,
    };
    try {
      const result = await apiPost('/enrollment/tokens', payload);
      // Show result
      document.getElementById('enrl-form-view').style.display = 'none';
      document.getElementById('enrl-result-view').style.display = '';
      const cmd = result.install_command || `# Token: ${result.token}`;
      document.getElementById('enrl-cmd-preview').textContent = cmd;

      document.getElementById('ef-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(cmd).then(() => showToast(t('enrollment.copied'), 'success'));
      });

      await loadAll();
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}
