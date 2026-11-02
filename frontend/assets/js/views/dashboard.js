/**
 * MADMIN Hub - Dashboard: state of the fleet in the user's scope.
 *
 * Online state, versions, resources and groups come from /instances and
 * /groups (the same data as the instance tree); backups, licenses,
 * certificates, commands, support and enrollment from /dashboard.
 */
import { apiGet } from '../api.js';
import { escapeHtml, formatBytes } from '../utils.js';
import { fmtDate, relTime, commandStatusBadge, cmpVersion, meter } from './hub-common.js';

const LIST = 8;            // rows per card before "e altre N"
const RECENT_DAYS = 7;     // "registrate di recente"

let timer = null;

function stat(label, value, { cls = '', sub = '', href = '', icon = '' } = {}) {
    const body = `
        <div class="card card-sm h-100"><div class="card-body">
            <div class="subheader">${icon ? `<i class="ti ${icon} me-1"></i>` : ''}${label}</div>
            <div class="h1 mb-0 ${cls}">${value}</div>
            ${sub ? `<div class="small text-muted text-truncate">${sub}</div>` : ''}
        </div></div>`;
    return href ? `<a class="text-reset text-decoration-none d-block h-100" href="${href}">${body}</a>` : body;
}

function card(title, body, { actions = '', footer = '' } = {}) {
    return `
        <div class="card">
            <div class="card-header"><h3 class="card-title">${title}</h3>
                ${actions ? `<div class="card-actions">${actions}</div>` : ''}</div>
            ${body}
            ${footer ? `<div class="card-footer text-muted small">${footer}</div>` : ''}
        </div>`;
}

const empty = (text, ok = true) => `<div class="card-body text-muted">
    ${ok ? '<i class="ti ti-circle-check text-success me-1"></i>' : ''}${text}</div>`;
const more = (total, shown) => total > shown ? `e altre ${total - shown}` : '';
const instLink = (id, name, tab = '') =>
    `<a href="#instances/${escapeHtml(id)}${tab ? `/${tab}` : ''}">${escapeHtml(name)}</a>`;
const countBadge = (n, cls) => n ? `<span class="badge ${cls}">${n}</span>` : '';

/** Days from now until `value` (negative = past). */
function daysTo(value) {
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z');
    return Math.round((d.getTime() - Date.now()) / 86400000);
}

