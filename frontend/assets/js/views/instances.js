/**
 * MADMIN Hub - Instances: list (#instances) and detail (#instances/<id>/<tab>).
 */
import { apiGet, apiPost, apiPatch, apiDelete, getToken } from '../api.js';
import { escapeHtml, showToast, confirmDialog, loadingSpinner, formatBytes,
         actionAttrs, registerActions } from '../utils.js';
import { checkPermission, setPageActions } from '../app.js';
import { fmtDate, relTime, onlineBadge, commandStatusBadge, formModal, secretModal,
         formData, groupOptions, groupPath, labelBadges, labelsToText, textToLabels } from './hub-common.js';

const TABS = [
    ['overview', 'Panoramica', 'instances.view'],
    ['addresses', 'Indirizzi', 'instances.view'],
    ['backups', 'Backup', 'backups.view'],
    ['licenses', 'Licenze', 'licenses.view'],
    ['support', 'Supporto', 'support.access'],
    ['commands', 'Comandi', 'instances.view'],
];

let groups = [];
let current = null;   // instance shown in the detail
let containerEl = null;

export async function render(container, params = []) {
    containerEl = container;
    groups = await apiGet('/groups').catch(() => []);
    if (params[0]) {
        await renderDetail(container, params[0], params[1] || 'overview');
    } else {
        await renderList(container);
    }
}

// ============== LIST ==============

