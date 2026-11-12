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

export function severityBadge(s) {
    const [label, cls] = SEVERITY[s] || SEVERITY.unknown;
    return `<span class="badge ${cls}">${label}</span>`;
}

export function advisoryLink(a) {
    const cves = (a.cves || []).slice(0, 3).join(', ');
    return `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" class="font-monospace">${escapeHtml(a.advisory_id)}</a>
        ${cves && !a.advisory_id.includes(cves) ? `<div class="small text-muted">${escapeHtml(cves)}</div>` : ''}`;
}

let containerEl = null;
let state = { tab: 'advisories', group: '', severity: 'critical,high', fixable: false, q: '' };

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
    const scan = sum.scan || {};
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
            ${card('Critiche', a.critical, a.critical ? 'text-red' : '', `${sum.instances_affected.critical} istanze`)}
            ${card('Alte', a.high, a.high ? 'text-orange' : '', `${sum.instances_affected.high} istanze`)}
            ${card('Medie', a.medium, '', `${sum.instances_affected.medium} istanze`)}
            ${card('Correggibili', sum.fixable_instances, '', 'istanze con critiche/alte già corrette nei repository')}
            ${card('Riavvio richiesto', sum.reboot_required, sum.reboot_required ? 'text-warning' : '', 'istanze')}
            ${card('Aggiornamenti sicurezza', sum.pending_security, '', `istanze con aggiornamenti in sospeso (su ${sum.instances})`)}
        </div>
        <div class="card">
            <div class="card-header">
                <ul class="nav nav-tabs card-header-tabs">
                    ${[['advisories', 'Per vulnerabilità'], ['instances', 'Per istanza'], ['versions', 'Per versione']].map(([k, l]) =>
                        `<li class="nav-item"><a class="nav-link ${k === state.tab ? 'active' : ''}" role="button" ${actionAttrs('vulnTab', k)}>${l}</a></li>`).join('')}
                </ul>
            </div>
            <div id="vuln-tab">${loadingSpinner()}</div>
        </div>`;
    container.querySelector('#vuln-group').addEventListener('change', (e) => { state.group = e.target.value; render(container); });
    await renderTab();
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
    const rows = await apiGet(`/vulnerabilities/advisories${qs({ severity: state.severity, fixable: state.fixable, q: state.q })}`);
    el.innerHTML = `
        <div class="card-body border-bottom d-flex flex-wrap gap-2 align-items-center">
            <select class="form-select form-select-sm w-auto" id="vuln-sev">
                ${[['critical,high', 'Critiche e alte'], ['critical', 'Solo critiche'], ['critical,high,medium', 'Fino a medie'], ['', 'Tutte']]
                    .map(([v, l]) => `<option value="${v}" ${v === state.severity ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <label class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" id="vuln-fix" ${state.fixable ? 'checked' : ''}>
                <span class="form-check-label">Solo con correzione disponibile</span></label>
            <input class="form-control form-control-sm w-auto ms-auto" id="vuln-q" placeholder="CVE, pacchetto..." value="${escapeHtml(state.q)}">
        </div>
        <div class="table-responsive"><table class="table card-table table-vcenter">
            <thead><tr><th>Vulnerabilità</th><th>Gravità</th><th>Tipo</th><th>Pacchetti</th><th>Istanze</th><th>Correzione</th><th>Descrizione</th></tr></thead>
            <tbody>${rows.map(r => `<tr class="cursor-pointer" ${actionAttrs('vulnAdvisory', r.advisory_id)}>
                <td>${advisoryLink(r)}</td><td>${severityBadge(r.severity)}</td>
                <td>${r.kind === 'os' ? 'OS' : 'Python'}</td>
                <td class="small">${escapeHtml(r.packages.slice(0, 4).join(', '))}${r.packages.length > 4 ? '…' : ''}</td>
                <td>${r.instances}</td>
                <td>${r.fixable ? '<span class="badge bg-success-lt">disponibile</span>' : '<span class="badge bg-secondary-lt">non ancora</span>'}</td>
                <td class="small text-muted text-truncate" style="max-width: 28rem">${escapeHtml(r.summary)}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="text-muted">Nessuna vulnerabilità con questi filtri</td></tr>'}</tbody>
        </table></div>`;
    el.querySelector('#vuln-sev').addEventListener('change', (e) => { state.severity = e.target.value; renderTab(); });
    el.querySelector('#vuln-fix').addEventListener('change', (e) => { state.fixable = e.target.checked; renderTab(); });
    el.querySelector('#vuln-q').addEventListener('change', (e) => { state.q = e.target.value.trim(); renderTab(); });
}

function sevCounts(f) {
    return ['critical', 'high', 'medium', 'low'].map(s => f[s]
        ? `<span class="badge ${SEVERITY[s][1]} me-1" title="${SEVERITY[s][0]}">${f[s]}</span>` : '').join('') || '<span class="text-muted">-</span>';
}

async function instancesTab(el) {
    const rows = await apiGet(`/vulnerabilities/instances${qs()}`);
    const rank = r => -(r.findings.critical * 1e6 + r.findings.high * 1e3 + r.findings.medium);
    rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    el.innerHTML = `<div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr><th>Istanza</th><th>MADMIN</th><th>OS</th><th>Kernel</th><th>Riavvio</th><th>Aggiornamenti</th><th>Vulnerabilità</th><th>Correggibili</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="cursor-pointer" ${actionAttrs('vulnInstance', r.id)}>
            <td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.version || '-')}</td>
            <td class="small">${escapeHtml(r.os || '-')}</td>
            <td class="small font-monospace">${escapeHtml(r.kernel || '-')}${r.newest_kernel && r.newest_kernel !== r.kernel
                ? `<div class="text-warning">installato ${escapeHtml(r.newest_kernel)}</div>` : ''}</td>
            <td>${r.reboot_required ? '<span class="badge bg-warning-lt">richiesto</span>' : '<span class="text-muted">no</span>'}</td>
            <td>${r.pending_updates == null ? '-' : `${r.pending_updates}${r.pending_security ? ` <span class="badge bg-red-lt">${r.pending_security} sicurezza</span>` : ''}`}
                ${r.apt_updated_at ? `<div class="small text-muted">liste: ${relTime(new Date(r.apt_updated_at * 1000).toISOString())}</div>` : ''}</td>
            <td>${sevCounts(r.findings)}</td><td>${r.fixable || '-'}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="text-muted">Nessuna istanza</td></tr>'}</tbody>
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
    vulnInstance: (id) => { location.hash = `#instances/${id}/packages`; },
    vulnAdvisory: async (id) => {
        try {
            const d = await apiGet(`/vulnerabilities/advisories/${encodeURIComponent(id)}${qs()}`);
            secretModal(`${d.advisory_id}`, `
                <div class="mb-2">${severityBadge(d.severity)} <span class="text-muted small">pubblicata ${fmtDate(d.published)}</span></div>
                <p>${escapeHtml(d.summary)}</p>
                <p class="small">${escapeHtml((d.cves || []).join(', '))} · <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">dettagli</a></p>
                <table class="table table-sm"><thead><tr><th>Istanza</th><th>Pacchetto</th><th>Installato</th><th>Corretto in</th><th>Dal</th></tr></thead>
                <tbody>${d.instances.map(i => `<tr><td><a href="#instances/${escapeHtml(i.id)}/packages" data-bs-dismiss="modal">${escapeHtml(i.name)}</a></td>
                    <td>${escapeHtml(i.package)}</td><td class="font-monospace small">${escapeHtml(i.installed_version)}</td>
                    <td class="font-monospace small">${escapeHtml(i.fixed_version || 'non ancora')}</td><td>${fmtDate(i.first_seen)}</td></tr>`).join('')}</tbody></table>`);
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