async function load(container) {
    const [d, list, groups] = await Promise.all([
        apiGet('/dashboard'), apiGet('/instances'), apiGet('/groups').catch(() => []),
    ]);
    const hub = d.open_support_sessions !== undefined;   // superusers only
    const active = list.filter(i => i.status === 'active');
    const online = active.filter(i => i.online);
    const offline = active.filter(i => !i.online)
        .sort((a, b) => (a.last_seen_at || '').localeCompare(b.last_seen_at || ''));   // longest first
    let latest = null;
    for (const i of active) if (i.madmin_version && (!latest || cmpVersion(i.madmin_version, latest) > 0)) latest = i.madmin_version;
    const outdated = active.filter(i => latest && i.madmin_version && cmpVersion(i.madmin_version, latest) < 0);
    const recent = list.filter(i => i.enrolled_at && daysTo(i.enrolled_at) > -RECENT_DAYS)
        .sort((a, b) => b.enrolled_at.localeCompare(a.enrolled_at));

    // --- Figures ---
    const pct = n => active.length ? `${Math.round(n * 100 / active.length)}% delle attive` : '';
    const stats = [
        stat('Istanze attive', active.length, { icon: 'ti-server-2', href: '#instances',
            sub: list.length > active.length ? `${list.length - active.length} revocate o dismesse` : '' }),
        stat('Online', online.length, { cls: 'text-success', icon: 'ti-plug-connected', sub: pct(online.length) }),
        stat('Offline', offline.length, { cls: offline.length ? 'text-danger' : '', icon: 'ti-plug-connected-x', sub: pct(offline.length) }),
        stat('Da aggiornare', outdated.length, { cls: outdated.length ? 'text-warning' : '', icon: 'ti-arrow-up-circle',
            sub: latest ? `ultima versione ${escapeHtml(latest)}` : '' }),
        stat('Backup nelle 24h', d.backups.last_24h, { icon: 'ti-database-export',
            sub: `${d.backups.count} archivi, ${formatBytes(d.backups.size)}` }),
        stat('Licenze attive', d.licenses.active, { icon: 'ti-certificate', href: '#licenses',
            sub: Object.keys(d.licenses.features).length ? `${Object.keys(d.licenses.features).length} feature` : '' }),
    ];
    if (hub) {
        stats.push(stat('Sessioni di supporto', d.open_support_sessions, { cls: d.open_support_sessions ? 'text-warning' : '',
            icon: 'ti-lifebuoy', href: '#support', sub: 'aperte ora' }));
        stats.push(stat('Enrollment in attesa', d.enrollment_pending, { cls: d.enrollment_pending ? 'text-warning' : '',
            icon: 'ti-user-plus', href: '#enrollment', sub: `${d.enrollment_tokens} token validi` }));
    }
    const statCol = stats.length > 6 ? 'col-6 col-md-3' : 'col-6 col-md-4 col-xl-2';

    // --- Versions ---
    const versions = Object.entries(d.versions).sort((a, b) => cmpVersion(b[0], a[0])).map(([v, n]) => `
        <tr><td class="font-monospace">${escapeHtml(v)}${v === latest ? '<span class="badge bg-success-lt ms-2">ultima</span>' : ''}</td>
            <td style="width: 45%"><div class="progress progress-sm"><div class="progress-bar ${v === latest ? 'bg-success' : 'bg-warning'}"
                style="width: ${Math.round(n * 100 / (active.length || 1))}%"></div></div></td>
            <td class="text-end">${n}</td></tr>`).join('');

    // --- Resources: averages of the online instances, the busiest ones ---
    const measured = online.filter(i => i.stats && i.stats.cpu_percent !== undefined);
    const avg = key => measured.reduce((s, i) => s + (Number(i.stats[key]) || 0), 0) / (measured.length || 1);
    const busy = i => Math.max(i.stats.cpu_percent || 0, i.stats.mem_percent || 0, i.stats.disk_percent || 0);
    const busiest = [...measured].sort((a, b) => busy(b) - busy(a)).slice(0, 5);
    const resources = measured.length ? `
        <div class="card-body border-bottom">
            <div class="subheader mb-1">Media su ${measured.length} istanze online</div>
            ${meter('CPU', avg('cpu_percent'))}${meter('RAM', avg('mem_percent'))}${meter('Disco', avg('disk_percent'))}
        </div>
        <div class="card-body">
            <div class="subheader mb-2">Più cariche</div>
            ${busiest.map(i => `<div class="mb-2"><div class="d-flex"><strong class="text-truncate">${instLink(i.id, i.name)}</strong></div>
                ${meter('CPU', i.stats.cpu_percent)}${meter('RAM', i.stats.mem_percent)}${meter('Disco', i.stats.disk_percent)}</div>`).join('')}
        </div>` : empty('Nessuna istanza online con dati sulle risorse.', false);

    // --- Backups ---
    const b = d.backups;
    const staleRows = (b.stale || []).map(s => `<tr>
        <td>${instLink(s.id, s.name, 'backups')}</td>
        <td class="text-muted">${s.last_backup_at ? `ultimo ${relTime(s.last_backup_at)}` : 'mai eseguito'}</td>
        <td class="text-end">${s.online ? '' : '<span class="badge bg-danger-lt">offline</span>'}</td></tr>`).join('');
    const backups = `
        <div class="card-body border-bottom small text-muted">
            ${b.interval_hours ? `Backup pianificati ogni <strong>${b.interval_hours} h</strong>; segnalate le istanze senza backup da oltre ${2 * b.interval_hours} h.`
                : 'Backup pianificati disattivati nelle impostazioni.'}
        </div>
        ${!b.interval_hours ? '' : staleRows
            ? `<div class="table-responsive"><table class="table card-table table-vcenter"><tbody>${staleRows}</tbody></table></div>`
            : empty('Tutte le istanze con backup pianificati hanno un backup recente.')}`;

    // --- Offline ---
    const offlineRows = offline.slice(0, LIST).map(i => `<tr>
        <td>${instLink(i.id, i.name)}</td>
        <td class="text-muted">${escapeHtml(groupName(groups, i.group_id))}</td>
        <td class="font-monospace small">${escapeHtml(i.last_ip || '-')}</td>
        <td class="text-end">${relTime(i.last_seen_at)}</td></tr>`).join('');

    // --- Failed commands (7 days) ---
    const cmdRows = d.failed_commands.map(c => `<tr>
        <td>${instLink(c.instance_id, c.instance_name, 'commands')}<div class="small text-muted">${relTime(c.created_at)}</div></td>
        <td class="font-monospace small">${escapeHtml(c.name)}</td>
        <td>${commandStatusBadge(c.status)}</td>
        <td class="small text-muted text-truncate" style="max-width: 260px" title="${escapeHtml(c.error)}">${escapeHtml(c.error || '-')}</td></tr>`).join('');

    // --- Groups: top level, a partner with its customers ---
    const byId = Object.fromEntries(groups.map(g => [g.id, g]));
    const top = groups.filter(g => !g.parent_id || !byId[g.parent_id]);
    const groupRows = top.map(g => {
        const ids = new Set([g.id, ...groups.filter(c => c.parent_id === g.id).map(c => c.id)]);
        const ga = active.filter(i => ids.has(i.group_id));
        const on = ga.filter(i => i.online).length;
        const old = ga.filter(i => outdated.includes(i)).length;
        return `<tr>
            <td><a href="#instances/group/${escapeHtml(g.id)}">${g.kind === 'partner'
                ? '<i class="ti ti-briefcase text-purple me-1"></i>' : '<i class="ti ti-building text-azure me-1"></i>'}${escapeHtml(g.name)}</a></td>
            <td class="text-end">${ga.length}</td>
            <td style="width: 30%"><div class="progress progress-sm" title="${on} online su ${ga.length}">
                <div class="progress-bar bg-success" style="width: ${ga.length ? on * 100 / ga.length : 0}%"></div>
                <div class="progress-bar bg-danger" style="width: ${ga.length ? (ga.length - on) * 100 / ga.length : 0}%"></div></div></td>
            <td class="text-end ${ga.length - on ? 'text-danger' : 'text-muted'}">${ga.length - on}</td>
            <td class="text-end ${old ? 'text-warning' : 'text-muted'}">${old}</td></tr>`;
    }).join('');

    // --- Expiring: license entitlements, agent certificates ---
    const expiring = [
        ...d.licenses.expiring.map(l => ({ at: l.valid_until, html: `<tr>
            <td><i class="ti ti-certificate text-muted me-1"></i>Licenza <span class="font-monospace">${escapeHtml(l.feature)}</span></td>
            <td>${instLink(l.instance_id, l.instance_name, 'licenses')}</td>
            <td class="text-end">${expiryText(l.valid_until)}</td></tr>` })),
        ...d.certificates_expiring.map(c => ({ at: c.not_after, html: `<tr>
            <td><i class="ti ti-shield-lock text-muted me-1"></i>Certificato agent</td>
            <td>${instLink(c.id, c.name)}${c.online ? '' : ' <span class="badge bg-danger-lt">offline</span>'}</td>
            <td class="text-end">${expiryText(c.not_after)}</td></tr>` })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const features = Object.entries(d.licenses.features).sort((a, b) => b[1] - a[1])
        .map(([f, n]) => `<span class="badge bg-azure-lt me-1 mb-1"><span class="font-monospace">${escapeHtml(f)}</span> · ${n}</span>`).join('');

    container.innerHTML = `
        <div class="row row-cards mb-3">${stats.map(s => `<div class="${statCol}">${s}</div>`).join('')}</div>
        <div class="row row-deck row-cards mb-3">
            <div class="col-md-6 col-xl-4">${card('Versioni MADMIN', versions
                ? `<table class="table card-table table-vcenter"><tbody>${versions}</tbody></table>` : empty('Nessuna istanza attiva.', false))}</div>
            <div class="col-md-6 col-xl-4">${card('Risorse', resources)}</div>
            <div class="col-md-12 col-xl-4">${card('Backup', backups, {
                actions: countBadge(b.stale_count, 'bg-warning-lt'), footer: more(b.stale_count || 0, (b.stale || []).length) })}</div>
        </div>
        <div class="row row-deck row-cards mb-3">
            <div class="col-xl-6">${card('Istanze offline', offlineRows ? `
                <div class="table-responsive"><table class="table card-table table-vcenter">
                    <thead><tr><th>Nome</th><th>Gruppo</th><th>Ultimo IP</th><th class="text-end">Ultimo contatto</th></tr></thead>
                    <tbody>${offlineRows}</tbody></table></div>` : empty('Tutte le istanze attive sono online.'),
                { actions: countBadge(offline.length, 'bg-danger-lt'), footer: more(offline.length, LIST) })}</div>
            <div class="col-xl-6">${card('Comandi falliti', cmdRows ? `
                <div class="table-responsive"><table class="table card-table table-vcenter">
                    <thead><tr><th>Istanza</th><th>Comando</th><th>Stato</th><th>Errore</th></tr></thead>
                    <tbody>${cmdRows}</tbody></table></div>` : empty(`Nessun comando fallito negli ultimi ${RECENT_DAYS} giorni.`),
                { actions: `<span class="text-muted small">nelle ultime 24h: ${d.failed_commands_24h}</span>` })}</div>
        </div>
        <div class="row row-deck row-cards mb-3">
            ${groupRows ? `<div class="col-xl-6">${card('Partner e clienti', `
                <div class="table-responsive"><table class="table card-table table-vcenter">
                    <thead><tr><th>Gruppo</th><th class="text-end">Attive</th><th>Online</th><th class="text-end">Offline</th>
                        <th class="text-end">Da aggiornare</th></tr></thead>
                    <tbody>${groupRows}</tbody></table></div>`)}</div>` : ''}
            <div class="col-xl-6">${card('Licenze e scadenze', `
                ${features ? `<div class="card-body border-bottom">${features}</div>` : ''}
                ${expiring.length ? `<div class="table-responsive"><table class="table card-table table-vcenter">
                    <tbody>${expiring.map(e => e.html).join('')}</tbody></table></div>`
                    : empty('Nessuna licenza o certificato in scadenza nei prossimi 30 giorni.')}`)}</div>
        </div>
        ${hub ? `<div class="row row-deck row-cards">
            <div class="col-xl-6">${card('Sessioni di supporto aperte', d.support_sessions.length ? `
                <div class="table-responsive"><table class="table card-table table-vcenter">
                    <thead><tr><th>Istanza</th><th>Tipo</th><th>Operatore</th><th class="text-end">Scade</th></tr></thead>
                    <tbody>${d.support_sessions.map(s => `<tr>
                        <td>${instLink(s.instance_id, s.instance_name, 'support')}<div class="small text-muted text-truncate" style="max-width: 280px">${escapeHtml(s.reason)}</div></td>
                        <td>${s.kind === 'ui' ? 'UI' : 'SSH'}</td><td>${escapeHtml(s.operator)}</td>
                        <td class="text-end">${fmtDate(s.expires_at)}</td></tr>`).join('')}</tbody></table></div>`
                    : empty('Nessuna sessione aperta.'), { footer: more(d.open_support_sessions, d.support_sessions.length) })}</div>
            <div class="col-xl-6">${card(`Registrate negli ultimi ${RECENT_DAYS} giorni`, recent.length ? `
                <div class="table-responsive"><table class="table card-table table-vcenter">
                    <tbody>${recent.slice(0, LIST).map(i => `<tr>
                        <td>${instLink(i.id, i.name)}</td>
                        <td class="text-muted">${escapeHtml(groupName(groups, i.group_id))}</td>
                        <td class="text-end">${fmtDate(i.enrolled_at)}</td></tr>`).join('')}</tbody></table></div>`
                    : empty('Nessuna nuova istanza.', false), {
                    actions: d.enrollment_pending ? `<a href="#enrollment" class="badge bg-warning-lt">${d.enrollment_pending} in attesa di approvazione</a>` : '',
                    footer: more(recent.length, LIST) })}</div>
        </div>` : ''}`;
}

function groupName(groups, id) {
    return (groups.find(g => g.id === id) || {}).path || '-';
}

function expiryText(value) {
    const days = daysTo(value);
    const cls = days < 7 ? 'text-danger' : 'text-warning';
    return `<span class="${cls}" title="${escapeHtml(fmtDate(value))}">${days < 0 ? 'scaduto' : days === 0 ? 'oggi' : `tra ${days} g`}</span>`;
}

export async function render(container) {
    clearInterval(timer);
    await load(container);
    timer = setInterval(() => {
        if (!document.body.contains(container) || !location.hash.startsWith('#dashboard') && location.hash) {
            clearInterval(timer);
            return;
        }
        load(container).catch(() => {});
    }, 30000);
}
