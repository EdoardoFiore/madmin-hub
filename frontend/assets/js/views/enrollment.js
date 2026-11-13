/**
 * MADMIN Manager - Enrollment: tokens, registrations waiting for approval,
 * API keys of the provisioning system (superusers).
 */
import { apiGet, apiPost } from '../api.js';
import { escapeHtml, showToast, confirmDialog, actionAttrs, registerActions, loadingSpinner } from '../utils.js';
import { setPageActions, checkPermission } from '../app.js';
import { fmtDate, formModal, secretModal, copyBlock, enrollTokenHelp, formData, groupPath, labelBadges,
         registrationFieldsHtml, registrationFieldsValue, field, formSection, notice, confirmAction,
         fieldError } from './manager-common.js';

let containerEl = null;
let manage = false;
let groups = [];
let tab = 'tokens';
let requests = [];

const TABS = [['tokens', 'Token'], ['requests', 'In attesa'], ['apikeys', 'Chiavi API']];

export async function render(container, params = []) {
    containerEl = container;
    tab = TABS.some(([t]) => t === params[0]) ? params[0] : 'tokens';
    // The page needs manager.view; changing anything needs manager.manage (superuser rw)
    manage = checkPermission('manager.manage');
    const tabs = TABS;

    const actions = { tokens: `<button class="btn btn-primary" ${actionAttrs('managerTokenNew')}><i class="ti ti-plus me-1"></i>Nuovo token</button>`,
                      apikeys: `<button class="btn btn-primary" ${actionAttrs('managerKeyNew')}><i class="ti ti-plus me-1"></i>Nuova chiave API</button>` };
    setPageActions(manage ? (actions[tab] || '') : '');

    const [info, g] = await Promise.all([apiGet('/enrollment/info'), apiGet('/groups').catch(() => [])]);
    groups = g;
    container.innerHTML = `
        ${info.agent_url ? '' : '<div class="alert alert-warning">Impostare l\'URL agent in Impostazioni prima di creare token.</div>'}
        <div class="card mb-3"><div class="card-body small">
            <div>URL agent: <span class="font-monospace">${escapeHtml(info.agent_url || '-')}</span></div>
            <div>Fingerprint CA (sha256): <span class="font-monospace">${escapeHtml(info.ca_fingerprint || '-')}</span></div>
            <div class="text-muted mt-1">Con token: <code>setup-madmin.sh ... --manager-token-file token.txt</code> ·
                Senza token (approvazione qui): <code>setup-madmin.sh ... --manager-url ${escapeHtml(info.agent_url || 'https://manager:8443')} --manager-ca-sha256 ${escapeHtml(info.ca_fingerprint || '<fingerprint>')}</code>
                ${info.registration_enabled ? '' : '<span class="text-danger">(registrazione senza token disattivata nelle impostazioni)</span>'}</div>
        </div></div>
        <div class="card">
            <div class="card-header"><ul class="nav nav-tabs card-header-tabs">
                ${tabs.map(([t, label]) => `<li class="nav-item"><a class="nav-link ${t === tab ? 'active' : ''}" href="#enrollment/${t}">${label}</a></li>`).join('')}
            </ul></div>
            <div id="enr-tab">${loadingSpinner()}</div>
        </div>`;
    const el = container.querySelector('#enr-tab');
    try {
        await ({ tokens: renderTokens, requests: renderRequests, apikeys: renderKeys })[tab](el);
    } catch (e) {
        el.innerHTML = `<div class="card-body text-danger">${escapeHtml(e.message)}</div>`;
    }
}

const reload = () => render(containerEl, [tab]);

// --- Tokens ---