async function renderList(container) {
    if (checkPermission('instances.manage')) {
        setPageActions(`<button class="btn btn-outline-primary" ${actionAttrs('hubGroups')}>
            <i class="ti ti-folders me-1"></i>Gruppi</button>`);
    }
    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <div class="row g-2 w-100">
                    <div class="col-md-5"><input id="inst-q" class="form-control" placeholder="Cerca nome, hostname, IP, ID, riferimento, etichetta"></div>
                    <div class="col-md-3">
                        <select id="inst-status" class="form-select">
                            <option value="">Tutti gli stati</option>
                            <option value="active" selected>Attive</option>
                            <option value="revoked">Revocate</option>
                            <option value="decommissioned">Dismesse</option>
                        </select>
                    </div>
                    <div class="col-md-4">
                        <select id="inst-group" class="form-select">
                            <option value="">Tutti i gruppi</option>
                            <option value="none">Senza gruppo (sito principale)</option>
                            ${groupOptions(groups, '', { none: null })}
                        </select>
                    </div>
                </div>
            </div>
            <div id="inst-table">${loadingSpinner()}</div>
        </div>`;
    const reload = () => loadList().catch(e => showToast(e.message, 'error'));
    let debounce;
    container.querySelector('#inst-q').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(reload, 300); });
    container.querySelector('#inst-status').addEventListener('change', reload);
    container.querySelector('#inst-group').addEventListener('change', reload);
    await reload();
}

async function loadList() {
    const p = new URLSearchParams();
    const q = containerEl.querySelector('#inst-q').value.trim();
    const status = containerEl.querySelector('#inst-status').value;
    const group = containerEl.querySelector('#inst-group').value;
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    if (group) p.set('group_id', group);
    const rows = await apiGet(`/instances?${p}`);
    const groupName = id => groupPath(groups, id);
    containerEl.querySelector('#inst-table').innerHTML = rows.length ? `
        <div class="table-responsive">
            <table class="table card-table table-vcenter table-hover">
                <thead><tr><th>Nome</th><th>Stato</th><th>Hostname</th><th>IP sorgente</th>
                    <th>Versione</th><th>Gruppo</th><th>Ultimo contatto</th></tr></thead>
                <tbody>${rows.map(i => `
                    <tr class="cursor-pointer" ${actionAttrs('hubOpenInstance', i.id)}>
                        <td><strong>${escapeHtml(i.name)}</strong>
                            ${i.external_ref ? `<div class="small text-muted font-monospace">${escapeHtml(i.external_ref)}</div>` : ''}
                            <div>${labelBadges(i.labels)}</div></td>
                        <td>${onlineBadge(i)}</td>
                        <td>${escapeHtml(i.hostname || '-')}</td>
                        <td>${escapeHtml(i.last_ip || '-')}</td>
                        <td>${escapeHtml(i.madmin_version || '-')}</td>
                        <td>${escapeHtml(groupName(i.group_id))}</td>
                        <td>${i.online ? 'ora' : relTime(i.last_seen_at)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>` : '<div class="card-body text-muted">Nessuna istanza. Crea un token in Enrollment e installa MADMIN con --hub-token-file.</div>';
}

function groupsModal() {
    const kindLabel = k => k === 'partner' ? '<span class="badge bg-purple-lt">partner</span>' : '<span class="badge bg-blue-lt">cliente</span>';
    const list = () => groups.map(g => `
        <tr><td>${g.parent_id ? '<span class="text-muted ms-3">└</span> ' : ''}${escapeHtml(g.name)} ${kindLabel(g.kind)}</td>
        <td class="text-muted">${escapeHtml(g.description)}</td><td>${g.instances}</td>
        <td class="text-end"><button type="button" class="btn btn-sm btn-ghost-danger" data-del="${escapeHtml(g.id)}">
        <i class="ti ti-trash"></i></button></td></tr>`).join('') || '<tr><td class="text-muted">Nessun gruppo</td></tr>';
    const parentSelect = () => groupOptions(groups, '', { none: 'Sito principale (primo livello)', partnersOnly: true });
    const el = formModal('Partner e clienti', `
        <p class="text-muted small">Il sito principale vede tutto. Sotto ci sono clienti diretti, oppure partner con i propri clienti.</p>
        <table class="table table-sm"><thead><tr><th>Gruppo</th><th>Descrizione</th><th>Istanze</th><th></th></tr></thead>
            <tbody id="grp-list">${list()}</tbody></table>
        <div class="row g-2">
            <div class="col-md-4"><input name="name" class="form-control" placeholder="Nome" required maxlength="100"></div>
            <div class="col-md-3"><select name="kind" class="form-select"><option value="customer">Cliente</option><option value="partner">Partner</option></select></div>
            <div class="col-md-5"><select name="parent_id" class="form-select" id="grp-parent">${parentSelect()}</select></div>
            <div class="col-12"><input name="description" class="form-control" placeholder="Descrizione" maxlength="500"></div>
        </div>`, async (form) => {
        const d = formData(form);
        if (!d.name) throw new Error('Nome obbligatorio');
        if (d.kind === 'partner' && d.parent_id) throw new Error('Un partner sta solo al primo livello');
        await apiPost('/groups', { name: d.name, kind: d.kind, parent_id: d.parent_id || null, description: d.description });
        groups = await apiGet('/groups');
        form.reset();
        el.querySelector('#grp-list').innerHTML = list();
        el.querySelector('#grp-parent').innerHTML = parentSelect();
        return false;
    }, { submitText: 'Aggiungi', size: 'lg' });
    el.addEventListener('click', async (e) => {
        const id = e.target.closest('[data-del]')?.dataset.del;
        if (!id) return;
        try {
            await apiDelete(`/groups/${id}`);
            groups = await apiGet('/groups');
            el.querySelector('#grp-list').innerHTML = list();
            el.querySelector('#grp-parent').innerHTML = parentSelect();
        } catch (err) { showToast(err.message, 'error'); }
    });
}

// ============== DETAIL ==============

async function renderDetail(container, id, tab) {
    current = await apiGet(`/instances/${encodeURIComponent(id)}`);
    const i = current;
    const tabs = TABS.filter(([, , perm]) => checkPermission(perm));
    if (!tabs.some(([t]) => t === tab)) tab = 'overview';

    const actions = [];
    if (i.online) actions.push(`<button class="btn btn-outline-secondary" ${actionAttrs('hubRefresh')}><i class="ti ti-refresh me-1"></i>Aggiorna dati</button>`);
    if (checkPermission('instances.manage')) actions.push(`<button class="btn btn-outline-primary" ${actionAttrs('hubEdit')}><i class="ti ti-edit me-1"></i>Modifica</button>`);
    if (checkPermission('enrollment.manage') && i.status !== 'revoked') actions.push(`<button class="btn btn-outline-primary" ${actionAttrs('hubReenroll')}><i class="ti ti-key me-1"></i>Token re-enroll</button>`);
    if (checkPermission('instances.manage') && i.status === 'active') actions.push(`<button class="btn btn-outline-danger" ${actionAttrs('hubRevoke')}><i class="ti ti-ban me-1"></i>Revoca</button>`);
    if (checkPermission('instances.manage') && i.status !== 'active') actions.push(`<button class="btn btn-danger" ${actionAttrs('hubDelete')}><i class="ti ti-trash me-1"></i>Elimina</button>`);
    setPageActions(`<div class="btn-list">${actions.join('')}</div>`);

    container.innerHTML = `
        <div class="mb-3">
            <a href="#instances" class="text-muted"><i class="ti ti-arrow-left"></i> Istanze</a>
            <h2 class="mt-1 mb-0">${escapeHtml(i.name)} ${onlineBadge(i)}</h2>
            <div class="text-muted small font-monospace">${escapeHtml(i.id)}</div>
            <div class="mt-1">${i.group_id ? `<span class="badge bg-blue-lt me-1">${escapeHtml(groupPath(groups, i.group_id))}</span>` : ''}${labelBadges(i.labels)}</div>
        </div>
        ${i.clone_suspects?.length ? `<div class="alert alert-warning">Stesso machine-id di:
            ${i.clone_suspects.map(c => `<a href="#instances/${escapeHtml(c.id)}">${escapeHtml(c.name)}</a>`).join(', ')}
            — probabile VM clonata: le due istanze vanno registrate separatamente.</div>` : ''}
        <div class="card">
            <div class="card-header">
                <ul class="nav nav-tabs card-header-tabs">
                    ${tabs.map(([t, label]) => `<li class="nav-item"><a class="nav-link ${t === tab ? 'active' : ''}"
                        href="#instances/${escapeHtml(i.id)}/${t}">${label}</a></li>`).join('')}
                </ul>
            </div>
            <div id="inst-tab">${loadingSpinner()}</div>
        </div>`;
    const el = container.querySelector('#inst-tab');
    const renderers = { overview, addresses, backups, licenses, support, commands };
    try {
        await renderers[tab](el, i);
    } catch (e) {
        el.innerHTML = `<div class="card-body text-danger">${escapeHtml(e.message)}</div>`;
    }
}

function kv(rows) {
    return `<dl class="row mb-0">${rows.map(([k, v]) =>
        `<dt class="col-5 col-md-4">${k}</dt><dd class="col-7 col-md-8">${v}</dd>`).join('')}</dl>`;
}

async function overview(el, i) {
    const f = i.facts || {};
    const st = i.stats || {};
    const modules = (f.modules || []).map(m => `<tr><td>${escapeHtml(m.id)}</td><td>${escapeHtml(m.version)}</td>
        <td>${m.enabled ? '<span class="badge bg-success-lt">attivo</span>' : '<span class="badge bg-secondary-lt">disattivo</span>'}</td></tr>`).join('')
        || '<tr><td colspan="3" class="text-muted">Nessun modulo attivo</td></tr>';
    const ifaces = (f.interfaces || []).map(n => `<tr><td>${escapeHtml(n.name)}</td>
        <td>${(n.ipv4 || []).map(escapeHtml).join('<br>') || '-'}</td><td>${escapeHtml(n.mac || '-')}</td>
        <td>${n.is_up ? 'up' : 'down'}</td></tr>`).join('');
    el.innerHTML = `
        <div class="card-body">
            <div class="row g-4">
                <div class="col-lg-6">${kv([
                    ['Hostname', escapeHtml(f.hostname || i.hostname || '-')],
                    ['Versione MADMIN', escapeHtml(i.madmin_version || '-')],
                    ['Sistema', escapeHtml(`${f.os || '-'} (kernel ${f.kernel || '?'})`)],
                    ['Machine ID', `<span class="font-monospace small">${escapeHtml(f.machine_id || '-')}</span>`],
                    ['Avvio', fmtDate(f.boot_time)],
                    ['Porte SSH', escapeHtml((f.ssh_ports || []).join(', ') || '-')],
                ])}</div>
                <div class="col-lg-6">${kv([
                    ['IP sorgente', escapeHtml(i.last_ip || '-')],
                    ['Connessa da', i.online ? fmtDate(i.connected_at) : '-'],
                    ['Ultimo contatto', `${fmtDate(i.last_seen_at)} (${relTime(i.last_seen_at)})`],
                    ['Registrata', fmtDate(i.enrolled_at)],
                    ['Certificato fino al', fmtDate(i.certificate_expires_at)],
                    ['CPU / RAM / disco', st.cpu_percent !== undefined ? `${st.cpu_percent}% / ${st.mem_percent}% / ${st.disk_percent}%` : '-'],
                    ['Gruppo', escapeHtml(groupPath(groups, i.group_id) || 'sito principale')],
                    ['Riferimento esterno', `<span class="font-monospace">${escapeHtml(i.external_ref || '-')}</span>`],
                    ['Backup pianificati', i.backup_enabled ? 'sì' : 'no'],
                    ['Descrizione', escapeHtml(i.description || '-')],
                ])}</div>
            </div>
        </div>
        <div class="row g-0 border-top">
            <div class="col-lg-5 border-end">
                <div class="card-body pb-0"><h4>Moduli</h4></div>
                <table class="table card-table"><thead><tr><th>Modulo</th><th>Versione</th><th></th></tr></thead><tbody>${modules}</tbody></table>
            </div>
            <div class="col-lg-7">
                <div class="card-body pb-0"><h4>Interfacce</h4></div>
                <div class="table-responsive"><table class="table card-table"><thead><tr><th>Nome</th><th>IPv4</th><th>MAC</th><th></th></tr></thead><tbody>${ifaces}</tbody></table></div>
            </div>
        </div>`;
}

async function addresses(el, i) {
    const rows = await apiGet(`/instances/${i.id}/addresses`);
    el.innerHTML = `<div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr><th>Indirizzo</th><th>Tipo</th><th>Interfaccia</th><th>Prima volta</th><th>Ultima volta</th><th></th></tr></thead>
        <tbody>${rows.map(a => `<tr class="${a.current ? '' : 'text-muted'}">
            <td class="font-monospace">${escapeHtml(a.address)}</td>
            <td>${a.kind === 'source' ? 'Sorgente connessione' : 'Interfaccia'}</td>
            <td>${escapeHtml(a.interface || '-')}</td>
            <td>${fmtDate(a.first_seen)}</td><td>${fmtDate(a.last_seen)}</td>
            <td>${a.current ? '<span class="badge bg-success-lt">attuale</span>' : ''}</td></tr>`).join('')}
        </tbody></table></div>`;
}

async function backups(el, i) {
    const rows = await apiGet(`/instances/${i.id}/backups`);
    const manage = checkPermission('backups.manage');
    const canRestore = checkPermission('backups.restore') && i.status === 'active';
    el.innerHTML = `
        ${manage && i.status === 'active' ? `<div class="card-body border-bottom">
            <button class="btn btn-primary" ${actionAttrs('hubBackupRun')}><i class="ti ti-database-export me-1"></i>Esegui backup ora</button>
            <span class="text-muted ms-2 small">${i.online ? '' : "L'istanza è offline: il backup partirà alla riconnessione (entro 1 ora)."}</span>
        </div>` : ''}
        <div class="table-responsive"><table class="table card-table table-vcenter">
            <thead><tr><th>Data</th><th>Dimensione</th><th>Versione</th><th>Origine</th><th></th></tr></thead>
            <tbody>${rows.map(b => `<tr>
                <td>${fmtDate(b.created_at)}</td><td>${formatBytes(b.size)}</td>
                <td>${escapeHtml(b.madmin_version || '-')}</td>
                <td>${b.trigger === 'scheduled' ? 'Pianificato' : escapeHtml(b.created_by || 'manuale')}</td>
                <td class="text-end"><div class="btn-list justify-content-end">
                    ${manage ? `<button class="btn btn-sm btn-outline-secondary" ${actionAttrs('hubBackupDownload', b.id)}><i class="ti ti-download"></i></button>` : ''}
                    ${canRestore ? `<button class="btn btn-sm btn-outline-warning" ${actionAttrs('hubBackupRestore', b.id, b.created_at)}>Ripristina</button>` : ''}
                    ${manage ? `<button class="btn btn-sm btn-ghost-danger" ${actionAttrs('hubBackupDelete', b.id)}><i class="ti ti-trash"></i></button>` : ''}
                </div></td></tr>`).join('') || '<tr><td colspan="5" class="text-muted">Nessun backup</td></tr>'}
            </tbody></table></div>`;
}

async function licenses(el, i) {
    const rows = await apiGet(`/licenses?instance_id=${i.id}`);
    const manage = checkPermission('licenses.manage') && i.status === 'active';
    el.innerHTML = `
        ${manage ? `<div class="card-body border-bottom"><button class="btn btn-primary" ${actionAttrs('hubLicenseNew')}>
            <i class="ti ti-certificate me-1"></i>Emetti licenza</button></div>` : ''}
        ${licenseTable(rows, manage)}`;
}

export function licenseTable(rows, manage, showInstance = false) {
    return `<div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr>${showInstance ? '<th>Istanza</th>' : ''}<th>Feature</th><th>Stato</th><th>Valida fino a</th>
            <th>Token attuale fino a</th><th>Note</th><th></th></tr></thead>
        <tbody>${rows.map(l => `<tr>
            ${showInstance ? `<td><a href="#instances/${escapeHtml(l.instance_id)}/licenses">${escapeHtml(l.instance_name)}</a></td>` : ''}
            <td class="font-monospace">${escapeHtml(l.feature)}</td>
            <td>${l.active ? '<span class="badge bg-success-lt">attiva</span>' : '<span class="badge bg-secondary-lt">revocata/scaduta</span>'}</td>
            <td>${l.valid_until ? fmtDate(l.valid_until) : 'fino a revoca'}</td>
            <td>${fmtDate(l.token_expires_at)}</td>
            <td class="text-muted">${escapeHtml(l.notes)}</td>
            <td class="text-end">${manage && l.active ? `<button class="btn btn-sm btn-outline-danger" ${actionAttrs('hubLicenseRevoke', l.id)}>Revoca</button>` : ''}</td>
        </tr>`).join('') || `<tr><td colspan="${showInstance ? 7 : 6}" class="text-muted">Nessuna licenza</td></tr>`}
        </tbody></table></div>`;
}

async function support(el, i) {
    const rows = await apiGet(`/instances/${i.id}/support`);
    const can = i.status === 'active' && i.online;
    el.innerHTML = `
        <div class="card-body border-bottom">
            <div class="btn-list">
                <button class="btn btn-primary" ${can ? '' : 'disabled'} ${actionAttrs('hubSupportUi')}><i class="ti ti-browser me-1"></i>Accesso UI superuser</button>
                <button class="btn btn-primary" ${can ? '' : 'disabled'} ${actionAttrs('hubSupportSsh')}><i class="ti ti-terminal-2 me-1"></i>Accesso SSH root</button>
            </div>
            ${can ? '' : '<div class="text-muted small mt-2">L\'istanza deve essere online.</div>'}
            <div class="text-muted small mt-2">Ogni accesso è temporaneo, raggiungibile solo dal tuo IP e registrato nell'audit log dell'istanza come hub:&lt;operatore&gt;.</div>
        </div>
        ${sessionTable(rows)}`;
}

export function sessionTable(rows, showInstance = false) {
    return `<div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr>${showInstance ? '<th>Istanza</th>' : ''}<th>Tipo</th><th>Operatore</th><th>Motivo</th><th>Porta</th>
            <th>IP ammesso</th><th>Scade</th><th>Stato</th><th></th></tr></thead>
        <tbody>${rows.map(s => `<tr>
            ${showInstance ? `<td><a href="#instances/${escapeHtml(s.instance_id)}/support">${escapeHtml(s.instance_name)}</a></td>` : ''}
            <td>${s.kind === 'ui' ? 'UI' : 'SSH'}</td><td>${escapeHtml(s.operator)}</td>
            <td class="text-muted">${escapeHtml(s.reason)}</td><td>${s.port}</td>
            <td class="font-monospace">${escapeHtml(s.allowed_ip)}</td><td>${fmtDate(s.expires_at)}</td>
            <td>${s.status === 'open' ? '<span class="badge bg-warning-lt">aperta</span>' : `<span class="badge bg-secondary-lt">${escapeHtml(s.status)}</span>`}</td>
            <td class="text-end"><div class="btn-list justify-content-end">${s.status === 'open' ? `
                ${s.kind === 'ui' ? `<button class="btn btn-sm btn-outline-primary" ${actionAttrs('hubSupportTicket', s.id)}>Nuovo link</button>` : ''}
                <button class="btn btn-sm btn-outline-danger" ${actionAttrs('hubSupportClose', s.id)}>Chiudi</button>` : ''}</div></td>
        </tr>`).join('') || `<tr><td colspan="${showInstance ? 9 : 8}" class="text-muted">Nessuna sessione</td></tr>`}
        </tbody></table></div>`;
}

async function commands(el, i) {
    const rows = await apiGet(`/instances/${i.id}/commands?limit=100`);
    el.innerHTML = `<div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr><th>Creato</th><th>Comando</th><th>Operatore</th><th>Stato</th><th>Esito</th></tr></thead>
        <tbody>${rows.map(c => `<tr>
            <td>${fmtDate(c.created_at)}</td><td class="font-monospace">${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.operator)}</td><td>${commandStatusBadge(c.status)}</td>
            <td class="small text-muted">${escapeHtml(c.error || (c.result ? JSON.stringify(c.result).slice(0, 200) : ''))}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="text-muted">Nessun comando</td></tr>'}
        </tbody></table></div>`;
}

const reloadDetail = (tab) => renderDetail(containerEl, current.id, tab);

function minutesField(def = 60) {
    return `<div class="mb-3"><label class="form-label">Durata (minuti)</label>
        <input name="minutes" type="number" class="form-control" min="5" max="480" value="${def}" required></div>`;
}

const reasonField = `<div class="mb-3"><label class="form-label">Motivo (ticket, richiesta)</label>
    <input name="reason" class="form-control" minlength="3" maxlength="500" required></div>`;
const ipField = `<div class="mb-3"><label class="form-label">IP ammesso (vuoto = il tuo IP attuale)</label>
    <input name="allowed_ip" class="form-control" maxlength="45"></div>`;

export function licenseModal(instanceId, onDone) {
    formModal('Emetti licenza', `
        ${instanceId ? '' : '<div class="mb-3"><label class="form-label">ID istanza</label><input name="instance_id" class="form-control" required></div>'}
        <div class="mb-3"><label class="form-label">Feature (come nel manifest del modulo, es. funkube)</label>
            <input name="feature" class="form-control" pattern="[a-z0-9_.\\-]{1,50}" required></div>
        <div class="mb-3"><label class="form-label">Valida fino al (vuoto = fino a revoca)</label>
            <input name="valid_until" type="date" class="form-control"></div>
        <div class="mb-3"><label class="form-label">Note</label><input name="notes" class="form-control" maxlength="500"></div>`,
    async (form) => {
        const d = formData(form);
        await apiPost('/licenses', {
            instance_id: instanceId || d.instance_id, feature: d.feature, notes: d.notes,
            valid_until: d.valid_until ? `${d.valid_until}T23:59:59` : null,
        });
        showToast('Licenza emessa: verrà installata sull\'istanza', 'success');
        onDone();
    }, { submitText: 'Emetti' });
}

export function uiLinkModal(res) {
    secretModal('Accesso UI di supporto',
        `Apri il link entro ${Math.round((res.ticket_ttl || 120) / 60)} minuti: vale una sola volta. Il browser segnalerà il certificato dell'istanza (autofirmato).`,
        res.url,
        `<a class="btn btn-primary mt-2 ms-2" href="${escapeHtml(res.url)}" target="_blank" rel="noopener noreferrer">Apri</a>`);
}

