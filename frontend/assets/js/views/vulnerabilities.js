/**
 * MADMIN Manager - Vulnerabilities: OS and Python advisories (OSV) that affect
 * the instances in the user's scope, by advisory, by instance and by version.
 * The per-instance detail is the Pacchetti tab of the instance page.
 */
import { apiGet, apiPost, getToken } from '../api.js';
import { escapeHtml, showToast, loadingSpinner, actionAttrs, registerActions } from '../utils.js';
import { checkPermission } from '../app.js';
import { fmtDate, relTime, groupOptions, secretModal } from './manager-common.js';

export const SEVERITY = {
    critical: ['Critica', 'bg-red text-red-fg'],
    high: ['Alta', 'bg-orange text-orange-fg'],
    medium: ['Media', 'bg-yellow text-yellow-fg'],
    low: ['Bassa', 'bg-azure-lt'],
    negligible: ['Trascurabile', 'bg-secondary-lt'],
    unknown: ['Non nota', 'bg-secondary-lt'],
};

/**
 * Severity badge. quiet = nothing to install yet: shown in grey, so the
 * colours (red above all) are left to what can be fixed now.
 */
export function severityBadge(s, quiet = false) {
    const [label, cls] = SEVERITY[s] || SEVERITY.unknown;
    return `<span class="badge ${quiet ? 'bg-secondary-lt' : cls}"${quiet ? ' title="Nessuna correzione installabile ora"' : ''}>${label}</span>`;
}

// Ubuntu tracker status of a finding (backend/manager/inventory/ubuntu.py), most actionable first
export const STATUS = {
    fixed: ['Correggibile', 'bg-success-lt', 'Correzione pubblicata: si installa con gli aggiornamenti del sistema'],
    release: ['Serve release MADMIN', 'bg-indigo-lt', 'Pacchetto Python di MADMIN con una versione corretta su PyPI: serve una release di MADMIN che la includa (gli aggiornamenti del sistema non lo toccano)'],
    pending: ['Correzione in arrivo', 'bg-azure-lt', 'Ubuntu ha preparato la correzione, non ancora pubblicata (per il kernel: il prossimo rilascio)'],
    stale: ['Da verificare', 'bg-teal-lt', 'Ubuntu ha valutato una versione precedente a quella installata: probabilmente già corretta, i dati Ubuntu non sono ancora aggiornati'],
    needed: ['Senza correzione', 'bg-orange-lt', 'Vulnerabile: Ubuntu non ha ancora una correzione'],
    triage: ['In valutazione', 'bg-secondary-lt', 'Non ancora valutata dal team di sicurezza Ubuntu: può risultare non applicabile'],
    deferred: ['Rimandata', 'bg-secondary-lt', 'Vulnerabile: Ubuntu ha rimandato la correzione'],
    esm: ['Solo Ubuntu Pro', 'bg-purple-lt', 'Corretta solo nei repository Ubuntu Pro (ESM)'],
    ignored: ['Non verrà corretta', 'bg-dark-lt', 'Ubuntu ha deciso di non correggerla (rischio basso o correzione non praticabile)'],
    eol: ['Non supportato', 'bg-dark-lt', 'Il pacchetto non è più supportato in questa release'],
    '': ['Nessuna correzione nota', 'bg-secondary-lt', 'Nessuna versione corretta nota'],
};

export const STATUS_FILTERS = [
    ['', 'Tutti gli stati'],
    ['fixed', 'Correggibili ora (sistema)'],
    ['release', 'Serve release MADMIN'],
    ['pending', 'Correzione in arrivo'],
    ['needed,triage,deferred,unknown', 'Senza correzione'],
    ['stale', 'Da verificare'],
    ['esm,ignored,eol', 'Non verranno corrette'],
];

export function statusBadge(s) {
    const [label, cls, title] = STATUS[s] || STATUS[''];
    return `<span class="badge ${cls}" title="${escapeHtml(title)}">${label}</span>`;
}

/** "linux-hwe-7.0 fixed 7.0.0-43.43~24.04.1" -> text for the GA kernel findings */
export function kernelFixText(kf) {
    if (!kf) return '';
    const [source, status, version] = kf.split(' ');
    return status === 'fixed' ? `corretta nel kernel HWE ${source} (${version})` : `non presente nel kernel HWE ${source}`;
}

