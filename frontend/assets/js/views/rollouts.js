/**
 * MADMIN Manager - Rollouts: one action (MADMIN update, package upgrade,
 * reboot, backup) on a set of instances, canary first, with a concurrency
 * limit, a stop threshold and the groups' maintenance windows.
 */
import { apiGet, apiPost } from '../api.js';
import { escapeHtml, showToast, confirmDialog, loadingSpinner, actionAttrs, registerActions } from '../utils.js';
import { checkPermission, setPageActions } from '../app.js';
import { fmtDate, relTime, formModal, formData, groupOptions, textToLabels, secretModal } from './manager-common.js';

const ACTIONS = {
    'madmin.update': ['Aggiornamento MADMIN', true],
    'os.upgrade': ['Aggiornamento pacchetti', true],
    'os.reboot': ['Riavvio', true],
    'backup.run': ['Backup', false],
};
const STATUS = {
    running: ['bg-primary-lt', 'in corso'], waiting: ['bg-warning-lt', 'in attesa di conferma'],
    halted: ['bg-danger-lt', 'fermato'], cancelled: ['bg-secondary-lt', 'annullato'], done: ['bg-success-lt', 'concluso'],
};
const TSTATUS = {
    pending: ['bg-secondary-lt', 'in attesa'], running: ['bg-primary-lt', 'in corso'], done: ['bg-success-lt', 'riuscito'],
    failed: ['bg-danger-lt', 'fallito'], skipped: ['bg-secondary-lt', 'saltato'],
};
const badge = (map, s) => `<span class="badge ${(map[s] || ['bg-secondary-lt', s])[0]}">${(map[s] || [, s])[1]}</span>`;

let containerEl = null;
let openId = null;

function progressBar(r) {
    const c = r.counts;
    const pct = (n) => r.total ? (n * 100 / r.total).toFixed(1) : 0;
    return `<div class="progress progress-sm" title="${c.done} riusciti, ${c.failed} falliti, ${c.running} in corso, ${c.skipped} saltati, ${c.pending} in attesa">
        <div class="progress-bar bg-success" style="width:${pct(c.done)}%"></div>
        <div class="progress-bar bg-danger" style="width:${pct(c.failed)}%"></div>
        <div class="progress-bar bg-primary" style="width:${pct(c.running)}%"></div>
        <div class="progress-bar bg-secondary" style="width:${pct(c.skipped)}%"></div></div>
        <div class="small text-muted mt-1">${c.done + c.failed + c.skipped}/${r.total} conclusi · ${c.failed} falliti · ${c.running} in corso</div>`;
}

function argsText(r) {
    if (r.action === 'madmin.update') return `release ${escapeHtml(r.args.release_id)}`;
    if (r.action === 'os.upgrade') return r.args.scope === 'security' ? 'solo sicurezza' : 'tutti i pacchetti';
    if (r.action === 'os.reboot') return escapeHtml(r.args.reason || '');
    return '';
}

export async function render(container) {
    containerEl = container;
    setPageActions(`<button class="btn btn-primary" ${actionAttrs('rolloutNew')}><i class="ti ti-plus me-1"></i>Nuovo rollout</button>`);
    const rows = await apiGet('/rollouts');
    container.innerHTML = `<div class="card">
        <div class="table-responsive"><table class="table card-table table-vcenter">
            <thead><tr><th>Rollout</th><th>Azione</th><th>Stato</th><th style="min-width: 14rem">Avanzamento</th><th>Creato</th><th></th></tr></thead>
            <tbody>${rows.map(r => `<tr class="cursor-pointer" ${actionAttrs('rolloutOpen', r.id)}>
                <td>${escapeHtml(r.name)}<div class="small text-muted">${escapeHtml(r.created_by)}</div></td>
                <td>${escapeHtml(r.label)}<div class="small text-muted">${argsText(r)}</div></td>
                <td>${badge(STATUS, r.status)}${r.halted_reason ? `<div class="small text-danger">${escapeHtml(r.halted_reason)}</div>` : ''}</td>
                <td>${progressBar(r)}</td><td>${fmtDate(r.created_at)}</td>
                <td class="text-end"><i class="ti ti-chevron-right"></i></td></tr>`).join('')
                || '<tr><td colspan="6" class="text-muted">Nessun rollout</td></tr>'}</tbody>
        </table></div></div>
        <div id="rollout-detail" class="mt-3"></div>`;
    if (openId) await showDetail(openId);
}

