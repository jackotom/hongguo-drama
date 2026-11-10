const FLOATING_WINDOW_NAME = 'hongguo-floating-player';
const SIZE_SAVE_DELAY_MS = 150;
const MIN_WIDTH = 160;
const MIN_HEIGHT = 90;
const MAX_DIMENSION = 32768;
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};
const normalizeSize = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.width !== 'number' || !Number.isFinite(value.width) || value.width <= 0) return null;
  if (typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height <= 0) return null;
  return {
    width: clamp(value.width, 1, MAX_DIMENSION, MIN_WIDTH),
    height: clamp(value.height, 1, MAX_DIMENSION, MIN_HEIGHT),
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
  let updateAspectRatio = null;
  const onAspectRatio = (event, channel, size) => {
    if (channel !== 'floating-player-aspect-ratio' || !floatingWindow || floatingWindow.isDestroyed()
      || event.sender !== mainWindow.webContents || !event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame
      || !isTrustedUrl?.(mainWindow.webContents.getURL())
      || !size || typeof size !== 'object' || Array.isArray(size)
      || ![size.width, size.height].every(value => typeof value === 'number'
        && Number.isFinite(value) && value >= 1 && value <= MAX_DIMENSION)) return;
    const ratio = size.width / size.height;
    if (ratio >= 0.1 && ratio <= 10) updateAspectRatio?.(ratio);
  };
  mainWindow.webContents.on('ipc-message', onAspectRatio);

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
    mainWindow.webContents.removeListener('ipc-message', onAspectRatio);
    if (floatingWindow && !floatingWindow.isDestroyed()) {
      finalizeFloatingWindow?.();
      floatingWindow.destroy();
    }
    floatingWindow = null;
    finalizeFloatingWindow = null;
    updateAspectRatio = null;
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
          width: clamp(finalOptions.width, MIN_WIDTH, MAX_DIMENSION, 480),
          height: clamp(finalOptions.height, MIN_HEIGHT, MAX_DIMENSION, 270),
        };
        const initialSize = lastKnownSize || loadSavedSize() || requestedSize;
        const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
        const width = Math.min(initialSize.width, Math.max(1, area.width - 32));
        const height = Math.min(initialSize.height, Math.max(1, area.height - 32));
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
          minWidth: Math.min(MIN_WIDTH, width),
          minHeight: Math.min(MIN_HEIGHT, height),
          maxWidth: Math.max(1, area.width - 32),
          maxHeight: Math.max(1, area.height - 32),
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
        let aspectRatio = null;
        let adjusting = false;
        let previousBounds = child.getBounds();
        const constrain = (keepArea = false) => {
          if (finalized || adjusting || child.isDestroyed() || child.isMaximized?.() || child.isFullScreen?.()) return;
          const bounds = child.getBounds();
          const content = child.getContentBounds();
          const frame = { width: Math.max(0, bounds.width - content.width), height: Math.max(0, bounds.height - content.height) };
          const workArea = screen.getDisplayMatching(bounds).workArea;
          const maxWidth = Math.max(frame.width + 1, workArea.width - 32);
          const maxHeight = Math.max(frame.height + 1, workArea.height - 32);
          let minWidth = Math.min(MIN_WIDTH + frame.width, maxWidth);
          let minHeight = Math.min(MIN_HEIGHT + frame.height, maxHeight);
          let nextWidth = Math.min(maxWidth, Math.max(minWidth, bounds.width));
          let nextHeight = Math.min(maxHeight, Math.max(minHeight, bounds.height));
          if (aspectRatio) {
            const maxContentHeight = Math.min(maxHeight - frame.height, (maxWidth - frame.width) / aspectRatio);
            const minContentHeight = Math.min(maxContentHeight, Math.max(MIN_HEIGHT, MIN_WIDTH / aspectRatio));
            minWidth = Math.round(minContentHeight * aspectRatio) + frame.width;
            minHeight = Math.round(minContentHeight) + frame.height;
            let height = content.width / aspectRatio;
            if (keepArea) height = Math.sqrt(content.width * content.height / aspectRatio);
            else if (Math.abs(bounds.height - previousBounds.height) > Math.abs(bounds.width - previousBounds.width) / aspectRatio) height = content.height;
            height = Math.min(maxContentHeight, Math.max(minContentHeight, height));
            nextWidth = Math.round(height * aspectRatio) + frame.width;
            nextHeight = Math.round(height) + frame.height;
          }
          const next = {
            width: nextWidth, height: nextHeight,
            x: Math.round(Math.min(workArea.x + workArea.width - nextWidth, Math.max(workArea.x, bounds.x))),
            y: Math.round(Math.min(workArea.y + workArea.height - nextHeight, Math.max(workArea.y, bounds.y))),
          };
          adjusting = true;
          try {
            // Clear old constraints before changing orientation or display.
            child.setMinimumSize(1, 1);
            child.setMaximumSize(maxWidth, maxHeight);
            child.setMinimumSize(minWidth, minHeight);
            if (aspectRatio) child.setAspectRatio(aspectRatio);
            if (Object.keys(next).some(key => next[key] !== bounds[key])) child.setBounds(next);
            previousBounds = child.getBounds();
          } finally { adjusting = false; }
        };
        const scheduleSave = () => {
          if (finalized || adjusting) return;
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
          screen.removeListener?.('display-metrics-changed', onDisplayChange);
          screen.removeListener?.('display-removed', onDisplayChange);
          const size = currentNormalSize(child) || lastKnownSize;
          if (size) {
            lastKnownSize = size;
            persistSize(size);
          }
        };
        const onDisplayChange = () => { constrain(); scheduleSave(); };
        updateAspectRatio = ratio => {
          if (ratio === aspectRatio) return;
          aspectRatio = ratio;
          constrain(true);
          scheduleSave();
        };
        finalizeFloatingWindow = finalize;
        child.on('resize', () => { constrain(); scheduleSave(); });
        child.on('moved', onDisplayChange);
        child.on('leave-full-screen', onDisplayChange);
        child.on('unmaximize', onDisplayChange);
        screen.on?.('display-metrics-changed', onDisplayChange);
        screen.on?.('display-removed', onDisplayChange);
        child.once('close', finalize);
        child.once('closed', () => {
          finalize();
          if (floatingWindow === child) { floatingWindow = null; updateAspectRatio = null; }
          if (finalizeFloatingWindow === finalize) finalizeFloatingWindow = null;
        });
        if (platform === 'darwin') {
          // Process transformation hides the whole app from the Dock.
          child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        }
        child.setAlwaysOnTop(true);
        child.setMenuBarVisibility(false);
        constrain();
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