/** Status badge with its version: "in <fixed>" or the version Ubuntu assessed. */
export function statusCell(f) {
    const v = f.fixed_version || f.status_version;
    const what = f.fixed_version || f.status === 'esm' ? 'in' : f.status === 'stale' ? 'valutata' : '';
    return `${statusBadge(f.status)}${what && v ? `<div class="small text-muted font-monospace">${what} ${escapeHtml(v)}</div>` : ''}
        ${f.kernel_fix ? `<div class="small text-muted">${escapeHtml(kernelFixText(f.kernel_fix))}</div>` : ''}`;
}

export function advisoryLink(a) {
    const cves = (a.cves || []).slice(0, 3).join(', ');
    return `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" class="font-monospace">${escapeHtml(a.advisory_id)}</a>
        ${cves && !a.advisory_id.includes(cves) ? `<div class="small text-muted">${escapeHtml(cves)}</div>` : ''}`;
}

let containerEl = null;
let state = { tab: 'advisories', group: '', severity: 'critical,high', status: '', q: '' };

function qs(extra = {}) {
    const p = new URLSearchParams();
    if (state.group) p.set('group_id', state.group);
    for (const [k, v] of Object.entries(extra)) if (v !== '' && v !== false && v != null) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
}

export async function render(container) {
    containerEl = container;
    const [sum, groups] = await Promise.all([apiGet(`/vulnerabilities/summary${qs()}`), apiGet('/groups').catch(() => [])]);
    const a = sum.advisories;
    const fx = sum.advisories_fixable || {};
    const scan = sum.scan || {};
    // Colour only for what can be fixed now; the rest is counted, in grey
    const sevHint = (s) => `${fx[s] ? `<b>${fx[s]} correggibili</b>` : 'nessuna correggibile'} · ${sum.instances_affected[s]} istanze`;
    const card = (label, value, cls = '', hint = '') => `<div class="col-6 col-md-4 col-xl-2"><div class="card card-sm"><div class="card-body">
        <div class="subheader">${label}</div><div class="h2 mb-0 ${cls}">${value}</div>
        ${hint ? `<div class="small text-muted">${hint}</div>` : ''}</div></div></div>`;
    container.innerHTML = `
        <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
            <select class="form-select w-auto" id="vuln-group">${groupOptions(groups, state.group, { none: 'Tutti i gruppi' })}
                ${checkPermission('manager.view') ? `<option value="none" ${state.group === 'none' ? 'selected' : ''}>Senza gruppo</option>` : ''}</select>
            <div class="text-muted small ms-auto">
                Ultima scansione: ${scan.last_scan_at ? relTime(scan.last_scan_at) : 'mai'}${scan.running ? ' (in corso)' : ''}
                ${scan.last_error ? `<span class="text-danger" title="${escapeHtml(scan.last_error)}"> · errore</span>` : ''}
            </div>
            ${checkPermission('manager.manage') ? `<button class="btn btn-outline-secondary btn-sm" ${actionAttrs('vulnScan')}><i class="ti ti-refresh me-1"></i>Scansiona ora</button>` : ''}
            <button class="btn btn-outline-primary btn-sm" ${actionAttrs('vulnExport')}><i class="ti ti-download me-1"></i>Esporta CSV</button>
        </div>
        <div class="row g-2 mb-3">
            ${card('Critiche', a.critical, fx.critical ? 'text-red' : 'text-muted', sevHint('critical'))}
            ${card('Alte', a.high, fx.high ? 'text-orange' : 'text-muted', sevHint('high'))}
            ${card('Medie', a.medium, 'text-muted', sevHint('medium'))}
            ${card('Correggibili', sum.fixable_instances, sum.fixable_instances ? 'text-red' : '', 'istanze con critiche/alte già corrette nei repository')}
            ${card('Riavvio richiesto', sum.reboot_required, sum.reboot_required ? 'text-warning' : '', 'istanze')}
            ${card('Aggiornamenti sicurezza', sum.pending_security, '', `istanze con aggiornamenti in sospeso (su ${sum.instances})`)}
        </div>
        ${howItWorks()}
        ${scan.vex_error ? `<div class="alert alert-warning py-2">Stato Ubuntu non aggiornato per alcune CVE: ${escapeHtml(scan.vex_error)}</div>` : ''}
        <div class="card mb-3"><div class="card-body py-2 d-flex flex-wrap gap-3 align-items-center">
            <span class="text-muted small">Stato secondo Ubuntu (rilevazioni, tutte le gravità):</span>
            ${Object.entries(sum.statuses || {}).filter(([, n]) => n).map(([s, n]) =>
                `<a role="button" class="text-reset" ${actionAttrs('vulnStatus', s || 'unknown')}>${statusBadge(s)} ${n}</a>`).join('')
                || '<span class="text-muted small">nessuna rilevazione</span>'}
        </div></div>
        <div class="card">
            <div class="card-header">
                <ul class="nav nav-tabs card-header-tabs">
                    ${[['advisories', 'Per vulnerabilità'], ['instances', 'Per istanza'], ['versions', 'Per versione']].map(([k, l]) =>
                        `<li class="nav-item"><a class="nav-link ${k === state.tab ? 'active' : ''}" role="button" ${actionAttrs('vulnTab', k)}>${l}</a></li>`).join('')}
                </ul>
            </div>
            <div id="vuln-tab">${loadingSpinner()}</div>
        </div>`;
    container.querySelector('#vuln-help').addEventListener('toggle', (e) => {
        try { localStorage.setItem('manager.vulnHelp', e.target.open ? 'open' : 'closed'); } catch { /* not remembered */ }
    });
    container.querySelector('#vuln-group').addEventListener('change', (e) => { state.group = e.target.value; render(container); });
    await renderTab();
}

