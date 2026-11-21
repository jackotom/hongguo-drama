const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-series-progress-'));

function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const handlers = {};
  const app = new EventEmitter();
  Object.assign(app, {
    getVersion: () => 'test',
    getPath: () => dir,
    commandLine: { appendSwitch() {}, hasSwitch: () => false },
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then() {} }),
  });
  const electron = {
    app,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    protocol: { registerSchemesAsPrivileged() {} },
    shell: { showItemInFolder() {}, openPath: async () => '' },
    session: { defaultSession: { setProxy: async () => {} } },
  };
  const store = {
    getSettings: () => ({ root: dir, name_format: '剧名 集数' }),
    saveTasks() {}, saveSeries() {}, saveMergeTasks() {}, saveSettings() {},
  };
  const fsPromises = { ...fsp };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './src/store' ? store
      : name === 'fs/promises' ? fsPromises : req(name),
    __dirname: path.dirname(source),
    process: { ...process, env: { ...process.env } },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  return {
    dir, handlers, context, fsPromises,
    set(name, value) {
      context.fixture = value;
      vm.runInContext(`${name} = fixture`, context);
    },
    run: code => vm.runInContext(code, context),
  };
}

function episodeTask(dir) {
  const savePath = path.join(dir, 'Short 001.mp4');
  fs.writeFileSync(savePath, Buffer.alloc(120000, 1));
  return {
    id: 'one', status: 'completed', savePath, customDir: dir,
    startTime: 1000, endTime: 2000, filename: path.basename(savePath),
    directoryIdentity: {
      directory: fs.realpathSync(dir), device: fs.lstatSync(dir).dev, ino: fs.lstatSync(dir).ino,
    },
    fileIdentity: req('./src/native/file-identity').readFileIdentity(savePath),
    hongguoInfo: {
      vid: 'one', series_id: 'S', series_title: 'Short', vid_index: 1, ep_title: '一',
    },
  };
}

function series() {
  return [{
    series_id: 'S', series_title: 'Short', cover: '',
    episodes: [{ vid: 'one', vid_index: 1, title: '一' }, { vid: 'two', vid_index: 2, title: '二' }],
  }];
}

(async () => {
  const h = fixture();
  const one = episodeTask(h.dir);
  h.set('seriesRegistry', series());
  h.set('downloadTasks', [one]);

  let readdirCalls = 0;
  const realReaddir = h.fsPromises.readdir;
  h.fsPromises.readdir = async (...args) => { readdirCalls++; return realReaddir(...args); };

  const initial = await h.handlers['get-series-progress']({});
  assert.equal(initial.progress.S.completed, 0);
  assert.equal(initial.progress.S.total, 2);
  assert.equal(initial.pending.join(','), 'S');
  assert.equal(readdirCalls, 0, 'initial badge load must not touch disk');

  const warmed = await h.handlers['warm-series-progress']({}, 'S');
  assert.equal(warmed.progress.completed, 1);
  assert.equal(warmed.progress.total, 2);
  assert.equal(readdirCalls, 1);
  const cached = await h.handlers['get-series-progress']({});
  assert.equal(cached.progress.S.completed, 1);
  assert.equal(cached.progress.S.total, 2);
  assert.equal(cached.pending.length, 0);

  const detail = await h.handlers['get-series-episodes']({}, 'S');
  assert.equal(detail.success, true);
  assert.equal(detail.data.completedCount, 1);
  assert.match(detail.data.episodes[0].fileUrl, /^hongguo-local:\/\/f\//);
  assert.equal(readdirCalls, 2, 'opening episode details must revalidate the filesystem');

  h.run('saveDownloadTasks()');
  const invalidated = await h.handlers['get-series-progress']({});
  assert.equal(invalidated.pending.join(','), 'S');

  const held = fixture();
  const heldTask = episodeTask(held.dir);
  held.set('seriesRegistry', series());
  held.set('downloadTasks', [heldTask]);
  fs.unlinkSync(heldTask.savePath);
  delete heldTask.fileIdentity;
  const releases = [];
  held.fsPromises.readdir = () => new Promise(resolve => { releases.push(resolve); });
  const pending = held.handlers['warm-series-progress']({}, 'S');
  let ticked = false;
  await new Promise(resolve => setTimeout(() => { ticked = true; resolve(); }, 20));
  assert.equal(ticked, true, 'a slow network directory must yield the main event loop');
  assert.equal(releases.length, 1, 'the scan must reach the held readdir');

  fs.writeFileSync(heldTask.savePath, Buffer.alloc(120000, 2));
  heldTask.fileIdentity = req('./src/native/file-identity').readFileIdentity(heldTask.savePath);
  held.run('saveDownloadTasks()');
  const fresh = held.handlers['get-series-episodes']({}, 'S');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(releases.length, 2, 'a task change must start a fresh scan instead of joining the stale job');
  releases.forEach(resolve => resolve([]));
  assert.equal((await pending).success, true);
  assert.equal((await fresh).data.completedCount, 1);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS series progress: cached badge snapshot, single-series warm, async detail, stale-job invalidation');
})().catch(error => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
