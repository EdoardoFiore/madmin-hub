/**
 * Profile modal — self-management of email, password, 2FA + backup codes.
 * Opened from the topbar avatar dropdown.
 */
import { apiGet, apiPost, apiPatch, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, showToast } from '../utils.js';
import { getUser } from '../app.js';

let _modalEl = null;
let _modal = null;
let _user = null;
let _status = null;

export async function openProfileModal() {
  _user = getUser();
  if (!_user) return;

  if (_modalEl) { _modal?.show(); return; }

  _modalEl = document.createElement('div');
  _modalEl.className = 'modal fade';
  _modalEl.innerHTML = `<div class="modal-dialog modal-dialog-centered" style="max-width:560px">
    <div class="modal-content">
      <div class="modal-header" style="padding-bottom:0;border-bottom:none">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:40px;height:40px;border-radius:50%;background:rgba(var(--hub-primary-rgb),.12);color:var(--hub-primary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px">
            ${escapeHtml((_user.username || 'U').charAt(0).toUpperCase())}
          </div>
          <div>
            <h5 class="modal-title" style="margin:0">${escapeHtml(_user.username)}</h5>
            <div style="font-size:12px;color:var(--tblr-secondary)">${_user.is_superuser ? t('users.role_admin') : t('users.role_user')}</div>
          </div>
        </div>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="hub-tabs" style="padding:0 16px">
        <button class="hub-tab active" data-tab="general">${t('profile.tab_general')}</button>
        <button class="hub-tab" data-tab="security">${t('profile.tab_security')}</button>
      </div>
      <div class="modal-body" id="pm-panel" style="min-height:280px;padding-top:14px"></div>
    </div>
  </div>`;
  document.body.appendChild(_modalEl);
  _modal = new window.bootstrap.Modal(_modalEl);

  _modalEl.querySelectorAll('.hub-tab').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  _modalEl.addEventListener('hidden.bs.modal', () => {
    _modalEl.remove(); _modalEl = null; _modal = null; _status = null;
  });

  switchTab('general');
  _modal.show();
}

