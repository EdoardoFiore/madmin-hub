import { apiGet, apiPost, apiDelete } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, relativeTime, showToast } from '../utils.js';
import { getUser } from '../app.js';

export async function render(container) {
  const user = getUser();
  if (!user) { container.innerHTML = ''; return; }

  container.innerHTML = `
    <div class="hub-page-header">
      <h1 class="hub-page-title">${t('account.title')}</h1>
    </div>
    <div class="hub-tabs" style="margin-bottom:16px">
      <button class="hub-tab active" data-tab="profile">${t('account.tab_profile')}</button>
      <button class="hub-tab" data-tab="security">${t('account.tab_security')}</button>
    </div>
    <div id="account-panel"></div>`;

  const panel = container.querySelector('#account-panel');

  function switchTab(tab) {
    container.querySelectorAll('.hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'profile')  renderProfile(panel, user);
    if (tab === 'security') renderSecurity(panel, user);
  }

  container.querySelectorAll('.hub-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  switchTab('profile');
}

function renderProfile(panel, user) {
  const row = (label, val) => `
    <div style="display:flex;gap:16px;padding:12px 0;border-bottom:1px solid var(--hub-border);font-size:14px">
      <div style="width:140px;color:var(--tblr-secondary);flex-shrink:0;font-size:13px">${escapeHtml(label)}</div>
      <div style="flex:1">${val}</div>
    </div>`;

  panel.innerHTML = `
    <div style="max-width:560px">
      <div style="display:flex;align-items:center;gap:16px;padding:20px;background:var(--hub-surface-2);border:1px solid var(--hub-border);border-radius:var(--hub-radius);margin-bottom:16px">
        <div style="width:56px;height:56px;border-radius:50%;background:rgba(var(--hub-primary-rgb),.12);color:var(--hub-primary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px;flex-shrink:0">
          ${escapeHtml((user.username || 'U').charAt(0).toUpperCase())}
        </div>
        <div>
          <div style="font-size:18px;font-weight:700">${escapeHtml(user.username)}</div>
          <div style="font-size:13px;color:var(--tblr-secondary)">${user.is_superuser ? t('users.role_admin') : t('users.role_user')}</div>
        </div>
      </div>
      <div style="background:var(--hub-surface-2);border:1px solid var(--hub-border);border-radius:var(--hub-radius);padding:0 16px">
        ${row(t('users.field_username'), `<strong>${escapeHtml(user.username)}</strong>`)}
        ${row(t('users.field_email'), escapeHtml(user.email || '—'))}
        ${row(t('users.col_lastlogin'), relativeTime(user.last_login))}
        ${row(t('users.col_status'), `<span class="hub-badge ${user.is_active ? 'online' : 'offline'}">${user.is_active ? t('users.status_active') : t('users.status_disabled')}</span>`)}
        ${row('2FA', `<span class="hub-badge ${user.totp_enabled ? 'info' : 'revoked'}">${user.totp_enabled ? t('account.2fa_enabled') : t('account.2fa_disabled')}</span>`)}
      </div>
    </div>`;
}

function renderSecurity(panel, user) {
  panel.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:860px">
      <div style="background:var(--hub-surface-2);border:1px solid var(--hub-border);border-radius:var(--hub-radius);padding:20px">
        <div style="font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px">
          <i class="ti ti-lock-password" style="color:var(--hub-primary)"></i> ${t('account.pwd_section')}
        </div>
        <div class="mb-3">
          <label class="form-label" style="font-size:13px">${t('users.field_current_pwd')}</label>
          <input type="password" id="sec-cur" class="form-control form-control-sm" autocomplete="current-password" />
        </div>
        <div class="mb-3">
          <label class="form-label" style="font-size:13px">${t('users.pwd_new')}</label>
          <input type="password" id="sec-new" class="form-control form-control-sm" autocomplete="new-password" />
        </div>
        <div class="mb-3">
          <label class="form-label" style="font-size:13px">${t('users.field_password_confirm')}</label>
          <input type="password" id="sec-confirm" class="form-control form-control-sm" autocomplete="new-password" />
        </div>
        <div id="sec-pwd-error" class="alert alert-danger py-2" style="display:none;font-size:13px;margin-bottom:8px"></div>
        <button class="btn btn-primary btn-sm" id="sec-save-pwd">${t('account.update_pwd')}</button>
      </div>

      <div style="background:var(--hub-surface-2);border:1px solid var(--hub-border);border-radius:var(--hub-radius);padding:20px">
        <div style="font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px">
          <i class="ti ti-shield-check" style="color:var(--hub-primary)"></i> ${t('account.2fa_section')}
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
          <span style="font-size:13px;color:var(--tblr-secondary)">Stato:</span>
          <span class="hub-badge ${user.totp_enabled ? 'info' : 'revoked'}" id="sec-2fa-badge">
            ${user.totp_enabled ? t('account.2fa_enabled') : t('account.2fa_disabled')}
          </span>
        </div>
        <div id="sec-2fa-actions">
          ${user.totp_enabled
            ? `<button class="btn btn-sm btn-outline-danger" id="sec-disable-2fa">
                 <i class="ti ti-shield-x me-1"></i>${t('account.disable_2fa')}
               </button>`
            : `<button class="btn btn-sm btn-outline-primary" id="sec-enable-2fa">
                 <i class="ti ti-shield-plus me-1"></i>${t('account.enable_2fa')}
               </button>`}
        </div>
      </div>
    </div>`;

  // Password change
  panel.querySelector('#sec-save-pwd')?.addEventListener('click', async () => {
    const errEl = panel.querySelector('#sec-pwd-error');
    errEl.style.display = 'none';
    const cur     = panel.querySelector('#sec-cur').value;
    const newPwd  = panel.querySelector('#sec-new').value;
    const confirm = panel.querySelector('#sec-confirm').value;
    if (!cur || !newPwd) { errEl.textContent = t('users.username_pwd_required'); errEl.style.display = ''; return; }
    if (newPwd !== confirm) { errEl.textContent = t('users.pwd_mismatch'); errEl.style.display = ''; return; }
    try {
      await apiPost('/auth/me/password', { current_password: cur, new_password: newPwd });
      showToast(t('users.password_changed'), 'success');
      panel.querySelector('#sec-cur').value = '';
      panel.querySelector('#sec-new').value = '';
      panel.querySelector('#sec-confirm').value = '';
    } catch (e) { errEl.textContent = e.detail || t('msg.error'); errEl.style.display = ''; }
  });

  // Disable 2FA
  panel.querySelector('#sec-disable-2fa')?.addEventListener('click', async () => {
    const ok = confirm(t('account.2fa_disable_confirm'));
    if (!ok) return;
    try {
      await apiDelete('/auth/me/2fa/disable');
      showToast(t('account.2fa_disabled_ok'), 'success');
      user.totp_enabled = false;
      refresh2faSection(panel, user);
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  // Enable 2FA
  panel.querySelector('#sec-enable-2fa')?.addEventListener('click', () => show2faSetupModal(user, panel));
}

function refresh2faSection(panel, user) {
  const badge   = panel.querySelector('#sec-2fa-badge');
  const actions = panel.querySelector('#sec-2fa-actions');
  if (badge) {
    badge.className = `hub-badge ${user.totp_enabled ? 'info' : 'revoked'}`;
    badge.textContent = user.totp_enabled ? t('account.2fa_enabled') : t('account.2fa_disabled');
  }
  if (actions) {
    actions.innerHTML = user.totp_enabled
      ? `<button class="btn btn-sm btn-outline-danger" id="sec-disable-2fa"><i class="ti ti-shield-x me-1"></i>${t('account.disable_2fa')}</button>`
      : `<button class="btn btn-sm btn-outline-primary" id="sec-enable-2fa"><i class="ti ti-shield-plus me-1"></i>${t('account.enable_2fa')}</button>`;
    panel.querySelector('#sec-disable-2fa')?.addEventListener('click', async () => {
      const ok = confirm(t('account.2fa_disable_confirm'));
      if (!ok) return;
      try {
        await apiDelete('/auth/me/2fa/disable');
        showToast(t('account.2fa_disabled_ok'), 'success');
        user.totp_enabled = false;
        refresh2faSection(panel, user);
      } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
    });
    panel.querySelector('#sec-enable-2fa')?.addEventListener('click', () => show2faSetupModal(user, panel));
  }
}

// ── 2FA Setup Modal (2 steps) ─────────────────────────────────────────────────

async function show2faSetupModal(user, secPanel) {
  let setupData = null;
  try {
    setupData = await apiPost('/auth/me/2fa/setup');
  } catch (e) {
    showToast(e.detail || t('msg.error'), 'error');
    return;
  }

  const secret = setupData.secret || '';
  const uri    = setupData.provisioning_uri || '';
  const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(uri)}&size=180x180&margin=10`;

  const modalEl = document.createElement('div');
  modalEl.className = 'modal fade';
  modalEl.innerHTML = `<div class="modal-dialog modal-dialog-centered" style="max-width:420px">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">${t('account.2fa_setup_title')}</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body" id="tfa-panel"></div>
      <div class="modal-footer" id="tfa-footer"></div>
    </div>
  </div>`;
  document.body.appendChild(modalEl);
  const m = new window.bootstrap.Modal(modalEl, { backdrop: 'static' });
  m.show();

  const tfaPanel  = modalEl.querySelector('#tfa-panel');
  const tfaFooter = modalEl.querySelector('#tfa-footer');

  function step1() {
    tfaPanel.innerHTML = `
      <div style="margin-bottom:8px;font-size:13px;color:var(--tblr-secondary)">
        <span style="font-size:11px;font-weight:600;background:rgba(var(--hub-primary-rgb),.1);color:var(--hub-primary);padding:2px 8px;border-radius:4px;margin-right:6px">Step 1 di 2</span>
        ${t('account.2fa_step1')}
      </div>
      <div style="text-align:center;margin:16px 0">
        <img src="${escapeHtml(qrUrl)}" alt="QR Code" width="180" height="180" style="border-radius:8px;border:1px solid var(--hub-border)" onerror="this.style.display='none'" />
      </div>
      <div style="font-size:12px;color:var(--tblr-secondary);margin-top:4px">${t('account.2fa_manual')}</div>
      <div style="font-family:monospace;font-size:14px;font-weight:600;letter-spacing:.1em;background:var(--hub-surface);border:1px solid var(--hub-border);border-radius:6px;padding:10px 14px;margin-top:6px;word-break:break-all">${escapeHtml(secret)}</div>`;
    tfaFooter.innerHTML = `
      <button type="button" class="btn btn-link link-secondary" data-bs-dismiss="modal">${t('modal.cancel')}</button>
      <button type="button" class="btn btn-primary" id="tfa-next">${t('account.next')}</button>`;
    tfaFooter.querySelector('#tfa-next')?.addEventListener('click', step2);
  }

  function step2() {
    tfaPanel.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--tblr-secondary)">
        <span style="font-size:11px;font-weight:600;background:rgba(var(--hub-primary-rgb),.1);color:var(--hub-primary);padding:2px 8px;border-radius:4px;margin-right:6px">Step 2 di 2</span>
        ${t('account.2fa_step2')}
      </div>
      <input type="text" id="tfa-otp" class="form-control form-control-lg text-center"
        placeholder="${t('account.otp_placeholder')}" maxlength="6"
        style="letter-spacing:.3em;font-weight:600;font-size:20px" autocomplete="one-time-code" inputmode="numeric" />
      <div id="tfa-error" class="alert alert-danger py-2" style="display:none;font-size:13px;margin-top:8px"></div>`;
    tfaFooter.innerHTML = `
      <button type="button" class="btn btn-link link-secondary" id="tfa-back">${t('account.back')}</button>
      <button type="button" class="btn btn-primary" id="tfa-verify">${t('account.verify')}</button>`;

    const otp = tfaPanel.querySelector('#tfa-otp');
    otp?.focus();
    otp?.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
    otp?.addEventListener('keydown', e => { if (e.key === 'Enter') tfaFooter.querySelector('#tfa-verify')?.click(); });

    tfaFooter.querySelector('#tfa-back')?.addEventListener('click', step1);
    tfaFooter.querySelector('#tfa-verify')?.addEventListener('click', async () => {
      const errEl = tfaPanel.querySelector('#tfa-error');
      errEl.style.display = 'none';
      const code = otp?.value.replace(/\s/g, '') || '';
      if (code.length < 6) { errEl.textContent = 'Inserisci il codice a 6 cifre.'; errEl.style.display = ''; return; }
      try {
        await apiPost('/auth/me/2fa/enable', { code });
        showToast(t('account.2fa_enabled_ok'), 'success');
        user.totp_enabled = true;
        m.hide();
        refresh2faSection(secPanel, user);
      } catch (e) { errEl.textContent = e.detail || t('msg.error'); errEl.style.display = ''; }
    });
  }

  step1();
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
}
