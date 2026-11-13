/**
 * MADMIN Manager - Instances: tree of groups and instances on the left, and on the
 * right the overview of the fleet (#instances), of a group (#instances/group/<id>)
 * or the detail of an instance (#instances/<id>/<tab>).
 */
import { apiGet, apiPost, apiPatch, apiDelete, getToken } from '../api.js';
import { escapeHtml, showToast, confirmDialog, loadingSpinner, formatBytes,
         actionAttrs, registerActions } from '../utils.js';
import { checkPermission, setPageActions } from '../app.js';
import { fmtDate, relTime, onlineBadge, commandStatusBadge, formModal, secretModal, copyBlock, enrollTokenHelp,
         formData, groupOptions, groupPath, labelBadges, labelsToText, textToLabels,
         cmpVersion, meter, STATUS_LABELS, field, formSection, notice, typedConfirm, confirmAction,
         fieldError } from './manager-common.js';
import { severityBadge, advisoryLink, statusBadge, statusCell } from './vulnerabilities.js';

const TABS = [
    ['overview', 'Panoramica', 'scope.view'],
    ['addresses', 'Indirizzi', 'scope.view'],
    ['backups', 'Backup', 'scope.view'],
    ['licenses', 'Licenze', 'scope.view'],
    ['packages', 'Sistema', 'scope.view'],
    ['support', 'Supporto', 'manager.view'],
    ['commands', 'Comandi', 'scope.view'],
];

let groups = [];
let current = null;   // instance shown in the detail
let mainEl = null;    // right pane: overview or detail

// ============== TREE (left) ==============
// The shell empties the page on every route change, so the tree is rebuilt
// each time: the lists are cached for a few seconds, and the filters, the
// collapsed groups and the scroll position live here to survive navigation.

const CACHE_MS = 15000;
const REFRESH_MS = 30000;
const COLLAPSED_KEY = 'manager.treeCollapsed';

let instances = [];   // every instance in scope, any status
let fetchedAt = 0;
let filterQ = '';
let filterStatus = 'active';
let treeScroll = 0;
let selected = { kind: 'root', id: null };
let refreshTimer = null;

const STATUS_FILTERS = [
    ['active', 'Attive', i => i.status === 'active'],
    ['online', 'Online', i => i.status === 'active' && i.online],
    ['offline', 'Offline', i => i.status === 'active' && !i.online],
    ['suspended', 'Sospese', i => i.status === 'suspended'],
    ['revoked', 'Revocate', i => i.status === 'revoked'],
    ['decommissioned', 'Dismesse', i => i.status === 'decommissioned'],
    ['', 'Tutti gli stati', () => true],
];

let collapsed = new Set();
try { collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch { /* all open */ }

function saveCollapsed() {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* not remembered */ }
}

async function fetchLists(force = false) {
    if (!force && Date.now() - fetchedAt < CACHE_MS) return;
    const [g, list] = await Promise.all([apiGet('/groups').catch(() => []), apiGet('/instances')]);
    groups = g;
    instances = list;
    fetchedAt = Date.now();
}

/** Groups by id, top level (a customer whose partner is out of scope is top level too), children. */
function hierarchy() {
    const byId = Object.fromEntries(groups.map(g => [g.id, g]));
    return {
        byId,
        top: groups.filter(g => !g.parent_id || !byId[g.parent_id]),
        children: id => groups.filter(g => g.parent_id === id),
    };
}

function subtreeIds(groupId) {
    return new Set([groupId, ...hierarchy().children(groupId).map(c => c.id)]);
}

function groupIcon(g, extra = '') {
    return g.kind === 'partner'
        ? `<i class="ti ti-briefcase text-purple ${extra}" title="Partner"></i>`
        : `<i class="ti ti-building text-azure ${extra}" title="Cliente"></i>`;
}

/** The newest MADMIN version among the active instances in scope. */
function latestVersion() {
    let latest = null;
    for (const i of instances) {
        if (i.status === 'active' && i.madmin_version && (!latest || cmpVersion(i.madmin_version, latest) > 0)) latest = i.madmin_version;
    }
    return latest;
}

const isOutdated = (i, latest) => !!(latest && i.status === 'active' && i.madmin_version && cmpVersion(i.madmin_version, latest) < 0);

function summary(list, latest) {
    const active = list.filter(i => i.status === 'active');
    const online = active.filter(i => i.online).length;
    return { total: list.length, active: active.length, online, offline: active.length - online,
             outdated: active.filter(i => isOutdated(i, latest)).length };
}

const passesStatus = i => (STATUS_FILTERS.find(([v]) => v === filterStatus) || STATUS_FILTERS[0])[2](i);

function passesSearch(i) {
    if (!filterQ) return true;
    const q = filterQ.toLowerCase();
    return [i.name, i.hostname, i.last_ip, i.id, i.external_ref, i.madmin_version,
            ...Object.entries(i.labels || {}).map(([k, v]) => `${k}=${v}`)]
        .some(v => v && String(v).toLowerCase().includes(q));
}

function statusDot(i) {
    if (i.status !== 'active') return '<span class="status-dot bg-secondary"></span>';
    return i.online ? '<span class="status-dot bg-success"></span>' : '<span class="status-dot bg-danger"></span>';
}

function versionTag(i, latest) {
    if (!i.madmin_version) return '';
    const old = isOutdated(i, latest);
    return `<span class="tree-ver ${old ? 'text-warning' : 'text-muted'}"
        title="${old ? `Versione precedente all'ultima nel parco (${escapeHtml(latest)})` : 'Versione MADMIN'}">${escapeHtml(i.madmin_version)}</span>`;
}

function countTag(s) {
    if (!s.active) return '<span class="tree-count text-muted">0</span>';
    return `<span class="tree-count ${s.offline ? 'text-danger' : 'text-success'}"
        title="${s.online} online su ${s.active} attive">${s.online}/${s.active}</span>`;
}

function renderTree() {
    const tree = document.getElementById('inst-tree');
    if (!tree) return;
    const latest = latestVersion();
    const q = filterQ.toLowerCase();
    const { byId, top, children } = hierarchy();
    const shown = instances.filter(passesStatus);

    const leaf = (i, depth) => {
        const title = [i.status === 'active' ? (i.online ? 'Online' : `Offline, ultimo contatto ${relTime(i.last_seen_at)}`)
                                             : (STATUS_LABELS[i.status] || i.status),
                       i.last_ip, i.madmin_version && `MADMIN ${i.madmin_version}`].filter(Boolean).join(' · ');
        return `<a class="tree-node ${i.status !== 'active' ? 'inactive' : ''} ${selected.kind === 'instance' && selected.id === i.id ? 'active' : ''}"
                href="#instances/${escapeHtml(i.id)}" style="--depth:${depth}" title="${escapeHtml(title)}">
            <span class="tree-toggle"></span>${statusDot(i)}
            <span class="tree-name ms-2">${escapeHtml(i.name)}</span>${versionTag(i, latest)}</a>`;
    };

    // A group whose name matches the search shows all its instances
    const node = (g, depth, whole = false) => {
        whole = whole || (q && g.name.toLowerCase().includes(q));
        const kids = children(g.id).map(c => node(c, depth + 1, whole)).filter(Boolean);
        const own = shown.filter(i => i.group_id === g.id && (whole || passesSearch(i)));
        if (q && !whole && !kids.length && !own.length) return '';
        const open = q || !collapsed.has(g.id);
        const toggle = kids.length || own.length
            ? `<span class="tree-toggle" data-toggle="${escapeHtml(g.id)}" title="${open ? 'Comprimi' : 'Espandi'}">
                   <i class="ti ti-chevron-${open ? 'down' : 'right'}"></i></span>`
            : '<span class="tree-toggle"></span>';
        const ids = subtreeIds(g.id);
        return `<a class="tree-node ${selected.kind === 'group' && selected.id === g.id ? 'active' : ''}"
                href="#instances/group/${escapeHtml(g.id)}" style="--depth:${depth}">
                ${toggle}${groupIcon(g)}<span class="tree-name fw-medium ms-2">${escapeHtml(g.name)}</span>
                ${countTag(summary(instances.filter(i => ids.has(i.group_id)), latest))}</a>
            ${open ? kids.join('') + own.map(i => leaf(i, depth + 1)).join('') : ''}`;
    };

    const groupsHtml = top.map(g => node(g, 1)).join('');
    const loose = shown.filter(i => !byId[i.group_id] && passesSearch(i)).map(i => leaf(i, 1)).join('');
    tree.innerHTML = `
        <a class="tree-node ${selected.kind === 'root' ? 'active' : ''}" href="#instances" style="--depth:0">
            <i class="ti ti-sitemap"></i><span class="tree-name fw-bold ms-2">Tutte le istanze</span>
            ${countTag(summary(instances, latest))}</a>
        ${groupsHtml}${loose}
        ${groupsHtml || loose ? '' : `<div class="text-muted small px-3 py-2">${instances.length
            ? 'Nessuna istanza corrisponde ai filtri.' : 'Nessuna istanza registrata.'}</div>`}`;
}

/** Search or status changed: the tree, and the instance table of an overview. */
function onFilter() {
    renderTree();
    if (selected.kind !== 'instance') renderOverviewTable();
}

export async function render(container, params = []) {
    clearInterval(refreshTimer);
    destroyCharts();
    await fetchLists();
    selected = params[0] === 'group' ? { kind: 'group', id: params[1] }
        : params[0] ? { kind: 'instance', id: params[0] } : { kind: 'root', id: null };
    // Enrolled after the lists were cached
    if (selected.kind === 'instance' && !instances.some(i => i.id === selected.id)) await fetchLists(true);

    // What is opened (also from a link elsewhere) is expanded, with its partner
    const { byId } = hierarchy();
    const opened = selected.kind === 'group' ? selected.id : instances.find(i => i.id === selected.id)?.group_id;
    for (let g = byId[opened]; g; g = byId[g.parent_id]) {
        if (collapsed.delete(g.id)) saveCollapsed();
    }

    // On a phone the tree is shown only on the first page
    container.innerHTML = `
        <div class="inst-layout">
            <div class="inst-side ${selected.kind === 'root' ? '' : 'd-none d-lg-block'}">
                <div class="card inst-tree-card">
                    <div class="card-body p-2 border-bottom">
                        <div class="input-icon mb-2">
                            <span class="input-icon-addon"><i class="ti ti-search"></i></span>
                            <input id="inst-q" class="form-control form-control-sm" value="${escapeHtml(filterQ)}"
                                placeholder="Nome, hostname, IP, ID, etichetta, gruppo" aria-label="Cerca">
                        </div>
                        <select id="inst-status" class="form-select form-select-sm" aria-label="Stato">
                            ${STATUS_FILTERS.map(([v, label]) => `<option value="${v}" ${v === filterStatus ? 'selected' : ''}>${label}</option>`).join('')}
                        </select>
                    </div>
                    <div class="inst-tree" id="inst-tree"></div>
                </div>
            </div>
            <div class="inst-main" id="inst-main">${loadingSpinner()}</div>
        </div>`;

    const tree = container.querySelector('#inst-tree');
    tree.addEventListener('scroll', () => { treeScroll = tree.scrollTop; });
    tree.addEventListener('click', (e) => {
        const t = e.target.closest('[data-toggle]');
        if (!t) return;
        e.preventDefault();   // the chevron sits inside the group's link
        collapsed.has(t.dataset.toggle) ? collapsed.delete(t.dataset.toggle) : collapsed.add(t.dataset.toggle);
        saveCollapsed();
        renderTree();
    });
    let debounce;
    container.querySelector('#inst-q').addEventListener('input', (e) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { filterQ = e.target.value.trim(); onFilter(); }, 200);
    });
    container.querySelector('#inst-status').addEventListener('change', (e) => { filterStatus = e.target.value; onFilter(); });
    renderTree();
    tree.scrollTop = treeScroll;
    const active = tree.querySelector('.tree-node.active');
    if (active && (active.offsetTop < tree.scrollTop || active.offsetTop > tree.scrollTop + tree.clientHeight - active.offsetHeight)) {
        tree.scrollTop = active.offsetTop - tree.clientHeight / 2;
    }

    // Online/offline kept current while the page is open
    refreshTimer = setInterval(async () => {
        if (!document.body.contains(tree) || !location.hash.startsWith('#instances')) {
            clearInterval(refreshTimer);
            return;
        }
        try { await fetchLists(true); renderTree(); } catch { /* next round */ }
    }, REFRESH_MS);

    mainEl = container.querySelector('#inst-main');
    try {
        if (selected.kind === 'instance') await renderDetail(mainEl, selected.id, params[1] || 'overview');
        else renderGroup(mainEl, selected.id);
    } catch (e) {
        mainEl.innerHTML = `<div class="card"><div class="card-body text-danger">${escapeHtml(e.message)}</div></div>`;
    }
}