function switchTab(tab) {
  _modalEl.querySelectorAll('.hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const panel = _modalEl.querySelector('#pm-panel');
  if (tab === 'general')  renderGeneral(panel);
  if (tab === 'security') renderSecurity(panel);
}

// ── Generale ─────────────────────────────────────────────────────────────────

function renderGeneral(panel) {
  panel.innerHTML = `
    <div class="row g-3">
      <div class="col-md-6">
        <label class="form-label">${t('users.field_username')}</label>
        <input type="text" class="form-control" value="${escapeHtml(_user.username)}" readonly
               style="background:var(--hub-surface);color:var(--tblr-secondary)" />
      </div>
      <div class="col-md-6">
        <label class="form-label">${t('users.field_email')}</label>
        <div style="display:flex;gap:6px">
          <input type="email" id="pm-email" class="form-control" value="${escapeHtml(_user.email || '')}" placeholder="es. nome@azienda.it" />
          <button type="button" class="btn btn-outline-primary" id="pm-email-save" title="${t('modal.save')}">
            <i class="ti ti-check"></i>
          </button>
        </div>
      </div>
    </div>

    <div style="height:1px;background:var(--hub-border);margin:18px 0"></div>

    <div style="font-size:13px;font-weight:600;margin-bottom:10px;display:flex;align-items:center;gap:8px">
      <i class="ti ti-lock-password" style="color:var(--hub-primary)"></i> ${t('account.pwd_section')}
    </div>
    <div class="row g-2">
      <div class="col-12">
        <label class="form-label" style="font-size:13px">${t('users.field_current_pwd')}</label>
        <input type="password" id="pm-pwd-cur" class="form-control form-control-sm" autocomplete="current-password" />
      </div>
      <div class="col-md-6">
        <label class="form-label" style="font-size:13px">${t('users.pwd_new')}</label>
        <input type="password" id="pm-pwd-new" class="form-control form-control-sm" autocomplete="new-password" />
      </div>
      <div class="col-md-6">
        <label class="form-label" style="font-size:13px">${t('users.field_password_confirm')}</label>
        <input type="password" id="pm-pwd-conf" class="form-control form-control-sm" autocomplete="new-password" />
      </div>
      <div class="col-12">
        <div id="pm-pwd-error" class="alert alert-danger py-2" style="display:none;font-size:13px;margin:8px 0 0"></div>
      </div>
      <div class="col-12 mt-2">
        <button class="btn btn-primary btn-sm" id="pm-pwd-save">${t('account.update_pwd')}</button>
      </div>
    </div>`;

  panel.querySelector('#pm-email-save')?.addEventListener('click', async () => {
    const email = panel.querySelector('#pm-email').value.trim();
    try {
      const updated = await apiPatch('/auth/me', { email: email || null });
      _user.email = updated.email;
      const ddEmail = document.getElementById('dd-email');
      if (ddEmail && updated.email) ddEmail.textContent = updated.email;
      showToast(t('profile.email_updated'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  panel.querySelector('#pm-pwd-save')?.addEventListener('click', async () => {
    const errEl = panel.querySelector('#pm-pwd-error');
    errEl.style.display = 'none';
    const cur     = panel.querySelector('#pm-pwd-cur').value;
    const newPwd  = panel.querySelector('#pm-pwd-new').value;
    const confirm = panel.querySelector('#pm-pwd-conf').value;
    if (!cur || !newPwd) { errEl.textContent = t('users.username_pwd_required'); errEl.style.display = ''; return; }
    if (newPwd !== confirm) { errEl.textContent = t('users.pwd_mismatch'); errEl.style.display = ''; return; }
    try {
      await apiPost('/auth/me/password', { current_password: cur, new_password: newPwd });
      showToast(t('users.password_changed'), 'success');
      panel.querySelector('#pm-pwd-cur').value = '';
      panel.querySelector('#pm-pwd-new').value = '';
      panel.querySelector('#pm-pwd-conf').value = '';
    } catch (e) { errEl.textContent = e.detail || t('msg.error'); errEl.style.display = ''; }
  });
}

// ── Sicurezza ────────────────────────────────────────────────────────────────

async function renderSecurity(panel) {
  panel.innerHTML = `<div class="hub-loader"></div>`;
  try {
    _status = await apiGet('/auth/me/2fa/status');
  } catch (_) {
    _status = { enabled: false, enforced: false, locked: false, has_backup_codes: false, backup_codes_remaining: 0 };
  }

  const badge = _status.locked
    ? `<span class="hub-badge revoked">${t('account.2fa_locked')}</span>`
    : (_status.enabled
        ? `<span class="hub-badge online">${t('account.2fa_enabled')}</span>`
        : `<span class="hub-badge offline">${t('account.2fa_disabled')}</span>`);

  const codesLine = _status.enabled
    ? `<div style="font-size:12px;color:var(--tblr-secondary);margin-top:6px">
         ${t('account.codes_remaining', { n: _status.backup_codes_remaining ?? 0 })}
       </div>`
    : '';

  let actions = '';
  if (_status.enabled) {
    actions = `
      <button class="btn btn-sm btn-outline-primary" id="pm-regen-codes">
        <i class="ti ti-refresh me-1"></i>${t('account.regenerate_codes')}
      </button>
      <button class="btn btn-sm btn-outline-danger" id="pm-disable">
        <i class="ti ti-shield-x me-1"></i>${t('account.disable_2fa')}
      </button>`;
  } else {
    actions = `
      <button class="btn btn-sm btn-primary" id="pm-enable">
        <i class="ti ti-shield-plus me-1"></i>${t('account.enable_2fa')}
      </button>`;
  }

  panel.innerHTML = `
    <div style="background:var(--hub-surface-2);border:1px solid var(--hub-border);border-radius:var(--hub-radius);padding:18px">
      <div style="font-size:14px;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px">
        <i class="ti ti-shield-check" style="color:var(--hub-primary)"></i> ${t('account.2fa_section')}
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span style="font-size:13px;color:var(--tblr-secondary)">${t('users.col_status')}:</span>
        ${badge}
        ${_status.enforced ? `<span class="hub-badge info" style="font-size:10px">${t('users.2fa_enforced_label')}</span>` : ''}
      </div>
      ${codesLine}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">${actions}</div>
    </div>`;

  panel.querySelector('#pm-enable')?.addEventListener('click', () => startSetupWizard());
  panel.querySelector('#pm-regen-codes')?.addEventListener('click', () => regenerateCodes());
  panel.querySelector('#pm-disable')?.addEventListener('click', () => disable2fa());
}

// ── 3-step wizard ────────────────────────────────────────────────────────────

async function startSetupWizard() {
  let setup;
  try {
    setup = await apiPost('/auth/me/2fa/setup');
  } catch (e) { showToast(e.detail || t('msg.error'), 'error'); return; }

  const panel = _modalEl.querySelector('#pm-panel');
  let stepLabel = (n) => `<span style="font-size:11px;font-weight:600;background:rgba(var(--hub-primary-rgb),.1);color:var(--hub-primary);padding:2px 8px;border-radius:4px;margin-right:6px">Step ${n} ${t('account.of')} 3</span>`;

  function step1() {
    panel.innerHTML = `
      <div style="margin-bottom:8px;font-size:13px;color:var(--tblr-secondary)">
        ${stepLabel(1)} ${t('account.2fa_step1')}
      </div>
      <div style="text-align:center;margin:14px 0">
        <img src="data:image/png;base64,${escapeHtml(setup.qr_code)}" alt="QR Code" width="180" height="180"
             style="border-radius:8px;border:1px solid var(--hub-border);background:#fff;padding:6px" />
      </div>
      <div style="font-size:12px;color:var(--tblr-secondary);margin-top:4px">${t('account.2fa_manual')}</div>
      <div style="font-family:monospace;font-size:14px;font-weight:600;letter-spacing:.1em;background:var(--hub-surface);border:1px solid var(--hub-border);border-radius:6px;padding:10px 14px;margin-top:6px;word-break:break-all">${escapeHtml(setup.secret)}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <button class="btn btn-link link-secondary" id="wz-cancel">${t('modal.cancel')}</button>
        <button class="btn btn-primary" id="wz-next">${t('account.next')}</button>
      </div>`;
    panel.querySelector('#wz-cancel').addEventListener('click', () => switchTab('security'));
    panel.querySelector('#wz-next').addEventListener('click', step2);
  }

  function step2() {
    panel.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--tblr-secondary)">
        ${stepLabel(2)} ${t('account.2fa_step2')}
      </div>
      <input type="text" id="wz-otp" class="form-control form-control-lg text-center"
        placeholder="${t('account.otp_placeholder')}" maxlength="6"
        style="letter-spacing:.3em;font-weight:600;font-size:20px" autocomplete="one-time-code" inputmode="numeric" />
      <div id="wz-error" class="alert alert-danger py-2" style="display:none;font-size:13px;margin-top:8px"></div>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:18px">
        <button class="btn btn-link link-secondary" id="wz-back">${t('account.back')}</button>
        <button class="btn btn-primary" id="wz-verify">${t('account.verify')}</button>
      </div>`;
    const otp = panel.querySelector('#wz-otp');
    otp.focus();
    otp.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
    otp.addEventListener('keydown', e => { if (e.key === 'Enter') panel.querySelector('#wz-verify').click(); });
    panel.querySelector('#wz-back').addEventListener('click', step1);
    panel.querySelector('#wz-verify').addEventListener('click', async () => {
      const errEl = panel.querySelector('#wz-error');
      errEl.style.display = 'none';
      const code = otp.value.trim();
      if (code.length < 6) { errEl.textContent = t('account.otp_required'); errEl.style.display = ''; return; }
      try {
        const res = await apiPost('/auth/me/2fa/enable', { code });
        _user.totp_enabled = true;
        showToast(t('account.2fa_enabled_ok'), 'success');
        step3(res.backup_codes || []);
      } catch (e) { errEl.textContent = e.detail || t('msg.error'); errEl.style.display = ''; }
    });
  }

  function step3(codes) {
    renderBackupCodesPanel(panel, codes, stepLabel(3));
  }

  step1();
}

function renderBackupCodesPanel(panel, codes, headerLabel) {
  const list = codes.map(c => `<div>${escapeHtml(c)}</div>`).join('');
  panel.innerHTML = `
    <div style="margin-bottom:10px;font-size:13px;color:var(--tblr-secondary)">
      ${headerLabel || ''} ${t('account.backup_codes_desc')}
    </div>
    <div style="background:var(--hub-surface);border:1px solid var(--hub-border);border-radius:8px;padding:14px;font-family:monospace;font-size:14px;line-height:1.9;letter-spacing:.08em;display:grid;grid-template-columns:1fr 1fr;gap:4px 24px">${list}</div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-sm btn-outline-secondary" id="bc-copy"><i class="ti ti-copy me-1"></i>${t('account.backup_codes_copy')}</button>
      <button class="btn btn-sm btn-outline-secondary" id="bc-download"><i class="ti ti-download me-1"></i>${t('account.backup_codes_download')}</button>
    </div>
    <div class="alert alert-warning mt-3 py-2 px-3" style="font-size:12px;margin-bottom:0">
      <i class="ti ti-alert-triangle me-1"></i>${t('account.backup_codes_warn')}
    </div>
    <label class="d-flex align-items-center gap-2 mt-3" style="cursor:pointer;font-size:13px">
      <input type="checkbox" id="bc-saved" class="form-check-input" />
      ${t('account.backup_codes_saved')}
    </label>
    <div style="display:flex;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-primary" id="bc-done" disabled>${t('modal.close')}</button>
    </div>`;

  panel.querySelector('#bc-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); showToast(t('account.backup_codes_copied'), 'success'); }
    catch (_) { showToast(t('msg.error'), 'error'); }
  });
  panel.querySelector('#bc-download').addEventListener('click', () => {
    const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `madmin-hub-backup-codes-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  const doneBtn = panel.querySelector('#bc-done');
  panel.querySelector('#bc-saved').addEventListener('change', e => { doneBtn.disabled = !e.target.checked; });
  doneBtn.addEventListener('click', () => switchTab('security'));
}

// ── Regenerate codes ─────────────────────────────────────────────────────────

async function regenerateCodes() {
  const panel = _modalEl.querySelector('#pm-panel');
  panel.innerHTML = `
    <div style="margin-bottom:10px;font-size:13px;color:var(--tblr-secondary)">
      ${t('account.regenerate_codes_desc')}
    </div>
    <input type="text" id="rg-otp" class="form-control form-control-lg text-center"
      placeholder="${t('account.otp_placeholder')}" maxlength="6"
      style="letter-spacing:.3em;font-weight:600;font-size:20px" autocomplete="one-time-code" inputmode="numeric" />
    <div id="rg-error" class="alert alert-danger py-2" style="display:none;font-size:13px;margin-top:8px"></div>
    <div style="display:flex;justify-content:space-between;gap:8px;margin-top:18px">
      <button class="btn btn-link link-secondary" id="rg-back">${t('account.back')}</button>
      <button class="btn btn-primary" id="rg-verify">${t('account.verify')}</button>
    </div>`;
  const otp = panel.querySelector('#rg-otp');
  otp.focus();
  otp.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
  otp.addEventListener('keydown', e => { if (e.key === 'Enter') panel.querySelector('#rg-verify').click(); });
  panel.querySelector('#rg-back').addEventListener('click', () => switchTab('security'));
  panel.querySelector('#rg-verify').addEventListener('click', async () => {
    const errEl = panel.querySelector('#rg-error');
    errEl.style.display = 'none';
    const code = otp.value.trim();
    if (code.length < 6) { errEl.textContent = t('account.otp_required'); errEl.style.display = ''; return; }
    try {
      const res = await apiPost('/auth/me/2fa/backup-codes', { code });
      showToast(t('account.codes_regenerated'), 'success');
      renderBackupCodesPanel(panel, res.backup_codes || [], '');
    } catch (e) { errEl.textContent = e.detail || t('msg.error'); errEl.style.display = ''; }
  });
}

// ── Disable 2FA ──────────────────────────────────────────────────────────────

async function disable2fa() {
  const panel = _modalEl.querySelector('#pm-panel');
  panel.innerHTML = `
    <div style="margin-bottom:10px;font-size:13px;color:var(--tblr-secondary)">
      ${t('account.disable_2fa_password_prompt')}
    </div>
    <input type="password" id="dis-pwd" class="form-control" autocomplete="current-password" />
    <div id="dis-error" class="alert alert-danger py-2" style="display:none;font-size:13px;margin-top:8px"></div>
    <div style="display:flex;justify-content:space-between;gap:8px;margin-top:18px">
      <button class="btn btn-link link-secondary" id="dis-back">${t('account.back')}</button>
      <button class="btn btn-danger" id="dis-confirm">${t('account.disable_2fa')}</button>
    </div>`;
  const pwd = panel.querySelector('#dis-pwd');
  pwd.focus();
  pwd.addEventListener('keydown', e => { if (e.key === 'Enter') panel.querySelector('#dis-confirm').click(); });
  panel.querySelector('#dis-back').addEventListener('click', () => switchTab('security'));
  panel.querySelector('#dis-confirm').addEventListener('click', async () => {
    const errEl = panel.querySelector('#dis-error');
    errEl.style.display = 'none';
    const password = pwd.value;
    if (!password) { errEl.textContent = t('users.username_pwd_required'); errEl.style.display = ''; return; }
    try {
      await apiDelete('/auth/me/2fa/disable', { password });
      _user.totp_enabled = false;
      showToast(t('account.2fa_disabled_ok'), 'success');
      switchTab('security');
    } catch (e) { errEl.textContent = e.detail || t('msg.error'); errEl.style.display = ''; }
  });
}
