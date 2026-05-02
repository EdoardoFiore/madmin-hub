/**
 * Shared UI utilities.
 */
import { t } from './i18n.js';

// ── Debounce ──────────────────────────────────────────────────────────────────

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── HTML escape ───────────────────────────────────────────────────────────────

export function escapeHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str ?? '')));
  return d.innerHTML;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `hub-toast ${type}`;
  el.innerHTML = `<div style="display:flex;align-items:flex-start;gap:8px">
    <span style="flex:1">${escapeHtml(message)}</span>
    <button style="background:none;border:0;font-size:16px;line-height:1;cursor:pointer;color:var(--tblr-secondary);flex-shrink:0;padding:0" onclick="this.closest('.hub-toast').remove()">×</button>
  </div>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Spinner ───────────────────────────────────────────────────────────────────

export function showSpinner(container) {
  if (!container) return;
  container.innerHTML = '<div class="hub-loader"></div>';
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function formatBytes(bytes, decimals = 1) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

export function relativeTime(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr.endsWith('Z') ? isoStr : isoStr + 'Z').getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return t('time.s_ago', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('time.m_ago', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.h_ago', { n: h });
  return t('time.d_ago', { n: Math.floor(h / 24) });
}

export function fmtDate(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr.endsWith('Z') ? isoStr : isoStr + 'Z')
    .toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtPercent(v) { return `${(v || 0).toFixed(1)}%`; }

// ── Status badges ─────────────────────────────────────────────────────────────

export function statusBadge(ws_connected, enrollment_status) {
  if (enrollment_status === 'revoked')
    return `<span class="hub-badge revoked"><span class="status-dot revoked"></span>${t('status.revoked')}</span>`;
  if (enrollment_status === 'pending')
    return `<span class="hub-badge pending"><span class="status-dot pending"></span>${t('status.pending')}</span>`;
  if (ws_connected)
    return `<span class="hub-badge online"><span class="status-dot online"></span>${t('status.online')}</span>`;
  return `<span class="hub-badge offline"><span class="status-dot offline"></span>${t('status.offline')}</span>`;
}

// Maps HTTP method to action label class + text key
export function httpMethodToAction(method) {
  switch ((method || '').toUpperCase()) {
    case 'POST':   return { cls: 'create', key: 'audit.action_create' };
    case 'PUT':
    case 'PATCH':  return { cls: 'update', key: 'audit.action_update' };
    case 'DELETE': return { cls: 'delete', key: 'audit.action_delete' };
    default:       return { cls: 'read',   key: 'audit.action_read' };
  }
}

export function actionLabel(method) {
  const { cls, key } = httpMethodToAction(method);
  return `<span class="action-label ${cls}">${t(key)}</span>`;
}

// ── Modal helpers (Bootstrap) ─────────────────────────────────────────────────

let _dialogEl = null;
function _getDialogEl() {
  if (_dialogEl) return _dialogEl;
  _dialogEl = document.createElement('div');
  _dialogEl.className = 'modal modal-blur fade';
  _dialogEl.tabIndex = -1;
  document.body.appendChild(_dialogEl);
  return _dialogEl;
}

export function confirmDialog(title, body = '', { okLabel = 'OK', okClass = 'btn-danger', cancelLabel = null } = {}) {
  return new Promise(resolve => {
    const cancel = cancelLabel || t('modal.cancel');
    const el = _getDialogEl();
    el.innerHTML = `
      <div class="modal-dialog modal-sm modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${escapeHtml(title)}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          ${body ? `<div class="modal-body" style="font-size:14px">${escapeHtml(body)}</div>` : ''}
          <div class="modal-footer">
            <button type="button" class="btn btn-link link-secondary me-auto" data-bs-dismiss="modal">${escapeHtml(cancel)}</button>
            <button type="button" class="btn ${okClass}" id="dlg-ok">${escapeHtml(okLabel)}</button>
          </div>
        </div>
      </div>`;
    const m = window.bootstrap.Modal.getOrCreateInstance(el);
    let confirmed = false;
    el.querySelector('#dlg-ok').onclick = () => { confirmed = true; m.hide(); };
    el.addEventListener('hidden.bs.modal', () => resolve(confirmed), { once: true });
    m.show();
  });
}

export function inputDialog(title, body = '', { placeholder = '', type = 'text', defaultValue = '', okLabel = 'OK', cancelLabel = null } = {}) {
  return new Promise(resolve => {
    const cancel = cancelLabel || t('modal.cancel');
    const el = _getDialogEl();
    el.innerHTML = `
      <div class="modal-dialog modal-sm modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${escapeHtml(title)}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            ${body ? `<p class="mb-2" style="font-size:14px">${escapeHtml(body)}</p>` : ''}
            <input id="dlg-input" type="${type}" class="form-control" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}" />
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-link link-secondary me-auto" data-bs-dismiss="modal">${escapeHtml(cancel)}</button>
            <button type="button" class="btn btn-primary" id="dlg-ok">${escapeHtml(okLabel)}</button>
          </div>
        </div>
      </div>`;
    const m = window.bootstrap.Modal.getOrCreateInstance(el);
    let value = null;
    const inp = el.querySelector('#dlg-input');
    el.querySelector('#dlg-ok').onclick = () => { value = inp.value; m.hide(); };
    el.addEventListener('hidden.bs.modal', () => resolve(value), { once: true });
    m.show();
    setTimeout(() => inp?.focus(), 300);
  });
}

// ── DataTable helper ──────────────────────────────────────────────────────────

/**
 * Render a simple data table into a container element.
 * @param {HTMLElement} el - container
 * @param {Array<{key, label, render?}>} cols - column definitions
 * @param {Array<object>} rows - data rows
 * @param {object} opts - { emptyIcon, emptyText, onRowClick, footer }
 */
export function renderTable(el, cols, rows, { emptyIcon = 'ti-database-off', emptyText = '', onRowClick, footer } = {}) {
  if (!rows.length) {
    el.innerHTML = `<div class="data-table">
      <div class="data-table-empty">
        <i class="ti ${emptyIcon}"></i>
        ${escapeHtml(emptyText)}
      </div>
    </div>`;
    return;
  }

  const thead = cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
  const tbody = rows.map((row, i) => {
    const cells = cols.map(c => `<td>${c.render ? c.render(row) : escapeHtml(row[c.key] ?? '—')}</td>`).join('');
    return `<tr class="${onRowClick ? 'clickable' : ''}" data-idx="${i}">${cells}</tr>`;
  }).join('');

  el.innerHTML = `<div class="data-table">
    <table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
    ${footer ? `<div class="data-table-footer">${footer}</div>` : ''}
  </div>`;

  if (onRowClick) {
    el.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', () => onRowClick(rows[+tr.dataset.idx], tr));
    });
  }
}
