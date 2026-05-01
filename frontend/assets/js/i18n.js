/**
 * i18n — translation engine.
 * Usage: import { t, getLang, setLang } from './i18n.js';
 */
import it from './locales/it.js';
import en from './locales/en.js';

const MESSAGES = { it, en };
const LANG_KEY  = 'hub_lang';

export function getLang() {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored && MESSAGES[stored]) return stored;
  const browser = (navigator.language || '').substring(0, 2).toLowerCase();
  return MESSAGES[browser] ? browser : 'it';
}

export function setLang(lang) {
  if (!MESSAGES[lang]) return;
  localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang;
}

export function t(key, vars = {}) {
  const lang = getLang();
  const str = MESSAGES[lang]?.[key] ?? MESSAGES.it?.[key] ?? key;
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, v),
    str,
  );
}
