/**
 * MADMIN - Logs View
 *
 * Two-tab log viewer:
 * - Audit Log: structured API call log from DB (with user info)
 * - System Log: raw journalctl output
 */

import { apiGet } from '../api.js';
import { showToast, escapeHtml, escapeAttr } from '../utils.js';
import { t, getLang } from '../i18n.js';
import { actionAttrs, registerActions } from '../utils.js';

// State
let currentTab = 'audit';
let auditPage = 1;
let auditFilters = { category: 'write', user: '', method: '', search: '', from_date: '', to_date: '' };
let auditUsers = [];

/**
 * Render the logs view
 */
export async function render(container) {
    container.innerHTML = `
        <div class="row row-deck row-cards">
            <div class="col-12">
                <div class="card">
                    <div class="card-header">
                        <ul class="nav nav-tabs card-header-tabs" id="logs-tabs">
                            <li class="nav-item">
                                <a class="nav-link active" href="#" data-tab="audit">
                                    <i class="ti ti-list-search me-1"></i>${t('logs.auditLog')}
                                </a>
                            </li>
                            <li class="nav-item">
                                <a class="nav-link" href="#" data-tab="system">
                                    <i class="ti ti-terminal me-1"></i>${t('logs.systemLog')}
                                </a>
                            </li>
                        </ul>
                    </div>
                    <div id="logs-tab-content"></div>
                </div>
            </div>
        </div>
    `;

    setupTabListeners();

    // Load user list for filter
    try {
        const usersData = await apiGet('/logs/audit/users');
        auditUsers = usersData.users || [];
    } catch (e) {
        auditUsers = [];
    }

    renderAuditTab();
}

/**
 * Date range filter of the audit log (Tabler Datepicker, range mode).
 * The calendar holds [from, to] and writes "from – to" in the field itself;
 * the filter is applied when the popup closes, so picking the first day of a
 * range does not reload the table on its own.
 */
function setupAuditDateRange() {
    const input = document.getElementById('audit-date-range');
    if (!input || !window.tabler?.Datepicker) return;

    // Created here, with its options, before tabler.js would create a plain one on focus
    const picker = window.tabler.Datepicker.getOrCreateInstance(input, {
        selectionMode: 'multiple-ranged',
        locale: getLang(),
        selectedDates: [auditFilters.from_date, auditFilters.to_date].filter(Boolean),
    });

    const setRange = (from, to) => {
        if (from === auditFilters.from_date && to === auditFilters.to_date) return;
        auditFilters.from_date = from;
        auditFilters.to_date = to;
        auditPage = 1;
        loadAuditData();
    };

    input.addEventListener('hidden.bs.datepicker', () => {
        const dates = picker.getSelectedDates().sort();
        // A single day picked is a one-day range
        setRange(dates[0] || '', dates.at(-1) || '');
    });

    document.getElementById('audit-date-clear')?.addEventListener('click', () => {
        picker.setSelectedDates([]);
        input.value = '';
        setRange('', '');
    });
}

/**
 * Setup tab click listeners
 */
function setupTabListeners() {
    document.getElementById('logs-tabs')?.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = e.target.closest('[data-tab]');
        if (!tab) return;

        document.querySelectorAll('#logs-tabs .nav-link').forEach(l => l.classList.remove('active'));
        tab.classList.add('active');

        currentTab = tab.dataset.tab;
        if (currentTab === 'audit') {
            renderAuditTab();
        } else {
            renderSystemTab();
        }
    });
}

// ==========================================
//  AUDIT LOG TAB
// ==========================================

