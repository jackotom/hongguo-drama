import { createTranslator, formatMessage } from './translator.mjs';
import { useSyncExternalStore } from 'react';
import english from './en.json';
import templates from './templates.json';
import { resolveLanguage, readPreference, savePreference, LANGUAGE_KEY } from './language.mjs';

let locale = typeof navigator === 'undefined' ? '' : navigator.language;
const storage = () => window.localStorage;
let preference;
try { preference = readPreference(storage()); } catch { preference = 'system'; }
let language = resolveLanguage(preference, locale);
const listeners = new Set();
const translateEnglish = createTranslator(english, templates);

export function t(value, values) { return language === 'en' ? translateEnglish(value, values) : formatMessage(value, values); }
export function getLanguagePreference() { return preference; }
export function getLanguage() { return language; }
function refresh() {
  language = resolveLanguage(preference, locale);
  document.documentElement.lang = language;
  document.title = language === 'en' ? 'Hongguo Drama' : '红果短剧';
  for (const listener of listeners) listener();
  try {
    Promise.resolve(window.electronAPI?.setInterfaceLanguage?.(language)).catch(() => {});
  } catch { /* Native menu updates must not block interface language or saved preferences. */ }
}
export async function initializeLanguage() {
  try {
    const info = await window.electronAPI?.getAppInfo?.();
    locale = info?.systemLocale || locale;
  } catch { /* Browser locale remains available when the native bridge is absent. */ }
  refresh();
}
export function setLanguagePreference(value) {
  savePreference(value, storage());
  preference = value;
  refresh();
}
export function useLanguage() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => language + ':' + preference);
}
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => { void initializeLanguage(); });
  window.addEventListener('storage', event => {
    if (event.key === LANGUAGE_KEY || event.key === null) { preference = readPreference(storage()); refresh(); }
  });
}
