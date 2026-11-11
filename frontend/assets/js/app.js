/**
 * MADMIN Manager - Main Application Module
 *
 * Handles routing, menu loading, and view rendering.
 * Uses ES modules for dynamic view loading.
 */

import { isAuthenticated, redirectToLogin, getCurrentUser, clearToken, apiGet, apiPatch, apiPost } from './api.js';
import { showToast, loadingSpinner, watchTablerComponents, escapeHtml, actionAttrs, registerActions } from './utils.js';
import { init as i18nInit, t, getLang, detectLang, translateDOM } from './i18n.js';
import { openProfileModal } from './profile.js';

registerActions({ reloadPage: () => location.reload() });

// View registry - maps routes to view modules
const views = {
    'dashboard': () => import('./views/dashboard.js'),
    'instances': () => import('./views/instances.js'),
    'support': () => import('./views/support.js'),
    'licenses': () => import('./views/licenses.js'),
    'enrollment': () => import('./views/enrollment.js'),
    'users': () => import('./views/users.js'),
    'settings': () => import('./views/settings.js'),
    'logs': () => import('./views/logs.js'),
};

// Views laid out edge to edge (container-fluid instead of container-xl)
const WIDE_VIEWS = new Set(['dashboard', 'instances']);

// Current user data
let currentUser = null;

/**
 * Initialize the application
 */
async function init() {
    console.log('MADMIN Manager initializing...');

    // Check authentication
    if (!isAuthenticated()) {
        redirectToLogin();
        return;
    }

    // Views render their markup after tabler.js has loaded: create the Tabler
    // components (OTP, clipboard, strength meter) they declare
    watchTablerComponents();

    // Load user info
    try {
        currentUser = await getCurrentUser();
        updateUserDisplay();
    } catch (error) {
        console.error('Failed to get user info:', error);
        redirectToLogin();
        return;
    }

    // Load system settings to get default language before i18n init
    let systemDefault = 'en';
    try {
        const sysSettings = await fetch('/api/settings/system', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('madmin_token')}` }
        });
        if (sysSettings.ok) {
            const s = await sysSettings.json();
            systemDefault = s.default_language || 'en';
        }
    } catch { /* ignore */ }

    // Initialize i18n
    const lang = detectLang(currentUser, systemDefault);
    localStorage.setItem('madmin_lang', lang);
    await i18nInit(lang);

    // Translate static HTML elements
    translateDOM();

    // Check if 2FA is enforced but not enabled - force user to set it up
    await check2FAEnforcement();

    // Load and apply system settings (customizations)
    await loadSystemSettings();

    // Apply user theme (dark/light)
    applyUserTheme();

    // Setup event listeners
    setupLogout();
    setupNavigation();
    setupMobileMenu();
    setupThemeToggle();
    setupProfileLink();

    // Load menu
    await loadMenu();

    // Handle initial route
    handleRoute();

    // Listen for hash changes
    window.addEventListener('hashchange', handleRoute);

    console.log('MADMIN ready');
}

/**
 * Check if 2FA is enforced but not enabled - show global setup modal if needed
 */
async function check2FAEnforcement() {
    try {
        const response = await fetch('/api/auth/me/2fa/status', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('madmin_token')}`
            }
        });

        if (!response.ok) return;

        const status = await response.json();

        // If 2FA is enforced but not enabled, show global modal
        if (status.enforced && !status.enabled) {
            showGlobal2FAModal();
        }
    } catch (error) {
        console.error('Failed to check 2FA status:', error);
    }
}

/**
 * Show global 2FA setup modal (cannot be dismissed until setup complete)
 */
function showGlobal2FAModal() {
    const modal = new bootstrap.Modal(document.getElementById('global-2fa-modal'));
    modal.show();

    // Setup button handlers
    document.getElementById('btn-start-global-2fa')?.addEventListener('click', startGlobal2FASetup);
    document.getElementById('btn-global-verify-2fa')?.addEventListener('click', verifyGlobal2FA);
    document.getElementById('global-verify-code')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') verifyGlobal2FA();
    });
}

/**
 * Start global 2FA setup - call API to generate secret and QR
 */
