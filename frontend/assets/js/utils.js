/**
 * MADMIN - Utilities Module
 *
 * Common utility functions used across the application.
 */

import { t, getLang } from './i18n.js';

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {string} type - 'success', 'error', 'warning', 'info'
 * @param {number} duration - Duration in ms (default 3000)
 */
export function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
        success: 'ti-check',
        error: 'ti-x',
        warning: 'ti-alert-triangle',
        info: 'ti-info-circle'
    };

    const titles = {
        success: t('common.success'),
        error: t('common.error'),
        warning: t('common.warning'),
        info: t('common.info')
    };

    const toastId = `toast-${Date.now()}`;
    const toastHtml = `
        <div id="${toastId}" class="toast toast-${type}" role="alert">
            <div class="toast-header">
                <i class="ti ${icons[type]} me-2"></i>
                <strong class="me-auto">${titles[type]}</strong>
                <button type="button" class="btn-close" data-bs-dismiss="toast"></button>
            </div>
            <div class="toast-body">${escapeHtml(message)}</div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', toastHtml);

    const toastEl = document.getElementById(toastId);
    const toast = new bootstrap.Toast(toastEl, { delay: duration });
    toast.show();

    // Clean up after hide
    toastEl.addEventListener('hidden.bs.toast', () => {
        toastEl.remove();
    });
}

/**
 * Escape a value for interpolation into HTML, in text content or inside a
 * quoted attribute. Quotes are escaped too: views put server data in
 * title="…" / value="…", where escaping only <>& let a '"' close the
 * attribute and add event handlers.
 * null/undefined render as ''.
 * @param {*} text
 * @returns {string}
 */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Same as escapeHtml; kept for the views that import it by this name. */
export const escapeAttr = escapeHtml;

// --- Delegated actions ---
// The CSP forbids inline handlers (onclick="…"), so markup names a registered
// handler instead: actionAttrs('deleteRule', rule.id) renders
// data-action="deleteRule" data-args="[…]", and one document-level listener
// calls it. Arguments are JSON in an escaped attribute, so any value is safe;
// only registered names run, never an arbitrary global.

const _actions = new Map();

/**
 * Register handlers callable from markup built with actionAttrs().
 * Registering a name again replaces it (views re-register on each render).
 * @param {Object<string, Function>} handlers
 */
export function registerActions(handlers) {
    for (const [name, fn] of Object.entries(handlers)) _actions.set(name, fn);
}

/**
 * Attributes that make an element run a registered action on click.
 * The innermost element with an action wins, so a button inside a clickable
 * card or row runs only its own action.
 * @param {string} name
 * @param {...*} args - JSON-serialisable arguments
 * @returns {string}
 */
export function actionAttrs(name, ...args) {
    return `data-action="${escapeHtml(name)}" data-args="${escapeHtml(JSON.stringify(args))}"`;
}

/** Like actionAttrs, but runs on the element's `change` event (inputs). */
export function changeActionAttrs(name, ...args) {
    return `data-action-event="change" ${actionAttrs(name, ...args)}`;
}

function _dispatchAction(e) {
    const el = e.target.closest?.('[data-action]');
    if (!el || (el.dataset.actionEvent || 'click') !== e.type) return;
    const fn = _actions.get(el.dataset.action);
    if (!fn) {
        console.warn(`No handler registered for action "${el.dataset.action}"`);
        return;
    }
    if (el.tagName === 'A') e.preventDefault();
    let args;
    try {
        args = JSON.parse(el.dataset.args || '[]');
    } catch {
        return;
    }
    fn(...args);
}

if (typeof document !== 'undefined') {
    document.addEventListener('click', _dispatchAction);
    document.addEventListener('change', _dispatchAction);
}

/**
 * True when a click on a clickable row/card started on something that has its
 * own behaviour (a button, a link, an input, an action, or an element marked
 * data-no-row-click), so the row must not react as well.
 * @param {Event} e
 * @returns {boolean}
 */
export function isInnerControlClick(e) {
    return !!e.target.closest?.('[data-action], [data-no-row-click], button, a, input, select, label, .form-check');
}

/**
 * Format a date for display
 * @param {string|Date} date 
 * @returns {string}
 */
export function formatDate(date) {
    if (!date) return '-';
    const d = new Date(date);
    const locale = getLang() === 'it' ? 'it-IT' : 'en-US';
    return d.toLocaleDateString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Format relative time (e.g., "2 hours ago")
 * @param {string|Date} date 
 * @returns {string}
 */
export function formatRelativeTime(date) {
    if (!date) return '-';
    const d = new Date(date);
    const now = new Date();
    const diff = now - d;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return t('time.now');
    if (minutes < 60) return t('time.minutesAgo', { n: minutes });
    if (hours < 24) return t('time.hoursAgo', { n: hours });
    if (days < 7) return t('time.daysAgo', { n: days });

    return formatDate(date);
}

/**
 * Format a byte count for display (1024-based: B/KB/MB/GB/TB)
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Create a loading spinner HTML
 * @returns {string}
 */
export function loadingSpinner() {
    return `
        <div class="d-flex align-items-center justify-content-center py-5">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">${t('common.loading')}</span>
            </div>
        </div>
    `;
}

/**
 * Create an empty state HTML
 * @param {string} icon - Tabler icon class
 * @param {string} title 
 * @param {string} subtitle 
 * @returns {string}
 */
export function emptyState(icon, title, subtitle = '') {
    return `
        <div class="empty-state">
            <div class="empty-state-icon">
                <i class="ti ${icon}"></i>
            </div>
            <div class="empty-state-title">${escapeHtml(title)}</div>
            ${subtitle ? `<div class="empty-state-subtitle">${escapeHtml(subtitle)}</div>` : ''}
        </div>
    `;
}

/**
 * Debounce a function
 * @param {Function} func 
 * @param {number} wait 
 * @returns {Function}
 */
export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Confirm dialog using Bootstrap modal
 * @param {string} title 
 * @param {string} message 
 * @param {string} confirmText 
 * @param {string} confirmClass 
 * @param {boolean} htmlContent - If true, message is rendered as HTML (use with caution)
 * @returns {Promise<boolean>}
 */
export function confirmDialog(title, message, confirmText = null, confirmClass = 'btn-danger', htmlContent = false, size = 'sm') {
    if (confirmText === null) confirmText = t('common.confirm');
    return new Promise((resolve) => {
        const modalId = `confirm-modal-${Date.now()}`;
        const sizeClass = size ? ` modal-${size}` : '';
        const modalHtml = `
            <div class="modal modal-blur fade" id="${modalId}" tabindex="-1">
                <div class="modal-dialog${sizeClass}">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">${escapeHtml(title)}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">${htmlContent ? message : escapeHtml(message)}</div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-link" data-bs-dismiss="modal">${t('common.cancel')}</button>
                            <button type="button" class="btn ${confirmClass}" id="${modalId}-confirm">${escapeHtml(confirmText)}</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modalEl = document.getElementById(modalId);
        const modal = new bootstrap.Modal(modalEl);

        const confirmBtn = document.getElementById(`${modalId}-confirm`);
        confirmBtn.addEventListener('click', () => {
            resolve(true);
            modal.hide();
        });

        modalEl.addEventListener('hidden.bs.modal', () => {
            resolve(false);
            modalEl.remove();
        });

        modal.show();
    });
}

