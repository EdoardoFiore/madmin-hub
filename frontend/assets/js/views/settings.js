/**
 * MADMIN Hub - Settings.
 */
import { apiGet, apiPatch } from '../api.js';
import { escapeHtml, showToast } from '../utils.js';
import { checkPermission } from '../app.js';

const FIELDS = [
    ['Generale', [
        ['company_name', 'Nome', 'text'],
        ['primary_color', 'Colore principale', 'text'],
        ['default_language', 'Lingua predefinita (it/en)', 'text'],
        ['password_max_age_days', 'Scadenza password (giorni, 0 = mai)', 'number'],
    ]],
    ['Istanze', [
        ['agent_url', 'URL agent (https://host:8443), scritto nei token di enrollment', 'text'],
        ['support_host', 'Host per le porte di supporto (vuoto = host dell\'URL agent)', 'text'],
        ['support_port_min', 'Prima porta di supporto', 'number'],
        ['support_port_max', 'Ultima porta di supporto', 'number'],
    ]],
    ['Registrazione senza token', [
        ['registration_enabled', 'Ammessa (le richieste vanno approvate in Enrollment)', 'checkbox'],
        ['registration_allowed_cidrs', 'Solo da queste reti (separate da virgola, vuoto = tutte)', 'text'],
        ['registration_ttl_days', 'Scadenza delle richieste (giorni)', 'number'],
        ['registration_max_pending', 'Massimo richieste in attesa', 'number'],
    ]],
    ['Backup e licenze', [
        ['backup_interval_hours', 'Backup pianificati ogni (ore, 0 = disattivati)', 'number'],
        ['backup_retention', 'Backup conservati per istanza', 'number'],
        ['license_validity_days', 'Durata di un token di licenza (giorni)', 'number'],
    ]],
];

export async function render(container) {
    const s = await apiGet('/settings/system');
    const ro = !checkPermission('hub.manage');
    container.innerHTML = `
        <form id="hub-settings" class="row row-cards">
            ${FIELDS.map(([title, fields]) => `
                <div class="col-lg-6 col-xl-3"><div class="card"><div class="card-header"><h3 class="card-title">${title}</h3></div>
                <div class="card-body">${fields.map(([k, label, type]) => type === 'checkbox' ? `
                    <label class="form-check mb-3"><input name="${k}" type="checkbox" class="form-check-input" ${s[k] ? 'checked' : ''} ${ro ? 'disabled' : ''}>
                    <span class="form-check-label">${label}</span></label>` : `
                    <div class="mb-3"><label class="form-label">${label}</label>
                    <input name="${k}" type="${type}" class="form-control" value="${escapeHtml(s[k] ?? '')}" ${ro ? 'disabled' : ''}></div>`).join('')}
                </div></div></div>`).join('')}
            ${ro ? '' : '<div class="col-12"><button class="btn btn-primary">Salva</button></div>'}
        </form>`;
    container.querySelector('#hub-settings').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {};
        for (const [, fields] of FIELDS) {
            for (const [k, , type] of fields) {
                const input = e.target.elements[k];
                if (type === 'checkbox') { body[k] = input.checked; continue; }
                const v = input.value.trim();
                body[k] = type === 'number' ? Number(v) : v;
            }
        }
        try {
            await apiPatch('/settings/system', body);
            showToast('Impostazioni salvate', 'success');
        } catch (err) {
            showToast(err.message, 'error', 6000);
        }
    });
}
