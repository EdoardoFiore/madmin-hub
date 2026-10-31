/**
 * MADMIN - Internationalization Module
 *
 * Lightweight i18n for vanilla JS with JSON locale files.
 * Supports dot-namespaced keys, {placeholder} interpolation, and DOM translation.
 */

let _translations = {};
let _lang = 'en';
const _supportedLangs = ['en', 'it'];

/**
 * Initialize i18n by loading the locale file for the given language.
 * @param {string} lang - Language code ('en', 'it', ...)
 */
export async function init(lang) {
    _lang = _supportedLangs.includes(lang) ? lang : 'en';

    try {
        const resp = await fetch(`/static/locales/${_lang}.json`);
        if (!resp.ok) throw new Error(`Locale ${_lang} not found`);
        _translations = await resp.json();
    } catch (err) {
        console.error(`[i18n] Failed to load locale "${_lang}":`, err);
        // If non-English failed, try falling back to English
        if (_lang !== 'en') {
            _lang = 'en';
            try {
                const resp = await fetch('/static/locales/en.json');
                if (resp.ok) _translations = await resp.json();
            } catch { /* silent */ }
        }
    }
}

/**
 * Translate a key with optional parameter interpolation.
 * Falls back to the key itself if not found.
 * @param {string} key - Dot-namespaced key (e.g. 'common.save')
 * @param {Object} [params] - Interpolation values (e.g. { name: 'John' })
 * @returns {string}
 */
export function t(key, params = {}) {
    let value = _resolve(key);
    if (value === undefined) return key;

    // Interpolate {placeholder} tokens. Values go in as-is: a caller that
    // renders the result as HTML escapes server data in `params` first.
    // The replacer is a function so '$&' / '$1' in a value stay literal.
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) {
            value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
        }
    }
    return value;
}

/**
 * Get the current active language code.
 * @returns {string}
 */
export function getLang() {
    return _lang;
}

/**
 * Get the list of supported languages.
 * @returns {string[]}
 */
export function getSupportedLangs() {
    return [..._supportedLangs];
}

/**
 * Detect the best language for the current context.
 * Priority: user preference > localStorage > browser language > 'en'
 * @param {Object|null} user - Current user object with preferences JSON
 * @param {string|null} systemDefault - System default language from settings
 * @returns {string}
 */
export function detectLang(user = null, systemDefault = null) {
    // 1. User preference
    if (user) {
        try {
            const prefs = JSON.parse(user.preferences || '{}');
            if (prefs.lang && _supportedLangs.includes(prefs.lang)) {
                return prefs.lang;
            }
        } catch { /* ignore */ }
    }

    // 2. localStorage (useful for login page, before user is loaded)
    const stored = localStorage.getItem('madmin_lang');
    if (stored && _supportedLangs.includes(stored)) {
        return stored;
    }

    // 3. System default
    if (systemDefault && _supportedLangs.includes(systemDefault)) {
        return systemDefault;
    }

    // 4. Browser language
    const browserLang = (navigator.language || '').split('-')[0];
    if (_supportedLangs.includes(browserLang)) {
        return browserLang;
    }

    // 5. Fallback
    return 'en';
}

/**
 * Scan DOM elements with data-i18n attributes and apply translations.
 * Supports:
 *   data-i18n="key"             → sets textContent
 *   data-i18n-placeholder="key" → sets placeholder attribute
 *   data-i18n-title="key"       → sets title attribute
 *   data-i18n-html="key"        → sets innerHTML (use with caution)
 * @param {Element} [root=document] - Root element to scan
 */
export function translateDOM(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const val = t(key);
        if (val !== key) el.textContent = val;
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const val = t(key);
        if (val !== key) el.setAttribute('placeholder', val);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        const val = t(key);
        if (val !== key) el.setAttribute('title', val);
    });
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.getAttribute('data-i18n-html');
        const val = t(key);
        if (val !== key) el.innerHTML = val;
    });
}

/**
 * Load module-specific translations and merge into the main dictionary.
 * Fetches from /static/modules/{moduleId}/locales/{lang}.json
 * @param {string} moduleId
 */
export async function loadModuleTranslations(moduleId) {
    // Skip if already loaded
    if (_translations[moduleId]) return;

    try {
        const resp = await fetch(`/static/modules/${moduleId}/locales/${_lang}.json`);
        if (!resp.ok) {
            // Try English fallback for modules
            if (_lang !== 'en') {
                const fallback = await fetch(`/static/modules/${moduleId}/locales/en.json`);
                if (fallback.ok) {
                    _translations[moduleId] = await fallback.json();
                }
            }
            return;
        }
        _translations[moduleId] = await resp.json();
    } catch {
        // Module may not have translations — that's fine
    }
}

/**
 * Resolve a dotted key against the translations dictionary.
 * @param {string} key
 * @returns {string|undefined}
 */
function _resolve(key) {
    const parts = key.split('.');
    let obj = _translations;
    for (const part of parts) {
        if (obj == null || typeof obj !== 'object') return undefined;
        obj = obj[part];
    }
    return typeof obj === 'string' ? obj : undefined;
}
