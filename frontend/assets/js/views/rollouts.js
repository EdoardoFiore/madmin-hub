/**
 * MADMIN Manager - Rollouts: one action (MADMIN update, package upgrade,
 * reboot, backup) on a set of instances, canary first, with a concurrency
 * limit, a stop threshold and the groups' maintenance windows.
 */
import { apiGet, apiPost, apiPut, apiDelete } from '../api.js';
import { escapeHtml, showToast, confirmDialog, loadingSpinner, actionAttrs, registerActions } from '../utils.js';
import { checkPermission, setPageActions } from '../app.js';
import { fmtDate, relTime, formModal, formData, groupOptions, textToLabels, secretModal, field, formSection, notice,
         confirmAction, fieldError } from './manager-common.js';

const ACTIONS = {
    'madmin.update': ['Aggiornamento MADMIN', true],
    'os.upgrade': ['Aggiornamento pacchetti', true],
    'os.reboot': ['Riavvio', true],
    'os.services.restart': ['Riavvio servizi', true],
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
    if (r.action === 'os.services.restart') return 'servizi con librerie vecchie';
    return '';
}

export async function render(container) {
    containerEl = container;
    const superuser = checkPermission('manager.manage');
    setPageActions(`<button class="btn btn-primary" ${actionAttrs('rolloutNew')}><i class="ti ti-plus me-1"></i>Nuovo rollout</button>
        ${superuser ? `<button class="btn btn-outline-primary" ${actionAttrs('scheduleNew')}><i class="ti ti-calendar-repeat me-1"></i>Nuova pianificazione</button>` : ''}`);
    const [rows, schedules] = await Promise.all([apiGet('/rollouts'),
        checkPermission('manager.view') ? apiGet('/rollout-schedules').catch(() => []) : Promise.resolve([])]);
    container.innerHTML = `<div class="card">
        <div class="table-responsive"><table class="table card-table table-vcenter">
            <thead><tr><th>Rollout</th><th>Azione</th><th>Stato</th><th style="min-width: 14rem">Avanzamento</th><th>Creato</th><th></th></tr></thead>
            <tbody>${rows.map(r => `<tr class="cursor-pointer" ${actionAttrs('rolloutOpen', r.id)}>
                <td>${escapeHtml(r.name)}<div class="small text-muted">${escapeHtml(r.created_by)}</div></td>
                <td>${escapeHtml(r.label)}<div class="small text-muted">${argsText(r)}</div></td>
                <td>${r.start_at && new Date(r.start_at + 'Z') > new Date() && r.status === 'running'
                    ? `<span class="badge bg-azure-lt"><i class="ti ti-clock me-1"></i>programmato</span><div class="small text-muted">${fmtDate(r.start_at)}</div>`
                    : badge(STATUS, r.status)}${r.halted_reason ? `<div class="small text-danger">${escapeHtml(r.halted_reason)}</div>` : ''}</td>
                <td>${progressBar(r)}</td><td>${fmtDate(r.created_at)}</td>
                <td class="text-end"><i class="ti ti-chevron-right"></i></td></tr>`).join('')
                || '<tr><td colspan="6" class="text-muted">Nessun rollout</td></tr>'}</tbody>
        </table></div></div>
        <div id="rollout-detail" class="mt-3"></div>
        ${schedules.length || superuser ? `<div class="card mt-3">
            <div class="card-header"><h3 class="card-title"><i class="ti ti-calendar-repeat me-2"></i>Pianificazioni ricorrenti</h3>
                <div class="card-actions small text-muted">creano un rollout nei giorni e all'ora indicati (ora del manager)</div></div>
            <div class="table-responsive"><table class="table card-table table-vcenter">
                <thead><tr><th>Pianificazione</th><th>Azione</th><th>Quando</th><th>Prossima</th><th>Ultimo rollout</th><th></th></tr></thead>
                <tbody>${schedules.map(sc => `<tr class="${sc.enabled ? '' : 'text-muted'}">
                    <td>${escapeHtml(sc.name)}<div class="small text-muted">${escapeHtml(sc.created_by)}</div></td>
                    <td>${escapeHtml(sc.label)}<div class="small text-muted">${argsText(sc)}${sc.selection?.needs_service_restart ? ' · solo con servizi da riavviare' : ''}${sc.selection?.reboot ? ` · solo riavvio ${escapeHtml(sc.selection.reboot === 'recommended' ? 'consigliato' : 'richiesto')}` : ''}</div></td>
                    <td><b>${escapeHtml(sc.time)}</b><div class="small text-muted">${sc.days.length === 7 ? 'ogni giorno' : sc.days.map(n => DAYS[n]).join(' ')}</div></td>
                    <td>${sc.enabled ? (sc.next_run ? fmtDate(sc.next_run) : '-') : '<span class="badge bg-secondary-lt">disattivata</span>'}</td>
                    <td>${sc.last_rollout_id ? `<a role="button" ${actionAttrs('rolloutOpen', sc.last_rollout_id)}>${escapeHtml(sc.last_run_on)}</a>` : '<span class="text-muted">mai</span>'}</td>
                    <td class="text-end">${superuser ? `<div class="btn-list justify-content-end">
                        <button class="btn btn-sm btn-outline-secondary" ${actionAttrs('scheduleToggle', sc.id)}>${sc.enabled ? 'Disattiva' : 'Attiva'}</button>
                        <button class="btn btn-sm btn-outline-primary" ${actionAttrs('scheduleEdit', sc.id)}>Modifica</button>
                        <button class="btn btn-sm btn-outline-danger" ${actionAttrs('scheduleDelete', sc.id)}><i class="ti ti-trash"></i></button></div>` : ''}</td>
                </tr>`).join('') || '<tr><td colspan="6" class="text-muted">Nessuna pianificazione. Esempio: ogni notte riavvio dei servizi in sospeso, o ogni domenica il riavvio delle istanze con riavvio consigliato.</td></tr>'}</tbody>
            </table></div></div>` : ''}`;
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
        if (!await confirmAction({ title: 'Annulla rollout', icon: 'ti-player-stop', confirmText: 'Annulla rollout',
            items: [['ti-ban', 'Nessuna nuova istanza verrà avviata.'],
                    ['ti-loader', 'Quelle già avviate terminano da sole.']] })) return;
        act('cancel', id, 'Rollout annullato');
    },
    rolloutNew: () => rolloutForm(null),
    scheduleNew: () => rolloutForm({}),
    scheduleEdit: async (id) => {
        const s = (await apiGet('/rollout-schedules')).find(x => x.id === id);
        if (s) rolloutForm(s);
    },
    scheduleToggle: async (id) => {
        const s = (await apiGet('/rollout-schedules')).find(x => x.id === id);
        if (!s) return;
        try {
            await apiPut(`/rollout-schedules/${id}`, { ...scheduleBody(s), enabled: !s.enabled });
            render(containerEl);
        } catch (e) { showToast(e.message, 'error'); }
    },
    scheduleDelete: async (id) => {
        if (!await confirmAction({ title: 'Elimina pianificazione', icon: 'ti-trash', confirmText: 'Elimina',
            intro: 'Non creerà più rollout; quelli già creati restano.' })) return;
        try { await apiDelete(`/rollout-schedules/${id}`); render(containerEl); } catch (e) { showToast(e.message, 'error'); }
    },
});

const DAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const ONLY = [['', 'Nessun filtro di stato'], ['restart', 'Solo con servizi da riavviare'],
              ['recommended', 'Solo con riavvio consigliato (corregge critiche/alte)'], ['required', 'Solo con riavvio richiesto da Ubuntu']];

function scheduleBody(s) {
    return { name: s.name, action: s.action, args: s.args, selection: s.selection, days: s.days, time: s.time,
             enabled: s.enabled, ...s.params };
}

/** New rollout (sched = null) or recurring schedule (sched = {} new, or the schedule to edit). */
async function rolloutForm(sched) {
    const superuser = checkPermission('manager.manage');
    const [groups, releases] = await Promise.all([
        apiGet('/groups').catch(() => []), superuser ? apiGet('/releases').catch(() => []) : Promise.resolve([])]);
    const actions = Object.entries(ACTIONS).filter(([, [, su]]) => superuser || !su);
    const isSched = sched !== null;
    const v = sched || {};
    const sel = v.selection || {};
    const par = v.params || {};
    const only = sel.needs_service_restart ? 'restart' : sel.reboot || '';
    const el = formModal(isSched ? (v.id ? 'Modifica pianificazione' : 'Nuova pianificazione') : 'Nuovo rollout', `
        ${isSched ? notice('info', '', [['ti-calendar-repeat', 'Nei giorni e all\'ora indicati (ora del manager) crea da sé un rollout con queste impostazioni, sulle istanze che in quel momento corrispondono ai filtri.'],
                                        ['ti-moon', 'Esempio: ogni notte alle 03:30 «Riavvio servizi» solo sulle istanze con servizi da riavviare.']]) : ''}
        <div class="row g-2">
            ${field('name', 'Nome', { required: true, minlength: 3, maxlength: 200, col: 'col-md-6', value: v.name || '',
                example: isSched ? 'Servizi notte clienti' : 'Sicurezza novembre' })}
            ${field('action', 'Azione', { type: 'select', required: true, col: 'col-md-6', value: v.action || '',
                options: actions.map(([k, [l]]) => [k, l]) })}
            <div class="col-12" data-for="madmin.update">${field('release_id', 'Release', { type: 'select', required: true,
                value: v.args?.release_id || '', options: releases.map(r => [r.id, `${r.id} — ${r.channel}`]),
                hint: isSched ? 'solo <b>stable</b> in una pianificazione' : 'una <b>candidate</b> va solo su una istanza o su istanze con etichetta <code>canary=true</code>' })}</div>
            <div class="col-12" data-for="os.upgrade">${field('scope', 'Pacchetti', { type: 'select', required: true, value: v.args?.scope || 'security',
                options: [['security', 'Solo aggiornamenti di sicurezza'], ['all', 'Tutti gli aggiornamenti']],
                hint: 'dettaglio di cosa installa ciascuno nella scheda Sistema di ogni istanza' })}</div>
            <div class="col-12" data-for="os.reboot">
                ${notice('warning', '', [['ti-power', 'Ogni istanza resta irraggiungibile per qualche minuto; un kernel nuovo parte in prova.']])}
                ${field('reason', 'Motivo del riavvio', { required: true, minlength: 3, maxlength: 200, value: v.args?.reason || '', example: 'kernel di sicurezza' })}</div>
            <div class="col-12" data-for="os.services.restart">
                ${notice('info', '', [['ti-refresh', 'Riavvia solo i servizi che ogni istanza segnala con librerie vecchie (needrestart): pochi secondi di interruzione per servizio. Le istanze senza servizi da riavviare sono saltate.']])}</div>
        </div>
        ${formSection('Istanze', 'tutti i filtri sono facoltativi e si sommano')}
        <div class="row g-2">
            ${field('group_id', 'Gruppo', { type: 'select', col: 'col-md-6', value: sel.group_id || '',
                options: [['', 'Tutte le istanze'], ...groups.map(g => [g.id, `${g.parent_id ? '\u00a0\u00a0' : ''}${g.name}${g.kind === 'partner' ? ' (partner, con i suoi clienti)' : ''}`])] })}
            ${field('only', 'Stato', { type: 'select', col: 'col-md-6', value: only, options: ONLY })}
            ${field('labels', 'Etichette', { type: 'textarea', rows: 1, mono: true, col: 'col-md-6', value: labelsText(sel.labels),
                format: 'chiave=valore, una per riga', example: 'sito=milano' })}
            ${field('version_not', 'Escludi chi è già su', { mono: true, col: 'col-md-6', example: '1.2.0+abcdef123456', value: sel.version_not || '',
                hint: 'versione+build, come in Release' })}
            <div class="col-12 d-flex gap-2 align-items-start"><button type="button" class="btn btn-outline-secondary" id="ro-preview">
                <i class="ti ti-eye me-1"></i>Anteprima istanze</button>
                <div id="ro-targets" class="small text-muted pt-2">${isSched ? 'Le istanze sono scelte di nuovo a ogni esecuzione.' : 'Usa <b>Anteprima</b> per vedere le istanze coinvolte prima di avviare.'}</div></div>
        </div>
        ${formSection(isSched ? 'Quando' : 'Avvio')}
        <div class="row g-2">
            ${isSched ? `
                ${field('time', 'Ora', { type: 'time', required: true, value: v.time || '03:30', col: 'col-md-3', hint: 'ora del manager' })}
                <div class="col-md-9"><label class="form-label">Giorni<span class="text-danger ms-1">*</span></label>
                    <div class="btn-group w-100" role="group">${DAYS.map((l, n) => `
                        <input type="checkbox" class="btn-check" name="day" value="${n}" id="sd-${n}" ${(v.days || [0, 1, 2, 3, 4, 5, 6]).includes(n) ? 'checked' : ''}>
                        <label class="btn btn-sm" for="sd-${n}">${l}</label>`).join('')}</div>
                    <div class="invalid-feedback d-block" data-days-error></div></div>
                ${field('enabled', 'Attiva', { type: 'checkbox', checked: v.enabled !== false, col: 'col-12' })}`
            : `${field('when', 'Quando', { type: 'select', required: true, col: 'col-md-4', options: [['now', 'Subito'], ['at', 'A un orario']] })}
                <div class="col-md-8" data-when-at hidden>${field('start_at', 'Data e ora di avvio', { type: 'datetime-local', required: true,
                    hint: 'ora del tuo browser; la scadenza conta da qui' })}</div>`}
        </div>
        ${formSection('Esecuzione')}
        <div class="row g-2">
            ${field('concurrency', 'Concorrenza', { type: 'number', required: true, min: 1, max: 50, value: par.concurrency ?? 1, col: 'col-md-3', hint: 'istanze insieme' })}
            ${field('canary', 'Canary', { type: 'number', required: true, min: 0, max: 50, value: par.canary ?? (isSched ? 0 : 1), col: 'col-md-3', hint: 'le prime, da sole' })}
            ${isSched ? '' : field('canary_wait_minutes', 'Attesa dopo il canary', { type: 'number', required: true, min: 0, max: 10080, value: 0, col: 'col-md-3', hint: 'minuti; 0 = conferma manuale' })}
            ${field('fail_threshold', 'Soglia di arresto %', { type: 'number', required: true, min: 0, max: 100, value: par.fail_threshold ?? 10, col: 'col-md-3', hint: 'falliti sui conclusi' })}
            ${field('use_windows', 'Rispetta le finestre di manutenzione dei gruppi', { type: 'checkbox', checked: par.use_windows ?? !isSched, col: 'col-md-8' })}
            ${field('expires_hours', 'Scadenza in ore', { type: 'number', required: true, min: 1, max: isSched ? 72 : 720, value: par.expires_hours ?? (isSched ? 4 : 72), col: 'col-md-4', hint: 'poi le istanze non avviate sono saltate' })}
        </div>`,
    async (form) => {
        const d = formData(form);
        let labels;
        try { labels = textToLabels(d.labels); } catch (e) { return fieldError(form, 'labels', e.message); }
        const body = {
            name: d.name, action: d.action, selection: selection(form, labels),
            concurrency: Number(d.concurrency), canary: Number(d.canary),
            fail_threshold: Number(d.fail_threshold), use_windows: form.querySelector('[name=use_windows]').checked,
            expires_hours: Number(d.expires_hours),
            args: d.action === 'madmin.update' ? { release_id: d.release_id }
                : d.action === 'os.upgrade' ? { scope: d.scope } : d.action === 'os.reboot' ? { reason: d.reason } : {},
        };
        if (isSched) {
            const days = [...form.querySelectorAll('[name=day]:checked')].map(x => Number(x.value));
            if (!days.length) { form.querySelector('[data-days-error]').textContent = 'Scegli almeno un giorno'; return false; }
            Object.assign(body, { days, time: d.time, enabled: form.querySelector('[name=enabled]').checked });
            const r = v.id ? await apiPut(`/rollout-schedules/${v.id}`, body) : await apiPost('/rollout-schedules', body);
            showToast(`Pianificazione salvata: prossima esecuzione ${r.next_run ? fmtDate(r.next_run) : '—'}`, 'success');
        } else {
            body.canary_wait_minutes = Number(d.canary_wait_minutes);
            if (d.when === 'at') body.start_at = new Date(d.start_at).toISOString();
            const r = await apiPost('/rollouts', body);
            showToast(r.start_at ? `Rollout programmato per ${fmtDate(r.start_at)} su ${r.total} istanze` : `Rollout creato su ${r.total} istanze`, 'success');
            openId = r.id;
        }
        render(containerEl);
    }, { submitText: isSched ? 'Salva pianificazione' : 'Crea rollout', size: 'xl', tone: 'primary',
         icon: isSched ? 'ti-calendar-repeat' : 'ti-stack-push' });
    const form = el.querySelector('form');
    const sync = () => {
        const a = form.querySelector('[name=action]').value;
        form.querySelectorAll('[data-for]').forEach(x => { x.hidden = x.dataset.for !== a; });
        const when = form.querySelector('[name=when]');
        if (when) form.querySelector('[data-when-at]').hidden = when.value !== 'at';
    };
    form.addEventListener('change', sync);
    sync();
    form.querySelector('#ro-preview').addEventListener('click', async () => {
        const box = form.querySelector('#ro-targets');
        try {
            const rows = await apiPost('/rollouts/preview', selection(form, textToLabels(formData(form).labels)));
            box.innerHTML = rows.length ? `${rows.length} istanze ${isSched ? 'oggi' : ''}: ${rows.slice(0, 60).map(i => `<span class="badge ${i.online ? 'bg-success-lt' : 'bg-secondary-lt'} me-1"
                title="${escapeHtml(`${i.version}+${i.build}`)}">${escapeHtml(i.name)}${i.canary ? ' ★' : ''}</span>`).join('')}${rows.length > 60 ? '…' : ''}
                <div class="mt-1">★ = canary (etichetta canary=true, eseguite per prime); grigio = offline ora.</div>` : 'Nessuna istanza ora';
        } catch (e) { box.textContent = e.message; }
    });
}

function labelsText(labels) {
    return Object.entries(labels || {}).map(([k, x]) => `${k}=${x}`).join('\n');
}

function selection(form, labels) {
    const d = formData(form);
    return { group_id: d.group_id || null, labels, version_not: d.version_not || null,
             needs_service_restart: d.only === 'restart', reboot: ['recommended', 'required'].includes(d.only) ? d.only : '' };
}