/**
 * Get chain badge HTML
 * @param {string} chain 
 * @returns {string}
 */
export function chainBadge(chain) {
    const classes = {
        'INPUT': 'bg-teal-lt',
        'OUTPUT': 'bg-blue-lt',
        'FORWARD': 'bg-purple-lt',
        'PREROUTING': 'bg-orange-lt',
        'POSTROUTING': 'bg-pink-lt'
    };
    return `<span class="badge ${classes[chain] || 'bg-secondary-lt'}">${chain}</span>`;
}

/**
 * Get action badge HTML
 * @param {string} action 
 * @returns {string}
 */
export function actionBadge(action) {
    const classes = {
        // Filter actions
        'ACCEPT': 'bg-green-lt',
        'DROP': 'bg-red-lt',
        'REJECT': 'bg-orange-lt',
        'LOG': 'bg-blue-lt',
        // NAT actions
        'SNAT': 'bg-teal-lt',
        'DNAT': 'bg-cyan-lt',
        'MASQUERADE': 'bg-purple-lt',
        'REDIRECT': 'bg-pink-lt',
        // Mangle/Raw actions
        'MARK': 'bg-yellow-lt',
        'TOS': 'bg-yellow-lt',
        'TTL': 'bg-yellow-lt',
        'NOTRACK': 'bg-gray-lt'
    };
    return `<span class="badge ${classes[action] || 'bg-secondary-lt'}">${action}</span>`;
}

