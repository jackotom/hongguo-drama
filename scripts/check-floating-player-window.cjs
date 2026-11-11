// Offline main-process boundary regression; no user data, network or real windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TARGET = 'hongguo-floating-player';
const attachFloatingPlayerWindow = require('../src/native/floating-player-window');
assert.equal(attachFloatingPlayerWindow.name, 'attachFloatingPlayerWindow');
assert.equal(attachFloatingPlayerWindow.attachFloatingPlayerWindow, attachFloatingPlayerWindow);

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const clone = value => value === undefined ? undefined : structuredClone(value);
function makeStore(initial = {}) {
  let settings = clone(initial);
  const saves = [];
  return {
    saves,
    current: () => settings,
    getSettings: () => settings,
    saveSettings(next) {
      settings = clone(next);
      saves.push(clone(next));
    },
  };
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.maximized = false;
    this.fullScreen = false;
    this.calls = [];
    this.dockVisible = true;
    this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
    this.frameSize = { width: 0, height: 0 };
    this.normalBounds = { ...this.bounds };
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = {};
    this.webContents.getURL = () => this.url;
    this.webContents.setWindowOpenHandler = handler => { this.webContents.openHandler = handler; };
  }
  isDestroyed() { return this.destroyed; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return this.fullScreen; }
  getBounds() { return { ...this.bounds }; }
  getSize() { return { width: this.bounds.width, height: this.bounds.height }; }
  getContentBounds() { return { ...this.bounds, width: this.bounds.width - this.frameSize.width, height: this.bounds.height - this.frameSize.height }; }
  setBounds(bounds) {
    this.bounds = { ...this.bounds, ...bounds };
    this.normalBounds = { ...this.bounds };
    this.emit('resize');
  }
  setAspectRatio(value) { this.calls.push(['setAspectRatio', value]); this.aspectRatio = value; }
  getNormalBounds() { return { ...this.normalBounds }; }
  resizeTo(width, height) {
    this.bounds = { ...this.bounds, width, height };
    this.normalBounds = { ...this.bounds };
    this.emit('resize');
  }
  maximizeTo(width, height) {
    this.maximized = true;
    this.bounds = { width, height };
    this.emit('resize');
  }
  enterFullScreen(width, height) {
    this.fullScreen = true;
    this.bounds = { width, height };
    this.emit('resize');
  }
  setAlwaysOnTop(value) { this.calls.push(['setAlwaysOnTop', value]); }
  setMenuBarVisibility(value) { this.calls.push(['setMenuBarVisibility', value]); }
  setMinimumSize(width, height) { this.calls.push(['setMinimumSize', width, height]); }
  setMaximumSize(width, height) { this.calls.push(['setMaximumSize', width, height]); }
  show() { this.calls.push(['show']); }
  focus() { this.calls.push(['focus']); }
  setVisibleOnAllWorkspaces(value, options) {
    this.calls.push(['setVisibleOnAllWorkspaces', value, options]);
    if (!options?.skipTransformProcessType) this.dockVisible = !options?.visibleOnFullScreen;
  }
  close() {
    if (this.destroyed) return;
    this.emit('close');
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

const created = [];
class BrowserWindow extends FakeWindow {
  constructor(options) {
    super(options);
    created.push(this);
  }
}

const trustedUrl = 'file:///trusted/index.html';
function fixture({ store = makeStore(), platform = 'darwin', workArea = { x: -1920, y: 40, width: 1920, height: 1040 } } = {}) {
  const mainWindow = new FakeWindow({});
  mainWindow.getBounds = () => ({ x: -1700, y: 100, width: 1100, height: 750 });
  mainWindow.url = trustedUrl;
  const trustedChecks = [];
  attachFloatingPlayerWindow(mainWindow, {
    BrowserWindow,
    store,
    platform,
    screen: { getDisplayMatching(bounds) {
      assert.equal(Number.isFinite(bounds.x) && Number.isFinite(bounds.y), true);
      return { workArea };
    } },
    isTrustedUrl(url) {
      trustedChecks.push(url);
      return url === trustedUrl;
    },
  });
  const request = overrides => mainWindow.webContents.openHandler({
    url: 'about:blank',
    frameName: TARGET,
    options: {},
    ...overrides,
  });
  const open = (options = { width: 420, height: 740 }) => {
    const response = request({ options });
    assert.equal(response.action, 'allow');
    assert.equal(response.outlivesOpener, undefined, 'the opener must remain available');
    const webContents = response.createWindow(options);
    const window = created.at(-1);
    assert.equal(webContents, window.webContents);
    return window;
  };
  const sendSize = (size, overrides = {}) => mainWindow.webContents.emit('ipc-message', {
    sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame, ...overrides,
  }, 'floating-player-aspect-ratio', size);
  return { mainWindow, request, open, trustedChecks, sendSize };
}

function closeMain(mainWindow) {
  if (mainWindow.destroyed) return;
  mainWindow.destroyed = true;
  mainWindow.emit('closed');
}

(async () => {
  for (const withFloating of [false, true]) {
    const { mainWindow, open } = fixture();
    const contents = mainWindow.webContents;
    Object.defineProperty(mainWindow, 'webContents', { get() {
      if (mainWindow.destroyed) throw new TypeError('Object has been destroyed');
      return contents;
    } });
    const child = withFloating ? open() : null;
    assert.doesNotThrow(() => closeMain(mainWindow), 'closed must not read a destroyed BrowserWindow getter');
    assert.equal(contents.listenerCount('ipc-message'), 0);
    if (child) assert.equal(child.destroyed, true);
  }
  {
    const store = makeStore({ root: '/keep' });
    const { mainWindow, request, trustedChecks, open } = fixture({ store });
    for (const overrides of [
      { url: 'https://example.invalid/' },
      { url: 'about:blank#other' },
      { frameName: 'other' },
      { frameName: '' },
    ]) {
      assert.equal(request(overrides).action, 'deny');
    }
    mainWindow.url = 'https://untrusted.invalid/';
    assert.equal(request().action, 'deny');
    assert.ok(trustedChecks.includes('https://untrusted.invalid/'), 'current main URL must be checked');
    mainWindow.url = trustedUrl;

    const finalOptions = {
      width: 120,
      height: 9999,
      show: false,
      x: 99999,
      y: 99999,
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        preload: '/inherited/preload.js',
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: true,
        webSecurity: false,
        allowRunningInsecureContent: true,
        webviewTag: true,
      },
    };
    const child = open(finalOptions);
    assert.equal(child.dockVisible, true, 'opening PiP must preserve the Dock icon');
    assert.equal(child.options.type, 'panel', 'macOS PiP must cover fullscreen apps without hiding the Dock');
    assert.equal(child.options.width, 160);
    assert.equal(child.options.height, 1008);
    assert.equal(child.options.show, true, 'the player must be shown even when popup options hide it');
    assert.equal(child.options.x, -176, 'anchor to the right of the opener display work area');
    assert.equal(child.options.y, 56, 'anchor above the taskbar with a 16px margin');
    assert.equal(child.options.frame, true);
    assert.equal(child.options.titleBarStyle, 'default');
    assert.equal(child.options.alwaysOnTop, true);
    assert.equal(child.options.autoHideMenuBar, true);
    assert.equal(child.options.resizable, true);
    assert.equal(child.options.useContentSize, false, 'normal bounds must remain outer-frame dimensions');
    assert.equal(child.options.webPreferences.sandbox, true);
    assert.equal(child.options.webPreferences.contextIsolation, true);
    assert.equal(child.options.webPreferences.nodeIntegration, false);
    assert.equal(child.options.webPreferences.webSecurity, true);
    assert.equal(child.options.webPreferences.allowRunningInsecureContent, false);
    assert.equal(child.options.webPreferences.webviewTag, false);
    assert.equal(Object.hasOwn(child.options.webPreferences, 'preload'), false);
    assert.deepEqual(child.calls, [
      ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
      ['setAlwaysOnTop', true],
      ['setMenuBarVisibility', false],
      ['setMinimumSize', 1, 1],
      ['setMaximumSize', 1888, 1008],
      ['setMinimumSize', 160, 90],
      ['show'],
      ['focus'],
    ]);
    for (const eventName of ['will-navigate', 'will-redirect']) {
      let prevented = false;
      child.webContents.emit(eventName, { preventDefault() { prevented = true; } }, 'https://evil.invalid/');
      assert.equal(prevented, true, eventName);
    }
    assert.equal(child.webContents.openHandler({ url: 'about:blank', frameName: TARGET }).action, 'deny');

    child.resizeTo(500, 300);
    child.resizeTo(520, 310);
    assert.equal(store.saves.length, 0, 'resize persistence must be debounced');
    await delay(170);
    assert.equal(store.saves.length, 1, 'one settled resize writes once');
    assert.deepEqual(store.saves[0].floating_player_size, { width: 520, height: 310 });
    assert.equal(store.saves[0].root, '/keep', 'existing settings must be preserved');
    child.close();
    assert.equal(mainWindow.destroyed, false, 'child close must not close the main window');

    const reopened = open({ width: 420, height: 740 });
    assert.deepEqual(reopened.getSize(), { width: 520, height: 310 }, 'saved size must override window features');
    reopened.close();
    closeMain(mainWindow);
  }

  {
    const { mainWindow, open } = fixture({ workArea: { x: 120, y: -700, width: 900, height: 620 } });
    const child = open({ width: 900, height: 900 });
    assert.equal(child.options.width, 868);
    assert.equal(child.options.height, 588);
    assert.equal(child.options.x, 136);
    assert.equal(child.options.y, -684, 'a tall saved player must fit entirely on a smaller display');
    child.close();
    closeMain(mainWindow);
  }

  {
    const store = makeStore({ root: '/close' });
    const { mainWindow, open } = fixture({ store });
    const child = open({ width: 420, height: 740 });
    child.resizeTo(610, 340);
    assert.equal(store.saves.length, 0);
    child.close();
    assert.deepEqual(store.saves.at(-1).floating_player_size, { width: 610, height: 340 });
    const count = store.saves.length;
    await delay(170);
    assert.equal(store.saves.length, count, 'close must cancel the pending debounce write');
    closeMain(mainWindow);
  }

  {
    const store = makeStore({ root: '/parent' });
    const { mainWindow, open } = fixture({ store });
    const child = open({ width: 420, height: 740 });
    child.resizeTo(700, 400);
    assert.equal(store.saves.length, 0);
    closeMain(mainWindow);
    assert.equal(child.destroyed, true);
    assert.deepEqual(store.saves.at(-1).floating_player_size, { width: 700, height: 400 });
    await delay(170);
    assert.equal(store.saves.length, 1, 'parent destroy flush must cancel the pending write');
  }

  {
    const store = makeStore({ root: '/renderer-close' });
    const { mainWindow, open } = fixture({ store });
    const child = open();
    child.resizeTo(310, 420);
    for (const method of ['getNormalBounds', 'getBounds', 'isMaximized', 'isFullScreen']) {
      const read = child[method].bind(child);
      child[method] = () => {
        if (child.destroyed) throw new TypeError('Object has been destroyed');
        return read();
      };
    }
    assert.doesNotThrow(() => child.destroy(), 'renderer close may emit closed after native destruction');
    assert.deepEqual(store.saves.at(-1).floating_player_size, { width: 310, height: 420 });
    const reopened = open();
    assert.deepEqual(reopened.getSize(), { width: 310, height: 420 });
    reopened.close();
    closeMain(mainWindow);
  }

  for (const invalid of [
    null,
    [],
    {},
    { width: '700', height: 740 },
    { width: 700 },
    { width: NaN, height: 200 },
    { width: 0, height: 200 },
    { width: Infinity, height: 200 },
  ]) {
    const store = makeStore({ floating_player_size: invalid });
    const { mainWindow, open } = fixture({ store });
    const child = open({ width: 420, height: 740 });
    assert.deepEqual(child.getSize(), { width: 420, height: 740 }, `invalid saved size: ${String(invalid)}`);
    child.close();
    closeMain(mainWindow);
  }

  {
    const store = makeStore({ floating_player_size: { width: 100, height: 2000 } });
    const { mainWindow, open } = fixture({ store });
    const child = open({ width: 420, height: 740 });
    assert.deepEqual(child.getSize(), { width: 160, height: 1008 }, 'saved numeric size must clamp to display limits');
    child.close();
    closeMain(mainWindow);
  }

  {
    const baseStore = makeStore({ root: '/failure' });
    let failWrites = true;
    const store = {
      getSettings: baseStore.getSettings,
      saveSettings(next) {
        if (failWrites) throw new Error('disk full');
        baseStore.saveSettings(next);
      },
    };
    const { mainWindow, open } = fixture({ store });
    const child = open({ width: 420, height: 740 });
    child.resizeTo(500, 300);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await delay(170);
      assert.equal(child.destroyed, false, 'save failure must not destroy the window');
      assert.equal(warnings.length > 0, true, 'save failure must be reported');
      child.close();
      const reopened = open({ width: 420, height: 740 });
      assert.deepEqual(reopened.getSize(), { width: 500, height: 300 },
        'save failure must retain the current-process size fallback');
      failWrites = false;
      reopened.close();
    } finally {
      console.warn = originalWarn;
      closeMain(mainWindow);
    }
  }

  {
    const store = makeStore({ floating_player_size: { width: 440, height: 260 } });
    const { mainWindow, open } = fixture({ store });
    const child = open({ width: 420, height: 740 });
    assert.deepEqual(child.getSize(), { width: 440, height: 260 });
    child.resizeTo(600, 320);
    await delay(170);
    child.maximizeTo(1920, 1080);
    await delay(170);
    child.enterFullScreen(2560, 1440);
    await delay(170);
    assert.deepEqual(store.saves.at(-1).floating_player_size, { width: 600, height: 320 },
      'maximized and fullscreen bounds must not replace the normal size');
    assert.equal(store.saves.some(settings => {
      const size = settings.floating_player_size;
      return size?.width === 1920 || size?.height === 1080 || size?.width === 2560 || size?.height === 1440;
    }), false);
    child.close();
    assert.deepEqual(store.saves.at(-1).floating_player_size, { width: 600, height: 320 });
    closeMain(mainWindow);
  }

  {
    const workArea = { x: -1920, y: 40, width: 1920, height: 1040 };
    const store = makeStore();
    const { mainWindow, open, sendSize } = fixture({ store, workArea });
    const child = open();
    child.frameSize = { width: 16, height: 30 };
    const checkRatio = expected => {
      const content = child.getContentBounds();
      assert.ok(Math.abs(content.width - content.height * expected) <= 1, 'content ratio must exclude native frame');
      const bounds = child.getBounds();
      assert.ok(bounds.x >= workArea.x && bounds.y >= workArea.y);
      assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
      assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
      assert.equal(child.aspectRatio, expected);
    };
    sendSize({ width: 1080, height: 1920 });
    checkRatio(9 / 16);
    child.resizeTo(40, 80);
    checkRatio(9 / 16);
    assert.equal(child.getContentBounds().width, 160, 'portrait can shrink below old 240px minimum');
    sendSize({ width: 1920, height: 1080 });
    checkRatio(16 / 9);
    child.resizeTo(1500, 865);
    checkRatio(16 / 9);
    assert.ok(child.getContentBounds().width > 900, 'resizing is no longer capped at 900px or video resolution');
    const beforeInvalid = child.getBounds();
    for (const size of [null, [], {}, { width: '1920', height: 1080 }, { width: Infinity, height: 1080 },
      { width: -1, height: 1080 }, { width: 50000, height: 1080 }, { width: 1, height: 1920 }]) sendSize(size);
    for (const overrides of [{ sender: {} }, { senderFrame: {} }, { senderFrame: null }]) sendSize({ width: 1080, height: 1920 }, overrides);
    mainWindow.url = 'https://untrusted.invalid/';
    sendSize({ width: 1080, height: 1920 });
    mainWindow.url = trustedUrl;
    assert.deepEqual(child.getBounds(), beforeInvalid, 'invalid dimensions and foreign senders cannot resize');
    // Move to a small display, including a negative origin and a different taskbar.
    Object.assign(workArea, { x: 100, y: -600, width: 640, height: 480 });
    child.emit('moved');
    checkRatio(16 / 9);
    assert.ok(child.getBounds().width <= 608 && child.getBounds().height <= 448);
    sendSize({ width: 1080, height: 1920 });
    checkRatio(9 / 16);
    const saved = child.getSize();
    child.close();
    assert.deepEqual(store.current().floating_player_size, saved);
    const reopened = open();
    assert.deepEqual(reopened.getSize(), saved, 'ratio-adjusted outer size survives reopen');
    reopened.close();
    closeMain(mainWindow);
    assert.equal(mainWindow.webContents.listenerCount('ipc-message'), 0, 'parent close removes the narrow channel listener');
  }

  {
    const { mainWindow, open } = fixture({ platform: 'win32' });
    const child = open();
    assert.equal(
      child.calls.some(([name]) => name === 'setVisibleOnAllWorkspaces'),
      false,
      'non-darwin platforms must not call setVisibleOnAllWorkspaces',
    );
    assert.equal(child.options.type, undefined, 'native panels are macOS only');
    child.close();
    closeMain(mainWindow);
  }

  const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const protectAt = mainSource.indexOf('rendererSecurity.protectWindow(mainWindow);');
  const attachAt = mainSource.indexOf('attachFloatingPlayerWindow(mainWindow, {');
  assert.ok(protectAt >= 0, 'rendererSecurity must protect the main window');
  assert.ok(attachAt > protectAt, 'floating player wiring must follow rendererSecurity.protectWindow');
  assert.match(
    mainSource.slice(attachAt),
    /attachFloatingPlayerWindow\(mainWindow, \{\s*BrowserWindow,\s*isTrustedUrl: rendererSecurity\.isTrustedUrl,\s*store,\s*screen,/,
  );

  {
    const { mainWindow, open } = fixture();
    const child = open();
    child.frameSize = { width: 16, height: 30 };
    let deliveries = 0;
    require('./check-floating-player-host.cjs')((channel, size) => {
      mainWindow.webContents.emit('ipc-message', {
        sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame,
      }, channel, size);
      const content = child.getContentBounds();
      assert.ok(Math.abs(content.width - content.height * size.width / size.height) <= 1,
        'hook -> actual preload bridge -> trusted native listener must update content ratio');
      deliveries++;
    });
    assert.ok(deliveries >= 3, 'full bridge chain must cover both orientation changes');
    child.close();
    closeMain(mainWindow);
  }
  console.log('PASS floating player window: dynamic content ratio, frame compensation, shrink/enlarge, display bounds, IPC trust, size memory and lifecycle');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
