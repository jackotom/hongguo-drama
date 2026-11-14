// Storage usage and delete-all must operate on the same target set.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-storage-targets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '../main.js'), req = createRequire(source), handlers = {}, app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {}, hasSwitch: () => false }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const store = req('./src/store');
  store.init(path.join(root, 'data.json'));
  store.saveSettings({ root });
  const electron = { app, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './src/store' ? store : req(name), __dirname: path.dirname(source), process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  req('./scripts/fixtures/trusted-ipc.cjs')(context, handlers);
  return { root, store, context, handlers, run: code => vm.runInContext(code, context) };
}

test('usage counts dismissed and task-only series that delete-all removes', async t => {
  const h = fixture(t);
  const make = (id, title) => {
    const dir = path.join(h.root, id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${title}-001.mp4`);
    fs.writeFileSync(file, Buffer.alloc(220 * 1024, 1));
    return { dir, file, title };
  };
  const a = make('dismissed-a', '已移除但有视频');
  const b = make('visible-b', '可见剧');
  const c = make('task-only-c', '仅有下载任务');
  const task = (id, item) => ({ id: `task-${id}`, status: 'completed', savePath: item.file, filename: path.basename(item.file), customDir: item.dir, hongguoInfo: { series_id: id, series_title: item.title, vid: `${id}-v1`, vid_index: 1 } });
  h.context.fixture = {
    registry: [
      { series_id: 'dismissed-a', series_title: a.title, dismissed: true, episodes: [{ vid: 'dismissed-a-v1', vid_index: 1 }] },
      { series_id: 'visible-b', series_title: b.title, episodes: [{ vid: 'visible-b-v1', vid_index: 1 }] },
    ],
    tasks: [task('dismissed-a', a), task('visible-b', b), task('task-only-c', c)],
  };
  h.run('seriesRegistry = fixture.registry; downloadTasks = fixture.tasks; mergeTasks = []');
  h.run('for (const task of downloadTasks) { task.endTime = Date.now(); task.fileIdentity = readFileIdentity(task.savePath); }');

  const usage = await h.handlers['get-storage-usage']({});
  assert.equal(usage.success, true);
  assert.equal(usage.totalFiles, 3, 'usage must include dismissed and task-only files');
  assert.equal(usage.totalBytes, 3 * 220 * 1024);
  assert.equal(usage.series.length, 3);

  const deleted = await h.handlers['delete-all-downloaded']({});
  assert.equal(deleted.success, true);
  assert.equal(deleted.count, 3, 'delete-all must delete exactly the counted files');
  for (const item of [a, b, c]) assert.equal(fs.existsSync(item.file), false, item.file);

  const after = await h.handlers['get-storage-usage']({});
  assert.equal(after.totalFiles, 0);
  assert.equal(after.totalBytes, 0);
});
