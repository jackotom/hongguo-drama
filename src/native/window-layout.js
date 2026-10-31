// Keep the complete window inside the current display, including after unplugging a monitor.
function fitWindowBounds(mode, current, workArea, previous) {
  if (!['portrait', 'landscape'].includes(mode)) throw new Error('Invalid window layout');
  const height = Math.min(mode === 'portrait' ? 940 : (previous?.height || 750), workArea.height);
  const width = Math.min(mode === 'portrait' ? Math.min(620, Math.round(height * 0.74)) : (previous?.width || 1100), workArea.width);
  const origin = mode === 'landscape' && previous ? previous : {
    x: Math.round(current.x + (current.width - width) / 2),
    y: Math.round(current.y + (current.height - height) / 2),
  };
  return {
    x: Math.max(workArea.x, Math.min(origin.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(origin.y, workArea.y + workArea.height - height)),
    width, height,
  };
}
// Window resizing changes available space, never the user's chosen text size.
function getWindowScale(value = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
}
function saveWindowZoom(store, direction) {
  if (!['in', 'out', 'reset'].includes(direction)) throw new Error('Invalid zoom direction');
  const settings = store.getSettings() || {};
  const current = getWindowScale(settings.ui_zoom);
  const next = direction === 'reset' ? 1 : Math.round((current + (direction === 'in' ? 0.1 : -0.1)) * 10) / 10;
  store.saveSettings({ ...settings, ui_zoom: getWindowScale(next) });
}
const validBounds = bounds => bounds && ['x', 'y', 'width', 'height'].every(key =>
  Number.isSafeInteger(bounds[key]) && Math.abs(bounds[key]) <= 2147483647)
  && bounds.width > 0 && bounds.height > 0;

function restoreMainWindowBounds(store, screen) {
  try {
    const saved = store.getSettings()?.main_window_state;
    if (!validBounds(saved?.bounds)) return {};
    const display = screen.getAllDisplays().find(item => item.id === saved.displayId);
    if (!display) return {};
    const bounds = fitWindowBounds('landscape', saved.bounds, display.workArea, {
      width: Math.max(900, saved.bounds.width), height: Math.max(620, saved.bounds.height),
      x: saved.bounds.x, y: saved.bounds.y,
    });
    return { ...bounds,
      ...(bounds.width < 900 ? { minWidth: bounds.width } : {}),
      ...(bounds.height < 620 ? { minHeight: bounds.height } : {}),
    };
  } catch (_) { return {}; }
}

function rememberMainWindowBounds(win, { store, screen, isNormal }) {
  let lastNormal = null;
  let enteringFullScreen = false;
  const capture = () => {
    if (win.isDestroyed() || enteringFullScreen || !isNormal()
      || win.isFullScreen?.() || win.isMinimized?.() || win.isVisible?.() === false) return;
    // macOS emits intermediate resize events before maximize; its final normal bounds undo those frames.
    const bounds = win.isMaximized?.() ? win.getNormalBounds?.() : win.getBounds?.();
    if (!validBounds(bounds)) return;
    const display = screen.getDisplayMatching(bounds);
    if (!Number.isSafeInteger(display.id)) return;
    lastNormal = { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, displayId: display.id };
  };
  capture();
  win.on('move', capture);
  win.on('resize', capture);
  win.on('maximize', capture);
  win.on('will-enter-full-screen', () => { capture(); enteringFullScreen = true; });
  win.on('leave-full-screen', () => { enteringFullScreen = false; capture(); });
  // shortcut: persist on close; add debounced writes if crash/force-quit recovery is required.
  win.on('close', () => {
    capture();
    if (!lastNormal) return;
    try {
      const settings = store.getSettings();
      if (JSON.stringify(settings.main_window_state) !== JSON.stringify(lastNormal)) {
        store.saveSettings({ ...settings, main_window_state: lastNormal });
      }
    } catch (_) { /* The store reports storage errors; window memory must not block closing. */ }
  });
}

module.exports = { fitWindowBounds, getWindowScale, saveWindowZoom, restoreMainWindowBounds, rememberMainWindowBounds };