async function startGlobal2FASetup() {
    const btn = document.getElementById('btn-start-global-2fa');
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>${t('app.generating')}`;
    btn.disabled = true;

    try {
        const response = await fetch('/api/auth/me/2fa/setup', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('madmin_token')}`,
                'Content-Type': 'application/json'
            },
            body: '{}'
        });

        if (!response.ok) throw new Error(t('app.2faGenerationError'));

        const data = await response.json();

        // Show QR content
        document.getElementById('global-2fa-setup-content').classList.add('d-none');
        document.getElementById('global-2fa-qr-content').classList.remove('d-none');

        // Populate data
        document.getElementById('global-qr-code-img').src = `data:image/png;base64,${data.qr_code}`;
        document.getElementById('global-secret-key').value = data.secret;

        // Show backup codes
        const codesContainer = document.getElementById('global-backup-codes');
        codesContainer.innerHTML = data.backup_codes.map(c =>
            `<div class="col-6 col-md-4"><code class="fs-5">${escapeHtml(c)}</code></div>`
        ).join('\n');  // newline-separated: the copy button copies this text

    } catch (error) {
        showToast(t('common.errorPrefix') + error.message, 'error');
        btn.innerHTML = `<i class="ti ti-shield-plus me-2"></i>${t('app.configure2fa')}`;
        btn.disabled = false;
    }
}

/**
 * Verify global 2FA code and enable
 */
async function verifyGlobal2FA() {
    const code = document.getElementById('global-verify-code').value.trim();
    if (!code || code.length !== 6) {
        showToast(t('app.enter6digitCode'), 'error');
        return;
    }

    const btn = document.getElementById('btn-global-verify-2fa');
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('app.verificationInProgress')}`;
    btn.disabled = true;

    try {
        const response = await fetch('/api/auth/me/2fa/enable', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('madmin_token')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ code })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || t('auth.invalidCode'));
        }

        showToast(t('app.2faActivatedSuccess'), 'success');

        // Close modal
        bootstrap.Modal.getInstance(document.getElementById('global-2fa-modal'))?.hide();

        // Reload page to refresh state
        window.location.reload();

    } catch (error) {
        showToast(t('common.errorPrefix') + error.message, 'error');
        btn.innerHTML = `<i class="ti ti-check me-1"></i>${t('app.activate2fa')}`;
        btn.disabled = false;
    }
}

function isSafeUrl(url) {
    if (url.startsWith('//')) return false;  // block protocol-relative URLs
    try {
        const u = new URL(url, window.location.origin);
        return ['http:', 'https:'].includes(u.protocol);
    } catch { return false; }
}

/**
 * Load and apply system settings (company name, primary color, etc.)
 */
async function loadSystemSettings() {
    try {
        const response = await fetch('/api/settings/system', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('madmin_token')}`
            }
        });

        if (!response.ok) return;

        const settings = await response.json();

        // Apply company name to browser title, sidebar, and mobile header
        if (settings.company_name) {
            document.title = `${settings.company_name} - Dashboard`;
            // Desktop sidebar brand
            const brandText = document.getElementById('navbar-brand-text');
            if (brandText) {
                brandText.textContent = settings.company_name;
            }
            // Mobile header brand
            const mobileBrand = document.getElementById('mobile-brand-name');
            if (mobileBrand) {
                mobileBrand.textContent = settings.company_name;
            }
        }

        // Apply primary color as CSS variable
        if (settings.primary_color && /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(settings.primary_color)) {
            const safeColor = settings.primary_color;
            document.documentElement.style.setProperty('--madmin-primary', safeColor);
            document.documentElement.style.setProperty('--tblr-primary', safeColor);
            const style = document.createElement('style');
            style.textContent = `
                .btn-primary { background-color: ${safeColor} !important; border-color: ${safeColor} !important; }
                .nav-link.active { background-color: ${safeColor} !important; }
                .text-primary { color: ${safeColor} !important; }
            `;
            document.head.appendChild(style);
        }

        // Apply logo - use custom URL if set, otherwise default logo.png is already in src
        const logoImg = document.getElementById('navbar-logo-img');
        const mobileLogoImg = document.getElementById('mobile-logo-img');
        if (settings.logo_url && isSafeUrl(settings.logo_url)) {
            if (logoImg) logoImg.src = settings.logo_url;
            if (mobileLogoImg) mobileLogoImg.src = settings.logo_url;
        }

        // Apply favicon if set (override default favicon.ico)
        if (settings.favicon_url && isSafeUrl(settings.favicon_url)) {
            const faviconLink = document.getElementById('favicon-link');
            if (faviconLink) {
                faviconLink.href = settings.favicon_url;
            }
        }

        // Show support URL in footer if configured (inline with version)
        if (settings.support_url && isSafeUrl(settings.support_url)) {
            const supportLink = document.getElementById('support-link');
            const supportItem = document.getElementById('support-link-item');
            if (supportLink && supportItem) {
                supportLink.href = settings.support_url;
                supportItem.style.display = 'list-item';
            }
        }

        // Update footer brand with company name
        if (settings.company_name) {
            const footerBrand = document.getElementById('footer-brand');
            if (footerBrand) {
                footerBrand.textContent = settings.company_name;
            }
        }

    } catch (error) {
        console.error('Failed to load system settings:', error);
    }
}

