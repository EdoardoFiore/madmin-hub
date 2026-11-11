/**
 * MADMIN Manager - Licenses of every instance.
 */
import { apiGet } from '../api.js';
import { actionAttrs, registerActions } from '../utils.js';
import { checkPermission, setPageActions } from '../app.js';
import { licenseTable, licenseModal } from './instances.js';

export async function render(container) {
    const manage = checkPermission('manager.manage');
    if (manage) {
        setPageActions(`<button class="btn btn-primary" ${actionAttrs('managerLicenseNewGlobal')}>
            <i class="ti ti-certificate me-1"></i>Emetti licenza</button>`);
    }
    registerActions({ managerLicenseNewGlobal: () => licenseModal(null, () => render(container)) });
    const rows = await apiGet('/licenses');
    container.innerHTML = `
        <div class="card">
            <div class="card-header"><h3 class="card-title">Licenze</h3>
                <div class="card-actions text-muted small">Ogni token dura poco ed è rinnovato dal manager finché la licenza è attiva</div></div>
            ${licenseTable(rows, manage, true)}
        </div>`;
}