/** Fresh lists, then the tree: after a change made from this page. */
async function reloadTree() {
    try { await fetchLists(true); } catch { return; }
    renderTree();
}

function breadcrumb(groupId, includeLast = true) {
    const { byId } = hierarchy();
    const chain = [];
    for (let g = byId[groupId]; g; g = byId[g.parent_id]) chain.unshift(g);
    if (!includeLast) chain.pop();
    return `<ol class="breadcrumb inst-crumbs mb-1">
        <li class="breadcrumb-item"><a href="#instances"><i class="ti ti-sitemap me-1"></i>Tutte le istanze</a></li>
        ${chain.map(g => `<li class="breadcrumb-item"><a href="#instances/group/${escapeHtml(g.id)}">${groupIcon(g, 'me-1')}${escapeHtml(g.name)}</a></li>`).join('')}
    </ol>`;
}

// ============== OVERVIEW (fleet or group) ==============

const DISK_WARN = 85;
const MEM_WARN = 90;
const ISSUES_SHOWN = 8;

let overviewGroups = null;   // group ids of the overview shown, null = all

function statCard(label, value, cls = '', sub = '') {
    return `
        <div class="col-6 col-xl-3">
            <div class="card card-sm"><div class="card-body">
                <div class="subheader">${label}</div>
                <div class="h1 mb-0 ${cls}">${value}</div>
                ${sub ? `<div class="small text-muted text-truncate">${sub}</div>` : ''}
            </div></div>
        </div>`;
}

function renderGroup(el, groupId) {
    const { byId, top, children } = hierarchy();
    const g = groupId ? byId[groupId] : null;
    const manager = checkPermission('manager.manage');
    const actions = [];
    if (manager) actions.push(`<button class="btn btn-outline-primary" ${actionAttrs('managerGroups')}><i class="ti ti-folders me-1"></i>Gruppi</button>`);
    if (manager && g) {
        actions.push(`<button class="btn btn-outline-primary" ${actionAttrs('managerGroupEdit')}><i class="ti ti-edit me-1"></i>Modifica</button>`);
        actions.push(`<button class="btn btn-outline-danger" ${actionAttrs('managerGroupDelete')}><i class="ti ti-trash me-1"></i>Elimina</button>`);
    }
    setPageActions(`<div class="btn-list">${actions.join('')}</div>`);
    if (groupId && !g) {
        overviewGroups = new Set();
        el.innerHTML = `<div class="card"><div class="card-body text-muted">Gruppo non trovato.</div></div>`;
        return;
    }

    overviewGroups = g ? subtreeIds(g.id) : null;
    const list = instances.filter(i => !overviewGroups || overviewGroups.has(i.group_id));
    const latest = latestVersion();
    const s = summary(list, latest);
    const active = list.filter(i => i.status === 'active');

    // Versions of the active instances, newest first
    const versions = {};
    for (const i of active) versions[i.madmin_version || '?'] = (versions[i.madmin_version || '?'] || 0) + 1;
    const versionRows = Object.entries(versions).sort((a, b) => cmpVersion(b[0], a[0])).map(([v, n]) => `
        <tr><td class="font-monospace">${escapeHtml(v)}
                ${v === latest ? '<span class="badge bg-success-lt ms-1">ultima</span>' : ''}</td>
            <td style="width: 45%"><div class="progress progress-sm"><div class="progress-bar ${v === latest ? 'bg-success' : 'bg-warning'}"
                style="width: ${Math.round(n * 100 / active.length)}%"></div></div></td>
            <td class="text-end">${n}</td></tr>`).join('')
        || '<tr><td class="text-muted">Nessuna istanza attiva</td></tr>';

    // What needs a look: offline, nearly full, behind
    const issues = [];
    for (const i of active) {
        const st = i.stats || {};
        if (!i.online) issues.push([i, 'ti-plug-connected-x text-danger', `Offline, ultimo contatto ${relTime(i.last_seen_at)}`]);
        else {
            if (st.disk_percent >= DISK_WARN) issues.push([i, 'ti-database text-warning', `Disco al ${Math.round(st.disk_percent)}%`]);
            if (st.mem_percent >= MEM_WARN) issues.push([i, 'ti-cpu text-warning', `RAM al ${Math.round(st.mem_percent)}%`]);
        }
        if (isOutdated(i, latest)) issues.push([i, 'ti-arrow-up-circle text-warning', `MADMIN ${escapeHtml(i.madmin_version)}, ultima ${escapeHtml(latest)}`]);
    }
    const issueRows = issues.slice(0, ISSUES_SHOWN).map(([i, icon, text]) => `
        <tr class="cursor-pointer" ${actionAttrs('managerOpenInstance', i.id)}>
            <td style="width: 1%"><i class="ti ${icon}"></i></td>
            <td><strong>${escapeHtml(i.name)}</strong></td><td class="text-muted">${text}</td></tr>`).join('');

    // Children: the customers of a partner, the top-level groups of the fleet
    const subgroups = g ? children(g.id) : top;
    const groupRows = subgroups.map(c => {
        const ids = subtreeIds(c.id);
        const cs = summary(instances.filter(i => ids.has(i.group_id)), latest);
        return `<tr>
            <td><a href="#instances/group/${escapeHtml(c.id)}">${groupIcon(c, 'me-1')}${escapeHtml(c.name)}</a></td>
            <td class="text-muted">${c.kind === 'partner' ? 'Partner' : 'Cliente'}</td>
            <td class="text-end">${cs.active}</td>
            <td class="text-end text-success">${cs.online}</td>
            <td class="text-end ${cs.offline ? 'text-danger' : 'text-muted'}">${cs.offline}</td>
            <td class="text-end ${cs.outdated ? 'text-warning' : 'text-muted'}">${cs.outdated}</td></tr>`;
    }).join('');

    el.innerHTML = `
        <div class="mb-3">
            ${g ? breadcrumb(g.id, false) : ''}
            <h2 class="mb-0">${g ? `${groupIcon(g, 'me-1')}${escapeHtml(g.name)}
                <span class="badge ${g.kind === 'partner' ? 'bg-purple-lt' : 'bg-azure-lt'} ms-1">${g.kind === 'partner' ? 'Partner' : 'Cliente'}</span>`
                : '<i class="ti ti-sitemap me-1"></i>Tutte le istanze'}</h2>
            ${g?.description ? `<div class="text-muted">${escapeHtml(g.description)}</div>` : ''}
        </div>
        <div class="row row-cards mb-3">
            ${statCard('Istanze attive', s.active, '', s.total > s.active ? `${s.total - s.active} revocate o dismesse` : '')}
            ${statCard('Online', s.online, 'text-success', s.active ? `${Math.round(s.online * 100 / s.active)}%` : '')}
            ${statCard('Offline', s.offline, s.offline ? 'text-danger' : '')}
            ${statCard('Da aggiornare', s.outdated, s.outdated ? 'text-warning' : '', latest ? `ultima versione ${escapeHtml(latest)}` : '')}
        </div>
        <div class="row row-cards mb-3">
            <div class="col-lg-5">
                <div class="card h-100">
                    <div class="card-header"><h3 class="card-title">Versioni MADMIN</h3></div>
                    <table class="table card-table table-vcenter"><tbody>${versionRows}</tbody></table>
                </div>
            </div>
            <div class="col-lg-7">
                <div class="card h-100">
                    <div class="card-header"><h3 class="card-title">Da controllare</h3>
                        ${issues.length ? `<div class="card-actions"><span class="badge bg-warning-lt">${issues.length}</span></div>` : ''}</div>
                    ${issues.length ? `<div class="table-responsive"><table class="table card-table table-vcenter table-hover"><tbody>${issueRows}</tbody></table></div>
                        ${issues.length > ISSUES_SHOWN ? `<div class="card-footer text-muted small">e altre ${issues.length - ISSUES_SHOWN} segnalazioni</div>` : ''}`
                        : '<div class="card-body text-muted"><i class="ti ti-circle-check text-success me-1"></i>Tutte le istanze attive sono online e aggiornate.</div>'}
                </div>
            </div>
        </div>
        ${subgroups.length ? `
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title">${g ? 'Clienti' : 'Partner e clienti'}</h3></div>
            <div class="table-responsive"><table class="table card-table table-vcenter">
                <thead><tr><th>Gruppo</th><th>Tipo</th><th class="text-end">Attive</th><th class="text-end">Online</th>
                    <th class="text-end">Offline</th><th class="text-end">Da aggiornare</th></tr></thead>
                <tbody>${groupRows}</tbody></table></div>
        </div>` : ''}
        <div class="card">
            <div class="card-header"><h3 class="card-title">Istanze</h3><div class="card-actions text-muted small" id="ov-inst-count"></div></div>
            <div id="ov-inst-table"></div>
        </div>`;
    renderOverviewTable();
}

