// Run: node scripts/check-macos.cjs. No network, GUI, or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const sourcePath = path.resolve(__dirname, '../main.js');
const localRequire = createRequire(sourcePath);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-macos-'));

function executable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
}

function load(platform = 'darwin') {
  const root = fs.mkdtempSync(path.join(temp, platform + '-'));
  const app = new EventEmitter();
  let ready, about;
  const deniedExecutables = new Set();
  const fixtureFs = Object.create(fs);
  fixtureFs.accessSync = (file, mode) => {
    if (mode === fs.constants.X_OK && deniedExecutables.has(file)) {
      throw Object.assign(new Error('Execution denied by fixture'), { code: 'EACCES' });
    }
    return fs.accessSync(file, mode);
  };
  Object.assign(app, {
    getVersion: () => require('../package.json').version, getPath: () => root,
    setAboutPanelOptions: options => { about = options; },
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true, whenReady: () => ({ then(fn) { ready = fn; } }),
    quit() {},
  });
  const windows = [];
  class View extends EventEmitter {
    constructor() { super(); this.children = []; this.bounds = { width: 1100, height: 750 }; }
    addChildView(view) { this.children.push(view); }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      Window.current = this; this.contentView = new View();
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { setWindowOpenHandler() {}, send() {}, loadFile: () => Promise.resolve(), loadURL: () => Promise.resolve(),
        isDestroyed: () => this.destroyed, setZoomFactor: value => { this.zoomFactor = value; } });
      windows.push(this);
    }
    static getAllWindows() { return windows.filter(w => !w.destroyed); }
    isDestroyed() { return this.destroyed; }
    getContentSize() { return [this.options.width, this.options.height]; }
    isMinimized() { return false; }
    setMenuBarVisibility() {}
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    close() { this.destroyed = true; this.emit('closed'); }
  }
  class WebContentsView extends View {
    constructor(options) { super(); this.options = options; this.webContents = Window.current.webContents; }
  }
  let menu;
  const electron = {
    app, BrowserWindow: Window, BaseWindow: Window, View, WebContentsView, ipcMain: { handle() {} },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    Menu: { buildFromTemplate: x => x, setApplicationMenu: x => { menu = x; } },
    dialog: { showErrorBox: (_title, message) => { throw new Error(message); } },
    session: { defaultSession: { setProxy: async () => {} } },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === 'fs' ? fixtureFs : localRequire(name),
    __dirname: root, console, Buffer, URL, Response, setTimeout, clearTimeout,
    setInterval: () => ({ unref() {} }), clearInterval() {},
    process: { platform, arch: 'arm64', resourcesPath: path.join(root, 'Resources'), env: { PATH: '' } },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { root, context, app, windows, ready: () => ready(), menu: () => menu, about: () => about, denyExecute: file => deniedExecutables.add(file) };
}

(async () => {
  const failures = [];
  async function check(name, fn) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message); }
  }
  await check('Mac finds bundled executables without .exe', () => {
    const h = load();
    const ff = executable(path.join(h.root, 'Resources/bin/ffmpeg'));
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), ff);
  });
  await check('Mac development resolves arm64 resource directory', () => {
    const h = load();
    const ff = executable(path.join(h.root, 'build/ffmpeg/darwin-arm64/ffprobe'));
    assert.equal(h.context.resolveFfmpeg('ffprobe'), ff);
  });
  await check('Missing and non-executable tools are reported unavailable', () => {
    const h = load();
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), null);
    const ff = executable(path.join(h.root, 'Resources/bin/ffmpeg'));
    // Windows does not implement POSIX executable bits; simulate the OS denial.
    h.denyExecute(ff);
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), null);
  });
  await check('PATH fallback resolves an actual file', () => {
    const h = load();
    const dir = path.join(h.root, 'tools with spaces');
    const ff = executable(path.join(dir, 'ffmpeg'));
    h.context.process.env.PATH = dir;
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), ff);
  });
  await check('Windows bundled .exe remains supported', () => {
    const h = load('win32');
    const ff = executable(path.join(h.root, 'Resources/bin/ffmpeg.exe'));
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), ff);
  });
  await check('Dock reopens main window when hidden search window exists', async () => {
    const h = load();
    await h.ready();
    const main = h.windows[0];
    assert.equal(main.zoomFactor, 1);
    h.context.getSearchWindow();
    main.close();
    h.app.emit('activate');
    assert.equal(h.windows.length, 3, 'main window must be recreated');
    h.app.emit('activate');
    assert.equal(h.windows.length, 3, 'existing main window must be reused');
    assert.ok(h.windows[2].focused);
    assert.equal(h.windows[2].zoomFactor, 1, 'reopened main window restores saved font size');
  });
  await check('Mac native menu supplies editing and quit shortcuts', async () => {
    const h = load();
    await h.ready();
    const roles = (h.menu() || []).flatMap(item => item.submenu || []).map(item => item.role);
    for (const role of ['copy', 'paste', 'selectAll', 'quit']) assert.ok(roles.includes(role), role);
  });
  await check('Mac zoom persists through activation and window recreation; failed saves preserve it', async () => {
    const h = load();
    await h.ready();
    assert.equal(h.windows[0].options.webPreferences.zoomMode, 'isolated', 'Zoom must render changes without sharing them with other windows');
    const out = h.menu().find(item => item.label === '视图').submenu.find(item => item.label === '缩小');
    assert.equal(out.accelerator, 'CmdOrCtrl+-');
    out.click();
    const dataFile = path.join(h.root, 'data.json');
    assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).settings.ui_zoom, 0.9);
    h.app.emit('activate');
    assert.equal(h.windows[0].zoomFactor, 0.9);
    h.windows[0].webContents.emit('zoom-changed', {}, 'out');
    assert.equal(h.windows[0].zoomFactor, 0.8);
    h.windows[0].close();
    const store = localRequire('./src/store');
    store.init(dataFile);
    h.app.emit('activate');
    const reopened = h.windows[1];
    assert.equal(reopened.zoomFactor, 0.8, 're-read saved zoom when recreating the main window');
    const durable = fs.readFileSync(dataFile, 'utf8');
    const saveSettings = store.saveSettings;
    const messages = [];
    reopened.webContents.send = channel => messages.push(channel);
    store.saveSettings = () => { throw new Error('synthetic disk full'); };
    try { out.click(); } finally { store.saveSettings = saveSettings; }
    assert.equal(reopened.zoomFactor, 0.8);
    assert.equal(fs.readFileSync(dataFile, 'utf8'), durable, 'failed save must preserve all settings');
    assert.ok(messages.includes('storage-error'), 'failed save must notify the user');
  });
  await check('Mac About panel displays only the public two-part version', async () => {
    const h = load();
    await h.ready();
    assert.equal(h.about()?.applicationVersion, require('../package.json').version.replace(/^(\d+\.\d+)\.0$/, '$1'));
    assert.equal(h.about()?.version, '');
  });
  assert.equal(failures.length, 0, failures.join('; '));
})().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