async function renderAuditTab() {
    const content = document.getElementById('logs-tab-content');
    if (!content) return;

    // Build user options
    const userOptions = auditUsers.map(u =>
        `<option value="${escapeHtml(u)}" ${auditFilters.user === u ? 'selected' : ''}>${escapeHtml(u)}</option>`
    ).join('');

    content.innerHTML = `
        <div class="card-body border-bottom py-3">
            <div class="d-flex flex-wrap gap-2 align-items-center">
                <div class="input-icon flex-grow-1" style="max-width: 250px;">
                    <span class="input-icon-addon"><i class="ti ti-search"></i></span>
                    <input type="text" class="form-control form-control-sm" id="audit-search"
                           placeholder="${t('logs.searchPath')}" value="${escapeHtml(auditFilters.search)}">
                </div>
                <select class="form-select form-select-sm w-auto" id="audit-user-filter">
                    <option value="">${t('logs.allUsers')}</option>
                    ${userOptions}
                </select>
                <select class="form-select form-select-sm w-auto" id="audit-category-filter">
                    <option value="write" ${auditFilters.category === 'write' ? 'selected' : ''}>${t('logs.writesOnly')}</option>
                    <option value="" ${auditFilters.category === '' ? 'selected' : ''}>${t('logs.allOperations')}</option>
                    <option value="read" ${auditFilters.category === 'read' ? 'selected' : ''}>${t('logs.readsOnly')}</option>
                </select>
                <div class="d-flex align-items-center gap-1">
                    <div class="input-icon" style="width: 220px;">
                        <span class="input-icon-addon"><i class="ti ti-calendar"></i></span>
                        <input type="text" class="form-control form-control-sm" id="audit-date-range" readonly
                               data-bs-toggle="datepicker" placeholder="${escapeAttr(t('logs.dateRange'))}"
                               aria-label="${escapeAttr(t('logs.dateRange'))}">
                    </div>
                    <button class="btn btn-sm btn-icon btn-ghost-secondary" id="audit-date-clear"
                            title="${escapeAttr(t('logs.clearDates'))}" aria-label="${escapeAttr(t('logs.clearDates'))}">
                        <i class="ti ti-x"></i>
                    </button>
                </div>
                <button class="btn btn-sm btn-ghost-secondary" id="btn-audit-export" title="${t('logs.exportCsv')}">
                    <i class="ti ti-download"></i>
                </button>
                <button class="btn btn-sm btn-ghost-secondary" id="btn-audit-refresh" title="${t('common.refresh')}">
                    <i class="ti ti-refresh"></i>
                </button>
            </div>
        </div>
        <div id="audit-table-container">
            <div class="card-body text-center py-4 text-muted">
                <div class="spinner-border spinner-border-sm me-2"></div>
                ${t('common.loading')}
            </div>
        </div>
    `;

    // Listeners
    document.getElementById('audit-search')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') applyAuditFilters();
    });
    document.getElementById('audit-search')?.addEventListener('change', applyAuditFilters);
    document.getElementById('audit-user-filter')?.addEventListener('change', applyAuditFilters);
    document.getElementById('audit-category-filter')?.addEventListener('change', applyAuditFilters);
    setupAuditDateRange();
    document.getElementById('btn-audit-refresh')?.addEventListener('click', () => loadAuditData());
    document.getElementById('btn-audit-export')?.addEventListener('click', exportAuditCsv);

    await loadAuditData();
}

/**
 * Export audit logs as CSV (opens download)
 */