/**
 * Get status badge HTML
 * @param {boolean} active 
 * @returns {string}
 */
export function statusBadge(active) {
    if (active) {
        return `<span class="badge bg-green-lt">${t('common.active')}</span>`;
    }
    return `<span class="badge bg-secondary-lt">${t('common.disabled')}</span>`;
}

/**
 * Input dialog using Bootstrap modal
 * @param {string} title - Modal title
 * @param {string} label - Input label
 * @param {string} placeholder - Input placeholder
 * @param {string} type - Input type (text, email, etc.)
 * @returns {Promise<string|null>} - Input value or null if cancelled
 */
export function inputDialog(title, label, placeholder = '', type = 'text') {
    return new Promise((resolve) => {
        const modalId = `input-modal-${Date.now()}`;
        const inputId = `${modalId}-input`;
        const modalHtml = `
            <div class="modal modal-blur fade" id="${modalId}" tabindex="-1">
                <div class="modal-dialog modal-sm">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">${escapeHtml(title)}</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <div class="mb-3">
                                <label class="form-label">${escapeHtml(label)}</label>
                                <input type="${type}" class="form-control" id="${inputId}" placeholder="${escapeHtml(placeholder)}">
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-link" data-bs-dismiss="modal">${t('common.cancel')}</button>
                            <button type="button" class="btn btn-primary" id="${modalId}-confirm">${t('common.confirm')}</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modalEl = document.getElementById(modalId);
        const modal = new bootstrap.Modal(modalEl);
        const inputEl = document.getElementById(inputId);
        const confirmBtn = document.getElementById(`${modalId}-confirm`);

        // Confirm on button click
        confirmBtn.addEventListener('click', () => {
            resolve(inputEl.value || null);
            modal.hide();
        });

        // Confirm on Enter key
        inputEl.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                resolve(inputEl.value || null);
                modal.hide();
            }
        });

        // Cancel on modal close
        modalEl.addEventListener('hidden.bs.modal', () => {
            if (!inputEl.value) resolve(null);
            modalEl.remove();
        });

        modal.show();
        setTimeout(() => inputEl.focus(), 300);
    });
}

/**
 * Validate IPv4 CIDR notation (e.g. 192.168.1.1/24)
 * @param {string} val
 * @returns {boolean}
 */
export function isValidCIDR(val) {
    return /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(val);
}

/**
 * Validate IPv4 address (e.g. 192.168.1.1)
 * @param {string} val
 * @returns {boolean}
 */
export function isValidIP(val) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(val);
}

// == Tabler components ==
//
// tabler.js creates its components once, when it loads. Views render their
// markup later, so the components they declare are created here instead: once
// for the page, then for every element added to the DOM afterwards.
// Datepicker is not listed: tabler.js creates it itself on first focus or
// click, and a view that needs options creates it explicitly with them.
const TABLER_COMPONENTS = [
    ['[data-bs-toggle="otp"]', 'OtpInput'],
    ['[data-bs-toggle="clipboard"]', 'Clipboard'],
    ['[data-bs-strength]', 'Strength'],
];

/**
 * Create the Tabler components declared inside root (root included).
 * @param {ParentNode} root
 */
export function initTablerComponents(root = document) {
    if (!window.tabler) return;
    for (const [selector, name] of TABLER_COMPONENTS) {
        const found = [...root.querySelectorAll(selector)];
        if (root.matches?.(selector)) found.unshift(root);
        for (const el of found) {
            try {
                window.tabler[name].getOrCreateInstance(el);
            } catch (e) {
                console.error(`Tabler ${name} init failed`, e);
            }
        }
    }
}

/**
 * Create the Tabler components already in the page, then those of every
 * element added to it later. Call once at startup.
 */
export function watchTablerComponents() {
    initTablerComponents(document);
    new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) initTablerComponents(node);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    // The `reset` event fires before the fields are emptied
    document.addEventListener('reset', (e) => setTimeout(() => refreshStrengthMeters(e.target)));

    // Clipboard needs a secure context: MADMIN runs on HTTPS, a plain-http dev
    // setup is where this fires.
    document.addEventListener('error.bs.clipboard', () => showToast(t('common.copyError'), 'error'));
}

/**
 * Copy button (Tabler Clipboard). It copies the value of an input or the text
 * of the element matched by target; the check icon replaces the copy icon for a moment.
 * @param {string} target - CSS selector of the source element
 * @param {string} [cls] - button classes
 * @returns {string} HTML
 */
export function copyButton(target, cls = 'btn btn-icon btn-outline-secondary') {
    return `
        <button type="button" class="${cls}" data-bs-toggle="clipboard" data-bs-target="${escapeAttr(target)}"
                title="${escapeAttr(t('common.copy'))}" aria-label="${escapeAttr(t('common.copy'))}">
            <span class="clipboard-label"><i class="ti ti-copy"></i></span>
            <span class="clipboard-feedback"><i class="ti ti-check text-success"></i></span>
        </button>`;
}

/**
 * Password strength meter (Tabler Strength) for the field matched by input.
 * Place it right after the field, in the same parent. It is a hint only: the
 * password policy is enforced by the backend.
 * @param {string} input - CSS selector of the password field
 * @returns {string} HTML
 */
export function strengthMeter(input) {
    const messages = {
        weak: t('password.weak'),
        fair: t('password.fair'),
        good: t('password.good'),
        strong: t('password.strong'),
    };
    return `
        <div class="strength" data-bs-strength data-bs-input="${escapeAttr(input)}"
             data-bs-messages="${escapeAttr(JSON.stringify(messages))}"
             aria-label="${escapeAttr(t('password.strengthLabel'))}">
            <div class="strength-segment"></div><div class="strength-segment"></div>
            <div class="strength-segment"></div><div class="strength-segment"></div>
        </div>
        <div class="strength-text"></div>`;
}

/**
 * Re-rate the strength meters inside root. The meter listens to `input`
 * events only, so a field emptied by code or by form.reset() keeps showing
 * the old level until this runs.
 * @param {ParentNode} root
 */
export function refreshStrengthMeters(root = document) {
    root.querySelectorAll('.strength[data-bs-strength]').forEach(el => {
        window.tabler?.Strength.getInstance(el)?.evaluate();
    });
}

/**
 * Clear an OTP field (Tabler OtpInput): setting .value alone leaves the slots
 * showing the old digits.
 * @param {HTMLInputElement|null} input
 */
export function clearOtpInput(input) {
    if (!input) return;
    input.value = '';
    input.dispatchEvent(new Event('input'));
}

/**
 * Legend for an ApexCharts chart (Tabler Legend): one button per series,
 * clicking it hides or shows that series.
 * @param {Array<{label: string, color: string, value?: string, valueId?: string}>} items
 *        in series order; valueId gives the value span an id to update later
 * @param {object} [opts]
 * @param {boolean} [opts.large] - big value under the label (legend-lg)
 * @returns {string} HTML
 */
export function chartLegend(items, { large = false } = {}) {
    return `
        <div class="legend-list${large ? ' legend-list-divided' : ''}">
            ${items.map((item, i) => `
                <button type="button" class="legend${large ? ' legend-lg' : ''}" data-series-index="${i}"
                        style="--tblr-legend-color: ${escapeAttr(item.color)}" aria-pressed="true">
                    <span class="legend-dot"></span>${escapeHtml(item.label)}
                    <span class="legend-value"${item.valueId ? ` id="${escapeAttr(item.valueId)}"` : ''}>${escapeHtml(item.value ?? '')}</span>
                </button>`).join('')}
        </div>`;
}

/**
 * Make the legend rendered by chartLegend toggle the series of a chart.
 * getChart is called on every click, so a chart rebuilt later is still reached.
 * @param {HTMLElement|null} legendEl - element containing the legend
 * @param {() => object|null} getChart - returns the current ApexCharts instance
 */
export function bindChartLegend(legendEl, getChart) {
    legendEl?.addEventListener('click', (e) => {
        const btn = e.target.closest('.legend[data-series-index]');
        const chart = getChart();
        if (!btn || !chart) return;
        const series = chart.w.globals.seriesNames[Number(btn.dataset.seriesIndex)];
        if (series === undefined) return;
        const visible = chart.toggleSeries(series);
        btn.classList.toggle('legend-off', !visible);
        btn.setAttribute('aria-pressed', String(Boolean(visible)));
    });
}

/**
 * Show every series again in a legend rendered by chartLegend, after its
 * chart was redrawn with all series visible.
 * @param {HTMLElement|null} legendEl
 */
export function resetChartLegend(legendEl) {
    legendEl?.querySelectorAll('.legend[data-series-index]').forEach(btn => {
        btn.classList.remove('legend-off');
        btn.setAttribute('aria-pressed', 'true');
    });
}
