export const SHORTCUT_STORAGE_KEY = 'hongguo:preview:playback-shortcuts:v1';
export const SHORTCUT_EVENT = 'hongguo:playback-shortcuts-changed';
export const SHORTCUT_ACTIONS = [
  { id: 'play', label: '播放 / 暂停', key: 'space' },
  { id: 'holdSpeed', label: '长按临时 2 倍速', key: 'space' },
  { id: 'backward', label: '快退 5 秒', key: 'arrowleft', repeat: true },
  { id: 'forward', label: '快进 5 秒', key: 'arrowright', repeat: true },
  { id: 'previous', label: '上一集', key: 'arrowup' },
  { id: 'next', label: '下一集', key: 'arrowdown' },
  { id: 'autoNext', label: '切换连播', key: 'a' },
  { id: 'slower', label: '减速 0.25 倍', key: 's', repeat: true },
  { id: 'faster', label: '加速 0.25 倍', key: 'd', repeat: true },
  { id: 'fullscreen', label: '切换全屏', key: 'f' },
];
export const DEFAULT_SHORTCUTS = Object.freeze(Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action.id, action.key])));
const KEY_PATTERN = /^(shift\+)?([a-z0-9]|space|arrowleft|arrowright|arrowup|arrowdown)$/;

export function shortcutKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return null;
  let key = String(event.key || '').toLowerCase();
  if (event.code === 'Space' || key === ' ') key = 'space';
  else if (/^Key[A-Z]$/.test(event.code || '')) key = event.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(event.code || '')) key = event.code.slice(5);
  const value = `${event.shiftKey ? 'shift+' : ''}${key}`;
  return KEY_PATTERN.test(value) && value !== 'shift+space' ? value : null;
}

export function formatShortcut(value, translate = value => value) {
  const names = { space: '空格', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' };
  return value.split('+').map(key => translate(names[key] || (key === 'shift' ? 'Shift' : key.toUpperCase()))).join(' + ');
}

export function validateShortcuts(bindings, translate = value => value) {
  const seen = new Map();
  for (const action of SHORTCUT_ACTIONS) {
    const key = bindings?.[action.id];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key === 'shift+space') return `${translate(action.label)}的按键不可用`;
    const previous = seen.get(key);
    if (previous && !(previous.id === 'play' && action.id === 'holdSpeed')) return `与「${translate(previous.label)}」冲突，请换一个按键`;
    seen.set(key, action);
  }
  return '';
}

export function readShortcuts() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SHORTCUT_STORAGE_KEY));
    if (stored && typeof stored === 'object' && stored.holdSpeed === undefined) stored.holdSpeed = stored.play;
    if (!validateShortcuts(stored)) return Object.fromEntries(SHORTCUT_ACTIONS.map(({ id }) => [id, stored[id]]));
  } catch { /* Missing or damaged preferences use the complete default map. */ }
  return { ...DEFAULT_SHORTCUTS };
}

export function saveShortcuts(bindings) {
  const error = validateShortcuts(bindings);
  if (error) throw new Error(error);
  window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(bindings));
  window.dispatchEvent(new Event(SHORTCUT_EVENT));
}

export function subscribeShortcuts(onChange) {
  const update = event => {
    if (event.type !== 'storage' || event.key === SHORTCUT_STORAGE_KEY || event.key === null) onChange(readShortcuts());
  };
  window.addEventListener(SHORTCUT_EVENT, update);
  window.addEventListener('storage', update);
  return () => {
    window.removeEventListener(SHORTCUT_EVENT, update);
    window.removeEventListener('storage', update);
  };
}

export function ignoresPlaybackShortcut(target, key) {
  if (target?.isContentEditable || target?.closest?.('input, select, textarea, [contenteditable]:not([contenteditable="false"]), [data-shortcut-settings], [role="dialog"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="listbox"]')) return true;
  if (target?.closest?.('[data-player-menu]')) {
    // Escape/selection returns focus to the trigger; a closed menu must not keep swallowing playback keys.
    const closedTrigger = target.closest('button[aria-haspopup][aria-expanded="false"]') && target.closest('.player-container');
    if (!closedTrigger || !key || key === ' ' || key === 'Enter') return true;
  }
  return !!(target?.closest?.('button, a') && !target.closest('.player-container'));
}
