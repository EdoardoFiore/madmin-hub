/**
 * Dashboard — fleet overview: summary tiles + instance grid.
 */
import { apiGet } from '../api.js';
import { showSpinner, statusBadge, relativeTime, fmtPercent } from '../utils.js';

export async function render(container) {
  showSpinner(container);

  let data;
  try {
    data = await apiGet('/dashboard/fleet');
  } catch (e) {
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-danger">Errore caricamento fleet.</div></div>`;
    return;
  }

  const { summary, instances } = data;

  container.innerHTML = `
    <div class="page-header d-print-none">
      <div class="container-xl">
        <div class="row g-2 align-items-center">
          <div class="col"><h2 class="page-title">Dashboard Fleet</h2></div>
          <div class="col-auto ms-auto">
            <button class="btn btn-outline-secondary btn-sm" id="refresh-btn">
              <i class="ti ti-refresh me-1"></i>Aggiorna
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="page-body">
      <div class="container-xl">

        <!-- Summary tiles -->
        <div class="row row-deck row-cards mb-4" id="summary-tiles">
          ${tile('Totale istanze', summary.total, 'ti-server', 'text-blue')}
          ${tile('Online', summary.online, 'ti-circle-check', 'text-green')}
          ${tile('Offline', summary.offline, 'ti-circle-x', 'text-red')}
          ${tile('Mai connesse', summary.never_seen, 'ti-clock-off', 'text-muted')}
        </div>

        <!-- Instance grid -->
        <div class="row row-cards" id="instance-grid">
          ${instances.length === 0 ? '<div class="col-12"><div class="alert alert-info">Nessuna istanza registrata. <a href="#enrollment">Registra la prima →</a></div></div>' : ''}
          ${instances.map(renderCard).join('')}
        </div>

      </div>
    </div>`;

  // Click instance card → detail
  container.querySelectorAll('.instance-card[data-id]').forEach(card => {
    card.addEventListener('click', () => {
      window.location.hash = `instance/${card.dataset.id}`;
    });
  });

  container.getElementById = container.querySelector.bind(container);
  document.getElementById('refresh-btn')?.addEventListener('click', () => render(container));
}

function tile(label, value, icon, colorClass) {
  return `
    <div class="col-sm-6 col-lg-3">
      <div class="card">
        <div class="card-body">
          <div class="d-flex align-items-center">
            <div class="subheader">${label}</div>
          </div>
          <div class="h1 mb-3 mt-2 ${colorClass}">${value}</div>
          <i class="ti ${icon} ${colorClass}" style="font-size:2rem; opacity:.3; position:absolute; right:16px; top:50%; transform:translateY(-50%)"></i>
        </div>
      </div>
    </div>`;
}

function renderCard(inst) {
  const online = inst.ws_connected;
  return `
    <div class="col-sm-6 col-lg-4 col-xl-3">
      <div class="card instance-card" data-id="${inst.id}">
        <div class="card-body">
          <div class="d-flex align-items-center mb-2">
            <span class="status-dot ${online ? 'online' : 'offline'}"></span>
            <strong class="flex-fill text-truncate">${inst.name}</strong>
            ${statusBadge(inst.ws_connected, inst.enrollment_status)}
          </div>
          <div class="text-muted small mb-1">
            <i class="ti ti-git-branch me-1"></i>${inst.version || '—'}
          </div>
          <div class="text-muted small">
            <i class="ti ti-clock me-1"></i>${relativeTime(inst.last_seen_at)}
          </div>
          ${inst.tags?.length ? `<div class="mt-2">${inst.tags.map(t => `<span class="badge bg-azure-lt me-1">${t}</span>`).join('')}</div>` : ''}
        </div>
      </div>
    </div>`;
}
