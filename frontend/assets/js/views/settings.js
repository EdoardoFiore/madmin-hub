import { apiGet, apiPost, apiPatch } from '../api.js';
import { t } from '../i18n.js';
import { escapeHtml, showToast } from '../utils.js';
import { applyBranding } from '../branding.js';

export async function render(container, params) {
  const tab = params?.[0] || 'general';

  container.innerHTML = `
    <div class="hub-page-header">
      <h1 class="hub-page-title">${t('settings.title')}</h1>
    </div>
    <div class="hub-tabs" id="settings-tabs">
      <button class="hub-tab" data-tab="general">${t('settings.tab_general')}</button>
      <button class="hub-tab" data-tab="smtp">${t('settings.tab_smtp')}</button>
      <button class="hub-tab" data-tab="branding">${t('settings.tab_branding')}</button>
      <button class="hub-tab" data-tab="retention">${t('settings.tab_retention')}</button>
      <button class="hub-tab" data-tab="security">${t('settings.tab_security')}</button>
    </div>
    <div id="settings-panel" style="max-width:640px"></div>`;

  const panel = document.getElementById('settings-panel');

  async function switchTab(t2) {
    window.location.hash = `settings/${t2}`;
    container.querySelectorAll('.hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t2));
    panel.innerHTML = '<div class="hub-loader"></div>';
    if (t2 === 'general')   await renderGeneral(panel);
    if (t2 === 'smtp')      await renderSmtp(panel);
    if (t2 === 'branding')  await renderBranding(panel);
    if (t2 === 'retention') await renderRetention(panel);
    if (t2 === 'security')  await renderSecurity(panel);
  }

  container.querySelectorAll('.hub-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  await switchTab(tab);
}

// ── General ───────────────────────────────────────────────────────────────────

async function renderGeneral(panel) {
  const s = await apiGet('/settings/system').catch(() => ({}));
  panel.innerHTML = `<div class="data-table" style="padding:20px;margin-top:8px">
    <div class="mb-3"><label class="form-label">${t('settings.company_name')}</label>
      <input type="text" id="sg-company" class="form-control" value="${escapeHtml(s.company_name||'')}" /></div>
    <div class="mb-3"><label class="form-label">${t('settings.hub_url')}</label>
      <input type="url" id="sg-huburl" class="form-control" value="${escapeHtml(s.hub_url||'')}" placeholder="https://hub.example.com" />
      <div class="form-text">${t('settings.hub_url_hint')}</div></div>
    <div class="mb-3"><label class="form-label">${t('settings.support_url')}</label>
      <input type="url" id="sg-support" class="form-control" value="${escapeHtml(s.support_url||'')}" /></div>
    <div class="mb-3"><label class="form-label">${t('settings.default_language')}</label>
      <select id="sg-lang" class="form-select">
        <option value="it" ${s.default_language==='it'?'selected':''}>Italiano</option>
        <option value="en" ${s.default_language==='en'?'selected':''}>English</option>
      </select></div>
    <button class="btn btn-primary" id="sg-save">${t('settings.save')}</button>
  </div>`;

  panel.querySelector('#sg-save').addEventListener('click', async () => {
    try {
      await apiPatch('/settings/system', {
        company_name:     panel.querySelector('#sg-company').value.trim() || null,
        hub_url:          panel.querySelector('#sg-huburl').value.trim() || null,
        support_url:      panel.querySelector('#sg-support').value.trim() || null,
        default_language: panel.querySelector('#sg-lang').value,
      });
      showToast(t('settings.saved'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
}

// ── SMTP ──────────────────────────────────────────────────────────────────────

async function renderSmtp(panel) {
  const s = await apiGet('/settings/smtp').catch(() => ({}));
  panel.innerHTML = `<div class="data-table" style="padding:20px;margin-top:8px">
    <div class="row g-3 mb-3">
      <div class="col-8"><label class="form-label">${t('settings.smtp_host')}</label>
        <input type="text" id="ss-host" class="form-control" value="${escapeHtml(s.host||'')}" /></div>
      <div class="col-4"><label class="form-label">${t('settings.smtp_port')}</label>
        <input type="number" id="ss-port" class="form-control" value="${s.port||587}" /></div>
    </div>
    <div class="mb-3"><label class="form-label">${t('settings.smtp_user')}</label>
      <input type="text" id="ss-user" class="form-control" value="${escapeHtml(s.username||'')}" /></div>
    <div class="mb-3"><label class="form-label">${t('settings.smtp_pass')}</label>
      <input type="password" id="ss-pass" class="form-control" placeholder="${s.password ? '••••••••' : t('settings.smtp_not_set')}" autocomplete="new-password" /></div>
    <div class="mb-3"><label class="form-label">${t('settings.smtp_from')}</label>
      <input type="email" id="ss-from" class="form-control" value="${escapeHtml(s.from_address||'')}" /></div>
    <div class="mb-3"><label class="form-label">${t('settings.smtp_from_name')}</label>
      <input type="text" id="ss-from-name" class="form-control" value="${escapeHtml(s.from_name||'')}" /></div>
    <div class="d-flex gap-2">
      <button class="btn btn-primary" id="ss-save">${t('settings.smtp_save')}</button>
      <button class="btn btn-outline-secondary" id="ss-test">${t('settings.smtp_test')}</button>
    </div>
  </div>`;

  panel.querySelector('#ss-save').addEventListener('click', async () => {
    const pass = panel.querySelector('#ss-pass').value;
    const payload = {
      host:         panel.querySelector('#ss-host').value.trim(),
      port:         +panel.querySelector('#ss-port').value,
      username:     panel.querySelector('#ss-user').value.trim(),
      from_address: panel.querySelector('#ss-from').value.trim(),
      from_name:    panel.querySelector('#ss-from-name').value.trim(),
    };
    if (pass) payload.password = pass;
    try {
      await apiPatch('/settings/smtp', payload);
      showToast(t('settings.smtp_saved'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });

  panel.querySelector('#ss-test').addEventListener('click', async () => {
    try {
      await apiPost('/settings/smtp/test', {});
      showToast(t('settings.smtp_test_sent'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
}

// ── Branding ──────────────────────────────────────────────────────────────────

async function renderBranding(panel) {
  const s = await apiGet('/settings/system').catch(() => ({}));
  panel.innerHTML = `<div class="data-table" style="padding:20px;margin-top:8px">
    <div class="mb-3"><label class="form-label">${t('settings.primary_color')}</label>
      <div class="d-flex align-items-center gap-3">
        <input type="color" id="sb-color" class="form-control form-control-color" value="${s.primary_color||'#206bc4'}" />
        <span id="sb-color-val" class="text-mono" style="font-size:13px">${s.primary_color||'#206bc4'}</span>
        <span style="width:24px;height:24px;border-radius:50%;background:${escapeHtml(s.primary_color||'#206bc4')}" id="sb-swatch"></span>
      </div></div>
    <div class="mb-3"><label class="form-label">${t('settings.logo_url')}</label>
      <input type="url" id="sb-logo" class="form-control" value="${escapeHtml(s.logo_url||'')}" /></div>
    <div class="mb-3"><label class="form-label">${t('settings.favicon_url')}</label>
      <input type="url" id="sb-fav" class="form-control" value="${escapeHtml(s.favicon_url||'')}" /></div>
    <button class="btn btn-primary" id="sb-save">${t('settings.save')}</button>
  </div>`;

  panel.querySelector('#sb-color').addEventListener('input', e => {
    document.getElementById('sb-color-val').textContent = e.target.value;
    document.getElementById('sb-swatch').style.background = e.target.value;
  });

  panel.querySelector('#sb-save').addEventListener('click', async () => {
    try {
      const updated = await apiPatch('/settings/system', {
        primary_color: panel.querySelector('#sb-color').value,
        logo_url:      panel.querySelector('#sb-logo').value.trim() || null,
        favicon_url:   panel.querySelector('#sb-fav').value.trim() || null,
      });
      if (updated) applyBranding(updated);
      showToast(t('settings.saved'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
}

// ── Retention ─────────────────────────────────────────────────────────────────

async function renderRetention(panel) {
  const s = await apiGet('/settings/system').catch(() => ({}));
  panel.innerHTML = `<div class="data-table" style="padding:20px;margin-top:8px">
    <div class="mb-3"><label class="form-label">${t('settings.tel_retention')}</label>
      <input type="number" id="sr-tel" class="form-control" value="${s.telemetry_retention_days||30}" min="1" max="365" /></div>
    <div class="mb-3"><label class="form-label">${t('settings.audit_retention')}</label>
      <input type="number" id="sr-aud" class="form-control" value="${s.audit_retention_days||90}" min="1" max="365" /></div>
    <div class="mb-3"><label class="form-label">${t('settings.default_token_ttl')}</label>
      <input type="number" id="sr-ttl" class="form-control" value="${s.default_token_ttl_minutes||15}" min="5" max="10080" /></div>
    <button class="btn btn-primary" id="sr-save">${t('settings.save')}</button>
  </div>`;

  panel.querySelector('#sr-save').addEventListener('click', async () => {
    try {
      await apiPatch('/settings/system', {
        telemetry_retention_days:  +panel.querySelector('#sr-tel').value,
        audit_retention_days:      +panel.querySelector('#sr-aud').value,
        default_token_ttl_minutes: +panel.querySelector('#sr-ttl').value,
      });
      showToast(t('settings.saved'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
}

// ── Security ──────────────────────────────────────────────────────────────────

async function renderSecurity(panel) {
  const s = await apiGet('/settings/system').catch(() => ({}));
  panel.innerHTML = `<div class="data-table" style="padding:20px;margin-top:8px">
    <div class="mb-3">
      <div class="form-check form-switch">
        <input class="form-check-input" type="checkbox" id="ssec-2fa" ${s.enforce_2fa_global ? 'checked' : ''} />
        <label class="form-check-label" for="ssec-2fa">${t('settings.enforce_2fa_global')}</label>
      </div>
      <div class="form-text">${t('settings.enforce_2fa_hint')}</div>
    </div>
    <button class="btn btn-primary" id="ssec-save">${t('settings.save')}</button>
  </div>`;

  panel.querySelector('#ssec-save').addEventListener('click', async () => {
    try {
      await apiPatch('/settings/system', {
        enforce_2fa_global: panel.querySelector('#ssec-2fa').checked,
      });
      showToast(t('settings.saved'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error'), 'error'); }
  });
}