function exportAuditCsv() {
    const params = new URLSearchParams();
    if (auditFilters.category) params.set('category', auditFilters.category);
    if (auditFilters.user) params.set('user', auditFilters.user);
    if (auditFilters.search) params.set('search', auditFilters.search);
    if (auditFilters.from_date) params.set('from_date', auditFilters.from_date);
    if (auditFilters.to_date) params.set('to_date', auditFilters.to_date);

    const token = localStorage.getItem('madmin_token');
    // Use fetch + blob to include auth header
    fetch(`/api/logs/audit/export?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(resp => {
            if (!resp.ok) throw new Error(t('logs.exportFailed'));
            const filename = resp.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] || 'audit_log.csv';
            return resp.blob().then(blob => ({ blob, filename }));
        })
        .then(({ blob, filename }) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        })
        .catch(err => {
            showToast(t('logs.exportError', { error: err.message }), 'error');
        });
}

function applyAuditFilters() {
    auditFilters.search = document.getElementById('audit-search')?.value || '';
    auditFilters.user = document.getElementById('audit-user-filter')?.value || '';
    auditFilters.category = document.getElementById('audit-category-filter')?.value ?? 'write';
    auditPage = 1;
    loadAuditData();
}

async function loadAuditData() {
    const container = document.getElementById('audit-table-container');
    if (!container) return;

    try {
        const params = new URLSearchParams();
        params.set('page', auditPage);
        params.set('per_page', '50');
        // Always send category — empty string = all
        params.set('category', auditFilters.category);
        if (auditFilters.user) params.set('user', auditFilters.user);
        if (auditFilters.search) params.set('search', auditFilters.search);
        if (auditFilters.from_date) params.set('from_date', auditFilters.from_date);
        if (auditFilters.to_date) params.set('to_date', auditFilters.to_date);

        const data = await apiGet(`/logs/audit?${params.toString()}`);
        const items = data.items || [];

        if (items.length === 0) {
            container.innerHTML = `
                <div class="card-body text-center py-4 text-muted">
                    <i class="ti ti-list-search" style="font-size: 2rem;"></i>
                    <p class="mt-2 mb-0">${t('logs.noLogsFound')}</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="table-responsive">
                <table class="table table-vcenter card-table table-hover table-sm">
                    <thead>
                        <tr>
                            <th>${t('logs.timestamp')}</th>
                            <th>${t('logs.user')}</th>
                            <th>${t('logs.request')}</th>
                            <th>Status</th>
                            <th>${t('logs.duration')}</th>
                            <th>${t('logs.ip')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.map(renderAuditRow).join('')}
                    </tbody>
                </table>
            </div>
            ${renderPagination(data.page, data.pages, data.total)}
        `;

        // Pagination listeners
        container.querySelectorAll('[data-audit-page]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                auditPage = parseInt(btn.dataset.auditPage);
                loadAuditData();
            });
        });

    } catch (error) {
        container.innerHTML = `
            <div class="card-body text-center py-4 text-danger">
                <i class="ti ti-alert-circle" style="font-size: 2rem;"></i>
                <p class="mt-2 mb-0">${t('common.errorPrefix')}${escapeHtml(error.message)}</p>
            </div>
        `;
    }
}

function renderAuditRow(log) {
    const methodColors = {
        'GET': 'azure', 'POST': 'green', 'PUT': 'orange',
        'PATCH': 'yellow', 'DELETE': 'red'
    };
    const methodColor = methodColors[log.method] || 'secondary';

    let statusColor = 'green';
    if (log.status_code >= 400 && log.status_code < 500) statusColor = 'yellow';
    if (log.status_code >= 500) statusColor = 'red';

    const ts = new Date(log.timestamp);
    const timeStr = ts.toLocaleString(undefined, {
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    // Payload button — only show if request_body is meaningful (not null/empty/{})
    let payloadHtml = '';
    if (log.request_body && log.request_body !== '{}' && log.request_body !== '[]') {
        window._auditPayloads = window._auditPayloads || {};
        window._auditPayloads[log.id] = log.request_body;

        payloadHtml = `
            <button class="btn btn-icon btn-sm btn-ghost-primary ms-1" ${actionAttrs('showAuditPayload', log.id)} title="${t('logs.viewPayload')}">
                <i class="ti ti-eye"></i>
            </button>
        `;
    }

    // Response error indicator — show for 4xx/5xx with response_summary
    let errorHtml = '';
    if (log.response_summary && log.status_code >= 400) {
        window._auditErrors = window._auditErrors || {};
        window._auditErrors[log.id] = log.response_summary;

        errorHtml = `
            <button class="btn btn-icon btn-sm btn-ghost-danger ms-1" ${actionAttrs('showAuditError', log.id)} title="${t('logs.errorDetail')}">
                <i class="ti ti-alert-triangle"></i>
            </button>
        `;
    }

    return `
        <tr>
            <td class="text-nowrap text-muted" style="font-size: .8125rem;">${timeStr}</td>
            <td><span class="badge bg-cyan-lt">${escapeHtml(log.username)}</span></td>
            <td>
                <span class="badge bg-${methodColor}-lt me-1">${escapeHtml(log.method)}</span>
                <code title="${escapeHtml(log.path)}">${escapeHtml(truncatePath(log.path))}</code>
                ${payloadHtml}
                ${errorHtml}
            </td>
            <td><span class="badge bg-${statusColor}-lt">${escapeHtml(log.status_code)}</span></td>
            <td class="text-muted" style="font-size: .8125rem;">${escapeHtml(log.duration_ms)}ms</td>
            <td class="text-muted" style="font-size: .8125rem;">${escapeHtml(log.client_ip)}</td>
        </tr>
    `;
}

// --- Payload Modal (with copy button) ---

window.showAuditPayload = function (logId) {
    const payload = window._auditPayloads && window._auditPayloads[logId];
    if (!payload) return;

    let formattedHtml = escapeHtml(payload);
    let rawPayload = payload;
    try {
        const parsed = JSON.parse(payload);
        const formatted = JSON.stringify(parsed, null, 2);
        formattedHtml = escapeHtml(formatted);
        rawPayload = formatted;
    } catch (e) { }

    _showCodeModal(t('logs.requestPayload'), 'ti-code', formattedHtml, rawPayload);
};

// --- Error Detail Modal ---

window.showAuditError = function (logId) {
    const detail = window._auditErrors && window._auditErrors[logId];
    if (!detail) return;

    let formattedHtml = escapeHtml(detail);
    let rawDetail = detail;
    try {
        const parsed = JSON.parse(detail);
        const formatted = JSON.stringify(parsed, null, 2);
        formattedHtml = escapeHtml(formatted);
        rawDetail = formatted;
    } catch (e) { }

    _showCodeModal(t('logs.errorDetailTitle'), 'ti-alert-triangle', formattedHtml, rawDetail);
};

// --- Shared Code Modal helper ---

function _showCodeModal(title, icon, formattedHtml, rawText) {
    const modalId = 'modal-audit-detail';

    const modalHtml = `
        <div class="modal fade" id="${modalId}" tabindex="-1">
            <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title"><i class="${icon} me-2"></i>${escapeHtml(title)}</h5>
                        <div class="ms-auto d-flex gap-2">
                            <button type="button" class="btn btn-sm btn-ghost-primary" data-bs-toggle="clipboard"
                                    data-bs-target="#audit-detail-raw">
                                <span class="clipboard-label"><i class="ti ti-copy me-1"></i>${t('common.copy')}</span>
                                <span class="clipboard-feedback"><i class="ti ti-check me-1"></i>${t('common.copied')}</span>
                            </button>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                    </div>
                    <div class="modal-body p-0">
                        <pre style="margin:0; padding:1.5rem; background: #1e293b; color: #c8d3e0; border-radius: 0 0 4px 4px;"><code>${formattedHtml}</code></pre>
                        <!-- What the copy button copies: the raw text, not the highlighted HTML.
                             Not a data-bs-text attribute: Bootstrap JSON-parses data-bs-* values. -->
                        <textarea id="audit-detail-raw" hidden>${escapeHtml(rawText)}</textarea>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.getElementById(modalId)?.remove();
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = new bootstrap.Modal(document.getElementById(modalId));
    modal.show();
}

function truncatePath(path) {
    if (path.length <= 50) return path;
    return path.substring(0, 47) + '...';
}

function renderPagination(currentPage, totalPages, totalItems) {
    if (totalPages <= 1) {
        return `<div class="card-footer"><small class="text-muted">${totalItems} ${t('common.results')}</small></div>`;
    }

    let pages = '';
    const maxVisible = 5;
    let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let end = Math.min(totalPages, start + maxVisible - 1);
    if (end - start < maxVisible - 1) start = Math.max(1, end - maxVisible + 1);

    if (start > 1) {
        pages += `<li class="page-item"><a class="page-link" href="#" data-audit-page="1">1</a></li>`;
        if (start > 2) pages += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
    }
    for (let i = start; i <= end; i++) {
        pages += `<li class="page-item ${i === currentPage ? 'active' : ''}">
            <a class="page-link" href="#" data-audit-page="${i}">${i}</a></li>`;
    }
    if (end < totalPages) {
        if (end < totalPages - 1) pages += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
        pages += `<li class="page-item"><a class="page-link" href="#" data-audit-page="${totalPages}">${totalPages}</a></li>`;
    }

    return `
        <div class="card-footer d-flex align-items-center justify-content-between">
            <small class="text-muted">${t('logs.pageOf', { current: currentPage, total: totalPages, items: totalItems })}</small>
            <ul class="pagination m-0 ms-auto">
                <li class="page-item ${currentPage <= 1 ? 'disabled' : ''}">
                    <a class="page-link" href="#" data-audit-page="${currentPage - 1}"><i class="ti ti-chevron-left"></i></a>
                </li>
                ${pages}
                <li class="page-item ${currentPage >= totalPages ? 'disabled' : ''}">
                    <a class="page-link" href="#" data-audit-page="${currentPage + 1}"><i class="ti ti-chevron-right"></i></a>
                </li>
            </ul>
        </div>
    `;
}


// ==========================================
//  SYSTEM LOG TAB
// ==========================================

async function renderSystemTab() {
    const content = document.getElementById('logs-tab-content');
    if (!content) return;

    content.innerHTML = `
        <div class="card-body border-bottom py-3">
            <div class="d-flex flex-wrap gap-2 align-items-center">
                <select class="form-select form-select-sm w-auto" id="syslog-lines">
                    <option value="100">100 ${t('logs.lines')}</option>
                    <option value="200" selected>200 ${t('logs.lines')}</option>
                    <option value="500">500 ${t('logs.lines')}</option>
                    <option value="1000">1000 ${t('logs.lines')}</option>
                </select>
                <div class="input-icon flex-grow-1" style="max-width: 300px;">
                    <span class="input-icon-addon"><i class="ti ti-search"></i></span>
                    <input type="text" class="form-control form-control-sm" id="syslog-search"
                           placeholder="${t('logs.filterGrep')}">
                </div>
                <div class="form-check form-switch ms-2">
                    <input class="form-check-input" type="checkbox" id="syslog-hide-audit" checked>
                    <label class="form-check-label" for="syslog-hide-audit" style="font-size: .8125rem;">
                        ${t('logs.hideAudit')}
                    </label>
                </div>
                <button class="btn btn-sm btn-primary" id="btn-syslog-load">
                    <i class="ti ti-refresh me-1"></i>${t('logs.load')}
                </button>
            </div>
        </div>
        <div id="syslog-container">
            <div class="card-body text-center py-4 text-muted">
                <div class="spinner-border spinner-border-sm me-2"></div>
                ${t('common.loading')}
            </div>
        </div>
    `;

    document.getElementById('btn-syslog-load')?.addEventListener('click', loadSystemLog);
    document.getElementById('syslog-search')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loadSystemLog();
    });
    document.getElementById('syslog-hide-audit')?.addEventListener('change', loadSystemLog);

    await loadSystemLog();
}

