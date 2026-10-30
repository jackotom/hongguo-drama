// Move the same live renderer into a native macOS panel; media sessions stay intact.
function createStealthController({ screen, getWindow, BaseWindow, View, platform = process.platform }) {
  let previous = null;
  let timer = null;
  let concealed = false;
  let panel = null;
  let contentView = null;
  let closingPanel = false;
  const send = () => {
    const main = getWindow();
    if (main && !main.isDestroyed()) main.webContents.send('stealth-state', { enabled: !!previous, concealed });
  };
  const reveal = win => { concealed = false; win.setOpacity(1); };
  const setEnabled = enabled => {
    let win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (enabled === !!previous) return;
    if (!enabled) {
      clearInterval(timer); timer = null;
      const saved = previous;
      previous = null;
      concealed = false;
      if (panel) {
        const host = panel;
        panel = null;
        host.setContentView(new View());
        win.setContentView(contentView);
        contentView = null;
        if (!closingPanel) host.close();
        win.show(); win.focus();
        win.webContents.focus();
        send();
        return;
      }
      reveal(win);
      win.setMinimumSize(...saved.minimum);
      win.setBounds(saved.bounds);
      win.setAlwaysOnTop(saved.onTop);
      win.setVisibleOnAllWorkspaces?.(saved.visibleOnAllWorkspaces, { visibleOnFullScreen: true, skipTransformProcessType: true });
      win.setFullScreenable(true);
      if (saved.maximized) win.maximize();
      send();
      return;
    }
    previous = { bounds: win.getNormalBounds(), minimum: win.getMinimumSize(), onTop: win.isAlwaysOnTop(), maximized: win.isMaximized(),
      visibleOnAllWorkspaces: typeof win.isVisibleOnAllWorkspaces === 'function' ? win.isVisibleOnAllWorkspaces() : false };
    if (platform === 'darwin') {
      try {
        panel = new BaseWindow({ type: 'panel', show: false, title: win.getTitle() });
        contentView = win.contentView;
        win.setContentView(new View());
        panel.setContentView(contentView);
      } catch (error) {
        if (contentView) win.setContentView(contentView);
        panel?.destroy(); panel = null; contentView = null; previous = null;
        throw error;
      }
      panel.on('close', () => {
        closingPanel = true;
        try { if (previous) setEnabled(false); }
        finally { closingPanel = false; }
      });
      win.hide();
      win = panel;
    }
    if (win.isMaximized()) win.unmaximize();
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const width = Math.min(400, area.width), height = Math.min(600, area.height);
    win.setMinimumSize(Math.min(300, width), Math.min(360, height));
    win.setBounds({ width, height, x: Math.max(area.x, Math.min(cursor.x - Math.round(width / 2), area.x + area.width - width)), y: Math.max(area.y, Math.min(cursor.y - 60, area.y + area.height - height)) });
    win.setAlwaysOnTop(true);
    // Keep the app's Dock identity while changing the window's workspace visibility.
    win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setFullScreenable(false);
    reveal(win);
    if (panel) { panel.show(); panel.focus(); getWindow().webContents.focus(); }
    send();
    timer = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(timer); timer = null; return; }
      const p = screen.getCursorScreenPoint(), b = win.getBounds();
      const outside = win.isMinimized() || p.x < b.x || p.x >= b.x + b.width || p.y < b.y || p.y >= b.y + b.height;
      if (outside === concealed) return;
      concealed = outside;
      // Opacity keeps the hit region available; polling restores it even when no DOM hover fires.
      win.setOpacity(concealed ? 0 : 1);
      send();
    }, 100);
    timer.unref?.();
  };
  return { setEnabled, get enabled() { return !!previous; }, dispose() {
    if (previous) setEnabled(false);
    clearInterval(timer); timer = null; previous = null; concealed = false;
    panel?.destroy(); panel = null; contentView = null;
  } };
}
module.exports = { createStealthController };
