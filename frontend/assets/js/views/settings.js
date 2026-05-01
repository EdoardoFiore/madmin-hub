/**
 * Settings — system settings + SMTP.
 */
import { apiGet, apiPatch } from '../api.js';
import { showSpinner, showToast } from '../utils.js';
import { t } from '../i18n.js';

export async function render(container) {
  showSpinner(container);
  let [sys, smtp] = [null, null];
  try {
    [sys, smtp] = await Promise.all([apiGet('/settings/system'), apiGet('/settings/smtp')]);
  } catch { }

  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl"><h2 class="page-title">${t('settings.title')}</h2></div>
    </div>
    <div class="page-body">
      <div class="container-xl">
        <div class="row row-cards">

          <!-- System settings -->
          <div class="col-lg-6">
            <div class="card">
              <div class="card-header"><h3 class="card-title">${t('settings.hub_section')}</h3></div>
              <div class="card-body">
                <div class="mb-2">
                  <label class="form-label">${t('settings.company_name')}</label>
                  <input id="s-company" type="text" class="form-control" value="${sys?.company_name || ''}" />
                </div>
                <div class="mb-2">
                  <label class="form-label">${t('settings.primary_color')}</label>
                  <input id="s-color" type="color" class="form-control form-control-color" value="${sys?.primary_color || '#206bc4'}" />
                </div>
                <div class="mb-2">
                  <label class="form-label">${t('settings.tel_retention')}</label>
                  <input id="s-tel-ret" type="number" class="form-control" value="${sys?.telemetry_retention_days || 30}" min="1" max="365" />
                </div>
                <div class="mb-3">
                  <label class="form-label">${t('settings.audit_retention')}</label>
                  <input id="s-audit-ret" type="number" class="form-control" value="${sys?.audit_retention_days || 90}" min="1" />
                </div>
                <button id="s-save" class="btn btn-primary">${t('settings.save')}</button>
              </div>
            </div>
          </div>

          <!-- SMTP -->
          <div class="col-lg-6">
            <div class="card">
              <div class="card-header d-flex align-items-center">
                <h3 class="card-title mb-0">${t('settings.smtp_section')}</h3>
                <div class="ms-auto form-check form-switch">
                  <input class="form-check-input" type="checkbox" id="smtp-enabled" ${smtp?.enabled ? 'checked' : ''} />
                </div>
              </div>
              <div class="card-body">
                <div class="mb-2">
                  <label class="form-label">${t('settings.smtp_host')}</label>
                  <input id="smtp-host" type="text" class="form-control" value="${smtp?.host || ''}" />
                </div>
                <div class="row mb-2">
                  <div class="col">
                    <label class="form-label">${t('settings.smtp_port')}</label>
                    <input id="smtp-port" type="number" class="form-control" value="${smtp?.port || 587}" />
                  </div>
                  <div class="col-auto d-flex align-items-end pb-1">
                    <label class="form-check mb-0">
                      <input id="smtp-tls" type="checkbox" class="form-check-input" ${smtp?.use_tls ? 'checked' : ''} />
                      <span class="form-check-label">STARTTLS</span>
                    </label>
                  </div>
                </div>
                <div class="mb-2">
                  <label class="form-label">${t('settings.smtp_user')}</label>
                  <input id="smtp-user" type="text" class="form-control" value="${smtp?.username || ''}" />
                </div>
                <div class="mb-2">
                  <label class="form-label">${t('settings.smtp_pass')}</label>
                  <input id="smtp-pass" type="password" class="form-control" placeholder="${smtp?.password ? '••••••••' : t('settings.smtp_not_set')}" />
                </div>
                <div class="mb-3">
                  <label class="form-label">${t('settings.smtp_from')}</label>
                  <input id="smtp-from" type="email" class="form-control" value="${smtp?.from_address || ''}" />
                </div>
                <button id="smtp-save" class="btn btn-primary">${t('settings.smtp_save')}</button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>`;

  container.querySelector('#s-save').addEventListener('click', async () => {
    try {
      await apiPatch('/settings/system', {
        company_name: container.querySelector('#s-company').value,
        primary_color: container.querySelector('#s-color').value,
        telemetry_retention_days: parseInt(container.querySelector('#s-tel-ret').value),
        audit_retention_days: parseInt(container.querySelector('#s-audit-ret').value),
      });
      showToast(t('settings.saved'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });

  container.querySelector('#smtp-save').addEventListener('click', async () => {
    const pass = container.querySelector('#smtp-pass').value;
    const payload = {
      enabled: container.querySelector('#smtp-enabled').checked,
      host: container.querySelector('#smtp-host').value,
      port: parseInt(container.querySelector('#smtp-port').value),
      username: container.querySelector('#smtp-user').value || null,
      use_tls: container.querySelector('#smtp-tls').checked,
      from_address: container.querySelector('#smtp-from').value || null,
    };
    if (pass) payload.password = pass;
    try {
      await apiPatch('/settings/smtp', payload);
      showToast(t('settings.smtp_saved'), 'success');
    } catch (e) { showToast(e.detail || t('msg.error', {}), 'error'); }
  });
}