async function loadSystemLog() {
    const container = document.getElementById('syslog-container');
    if (!container) return;

    const lines = document.getElementById('syslog-lines')?.value || '200';
    const search = document.getElementById('syslog-search')?.value || '';
    const hideAudit = document.getElementById('syslog-hide-audit')?.checked ?? true;

    try {
        const params = new URLSearchParams();
        params.set('lines', lines);
        if (search) params.set('search', search);

        const data = await apiGet(`/logs/system?${params.toString()}`);
        let logLines = data.lines || [];

        // Filter out AUDIT lines if toggle is on
        if (hideAudit) {
            logLines = logLines.filter(line => !/\bAUDIT\b/.test(line));
        }

        if (logLines.length === 0) {
            container.innerHTML = `
                <div class="card-body text-center py-4 text-muted">
                    <i class="ti ti-file-off" style="font-size: 2rem;"></i>
                    <p class="mt-2 mb-0">${t('logs.noLogFound')}</p>
                </div>
            `;
            return;
        }

        // Use a dark background for the terminal-like viewer regardless of theme
        container.innerHTML = `
            <div class="card-body p-0">
                <pre id="syslog-output" style="
                    max-height: 600px; overflow-y: auto; margin: 0; padding: 1rem;
                    font-size: 0.75rem; line-height: 1.6;
                    background: #1e293b; color: #c8d3e0;
                    border-radius: 0;
                ">${logLines.map(formatSystemLogLine).join('\n')}</pre>
            </div>
            <div class="card-footer">
                <small class="text-muted">${t('logs.linesLabel', { count: logLines.length })} — <code>journalctl -u madmin</code></small>
            </div>
        `;

        // Scroll to bottom
        const output = document.getElementById('syslog-output');
        if (output) output.scrollTop = output.scrollHeight;

    } catch (error) {
        container.innerHTML = `
            <div class="card-body text-center py-4 text-danger">
                <i class="ti ti-alert-circle" style="font-size: 2rem;"></i>
                <p class="mt-2 mb-0">${t('common.errorPrefix')}${escapeHtml(error.message)}</p>
            </div>
        `;
    }
}

function formatSystemLogLine(line) {
    const escaped = escapeHtml(line);

    // Error / Critical → red
    if (/\bERROR\b/i.test(line) || /\bCRITICAL\b/i.test(line) || /\bTraceback\b/.test(line)) {
        return `<span style="color:#f87171">${escaped}</span>`;
    }
    // Warning → amber
    if (/\bWARNING\b/i.test(line) || /\bWARN\b/i.test(line)) {
        return `<span style="color:#fbbf24">${escaped}</span>`;
    }
    // Audit lines → cyan
    if (/\bAUDIT\b/.test(line)) {
        return `<span style="color:#67e8f9">${escaped}</span>`;
    }
    // Uvicorn access log (INFO: IP - "METHOD /path") → dimmed
    if (/^INFO:\s+\d/.test(line)) {
        return `<span style="color:#64748b">${escaped}</span>`;
    }

    // Default → light gray (visible on dark bg)
    return escaped;
}

// Handlers called from markup (data-action); resolved on window at call time.
registerActions({
    showAuditError: (...a) => window.showAuditError(...a),
    showAuditPayload: (...a) => window.showAuditPayload(...a),
});
