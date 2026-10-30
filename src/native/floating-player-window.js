const FLOATING_WINDOW_NAME = 'hongguo-floating-player';
const SIZE_SAVE_DELAY_MS = 150;
const MIN_WIDTH = 240;
const MAX_WIDTH = 900;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 900;
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};
const normalizeSize = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.width !== 'number' || !Number.isFinite(value.width) || value.width <= 0) return null;
  if (typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height <= 0) return null;
  return {
    width: clamp(value.width, MIN_WIDTH, MAX_WIDTH, MIN_WIDTH),
    height: clamp(value.height, MIN_HEIGHT, MAX_HEIGHT, MIN_HEIGHT),
  };
};

function attachFloatingPlayerWindow(mainWindow, {
  BrowserWindow,
  isTrustedUrl,
  store,
  screen,
  platform = process.platform,
} = {}) {
  if (!mainWindow?.webContents?.setWindowOpenHandler || typeof BrowserWindow !== 'function'
    || typeof store?.getSettings !== 'function' || typeof store?.saveSettings !== 'function'
    || typeof screen?.getDisplayMatching !== 'function') {
    throw new TypeError('attachFloatingPlayerWindow requires a window, BrowserWindow, screen and settings store');
  }

  let floatingWindow = null;
  let finalizeFloatingWindow = null;
  let lastKnownSize = null;

  const loadSavedSize = () => {
    try {
      return normalizeSize(store.getSettings()?.floating_player_size);
    } catch (error) {
      console.warn('[FloatingPlayer] 悬浮窗尺寸读取失败:', error?.message || error);
      return null;
    }
  };
  const persistSize = size => {
    try {
      const settings = store.getSettings() || {};
      store.saveSettings({ ...settings, floating_player_size: size });
      return true;
    } catch (error) {
      console.warn('[FloatingPlayer] 悬浮窗尺寸保存失败:', error?.message || error);
      return false;
    }
  };
  const currentNormalSize = window => {
    if (window.isDestroyed()) return null;
    let bounds = null;
    try {
      if (typeof window.getNormalBounds === 'function') bounds = window.getNormalBounds();
    } catch (_) {}
    if (!bounds && !window.isMaximized?.() && !window.isFullScreen?.()) {
      try { bounds = window.getBounds?.(); } catch (_) {}
    }
    return normalizeSize(bounds);
  };

  mainWindow.once('closed', () => {
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      finalizeFloatingWindow?.();
      floatingWindow.destroy();
    }
    floatingWindow = null;
    finalizeFloatingWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url, frameName, options } = {}) => {
    let mainUrl = '';
    try { mainUrl = mainWindow.webContents.getURL(); } catch (_) {}
    const allowed = !mainWindow.isDestroyed?.()
      && url === 'about:blank'
      && frameName === FLOATING_WINDOW_NAME
      && typeof isTrustedUrl === 'function'
      && isTrustedUrl(mainUrl);
    if (!allowed) return { action: 'deny' };

    return {
      action: 'allow',
      createWindow(finalOptions = options || {}) {
        if (floatingWindow && !floatingWindow.isDestroyed()) return floatingWindow.webContents;

        const requestedSize = {
          width: clamp(finalOptions.width, MIN_WIDTH, MAX_WIDTH, 480),
          height: clamp(finalOptions.height, MIN_HEIGHT, MAX_HEIGHT, 270),
        };
        const initialSize = lastKnownSize || loadSavedSize() || requestedSize;
        const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
        const width = Math.min(initialSize.width, Math.max(MIN_WIDTH, area.width - 32));
        const height = Math.min(initialSize.height, Math.max(MIN_HEIGHT, area.height - 32));
        lastKnownSize = { width, height };
        const webPreferences = {
          ...(finalOptions.webPreferences || {}),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
        };
        delete webPreferences.preload;
        const child = new BrowserWindow({
          ...finalOptions,
          width,
          height,
          x: area.x + Math.max(0, area.width - width - 16),
          y: area.y + Math.max(0, area.height - height - 16),
          show: true,
          useContentSize: false,
          minWidth: MIN_WIDTH,
          minHeight: MIN_HEIGHT,
          maxWidth: MAX_WIDTH,
          maxHeight: MAX_HEIGHT,
          frame: true,
          ...(platform === 'darwin' ? { type: 'panel' } : {}),
          titleBarStyle: 'default',
          alwaysOnTop: true,
          autoHideMenuBar: true,
          resizable: true,
          webPreferences,
        });
        floatingWindow = child;
        let saveTimer = null;
        let finalized = false;
        const scheduleSave = () => {
          if (finalized) return;
          const size = currentNormalSize(child);
          if (!size) return;
          lastKnownSize = size;
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            saveTimer = null;
            persistSize(size);
          }, SIZE_SAVE_DELAY_MS);
        };
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = null;
          const size = currentNormalSize(child) || lastKnownSize;
          if (size) {
            lastKnownSize = size;
            persistSize(size);
          }
        };
        finalizeFloatingWindow = finalize;
        child.on('resize', scheduleSave);
        child.once('close', finalize);
        child.once('closed', () => {
          finalize();
          if (floatingWindow === child) floatingWindow = null;
          if (finalizeFloatingWindow === finalize) finalizeFloatingWindow = null;
        });
        if (platform === 'darwin') {
          // Process transformation hides the whole app from the Dock.
          child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        }
        child.setAlwaysOnTop(true);
        child.setMenuBarVisibility(false);
        child.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
        child.setMaximumSize(MAX_WIDTH, MAX_HEIGHT);
        for (const eventName of ['will-navigate', 'will-redirect']) {
          child.webContents.on(eventName, event => event.preventDefault());
        }
        child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        child.show();
        child.focus();
        return child.webContents;
      },
    };
  });
}

module.exports = attachFloatingPlayerWindow;
module.exports.attachFloatingPlayerWindow = attachFloatingPlayerWindow;
