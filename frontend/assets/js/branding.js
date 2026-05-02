/**
 * Loads branding from /api/settings/system and applies CSS vars, title, favicon, logo.
 */
import { apiGet } from './api.js';
import { setLang } from './i18n.js';

let _branding = null;

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

export function applyBranding(b) {
  if (!b) return;
  _branding = b;

  if (b.primary_color) {
    document.documentElement.style.setProperty('--hub-primary', b.primary_color);
    const rgb = hexToRgb(b.primary_color);
    if (rgb) document.documentElement.style.setProperty('--hub-primary-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
  }

  const companyName = b.company_name || 'MADMIN Hub';
  const brandEl = document.getElementById('sidebar-brand-text');
  if (brandEl) brandEl.textContent = companyName;

  if (b.logo_url) {
    const img = document.getElementById('sidebar-logo');
    if (img) { img.src = b.logo_url; img.style.display = ''; }
    const brandText = document.getElementById('sidebar-brand-text');
    if (brandText) brandText.style.display = 'none';
  }

  if (b.favicon_url) {
    let link = document.querySelector("link[rel='icon']");
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = b.favicon_url;
  }
}

export function updatePageTitle(pageTitle) {
  const company = _branding?.company_name || 'MADMIN Hub';
  document.title = pageTitle ? `${pageTitle} — ${company}` : company;
}

export async function loadBranding() {
  try {
    const b = await apiGet('/settings/system');
    if (b) applyBranding(b);
    return b;
  } catch (_) {
    return null;
  }
}

export function getBranding() { return _branding; }