/** The flow, from the instance to an action: collapsed after the first visit. */
function howItWorks() {
    let open = true;
    try { open = localStorage.getItem('manager.vulnHelp') !== 'closed'; } catch { /* default open */ }
    const step = (n, icon, title, text, where) => `<div class="col-md-3"><div class="d-flex gap-2">
        <span class="avatar avatar-sm bg-primary-lt">${n}</span><div>
        <div class="fw-bold"><i class="ti ${icon} me-1"></i>${title}</div>
        <div class="small text-muted">${text}</div>
        <div class="small mt-1"><span class="badge bg-secondary-lt">${where}</span></div></div></div></div>`;
    return `<details class="card mb-3" ${open ? 'open' : ''} id="vuln-help">
        <summary class="card-header cursor-pointer"><h3 class="card-title"><i class="ti ti-help-circle me-2"></i>Come funziona</h3></summary>
        <div class="card-body"><div class="row g-3">
            ${step(1, 'ti-server', 'L\'istanza invia i pacchetti',
                'Elenco dei pacchetti del sistema e del venv di MADMIN, e gli aggiornamenti disponibili: solo quando cambiano (controllo ogni 5 minuti).',
                'sull\'istanza')}
            ${step(2, 'ti-shield-search', 'Il manager li confronta',
                'Con OSV (avvisi Ubuntu e PyPI) e con lo stato del tracker di Ubuntu per ogni CVE: a ogni cambio e una volta al giorno.',
                'sul manager, l\'unico che esce su internet')}
            ${step(3, 'ti-list-details', 'Ogni vulnerabilità ha uno stato',
                '<b class="text-success">Correggibile</b>: la correzione è nei repository · <b>In arrivo</b>: Ubuntu l\'ha preparata · <b>Senza correzione</b>: si aspetta Ubuntu · <b class="text-indigo">Serve release MADMIN</b>: pacchetto Python.',
                'Vulnerabilità · scheda Sistema')}
            ${step(4, 'ti-tool', 'Cosa fare',
                'Scheda <b>Sistema</b> dell\'istanza: <b>Aggiornamenti di sicurezza</b> (o <b>Aggiorna tutto</b>) con l\'elenco esatto di cosa installano, poi il riavvio se serve. Su molte istanze: un <b>Rollout</b>.',
                'azione di un superuser')}
        </div></div></details>`;
}

