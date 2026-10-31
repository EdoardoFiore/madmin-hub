/**
 * MADMIN Hub - Enrollment: tokens, registrations waiting for approval,
 * API keys of the provisioning system (superusers).
 */
import { apiGet, apiPost } from '../api.js';
import { escapeHtml, showToast, confirmDialog, actionAttrs, registerActions, loadingSpinner } from '../utils.js';
import { setPageActions, getUser } from '../app.js';
import { fmtDate, formModal, secretModal, formData, groupPath, labelBadges,
         registrationFieldsHtml, registrationFieldsValue } from './hub-common.js';

let containerEl = null;
let groups = [];
let tab = 'tokens';
let requests = [];

const TABS = [['tokens', 'Token'], ['requests', 'In attesa'], ['apikeys', 'Chiavi API']];

export async function render(container, params = []) {
    containerEl = container;
    tab = TABS.some(([t]) => t === params[0]) ? params[0] : 'tokens';
    const superuser = !!getUser()?.is_superuser;
    const tabs = TABS.filter(([t]) => t !== 'apikeys' || superuser);
    if (!tabs.some(([t]) => t === tab)) tab = 'tokens';

    const actions = { tokens: `<button class="btn btn-primary" ${actionAttrs('hubTokenNew')}><i class="ti ti-plus me-1"></i>Nuovo token</button>`,
                      apikeys: `<button class="btn btn-primary" ${actionAttrs('hubKeyNew')}><i class="ti ti-plus me-1"></i>Nuova chiave API</button>` };
    setPageActions(actions[tab] || '');

    const [info, g] = await Promise.all([apiGet('/enrollment/info'), apiGet('/groups').catch(() => [])]);
    groups = g;
    container.innerHTML = `
        ${info.agent_url ? '' : '<div class="alert alert-warning">Impostare l\'URL agent in Impostazioni prima di creare token.</div>'}
        <div class="card mb-3"><div class="card-body small">
            <div>URL agent: <span class="font-monospace">${escapeHtml(info.agent_url || '-')}</span></div>
            <div>Fingerprint CA (sha256): <span class="font-monospace">${escapeHtml(info.ca_fingerprint || '-')}</span></div>
            <div class="text-muted mt-1">Con token: <code>setup-madmin.sh ... --hub-token-file token.txt</code> ·
                Senza token (approvazione qui): <code>setup-madmin.sh ... --hub-url ${escapeHtml(info.agent_url || 'https://hub:8443')} --hub-ca-sha256 ${escapeHtml(info.ca_fingerprint || '<fingerprint>')}</code>
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
            <td class="text-end">${t.valid ? `<button class="btn btn-sm btn-outline-danger" ${actionAttrs('hubTokenRevoke', t.id)}>Revoca</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="text-muted">Nessun token</td></tr>'}
        </tbody></table></div>`;
}

function tokenModal() {
    formModal('Nuovo token di enrollment', `
        <div class="mb-3"><label class="form-label">Descrizione</label><input name="description" class="form-control" maxlength="200"></div>
        <div class="row">
            <div class="col-6 mb-3"><label class="form-label">Validità (ore)</label>
                <input name="hours" type="number" min="1" max="2160" value="24" class="form-control" required></div>
            <div class="col-6 mb-3"><label class="form-label">Utilizzi (vuoto = illimitati)</label>
                <input name="max_uses" type="number" min="1" max="10000" value="1" class="form-control"></div>
        </div>
        <div class="text-muted small mb-2">Campi applicati all'istanza alla registrazione (tutti facoltativi):</div>
        ${registrationFieldsHtml(groups)}
        <div class="mb-3"><label class="form-label">Utilizzabile solo dall'IP (facoltativo)</label>
            <input name="bind_ip" class="form-control" maxlength="45"></div>`,
    async (form) => {
        const d = formData(form);
        const res = await apiPost('/enrollment/tokens', {
            ...registrationFieldsValue(form), description: d.description, hours: Number(d.hours),
            max_uses: d.max_uses ? Number(d.max_uses) : null, bind_ip: d.bind_ip || null,
        });
        secretModal('Token di enrollment',
            'Mostrato una sola volta. Salvalo in un file sull\'istanza e passalo a <code>setup-madmin.sh --hub-token-file</code> (oppure nella variabile MADMIN_HUB_TOKEN).',
            res.token);
        reload();
    }, { submitText: 'Crea' });
}

// --- Registration requests ---

async function renderRequests(el) {
    requests = await apiGet('/enrollment/requests?status=pending');
    el.innerHTML = `
        <div class="card-body border-bottom text-muted small">Istanze installate con <code>--hub-url</code>: prima di approvare,
            confronta il fingerprint della chiave con quello stampato dal setup dell'istanza (o da <code>python -m core.hub status</code>).</div>
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
            <td class="text-end"><div class="btn-list justify-content-end">
                <button class="btn btn-sm btn-primary" ${actionAttrs('hubRequestApprove', r.id)}>Approva</button>
                <button class="btn btn-sm btn-outline-danger" ${actionAttrs('hubRequestReject', r.id)}>Rifiuta</button>
            </div></td>
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
        ${r.ca_pinned ? '' : '<div class="alert alert-warning small">L\'istanza ha accettato la CA della hub al primo contatto: verifica il fingerprint della chiave con chi ha installato l\'istanza.</div>'}
        ${r.matches.length ? `<div class="mb-3"><label class="form-label">Registrare di nuovo un'istanza esistente (reinstallazione)?</label>
            <select name="reenroll_instance_id" class="form-select"><option value="">No, nuova istanza</option>
            ${r.matches.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (mantiene identità, backup, licenze)</option>`).join('')}</select></div>` : ''}
        ${registrationFieldsHtml(groups, { name: r.hostname || '' })}`,
    async (form) => {
        const d = formData(form);
        const res = await apiPost(`/enrollment/requests/${id}/approve`, {
            ...registrationFieldsValue(form), reenroll_instance_id: d.reenroll_instance_id || null,
        });
        showToast(`Approvata: ${res.name} si collegherà entro un minuto`, 'success');
        reload();
    }, { submitText: 'Approva', size: 'lg' });
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
            <td class="text-end">${k.valid ? `<button class="btn btn-sm btn-outline-danger" ${actionAttrs('hubKeyRevoke', k.id)}>Revoca</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="text-muted">Nessuna chiave</td></tr>'}
        </tbody></table></div>`;
}

