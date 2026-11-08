export const LANGUAGE_KEY = 'hongguo:language';
export const LANGUAGE_OPTIONS = ['system', 'zh-CN', 'en'];
export function resolveLanguage(preference, locale) {
  if (preference === 'zh-CN' || preference === 'en') return preference;
  return /^zh(?:[-_.@]|$)/i.test(String(locale || '').trim()) ? 'zh-CN' : 'en';
}
export function systemLocale(env = {}, locale = '', platform = '') {
  return platform === 'linux' ? env.LC_ALL || env.LC_MESSAGES || env.LANG || locale : locale;
}
export function readPreference(storage) {
  try { const value = storage.getItem(LANGUAGE_KEY); return LANGUAGE_OPTIONS.includes(value) ? value : 'system'; }
  catch { return 'system'; }
}
export function savePreference(preference, storage) {
  if (!LANGUAGE_OPTIONS.includes(preference)) throw new Error('Unsupported language preference');
  storage.setItem(LANGUAGE_KEY, preference);
}
