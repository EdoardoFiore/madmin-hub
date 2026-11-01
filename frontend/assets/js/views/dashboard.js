/**
 * MADMIN Hub - Dashboard: state of the fleet.
 */
import { apiGet } from '../api.js';
import { escapeHtml } from '../utils.js';
import { onlineBadge, relTime } from './hub-common.js';

let timer = null;

function card(label, value, cls = '') {
    return `
        <div class="col-sm-6 col-lg-3">
            <div class="card card-sm"><div class="card-body">
                <div class="subheader">${label}</div>
                <div class="h1 mb-0 ${cls}">${value}</div>
            </div></div>
        </div>`;
}

async function load(container) {
    const d = await apiGet('/dashboard');
    const versions = Object.entries(d.versions).sort((a, b) => b[1] - a[1])
        .map(([v, n]) => `<tr><td>${escapeHtml(v)}</td><td class="text-end">${n}</td></tr>`).join('')
        || '<tr><td colspan="2" class="text-muted">Nessuna istanza</td></tr>';
    const offline = d.offline.map(i => `
        <tr>
            <td><a href="#instances/${escapeHtml(i.id)}">${escapeHtml(i.name)}</a></td>
            <td>${onlineBadge(i)}</td>
            <td>${escapeHtml(i.last_ip || '-')}</td>
            <td>${relTime(i.last_seen_at)}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="text-muted">Tutte le istanze attive sono online</td></tr>';

    container.innerHTML = `
        <div class="row row-deck row-cards">
            ${card('Istanze attive', d.active)}
            ${card('Online', d.online, 'text-success')}
            ${card('Offline', d.active - d.online, d.active - d.online ? 'text-danger' : '')}
            ${d.open_support_sessions !== undefined   // superusers only
                ? card('Sessioni di supporto aperte', d.open_support_sessions, d.open_support_sessions ? 'text-warning' : '')
                : card('Revocate / dismesse', d.revoked)}
            <div class="col-lg-4">
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Versioni MADMIN</h3></div>
                    <table class="table card-table"><tbody>${versions}</tbody></table>
                </div>
            </div>
            <div class="col-lg-8">
                <div class="card">
                    <div class="card-header">
                        <h3 class="card-title">Istanze offline</h3>
                        <div class="card-actions text-muted small">Comandi falliti/scaduti nelle ultime 24h: ${d.failed_commands_24h}</div>
                    </div>
                    <div class="table-responsive">
                        <table class="table card-table table-vcenter">
                            <thead><tr><th>Nome</th><th>Stato</th><th>Ultimo IP</th><th>Ultimo contatto</th></tr></thead>
                            <tbody>${offline}</tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>`;
}

export async function render(container) {
    clearInterval(timer);
    await load(container);
    timer = setInterval(() => {
        if (!document.body.contains(container) || !location.hash.startsWith('#dashboard') && location.hash) {
            clearInterval(timer);
            return;
        }
        load(container).catch(() => {});
    }, 30000);
}
