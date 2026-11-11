/**
 * MADMIN Manager - Releases: signed MADMIN releases the instances update to.
 * The manager stores and distributes them; each instance checks the
 * signature with its own keys before installing (madmin-update).
 */
import { apiFetch, apiGet, apiPatch, apiDelete, _extractDetail } from '../api.js';
import { escapeHtml, showToast, confirmDialog, actionAttrs, registerActions } from '../utils.js';
import { checkPermission, setPageActions } from '../app.js';
import { fmtDate, formModal } from './manager-common.js';

let containerEl = null;

const channelBadge = (c) => c === 'stable'
    ? '<span class="badge bg-success-lt">stable</span>'
    : '<span class="badge bg-warning-lt">candidate</span>';

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

export async function render(container) {
    containerEl = container;
    const manage = checkPermission('manager.manage');
    if (manage) {
        setPageActions(`<button class="btn btn-primary" ${actionAttrs('releaseUpload')}>
            <i class="ti ti-upload me-1"></i>Carica release</button>`);
    }
    const rows = await apiGet('/releases');
    container.innerHTML = `
        <div class="card">
            <div class="card-header"><h3 class="card-title">Release</h3>
                <div class="card-actions text-muted small">File .release firmati (scripts/sign-release.sh). Una release
                    <em>candidate</em> si installa su singole istanze; i rollout richiedono <em>stable</em>.</div></div>
            <div class="table-responsive"><table class="table table-vcenter card-table">
                <thead><tr><th>Release</th><th>Canale</th><th>Sistema</th><th>Da</th><th>Dimensione</th>
                    <th>Firma</th><th>Caricata</th><th>Istanze</th><th></th></tr></thead>
                <tbody>${rows.map(r => `<tr>
                    <td><div class="font-monospace">${escapeHtml(r.id)}</div>
                        ${r.notes ? `<div class="text-muted small">${escapeHtml(r.notes)}</div>` : ''}</td>
                    <td>${channelBadge(r.channel)}</td>
                    <td class="small">${escapeHtml((r.manifest.os || []).join(', '))}</td>
                    <td class="small">${escapeHtml(r.manifest.min_from || '-')}</td>
                    <td class="small">${mb(r.size)}</td>
                    <td class="small font-monospace" title="Chiave che l'ha verificata al caricamento">${escapeHtml(r.signed_by || 'non verificata qui')}</td>
                    <td class="small">${fmtDate(r.uploaded_at)}<div class="text-muted">${escapeHtml(r.uploaded_by)}</div></td>
                    <td>${r.installed_on}</td>
                    <td class="text-end">${manage ? `<div class="btn-list flex-nowrap justify-content-end">
                        ${r.channel === 'candidate'
                            ? `<button class="btn btn-sm btn-outline-success" ${actionAttrs('releasePromote', r.id)}>Promuovi a stable</button>`
                            : `<button class="btn btn-sm btn-outline-secondary" ${actionAttrs('releaseDemote', r.id)}>Riporta a candidate</button>`}
                        <button class="btn btn-sm btn-ghost-danger" ${actionAttrs('releaseDelete', r.id)}><i class="ti ti-trash"></i></button>
                    </div>` : ''}</td>
                </tr>`).join('') || '<tr><td colspan="9" class="text-muted">Nessuna release caricata</td></tr>'}
                </tbody></table></div>
        </div>`;
}

registerActions({
    releaseUpload: () => {
        formModal('Carica release', `
            <div class="mb-3"><label class="form-label">File .release (firmato)</label>
                <input name="file" type="file" class="form-control" accept=".release" required></div>
            <div class="mb-3"><label class="form-label">Note</label>
                <input name="notes" class="form-control" maxlength="200" placeholder="facoltative"></div>
            <div class="text-muted small">Il manager controlla il formato, l'integrità e, se configurate nelle
                impostazioni, la firma. Le istanze la verificano comunque prima di installarla.</div>`,
        async (form) => {
            const file = form.elements.file.files[0];
            if (!file) throw new Error('Scegli un file');
            const res = await apiFetch('/releases', {
                method: 'POST', body: file,
                headers: { 'Content-Type': 'application/octet-stream',
                           'X-Release-Notes': encodeURIComponent(form.elements.notes.value || '') },
            });
            if (!res.ok) throw new Error(_extractDetail(await res.json().catch(() => ({}))) || `HTTP ${res.status}`);
            const r = await res.json();
            showToast(`Release ${r.id} caricata`, 'success');
            render(containerEl);
        }, { submitText: 'Carica' });
    },
    releasePromote: async (id) => {
        if (!await confirmDialog('Promuovi release', `${id} diventa stable: potrà essere distribuita a gruppi di istanze.`, 'Promuovi', 'btn-success')) return;
        try { await apiPatch(`/releases/${encodeURIComponent(id)}`, { channel: 'stable' }); render(containerEl); }
        catch (e) { showToast(e.message, 'error'); }
    },
    releaseDemote: async (id) => {
        try { await apiPatch(`/releases/${encodeURIComponent(id)}`, { channel: 'candidate' }); render(containerEl); }
        catch (e) { showToast(e.message, 'error'); }
    },
    releaseDelete: async (id) => {
        if (!await confirmDialog('Elimina release', `Eliminare ${id}? Le istanze che la usano non ne risentono; non sarà più installabile.`, 'Elimina')) return;
        try { await apiDelete(`/releases/${encodeURIComponent(id)}`); render(containerEl); }
        catch (e) { showToast(e.message, 'error'); }
    },
});