/**
 * Update user display in sidebar
 */
function updateUserDisplay() {
    const userNameEl = document.getElementById('user-name');
    if (userNameEl && currentUser) {
        userNameEl.textContent = currentUser.username;
    }
}

/**
 * Setup "Profile" dropdown item -> open self-service profile modal
 */
function setupProfileLink() {
    const link = document.getElementById('profile-link');
    if (link) {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            // The user menu uses data-bs-auto-close="outside": close it by hand
            const trigger = document.querySelector('#user-dropdown [data-bs-toggle="dropdown"]');
            if (trigger) bootstrap.Dropdown.getOrCreateInstance(trigger).hide();
            openProfileModal();
        });
    }
}

/**
 * Setup logout button
 */
function setupLogout() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            // End the session server-side too: removing the token from this
            // browser alone left it valid until expiry for whoever copied it
            try {
                await apiPost('/auth/logout');
            } catch (err) {
                console.warn('Server-side logout failed:', err);
            }
            clearToken();
            redirectToLogin();
        });
    }
}

/**
 * Apply user theme from preferences
 */
function applyUserTheme() {
    if (!currentUser) return;
    try {
        const prefs = JSON.parse(currentUser.preferences || '{}');
        const theme = prefs.theme || 'light';
        applyTheme(theme);
    } catch (e) {
        applyTheme('light');
    }
}

/**
 * Apply a theme and update toggle UI
 */
export function applyTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme);
    // Update toggle button UI
    const icon = document.getElementById('theme-toggle-icon');
    const label = document.getElementById('theme-toggle-label');
    if (icon) {
        icon.className = theme === 'dark' ? 'ti ti-sun me-2' : 'ti ti-moon me-2';
    }
    if (label) {
        label.textContent = theme === 'dark' ? t('auth.lightTheme') : t('auth.darkTheme');
    }
}

/**
 * Get current theme
 */
export function getCurrentTheme() {
    return document.documentElement.getAttribute('data-bs-theme') || 'light';
}

/**
 * Setup theme toggle in user dropdown
 */
function setupThemeToggle() {
    const toggleBtn = document.getElementById('theme-toggle-btn');
    if (!toggleBtn) return;

    toggleBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const newTheme = getCurrentTheme() === 'dark' ? 'light' : 'dark';
        applyTheme(newTheme);

        // Save to user preferences
        try {
            const allPrefs = JSON.parse(currentUser.preferences || '{}');
            allPrefs.theme = newTheme;
            const prefsStr = JSON.stringify(allPrefs);
            await apiPatch('/auth/me/preferences', { preferences: prefsStr });
            currentUser.preferences = prefsStr;
        } catch (err) {
            console.error('Failed to save theme preference:', err);
        }
    });
}

/**
 * Setup navigation click handlers
 */
function setupNavigation() {
    const navMenu = document.getElementById('nav-menu');
    if (navMenu) {
        navMenu.addEventListener('click', (e) => {
            const link = e.target.closest('a.nav-link');
            if (link) {
                // Update active state
                navMenu.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
                link.classList.add('active');
                // Close mobile menu on navigation
                closeMobileMenu();
            }
        });
    }
}

/**
 * Setup mobile menu toggle
 */
function setupMobileMenu() {
    const toggleBtn = document.getElementById('mobile-menu-toggle');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('mobile-overlay');

    if (!toggleBtn || !sidebar) return;

    // Toggle menu on hamburger click
    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('mobile-open');
        overlay?.classList.toggle('show');
    });

    // Close on overlay click
    overlay?.addEventListener('click', closeMobileMenu);
}