registerActions({
    hubOpenInstance: (id) => { location.hash = `#instances/${id}`; },
    hubGroups: groupsModal,
    hubRefresh: async () => {
        try { await apiPost(`/instances/${current.id}/refresh`, {}); showToast('Dati aggiornati', 'success'); reloadDetail('overview'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    hubEdit: () => {
        const i = current;
        formModal('Modifica istanza', `
            <div class="mb-3"><label class="form-label">Nome</label><input name="name" class="form-control" value="${escapeHtml(i.name)}" required maxlength="100"></div>
            <div class="mb-3"><label class="form-label">Descrizione</label><input name="description" class="form-control" value="${escapeHtml(i.description)}" maxlength="500"></div>
            <div class="mb-3"><label class="form-label">Gruppo</label><select name="group_id" class="form-select">
                ${groupOptions(groups, i.group_id || '', { none: 'Nessuno (sito principale)' })}
            </select></div>
            <div class="mb-3"><label class="form-label">Etichette (una per riga, chiave=valore)</label>
                <textarea name="labels" class="form-control font-monospace" rows="3">${escapeHtml(labelsToText(i.labels))}</textarea></div>
            <div class="mb-3"><label class="form-label">Riferimento esterno</label>
                <input name="external_ref" class="form-control" maxlength="100" value="${escapeHtml(i.external_ref || '')}"></div>
            <label class="form-check"><input type="checkbox" name="backup_enabled" class="form-check-input" ${i.backup_enabled ? 'checked' : ''}>
                <span class="form-check-label">Backup pianificati</span></label>`,
        async (form) => {
            const d = formData(form);
            await apiPatch(`/instances/${i.id}`, { name: d.name, description: d.description, group_id: d.group_id,
                                                  backup_enabled: form.backup_enabled.checked,
                                                  labels: textToLabels(d.labels), external_ref: d.external_ref });
            reloadDetail('overview');
        });
    },
    hubReenroll: async () => {
        if (!await confirmDialog('Token re-enroll', 'Il token (monouso, 72 ore) registra di nuovo questa istanza mantenendo la stessa identità, backup e licenze: da usare con setup-madmin.sh --hub-token-file dopo una reinstallazione. Il certificato attuale viene revocato al suo utilizzo.', 'Genera', 'btn-primary')) return;
        try {
            const { token } = await apiPost(`/enrollment/instances/${current.id}/reenroll`, {});
            secretModal('Token re-enroll', 'Mostrato una sola volta.', token);
        } catch (e) { showToast(e.message, 'error'); }
    },
    hubRevoke: async () => {
        if (!await confirmDialog('Revoca istanza', `L'istanza ${current.name} viene disconnessa e il suo certificato revocato: non potrà riconnettersi senza un nuovo enrollment. Le sessioni di supporto aperte vengono chiuse.`, 'Revoca')) return;
        try { await apiPost(`/instances/${current.id}/revoke`, {}); reloadDetail('overview'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    hubDelete: async () => {
        if (!await confirmDialog('Elimina istanza', `Eliminare ${current.name} con backup, licenze e storico? Operazione irreversibile.`, 'Elimina')) return;
        try { await apiDelete(`/instances/${current.id}`); location.hash = '#instances'; }
        catch (e) { showToast(e.message, 'error'); }
    },
    hubBackupRun: async () => {
        try { await apiPost(`/instances/${current.id}/backups`, {}); showToast('Backup richiesto: compare qui al termine', 'success'); setTimeout(() => reloadDetail('backups'), 5000); }
        catch (e) { showToast(e.message, 'error'); }
    },
    hubBackupDownload: async (id) => {
        try {
            const r = await fetch(`/api/backups/${id}/download`, { headers: { Authorization: `Bearer ${getToken()}` } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const url = URL.createObjectURL(await r.blob());
            const a = Object.assign(document.createElement('a'), { href: url, download: `${current.name}-${id.slice(0, 8)}.tar.gz.enc` });
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) { showToast(e.message, 'error'); }
    },
    hubBackupDelete: async (id) => {
        if (!await confirmDialog('Elimina backup', 'Eliminare questo backup?', 'Elimina')) return;
        try { await apiDelete(`/backups/${id}`); reloadDetail('backups'); } catch (e) { showToast(e.message, 'error'); }
    },
    hubBackupRestore: (id, created) => {
        formModal('Ripristina configurazione', `
            <div class="alert alert-danger">Il ripristino sovrascrive tutta la configurazione di <strong>${escapeHtml(current.name)}</strong>
                (utenti compresi) con il backup del ${fmtDate(created)}, poi riavvia MADMIN.</div>
            ${reasonField}
            <div class="mb-3"><label class="form-label">Scrivi il nome dell'istanza per confermare</label>
                <input name="confirm_name" class="form-control" required></div>`,
        async (form) => {
            const d = formData(form);
            await apiPost(`/backups/${id}/restore`, d);
            showToast('Ripristino avviato: esito nella scheda Comandi', 'success');
            reloadDetail('commands');
        }, { submitText: 'Ripristina', submitClass: 'btn-danger' });
    },
    hubLicenseNew: () => licenseModal(current.id, () => reloadDetail('licenses')),
    hubLicenseRevoke: async (id) => {
        if (!await confirmDialog('Revoca licenza', 'Il modulo non sarà più attivabile e, al prossimo riavvio dell\'istanza, non verrà caricato (i suoi dati restano).', 'Revoca')) return;
        try { await apiPost(`/licenses/${id}/revoke`, {}); location.hash.startsWith('#licenses') ? location.reload() : reloadDetail('licenses'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    hubSupportUi: () => {
        formModal('Accesso UI superuser temporaneo', `${minutesField()}${reasonField}${ipField}`, async (form) => {
            const d = formData(form);
            const res = await apiPost(`/instances/${current.id}/support/ui`, {
                minutes: Number(d.minutes), reason: d.reason, allowed_ip: d.allowed_ip || null });
            uiLinkModal(res);
            reloadDetail('support');
        }, { submitText: 'Apri sessione' });
    },
    hubSupportSsh: () => {
        formModal('Accesso SSH root temporaneo', `${minutesField()}${reasonField}${ipField}
            <div class="mb-3"><label class="form-label">La tua chiave pubblica SSH (ed25519 consigliata)</label>
                <textarea name="public_key" class="form-control font-monospace" rows="3" required placeholder="ssh-ed25519 AAAA..."></textarea></div>`,
        async (form) => {
            const d = formData(form);
            const res = await apiPost(`/instances/${current.id}/support/ssh`, {
                minutes: Number(d.minutes), reason: d.reason, allowed_ip: d.allowed_ip || null, public_key: d.public_key });
            const file = `madmin-${current.id.slice(0, 8)}-cert.pub`;
            secretModal('Certificato SSH di supporto',
                `Salva il certificato come <code>${escapeHtml(file)}</code> accanto alla tua chiave privata, poi connettiti con:<br>
                 <code>${escapeHtml(res.command)}</code><br>Valido solo fino alla scadenza della sessione e solo attraverso il tunnel.`,
                res.certificate);
            reloadDetail('support');
        }, { submitText: 'Apri sessione', size: 'lg' });
    },
    hubSupportTicket: async (id) => {
        try { uiLinkModal(await apiPost(`/support/${id}/ticket`, {})); } catch (e) { showToast(e.message, 'error'); }
    },
    hubSupportClose: async (id) => {
        try {
            await apiPost(`/support/${id}/close`, {});
            location.hash.startsWith('#support') ? location.reload() : reloadDetail('support');
        } catch (e) { showToast(e.message, 'error'); }
    },
});