/** Instances of the overview shown, with the filters of the tree. */
function renderOverviewTable() {
    const box = document.getElementById('ov-inst-table');
    if (!box) return;
    const all = instances.filter(i => !overviewGroups || overviewGroups.has(i.group_id));
    const rows = all.filter(i => passesStatus(i) && passesSearch(i));
    const latest = latestVersion();
    // A customer's page has a single group: no column for it
    const showGroup = !overviewGroups || overviewGroups.size > 1;
    document.getElementById('ov-inst-count').textContent =
        rows.length === all.length ? `${all.length}` : `${rows.length} di ${all.length} (filtri a sinistra)`;
    box.innerHTML = rows.length ? `
        <div class="table-responsive">
            <table class="table card-table table-vcenter table-hover">
                <thead><tr><th>Stato</th><th>Nome</th>${showGroup ? '<th>Gruppo</th>' : ''}<th>Versione</th>
                    <th>IP sorgente</th><th style="min-width: 170px">Risorse</th><th>Ultimo contatto</th></tr></thead>
                <tbody>${rows.map(i => {
                    const st = i.stats || {};
                    return `
                    <tr class="cursor-pointer" ${actionAttrs('managerOpenInstance', i.id)}>
                        <td>${onlineBadge(i)}</td>
                        <td><strong>${escapeHtml(i.name)}</strong>
                            ${i.hostname && i.hostname !== i.name ? `<div class="small text-muted">${escapeHtml(i.hostname)}</div>` : ''}
                            ${i.external_ref ? `<div class="small text-muted font-monospace">${escapeHtml(i.external_ref)}</div>` : ''}
                            <div>${labelBadges(i.labels)}</div></td>
                        ${showGroup ? `<td class="text-muted">${escapeHtml(groupPath(groups, i.group_id) || '-')}</td>` : ''}
                        <td class="font-monospace ${isOutdated(i, latest) ? 'text-warning' : ''}">${escapeHtml(i.madmin_version || '-')}</td>
                        <td class="font-monospace">${escapeHtml(i.last_ip || '-')}</td>
                        <td>${i.online && st.cpu_percent !== undefined
                            ? meter('CPU', st.cpu_percent) + meter('RAM', st.mem_percent) + meter('Disco', st.disk_percent)
                            : '<span class="text-muted">-</span>'}</td>
                        <td>${i.online ? 'ora' : relTime(i.last_seen_at)}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
        </div>`
        : `<div class="card-body text-muted">${all.length ? 'Nessuna istanza corrisponde ai filtri.'
            : 'Nessuna istanza. Crea un token in Enrollment e installa MADMIN con --manager-token-file.'}</div>`;
}

function groupsModal() {
    const kindLabel = k => k === 'partner'
        ? '<span class="badge bg-purple-lt"><i class="ti ti-briefcase me-1"></i>partner</span>'
        : '<span class="badge bg-azure-lt"><i class="ti ti-building me-1"></i>cliente</span>';
    const list = () => groups.map(g => `
        <tr><td>${g.parent_id ? '<span class="text-muted ms-3">└</span> ' : ''}${escapeHtml(g.name)} ${kindLabel(g.kind)}</td>
        <td class="text-muted">${escapeHtml(g.description)}</td><td>${g.instances}</td>
        <td class="text-end"><button type="button" class="btn btn-sm btn-ghost-danger" data-del="${escapeHtml(g.id)}">
        <i class="ti ti-trash"></i></button></td></tr>`).join('') || '<tr><td class="text-muted">Nessun gruppo</td></tr>';
    const parentSelect = () => groupOptions(groups, '', { none: 'Sito principale (primo livello)', partnersOnly: true });
    const changed = async () => {
        await fetchLists(true);
        el.querySelector('#grp-list').innerHTML = list();
        el.querySelector('#grp-parent').innerHTML = parentSelect();
        renderTree();
    };
    const el = formModal('Partner e clienti', `
        <p class="text-muted small">Il sito principale vede tutto. Sotto ci sono clienti diretti, oppure partner con i propri clienti.</p>
        <table class="table table-sm"><thead><tr><th>Gruppo</th><th>Descrizione</th><th>Istanze</th><th></th></tr></thead>
            <tbody id="grp-list">${list()}</tbody></table>
        ${formSection('Nuovo gruppo')}
        <div class="row g-2">
            ${field('name', 'Nome', { required: true, maxlength: 100, col: 'col-md-4', example: 'Rossi S.p.A.' })}
            ${field('kind', 'Tipo', { type: 'select', required: true, col: 'col-md-3', options: [['customer', 'Cliente'], ['partner', 'Partner']] })}
            <div class="col-md-5"><label class="form-label">Sotto<span class="text-muted small fw-normal ms-1">facoltativo</span></label>
                <select name="parent_id" class="form-select" id="grp-parent">${parentSelect()}</select>
                <div class="invalid-feedback"></div><div class="form-hint">un partner sta solo al primo livello</div></div>
            ${field('description', 'Descrizione', { maxlength: 500, col: 'col-12' })}
        </div>`, async (form) => {
        const d = formData(form);
        if (d.kind === 'partner' && d.parent_id) return fieldError(form, 'parent_id', 'Un partner sta solo al primo livello');
        await apiPost('/groups', { name: d.name, kind: d.kind, parent_id: d.parent_id || null, description: d.description });
        form.reset();
        await changed();
        return false;
    }, { submitText: 'Aggiungi gruppo', size: 'lg', icon: 'ti-folders' });
    // The overview counts the groups too
    el.addEventListener('hidden.bs.modal', () => {
        if (selected.kind !== 'instance' && document.body.contains(mainEl)) renderGroup(mainEl, selected.id);
    });
    el.addEventListener('click', async (e) => {
        const id = e.target.closest('[data-del]')?.dataset.del;
        if (!id) return;
        try {
            await apiDelete(`/groups/${id}`);
            await changed();
        } catch (err) { showToast(err.message, 'error'); }
    });
}

// ============== DETAIL ==============

async function renderDetail(container, id, tab) {
    destroyCharts();
    current = await apiGet(`/instances/${encodeURIComponent(id)}`);
    const i = current;
    const tabs = TABS.filter(([, , perm]) => checkPermission(perm));
    if (!tabs.some(([t]) => t === tab)) tab = 'overview';

    const actions = [];
    if (i.online && checkPermission('scope.manage')) actions.push(`<button class="btn btn-outline-secondary" ${actionAttrs('managerRefresh')}><i class="ti ti-refresh me-1"></i>Aggiorna dati</button>`);
    if (checkPermission('scope.manage')) actions.push(`<button class="btn btn-outline-primary" ${actionAttrs('managerEdit')}><i class="ti ti-edit me-1"></i>Modifica</button>`);
    if (checkPermission('manager.manage') && i.status !== 'revoked') actions.push(`<button class="btn btn-outline-primary" ${actionAttrs('managerReenroll')}><i class="ti ti-key me-1"></i>Token re-enroll</button>`);
    if (checkPermission('manager.manage') && i.status === 'active' && i.layout >= 1) actions.push(`<button class="btn btn-outline-primary" ${actionAttrs('managerUpdate')}><i class="ti ti-package me-1"></i>Aggiorna</button>`);
    if (checkPermission('manager.manage') && i.status === 'active') actions.push(`<button class="btn btn-outline-secondary" ${actionAttrs('managerRelocate')}><i class="ti ti-arrows-exchange me-1"></i>Cambia indirizzo</button>`);
    if (checkPermission('manager.manage') && i.status === 'active') actions.push(`<button class="btn btn-outline-warning" ${actionAttrs('managerSuspend')}><i class="ti ti-player-pause me-1"></i>Sospendi</button>`);
    if (checkPermission('manager.manage') && i.status === 'suspended') actions.push(`<button class="btn btn-outline-success" ${actionAttrs('managerResume')}><i class="ti ti-player-play me-1"></i>Riattiva</button>`);
    if (checkPermission('manager.manage') && ['active', 'suspended'].includes(i.status)) actions.push(`<button class="btn btn-outline-danger" ${actionAttrs('managerRevoke')}><i class="ti ti-ban me-1"></i>Revoca</button>`);
    if (checkPermission('manager.manage') && !['active', 'suspended'].includes(i.status)) actions.push(`<button class="btn btn-danger" ${actionAttrs('managerDelete')}><i class="ti ti-trash me-1"></i>Elimina</button>`);
    setPageActions(`<div class="btn-list">${actions.join('')}</div>`);

    container.innerHTML = `
        <div class="mb-3">
            ${breadcrumb(i.group_id)}
            <h2 class="mb-0">${escapeHtml(i.name)} ${onlineBadge(i)}</h2>
            <div class="text-muted small font-monospace">${escapeHtml(i.id)}</div>
            <div class="mt-1">${labelBadges(i.labels)}</div>
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
    const renderers = { overview, addresses, backups, licenses, packages, support, commands };
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
        ${rescueCard(i)}
        <div class="card-body border-bottom">
            <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
                <h4 class="mb-0 flex-fill"><i class="ti ti-chart-line me-2"></i>Risorse e traffico</h4>
                <select class="form-select form-select-sm d-none" id="ov-iface" style="width: auto; min-width: 120px;"
                        aria-label="Interfaccia"></select>
                <div class="btn-group" role="group" aria-label="Periodo">
                    ${[1, 6, 24].map(h => `
                        <input type="radio" class="btn-check" name="ov-range" id="ov-range-${h}" value="${h}" ${h === statsHours ? 'checked' : ''}>
                        <label class="btn btn-sm" for="ov-range-${h}">${h}h</label>`).join('')}
                </div>
            </div>
            <div id="ov-charts">${loadingSpinner()}</div>
        </div>
        <div class="card-body">
            <div class="row g-4">
                <div class="col-lg-6">${kv([
                    ['Hostname', escapeHtml(f.hostname || i.hostname || '-')],
                    ['Versione MADMIN', escapeHtml(i.madmin_version || '-')],
                    ['Build', `<span class="font-monospace">${escapeHtml(i.build || '-')}</span>${i.layout < 1 ? ' <span class="badge bg-secondary-lt" title="Installazione senza updater: per aggiornarla va reinstallata">senza updater</span>' : ''}`],
                    ['Ultimo aggiornamento', updateText(i.update)],
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
                    ['Ultimi CPU / RAM / disco', st.cpu_percent !== undefined ? `${st.cpu_percent}% / ${st.mem_percent}% / ${st.disk_percent}%` : '-'],
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

    el.querySelectorAll('input[name="ov-range"]').forEach(r => r.addEventListener('change', () => {
        statsHours = Number(r.value);
        loadStats(i);
    }));
    el.querySelector('#ov-iface').addEventListener('change', (e) => {
        statsIface = e.target.value;
        renderNetChart();
    });
    loadStats(i);  // not awaited: the rest of the page is already usable
}

// ============== RESOURCE AND TRAFFIC GRAPHS (overview) ==============
// The instance keeps 24 h of samples (one a minute); the manager asks for them
// when the page opens (GET /instances/<id>/stats) and stores nothing.

let statsHours = 1;
let statsIface = '';
let statsData = null;
let statsRequest = 0;
let charts = [];
let netChart = null;

const STATS_UNAVAILABLE = {
    offline: ['ti-plug-connected-x', 'Istanza offline: lo storico è disponibile quando l\'istanza è connessa.'],
    unsupported: ['ti-alert-triangle', 'La versione di MADMIN dell\'istanza non fornisce lo storico delle risorse: aggiornarla.'],
    timeout: ['ti-clock', 'L\'istanza non ha risposto in tempo.'],
    error: ['ti-alert-circle', 'L\'istanza non ha potuto fornire lo storico.'],
};

function destroyCharts() {
    charts.forEach(c => c.destroy());
    charts = [];
    if (netChart) { netChart.destroy(); netChart = null; }
}

function hhmm(iso) {
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');  // naive UTC from the instance
    return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function areaOptions(series, colors, categories, height, yaxis, tooltip) {
    return {
        series,
        chart: { type: 'area', height, animations: { enabled: false }, toolbar: { show: false }, zoom: { enabled: false } },
        dataLabels: { enabled: false },
        stroke: { curve: 'smooth', width: 2 },
        fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.4, opacityTo: 0.1 } },
        colors,
        legend: { show: series.length > 1, position: 'top', horizontalAlign: 'right' },
        xaxis: { categories, labels: { show: false }, axisBorder: { show: false }, axisTicks: { show: false },
                 tooltip: { enabled: false } },
        yaxis,
        tooltip,
        grid: { show: true, borderColor: '#e0e0e0', strokeDashArray: 3, padding: { left: 5, right: 5 } },
    };
}

async function loadStats(i) {
    const box = document.getElementById('ov-charts');
    if (!box) return;
    const request = ++statsRequest;
    box.innerHTML = loadingSpinner();
    let data;
    try {
        data = await apiGet(`/instances/${i.id}/stats?hours=${statsHours}`);
    } catch (e) {
        data = { available: false, reason: 'error', error: e.message };
    }
    // Another range was chosen meanwhile, or the page was left
    if (request !== statsRequest || !document.body.contains(box)) return;
    destroyCharts();
    statsData = data;
    const ifaceSelect = document.getElementById('ov-iface');

    if (!data.available) {
        const [icon, text] = STATS_UNAVAILABLE[data.reason] || STATS_UNAVAILABLE.error;
        ifaceSelect.classList.add('d-none');
        box.innerHTML = `
            <div class="text-muted text-center py-4">
                <i class="ti ${icon} me-1"></i>${escapeHtml(text)}
                ${data.error ? `<div class="small mt-1">${escapeHtml(data.error)}</div>` : ''}
                ${data.reason === 'timeout' || data.reason === 'error'
                    ? `<div class="mt-2"><button type="button" class="btn btn-sm btn-outline-primary" id="ov-retry">
                        <i class="ti ti-refresh me-1"></i>Riprova</button></div>` : ''}
            </div>`;
        box.querySelector('#ov-retry')?.addEventListener('click', () => loadStats(i));
        return;
    }

    const sys = data.system || { t: [] };
    const ifaces = Object.keys(data.network || {});
    if (!ifaces.includes(statsIface)) statsIface = ifaces[0] || '';
    ifaceSelect.innerHTML = ifaces.map(n =>
        `<option value="${escapeHtml(n)}" ${n === statsIface ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
    ifaceSelect.classList.toggle('d-none', ifaces.length === 0);

    if (!sys.t.length) {
        box.innerHTML = `<div class="text-muted text-center py-4"><i class="ti ti-clock me-1"></i>
            Dati non ancora disponibili: l'istanza raccoglie un campione al minuto.</div>`;
        return;
    }

    const last = (arr) => arr.length ? arr[arr.length - 1] : 0;
    const total = (bytes) => bytes ? ` · ${formatBytes(bytes)}` : '';
    box.innerHTML = `
        <div class="row g-3">
            <div class="col-md-4">
                <div class="subheader d-flex">CPU<span class="ms-auto text-body">${last(sys.cpu)}%</span></div>
                <div id="ov-chart-cpu"></div>
            </div>
            <div class="col-md-4">
                <div class="subheader d-flex">RAM${total(sys.ram_total)}<span class="ms-auto text-body">${last(sys.ram)}%</span></div>
                <div id="ov-chart-ram"></div>
            </div>
            <div class="col-md-4">
                <div class="subheader d-flex">Disco${total(sys.disk_total)}<span class="ms-auto text-body">${last(sys.disk)}%</span></div>
                <div id="ov-chart-disk"></div>
            </div>
            <div class="col-12">
                <div class="subheader d-flex">Traffico di rete<span class="ms-auto text-body" id="ov-net-last"></span></div>
                <div id="ov-chart-net"></div>
            </div>
        </div>`;

    const cats = sys.t.map(hhmm);
    const pct = { min: 0, max: 100, tickAmount: 4, labels: { formatter: v => `${Math.round(v)}%` } };
    const pctTip = { y: { formatter: v => `${Number(v).toFixed(1)}%` } };
    for (const [id, key, name, color] of [['ov-chart-cpu', 'cpu', 'CPU', '#206bc4'],
                                          ['ov-chart-ram', 'ram', 'RAM', '#2fb344'],
                                          ['ov-chart-disk', 'disk', 'Disco', '#f76707']]) {
        const chart = new ApexCharts(document.getElementById(id),
            areaOptions([{ name, data: sys[key] }], [color], cats, 140, pct, pctTip));
        chart.render();
        charts.push(chart);
    }
    renderNetChart();
}

/** Traffic of the selected interface, bytes/s shown as Mb/s (Kb/s when small), as in MADMIN. */
function renderNetChart() {
    const box = document.getElementById('ov-chart-net');
    if (!box || !statsData?.available) return;
    if (netChart) { netChart.destroy(); netChart = null; }
    const series = (statsData.network || {})[statsIface];
    const lastEl = document.getElementById('ov-net-last');
    if (!series || !series.t.length) {
        box.innerHTML = '<div class="text-muted text-center py-4">Nessun dato di traffico per questa interfaccia.</div>';
        if (lastEl) lastEl.textContent = '';
        return;
    }
    box.innerHTML = '';
    const mbit = v => (v * 8) / 1_000_000;
    const max = Math.max(...series.tx.map(mbit), ...series.rx.map(mbit));
    const [unit, scale] = max < 0.01 ? ['Kb/s', 1000] : ['Mb/s', 1];
    const conv = arr => arr.map(v => Number((mbit(v) * scale).toFixed(3)));
    const tx = conv(series.tx), rx = conv(series.rx);
    netChart = new ApexCharts(box, areaOptions(
        [{ name: 'TX', data: tx }, { name: 'RX', data: rx }], ['#f76707', '#206bc4'],
        series.t.map(hhmm), 200,
        { min: 0, tickAmount: 4, labels: { formatter: v => `${Number(v).toFixed(v < 10 ? 1 : 0)} ${unit}` } },
        { y: { formatter: v => `${Number(v).toFixed(2)} ${unit}` } }));
    netChart.render();
    if (lastEl) lastEl.textContent = `TX ${tx[tx.length - 1]} · RX ${rx[rx.length - 1]} ${unit}`;
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
    const manage = checkPermission('scope.manage');
    const canRestore = checkPermission('scope.manage') && i.status === 'active';
    el.innerHTML = `
        ${manage && i.status === 'active' ? `<div class="card-body border-bottom">
            <button class="btn btn-primary" ${actionAttrs('managerBackupRun')}><i class="ti ti-database-export me-1"></i>Esegui backup ora</button>
            <span class="text-muted ms-2 small">${i.online ? '' : "L'istanza è offline: il backup partirà alla riconnessione (entro 1 ora)."}</span>
        </div>` : ''}
        <div class="table-responsive"><table class="table card-table table-vcenter">
            <thead><tr><th>Data</th><th>Dimensione</th><th>Versione</th><th>Origine</th><th></th></tr></thead>
            <tbody>${rows.map(b => `<tr>
                <td>${fmtDate(b.created_at)}</td><td>${formatBytes(b.size)}</td>
                <td>${escapeHtml(b.madmin_version || '-')}</td>
                <td>${b.trigger === 'scheduled' ? 'Pianificato' : escapeHtml(b.created_by || 'manuale')}</td>
                <td class="text-end"><div class="btn-list justify-content-end">
                    ${manage ? `<button class="btn btn-sm btn-outline-secondary" ${actionAttrs('managerBackupDownload', b.id)}><i class="ti ti-download"></i></button>` : ''}
                    ${canRestore ? `<button class="btn btn-sm btn-outline-warning" ${actionAttrs('managerBackupRestore', b.id, b.created_at)}>Ripristina</button>` : ''}
                    ${manage ? `<button class="btn btn-sm btn-ghost-danger" ${actionAttrs('managerBackupDelete', b.id)}><i class="ti ti-trash"></i></button>` : ''}
                </div></td></tr>`).join('') || '<tr><td colspan="5" class="text-muted">Nessun backup</td></tr>'}
            </tbody></table></div>`;
}

async function licenses(el, i) {
    const rows = await apiGet(`/licenses?instance_id=${i.id}`);
    const manage = checkPermission('manager.manage') && i.status === 'active';
    el.innerHTML = `
        ${manage ? `<div class="card-body border-bottom"><button class="btn btn-primary" ${actionAttrs('managerLicenseNew')}>
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
            <td class="text-end">${manage && l.active ? `<button class="btn btn-sm btn-outline-danger" ${actionAttrs('managerLicenseRevoke', l.id)}>Revoca</button>` : ''}</td>
        </tr>`).join('') || `<tr><td colspan="${showInstance ? 7 : 6}" class="text-muted">Nessuna licenza</td></tr>`}
        </tbody></table></div>`;
}

async function support(el, i) {
    const rows = await apiGet(`/instances/${i.id}/support`);
    const can = i.status === 'active' && i.online;
    if (!checkPermission('manager.manage')) {
        el.innerHTML = sessionTable(rows);
        return;
    }
    el.innerHTML = `
        <div class="card-body border-bottom">
            <div class="btn-list">
                <button class="btn btn-primary" ${can ? '' : 'disabled'} ${actionAttrs('managerSupportUi')}><i class="ti ti-browser me-1"></i>Accesso UI superuser</button>
                <button class="btn btn-primary" ${can ? '' : 'disabled'} ${actionAttrs('managerSupportSsh')}><i class="ti ti-terminal-2 me-1"></i>Accesso SSH root</button>
            </div>
            ${can ? '' : '<div class="text-muted small mt-2">L\'istanza deve essere online.</div>'}
            <div class="text-muted small mt-2">Ogni accesso è temporaneo, raggiungibile solo dal tuo IP e registrato nell'audit log dell'istanza come manager:&lt;operatore&gt;.</div>
        </div>
        ${sessionTable(rows)}`;
}

const SESSION_STATUS = { closed: 'chiusa', expired: 'scaduta', replaced: 'sostituita' };

export function sessionTable(rows, showInstance = false) {
    return `<div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr>${showInstance ? '<th>Istanza</th>' : ''}<th>Tipo</th><th>Operatore</th><th>Motivo</th><th>Porta</th>
            <th>IP ammesso</th><th>Scade</th><th>Stato</th><th></th></tr></thead>
        <tbody>${rows.map(s => `<tr>
            ${showInstance ? `<td><a href="#instances/${escapeHtml(s.instance_id)}/support">${escapeHtml(s.instance_name)}</a></td>` : ''}
            <td>${s.kind === 'ui' ? 'UI' : 'SSH'}</td><td>${escapeHtml(s.operator)}${s.key_fingerprint
                ? `<div class="small text-muted font-monospace">${escapeHtml(s.key_fingerprint)}</div>` : ''}</td>
            <td class="text-muted">${escapeHtml(s.reason)}</td><td>${s.port}</td>
            <td class="font-monospace">${escapeHtml(s.allowed_ip)}</td><td>${fmtDate(s.expires_at)}</td>
            <td>${s.status === 'open' ? '<span class="badge bg-warning-lt">aperta</span>' : `<span class="badge bg-secondary-lt">${escapeHtml(SESSION_STATUS[s.status] || s.status)}</span>`}</td>
            <td class="text-end"><div class="btn-list justify-content-end">${s.status === 'open' && checkPermission('manager.manage') ? `
                ${s.kind === 'ui' ? `<button class="btn btn-sm btn-outline-primary" ${actionAttrs('managerSupportTicket', s.id)}>Nuovo link</button>` : ''}
                <button class="btn btn-sm btn-outline-danger" ${actionAttrs('managerSupportClose', s.id)}>Chiudi</button>` : ''}</div></td>
        </tr>`).join('') || `<tr><td colspan="${showInstance ? 9 : 8}" class="text-muted">Nessuna sessione</td></tr>`}
        </tbody></table></div>`;
}

async function packages(el, i) {
    // Only the fixable findings come in full; the rest is grouped by package and
    // each package's list is loaded when it is opened (hundreds of kernel CVEs).
    const [inv, fixable, byPackage, changes] = await Promise.all([
        apiGet(`/instances/${i.id}/inventory`), apiGet(`/instances/${i.id}/findings?fixable=true`),
        apiGet(`/instances/${i.id}/findings/packages`), apiGet(`/instances/${i.id}/inventory/changes?limit=20`)]);
    const st = inv.os_status || {};
    const sec = inv.sections || {};
    const secInfo = (n) => sec[n] ? `${sec[n].count} · ${sec[n].updated_at ? relTime(sec[n].updated_at) : 'mai'}${sec[n].pending ? ' · <span class="text-warning">aggiornamento in corso</span>' : ''}` : 'non ancora ricevuto';
    const trial = st.kernel_trial;
    const TRIAL = { pending: ['bg-warning-lt', 'in prova'], confirmed: ['bg-success-lt', 'confermato'], failed: ['bg-danger-lt', 'fallito'] };
    const osManage = checkPermission('manager.manage') && i.status === 'active' && i.layout >= 1;
    const osActions = osManage ? `<div class="btn-list mb-3">
        <button class="btn btn-sm btn-outline-secondary" ${actionAttrs('managerOsRefresh')}><i class="ti ti-refresh me-1"></i>Aggiorna liste</button>
        <button class="btn btn-sm btn-outline-primary" ${actionAttrs('managerOsUpgrade', 'security')}><i class="ti ti-shield-check me-1"></i>Aggiornamenti di sicurezza</button>
        <button class="btn btn-sm btn-outline-primary" ${actionAttrs('managerOsUpgrade', 'all')}><i class="ti ti-package me-1"></i>Aggiorna tutto</button>
        <button class="btn btn-sm btn-outline-warning" ${actionAttrs('managerOsReboot')}><i class="ti ti-power me-1"></i>Riavvia</button>
        ${st.reboot_scheduled_at ? `<button class="btn btn-sm btn-outline-danger" ${actionAttrs('managerOsRebootCancel')}><i class="ti ti-x me-1"></i>Annulla riavvio</button>` : ''}
    </div>` : '';
    const ss = inv.statuses || {};
    const total = Object.values(inv.findings || {}).reduce((n, x) => n + x, 0);
    const sevList = (counts, quiet) => Object.entries(counts).filter(([, n]) => n)
        .map(([s, n]) => `${severityBadge(s, quiet)} ${n}`).join(' &nbsp; ');
    const findingRow = (f, withPackage) => `<tr><td>${advisoryLink(f)}</td><td>${severityBadge(f.severity, !f.fixed_version)}</td>
        ${withPackage ? `<td>${escapeHtml(f.package)}${f.kind === 'python' ? ' <span class="badge bg-blue-lt">py</span>' : ''}</td>
        <td class="font-monospace small">${escapeHtml(f.installed_version)}</td>` : ''}
        <td>${statusCell(f)}</td></tr>`;
    // One sentence that says whether there is something to do on this instance
    const verdict = !total ? ['alert-success', 'Nessuna vulnerabilità nota.']
        : inv.fixable ? ['alert-warning', [
            inv.fixable_os ? `${inv.fixable_os} vulnerabilità si correggono con gli aggiornamenti del sistema già disponibili: <b>Aggiornamenti di sicurezza</b> (o <b>Aggiorna tutto</b>)${st.reboot_required ? ', poi riavvio' : ''}.` : '',
            inv.fixable_release ? `${inv.fixable_release} riguardano pacchetti Python di MADMIN: serve una <b>release di MADMIN</b> che includa la versione corretta (Aggiorna MADMIN).` : '',
        ].filter(Boolean).join('<br>')]
        : st.reboot_required ? ['alert-warning', 'Aggiornamenti installati: serve il <b>riavvio</b> per applicarli.']
        : ['alert-info', `Il sistema è aggiornato: nessuna delle ${total} vulnerabilità ha una correzione installabile ora.
            ${ss.pending ? `${ss.pending} hanno la correzione già preparata da Ubuntu (arriverà con i prossimi aggiornamenti).` : ''}
            ${ss.stale ? `${ss.stale} risultano probabilmente già corrette (dati Ubuntu non ancora aggiornati).` : ''}`];
    const kf = inv.kernel_fix;
    const hweMeta = inv.os_id && inv.os_id.startsWith('ubuntu-') ? `linux-generic-hwe-${inv.os_id.slice(7)}` : 'linux-generic-hwe';
    el.innerHTML = `<div class="card-body">
        ${osActions}
        <div class="row g-3">
            <div class="col-lg-5">${kv([
                ['Sistema', escapeHtml(inv.os || '-')],
                ...(st.reboot_scheduled_at ? [['Riavvio programmato', `<span class="badge bg-warning-lt">${fmtDate(new Date(st.reboot_scheduled_at * 1000).toISOString())}</span>`]] : []),
                ...(trial ? [['Kernel in prova', `<span class="font-monospace">${escapeHtml(trial.kernel)}</span>
                    <span class="badge ${(TRIAL[trial.result] || TRIAL.pending)[0]}">${(TRIAL[trial.result] || [, trial.result])[1]}</span>
                    ${trial.detail ? `<div class="small text-muted">${escapeHtml(trial.detail)}</div>` : ''}`]] : []),
                ['Kernel in esecuzione', `<span class="font-monospace">${escapeHtml(st.running_kernel || inv.kernel || '-')}</span>`],
                ['Kernel più recente', `<span class="font-monospace">${escapeHtml(st.newest_kernel || '-')}</span>`],
                ['Riavvio richiesto', st.reboot_required
                    ? `<span class="badge bg-warning-lt">sì</span> <span class="small text-muted">${escapeHtml((st.reboot_packages || []).join(', '))}</span>` : 'no'],
                ['Aggiornamenti in sospeso', st.pending_updates == null ? '-' : `${st.pending_updates} (${st.pending_security || 0} di sicurezza)`],
                ['Liste pacchetti', st.apt_updated_at ? relTime(new Date(st.apt_updated_at * 1000).toISOString()) : '-'],
                ['Aggiornamenti automatici', st.unattended_upgrades == null ? '-' : st.unattended_upgrades ? 'attivi' : 'disattivi'],
                ['Pacchetti OS', secInfo('packages')],
                ['Pacchetti Python', secInfo('python')],
            ])}</div>
            <div class="col-lg-7">
                <div class="alert ${verdict[0]} py-2 mb-2">${verdict[1]}</div>
                ${total ? `<div class="mb-1 small"><span class="text-muted">Gravità:</span> ${sevList(inv.findings, true)}</div>
                    <div class="mb-2 small"><span class="text-muted">Stato Ubuntu:</span> ${Object.entries(ss).filter(([, n]) => n).map(([s, n]) => `${statusBadge(s)} ${n}`).join(' &nbsp; ')}</div>` : ''}
                ${kf ? `<div class="alert alert-secondary py-2 small mb-2">
                    <b>${kf.count}</b> vulnerabilità del kernel${kf.critical || kf.high ? ` (${[kf.critical ? `${kf.critical} critiche` : '', kf.high ? `${kf.high} alte` : ''].filter(Boolean).join(', ')})` : ''}
                    sono già corrette (o non presenti) nel kernel HWE <span class="font-monospace">${escapeHtml(kf.source)}</span>.
                    Il kernel in uso (GA) le riceverà con i prossimi rilasci; in alternativa si può passare al kernel HWE
                    (<span class="font-monospace">${escapeHtml(hweMeta)}</span>), che segue una serie di kernel più recente e cambia serie
                    a ogni point release: va provato prima su un'istanza di test.</div>` : ''}
                ${fixable.length ? `<h4 class="mb-1">Da correggere</h4>
                <div class="table-responsive" style="max-height: 20rem; overflow-y: auto"><table class="table table-sm table-vcenter">
                    <thead class="sticky-top bg-body"><tr><th>Vulnerabilità</th><th>Gravità</th><th>Pacchetto</th><th>Installato</th><th>Stato Ubuntu</th></tr></thead>
                    <tbody>${fixable.map(f => findingRow(f, true)).join('')}</tbody>
                </table></div>` : ''}
                <div class="small text-muted">Dei kernel conta solo quello in esecuzione: quelli installati ma non avviati (di riserva) non sono esposti finché non vengono avviati.</div>
            </div>
        </div>
        ${byPackage.length ? `<h4 class="mt-4 mb-1">Vulnerabilità per pacchetto</h4>
        <div class="small text-muted mb-2">${byPackage.length} pacchetti; clic su una riga per l'elenco delle vulnerabilità.</div>
        <div class="table-responsive" style="max-height: 28rem; overflow-y: auto"><table class="table table-sm table-vcenter mb-0" id="vuln-pkgs">
            <thead class="sticky-top bg-body"><tr><th></th><th>Pacchetto</th><th>Installato</th><th class="text-end">Totale</th><th>Gravità</th><th>Stato Ubuntu</th></tr></thead>
            <tbody>${byPackage.map((g, n) => `<tr class="cursor-pointer" data-pkg="${n}">
                <td class="text-muted" style="width: 1.5rem"><i class="ti ti-chevron-right"></i></td>
                <td>${escapeHtml(g.package)}${g.kind === 'python' ? ' <span class="badge bg-blue-lt">py</span>' : ''}</td>
                <td class="font-monospace small">${escapeHtml(g.installed_version)}</td>
                <td class="text-end">${g.count}</td>
                <td class="small">${sevList(g.severities, !g.fixable)}</td>
                <td class="small">${Object.entries(g.statuses).map(([s, c]) => `${statusBadge(s)} ${c}`).join(' ')}</td>
            </tr><tr class="d-none" data-pkg-detail="${n}"><td></td><td colspan="5"></td></tr>`).join('')}</tbody>
        </table></div>` : ''}
        <hr>
        <div class="d-flex gap-2 align-items-center mb-2">
            <select class="form-select form-select-sm w-auto" id="pkg-section"><option value="packages">Pacchetti OS</option><option value="python">Pacchetti Python</option></select>
            <input class="form-control form-control-sm w-auto" id="pkg-q" placeholder="Cerca pacchetto">
        </div>
        <div id="pkg-list" class="table-responsive" style="max-height: 24rem; overflow-y: auto"></div>
        <h4 class="mt-4">Modifiche recenti</h4>
        ${changes.length ? changes.map(c => `<details class="mb-1"><summary>${fmtDate(c.at)} · ${c.section === 'packages' ? 'OS' : 'Python'} · ${c.changes.length} modifiche</summary>
            <table class="table table-sm mb-2">${c.changes.slice(0, 200).map(x => `<tr><td class="small">${escapeHtml(x.name)}</td>
                <td class="font-monospace small">${escapeHtml(x.from || '(nuovo)')}</td><td>→</td>
                <td class="font-monospace small">${escapeHtml(x.to || '(rimosso)')}</td></tr>`).join('')}</table></details>`).join('')
            : '<div class="text-muted small">Nessuna modifica registrata</div>'}
    </div>`;
    el.querySelector('#vuln-pkgs')?.addEventListener('click', async (e) => {
        const row = e.target.closest('tr[data-pkg]');
        if (!row || e.target.closest('a')) return;
        const n = row.dataset.pkg;
        const detail = el.querySelector(`tr[data-pkg-detail="${n}"]`);
        const icon = row.querySelector('.ti');
        const open = detail.classList.toggle('d-none') === false;
        icon.classList.toggle('ti-chevron-right', !open);
        icon.classList.toggle('ti-chevron-down', open);
        if (!open || detail.dataset.loaded) return;
        const cell = detail.lastElementChild;
        cell.innerHTML = loadingSpinner();
        try {
            const items = await apiGet(`/instances/${i.id}/findings?package=${encodeURIComponent(byPackage[n].package)}`);
            cell.innerHTML = `<div style="max-height: 20rem; overflow-y: auto"><table class="table table-sm table-vcenter mb-0">
                <thead class="sticky-top bg-body"><tr><th>Vulnerabilità</th><th>Gravità</th><th>Stato Ubuntu</th></tr></thead>
                <tbody>${items.map(f => findingRow(f, false)).join('')}</tbody></table></div>`;
            detail.dataset.loaded = '1';
        } catch (err) {
            cell.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
        }
    });
    const listEl = el.querySelector('#pkg-list');
    const load = async () => {
        const section = el.querySelector('#pkg-section').value;
        const q = el.querySelector('#pkg-q').value.trim();
        const items = await apiGet(`/instances/${i.id}/inventory/${section}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
        listEl.innerHTML = `<table class="table table-sm"><thead><tr><th>Nome</th><th>Versione</th>${section === 'packages' ? '<th>Sorgente</th>' : ''}</tr></thead>
            <tbody>${items.slice(0, 1000).map(p => `<tr><td>${escapeHtml(p.name)}${p.arch && p.arch !== 'all' ? ` <span class="text-muted small">${escapeHtml(p.arch)}</span>` : ''}</td>
                <td class="font-monospace small">${escapeHtml(p.version)}</td>
                ${section === 'packages' ? `<td class="small text-muted">${escapeHtml(p.source !== p.name ? p.source : '')}</td>` : ''}</tr>`).join('')
                || '<tr><td class="text-muted">Nessun pacchetto</td></tr>'}</tbody></table>`;
    };
    el.querySelector('#pkg-section').addEventListener('change', load);
    el.querySelector('#pkg-q').addEventListener('change', load);
    await load();
}

async function commands(el, i) {
    const rows = await apiGet(`/instances/${i.id}/commands?limit=100`);
    el.innerHTML = `<div class="table-responsive"><table class="table card-table table-vcenter">
        <thead><tr><th>Creato</th><th>Comando</th><th>Operatore</th><th>Stato</th><th>Esito</th></tr></thead>
        <tbody>${rows.map(c => `<tr>
            <td>${fmtDate(c.created_at)}</td><td class="font-monospace">${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.operator)}</td><td>${commandStatusBadge(c.status)}</td>
            <td class="small text-muted">${escapeHtml(c.error ? `${c.error_code ? `[${c.error_code}] ` : ''}${c.error}`
                : c.result ? JSON.stringify(c.result).slice(0, 200)
                : c.status === 'running' && c.progress ? progressText(c.progress) : '')}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="text-muted">Nessun comando</td></tr>'}
        </tbody></table></div>`;
}

// Shown while madmin-rescue reports (MADMIN down, every 5 minutes) or an
// action is queued for it
function rescueCard(i) {
    const recent = i.rescue_at && (Date.now() - new Date(i.rescue_at + 'Z').getTime()) < 30 * 60000;
    const act = i.rescue_action || {};
    if (!recent && act.status !== 'pending') return '';
    const r = i.rescue || {};
    const manage = checkPermission('manager.manage');
    const last = r.last_action ? `<div class="mt-2 small">Ultima azione: <strong>${escapeHtml(r.last_action.action)}</strong>
        ${r.last_action.ok ? '<span class="badge bg-success-lt">riuscita</span>' : '<span class="badge bg-danger-lt">fallita</span>'}
        <span class="text-muted">${fmtDate(r.last_action.at)}</span>
        <pre class="small mt-1 mb-0">${escapeHtml(r.last_action.output || '')}</pre></div>` : '';
    return `<div class="card-body border-bottom bg-danger-lt">
        <h4><i class="ti ti-lifebuoy me-2"></i>Rescue: MADMIN non risponde</h4>
        <div class="small">Ultimo report ${fmtDate(i.rescue_at)} · release ${escapeHtml(r.current || '?')}
            (precedente ${escapeHtml(r.previous || '-')}) · ${escapeHtml(r.unit || '')} · disco libero ${r.disk_free_mb ?? '?'} MB</div>
        ${act.status ? `<div class="mt-2">Azione <strong>${escapeHtml(act.action)}</strong> ${act.release_id ? escapeHtml(act.release_id) : ''}:
            ${act.status === 'pending' ? 'in attesa del prossimo report (entro 5 minuti)' : `inviata ${fmtDate(act.sent_at)}`}
            ${act.status === 'pending' && manage ? `<button class="btn btn-sm btn-link" ${actionAttrs('managerRescueCancel')}>Annulla</button>` : ''}</div>` : ''}
        ${last}
        ${manage ? `<div class="btn-list mt-2">
            <button class="btn btn-sm btn-outline-danger" ${actionAttrs('managerRescue', 'restart')}>Riavvia MADMIN</button>
            <button class="btn btn-sm btn-outline-danger" ${actionAttrs('managerRescue', 'rollback')}>Torna alla release precedente</button>
            <button class="btn btn-sm btn-outline-danger" ${actionAttrs('managerRescue', 'install')}>Installa una release</button></div>` : ''}
        <details class="mt-2"><summary class="small">Journal di madmin.service</summary>
            <pre class="small mb-0" style="max-height: 360px; overflow: auto">${escapeHtml(r.journal || '')}</pre></details>
    </div>`;
}

const UPDATE_RESULTS = { running: ['bg-info-lt', 'in corso'], verifying: ['bg-info-lt', 'in verifica'],
    ok: ['bg-success-lt', 'riuscito'], rolled_back: ['bg-warning-lt', 'annullato (rollback)'], failed: ['bg-danger-lt', 'fallito'] };

function updateText(u) {
    if (!u || !u.release_id) return '-';
    const [cls, label] = UPDATE_RESULTS[u.result] || ['bg-secondary-lt', u.result || '?'];
    return `<span class="font-monospace">${escapeHtml(u.release_id)}</span> <span class="badge ${cls}">${label}</span>
        ${u.result === 'running' || u.result === 'verifying' ? `<span class="text-muted small">(${escapeHtml(u.step || '')})</span>` : ''}
        <div class="text-muted small">${fmtDate(u.updated_at)}${u.detail ? ` · ${escapeHtml(u.detail)}` : ''}</div>`;
}

function progressText(p) {
    return [p.step, p.percent != null ? `${p.percent}%` : '', p.message].filter(Boolean).join(' · ');
}

// The tree too: name, group or status may have changed
const reloadDetail = (tab) => {
    reloadTree();
    return renderDetail(mainEl, current.id, tab);
};

function minutesField(def = 60) {
    return field('minutes', 'Durata in minuti', { type: 'number', required: true, min: 5, max: 1440, value: def,
        col: 'col-md-4', hint: 'da 5 a 1440 (1 giorno); poi l\'accesso si chiude da solo' });
}

const reasonField = field('reason', 'Motivo', { required: true, minlength: 3, maxlength: 500, col: 'col-md-8',
    example: 'Ticket #1234, richiesta del cliente', hint: 'resta nell\'audit del manager e dell\'istanza' });
const ipField = field('allowed_ip', 'IP ammesso sulla porta di supporto', { maxlength: 45, mono: true, col: 'col-md-6',
    pattern: '^[0-9a-fA-F:.]+$', format: 'un indirizzo IPv4 o IPv6', example: '203.0.113.10',
    hint: 'vuoto = il tuo IP attuale' });
// Step-up: a fresh code at every opening (a code is accepted once)
const totpField = field('totp', 'Codice 2FA', { required: true, mono: true, pattern: '^[0-9]{6}$', maxlength: 6,
    format: '6 cifre', col: 'col-md-6', attrs: 'inputmode="numeric" autocomplete="one-time-code"',
    hint: 'dall\'app di autenticazione, nuovo a ogni apertura (non i codici di recupero)' });

export function licenseModal(instanceId, onDone) {
    formModal('Emetti licenza', `
        ${notice('info', '', ['La licenza viene firmata dal manager e installata sull\'istanza alla prossima connessione; si rinnova da sola finché non è revocata.'])}
        ${instanceId ? '' : field('instance_id', 'ID istanza', { required: true, mono: true, pattern: '^[0-9a-f-]{36}$',
            format: 'UUID dell\'istanza', example: '0ae55d84-d277-45ad-9cbb-81705023ea60' })}
        ${field('feature', 'Feature', { required: true, mono: true, pattern: '^[a-z0-9_.\\-]{1,50}$',
            format: 'minuscole, cifre, . _ -', example: 'funkube', hint: 'come nel manifest del modulo' })}
        ${field('valid_until', 'Valida fino al', { type: 'date', hint: 'vuoto = fino a revoca' })}
        ${field('notes', 'Note', { maxlength: 500, example: 'contratto 2026/45' })}`,
    async (form) => {
        const d = formData(form);
        await apiPost('/licenses', {
            instance_id: instanceId || d.instance_id, feature: d.feature, notes: d.notes,
            valid_until: d.valid_until ? `${d.valid_until}T23:59:59` : null,
        });
        showToast('Licenza emessa: verrà installata sull\'istanza', 'success');
        onDone();
    }, { submitText: 'Emetti licenza', icon: 'ti-certificate', tone: 'primary' });
}

const SSH_OS_KEY = 'manager.sshOs';
const SSH_OS = [['windows', 'Windows', 'ti-brand-windows'], ['macos', 'macOS', 'ti-brand-apple'], ['linux', 'Linux', 'ti-brand-ubuntu']];

function sshSessionModal(res) {
    const s = res.session || {};
    const cert = res.certificate.trim();
    const file = `madmin-${current.id.slice(0, 8)}-cert.pub`;
    const unixPath = `~/.ssh/${file}`;
    const winPath = `$HOME\\.ssh\\${file}`;
    let os = 'windows';
    try { os = SSH_OS.some(([k]) => k === localStorage.getItem(SSH_OS_KEY)) ? localStorage.getItem(SSH_OS_KEY) : os; } catch { /* default */ }

    // One line that writes the file: no editor in between (TextEdit on macOS
    // would save rich text, Notepad may add a BOM or .txt). The certificate
    // never contains a single quote.
    const unixSave = `mkdir -p ~/.ssh && printf '%s\\n' '${cert}' > ${unixPath}`;
    // PowerShell: $HOME is %USERPROFILE%, the folder Windows OpenSSH expands ~ to,
    // so the connect command (CertificateFile=~/.ssh/...) is the same everywhere
    const winSave = `New-Item -ItemType Directory -Force "$HOME\\.ssh" | Out-Null; `
        + `Set-Content -Encoding ascii -Path "${winPath}" -Value '${cert}'`;

    const steps = (where, save, path, keyDir, agent, extraTrouble = '') => `
        <h4 class="mb-1">1. Salva il certificato</h4>
        <p class="mb-2">${where}</p>
        ${copyBlock(save)}

        <h4 class="mt-4 mb-1">2. Connettiti</h4>
        ${copyBlock(res.command)}

        <h4 class="mt-4 mb-1">Requisiti</h4>
        <ul class="mb-3">
            <li>La chiave privata della chiave scelta deve essere in <code>${keyDir}</code>
                con un nome standard (<code>id_ed25519</code>, <code>id_rsa</code>, …) oppure caricata in ${agent}.
                Altrimenti aggiungi al comando <code>-i ${keyDir}&lt;tua_chiave&gt;</code>.</li>
            <li>Il certificato va salvato esattamente in <code>${escapeHtml(path)}</code>:
                se ssh non lo trova lo ignora senza errori.</li>
        </ul>

        <details>
            <summary class="text-muted">Se ti chiede la password</summary>
            <p class="mt-2 mb-2">Il certificato non è stato usato. Cerca nell'output (o ripeti il comando con <code>-v</code>):</p>
            <ul class="mb-2">
                <li><code>Load key "…-cert.pub": invalid format</code>: il certificato è stato letto, ma non c'è
                    la chiave privata corrispondente (ssh ripiega sul file del certificato). La chiave
                    scelta non è tra quelle in <code>${keyDir}</code> con nome standard né in ssh-agent:
                    usa <code>-i ${keyDir}&lt;tua_chiave&gt;</code> o apri una nuova sessione con la chiave giusta.
                    Confronta l'impronta in <code>ssh-keygen -L -f ${escapeHtml(path)}</code> (riga <code>Public key</code>)
                    con <code>ssh-keygen -lf ${keyDir}&lt;tua_chiave&gt;.pub</code>.</li>
                <li><code>no identity cert loaded</code>: il file non è nel percorso indicato o è danneggiato.
                    Controllalo con <code>ssh-keygen -L -f ${escapeHtml(path)}</code>.</li>
                <li>nessuna riga <code>CERT</code> tra le chiavi offerte: la chiave privata non è stata trovata (vedi requisiti).</li>
                ${extraTrouble}
            </ul>
        </details>`;

    const panes = {
        windows: steps(
            `In <strong>PowerShell</strong> (non nel Prompt dei comandi). Serve il client OpenSSH di Windows 10/11
             (<code>ssh -V</code> per verificarlo; PuTTY non supporta i certificati OpenSSH):`,
            winSave, `${winPath}`, '$HOME\\.ssh\\', 'ssh-agent (servizio <code>OpenSSH Authentication Agent</code>)',
            // OpenSSH wants "-----BEGIN/END ...-----\n": a key saved with Notepad or
            // exported by PuTTYgen has CRLF and no final newline, so it is rejected
            `<li><code>Load key "…\\id_rsa": invalid format</code> (o <code>id_ed25519</code>…): la chiave privata
                ha fine riga Windows (CRLF). Convertila (fai prima una copia):
                ${copyBlock('$k = "$HOME\\.ssh\\id_rsa"; [IO.File]::WriteAllText($k, ([IO.File]::ReadAllText($k) -replace "`r`n", "`n").TrimEnd("`n") + "`n")')}</li>`),
        macos: steps('Nel Terminale:', unixSave, unixPath, '~/.ssh/', 'ssh-agent (<code>ssh-add --apple-use-keychain</code>)'),
        linux: steps('Nel terminale:', unixSave, unixPath, '~/.ssh/', 'ssh-agent (<code>ssh-add</code>)'),
    };

    const el = secretModal('Accesso SSH di supporto aperto', `
        <p class="text-muted mb-3">
            Valido fino a <strong>${escapeHtml(fmtDate(s.expires_at))}</strong>,
            solo dall'IP <strong class="font-monospace">${escapeHtml(s.allowed_ip || '')}</strong>
            e solo attraverso la porta <strong>${escapeHtml(String(s.port ?? ''))}</strong> del manager.
        </p>

        <div class="btn-group w-100 mb-4" role="group" aria-label="Sistema operativo">
            ${SSH_OS.map(([k, label, icon]) => `
                <input type="radio" class="btn-check" name="ssh-os" id="ssh-os-${k}" value="${k}" ${k === os ? 'checked' : ''}>
                <label class="btn" for="ssh-os-${k}"><i class="ti ${icon} me-1"></i>${label}</label>`).join('')}
        </div>

        ${SSH_OS.map(([k]) => `<div data-ssh-os="${k}" ${k === os ? '' : 'hidden'}>${panes[k]}</div>`).join('')}

        <details class="mt-2">
            <summary class="text-muted">Certificato (per salvarlo a mano)</summary>
            <div class="mt-2">${copyBlock(cert, 4)}</div>
        </details>`);

    el.querySelectorAll('input[name="ssh-os"]').forEach((r) => r.addEventListener('change', () => {
        el.querySelectorAll('[data-ssh-os]').forEach((p) => { p.hidden = p.dataset.sshOs !== r.value; });
        try { localStorage.setItem(SSH_OS_KEY, r.value); } catch { /* not remembered */ }
    }));
}

export function uiLinkModal(res) {
    const s = res.session || {};
    const until = s.expires_at
        ? `<li>La sessione resta aperta fino a <strong>${escapeHtml(fmtDate(s.expires_at))}</strong>,
               solo dall'IP <strong class="font-monospace">${escapeHtml(s.allowed_ip || '')}</strong>.</li>` : '';
    secretModal('Accesso UI di supporto', `
        <ul class="mb-0">
            <li>Apri il link entro <strong>${Math.round((res.ticket_ttl || 120) / 60)} minuti</strong>: vale una sola volta.
                Se scade, chiedine uno nuovo dalla scheda Supporto.</li>
            <li>Il browser segnalerà il certificato dell'istanza (autofirmato): è normale, prosegui.</li>
            ${until}
        </ul>`,
        res.url,
        `<a class="btn btn-primary" href="${escapeHtml(res.url)}" target="_blank" rel="noopener noreferrer">
            <i class="ti ti-external-link me-1"></i>Apri</a>`);
}