async function showDetail(id) {
    openId = id;
    const el = containerEl.querySelector('#rollout-detail');
    el.innerHTML = loadingSpinner();
    const r = await apiGet(`/rollouts/${id}`);
    const manage = !ACTIONS[r.action]?.[1] || checkPermission('manager.manage');
    const btn = (action, label, cls, show) => show && manage
        ? `<button class="btn btn-sm ${cls}" ${actionAttrs(action, r.id)}>${label}</button>` : '';
    el.innerHTML = `<div class="card">
        <div class="card-header"><h3 class="card-title">${escapeHtml(r.name)} ${badge(STATUS, r.status)}</h3>
            <div class="card-actions btn-list">
                ${btn('rolloutResume', r.status === 'waiting' ? 'Prosegui oltre il canary' : 'Riprendi', 'btn-success', ['halted', 'waiting'].includes(r.status))}
                ${btn('rolloutHalt', 'Ferma', 'btn-outline-warning', ['running', 'waiting'].includes(r.status))}
                ${btn('rolloutRetry', 'Riprova falliti', 'btn-outline-primary', r.counts.failed + r.counts.skipped > 0 && r.status !== 'cancelled')}
                ${btn('rolloutCancel', 'Annulla', 'btn-outline-danger', !['done', 'cancelled'].includes(r.status))}
            </div></div>
        <div class="card-body border-bottom small">
            ${escapeHtml(r.label)} · ${argsText(r)} · concorrenza ${r.concurrency} · canary ${r.canary}${r.canary
                ? (r.canary_wait_minutes ? ` (poi attesa ${r.canary_wait_minutes} min)` : ' (poi conferma)') : ''}
            · soglia ${r.fail_threshold}% · ${r.use_windows ? 'finestre di manutenzione' : 'senza finestre'} · scade ${fmtDate(r.expires_at)}
            ${r.halted_reason ? `<div class="text-danger mt-1">${escapeHtml(r.halted_reason)}</div>` : ''}
            <div class="mt-2">${progressBar(r)}</div>
        </div>
        <div class="table-responsive"><table class="table card-table table-vcenter">
            <thead><tr><th>#</th><th>Istanza</th><th>Stato</th><th>Avvio</th><th>Fine</th><th>Dettaglio</th></tr></thead>
            <tbody>${r.targets.map(t => `<tr>
                <td>${t.position + 1}${t.canary ? ' <span class="badge bg-yellow-lt">canary</span>' : ''}</td>
                <td><a href="#instances/${escapeHtml(t.instance_id)}/commands">${escapeHtml(t.instance_name)}</a>
                    ${t.online ? '' : '<span class="badge bg-danger-lt ms-1">offline</span>'}</td>
                <td>${badge(TSTATUS, t.status)}</td><td>${fmtDate(t.started_at)}</td><td>${fmtDate(t.finished_at)}</td>
                <td class="small text-muted">${escapeHtml(t.detail)}</td></tr>`).join('')}</tbody>
        </table></div></div>`;
}

async function act(path, id, ok) {
    try { await apiPost(`/rollouts/${id}/${path}`, {}); showToast(ok, 'success'); render(containerEl); }
    catch (e) { showToast(e.message, 'error'); }
}

