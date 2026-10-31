/**
 * MADMIN - page shell bits that live outside the router: footer year and the
 * language toggle. Loaded from index.html (the CSP forbids inline scripts).
 */
import { getLang, getSupportedLangs } from './i18n.js';
import { apiGet, apiPatch } from './api.js';

const year = document.getElementById('copyright-year');
if (year) year.textContent = new Date().getFullYear();

const btn = document.getElementById('lang-toggle-btn');
const label = document.getElementById('lang-toggle-label');

if (btn) {
    const langNames = { en: 'English', it: 'Italiano' };
    const nextLang = () => {
        const cur = getLang();
        const langs = getSupportedLangs();
        return langs[(langs.indexOf(cur) + 1) % langs.length];
    };
    const updateLabel = () => {
        const next = nextLang();
        label.textContent = langNames[next] || next.toUpperCase();
    };

    // Wait for i18n to be initialized before showing label
    setTimeout(updateLabel, 500);

    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const next = nextLang();

        // Save to user preferences
        try {
            const user = await apiGet('/auth/me');
            const prefs = JSON.parse(user.preferences || '{}');
            prefs.lang = next;
            await apiPatch('/auth/me/preferences', { preferences: JSON.stringify(prefs) });
        } catch (err) {
            console.error('Failed to save language preference:', err);
        }

        localStorage.setItem('madmin_lang', next);
        window.location.reload();
    });
}
