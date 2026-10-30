// Offline main-process boundary regression; no user data, network or real windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const file = path.resolve(__dirname, '../main.js'), req = createRequire(file);
const handlers = {}, opened = [];
const app = new EventEmitter();
Object.assign(app, { getVersion: () => 'test', getPath: () => '/synthetic', commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
class View extends EventEmitter {
  constructor() { super(); this.children = []; this.bounds = { width: 1100, height: 750 }; }
  addChildView(view) { this.children.push(view); }
  getBounds() { return this.bounds; }
  setBounds(bounds) { this.bounds = bounds; }
}
class Window extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.bounds = { x: 100, y: 100, width: options.width, height: options.height };
    Window.current = this; this.contentView = new View();
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, { mainFrame: { url: pathToFileURL(path.join(path.dirname(file), 'dist-react/index.html')).href }, setWindowOpenHandler: fn => { this.openHandler = fn; }, send() {}, loadFile() {}, setZoomFactor: value => { this.zoomFactor = value; } });
  }
  isDestroyed() { return false; }
  getContentSize() { return [this.bounds.width, this.bounds.height]; }
  getBounds() { return { ...this.bounds }; }
  getNormalBounds() { return this.getBounds(); }
  isFullScreen() { return false; }
  isMaximized() { return false; }
  setMinimumSize() {}
  setBounds(bounds) { this.bounds = { ...bounds }; this.emit('resize'); }
  setMenuBarVisibility() {}
  loadFile() {}
}
class WebContentsView extends View {
  constructor(options) { super(); this.options = options; this.webContents = Window.current.webContents; }
}
const electron = { app, BrowserWindow: Window, BaseWindow: Window, View, WebContentsView, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, protocol: { registerSchemesAsPrivileged() {} }, shell: { openExternal: async url => { opened.push(url); } } };
const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './src/store' ? { setErrorHandler() {}, getSettings: () => ({}), saveSettings() {} } : req(name), __dirname: path.dirname(file), process, Buffer, URL, AbortController, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } });
vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
context.createWindow();
const win = vm.runInContext('mainWindow', context);
const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
const failures = [];
async function check(name, fn) { try { await fn(); } catch (error) { failures.push(`${name}: ${error.message}`); } }
(async () => {
  await check('window scaling follows native events and layout IPC', async () => {
    assert.equal(win.zoomFactor, 1);
    for (const name of ['resize', 'enter-full-screen', 'leave-full-screen', 'did-finish-load']) {
      win.bounds.width = 1470;
      win.zoomFactor = 2;
      (name === 'did-finish-load' ? win.webContents : win).emit(name);
      assert.equal(win.zoomFactor, 1, name);
    }
    assert.equal((await handlers['set-window-layout'](event, 'portrait')).success, true);
    assert.equal(win.zoomFactor, 1, 'portrait preserves font size');
    win.emit('resize');
    assert.equal(win.zoomFactor, 1, 'portrait resize keeps original scale');
    assert.equal((await handlers['set-window-layout'](event, 'landscape')).success, true);
    assert.equal(win.zoomFactor, 1, 'landscape restores bounds without changing font size');
  });
  await check('sandbox enabled', () => assert.equal(win.options.webPreferences.sandbox, true));
  if (process.platform === 'darwin') await check('Mac renderer remains in a resizable movable view', () => {
    const view = win.contentView.children[0];
    assert.equal(view.webContents, win.webContents);
    assert.equal(view.options.webPreferences.sandbox, true);
    assert.equal(view.options.webPreferences.nodeIntegration, false);
    win.contentView.bounds = { width: 400, height: 568 };
    win.contentView.emit('bounds-changed');
    assert.deepEqual({ ...view.bounds }, { x: 0, y: 0, width: 400, height: 568 });
  });
  await check('trusted page can invoke IPC', async () => assert.equal((await handlers['get-app-info'](event)).version, 'test'));
  await check('foreign window rejected', async () => assert.rejects(async () => handlers['get-app-info']({ sender: {}, senderFrame: event.senderFrame }), /窗口请求无效/));
  await check('subframe rejected', async () => assert.rejects(async () => handlers['get-app-info']({ sender: event.sender, senderFrame: { url: event.senderFrame.url } }), /窗口请求无效/));
  await check('navigated main frame rejected', async () => {
    const url = event.senderFrame.url; event.senderFrame.url = 'https://evil.invalid/';
    try { await assert.rejects(async () => handlers['get-app-info'](event), /窗口请求无效/); } finally { event.senderFrame.url = url; }
  });
  await check('other file rejected', async () => {
    const url = event.senderFrame.url; event.senderFrame.url = 'file:///tmp/hostile.html';
    try { await assert.rejects(async () => handlers['get-app-info'](event), /窗口请求无效/); } finally { event.senderFrame.url = url; }
  });
  await check('hash routing remains trusted', async () => {
    const url = event.senderFrame.url; event.senderFrame.url += '#/settings';
    try { assert.equal((await handlers['get-app-info'](event)).version, 'test'); } finally { event.senderFrame.url = url; }
  });
  await check('remote navigation and redirects denied', () => {
    for (const name of ['will-navigate', 'will-redirect']) {
      let prevented = false;
      win.webContents.emit(name, { preventDefault() { prevented = true; } }, 'https://evil.invalid/');
      assert.equal(prevented, true, name);
    }
    assert.equal(win.openHandler?.({ url: 'https://evil.invalid/' }).action, 'deny');
  });
  await check('external links remain limited to web schemes; email is copied inside the app', async () => {
    for (const url of ['file:///tmp/hostile', 'javascript:alert(1)', 'custom-app:run', 'https://user:secret@example.com/',
      'mailto:other@example.com', 'mailto:jaoktom@outlook.com', 'mailto:jaoktom@outlook.com?attach=/private/file', 'mailto:jaoktom@outlook.com?body=test']) {
      assert.equal((await handlers['open-external-url'](event, url)).success, false, url);
    }
    assert.equal(opened.length, 0);
    assert.equal((await handlers['open-external-url'](event, 'https://example.com/')).success, true);
  });
  await check('production CSP denies inline and eval scripts', () => {
    const html = fs.readFileSync(path.join(path.dirname(file), 'index.html'), 'utf8');
    const policy = /script-src ([^;]+)/.exec(html)[1];
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
    assert.match(html, /style-src 'self' 'unsafe-inline'/);
  });
  await check('URL trust is exact for files and scoped for development', () => {
    const { createRendererSecurity } = req('./src/native/renderer-security');
    const security = createRendererSecurity(path.join(path.dirname(file), 'dist-react/index.html'), 'http://localhost:5173');
    assert.equal(security.isTrustedUrl(event.senderFrame.url + '?arbitrary=1'), false);
    assert.equal(security.isTrustedUrl('http://localhost:5173/settings#player'), true);
    assert.equal(security.isTrustedUrl('http://localhost:5174/'), false);
    assert.equal(security.isTrustedUrl('http://localhost:5173.evil.invalid/'), false);
    assert.equal(security.isTrustedUrl('http://user:pass@localhost:5173/'), false);
    assert.equal(security.isTrustedSender({}, win), false);
    assert.equal(security.isTrustedSender(event, { isDestroyed: () => true }), false);
  });
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log('PASS renderer security: sandbox, trusted IPC/frame/page, navigation/popups, external schemes and production CSP');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