registerActions({
    rolloutOpen: (id) => showDetail(id).catch(e => showToast(e.message, 'error')),
    rolloutHalt: (id) => act('halt', id, 'Rollout fermato: i comandi già partiti proseguono'),
    rolloutResume: (id) => act('resume', id, 'Rollout ripreso'),
    rolloutRetry: (id) => act('retry', id, 'Istanze fallite e saltate rimesse in coda'),
    rolloutCancel: async (id) => {
        if (!await confirmDialog('Annulla rollout', 'Nessuna nuova istanza verrà avviata; quelle in corso terminano da sole.', 'Annulla rollout')) return;
        act('cancel', id, 'Rollout annullato');
    },
    rolloutNew: async () => {
        const superuser = checkPermission('manager.manage');
        const [groups, releases] = await Promise.all([
            apiGet('/groups').catch(() => []), superuser ? apiGet('/releases').catch(() => []) : Promise.resolve([])]);
        const actions = Object.entries(ACTIONS).filter(([, [, su]]) => superuser || !su);
        const el = formModal('Nuovo rollout', `
            <div class="row g-3">
                <div class="col-md-6"><label class="form-label">Nome</label><input name="name" class="form-control" required minlength="3" maxlength="200"></div>
                <div class="col-md-6"><label class="form-label">Azione</label>
                    <select name="action" class="form-select">${actions.map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
                <div class="col-12" data-for="madmin.update"><label class="form-label">Release</label>
                    <select name="release_id" class="form-select">${releases.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id)} (${r.channel})</option>`).join('')}</select>
                    <div class="form-hint">Una release candidate va solo su una istanza o su istanze con etichetta <code>canary=true</code>.</div></div>
                <div class="col-12" data-for="os.upgrade"><label class="form-label">Pacchetti</label>
                    <select name="scope" class="form-select"><option value="security">Solo aggiornamenti di sicurezza</option><option value="all">Tutti</option></select></div>
                <div class="col-12" data-for="os.reboot"><label class="form-label">Motivo del riavvio</label><input name="reason" class="form-control" maxlength="200">
                    <div class="form-hint text-warning">Ogni istanza resta irraggiungibile per qualche minuto; un kernel nuovo parte in prova.</div></div>
                <div class="col-12"><hr class="my-1"><h4 class="mb-0">Istanze</h4></div>
                <div class="col-md-6"><label class="form-label">Gruppo</label>
                    <select name="group_id" class="form-select">${groupOptions(groups, '', { none: 'Tutte' })}</select></div>
                <div class="col-md-6"><label class="form-label">Etichette (chiave=valore, una per riga)</label>
                    <textarea name="labels" class="form-control" rows="1"></textarea></div>
                <div class="col-md-6"><label class="form-label">Escludi chi è già su (versione+build)</label><input name="version_not" class="form-control" placeholder="1.2.0+abcdef123456"></div>
                <div class="col-md-6 d-flex align-items-end"><button type="button" class="btn btn-outline-secondary w-100" id="ro-preview">Anteprima istanze</button></div>
                <div class="col-12"><div id="ro-targets" class="small text-muted">Usa Anteprima per vedere le istanze coinvolte.</div></div>
                <div class="col-12"><hr class="my-1"><h4 class="mb-0">Esecuzione</h4></div>
                <div class="col-md-3"><label class="form-label">Concorrenza</label><input name="concurrency" type="number" min="1" max="50" value="1" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">Canary</label><input name="canary" type="number" min="0" max="50" value="1" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">Dopo il canary (min, 0 = conferma)</label><input name="canary_wait_minutes" type="number" min="0" max="10080" value="0" class="form-control"></div>
                <div class="col-md-3"><label class="form-label">Soglia di arresto %</label><input name="fail_threshold" type="number" min="0" max="100" value="10" class="form-control"></div>
                <div class="col-md-6"><label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="use_windows" checked>
                    <span class="form-check-label">Rispetta le finestre di manutenzione dei gruppi</span></label></div>
                <div class="col-md-6"><label class="form-label">Scadenza (ore)</label><input name="expires_hours" type="number" min="1" max="720" value="72" class="form-control"></div>
            </div>`,
        async (form) => {
            const d = formData(form);
            const body = {
                name: d.name, action: d.action, selection: selection(form),
                concurrency: Number(d.concurrency), canary: Number(d.canary), canary_wait_minutes: Number(d.canary_wait_minutes),
                fail_threshold: Number(d.fail_threshold), use_windows: form.querySelector('[name=use_windows]').checked,
                expires_hours: Number(d.expires_hours),
                args: d.action === 'madmin.update' ? { release_id: d.release_id }
                    : d.action === 'os.upgrade' ? { scope: d.scope } : d.action === 'os.reboot' ? { reason: d.reason } : {},
            };
            const r = await apiPost('/rollouts', body);
            showToast(`Rollout creato su ${r.total} istanze`, 'success');
            openId = r.id;
            render(containerEl);
        }, { submitText: 'Avvia rollout', size: 'xl' });
        const form = el.querySelector('form');
        const sync = () => {
            const a = form.querySelector('[name=action]').value;
            form.querySelectorAll('[data-for]').forEach(x => { x.hidden = x.dataset.for !== a; });
        };
        form.querySelector('[name=action]').addEventListener('change', sync);
        sync();
        form.querySelector('#ro-preview').addEventListener('click', async () => {
            const box = form.querySelector('#ro-targets');
            try {
                const rows = await apiPost('/rollouts/preview', selection(form));
                box.innerHTML = rows.length ? `${rows.length} istanze: ${rows.slice(0, 60).map(i => `<span class="badge ${i.online ? 'bg-success-lt' : 'bg-secondary-lt'} me-1"
                    title="${escapeHtml(`${i.version}+${i.build}`)}">${escapeHtml(i.name)}${i.canary ? ' ★' : ''}</span>`).join('')}${rows.length > 60 ? '…' : ''}
                    <div class="mt-1">★ = canary (etichetta canary=true, eseguite per prime); grigio = offline ora.</div>` : 'Nessuna istanza';
            } catch (e) { box.textContent = e.message; }
        });
    },
});

function selection(form) {
    const d = formData(form);
    return { group_id: d.group_id || null, labels: textToLabels(d.labels), version_not: d.version_not || null };
}
