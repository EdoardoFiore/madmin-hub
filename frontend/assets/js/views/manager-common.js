/**
 * MADMIN Manager - helpers shared by the manager views (modals, badges, dates).
 */
import { escapeHtml, showToast } from '../utils.js';

export function fmtDate(value) {
    if (!value) return '-';
    // The API sends naive UTC datetimes
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z');
    return isNaN(d) ? '-' : d.toLocaleString('it-IT');
}

export function relTime(value) {
    if (!value) return 'mai';
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z');
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${Math.max(s, 0)}s fa`;
    if (s < 3600) return `${Math.round(s / 60)} min fa`;
    if (s < 86400) return `${Math.round(s / 3600)} h fa`;
    return `${Math.round(s / 86400)} g fa`;
}

export const STATUS_LABELS = { suspended: 'Sospesa', revoked: 'Revocata', decommissioned: 'Dismessa' };

export function onlineBadge(inst) {
    if (inst.status === 'suspended') return '<span class="badge bg-warning-lt">Sospesa</span>';
    if (inst.status !== 'active') {
        return `<span class="badge bg-secondary-lt">${STATUS_LABELS[inst.status] || inst.status}</span>`;
    }
    return inst.online
        ? '<span class="badge bg-success-lt"><span class="status-dot status-dot-animated bg-success me-1"></span>Online</span>'
        : '<span class="badge bg-danger-lt"><span class="status-dot bg-danger me-1"></span>Offline</span>';
}

export function commandStatusBadge(status) {
    const cls = { queued: 'bg-secondary-lt', sent: 'bg-info-lt', running: 'bg-primary-lt', done: 'bg-success-lt',
                  failed: 'bg-danger-lt', expired: 'bg-warning-lt' }[status] || 'bg-secondary-lt';
    const label = { queued: 'In coda', sent: 'Inviato', running: 'In corso', done: 'Completato',
                    failed: 'Fallito', expired: 'Scaduto' }[status] || status;
    return `<span class="badge ${cls}">${label}</span>`;
}

// ============== FORM KIT ==============
// Every modal of the manager is built from these pieces, so they all look and
// behave the same: required fields marked with a red asterisk, optional ones
// say so, a short hint under each field (format and example when it has one),
// errors under the field, consequences at the top in a coloured box, typed
// confirmations in a red box that turns green when the text matches.

const TONES = {
    info: ['alert-info', 'ti-info-circle'],
    warning: ['alert-warning', 'ti-alert-triangle'],
    danger: ['alert-danger', 'ti-alert-octagon'],
    success: ['alert-success', 'ti-circle-check'],
};

/**
 * A form field. Options: type (text, number, password, textarea, select,
 * checkbox, time, ...), required, hint (HTML, short), format (shown in the
 * error when the pattern does not match, e.g. "chiave=valore"), example,
 * value, placeholder, pattern, min, max, minlength, maxlength, rows,
 * options ([[value, label]] for selects), mono (monospace), attrs (raw), col
 * (bootstrap column class when used inside a .row).
 */
export function field(name, label, opts = {}) {
    const {
        type = 'text', required = false, hint = '', format = '', example = '', value = '', placeholder = '',
        pattern = '', min = null, max = null, minlength = null, maxlength = null, rows = 3, options = [],
        mono = false, attrs = '', col = '', checked = false, id = '',
    } = opts;
    const fid = id || `f-${name}-${Math.random().toString(36).slice(2, 8)}`;
    const a = [
        `name="${escapeHtml(name)}"`, `id="${fid}"`, required ? 'required' : '',
        pattern ? `pattern="${escapeHtml(pattern)}"` : '', min != null ? `min="${min}"` : '', max != null ? `max="${max}"` : '',
        minlength != null ? `minlength="${minlength}"` : '', maxlength != null ? `maxlength="${maxlength}"` : '',
        placeholder || example ? `placeholder="${escapeHtml(placeholder || example)}"` : '',
        format ? `data-format="${escapeHtml(format)}"` : '', attrs,
    ].filter(Boolean).join(' ');
    const cls = `form-control${mono ? ' font-monospace' : ''}`;
    const mark = required ? '<span class="text-danger ms-1" title="Obbligatorio">*</span>'
        : '<span class="text-muted small fw-normal ms-1">facoltativo</span>';
    let input;
    if (type === 'checkbox') {
        input = `<label class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" ${a} ${checked ? 'checked' : ''}>
            <span class="form-check-label">${label}</span></label>`;
        return wrap(`${input}${hint ? `<div class="form-hint">${hint}</div>` : ''}`);
    }
    if (type === 'textarea') {
        input = `<textarea class="${cls}" rows="${rows}" ${a}>${escapeHtml(value)}</textarea>`;
    } else if (type === 'select') {
        input = `<select class="form-select" ${a}>${options.map(([v, l]) =>
            `<option value="${escapeHtml(v)}" ${String(v) === String(value) ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>`;
    } else {
        input = `<input type="${type}" class="${cls}" value="${escapeHtml(value)}" ${a}>`;
    }
    const help = [hint, format ? `Formato: <code>${escapeHtml(format)}</code>` : '',
                  example && !placeholder ? `Es. <code>${escapeHtml(example)}</code>` : ''].filter(Boolean).join(' · ');
    return wrap(`<label class="form-label" for="${fid}">${label}${mark}</label>${input}
        <div class="invalid-feedback"></div>${help ? `<div class="form-hint">${help}</div>` : ''}`);

    function wrap(html) {
        return col ? `<div class="${col}">${html}</div>` : `<div class="mb-3">${html}</div>`;
    }
}

/** A small section title inside a modal. */
export function formSection(title, note = '') {
    return `<div class="d-flex align-items-baseline gap-2 mt-2 mb-2 border-bottom pb-1">
        <h4 class="mb-0">${title}</h4>${note ? `<span class="small text-muted">${note}</span>` : ''}</div>`;
}

/**
 * Coloured box at the top of a modal: what the action does and what it
 * costs. items: short lines (HTML), each optionally [icon, text].
 */
export function notice(tone, title, items = []) {
    const [cls, icon] = TONES[tone] || TONES.info;
    const list = items.filter(Boolean).map((it) => {
        const [ic, text] = Array.isArray(it) ? it : [null, it];
        return `<li class="d-flex gap-2 mb-1">${ic ? `<i class="ti ${ic} mt-1"></i>` : '<span>•</span>'}<span>${text}</span></li>`;
    }).join('');
    return `<div class="alert ${cls} mb-3"><div class="d-flex gap-2">
        <i class="ti ${icon} fs-2 lh-1"></i><div class="flex-fill">
        ${title ? `<h4 class="alert-title mb-1">${title}</h4>` : ''}
        ${list ? `<ul class="list-unstyled mb-0 small">${list}</ul>` : ''}</div></div></div>`;
}

/**
 * Typed confirmation: the submit button stays disabled until the field holds
 * exactly `expected`. `what` names it ("il nome dell'istanza").
 */
export function typedConfirm(expected, what = "il nome dell'istanza") {
    return `<div class="border border-2 border-danger rounded p-3 mb-2 bg-danger-lt" data-typed-box>
        <label class="form-label mb-1">Per confermare scrivi ${what}:
            <span class="font-monospace fw-bold fs-3 d-block mt-1 user-select-all">${escapeHtml(expected)}</span></label>
        <input class="form-control font-monospace" name="confirm_name" autocomplete="off" spellcheck="false"
            data-confirm="${escapeHtml(expected)}" placeholder="${escapeHtml(expected)}">
        <div class="small mt-1" data-typed-state>Il pulsante si attiva quando il testo coincide esattamente.</div>
    </div>`;
}

const MESSAGES = (input) => {
    const v = input.validity;
    if (v.valueMissing) return 'Campo obbligatorio';
    if (v.patternMismatch) return input.dataset.format ? `Formato richiesto: ${input.dataset.format}` : 'Formato non valido';
    if (v.typeMismatch) return input.type === 'email' ? 'Indirizzo e-mail non valido' : 'Valore non valido';
    if (v.rangeUnderflow) return `Minimo ${input.min}`;
    if (v.rangeOverflow) return `Massimo ${input.max}`;
    if (v.tooShort) return `Almeno ${input.minLength} caratteri`;
    if (v.tooLong) return `Al massimo ${input.maxLength} caratteri`;
    if (v.stepMismatch || v.badInput) return 'Valore non valido';
    return input.validationMessage || 'Valore non valido';
};

/** Marks the invalid fields of a form (message under each); true when all valid. */
export function validateForm(form) {
    let first = null;
    form.querySelectorAll('input, select, textarea').forEach((input) => {
        if (input.disabled || input.type === 'hidden' || input.closest('[hidden]')) {
            input.classList.remove('is-invalid');
            return;
        }
        const fb = input.parentElement.querySelector(':scope > .invalid-feedback')
            || input.closest('.mb-3, [class*="col"]')?.querySelector('.invalid-feedback');
        if (!input.checkValidity()) {
            input.classList.add('is-invalid');
            if (fb) fb.textContent = MESSAGES(input);
            first = first || input;
        } else {
            input.classList.remove('is-invalid');
        }
    });
    if (first) first.focus();
    return !first;
}

/** A field's error coming from the server (or a check of the caller). */
export function fieldError(form, name, message) {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input) throw new Error(message);
    input.classList.add('is-invalid');
    const fb = input.parentElement.querySelector(':scope > .invalid-feedback');
    if (fb) fb.textContent = message;
    input.focus();
    return false;
}

