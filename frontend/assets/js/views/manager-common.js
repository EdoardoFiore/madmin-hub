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

/**
 * Modal with a form. onSubmit(form) may throw (the error is shown as a toast
 * and the modal stays open) or return false to keep it open.
 */
export function formModal(title, bodyHtml, onSubmit, { submitText = 'Salva', submitClass = 'btn-primary', size = '' } = {}) {
    const id = `manager-modal-${Date.now()}`;
    document.body.insertAdjacentHTML('beforeend', `
        <div class="modal modal-blur fade" id="${id}" tabindex="-1">
            <div class="modal-dialog ${size ? 'modal-' + size : ''}">
                <form class="modal-content" novalidate>
                    <div class="modal-header">
                        <h5 class="modal-title">${escapeHtml(title)}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">${bodyHtml}</div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-link" data-bs-dismiss="modal">Annulla</button>
                        <button type="submit" class="btn ${submitClass}">${escapeHtml(submitText)}</button>
                    </div>
                </form>
            </div>
        </div>`);
    const el = document.getElementById(id);
    const modal = new bootstrap.Modal(el);
    const form = el.querySelector('form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('[type=submit]');
        btn.disabled = true;
        try {
            if ((await onSubmit(form)) !== false) modal.hide();
        } catch (err) {
            showToast(err.message || 'Errore', 'error', 6000);
        } finally {
            btn.disabled = false;
        }
    });
    el.addEventListener('hidden.bs.modal', () => el.remove());
    modal.show();
    return el;
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
    return `
        <div class="mb-3"><label class="form-label">Nome istanza (vuoto = hostname)</label>
            <input name="name" class="form-control" maxlength="100" value="${escapeHtml(defaults.name || '')}"></div>
        <div class="mb-3"><label class="form-label">Gruppo (cliente o partner)</label>
            <select name="group_id" class="form-select">${groupOptions(groups, defaults.group_id || '')}</select></div>
        <div class="mb-3"><label class="form-label">Etichette (una per riga, chiave=valore)</label>
            <textarea name="labels" class="form-control font-monospace" rows="2" placeholder="sito=milano">${escapeHtml(labelsToText(defaults.labels))}</textarea></div>
        <div class="mb-3"><label class="form-label">Riferimento esterno (ID nel sistema di provisioning)</label>
            <input name="external_ref" class="form-control" maxlength="100" value="${escapeHtml(defaults.external_ref || '')}"></div>`;
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
