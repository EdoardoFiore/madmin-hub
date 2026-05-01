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

// ── Modal dialogs ────────────────────────────────────────────────────────────

let _dialogEl = null;

function _getDialogEl() {
  if (_dialogEl) return _dialogEl;
  _dialogEl = document.createElement('div');
  _dialogEl.className = 'modal modal-blur fade';
  _dialogEl.tabIndex = -1;
  _dialogEl.setAttribute('role', 'dialog');
  document.body.appendChild(_dialogEl);
  return _dialogEl;
}

export function confirmDialog(title, body = '', { okLabel = 'OK', okClass = 'btn-primary', cancelLabel = 'Annulla' } = {}) {
  return new Promise(resolve => {
    const el = _getDialogEl();
    el.innerHTML = `
      <div class="modal-dialog modal-sm modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${escapeHtml(title)}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          ${body ? `<div class="modal-body">${escapeHtml(body)}</div>` : ''}
          <div class="modal-footer">
            <button type="button" class="btn btn-link link-secondary me-auto" data-bs-dismiss="modal">${escapeHtml(cancelLabel)}</button>
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

export function inputDialog(title, body = '', { placeholder = '', type = 'text', defaultValue = '', okLabel = 'OK', cancelLabel = 'Annulla' } = {}) {
  return new Promise(resolve => {
    const el = _getDialogEl();
    el.innerHTML = `
      <div class="modal-dialog modal-sm modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${escapeHtml(title)}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            ${body ? `<p class="mb-2">${escapeHtml(body)}</p>` : ''}
            <input id="dlg-input" type="${type}" class="form-control" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}" />
            ${type === 'password' ? `<input id="dlg-input2" type="password" class="form-control mt-2" placeholder="Conferma password" />` : ''}
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-link link-secondary me-auto" data-bs-dismiss="modal">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn btn-primary" id="dlg-ok">${escapeHtml(okLabel)}</button>
          </div>
        </div>
      </div>`;
    const m = window.bootstrap.Modal.getOrCreateInstance(el);
    let value = null;
    const inp = el.querySelector('#dlg-input');
    el.querySelector('#dlg-ok').onclick = () => {
      const v = inp.value;
      if (type === 'password') {
        const v2 = el.querySelector('#dlg-input2')?.value;
        if (v !== v2) { inp.classList.add('is-invalid'); return; }
      }
      value = v;
      m.hide();
    };
    el.addEventListener('hidden.bs.modal', () => resolve(value), { once: true });
    m.show();
    setTimeout(() => inp?.focus(), 300);
  });
}

export function selectDialog(title, body = '', options = [], { okLabel = 'OK', cancelLabel = 'Annulla', allowCreate = false } = {}) {
  return new Promise(resolve => {
    const el = _getDialogEl();
    const optHtml = options.map(o => `
      <label class="form-selectgroup-item flex-fill">
        <input type="radio" name="dlg-select" class="form-selectgroup-input" value="${escapeHtml(String(o.value))}">
        <span class="form-selectgroup-label d-flex flex-column">
          <span>${escapeHtml(o.label)}</span>
          ${o.hint ? `<small class="text-muted">${escapeHtml(o.hint)}</small>` : ''}
        </span>
      </label>`).join('');
    el.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">${escapeHtml(title)}</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            ${body ? `<p class="mb-2">${escapeHtml(body)}</p>` : ''}
            <div class="form-selectgroup form-selectgroup-boxes d-flex flex-column gap-2">${optHtml}</div>
            ${allowCreate ? `
              <div class="mt-3">
                <label class="form-label text-muted small">Oppure crea nuovo:</label>
                <input id="dlg-create" type="text" class="form-control" placeholder="Nome nuovo elemento..." />
              </div>` : ''}
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-link link-secondary me-auto" data-bs-dismiss="modal">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn btn-primary" id="dlg-ok">${escapeHtml(okLabel)}</button>
          </div>
        </div>
      </div>`;
    const m = window.bootstrap.Modal.getOrCreateInstance(el);
    let selected = null;
    el.querySelector('#dlg-ok').onclick = () => {
      const checked = el.querySelector('input[name="dlg-select"]:checked');
      const createVal = el.querySelector('#dlg-create')?.value?.trim();
      if (allowCreate && createVal) {
        selected = { value: '__create__', label: createVal };
      } else if (checked) {
        selected = { value: checked.value };
      }
      m.hide();
    };
    el.addEventListener('hidden.bs.modal', () => resolve(selected), { once: true });
    m.show();
  });
}