/**
 * Close mobile menu
 */
function closeMobileMenu() {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    document.getElementById('mobile-overlay')?.classList.remove('show');
}

/**
 * Load menu from API
 */
async function loadMenu() {
    const navMenu = document.getElementById('nav-menu');
    if (!navMenu) return;

    try {
        const response = await fetch('/api/ui/menu', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('madmin_token')}`
            }
        });

        if (!response.ok) throw new Error('Failed to load menu');

        const menuData = await response.json();
        buildRoutePermissions(menuData);

        // Build menu HTML
        let menuHtml = '';

        // Core menu items
        for (const item of menuData.core) {
            if (item.permission && !hasPermission(item.permission)) {
                continue;
            }
            menuHtml += createMenuItem(item);
        }

        // Module menu items
        if (menuData.modules && menuData.modules.length > 0) {
            const visibleModules = menuData.modules.filter(item =>
                !item.permission || hasPermission(item.permission)
            );

            if (visibleModules.length > 0) {
                menuHtml += `
                    <li class="nav-item pt-3">
                        <span class="nav-link disabled text-uppercase text-muted" style="font-size: 0.7rem;">
                            ${t('menu.modulesSection')}
                        </span>
                    </li>
                `;

                for (const item of visibleModules) {
                    menuHtml += createMenuItem(item);
                }
            }
        }

        navMenu.innerHTML = menuHtml;

    } catch (error) {
        console.error('Failed to load menu:', error);
    }
}

/**
 * Create a menu item HTML - supports both Tabler icons and custom URLs
 */
function createMenuItem(item) {
    let iconHtml;
    if (item.icon && /^(https?:\/\/|\/)/.test(item.icon)) {
        iconHtml = `<img src="${escapeHtml(item.icon)}" alt="" class="module-icon-menu" style="width: 20px; height: 20px;">`;
    } else {
        const iconClass = item.icon ? `ti-${item.icon}` : 'ti-circle';
        iconHtml = `<i class="ti ${iconClass}"></i>`;
    }
    // item.label is either a translation key (e.g. "menu.users") or a display name (module names)
    const label = item.label.includes('.') ? t(item.label) : item.label;
    return `
        <li class="nav-item">
            <a class="nav-link" href="${escapeHtml(item.route)}">
                <span class="nav-link-icon d-md-none d-lg-inline-block">
                    ${iconHtml}
                </span>
                <span class="nav-link-title">${escapeHtml(label)}</span>
            </a>
        </li>
    `;
}

/**
 * Check if the current user has a capability (scope.view, scope.manage,
 * users.view, users.manage, manager.view, manager.manage). The server derives them
 * from role and access level and sends them in /me as `permissions`.
 * Accepts a slug, or an array of slugs meaning "any of these".
 */
function hasPermission(permission) {
    const held = currentUser?.permissions || [];
    if (Array.isArray(permission)) {
        return permission.some(p => held.includes(p));
    }
    return held.includes(permission);
}

// route name -> permission, built from the menu the server sends. Lets handleRoute
// refuse a hash typed by hand instead of loading a view whose every API call 403s.
let routePermissions = {};

function buildRoutePermissions(menuData) {
    routePermissions = {};
    for (const item of [...(menuData.core || []), ...(menuData.modules || [])]) {
        if (!item.permission || !item.route) continue;
        routePermissions[item.route.replace(/^#\/?/, '')] = item.permission;
    }
}

/**
 * Handle route changes
 */
// Navigation guard: a view with unsaved state (e.g. the firewall rule editor)
// can veto hash navigation. The guard returns true to allow leaving.
let navGuard = null;
let lastRouteHash = window.location.hash;
let restoringHash = false;

export function setNavigationGuard(fn) { navGuard = fn; }
export function clearNavigationGuard() { navGuard = null; }

async function handleRoute() {
    if (restoringHash) { restoringHash = false; return; }
    if (navGuard && window.location.hash !== lastRouteHash) {
        const target = window.location.hash;
        // Put the old hash back while the guard decides (sync revert avoids a
        // visible flash of the target route).
        restoringHash = true;
        window.location.hash = lastRouteHash;
        if (!(await navGuard())) return;
        navGuard = null;
        restoringHash = true;
        window.location.hash = target;
        // fall through: render the target now (the hashchange we just queued
        // is swallowed by the restoringHash flag)
    }
    lastRouteHash = window.location.hash;

    let hash = window.location.hash.slice(1);

    // Remove leading slash if present
    if (hash.startsWith('/')) {
        hash = hash.substring(1);
    }

    // Default route
    if (!hash) hash = 'dashboard';

    const [viewName, ...params] = hash.split('/');

    // Views with a side panel use the whole width
    const wide = WIDE_VIEWS.has(viewName);
    document.querySelectorAll('.page-wrapper .container-xl, .page-wrapper .container-fluid').forEach((c) => {
        c.classList.toggle('container-xl', !wide);
        c.classList.toggle('container-fluid', wide);
    });

    // Update page title
    const pageTitle = document.getElementById('page-title');
    if (pageTitle) {
        pageTitle.textContent = getViewTitle(viewName);
    }

    // Update active menu item
    updateActiveMenuItem(viewName);

    // Clear page actions
    const pageActions = document.getElementById('page-actions');
    if (pageActions) {
        pageActions.innerHTML = '';
    }

    // Load view
    const contentEl = document.getElementById('app-content');
    if (!contentEl) return;

    // A hash typed by hand must not load a view the user cannot use. The backend
    // still enforces every call; this only avoids a page of cascading 403 toasts.
    const required = routePermissions[viewName];
    if (required && !hasPermission(required)) {
        contentEl.innerHTML = `
            <div class="card">
                <div class="card-body text-center py-5">
                    <i class="ti ti-lock text-muted" style="font-size: 4rem;"></i>
                    <h3 class="mt-3">${t('app.accessDenied')}</h3>
                    <p class="text-muted">${t('app.accessDeniedDesc')}</p>
                    <a href="#dashboard" class="btn btn-primary">${t('app.backToDashboard')}</a>
                </div>
            </div>
        `;
        return;
    }

    contentEl.innerHTML = loadingSpinner();

    try {
        let viewModule;

        if (!views[viewName]) {
            contentEl.innerHTML = `
                <div class="card">
                    <div class="card-body text-center py-5">
                        <i class="ti ti-error-404 text-muted" style="font-size: 4rem;"></i>
                        <h3 class="mt-3">${t('app.pageNotFound')}</h3>
                        <p class="text-muted">${t('app.pageNotFoundDesc')}</p>
                        <a href="#dashboard" class="btn btn-primary">${t('app.backToDashboard')}</a>
                    </div>
                </div>
            `;
            return;
        }
        viewModule = await views[viewName]();

        await viewModule.render(contentEl, params);

    } catch (error) {
        console.error('Failed to load view:', error);
        contentEl.innerHTML = `
            <div class="card">
                <div class="card-body text-center py-5">
                    <i class="ti ti-alert-circle text-danger" style="font-size: 4rem;"></i>
                    <h3 class="mt-3">${t('app.loadingError')}</h3>
                    <p class="text-muted">${escapeHtml(error.message)}</p>
                    <button class="btn btn-primary" ${actionAttrs('reloadPage')}>${t('app.reload')}</button>
                </div>
            </div>
        `;
    }
}

/**
 * Get human-readable title for a view
 */
function getViewTitle(viewName) {
    const titles = {
        'dashboard': t('menu.dashboard'),
        'instances': t('menu.instances'),
        'support': t('menu.support'),
        'licenses': t('menu.licenses'),
        'enrollment': t('menu.enrollment'),
        'users': t('menu.users'),
        'settings': t('menu.settings'),
        'logs': t('menu.logs'),
    };
    return titles[viewName] || viewName.charAt(0).toUpperCase() + viewName.slice(1);
}

/**
 * Update active menu item
 */
function updateActiveMenuItem(viewName) {
    const navMenu = document.getElementById('nav-menu');
    if (!navMenu) return;

    navMenu.querySelectorAll('.nav-link').forEach(link => {
        const href = link.getAttribute('href');
        const linkView = href ? href.replace('#', '').split('/')[0] : '';

        if (linkView === viewName) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });
}

/**
 * Set page actions (buttons in header)
 */
export function setPageActions(html) {
    const pageActions = document.getElementById('page-actions');
    if (pageActions) {
        pageActions.innerHTML = html;
    }
}

/**
 * Get current user
 */
export function getUser() {
    return currentUser;
}

/**
 * Check user permission
 */
export function checkPermission(permission) {
    return hasPermission(permission);
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);
