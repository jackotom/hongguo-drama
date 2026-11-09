const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const store = require('../store');
const full = { x: 0, y: 0, width: 1, height: 1 };
const custom = { x: 0.2, y: 0.3, width: 0.5, height: 0.6 };
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-stealth-settings-'));
  const file = path.join(directory, 'state.json'); store.init(file);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handlers = {}, root = path.resolve(__dirname, '../..'), source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  let regionHelpers = {}; try { regionHelpers = require('./stealth-region'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  const context = { ...regionHelpers, store, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    require: createRequire(path.join(root, 'main.js')), path, app: { getPath: () => directory }, IS_PREVIEW: false,
    normalizeProxySettings: settings => ({ ...settings }), normalizeDownloadQuality: value => value, validateProxyDraft() {},
    applyProxyWithTimeout: async () => {}, sendToRenderer() {}, updateDownloadGeneration: 0, appUpdateInstaller: null, proxyStartupFallback: false, MAX_CONCURRENT_DOWNLOADS: 3 };
  for (const [start, end] of [['function getDefaultSettings()', '// 启动时记下'], ['function getCurrentSettings()', '// 净化文件夹'], ['const SETTINGS_KEYS =', '// ===== IPC：网络代理']]) vm.runInNewContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
  return { handlers, file, context, read: async () => JSON.parse(JSON.stringify(await handlers['get-settings']())) };
}
test('old settings return the full-window region and save through the existing IPC whitelist', async t => {
  const h = harness(t); assert.deepEqual((await h.read()).stealth_wake_region, full);
  const result = await h.handlers['save-settings']({}, { stealth_wake_region: custom, unknown: 'ignored' });
  assert.equal(result.success, true); assert.deepEqual((await h.read()).stealth_wake_region, custom);
  assert.equal(store.getSettings().unknown, undefined);
  store.init(h.file); assert.deepEqual((await h.read()).stealth_wake_region, custom);
});
test('invalid regions are rejected before persistence and corrupt saved values use the default', async t => {
  const h = harness(t);
  for (const region of [null, [], {}, { ...full, x: '0' }, { ...full, x: NaN }, { ...full, y: Infinity }, { ...full, x: -0.1 }, { ...full, width: 0.01 }, { ...full, height: 0.049 }, { ...full, x: 0.1 }, { ...full, y: 0.1 }, { ...full, extra: 1 }]) {
    const result = await h.handlers['save-settings']({}, { stealth_wake_region: region });
    assert.equal(result.success, false, JSON.stringify(region)); assert.deepEqual((await h.read()).stealth_wake_region, full);
  }
  store.saveSettings({ stealth_wake_region: { ...full, x: -1 } });
  assert.deepEqual((await h.read()).stealth_wake_region, full);
  assert.equal((await h.handlers['save-settings']({}, { stealth_wake_region: { x: 0.95, y: 0.95, width: 0.05, height: 0.05 } })).success, true);
});
test('failed durable save preserves both the active region and the on-disk preference', async t => {
  const h = harness(t); await h.handlers['save-settings']({}, { stealth_wake_region: custom });
  const previous = fs.readFileSync(h.file, 'utf8'), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === h.file) throw new Error('fixture disk full'); return rename(from, to); };
  try {
    const result = await h.handlers['save-settings']({}, { stealth_wake_region: full });
    assert.equal(result.success, false); assert.match(result.error, /disk full/);
    assert.deepEqual((await h.read()).stealth_wake_region, custom); assert.equal(fs.readFileSync(h.file, 'utf8'), previous);
  } finally { fs.renameSync = rename; }
});
