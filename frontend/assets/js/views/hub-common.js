/**
 * MADMIN Hub - helpers shared by the hub views (modals, badges, dates).
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

export function onlineBadge(inst) {
    if (inst.status !== 'active') {
        const label = inst.status === 'revoked' ? 'Revocata' : 'Dismessa';
        return `<span class="badge bg-secondary-lt">${label}</span>`;
    }
    return inst.online
        ? '<span class="badge bg-success-lt"><span class="status-dot status-dot-animated bg-success me-1"></span>Online</span>'
        : '<span class="badge bg-danger-lt"><span class="status-dot bg-danger me-1"></span>Offline</span>';
}

export function commandStatusBadge(status) {
    const cls = { queued: 'bg-secondary-lt', sent: 'bg-info-lt', done: 'bg-success-lt',
                  failed: 'bg-danger-lt', expired: 'bg-warning-lt' }[status] || 'bg-secondary-lt';
    const label = { queued: 'In coda', sent: 'Inviato', done: 'Completato',
                    failed: 'Fallito', expired: 'Scaduto' }[status] || status;
    return `<span class="badge ${cls}">${label}</span>`;
}

/**
 * Modal with a form. onSubmit(form) may throw (the error is shown as a toast
 * and the modal stays open) or return false to keep it open.
 */
export function formModal(title, bodyHtml, onSubmit, { submitText = 'Salva', submitClass = 'btn-primary', size = '' } = {}) {
    const id = `hub-modal-${Date.now()}`;
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
export function secretModal(title, intro, value, extraHtml = '') {
    const id = `hub-secret-${Date.now()}`;
    document.body.insertAdjacentHTML('beforeend', `
        <div class="modal modal-blur fade" id="${id}" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${escapeHtml(title)}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <p>${intro}</p>
                        <textarea class="form-control font-monospace" rows="4" readonly>${escapeHtml(value)}</textarea>
                        <button type="button" class="btn btn-outline-primary mt-2" data-copy>
                            <i class="ti ti-copy me-1"></i>Copia
                        </button>
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
    el.querySelector('[data-copy]').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(value);
            showToast('Copiato', 'success');
        } catch {
            el.querySelector('textarea').select();
        }
    });
    el.addEventListener('hidden.bs.modal', () => el.remove());
    modal.show();
}

export function formData(form) {
    const out = {};
    for (const [k, v] of new FormData(form).entries()) out[k] = typeof v === 'string' ? v.trim() : v;
    return out;
}

// --- Groups (hub -> customer, hub -> partner -> customer) and labels ---

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
