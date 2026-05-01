/**
 * Shared UI utilities: toast, spinner, formatters.
 */
import { t } from './i18n.js';

// ── Toast ───────────────────────────────────────────────────────────────────

let _toastContainer = null;

function getToastContainer() {
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.className = 'toast-container position-fixed bottom-0 end-0 p-3';
    _toastContainer.style.zIndex = '1090';
    document.body.appendChild(_toastContainer);
  }
  return _toastContainer;
}

export function showToast(message, type = 'info') {
  const colorMap = {
    success: 'bg-success',
    error: 'bg-danger',
    warning: 'bg-warning',
    info: 'bg-info',
  };
  const bg = colorMap[type] || colorMap.info;

  const id = `toast-${Date.now()}`;
  const el = document.createElement('div');
  el.id = id;
  el.className = `toast align-items-center text-white ${bg} border-0 show`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto"
              data-bs-dismiss="toast"></button>
    </div>`;

  getToastContainer().appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Spinner ─────────────────────────────────────────────────────────────────

export function showSpinner(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="d-flex justify-content-center align-items-center py-5">
      <div class="spinner-border text-primary" role="status"></div>
    </div>`;
}

// ── Formatters ───────────────────────────────────────────────────────────────

export function escapeHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

export function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

export function relativeTime(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr + (isoStr.endsWith('Z') ? '' : 'Z')).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return t('time.s_ago', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('time.m_ago', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.h_ago', { n: h });
  return t('time.d_ago', { n: Math.floor(h / 24) });
}

export function statusBadge(ws_connected, enrollment_status) {
  if (enrollment_status === 'revoked') return `<span class="badge badge-revoked">${t('status.revoked')}</span>`;
  if (enrollment_status === 'pending') return `<span class="badge badge-pending">${t('status.pending')}</span>`;
  if (ws_connected) return `<span class="badge badge-online">${t('status.online')}</span>`;
  return `<span class="badge badge-offline">${t('status.offline')}</span>`;
}

export function wsPill(connected) {
  return connected
    ? `<span class="ws-pill online"><span class="status-dot online"></span>${t('status.online')}</span>`
    : `<span class="ws-pill offline"><span class="status-dot offline"></span>${t('status.offline')}</span>`;
}

export function fmtPercent(v) {
  return `${(v || 0).toFixed(1)}%`;
}