registerActions({
    managerOpenInstance: (id) => { location.hash = `#instances/${id}`; },
    managerGroups: groupsModal,
    managerGroupEdit: () => {
        const g = hierarchy().byId[selected.id];
        if (!g) return;
        let w = {};
        try { w = JSON.parse(g.maintenance_json || '{}'); } catch { /* none */ }
        const days = w.days || [0, 1, 2, 3, 4, 5, 6];
        const DAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
        formModal(g.kind === 'partner' ? 'Modifica partner' : 'Modifica cliente', `
            ${field('name', 'Nome', { required: true, maxlength: 100, value: g.name })}
            ${field('description', 'Descrizione', { maxlength: 500, value: g.description })}
            ${formSection('Finestra di manutenzione', 'facoltativa')}
            <div class="small text-muted mb-2">I <b>rollout</b> avviano aggiornamenti e riavvii su queste istanze solo in questa
                finestra (ora del manager). Vuota = sempre${g.kind === 'customer' && g.parent_id ? '; senza finestra vale quella del partner' : ''}.
                Una fine precedente all'inizio attraversa la mezzanotte (es. 22:00 → 04:00).</div>
            <div class="row g-2 mb-2">
                ${field('w_start', 'Dalle', { type: 'time', value: w.start || '', col: 'col' })}
                ${field('w_end', 'Alle', { type: 'time', value: w.end || '', col: 'col' })}
            </div>
            <div class="btn-group w-100" role="group">${DAYS.map((l, n) => `
                <input type="checkbox" class="btn-check" name="w_day" value="${n}" id="w-day-${n}" ${days.includes(n) ? 'checked' : ''}>
                <label class="btn btn-sm" for="w-day-${n}">${l}</label>`).join('')}</div>`,
        async (form) => {
            const d = formData(form);
            const wdays = [...form.querySelectorAll('[name=w_day]:checked')].map(x => Number(x.value));
            if (Boolean(d.w_start) !== Boolean(d.w_end)) return fieldError(form, d.w_start ? 'w_end' : 'w_start', 'Indicare inizio e fine, o nessuno dei due');
            await apiPatch(`/groups/${g.id}`, { name: d.name, description: d.description,
                maintenance: { start: d.w_start || '', end: d.w_end || '', days: wdays.length ? wdays : [0, 1, 2, 3, 4, 5, 6] } });
            await fetchLists(true);
            renderTree();
            renderGroup(mainEl, g.id);
        }, { icon: 'ti-folder' });
    },
    managerGroupDelete: async () => {
        const g = hierarchy().byId[selected.id];
        if (!g) return;
        if (!await confirmAction({ title: `Elimina ${g.kind === 'partner' ? 'partner' : 'cliente'}`, icon: 'ti-trash',
            intro: `Eliminare <b>${escapeHtml(g.name)}</b>?`,
            items: [['ti-info-circle', 'Possibile solo se è vuoto: senza istanze, clienti e utenti.']], confirmText: 'Elimina' })) return;
        try {
            await apiDelete(`/groups/${g.id}`);
            fetchedAt = 0;
            location.hash = g.parent_id ? `#instances/group/${g.parent_id}` : '#instances';
        } catch (e) { showToast(e.message, 'error'); }
    },
    managerRefresh: async () => {
        try { await apiPost(`/instances/${current.id}/refresh`, {}); showToast('Dati aggiornati', 'success'); reloadDetail('overview'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    managerEdit: () => {
        const i = current;
        // Partners and customers: their own groups only, no external reference
        const manager = checkPermission('manager.manage');
        formModal('Modifica istanza', `
            <div class="row g-2">
                ${field('name', 'Nome', { required: true, maxlength: 100, value: i.name, col: 'col-md-6' })}
                <div class="col-md-6"><label class="form-label">Gruppo${manager ? '<span class="text-muted small fw-normal ms-1">facoltativo</span>' : '<span class="text-danger ms-1">*</span>'}</label>
                    <select name="group_id" class="form-select">${groupOptions(groups, i.group_id || '', { none: manager ? 'Nessuno (sito principale)' : null })}</select>
                    <div class="invalid-feedback"></div></div>
                ${field('description', 'Descrizione', { maxlength: 500, value: i.description, col: 'col-12' })}
                ${field('labels', 'Etichette', { type: 'textarea', rows: 3, mono: true, value: labelsToText(i.labels), col: 'col-md-7',
                    format: 'chiave=valore, una per riga', hint: '<code>canary=true</code> = prima nei rollout' })}
                ${field('external_ref', 'Riferimento esterno', { maxlength: 100, mono: true, value: i.external_ref || '', col: 'col-md-5',
                    attrs: manager ? '' : 'readonly', hint: manager ? 'id nel sistema di provisioning' : 'lo imposta il provisioning o un superuser' })}
                ${field('backup_enabled', 'Backup pianificati', { type: 'checkbox', checked: i.backup_enabled, col: 'col-12' })}
            </div>`,
        async (form) => {
            const d = formData(form);
            let labels;
            try { labels = textToLabels(d.labels); } catch (e) { return fieldError(form, 'labels', e.message); }
            const body = { name: d.name, description: d.description, group_id: d.group_id,
                           backup_enabled: form.backup_enabled.checked, labels };
            if (manager) body.external_ref = d.external_ref;
            await apiPatch(`/instances/${i.id}`, body);
            reloadDetail('overview');
        }, { icon: 'ti-edit', size: 'lg' });
    },
    managerReenroll: async () => {
        if (!await confirmAction({ title: 'Token re-enroll', tone: 'primary', icon: 'ti-key', confirmText: 'Genera token',
            intro: `Registra di nuovo <b>${escapeHtml(current.name)}</b> mantenendo identità, backup e licenze.`,
            items: [['ti-clock', 'Monouso, valido <b>72 ore</b>.'],
                    ['ti-terminal-2', 'Si usa dopo una reinstallazione: <code>setup-madmin.sh --manager-token-file</code>.'],
                    ['ti-alert-triangle', 'Al suo utilizzo il certificato attuale dell\'istanza viene revocato.']] })) return;
        try {
            const res = await apiPost(`/enrollment/instances/${current.id}/reenroll`, {});
            secretModal('Token re-enroll',
                enrollTokenHelp(res.token, { expiresAt: res.expires_at, reenroll: true }), res.token);
        } catch (e) { showToast(e.message, 'error'); }
    },
    managerRescue: async (action) => {
        const labels = { restart: 'riavviare MADMIN', rollback: 'tornare alla release precedente (con il database di allora)',
                         install: 'installare una release' };
        let body = { action };
        if (action === 'install') {
            const releases = await apiGet('/releases');
            if (!releases.length) { showToast('Nessuna release caricata', 'warning'); return; }
            return formModal('Rescue: installa una release', `
                ${notice('warning', 'MADMIN non risponde: azione eseguita dal rescue', [
                    ['ti-clock', 'Il rescue la esegue al prossimo report (entro <b>5 minuti</b>).'],
                    ['ti-package', 'La release viene verificata (firma) e installata come un normale aggiornamento, con rollback se non parte.']])}
                ${field('release_id', 'Release da installare', { type: 'select', required: true,
                    options: releases.map(r => [r.id, `${r.id} (${r.channel})`]) })}`,
            async (form) => {
                await apiPost(`/instances/${current.id}/rescue`, { action, release_id: formData(form).release_id });
                showToast('Azione in coda: la esegue il rescue al prossimo report', 'success');
                reloadDetail('overview');
            }, { submitText: 'Metti in coda', submitClass: 'btn-warning', tone: 'warning', icon: 'ti-lifebuoy' });
        }
        if (!await confirmAction({ title: 'Rescue', tone: 'warning', icon: 'ti-lifebuoy', confirmText: 'Metti in coda',
            intro: `Il rescue di <b>${escapeHtml(current.name)}</b> proverà a <b>${labels[action]}</b>.`,
            items: [['ti-clock', 'Al prossimo report, entro 5 minuti; l\'esito compare nella scheda Panoramica.']] })) return;
        try { await apiPost(`/instances/${current.id}/rescue`, body); reloadDetail('overview'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    managerRescueCancel: async () => {
        try { await apiDelete(`/instances/${current.id}/rescue`); reloadDetail('overview'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    managerUpdate: async () => {
        let releases;
        try { releases = (await apiGet('/releases')).filter(r => r.build !== current.build); }
        catch (e) { showToast(e.message, 'error'); return; }
        if (!releases.length) { showToast('Nessuna release disponibile: caricala in Release', 'warning'); return; }
        formModal('Aggiorna MADMIN', `
            ${notice('info', '', [
                ['ti-download', 'L\'istanza scarica la release dal manager e ne <b>verifica la firma</b>.'],
                ['ti-refresh', 'MADMIN si riavvia (pochi secondi); il firewall resta attivo.'],
                ['ti-arrow-back-up', 'Se entro il tempo di verifica non torna attiva e collegata, <b>torna da sola</b> alla versione precedente, database compreso.']])}
            <div class="mb-3"><span class="text-muted small">Versione attuale</span>
                <div class="font-monospace fs-3">${escapeHtml(current.madmin_version || '')}+${escapeHtml(current.build || '')}</div></div>
            ${field('release_id', 'Nuova release', { type: 'select', required: true,
                options: releases.map(r => [r.id, `${r.id} — ${r.channel}`]), hint: 'candidate = da provare; stable = promossa' })}
            ${field('deadline', 'Tempo per la verifica (secondi)', { type: 'number', min: 60, max: 3600, value: 300,
                hint: 'da 60 a 3600; vuoto = 300' })}`,
        async (form) => {
            const d = formData(form);
            const res = await apiPost(`/instances/${current.id}/update`,
                { release_id: d.release_id, deadline: Number(d.deadline) || null });
            showToast(`Aggiornamento a ${res.release_id} inviato: avanzamento in Comandi e in Panoramica`, 'success');
            reloadDetail('commands');
        }, { submitText: 'Aggiorna MADMIN', submitClass: 'btn-primary', tone: 'primary', icon: 'ti-package' });
    },
    managerOsRefresh: async () => {
        try {
            await apiPost(`/instances/${current.id}/os/refresh`, {});
            showToast('Aggiornamento delle liste inviato: esito in Comandi', 'success');
            reloadDetail('packages');
        } catch (e) { showToast(e.message, 'error'); }
    },
    managerOsUpgrade: async (scope) => {
        const what = scope === 'security'
            ? 'solo gli aggiornamenti di sicurezza (unattended-upgrade, il canale security di Ubuntu)'
            : 'tutti gli aggiornamenti disponibili (i pacchetti bloccati con hold restano invariati)';
        if (!await confirmDialog('Aggiorna pacchetti', `Su ${escapeHtml(current.name)} vengono installati ${what}.
            Alcuni servizi possono riavviarsi (MADMIN compreso, per pochi secondi); un nuovo kernel si attiva solo
            con un riavvio, che non è automatico.`, 'Aggiorna', 'btn-primary')) return;
        try {
            await apiPost(`/instances/${current.id}/os/upgrade`, { scope });
            showToast('Aggiornamento inviato: avanzamento in Comandi', 'success');
            reloadDetail('commands');
        } catch (e) { showToast(e.message, 'error'); }
    },
    managerOsReboot: () => {
        formModal('Riavvia istanza', `
            ${notice('warning', `Interruzione del servizio di ${escapeHtml(current.name)}`, [
                ['ti-clock', 'Il router è fermo per <b>1–3 minuti</b>.'],
                ['ti-shield-lock', 'All\'avvio il firewall blocca tutto finché MADMIN non riparte; se non riparte, resta solo la console dell\'hypervisor.'],
                ['ti-cpu', 'Un kernel più recente, se installato, parte <b>in prova</b>: senza conferma entro 15 minuti torna al precedente.']])}
            <div class="row g-2">
                ${field('delay_minutes', 'Tra quanti minuti', { type: 'number', required: true, min: 0, max: 1440, value: 0,
                    col: 'col-md-4', hint: '0 = subito; max 1440' })}
                ${field('reason', 'Motivo', { required: true, minlength: 3, maxlength: 200, col: 'col-md-8',
                    example: 'kernel di sicurezza', hint: 'compare nel messaggio di sistema e nell\'audit' })}
            </div>
            ${typedConfirm(current.name)}`,
        async (form) => {
            const d = formData(form);
            await apiPost(`/instances/${current.id}/os/reboot`, { delay_minutes: Number(d.delay_minutes), reason: d.reason });
            showToast('Riavvio inviato: esito in Comandi', 'success');
            reloadDetail('commands');
        }, { submitText: 'Riavvia', submitClass: 'btn-warning', tone: 'warning', icon: 'ti-power' });
    },
    managerOsRebootCancel: async () => {
        try {
            await apiPost(`/instances/${current.id}/os/reboot/cancel`, {});
            showToast('Annullamento del riavvio inviato', 'success');
            reloadDetail('packages');
        } catch (e) { showToast(e.message, 'error'); }
    },
    managerRelocate: () => {
        formModal('Cambia indirizzo del manager', `
            ${notice('info', '', [
                ['ti-shield-check', 'L\'istanza verifica che il nuovo indirizzo presenti un certificato della <b>stessa CA</b>.'],
                ['ti-arrows-exchange', 'Lo adotta solo se lì risponde; altrimenti resta sull\'indirizzo attuale.'],
                ['ti-alert-triangle', 'Il vecchio indirizzo deve restare raggiungibile finché lo spostamento non è confermato.']])}
            ${field('url', 'Nuovo indirizzo', { maxlength: 255, mono: true, pattern: '^https://[^/\\s]+$',
                format: 'https://host:porta', example: 'https://manager2.example.com:8443',
                hint: 'vuoto = l\'URL agent delle impostazioni' })}`,
        async (form) => {
            const d = formData(form);
            const res = await apiPost(`/instances/${current.id}/relocate`, { url: d.url || null });
            showToast(`Spostamento verso ${res.url} inviato: esito nella scheda Comandi`, 'success');
            reloadDetail('commands');
        }, { submitText: 'Sposta', icon: 'ti-arrows-exchange' });
    },
    managerSuspend: async () => {
        if (!await confirmAction({ title: 'Sospendi istanza', tone: 'warning', icon: 'ti-player-pause', confirmText: 'Sospendi',
            intro: `<b>${escapeHtml(current.name)}</b> viene disconnessa dal manager.`,
            items: [['ti-plug-off', 'Non riceve comandi finché non è riattivata; riprova a collegarsi ogni 15 minuti.'],
                    ['ti-lifebuoy', 'Le sessioni di supporto aperte vengono chiuse.'],
                    ['ti-check', 'Identità, backup e licenze restano; il router continua a funzionare.']] })) return;
        try { await apiPost(`/instances/${current.id}/suspend`, {}); reloadDetail('overview'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    managerResume: async () => {
        try {
            await apiPost(`/instances/${current.id}/resume`, {});
            showToast('Istanza riattivata: si ricollega entro 15 minuti', 'success');
            reloadDetail('overview');
        } catch (e) { showToast(e.message, 'error'); }
    },
    managerRevoke: async () => {
        if (!await confirmAction({ title: 'Revoca istanza', icon: 'ti-ban', confirmText: 'Revoca', typed: current.name,
            intro: `<b>${escapeHtml(current.name)}</b> perde l'accesso al manager.`,
            items: [['ti-certificate-off', 'Il certificato viene revocato: per tornare serve un <b>nuovo enrollment</b>.'],
                    ['ti-lifebuoy', 'Le sessioni di supporto aperte vengono chiuse.']] })) return;
        try { await apiPost(`/instances/${current.id}/revoke`, {}); reloadDetail('overview'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    managerDelete: async () => {
        if (!await confirmAction({ title: 'Elimina istanza', icon: 'ti-trash', confirmText: 'Elimina definitivamente', typed: current.name,
            intro: '<b>Operazione irreversibile.</b>',
            items: [['ti-database-off', 'Vengono cancellati backup, licenze, inventario e storico dei comandi.']] })) return;
        try {
            await apiDelete(`/instances/${current.id}`);
            fetchedAt = 0;
            location.hash = current.group_id ? `#instances/group/${current.group_id}` : '#instances';
        }
        catch (e) { showToast(e.message, 'error'); }
    },
    managerBackupRun: async () => {
        try { await apiPost(`/instances/${current.id}/backups`, {}); showToast('Backup richiesto: compare qui al termine', 'success'); setTimeout(() => reloadDetail('backups'), 5000); }
        catch (e) { showToast(e.message, 'error'); }
    },
    managerBackupDownload: async (id) => {
        try {
            const r = await fetch(`/api/backups/${id}/download`, { headers: { Authorization: `Bearer ${getToken()}` } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const url = URL.createObjectURL(await r.blob());
            const a = Object.assign(document.createElement('a'), { href: url, download: `${current.name}-${id.slice(0, 8)}.tar.gz.enc` });
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) { showToast(e.message, 'error'); }
    },
    managerBackupDelete: async (id) => {
        if (!await confirmAction({ title: 'Elimina backup', icon: 'ti-trash', confirmText: 'Elimina',
            intro: 'Il backup viene cancellato dal manager: non si potrà più ripristinare.' })) return;
        try { await apiDelete(`/backups/${id}`); reloadDetail('backups'); } catch (e) { showToast(e.message, 'error'); }
    },
    managerBackupRestore: (id, created) => {
        formModal('Ripristina configurazione', `
            ${notice('danger', `Sovrascrive la configurazione di ${escapeHtml(current.name)}`, [
                ['ti-calendar', `Torna allo stato del backup del <b>${fmtDate(created)}</b>, utenti compresi.`],
                ['ti-refresh', 'Poi MADMIN si riavvia; quello che è cambiato dopo il backup va perso.']])}
            <div class="row g-2">${reasonField.replace('col-md-8', 'col-12')}</div>
            ${typedConfirm(current.name)}`,
        async (form) => {
            const d = formData(form);
            await apiPost(`/backups/${id}/restore`, d);
            showToast('Ripristino avviato: esito nella scheda Comandi', 'success');
            reloadDetail('commands');
        }, { submitText: 'Ripristina', submitClass: 'btn-danger', tone: 'danger', icon: 'ti-database-import' });
    },
    managerLicenseNew: () => licenseModal(current.id, () => reloadDetail('licenses')),
    managerLicenseRevoke: async (id) => {
        if (!await confirmAction({ title: 'Revoca licenza', icon: 'ti-certificate-off', confirmText: 'Revoca',
            items: [['ti-lock', 'Il modulo non sarà più attivabile.'],
                    ['ti-refresh', 'Al prossimo riavvio dell\'istanza non verrà caricato; i suoi dati restano.']] })) return;
        try { await apiPost(`/licenses/${id}/revoke`, {}); location.hash.startsWith('#licenses') ? location.reload() : reloadDetail('licenses'); }
        catch (e) { showToast(e.message, 'error'); }
    },
    managerSupportUi: () => {
        formModal('Accesso UI superuser temporaneo', `
            ${notice('info', '', [
                ['ti-user-shield', 'Crea sull\'istanza un superuser temporaneo che scade con la sessione.'],
                ['ti-link', 'Ricevi un link di accesso monouso; la porta di supporto ammette solo l\'IP indicato.']])}
            <div class="row g-2">${minutesField()}${reasonField}${ipField}${totpField}</div>`, async (form) => {
            const d = formData(form);
            const res = await apiPost(`/instances/${current.id}/support/ui`, {
                minutes: Number(d.minutes), reason: d.reason, allowed_ip: d.allowed_ip || null, totp: d.totp });
            uiLinkModal(res);
            reloadDetail('support');
        }, { submitText: 'Apri sessione', tone: 'primary', icon: 'ti-browser', size: 'lg' });
    },
    managerSupportSsh: async () => {
        // The instance has one SSH grant: a new session replaces the open one
        let open = [];
        let keys = [];
        try {
            open = (await apiGet(`/instances/${current.id}/support`))
                .filter(s => s.kind === 'ssh' && s.status === 'open');
            keys = (await apiGet('/me/ssh-keys')).filter(k => k.status === 'approved');
        } catch (e) { showToast(e.message, 'error'); return; }
        if (!keys.length) {
            secretModal('Nessuna chiave SSH approvata', `
                <p>L'accesso SSH di supporto firma solo una delle tue chiavi pubbliche, approvata da un altro superuser.</p>
                <p>Aggiungila in <a href="#support" data-bs-dismiss="modal">Supporto → Le mie chiavi SSH</a> e chiedi a un altro superuser di approvarla.</p>`);
            return;
        }
        const warning = open.length ? notice('warning', 'Una sessione SSH è già attiva: verrà chiusa', [
            ...open.map(s => ['ti-user', `<b>${escapeHtml(s.operator)}</b> da <span class="font-monospace">${escapeHtml(s.allowed_ip)}</span>,
                scade il ${escapeHtml(fmtDate(s.expires_at))} — <span class="text-muted">${escapeHtml(s.reason)}</span>`]),
            ['ti-plug-off', 'L\'istanza ammette un solo accesso SSH: chi è collegato viene disconnesso.']])
            : notice('info', '', [['ti-certificate', 'Il manager firma un certificato per la chiave scelta, valido solo per la durata indicata e solo attraverso il tunnel.']]);
        formModal('Accesso SSH root temporaneo', `${warning}<div class="row g-2">${minutesField()}${reasonField}${ipField}${totpField}
            ${field('key_id', 'Chiave SSH', { type: 'select', required: true, col: 'col-12',
                options: keys.map(k => [k.id, `${k.name} — ${k.fingerprint}`]),
                hint: 'solo le tue chiavi approvate (Supporto → Le mie chiavi SSH)' })}</div>`,
        async (form) => {
            const d = formData(form);
            const res = await apiPost(`/instances/${current.id}/support/ssh`, {
                minutes: Number(d.minutes), reason: d.reason, allowed_ip: d.allowed_ip || null,
                key_id: d.key_id, totp: d.totp, replace: open.length > 0 });
            sshSessionModal(res);
            reloadDetail('support');
        }, open.length
            ? { submitText: 'Chiudi la sessione attuale e apri', submitClass: 'btn-warning', size: 'lg', tone: 'warning', icon: 'ti-terminal-2' }
            : { submitText: 'Apri sessione', size: 'lg', tone: 'primary', icon: 'ti-terminal-2' });
    },
    managerSupportTicket: async (id) => {
        try { uiLinkModal(await apiPost(`/support/${id}/ticket`, {})); } catch (e) { showToast(e.message, 'error'); }
    },
    managerSupportClose: async (id) => {
        try {
            await apiPost(`/support/${id}/close`, {});
            location.hash.startsWith('#support') ? location.reload() : reloadDetail('support');
        } catch (e) { showToast(e.message, 'error'); }
    },
});
