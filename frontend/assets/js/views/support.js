/**
 * MADMIN Manager - Support: every open support session (they are opened from
 * the instance page, Supporto tab), the caller's SSH keys and the keys of the
 * other superusers waiting for approval.
 */
import { apiGet, apiPost, apiDelete } from '../api.js';
import { escapeHtml, showToast, confirmDialog, actionAttrs, registerActions } from '../utils.js';
import { checkPermission, getUser } from '../app.js';
import { fmtDate, relTime, formModal, formData, field, notice, confirmAction } from './manager-common.js';
import { sessionTable } from './instances.js';

let containerEl = null;

const keyStatus = (k) => k.status === 'approved'
    ? `<span class="badge bg-success-lt" title="da ${escapeHtml(k.approved_by)}, ${escapeHtml(fmtDate(k.approved_at))}">approvata</span>`
    : '<span class="badge bg-warning-lt">da approvare</span>';

function keyRows(keys, { mine }) {
    const manage = checkPermission('manager.manage');
    return keys.map(k => `<tr>
        ${mine ? '' : `<td>${escapeHtml(k.owner)}</td>`}
        <td>${escapeHtml(k.name)}<div class="small text-muted">${escapeHtml(k.key_type)} ${escapeHtml(k.comment)}</div></td>
        <td class="font-monospace small">${escapeHtml(k.fingerprint)}</td>
        <td>${keyStatus(k)}</td>
        <td>${fmtDate(k.created_at)}</td>
        <td>${k.last_used_at ? relTime(k.last_used_at) : 'mai'}</td>
        <td class="text-end"><div class="btn-list justify-content-end">${mine ? `
            <button class="btn btn-sm btn-outline-danger" ${actionAttrs('supportKeyRemove', k.id)}>Rimuovi</button>` : manage ? `
            ${k.status === 'pending' ? `<button class="btn btn-sm btn-success" ${actionAttrs('supportKeyApprove', k.id)}>Approva</button>` : ''}
            <button class="btn btn-sm btn-outline-danger" ${actionAttrs('supportKeyReject', k.id)}>Rimuovi</button>` : ''}</div></td>
    </tr>`).join('');
}

export async function render(container) {
    containerEl = container;
    const manage = checkPermission('manager.manage');
    const me = getUser()?.username;
    const [rows, mine, all] = await Promise.all([
        apiGet('/support'),
        manage ? apiGet('/me/ssh-keys') : Promise.resolve([]),
        apiGet('/ssh-keys'),
    ]);
    const others = all.filter(k => k.owner !== me)
        .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
    const pending = others.filter(k => k.status === 'pending').length;
    container.innerHTML = `
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title">Sessioni di supporto aperte</h3>
                <div class="card-actions text-muted small">Per aprirne una: Istanze → istanza → Supporto</div></div>
            ${sessionTable(rows, true)}
        </div>
        ${manage ? `
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title">Le mie chiavi SSH</h3>
                <div class="card-actions"><button class="btn btn-primary btn-sm" ${actionAttrs('supportKeyAdd')}>
                    <i class="ti ti-plus me-1"></i>Aggiungi chiave</button></div></div>
            <div class="card-body pb-0 text-muted small">
                L'accesso SSH di supporto firma solo una di queste chiavi, dopo che un <strong>altro</strong> superuser l'ha
                approvata. Un cambio di ruolo, accesso o gruppo rimette le chiavi in attesa di approvazione.
                Senza un altro superuser: <code>python -m manager.keys approve &lt;utente&gt; &lt;impronta&gt;</code> come root sul manager.
            </div>
            <div class="table-responsive"><table class="table card-table table-vcenter">
                <thead><tr><th>Nome</th><th>Impronta</th><th>Stato</th><th>Aggiunta</th><th>Ultimo uso</th><th></th></tr></thead>
                <tbody>${keyRows(mine, { mine: true }) || '<tr><td colspan="6" class="text-muted">Nessuna chiave</td></tr>'}</tbody>
            </table></div>
        </div>` : ''}
        <div class="card">
            <div class="card-header"><h3 class="card-title">Chiavi SSH degli altri superuser
                ${pending ? `<span class="badge bg-warning ms-2">${pending} da approvare</span>` : ''}</h3></div>
            <div class="table-responsive"><table class="table card-table table-vcenter">
                <thead><tr><th>Utente</th><th>Nome</th><th>Impronta</th><th>Stato</th><th>Aggiunta</th><th>Ultimo uso</th><th></th></tr></thead>
                <tbody>${keyRows(others, { mine: false }) || '<tr><td colspan="7" class="text-muted">Nessuna chiave</td></tr>'}</tbody>
            </table></div>
        </div>`;
}

const reload = () => containerEl && render(containerEl);

registerActions({
    supportKeyAdd: () => {
        formModal('Aggiungi chiave SSH', `
            ${notice('info', '', [['ti-user-check', 'Resta <b>in attesa</b> finché un altro superuser non la approva (verificando l\'impronta con te).']])}
            ${field('name', 'Nome', { required: true, maxlength: 100, example: 'portatile ufficio' })}
            ${field('public_key', 'Chiave pubblica', { type: 'textarea', rows: 3, required: true, mono: true,
                pattern: '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( .*)?$',
                format: 'ssh-ed25519 AAAA… commento', placeholder: 'ssh-ed25519 AAAA... nome@pc',
                hint: 'solo la parte pubblica, il contenuto di <code>~/.ssh/id_ed25519.pub</code>; ed25519 consigliata, RSA almeno 3072 bit' })}`,
        async (form) => {
            const k = await apiPost('/me/ssh-keys', formData(form));
            showToast(`Chiave aggiunta (${k.fingerprint}): in attesa di approvazione`, 'success', 6000);
            reload();
        }, { submitText: 'Aggiungi', size: 'lg', icon: 'ti-key' });
    },
    supportKeyRemove: async (id) => {
        if (!await confirmAction({ title: 'Rimuovi chiave', icon: 'ti-trash', confirmText: 'Rimuovi',
            items: [['ti-ban', 'Non potrà più essere usata per nuovi accessi SSH di supporto.'],
                    ['ti-clock', 'Le sessioni già aperte restano valide fino alla scadenza.']] })) return;
        try { await apiDelete(`/me/ssh-keys/${id}`); reload(); } catch (e) { showToast(e.message, 'error'); }
    },
    supportKeyApprove: async (id) => {
        if (!await confirmAction({ title: 'Approva chiave SSH', tone: 'success', icon: 'ti-user-check', confirmText: 'Approva',
            intro: 'Con questa chiave il proprietario potrà ricevere accessi <b>SSH root</b> di supporto.',
            items: [['ti-phone', 'Verifica con il proprietario, <b>su un canale diverso</b> (telefono, di persona), che l\'impronta sia la sua.'],
                    ['ti-alert-triangle', 'Se non l\'ha aggiunta lui, il suo account è compromesso: rimuovila.']] })) return;
        try { await apiPost(`/ssh-keys/${id}/approve`, {}); reload(); } catch (e) { showToast(e.message, 'error'); }
    },
    supportKeyReject: async (id) => {
        if (!await confirmAction({ title: 'Rimuovi chiave', icon: 'ti-trash', confirmText: 'Rimuovi',
            intro: 'La chiave di un altro utente viene rimossa; dovrà aggiungerla di nuovo e farla approvare.' })) return;
        try { await apiPost(`/ssh-keys/${id}/reject`, {}); reload(); } catch (e) { showToast(e.message, 'error'); }
    },
});