async function renderTab() {
    const el = containerEl.querySelector('#vuln-tab');
    try {
        if (state.tab === 'advisories') await advisoriesTab(el);
        else if (state.tab === 'instances') await instancesTab(el);
        else await versionsTab(el);
    } catch (e) {
        el.innerHTML = `<div class="card-body text-danger">${escapeHtml(e.message)}</div>`;
    }
}

async function advisoriesTab(el) {
    const rows = await apiGet(`/vulnerabilities/advisories${qs({ severity: state.severity, status: state.status, q: state.q })}`);
    const filters = STATUS_FILTERS.some(([v]) => v === state.status) ? STATUS_FILTERS
        : [...STATUS_FILTERS, [state.status, (STATUS[state.status === 'unknown' ? '' : state.status] || STATUS[''])[0]]];
    el.innerHTML = `
        <div class="card-body border-bottom d-flex flex-wrap gap-2 align-items-center">
            <select class="form-select form-select-sm w-auto" id="vuln-sev">
                ${[['critical,high', 'Critiche e alte'], ['critical', 'Solo critiche'], ['critical,high,medium', 'Fino a medie'], ['', 'Tutte']]
                    .map(([v, l]) => `<option value="${v}" ${v === state.severity ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <select class="form-select form-select-sm w-auto" id="vuln-status">
                ${filters.map(([v, l]) => `<option value="${v}" ${v === state.status ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
            </select>
            <input class="form-control form-control-sm w-auto ms-auto" id="vuln-q" placeholder="CVE, pacchetto..." value="${escapeHtml(state.q)}">
        </div>
        <div class="table-responsive"><table class="table card-table table-vcenter">
            <thead><tr><th>Vulnerabilità</th><th>Gravità</th><th>Tipo</th><th>Pacchetti</th><th>Istanze</th><th>Stato Ubuntu</th><th>Descrizione</th></tr></thead>
            <tbody>${rows.map(r => `<tr class="cursor-pointer" ${actionAttrs('vulnAdvisory', r.advisory_id)}>
                <td>${advisoryLink(r)}</td><td>${severityBadge(r.severity, !r.fixable)}</td>
                <td>${r.kind === 'os' ? 'OS' : 'Python'}</td>
                <td class="small">${escapeHtml(r.packages.slice(0, 4).join(', '))}${r.packages.length > 4 ? '…' : ''}</td>
                <td>${r.instances}</td>
                <td>${statusBadge(r.status)}${Object.keys(r.statuses || {}).length > 1 ? '<div class="small text-muted">varia per istanza</div>' : ''}
                    ${r.kernel_fix ? `<div class="small text-muted">${escapeHtml(kernelFixText(r.kernel_fix))}</div>` : ''}</td>
                <td class="small text-muted text-truncate" style="max-width: 28rem">${escapeHtml(r.summary)}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="text-muted">Nessuna vulnerabilità con questi filtri</td></tr>'}</tbody>
        </table></div>`;
    el.querySelector('#vuln-sev').addEventListener('change', (e) => { state.severity = e.target.value; renderTab(); });
    el.querySelector('#vuln-status').addEventListener('change', (e) => { state.status = e.target.value; renderTab(); });
    el.querySelector('#vuln-q').addEventListener('change', (e) => { state.q = e.target.value.trim(); renderTab(); });
}

/** Counts per severity, in grey: the colour goes to the Correggibili column. */
export function sevCounts(f) {
    return ['critical', 'high', 'medium', 'low'].map(s => f[s]
        ? `<span class="badge bg-secondary-lt me-1" title="${SEVERITY[s][0]}">${SEVERITY[s][0][0]} ${f[s]}</span>` : '').join('') || '<span class="text-muted">-</span>';
}

async function instancesTab(el) {
    const rows = await apiGet(`/vulnerabilities/instances${qs()}`);
    const rank = r => -(r.findings.critical * 1e6 + r.findings.high * 1e3 + r.findings.medium);
    rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    el.innerHTML = `<div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr><th>Istanza</th><th>MADMIN</th><th>OS</th><th>Kernel</th><th>Riavvio</th><th>Aggiornamenti</th><th>Vulnerabilità</th><th>Correggibili</th><th>In arrivo</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="cursor-pointer" ${actionAttrs('vulnInstance', r.id)}>
            <td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.version || '-')}</td>
            <td class="small">${escapeHtml(r.os || '-')}</td>
            <td class="small font-monospace">${escapeHtml(r.kernel || '-')}${r.newest_kernel && r.newest_kernel !== r.kernel
                ? `<div class="text-warning">installato ${escapeHtml(r.newest_kernel)}</div>` : ''}</td>
            <td>${r.reboot_required ? '<span class="badge bg-warning-lt">richiesto</span>' : '<span class="text-muted">no</span>'}</td>
            <td>${r.pending_updates == null ? '-' : `${r.pending_updates}${r.pending_security ? ` <span class="badge bg-red-lt">${r.pending_security} sicurezza</span>` : ''}`}
                ${r.apt_updated_at ? `<div class="small text-muted">liste: ${relTime(new Date(r.apt_updated_at * 1000).toISOString())}</div>` : ''}</td>
            <td>${sevCounts(r.findings)}</td>
            <td>${r.fixable ? `<span class="badge bg-red text-red-fg">${r.fixable}</span>` : '<span class="text-muted">-</span>'}</td>
            <td title="${escapeHtml(STATUS.pending[2])}">${r.pending || '-'}</td>
        </tr>`).join('') || '<tr><td colspan="9" class="text-muted">Nessuna istanza</td></tr>'}</tbody>
    </table></div>`;
}

async function versionsTab(el) {
    const v = await apiGet(`/vulnerabilities/versions${qs()}`);
    const list = (title, items) => `<div class="col-md-4"><h4>${title}</h4><table class="table table-sm">
        ${items.map(i => `<tr><td class="font-monospace small">${escapeHtml(i.value)}</td><td class="text-end">${i.count}</td></tr>`).join('')
            || '<tr><td class="text-muted">-</td></tr>'}</table></div>`;
    el.innerHTML = `<div class="card-body"><div class="row">
        ${list('MADMIN', v.madmin)}${list('Sistema operativo', v.os)}${list('Kernel in esecuzione', v.kernel)}
    </div></div>`;
}

registerActions({
    vulnTab: (tab) => { state.tab = tab; render(containerEl); },
    vulnStatus: (status) => { state.tab = 'advisories'; state.status = status; state.severity = ''; render(containerEl); },
    vulnInstance: (id) => { location.hash = `#instances/${id}/packages`; },
    vulnAdvisory: async (id) => {
        try {
            const d = await apiGet(`/vulnerabilities/advisories/${encodeURIComponent(id)}${qs()}`);
            secretModal(`${d.advisory_id}`, `
                <div class="mb-2">${severityBadge(d.severity, !d.instances.some(i => i.fixed_version))} <span class="text-muted small">pubblicata ${fmtDate(d.published)}</span></div>
                <p>${escapeHtml(d.summary)}</p>
                <p class="small">${escapeHtml((d.cves || []).join(', '))} · <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">dettagli</a></p>
                <table class="table table-sm"><thead><tr><th>Istanza</th><th>Pacchetto</th><th>Installato</th><th>Stato Ubuntu</th><th>Dal</th></tr></thead>
                <tbody>${d.instances.map(i => `<tr><td><a href="#instances/${escapeHtml(i.id)}/packages" data-bs-dismiss="modal">${escapeHtml(i.name)}</a></td>
                    <td>${escapeHtml(i.package)}</td><td class="font-monospace small">${escapeHtml(i.installed_version)}</td>
                    <td>${statusCell(i)}</td><td>${fmtDate(i.first_seen)}</td></tr>`).join('')}</tbody></table>`);
        } catch (e) { showToast(e.message, 'error'); }
    },
    vulnScan: async () => {
        try { await apiPost('/vulnerabilities/scan', {}); showToast('Scansione avviata (entro un minuto)', 'success'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    vulnExport: async () => {
        try {
            const r = await fetch(`/api/vulnerabilities/export.csv${qs()}`, { headers: { Authorization: `Bearer ${getToken()}` } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const url = URL.createObjectURL(await r.blob());
            const a = Object.assign(document.createElement('a'), { href: url, download: 'vulnerabilita.csv' });
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) { showToast(e.message, 'error'); }
    },
});
