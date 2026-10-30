const DEFAULT_BOSS_KEY = Object.freeze({ enabled: false, accelerator: 'CommandOrControl+Shift+H' });
const MODIFIERS = { ctrl: 'Control', control: 'Control', cmd: 'Command', command: 'Command', meta: 'Command',
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl', alt: 'Alt', option: 'Alt', shift: 'Shift' };
const PAUSE_MEDIA = `(() => {
  document.querySelectorAll('video, audio').forEach(media => media.pause());
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  return true;
})()`;

function normalizeBossKey(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.accelerator !== 'string' || value.accelerator.length > 80) throw Error('老板键设置无效');
  const parts = value.accelerator.split('+').map(part => part.trim());
  const key = parts.pop().toUpperCase();
  const modifiers = parts.map(part => MODIFIERS[part.toLowerCase()]).map(part => part === 'CommandOrControl' ? (process.platform === 'darwin' ? 'Command' : 'Control') : part);
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|SPACE)$/.test(key) || modifiers.some(part => !part)
    || new Set(modifiers).size !== modifiers.length || (!/^F\d+$/.test(key) && !modifiers.some(part => part !== 'Shift'))) {
    throw Error('请使用 Ctrl、Cmd 或 Alt 组合键，或 F1–F12；不能使用普通单键');
  }
  modifiers.sort((a, b) => ['Control', 'Command', 'Alt', 'Shift'].indexOf(a) - ['Control', 'Command', 'Alt', 'Shift'].indexOf(b));
  return { enabled: value.enabled, accelerator: [...modifiers, key === 'SPACE' ? 'Space' : key].join('+') };
}

function createBossKeyController({ globalShortcut, getWindows, getMainWindow, store, dock }) {
  let config = normalizeBossKey(DEFAULT_BOSS_KEY), registered = '', error = '', hidden = false, generation = 0;
  let savedWindows = [];
  let restoreDock = false;
  const mutedContents = new Map();
  const getState = () => ({ ...config, registered: !!registered, error, hidden });
  const notify = () => {
    const main = getMainWindow();
    if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) main.webContents.send('boss-key-state', { hidden });
  };
  const pause = contents => {
    try { return Promise.resolve(contents.executeJavaScript(PAUSE_MEDIA)); }
    catch (failure) { return Promise.reject(failure); }
  };
  const restore = () => {
    if (!hidden) return false;
    hidden = false;
    const token = ++generation;
    if (restoreDock) {
      Promise.resolve(dock.show()).then(() => {
        // A late Dock show cannot reveal an app hidden again by a rapid second press.
        if (hidden) dock.hide();
        else restoreDock = false;
      }).catch(() => { error = 'Dock 图标暂时无法恢复，请重新打开应用'; });
    }
    notify();
    for (const [contents, wasMuted] of mutedContents) {
      if (contents.isDestroyed()) { mutedContents.delete(contents); continue; }
      pause(contents).then(() => {
        if (hidden || generation !== token || contents.isDestroyed()) return;
        contents.setAudioMuted(wasMuted);
        mutedContents.delete(contents);
      }).catch(() => { /* Keep temporary mute if the renderer cannot confirm pause. */ });
    }
    const windows = savedWindows.filter(({ window }) => !window.isDestroyed());
    savedWindows = [];
    for (const { window, minimized } of [...windows].reverse()) {
      window.show();
      if (minimized) window.minimize();
    }
    const focus = windows.find(item => item.focused && !item.minimized) || windows.find(item => !item.minimized);
    focus?.window.focus();
    return windows.length > 0;
  };
  const toggle = () => {
    if (hidden) return restore();
    const windows = getWindows().filter(window => !window.isDestroyed() && (window.isVisible() || window.isMinimized()));
    if (!windows.length) return false;
    savedWindows = windows.map(window => ({ window, minimized: window.isMinimized(), focused: window.isFocused() }));
    const main = getMainWindow();
    const contents = new Set([main?.webContents, ...windows.map(window => window.webContents)]);
    for (const item of contents) {
      if (!item || item.isDestroyed()) continue;
      // Preserve the original mute state across rapid hide/restore/hide sequences.
      if (!mutedContents.has(item)) mutedContents.set(item, item.isAudioMuted());
      item.setAudioMuted(true);
    }
    hidden = true; generation++;
    restoreDock ||= dock?.isVisible() === true;
    notify();
    for (const item of mutedContents.keys()) if (!item.isDestroyed()) pause(item).catch(() => {});
    for (const window of windows) if (!window.isDestroyed()) window.hide();
    if (restoreDock) dock.hide();
    return true;
  };
  const callback = () => { try { toggle(); } catch (_) { error = '老板键暂时无法切换，请重试'; } };
  const register = accelerator => {
    let accepted = false;
    try { accepted = globalShortcut.register(accelerator, callback); } catch (_) {}
    if (!accepted) throw Error('快捷键已被占用或系统不支持，请换一组按键');
  };
  const set = value => {
    const next = normalizeBossKey(value);
    const added = next.enabled && registered !== next.accelerator;
    if (added) register(next.accelerator);
    try { store.saveSettings({ ...store.getSettings(), boss_key: next }); }
    catch (failure) { if (added) globalShortcut.unregister(next.accelerator); throw failure; }
    if (registered && (!next.enabled || registered !== next.accelerator)) globalShortcut.unregister(registered);
    registered = next.enabled ? next.accelerator : '';
    config = next; error = '';
    if (!next.enabled) restore();
    return getState();
  };
  return { getState, set, toggle, restore, get hidden() { return hidden; },
    start() {
      try {
        config = normalizeBossKey(store.getSettings().boss_key || DEFAULT_BOSS_KEY);
        if (config.enabled) { register(config.accelerator); registered = config.accelerator; }
      } catch (failure) { error = failure.message; }
      return getState();
    },
    dispose() {
      generation++;
      if (registered) globalShortcut.unregister(registered);
      registered = ''; savedWindows = []; mutedContents.clear();
    },
  };
}
module.exports = { DEFAULT_BOSS_KEY, normalizeBossKey, createBossKeyController };
