/**
 * Instance detail — telemetry charts, latest stats, commands.
 */
import { apiGet, apiPost } from '../api.js';
import { showSpinner, wsPill, relativeTime, formatBytes, fmtPercent, showToast } from '../utils.js';
import { t } from '../i18n.js';

export async function render(container, params) {
  const instanceId = params[0];
  if (!instanceId) {
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-warning">${t('instance.missing_id')}</div></div>`;
    return;
  }

  showSpinner(container);

  let [inst, telemetry, latest] = [null, [], null];
  try {
    [inst, telemetry, latest] = await Promise.all([
      apiGet(`/instances/${instanceId}`),
      apiGet(`/instances/${instanceId}/telemetry?hours=6`),
      apiGet(`/instances/${instanceId}/telemetry/latest`),
    ]);
  } catch {
    container.innerHTML = `<div class="container-xl py-4"><div class="alert alert-danger">${t('instance.load_error')}</div></div>`;
    return;
  }

  const cpu  = latest?.cpu_percent  ?? 0;
  const ram  = latest?.ram_percent  ?? 0;
  const disk = latest?.disk_percent ?? 0;

  container.innerHTML = `
    <div class="page-header">
      <div class="container-xl">
        <div class="row align-items-center">
          <div class="col-auto">
            <a href="#instances" class="btn btn-sm btn-ghost-secondary">
              <i class="ti ti-arrow-left me-1"></i>${t('instance.back')}
            </a>
          </div>
          <div class="col">
            <h2 class="page-title mb-0">${inst.name}</h2>
            <div class="text-muted small">${wsPill(inst.ws_connected)} &nbsp; v${inst.version || '—'} &nbsp; ${relativeTime(inst.last_seen_at)}</div>
          </div>
          <div class="col-auto">
            <button class="btn btn-outline-secondary btn-sm me-2" id="exec-info-btn">
              <i class="ti ti-refresh me-1"></i>${t('instance.refresh')}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="page-body">
      <div class="container-xl">

        <!-- Gauges row -->
        <div class="row row-cards mb-4">
          <div class="col-4">${gauge('CPU',            cpu,  'text-blue')}</div>
          <div class="col-4">${gauge('RAM',            ram,  'text-green')}</div>
          <div class="col-4">${gauge(t('instance.disk'), disk, 'text-orange')}</div>
        </div>

        <!-- Charts -->
        <div class="row row-cards mb-4">
          <div class="col-12">
            <div class="card">
              <div class="card-header d-flex align-items-center">
                <span id="telemetry-card-title">${t('instance.telemetry_card')} (6h)</span>
                <div class="ms-auto">
                  <select id="hours-select" class="form-select form-select-sm">
                    <option value="3">3h</option>
                    <option value="6" selected>6h</option>
                    <option value="24">24h</option>
                  </select>
                </div>
              </div>
              <div class="card-body">
                <div id="telemetry-chart"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Info + Commands -->
        <div class="row row-cards">
          <div class="col-md-6">
            <div class="card">
              <div class="card-header"><h3 class="card-title">${t('instance.info_title')}</h3></div>
              <div class="card-body">
                <dl class="row mb-0">
                  <dt class="col-5">${t('instance.id')}</dt><dd class="col-7 text-mono small">${inst.id}</dd>
                  <dt class="col-5">${t('instance.fingerprint')}</dt><dd class="col-7 text-mono small">${inst.fingerprint}</dd>
                  <dt class="col-5">${t('instance.enroll_status')}</dt><dd class="col-7">${inst.enrollment_status}</dd>
                  <dt class="col-5">${t('instance.group')}</dt><dd class="col-7">${inst.group_id || '—'}</dd>
                  <dt class="col-5">${t('label.tags', {})}</dt><dd class="col-7">${(inst.tags || []).map(tag=>`<span class="badge bg-azure-lt">${tag}</span>`).join(' ') || '—'}</dd>
                  <dt class="col-5">${t('label.notes', {})}</dt><dd class="col-7">${inst.notes || '—'}</dd>
                </dl>
              </div>
            </div>
          </div>
          <div class="col-md-6">
            <div class="card">
              <div class="card-header"><h3 class="card-title">${t('instance.actions_title')}</h3></div>
              <div class="card-body d-flex flex-column gap-2">
                <button class="btn btn-outline-primary" data-cmd="backup.run" data-label="${t('instance.cmd_backup')}">
                  <i class="ti ti-database-export me-2"></i>${t('instance.cmd_backup')}
                </button>
                <button class="btn btn-outline-warning" data-cmd="info" data-label="${t('instance.cmd_reload')}">
                  <i class="ti ti-info-circle me-2"></i>${t('instance.cmd_reload')}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Command result -->
        <div id="cmd-result" class="mt-3 d-none">
          <div class="alert" id="cmd-result-inner"></div>
        </div>

      </div>
    </div>`;

  drawTelemetryChart(container.querySelector('#telemetry-chart'), telemetry);

  container.querySelector('#hours-select')?.addEventListener('change', async (e) => {
    const h = e.target.value;
    container.querySelector('#telemetry-card-title').textContent = `${t('instance.telemetry_card')} (${h}h)`;
    const newTel = await apiGet(`/instances/${instanceId}/telemetry?hours=${h}`);
    const chartEl = container.querySelector('#telemetry-chart');
    chartEl.innerHTML = '';
    drawTelemetryChart(chartEl, newTel);
  });

  container.querySelectorAll('[data-cmd]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.cmd;
      const label = btn.dataset.label;
      btn.disabled = true;
      const res = container.querySelector('#cmd-result');
      const inner = container.querySelector('#cmd-result-inner');
      res.classList.remove('d-none');
      inner.className = 'alert alert-info';
      inner.textContent = `${label}…`;
      try {
        const result = await apiPost(`/instances/${instanceId}/exec/${action}`, { params: {} });
        if (result.success || result.status === 'done' || result.status === 'queued') {
          inner.className = 'alert alert-success';
          inner.textContent = result.status === 'queued'
            ? t('instance.cmd_queued')
            : t('instance.cmd_done', { result: JSON.stringify(result.result || {}) });
        } else {
          inner.className = 'alert alert-danger';
          inner.textContent = result.error || t('msg.error', {});
        }
      } catch (e) {
        inner.className = 'alert alert-danger';
        inner.textContent = e.detail || t('msg.error', {});
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.getElementById('exec-info-btn')?.addEventListener('click', () => render(container, params));
}

function gauge(label, value, colorClass) {
  return `
    <div class="card text-center">
      <div class="card-body py-3">
        <div class="h5 mb-1 ${colorClass}">${fmtPercent(value)}</div>
        <div class="text-muted small">${label}</div>
        <div class="progress mt-2" style="height:6px">
          <div class="progress-bar ${colorClass.replace('text-', 'bg-')}" style="width:${value}%"></div>
        </div>
      </div>
    </div>`;
}

function drawTelemetryChart(el, rows) {
  if (!rows || !rows.length) {
    el.innerHTML = `<div class="text-muted text-center py-3">${t('instance.no_telemetry')}</div>`;
    return;
  }
  const labels = rows.map(r => new Date(r.ts + (r.ts.endsWith('Z') ? '' : 'Z')).getTime());
  const options = {
    series: [
      { name: 'CPU %',   data: rows.map((r, i) => [labels[i], parseFloat(r.cpu_percent.toFixed(1))]) },
      { name: 'RAM %',   data: rows.map((r, i) => [labels[i], parseFloat(r.ram_percent.toFixed(1))]) },
      { name: `${t('instance.disk')} %`, data: rows.map((r, i) => [labels[i], parseFloat(r.disk_percent.toFixed(1))]) },
    ],
    chart: { type: 'line', height: 260, toolbar: { show: false }, animations: { enabled: false } },
    xaxis: { type: 'datetime' },
    yaxis: { min: 0, max: 100, labels: { formatter: v => v + '%' } },
    stroke: { curve: 'smooth', width: 2 },
    colors: ['#206bc4', '#2fb344', '#f59f00'],
    legend: { position: 'top' },
    tooltip: { x: { format: 'HH:mm:ss' } },
  };
  // eslint-disable-next-line no-undef
  new ApexCharts(el, options).render();
}
