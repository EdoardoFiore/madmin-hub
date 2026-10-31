/**
 * MADMIN Hub - Support: every open support session. They are opened from
 * the instance page (Supporto tab).
 */
import { apiGet } from '../api.js';
import { sessionTable } from './instances.js';

export async function render(container) {
    const rows = await apiGet('/support');
    container.innerHTML = `
        <div class="card">
            <div class="card-header"><h3 class="card-title">Sessioni di supporto aperte</h3>
                <div class="card-actions text-muted small">Per aprirne una: Istanze → istanza → Supporto</div></div>
            ${sessionTable(rows, true)}
        </div>`;
}
