/**
 * Right-side drawer host. Views call openDrawer({title, render, footer?}) to slide in a panel.
 * Closing the drawer pops the URL back to the parent route.
 */

let _isOpen = false;
let _onClose = null;

const el        = () => document.getElementById('hub-drawer');
const backdrop  = () => document.getElementById('drawer-backdrop');
const titleEl   = () => document.getElementById('drawer-title');
const bodyEl    = () => document.getElementById('drawer-body');
const footerEl  = () => document.getElementById('drawer-footer');
const closeBtn  = () => document.getElementById('drawer-close');

function _open() {
  el()?.classList.add('open');
  backdrop()?.classList.add('open');
  _isOpen = true;
}

function _close() {
  el()?.classList.remove('open');
  backdrop()?.classList.remove('open');
  _isOpen = false;
  if (_onClose) { _onClose(); _onClose = null; }
}

export function isDrawerOpen() { return _isOpen; }

/**
 * Open drawer with content.
 * @param {object} opts
 * @param {string} opts.title
 * @param {function} opts.render - async fn(bodyEl, footerEl) that populates the drawer
 * @param {string} [opts.closeHash] - hash to push when drawer closes (e.g. '#instances')
 */
export async function openDrawer({ title, render, closeHash = null }) {
  const body   = bodyEl();
  const footer = footerEl();
  const ttl    = titleEl();

  if (ttl) ttl.textContent = title || '';
  if (body) body.innerHTML = '<div class="hub-loader"></div>';
  if (footer) { footer.innerHTML = ''; footer.style.display = 'none'; }

  _open();

  _onClose = closeHash ? () => {
    if (window.location.hash !== closeHash) window.location.hash = closeHash;
  } : null;

  try {
    await render(body, footer);
  } catch (err) {
    console.error('[drawer] render error', err);
    if (body) body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--hub-status-offline)">Errore caricamento.</div>`;
  }
}

export function closeDrawer() { _close(); }

export function setDrawerFooter(html) {
  const f = footerEl();
  if (!f) return;
  f.innerHTML = html;
  f.style.display = '';
}

// Wire up close button and backdrop (called once on page load)
export function initDrawer() {
  closeBtn()?.addEventListener('click', _close);
  backdrop()?.addEventListener('click', _close);
}