async function renderTokens(el) {
    const rows = await apiGet('/enrollment/tokens');
    el.innerHTML = `<div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr><th>Descrizione</th><th>Creato</th><th>Scade</th><th>Usi</th><th>Assegna</th><th>Tipo</th><th>Stato</th><th></th></tr></thead>
        <tbody>${rows.map(t => `<tr>
            <td>${escapeHtml(t.description || t.id)}${t.bind_ip ? `<div class="small text-muted">solo da ${escapeHtml(t.bind_ip)}</div>` : ''}</td>
            <td>${fmtDate(t.created_at)}<div class="small text-muted">${escapeHtml(t.created_by)}</div></td>
            <td>${fmtDate(t.expires_at)}</td>
            <td>${t.uses}${t.max_uses ? ` / ${t.max_uses}` : ' / ∞'}</td>
            <td class="small">${t.name ? `<div>${escapeHtml(t.name)}</div>` : ''}
                ${t.group_id ? `<div>${escapeHtml(groupPath(groups, t.group_id))}</div>` : ''}
                ${t.external_ref ? `<div class="font-monospace">${escapeHtml(t.external_ref)}</div>` : ''}
                ${labelBadges(t.labels)}</td>
            <td>${t.reenroll_instance_id ? `<a href="#instances/${escapeHtml(t.reenroll_instance_id)}">re-enroll</a>` : 'nuova istanza'}</td>
            <td>${t.valid ? '<span class="badge bg-success-lt">valido</span>' : '<span class="badge bg-secondary-lt">non valido</span>'}</td>
            <td class="text-end">${t.valid && manage ? `<button class="btn btn-sm btn-outline-danger" ${actionAttrs('managerTokenRevoke', t.id)}>Revoca</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="text-muted">Nessun token</td></tr>'}
        </tbody></table></div>`;
}

function tokenModal() {
    formModal('Nuovo token di enrollment', `
        ${notice('info', '', [['ti-key', 'Il token si usa una volta sull\'istanza (setup o <code>core.manager enroll</code>) e viene mostrato <b>una sola volta</b>.']])}
        <div class="row g-2">
            ${field('description', 'Descrizione', { maxlength: 200, col: 'col-12', example: 'Nuovo router Rossi S.p.A.' })}
            ${field('hours', 'Validità in ore', { type: 'number', required: true, min: 1, max: 2160, value: 24, col: 'col-md-4', hint: 'max 2160 (90 giorni)' })}
            ${field('max_uses', 'Utilizzi', { type: 'number', min: 1, max: 10000, value: 1, col: 'col-md-4', hint: 'vuoto = illimitati' })}
            ${field('bind_ip', 'Solo dall\'IP', { maxlength: 45, mono: true, col: 'col-md-4', pattern: '^[0-9a-fA-F:.]+$',
                format: 'IPv4 o IPv6', example: '203.0.113.10' })}
        </div>
        ${formSection('Dati dell\'istanza', 'applicati alla registrazione, tutti facoltativi')}
        ${registrationFieldsHtml(groups)}`,
    async (form) => {
        const d = formData(form);
        const res = await apiPost('/enrollment/tokens', {
            ...registrationFieldsValue(form), description: d.description, hours: Number(d.hours),
            max_uses: d.max_uses ? Number(d.max_uses) : null, bind_ip: d.bind_ip || null,
        });
        secretModal('Token di enrollment',
            enrollTokenHelp(res.token, { expiresAt: res.expires_at, maxUses: d.max_uses ? Number(d.max_uses) : null }),
            res.token);
        reload();
    }, { submitText: 'Crea token', icon: 'ti-key', size: 'lg' });
}

// --- Registration requests ---

async function renderRequests(el) {
    requests = await apiGet('/enrollment/requests?status=pending');
    el.innerHTML = `
        <div class="card-body border-bottom text-muted small">Istanze installate con <code>--manager-url</code>: prima di approvare,
            confronta il fingerprint della chiave con quello stampato dal setup dell'istanza (o da <code>python -m core.manager status</code>).</div>
        <div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr><th>Hostname</th><th>IP sorgente</th><th>Versione</th><th>Fingerprint chiave</th><th>CA verificata</th><th>Richiesta</th><th></th></tr></thead>
        <tbody>${requests.map(r => `<tr>
            <td><strong>${escapeHtml(r.hostname || '-')}</strong>
                ${r.matches.length ? `<div class="small text-warning">Stesso machine-id di: ${r.matches.map(m => escapeHtml(m.name)).join(', ')}</div>` : ''}</td>
            <td class="font-monospace">${escapeHtml(r.source_ip)}</td>
            <td>${escapeHtml(r.madmin_version || '-')}</td>
            <td class="font-monospace small">${escapeHtml(r.key_fingerprint.slice(0, 32))}…</td>
            <td>${r.ca_pinned ? '<span class="badge bg-success-lt">sì</span>' : '<span class="badge bg-warning-lt">primo contatto</span>'}</td>
            <td>${fmtDate(r.created_at)}<div class="small text-muted">scade ${fmtDate(r.expires_at)}</div></td>
            <td class="text-end">${manage ? `<div class="btn-list justify-content-end">
                <button class="btn btn-sm btn-primary" ${actionAttrs('managerRequestApprove', r.id)}>Approva</button>
                <button class="btn btn-sm btn-outline-danger" ${actionAttrs('managerRequestReject', r.id)}>Rifiuta</button>
            </div>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="text-muted">Nessuna richiesta in attesa</td></tr>'}
        </tbody></table></div>`;
}

function approveModal(id) {
    const r = requests.find(x => x.id === id);
    if (!r) return;
    const ifaces = (r.interfaces || []).map(n => `${escapeHtml(n.name)}: ${(n.ipv4 || []).map(escapeHtml).join(', ') || '-'}`).join('<br>');
    formModal('Approva registrazione', `
        <dl class="row small mb-3">
            <dt class="col-4">Hostname</dt><dd class="col-8">${escapeHtml(r.hostname || '-')}</dd>
            <dt class="col-4">IP sorgente</dt><dd class="col-8">${escapeHtml(r.source_ip)}</dd>
            <dt class="col-4">Sistema</dt><dd class="col-8">${escapeHtml(r.os || '-')}</dd>
            <dt class="col-4">Machine ID</dt><dd class="col-8 font-monospace">${escapeHtml(r.machine_id || '-')}</dd>
            <dt class="col-4">Interfacce</dt><dd class="col-8">${ifaces || '-'}</dd>
            <dt class="col-4">Fingerprint chiave</dt><dd class="col-8 font-monospace text-break">${escapeHtml(r.key_fingerprint)}</dd>
        </dl>
        ${notice(r.ca_pinned ? 'info' : 'warning', 'Prima di approvare verifica l\'impronta', [
            ['ti-fingerprint', 'Confronta l\'impronta qui sopra con quella stampata dal setup dell\'istanza (o <code>python -m core.manager status</code>).'],
            r.ca_pinned ? null : ['ti-alert-triangle', 'L\'istanza ha accettato la CA del manager <b>al primo contatto</b>: chiedi conferma a chi l\'ha installata.']])}
        ${r.matches.length ? field('reenroll_instance_id', 'Reinstallazione di un\'istanza esistente?', { type: 'select',
            options: [['', 'No, nuova istanza'], ...r.matches.map(m => [m.id, `${m.name} — mantiene identità, backup, licenze`])],
            hint: 'stesso machine-id di un\'istanza già registrata' }) : ''}
        ${formSection('Dati dell\'istanza', 'facoltativi')}
        ${registrationFieldsHtml(groups, { name: r.hostname || '' })}`,
    async (form) => {
        const d = formData(form);
        const res = await apiPost(`/enrollment/requests/${id}/approve`, {
            ...registrationFieldsValue(form), reenroll_instance_id: d.reenroll_instance_id || null,
        });
        showToast(`Approvata: ${res.name} si collegherà entro un minuto`, 'success');
        reload();
    }, { submitText: 'Approva', size: 'lg', tone: 'primary', icon: 'ti-check' });
}

// --- API keys ---

async function renderKeys(el) {
    const rows = await apiGet('/apikeys');
    el.innerHTML = `
        <div class="card-body border-bottom text-muted small">Per il sistema di provisioning (<code>/api/provisioning/*</code>, vedi docs/API.md).
            Non installare mai una chiave su un'istanza.</div>
        <div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr><th>Nome</th><th>ID</th><th>Scope</th><th>Reti ammesse</th><th>Scade</th><th>Ultimo uso</th><th>Stato</th><th></th></tr></thead>
        <tbody>${rows.map(k => `<tr>
            <td>${escapeHtml(k.name)}<div class="small text-muted">${escapeHtml(k.created_by)}</div></td>
            <td class="font-monospace">${escapeHtml(k.id)}</td>
            <td class="small">${k.scopes.map(s => `<span class="badge bg-secondary-lt me-1">${escapeHtml(s)}</span>`).join('')}</td>
            <td class="small font-monospace">${escapeHtml(k.allowed_cidrs || 'tutte')}</td>
            <td>${k.expires_at ? fmtDate(k.expires_at) : 'mai'}</td>
            <td>${fmtDate(k.last_used_at)}<div class="small text-muted">${escapeHtml(k.last_used_ip || '')}</div></td>
            <td>${k.valid ? '<span class="badge bg-success-lt">attiva</span>' : '<span class="badge bg-secondary-lt">non valida</span>'}</td>
            <td class="text-end">${k.valid && manage ? `<button class="btn btn-sm btn-outline-danger" ${actionAttrs('managerKeyRevoke', k.id)}>Revoca</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="text-muted">Nessuna chiave</td></tr>'}
        </tbody></table></div>`;
}

async function keyModal() {
    const scopes = await apiGet('/apikeys/scopes');
    formModal('Nuova chiave API', `
        ${notice('warning', '', [['ti-plug', 'Solo per il sistema di provisioning (<code>/api/provisioning/*</code>): mai su un\'istanza.'],
                                 ['ti-eye-off', 'La chiave viene mostrata <b>una sola volta</b>.']])}
        ${field('name', 'Nome', { required: true, maxlength: 100, example: 'provisioning-fae' })}
        <div class="mb-3"><label class="form-label">Permessi<span class="text-danger ms-1">*</span></label>
            ${scopes.map(s => `<label class="form-check"><input type="checkbox" class="form-check-input" name="scope" value="${escapeHtml(s.scope)}"
                ${s.scope === 'provisioning.enroll' ? 'checked' : ''}><span class="form-check-label"><code>${escapeHtml(s.scope)}</code> <span class="text-muted">— ${escapeHtml(s.description)}</span></span></label>`).join('')}
            <div class="invalid-feedback d-block" data-scope-error></div>
        </div>
        <div class="row g-2">
            ${field('allowed_cidrs', 'Reti ammesse', { mono: true, col: 'col-md-8', format: 'reti CIDR separate da virgola',
                example: '10.0.0.0/8, 192.0.2.10', hint: 'vuoto = tutte' })}
            ${field('days', 'Validità in giorni', { type: 'number', min: 1, max: 3650, value: 365, col: 'col-md-4', hint: 'vuoto = senza scadenza' })}
        </div>`,
    async (form) => {
        const d = formData(form);
        if (!form.querySelector('input[name=scope]:checked')) {
            form.querySelector('[data-scope-error]').textContent = 'Scegli almeno un permesso';
            return false;
        }
        const res = await apiPost('/apikeys', {
            name: d.name, allowed_cidrs: d.allowed_cidrs,
            scopes: [...form.querySelectorAll('input[name=scope]:checked')].map(i => i.value),
            days: d.days ? Number(d.days) : null,
        });
        secretModal('Chiave API', `
            <p class="text-muted mb-3">Mostrata <strong>una sola volta</strong>: salvala subito nel sistema di provisioning.
                Funziona solo sulle API <code>/api/provisioning/*</code>, non nella UI.</p>
            <h4 class="mb-1">Uso</h4>
            <p class="mb-2">In ogni richiesta, come header:</p>
            ${copyBlock(`Authorization: Bearer ${res.key}`)}
            <p class="text-muted small mb-0">Documentazione: <code>docs/API.md</code> nel repository del manager.</p>`,
            res.key);
        reload();
    }, { submitText: 'Crea chiave', size: 'lg', icon: 'ti-api' });
}

registerActions({
    managerTokenNew: tokenModal,
    managerTokenRevoke: async (id) => {
        if (!await confirmAction({ title: 'Revoca token', icon: 'ti-key-off', confirmText: 'Revoca',
            intro: 'Il token non potrà più essere usato; le istanze già registrate con esso non ne risentono.' })) return;
        try { await apiPost(`/enrollment/tokens/${id}/revoke`, {}); reload(); } catch (e) { showToast(e.message, 'error'); }
    },
    managerRequestApprove: approveModal,
    managerRequestReject: async (id) => {
        if (!await confirmAction({ title: 'Rifiuta registrazione', icon: 'ti-x', confirmText: 'Rifiuta',
            intro: 'L\'istanza smette di chiedere la registrazione.',
            items: [['ti-refresh', 'Potrà riprovare solo con un nuovo comando <code>register</code> sull\'istanza.']] })) return;
        try { await apiPost(`/enrollment/requests/${id}/reject`, {}); reload(); } catch (e) { showToast(e.message, 'error'); }
    },
    managerKeyNew: keyModal,
    managerKeyRevoke: async (id) => {
        if (!await confirmAction({ title: 'Revoca chiave API', icon: 'ti-key-off', confirmText: 'Revoca',
            intro: 'Il sistema che la usa non potrà più chiamare il manager. Operazione irreversibile.' })) return;
        try { await apiPost(`/apikeys/${id}/revoke`, {}); reload(); } catch (e) { showToast(e.message, 'error'); }
    },
});