async function keyModal() {
    const scopes = await apiGet('/apikeys/scopes');
    formModal('Nuova chiave API', `
        <div class="mb-3"><label class="form-label">Nome</label><input name="name" class="form-control" required maxlength="100" placeholder="provisioning-fae"></div>
        <div class="mb-3"><label class="form-label">Scope</label>
            ${scopes.map(s => `<label class="form-check"><input type="checkbox" class="form-check-input" name="scope" value="${escapeHtml(s.scope)}"
                ${s.scope === 'provisioning.enroll' ? 'checked' : ''}><span class="form-check-label"><code>${escapeHtml(s.scope)}</code> — ${escapeHtml(s.description)}</span></label>`).join('')}
        </div>
        <div class="mb-3"><label class="form-label">Reti ammesse (separate da virgola, vuoto = tutte)</label>
            <input name="allowed_cidrs" class="form-control" placeholder="10.0.0.0/8, 192.0.2.10"></div>
        <div class="mb-3"><label class="form-label">Validità (giorni, vuoto = senza scadenza)</label>
            <input name="days" type="number" min="1" max="3650" value="365" class="form-control"></div>`,
    async (form) => {
        const d = formData(form);
        const res = await apiPost('/apikeys', {
            name: d.name, allowed_cidrs: d.allowed_cidrs,
            scopes: [...form.querySelectorAll('input[name=scope]:checked')].map(i => i.value),
            days: d.days ? Number(d.days) : null,
        });
        secretModal('Chiave API', 'Mostrata una sola volta: va nel sistema di provisioning come <code>Authorization: Bearer &lt;chiave&gt;</code>.', res.key);
        reload();
    }, { submitText: 'Crea', size: 'lg' });
}

registerActions({
    hubTokenNew: tokenModal,
    hubTokenRevoke: async (id) => {
        if (!await confirmDialog('Revoca token', 'Il token non potrà più essere usato.', 'Revoca')) return;
        try { await apiPost(`/enrollment/tokens/${id}/revoke`, {}); reload(); } catch (e) { showToast(e.message, 'error'); }
    },
    hubRequestApprove: approveModal,
    hubRequestReject: async (id) => {
        if (!await confirmDialog('Rifiuta registrazione', 'L\'istanza smette di chiedere la registrazione; potrà riprovare solo con un nuovo comando register.', 'Rifiuta')) return;
        try { await apiPost(`/enrollment/requests/${id}/reject`, {}); reload(); } catch (e) { showToast(e.message, 'error'); }
    },
    hubKeyNew: keyModal,
    hubKeyRevoke: async (id) => {
        if (!await confirmDialog('Revoca chiave API', 'Il sistema che la usa non potrà più chiamare la hub.', 'Revoca')) return;
        try { await apiPost(`/apikeys/${id}/revoke`, {}); reload(); } catch (e) { showToast(e.message, 'error'); }
    },
});