const TONE_STATUS = { danger: 'bg-danger', warning: 'bg-warning', primary: 'bg-primary', success: 'bg-success' };

/**
 * Modal with a form. onSubmit(form) may throw (the error is shown inside the
 * modal, which stays open) or return false to keep it open. The fields are
 * validated first (required, pattern, ranges), each error under its field.
 * Options: submitText, submitClass, size, tone (coloured top bar: danger,
 * warning, primary), icon (title icon), subtitle (small text under the title).
 */
export function formModal(title, bodyHtml, onSubmit, {
    submitText = 'Salva', submitClass = 'btn-primary', size = '', tone = '', icon = '', subtitle = '',
} = {}) {
    const id = `manager-modal-${Date.now()}`;
    document.body.insertAdjacentHTML('beforeend', `
        <div class="modal modal-blur fade" id="${id}" tabindex="-1">
            <div class="modal-dialog ${size ? 'modal-' + size : ''}">
                <form class="modal-content" novalidate>
                    ${TONE_STATUS[tone] ? `<div class="modal-status ${TONE_STATUS[tone]}"></div>` : ''}
                    <div class="modal-header">
                        <div>
                            <h5 class="modal-title">${icon ? `<i class="ti ${icon} me-2"></i>` : ''}${escapeHtml(title)}</h5>
                            ${subtitle ? `<div class="small text-muted mt-1">${subtitle}</div>` : ''}
                        </div>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        ${bodyHtml}
                        <div class="alert alert-danger d-none mb-0 mt-2" data-form-error></div>
                    </div>
                    <div class="modal-footer">
                        <span class="me-auto small text-muted">${/class="text-danger ms-1"/.test(bodyHtml) ? '<span class="text-danger">*</span> obbligatorio' : ''}</span>
                        <button type="button" class="btn btn-link" data-bs-dismiss="modal">Annulla</button>
                        <button type="submit" class="btn ${submitClass}">${escapeHtml(submitText)}</button>
                    </div>
                </form>
            </div>
        </div>`);
    const el = document.getElementById(id);
    const modal = new bootstrap.Modal(el);
    const form = el.querySelector('form');
    const btn = form.querySelector('[type=submit]');
    const errorBox = form.querySelector('[data-form-error]');
    // Typed confirmation: the button waits for the exact text
    const typed = form.querySelector('[data-confirm]');
    const syncTyped = () => {
        if (!typed) return true;
        const ok = typed.value.trim() === typed.dataset.confirm;
        const box = typed.closest('[data-typed-box]');
        box.classList.toggle('border-danger', !ok);
        box.classList.toggle('bg-danger-lt', !ok);
        box.classList.toggle('border-success', ok);
        box.classList.toggle('bg-success-lt', ok);
        box.querySelector('[data-typed-state]').innerHTML = ok
            ? '<i class="ti ti-check me-1"></i>Coincide' : 'Il pulsante si attiva quando il testo coincide esattamente.';
        btn.disabled = !ok;
        return ok;
    };
    if (typed) {
        typed.addEventListener('input', syncTyped);
        syncTyped();
    }
    // An error under a field goes away as soon as the field is edited
    form.addEventListener('input', (e) => e.target.classList?.remove('is-invalid'));
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorBox.classList.add('d-none');
        if (!validateForm(form) || !syncTyped()) return;
        const label = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>${label}`;
        try {
            if ((await onSubmit(form)) !== false) modal.hide();
        } catch (err) {
            errorBox.textContent = err.message || 'Errore';
            errorBox.classList.remove('d-none');
        } finally {
            btn.innerHTML = label;
            btn.disabled = typed ? !syncTyped() : false;
        }
    });
    el.addEventListener('hidden.bs.modal', () => el.remove());
    el.addEventListener('shown.bs.modal', () => form.querySelector('input:not([type=hidden]):not([readonly]), select, textarea')?.focus());
    modal.show();
    return el;
}

/**
 * Confirmation of an action, as a promise (true = confirmed). tone colours
 * the top bar and the button (danger, warning, primary); intro and items go
 * in a notice box; typed = text to type before the button activates.
 */
export function confirmAction({ title, tone = 'danger', intro = '', items = [], body = '', confirmText = 'Conferma',
                                typed = null, typedWhat, icon = '' }) {
    return new Promise((resolve) => {
        let done = false;
        const btnClass = { danger: 'btn-danger', warning: 'btn-warning', primary: 'btn-primary', success: 'btn-success' }[tone] || 'btn-primary';
        const el = formModal(title, `${intro || items.length ? notice(tone === 'primary' ? 'info' : tone, intro, items) : ''}
            ${body}${typed ? typedConfirm(typed, typedWhat) : ''}`, async () => { done = true; resolve(true); },
        { submitText: confirmText, submitClass: btnClass, tone, icon });
        el.addEventListener('hidden.bs.modal', () => { if (!done) resolve(false); });
    });
}

/** A value shown once (token, link, certificate), with a copy button. */
/**
 * Read-only text (a command, token, key) with a Copy button. Works inside any
 * modal opened by secretModal, which wires the buttons. Long single lines wrap
 * in the textarea instead of overflowing.
 */
export function copyBlock(text, rows = null) {
    const value = String(text ?? '');
    const n = rows || Math.min(8, Math.max(1, value.split('\n').length, Math.ceil(value.length / 80)));
    return `
        <div class="mb-2">
            <textarea class="form-control font-monospace small" rows="${n}" readonly
                spellcheck="false" style="resize: vertical">${escapeHtml(value)}</textarea>
            <button type="button" class="btn btn-sm btn-outline-primary mt-1" data-copy-text="${escapeHtml(value)}">
                <i class="ti ti-copy me-1"></i>Copia
            </button>
        </div>`;
}

/**
 * How to use an enrollment token on the instance, with the token already in
 * the commands. Without a token: the same text with a placeholder.
 */
export function enrollTokenHelp(token = null, { expiresAt = null, maxUses = 1, reenroll = false } = {}) {
    const t = token ? token.replace(/'/g, '') : '<token>';
    const uses = reenroll ? 'Registra di nuovo <strong>questa istanza</strong> (stessa identità, backup e licenze)'
        : !maxUses ? 'Utilizzabile da più istanze'
        : maxUses === 1 ? 'Vale per <strong>una sola istanza</strong>'
        : `Vale per <strong>${maxUses} istanze</strong>`;
    const expiry = expiresAt ? ` e scade il <strong>${escapeHtml(fmtDate(expiresAt))}</strong>` : '';
    return `
        <p class="text-muted mb-3">
            Mostrato <strong>una sola volta</strong>. ${uses}${expiry}.
            I comandi vanno eseguiti come root sull'istanza; il client del manager è nel branch
            <code>feat/manager-agent</code> di MADMIN.
        </p>

        <h4 class="mb-1">Nuova installazione di MADMIN</h4>
        <p class="mb-2">Dalla cartella del repository MADMIN:</p>
        ${copyBlock(`sudo MADMIN_MANAGER_TOKEN='${t}' bash scripts/setup-madmin.sh -u admin -p '<password>'`)}

        <h4 class="mt-4 mb-1">MADMIN già installato</h4>
        ${copyBlock(`cd /opt/madmin/backend && sudo MADMIN_MANAGER_TOKEN='${t}' ../venv/bin/python -m core.manager enroll`)}
        <p class="text-muted small mb-0">
            Se l'istanza è già registrata (anche su un altro manager) aggiungi <code>--force</code>.
            Verifica con <code>cd /opt/madmin/backend && sudo ../venv/bin/python -m core.manager status</code>.
        </p>`;
}

/**
 * Modal for something shown once. `intro` is HTML (paragraphs, lists,
 * copyBlock()s); `value`, when given, goes below it in a copy block.
 */
export function secretModal(title, intro, value = null, extraHtml = '') {
    const id = `manager-secret-${Date.now()}`;
    document.body.insertAdjacentHTML('beforeend', `
        <div class="modal modal-blur fade" id="${id}" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${escapeHtml(title)}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">${intro}</div>
                        ${value != null ? copyBlock(value, 4) : ''}
                        ${extraHtml}
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-primary" data-bs-dismiss="modal">Chiudi</button>
                    </div>
                </div>
            </div>
        </div>`);
    const el = document.getElementById(id);
    const modal = new bootstrap.Modal(el);
    el.querySelectorAll('[data-copy-text]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(btn.dataset.copyText);
                showToast('Copiato', 'success');
            } catch {
                btn.previousElementSibling?.select();
            }
        });
    });
    el.querySelectorAll('textarea[readonly]').forEach((t) => t.addEventListener('focus', () => t.select()));
    el.addEventListener('hidden.bs.modal', () => el.remove());
    modal.show();
    return el;
}

export function formData(form) {
    const out = {};
    for (const [k, v] of new FormData(form).entries()) out[k] = typeof v === 'string' ? v.trim() : v;
    return out;
}

// --- Versions and resources ---

// "2.10.1" > "2.9.3": numeric parts, missing ones count as 0
export function cmpVersion(a, b) {
    const pa = String(a).split(/\D+/).filter(Boolean).map(Number);
    const pb = String(b).split(/\D+/).filter(Boolean).map(Number);
    for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
        const d = (pa[k] || 0) - (pb[k] || 0);
        if (d) return d;
    }
    return 0;
}

/** A percentage as a small bar, red/orange when high (CPU, RAM, disk). */
export function meter(label, v) {
    if (v === undefined || v === null) return '';
    const cls = v >= 90 ? 'bg-danger' : v >= 75 ? 'bg-warning' : 'bg-primary';
    return `<div class="d-flex align-items-center gap-2 small lh-1 my-1">
        <span class="text-muted" style="width: 2.6rem">${label}</span>
        <div class="progress progress-sm flex-fill" style="min-width: 50px"><div class="progress-bar ${cls}" style="width: ${Math.min(100, v)}%"></div></div>
        <span class="text-end" style="width: 2.4rem">${Math.round(v)}%</span></div>`;
}

// --- Groups (manager -> customer, manager -> partner -> customer) and labels ---

/** <option>s for a group select; groups come sorted by path from /api/groups. */
export function groupOptions(groups, selected = '', { none = 'Nessun gruppo', partnersOnly = false } = {}) {
    const opts = none !== null ? [`<option value="">${escapeHtml(none)}</option>`] : [];
    for (const g of groups) {
        if (partnersOnly && g.kind !== 'partner') continue;
        const indent = g.parent_id ? '    ' : '';
        const kind = g.kind === 'partner' ? ' (partner)' : '';
        opts.push(`<option value="${escapeHtml(g.id)}" ${g.id === selected ? 'selected' : ''}>${indent}${escapeHtml(g.name)}${kind}</option>`);
    }
    return opts.join('');
}

export function groupPath(groups, id) {
    return (groups.find(g => g.id === id) || {}).path || '';
}

export function labelBadges(labels) {
    return Object.entries(labels || {}).map(([k, v]) =>
        `<span class="badge bg-azure-lt me-1">${escapeHtml(k)}=${escapeHtml(v)}</span>`).join('');
}

/** "k=v" lines <-> object */
export function labelsToText(labels) {
    return Object.entries(labels || {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

export function textToLabels(text) {
    const out = {};
    for (const line of (text || '').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const i = t.indexOf('=');
        if (i < 1) throw new Error(`Etichetta non valida: "${t}" (formato chiave=valore)`);
        out[t.slice(0, i).trim().toLowerCase()] = t.slice(i + 1).trim();
    }
    return out;
}

/** Optional registration fields (token, approval): name, group, labels, external ref. */
export function registrationFieldsHtml(groups, defaults = {}) {
    return `<div class="row g-2">
        ${field('name', 'Nome istanza', { maxlength: 100, value: defaults.name || '', col: 'col-md-6', hint: 'vuoto = hostname' })}
        ${field('group_id', 'Gruppo', { type: 'select', value: defaults.group_id || '', col: 'col-md-6',
            options: [['', 'Nessun gruppo'], ...groups.map(g => [g.id, `${g.parent_id ? '\u00a0\u00a0' : ''}${g.name}${g.kind === 'partner' ? ' (partner)' : ''}`])] })}
        ${field('labels', 'Etichette', { type: 'textarea', rows: 2, mono: true, value: labelsToText(defaults.labels), col: 'col-md-6',
            format: 'chiave=valore, una per riga', example: 'sito=milano' })}
        ${field('external_ref', 'Riferimento esterno', { maxlength: 100, mono: true, value: defaults.external_ref || '', col: 'col-md-6',
            hint: 'id nel sistema di provisioning' })}
    </div>`;
}

export function registrationFieldsValue(form) {
    const d = formData(form);
    return {
        name: d.name || null,
        group_id: d.group_id || null,
        labels: textToLabels(d.labels),
        external_ref: d.external_ref || null,
    };
}
