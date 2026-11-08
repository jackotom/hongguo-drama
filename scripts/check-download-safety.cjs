// Offline behavioral checks. All files live in a disposable directory; no app data/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-safety-'));
let serial = 0, failures = 0;
function load(settings = {}, overrides = {}, env = process.env, options = {}) {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  const handlers = {}, app = new EventEmitter(), opened = [], proxyCalls = [];
  let stored = { root: dir, ...settings };
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = {
    app, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} },
    shell: { showItemInFolder: target => { opened.push(target); }, openPath: async target => { opened.push(`open:${target}`); return ''; } },
    session: { defaultSession: { setProxy: async options => { proxyCalls.push(options); } } },
  };
  const store = { getSettings: () => ({ ...stored }), saveTasks() { if (options.failSaveTasks) throw new Error('disk full'); }, saveSeries() {}, saveMergeTasks() {}, saveSettings(next) { stored = { ...next }; } };
  const context = vm.createContext({ require: name => overrides[name] || (name === 'electron' ? electron : name === './src/store' ? store : req(name)), __dirname: path.dirname(source), process: { ...process, env: { ...env } }, console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  const pump = context.pumpQueue;
  context.pumpQueue = () => {}; // Inspect queued destinations without fetching media.
  context.processDownloadQueue = () => {};
  return { app, context, handlers, dir, pump, opened, proxyCalls, settings: () => stored, run: code => vm.runInContext(code, context), set(name, value) { context.fixture = value; vm.runInContext(`${name} = fixture`, context); } };
}
function task(id, dir, status = 'completed', filename = `${id}.mp4`, index = 1) {
  return { id, type: 'hongguo', status, filename, savePath: path.join(dir, filename), customDir: dir, hongguoInfo: { vid: id, series_id: 'S', series_title: 'Short', vid_index: index } };
}
function series() { return [{ series_id: 'S', series_title: 'Short', episodes: [{ vid: 'one', vid_index: 1 }, { vid: 'two', vid_index: 2 }] }]; }
function file(p) { fs.writeFileSync(p, Buffer.alloc(120000)); }
async function check(name, run) { try { await run(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); } }
(async () => {
  await check('NAS deletion rejects a changed mount and retains the task and foreign file', async () => {
    for (const channel of ['delete-task', 'delete-tasks', 'delete-series-files', 'delete-all-downloaded', 'delete-episode-file']) {
      const h = load(); h.set('seriesRegistry', series());
      const one = task('one', h.dir); file(one.savePath);
      one.nasDestination = { root: fs.realpathSync(h.dir), directory: fs.realpathSync(h.dir), flat: true,
        device: fs.statSync(h.dir).dev + 1, seriesId: 'S', title: 'Short', season: 1 };
      h.set('downloadTasks', [one]);
      const args = channel === 'delete-task' ? ['one', { deleteFiles: true }]
        : channel === 'delete-tasks' ? [['one'], { deleteFiles: true }]
        : channel === 'delete-episode-file' ? ['S', 1] : ['S'];
      const result = await h.handlers[channel]({}, ...args);
      assert.equal(result.success, false, channel);
      assert.equal(fs.existsSync(one.savePath), true, channel + ' must preserve a foreign mount file');
      assert.equal(h.run('downloadTasks.length'), 1, channel + ' must retain its task');
    }
  });
  await check('ordinary download records retain directory identity and reject replacement mounts', async () => {
    const queued = load(); queued.set('seriesRegistry', series());
    const submitted = await queued.handlers['hongguo-download-batch']({}, { seriesId:'S', seriesTitle:'Short', episodes:series()[0].episodes, quality:'auto' });
    assert.equal(submitted.success, true);
    const recorded = queued.run('downloadTasks[0].directoryIdentity');
    assert.equal(fs.realpathSync(recorded.directory), recorded.directory);
    assert.equal(recorded.device, fs.statSync(recorded.directory).dev);
    for (const channel of ['delete-task', 'delete-tasks', 'delete-series-files', 'delete-all-downloaded', 'delete-episode-file']) {
      const h = load(); h.set('seriesRegistry', series());
      const one = task('one', h.dir); file(one.savePath);
      one.directoryIdentity = { directory:fs.realpathSync(h.dir), device:fs.statSync(h.dir).dev+1 };
      h.set('downloadTasks',[one]);
      const args = channel === 'delete-task' ? ['one',{deleteFiles:true}] : channel === 'delete-tasks' ? [['one'],{deleteFiles:true}]
        : channel === 'delete-episode-file' ? ['S',1] : ['S'];
      const result = await h.handlers[channel]({},...args);
      assert.equal(result.success,false,channel);
      assert.equal(fs.existsSync(one.savePath),true,channel);
      assert.equal(h.run('downloadTasks.length'),1,channel);
    }
  });
  await check('queued ordinary downloads refuse a changed directory before resolving media', async () => {
    let lookedUp = 0;
    const h = load({}, {'./src/native/hongguo':{fetchPlayUrlSingle:async()=>{lookedUp++;throw Error('unexpected source lookup');}}});
    const one = task('one',h.dir,'pending');
    one.directoryIdentity={directory:fs.realpathSync(h.dir),device:fs.statSync(h.dir).dev+1};
    h.set('downloadTasks',[one]);
    await h.context.executeHongguoDownload(one);
    assert.equal(one.status,'failed');assert.equal(lookedUp,0);assert.equal(fs.existsSync(one.savePath),false);
  });
  await check('deleting downloads preserves active online sessions and cached episodes', async () => {
    for (const channel of ['delete-series-files', 'delete-all-downloaded']) {
      const h = load(); h.set('seriesRegistry', series());
      const one = task('one', h.dir); file(one.savePath); h.set('downloadTasks', [one]);
      const controller = new AbortController(); h.context.fixtureController = controller;
      h.run("onlineCache.set('cached', { seriesId: 'S', size: 16, buffer: Buffer.alloc(16) }); onlineSessions.set('playing', { requests: new Set([fixtureController]) })");
      const result = await h.handlers[channel]({}, 'S');
      assert.equal(result.success, true);
      assert.equal(fs.existsSync(one.savePath), false);
      assert.equal(h.run('onlineSessions.size'), 1, channel);
      assert.equal(controller.signal.aborted, false, channel);
      assert.equal(h.run('onlineCache.size'), 1, channel);
    }
  });
  await check('all deletion entry points count only successfully removed bytes', async () => {
    for (const channel of ['delete-series-files', 'delete-all-downloaded', 'delete-episode-file']) {
      let blocked;
      const fakeFs = Object.create(fs);
      fakeFs.unlinkSync = p => { if (p === blocked) throw Object.assign(new Error('locked fixture'), { code: 'EBUSY' }); fs.unlinkSync(p); };
      const h = load({}, { fs: fakeFs }); h.set('seriesRegistry', series());
      const one = task('one', h.dir), two = task('two', h.dir, 'completed', 'two.mp4', 2);
      file(one.savePath); file(two.savePath); blocked = one.savePath; h.set('downloadTasks', [one, two]);
      const result = await h.handlers[channel]({}, 'S', 1);
      assert.equal(result.success, false); assert.equal(result.failed, 1);
      assert.equal(result.freed, channel === 'delete-episode-file' ? 0 : 120000, channel);
      assert.equal(fs.existsSync(one.savePath), true);
      assert.equal(h.run('downloadTasks.some(t => t.id === "one")'), true);
    }
  });
  await check('series cleanup removes owned temporary files and empty directories but protects active downloads', async () => {
    for (const channel of ['delete-series-files', 'delete-all-downloaded']) {
      const h = load(); h.set('seriesRegistry', series());
      const dir = h.context.seriesDownloadDir(h.dir, 'S', 'Short'); fs.mkdirSync(dir, { recursive: true });
      const one = path.join(dir, 'Short 001.mp4');
      for (const suffix of ['.enc.tmp', '.enc.tmp.decoded']) file(one + suffix);
      file(path.join(dir, 'Short.ffconcat.txt'));
      const active = task('two', dir, 'downloading', 'Short 002.mp4', 2);
      file(active.savePath + '.enc.tmp'); h.set('downloadTasks', [active]);
      const result = await h.handlers[channel]({}, 'S');
      assert.equal(result.success, true); assert.equal(result.count, 3); assert.equal(result.freed, 360000);
      assert.equal(fs.existsSync(one + '.enc.tmp'), false);
      assert.equal(fs.existsSync(one + '.enc.tmp.decoded'), false);
      assert.equal(fs.existsSync(active.savePath + '.enc.tmp'), true);
      h.set('downloadTasks', []);
      const last = await h.handlers[channel]({}, 'S');
      assert.equal(last.success, true); assert.equal(last.freed, 120000);
      assert.equal(fs.existsSync(dir), false, 'empty series directory should be removed');
    }
  });
  await check('failed temporary cleanup reports failure without counting its bytes', async () => {
    let blocked;
    const fakeFs = Object.create(fs);
    fakeFs.unlinkSync = p => { if (p === blocked) throw Object.assign(new Error('locked fixture'), { code: 'EBUSY' }); fs.unlinkSync(p); };
    const h = load({}, { fs: fakeFs }); h.set('seriesRegistry', series());
    const one = task('one', h.dir); file(one.savePath); blocked = one.savePath + '.enc.tmp'; file(blocked);
    h.set('downloadTasks', [one]);
    const result = await h.handlers['delete-series-files']({}, 'S');
    assert.equal(result.success, false); assert.equal(result.failed, 1); assert.equal(result.freed, 120000);
    assert.equal(fs.existsSync(blocked), true);
  });
  await check('temporary cleanup preserves files registered to another series in a shared directory', async () => {
    const h = load(); h.set('seriesRegistry', series());
    const dir = h.context.seriesDownloadDir(h.dir, 'S', 'Short'); fs.mkdirSync(dir, { recursive: true });
    const other = task('foreign', dir, 'stopped', 'Short 001.mp4'); other.hongguoInfo.series_id = 'OTHER';
    h.set('downloadTasks', [other]);
    file(other.savePath + '.enc.tmp'); file(path.join(dir, 'unknown.mp4.enc.tmp'));
    const result = await h.handlers['delete-series-files']({}, 'S');
    assert.equal(result.success, true); assert.equal(result.count, 0);
    assert.equal(fs.existsSync(other.savePath + '.enc.tmp'), true);
    assert.equal(fs.existsSync(path.join(dir, 'unknown.mp4.enc.tmp')), true);
  });
  await check('shared directory cleanup preserves foreign merges and concat, including conflicting registrations', async () => {
    for (const sharedBy of ['download', 'merge']) {
      const h = load(); h.set('seriesRegistry', series());
      const own = task('one', h.dir); file(own.savePath);
      const foreign = task('foreign', h.dir, 'completed', 'Other 001.mp4'); foreign.hongguoInfo.series_id = 'OTHER';
      const kept = ['Other 合集.mp4', 'Other.ffconcat.txt', 'Short 合集.mp4', 'Short.ffconcat.txt', 'conflict.mp4'].map(name => path.join(h.dir, name));
      kept.forEach(file);
      const ownedMerge = path.join(h.dir, 'my-custom-export.mp4'); file(ownedMerge);
      h.set('downloadTasks', sharedBy === 'download' ? [own, foreign] : [own]);
      h.set('mergeTasks', [{ seriesId: 'S', output: ownedMerge, status: 'completed' }, { seriesId: 'OTHER', output: kept[0], status: 'completed' }, { seriesId: 'S', output: kept[4], status: 'completed' }, { seriesId: 'OTHER', output: kept[4], status: 'completed' }]);
      const result = await h.handlers['delete-series-files']({}, 'S');
      assert.equal(result.success, true); assert.equal(result.count, 2); assert.equal(result.freed, 240000);
      assert.equal(fs.existsSync(ownedMerge), false);
      for (const filename of kept) assert.equal(fs.existsSync(filename), true, filename);
    }
  });
  await check('includeMerged false preserves both merge outputs and historical concat', async () => {
    const h = load(); h.set('seriesRegistry', series());
    const own = task('one', h.dir); file(own.savePath); h.set('downloadTasks', [own]);
    const kept = ['Short_合集.mp4', 'Short.ffconcat.txt', 'export 009.mp4'].map(name => path.join(h.dir, name)); kept.forEach(file);
    h.set('mergeTasks', [{ seriesId: 'S', output: kept[2], status: 'completed' }]);
    const result = await h.handlers['delete-series-files']({}, 'S', { includeMerged: false });
    assert.equal(result.count, 1); for (const filename of kept) assert.equal(fs.existsSync(filename), true, filename);
  });
  await check('unregistered cleanup matches only this title and default duplicate merge names', async () => {
    const h = load(); h.set('seriesRegistry', series());
    const own = task('one', h.dir); file(own.savePath); h.set('downloadTasks', [own]);
    const removed = ['Short_合集.mp4', 'Short_合集 (2).mp4', 'Short 合集.mp4', 'Short.ffconcat.txt'].map(name => path.join(h.dir, name)); removed.forEach(file);
    const kept = ['Other 合集.mp4', 'Other.ffconcat.txt', 'Short story 合集.mp4'].map(name => path.join(h.dir, name)); kept.forEach(file);
    const result = await h.handlers['delete-series-files']({}, 'S');
    assert.equal(result.count, 5); for (const filename of kept) assert.equal(fs.existsSync(filename), true, filename);
    for (const filename of removed) assert.equal(fs.existsSync(filename), false, filename);
  });
  await check('record persistence failure preserves deleted stats and in-memory task records', async () => {
    for (const channel of ['delete-series-files', 'delete-all-downloaded', 'delete-episode-file']) {
      let disk = [], rejectSave = true;
      const store = { getSettings: () => ({}), saveTasks: rows => { if (rejectSave) throw new Error('fixture storage full'); disk = structuredClone(rows); } };
      const h = load({}, { './src/store': store }); h.set('seriesRegistry', series());
      const own = task('one', h.dir); file(own.savePath); h.set('downloadTasks', [own]); disk = structuredClone([own]);
      const result = await h.handlers[channel]({}, 'S', 1);
      assert.equal(result.success, false); assert.equal(result.count, 1); assert.equal(result.freed, 120000); assert.equal(result.failed, 0, channel);
      assert.match(result.error, /记录.*保存/); assert.equal(fs.existsSync(own.savePath), false);
      assert.equal(JSON.stringify(h.run('downloadTasks')), JSON.stringify(disk), 'failed persistence must restore memory');
      rejectSave = false;
      const retried = await h.handlers[channel]({}, 'S', 1);
      assert.equal(retried.success, true); assert.equal(retried.count, 0); assert.equal(retried.freed, 0);
      assert.equal(disk.length, 0); assert.equal(h.run('downloadTasks.length'), 0);
    }
  });
  for (const channel of ['delete-task', 'delete-tasks']) for (const deleteFiles of [true, false]) {
    await check(`${channel} restores records on save failure with deleteFiles=${deleteFiles}`, async () => {
      let disk, rejectSave = true;
      const store = { getSettings: () => ({}), saveTasks: rows => { if (rejectSave) throw new Error('fixture storage full'); disk = structuredClone(rows); } };
      const h = load({}, { './src/store': store });
      const own = task('one', h.dir); file(own.savePath); file(own.savePath + '.enc.tmp');
      h.set('downloadTasks', [own]); disk = structuredClone([own]);
      const target = channel === 'delete-task' ? 'one' : ['one'];
      const result = await h.handlers[channel]({}, target, { deleteFiles });
      assert.equal(result.success, false); assert.equal(result.count, 0); assert.equal(result.failed, 0);
      assert.equal(result.fileCount, deleteFiles ? 2 : 0); assert.equal(result.freed, deleteFiles ? 240000 : 0);
      assert.match(result.error, /记录.*保存/); assert.equal(JSON.stringify(h.run('downloadTasks')), JSON.stringify(disk));
      assert.equal(fs.existsSync(own.savePath), !deleteFiles);
      rejectSave = false;
      const retry = await h.handlers[channel]({}, target, { deleteFiles });
      assert.equal(retry.success, true); assert.equal(retry.count, 1); assert.equal(retry.fileCount, 0); assert.equal(retry.freed, 0);
      assert.equal(disk.length, 0); assert.equal(h.run('downloadTasks.length'), 0);
    });
  }
  await check('failed task-record deletion preserves concurrent additions and state changes during cancellation', async () => {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const store = { getSettings: () => ({}), saveTasks: () => { throw new Error('fixture storage full'); } };
    const h = load({}, { './src/store': store });
    const active = task('one', h.dir, 'downloading'), other = task('two', h.dir, 'pending');
    h.set('downloadTasks', [active, other]); h.set('downloadQueue', [other]);
    h.context.stopTaskAndWait = async item => { item.status = 'stopped'; await wait; };
    const pending = h.handlers['delete-tasks']({}, ['one'], { deleteFiles: false });
    const added = task('added', h.dir, 'pending'); h.context.added = added;
    h.run('downloadTasks.push(added); downloadQueue.push(added); downloadTasks.find(t => t.id === "two").status = "downloading"');
    release();
    const result = await pending;
    assert.equal(result.success, false); assert.equal(result.count, 0);
    assert.equal(h.run('downloadTasks.length'), 3); assert.equal(h.run('downloadTasks.find(t => t.id === "two").status'), 'downloading');
    assert.equal(h.run('downloadQueue.some(t => t.id === "added")'), true); assert.equal(h.run('downloadTasks.find(t => t.id === "one").status'), 'stopped');
  });
  await check('shared directory ownership agrees across storage, record cleanup, listing, purge, merge and delete', async () => {
    let mergedInputs;
    const h = load({}, { './src/native/merge-runner': { runMerge: async ({ task, ordered }) => { mergedInputs = ordered.map(item => item.path); task.status = 'completed'; } } });
    h.set('seriesRegistry', [...series(), { series_id: 'OTHER', series_title: 'Other', episodes: [{ vid_index: 1 }] }]);
    const dir = h.context.seriesDownloadDir(h.dir, 'S', 'Short'); fs.mkdirSync(dir, { recursive: true });
    const own = task('one', dir, 'completed', 'Short 001.mp4'); file(own.savePath);
    const foreign = task('foreign', dir, 'completed', 'Other 001.mp4'); foreign.hongguoInfo.series_id = 'OTHER'; foreign.hongguoInfo.series_title = 'Other'; file(foreign.savePath);
    const ownMerge = path.join(dir, 'custom export 009.mp4'), foreignMerge = path.join(dir, 'Other 合集.mp4'); file(ownMerge); fs.writeFileSync(foreignMerge, Buffer.alloc(240000));
    h.set('downloadTasks', [own, foreign]); h.set('mergeTasks', [{ seriesId: 'S', output: ownMerge, status: 'completed' }, { seriesId: 'OTHER', output: foreignMerge, status: 'completed' }]);
    const usage = () => h.handlers['get-storage-usage']({});
    const before = (await usage()).series.find(row => row.series_id === 'S');
    assert.equal(before.files, 2); assert.equal(before.bytes, 240000); assert.equal(before.merged, 1);
    assert.equal((await h.handlers['delete-task']({}, 'one', { deleteFiles: false })).success, true);
    assert.equal((await h.handlers['get-series-list']({}, { downloadedOnly: true })).some(row => row.series_id === 'S'), true);
    assert.equal((await h.handlers['purge-empty-series']({})).count, 0);
    h.context.resolveFfmpeg = () => '/fixture/ffmpeg';
    const merge = await h.handlers['merge-series']({}, 'S');
    assert.equal(merge.success, true, merge.error); assert.equal(JSON.stringify(mergedInputs), JSON.stringify([own.savePath]));
    const removed = await h.handlers['delete-series-files']({}, 'S');
    assert.equal(removed.success, true, removed.error); assert.equal(removed.count, 2);
    assert.equal(fs.existsSync(foreign.savePath), true); assert.equal(fs.existsSync(foreignMerge), true);
    const after = (await usage()).series.find(row => row.series_id === 'S'); assert.equal(after.files, 0); assert.equal(after.bytes, 0);
  });
  await check('shared directory unregistered same-title episodes remain ambiguous and preserved', async () => {
    const h = load(); const entries = series(); entries.push({ ...entries[0], series_id: 'OTHER' }); h.set('seriesRegistry', entries);
    const dir = h.context.seriesDownloadDir(h.dir, 'S', 'Short'); fs.mkdirSync(dir, { recursive: true });
    const ambiguous = path.join(dir, 'Short 001.mp4'); file(ambiguous);
    const foreign = task('other', dir, 'completed', 'foreign.mp4'); foreign.hongguoInfo.series_id = 'OTHER'; h.set('downloadTasks', [foreign]);
    assert.equal(h.context.collectSeriesEpisodeFiles('S', 'Short').ordered.length, 0);
    assert.equal((await h.handlers['delete-series-files']({}, 'S')).count, 0); assert.equal(fs.existsSync(ambiguous), true);
  });
  await check('delete-all reports skipped running merges for all-skipped and mixed results', async () => {
    for (const mixed of [false, true]) {
      const h = load(); h.set('seriesRegistry', series());
      const protectedTask = task('one', h.dir); file(protectedTask.savePath);
      const extra = task('other', h.dir, 'completed', 'Other 001.mp4'); extra.hongguoInfo.series_id = 'OTHER'; file(extra.savePath);
      h.set('downloadTasks', mixed ? [protectedTask, extra] : [protectedTask]);
      h.set('mergeTasks', [{ seriesId: 'S', status: 'running' }]);
      const result = await h.handlers['delete-all-downloaded']({});
      assert.equal(result.success, true); assert.equal(result.skipped, 1); assert.match(result.warning, /1.*合并.*跳过/);
      assert.equal(result.count, mixed ? 1 : 0); assert.equal(result.failed, 0); assert.equal(result.freed, mixed ? 120000 : 0);
      assert.equal(fs.existsSync(protectedTask.savePath), true); assert.equal(h.run('downloadTasks.some(t => t.id === "one")'), true);
    }
  });
  await check('task deletion cancels scheduled source retries even when record persistence fails', async () => {
    for (const channel of ['delete-task', 'delete-tasks']) for (const rejectSave of [false, true]) {
      const store = { getSettings: () => ({}), saveTasks: () => { if (rejectSave) throw new Error('fixture storage full'); } };
      const h = load({}, { './src/store': store });
      const retry = { ...task('retry', h.dir, 'failed'), retryAt: Date.now() + 60000, sourceRetries: 1 };
      h.set('downloadTasks', [retry]); h.context.armSourceRetry(retry);
      try {
        const result = await h.handlers[channel]({}, channel === 'delete-task' ? 'retry' : ['retry'], { deleteFiles: false });
        assert.equal(result.success, !rejectSave); assert.equal(h.run('sourceRetryTimers.size'), 0);
        assert.equal(retry.retryAt, undefined); assert.equal(retry.sourceRetries, undefined);
        if (rejectSave) assert.equal(h.run('downloadTasks.length'), 1);
      } finally { h.context.clearSourceRetry(retry); }
    }
  });
  await check('retry and resume roll back task state when queue persistence fails', async () => {
    for (const channel of ['retry-task', 'retry-tasks', 'resume-all']) {
      const h = load({}, {}, process.env, { failSaveTasks: true });
      const one = task('one', h.dir, 'failed');
      h.set('downloadTasks', [one]); h.set('downloadQueue', []);
      const result = channel === 'retry-task' ? await h.handlers[channel]({}, 'one')
        : channel === 'retry-tasks' ? await h.handlers[channel]({}, ['one']) : await h.handlers[channel]({});
      assert.equal(result.success, false, channel);
      assert.equal(h.run('downloadTasks[0].status'), 'failed', `${channel} must restore status`);
      assert.equal(h.run('downloadQueue.length'), 0, `${channel} must not leave a ghost queue entry`);
    }
  });
  await check('shared directory ignores unregistered episode names from templates without the series title', async () => {
    for (const name_format of ['集数', '标题', '{vid_index}']) {
      const h = load({ name_format }), entries = series(); entries[0].episodes[0].title = 'Shared'; h.set('seriesRegistry', entries);
      const dir = h.context.seriesDownloadDir(h.dir, 'S', 'Short'); fs.mkdirSync(dir, { recursive: true });
      const ambiguous = path.join(dir, h.context.uniqueEpisodeFilename({ name_format }, 'Short', entries[0].episodes[0])); file(ambiguous);
      const foreign = task('other', dir, 'completed', 'Other 009.mp4'); foreign.hongguoInfo.series_id = 'OTHER'; foreign.hongguoInfo.series_title = 'Other'; h.set('downloadTasks', [foreign]);
      assert.equal(h.context.collectSeriesEpisodeFiles('S', 'Short').ordered.length, 0, name_format);
      const usage = (await h.handlers['get-storage-usage']({})).series.find(item => item.series_id === 'S'); assert.equal(usage.files, 0, name_format);
      assert.equal((await h.handlers['delete-series-files']({}, 'S')).count, 0, name_format); assert.equal(fs.existsSync(ambiguous), true);
    }
  });
  await check('cross-series registrations sharing both path and vid remain unowned for scan and deletion', async () => {
    const h = load(); h.set('seriesRegistry', series());
    const own = task('one', h.dir), foreign = { ...own, id: 'foreign', hongguoInfo: { ...own.hongguoInfo, series_id: 'OTHER' } }; file(own.savePath); h.set('downloadTasks', [own, foreign]);
    assert.equal(h.context.collectSeriesEpisodeFiles('S', 'Short').ordered.length, 0);
    assert.equal((await h.handlers['get-storage-usage']({})).series.find(item => item.series_id === 'S').files, 0);
    assert.equal((await h.handlers['delete-series-files']({}, 'S')).count, 0); assert.equal(fs.existsSync(own.savePath), true);
  });
  await check('task deletion preserves shared, active and merged file families', async () => {
    for (const channel of ['delete-task', 'delete-tasks']) for (const conflict of ['cross-series', 'same-series', 'active', 'merge', 'temporary']) {
      const h = load(), own = task('one', h.dir), other = { ...own, id: 'other', hongguoInfo: { ...own.hongguoInfo, series_id: conflict === 'same-series' ? 'S' : 'OTHER', vid_index: 2 } };
      const family = [own.savePath, own.savePath + '.enc.tmp', own.savePath + '.enc.tmp.decoded']; family.forEach(file);
      if (conflict === 'active') other.status = 'downloading';
      if (conflict === 'temporary') other.savePath += '.enc.tmp';
      h.set('downloadTasks', conflict === 'merge' ? [own] : [own, other]);
      if (conflict === 'merge') h.set('mergeTasks', [{ seriesId: 'OTHER', status: 'completed', output: own.savePath }]);
      const result = await h.handlers[channel]({}, channel === 'delete-task' ? 'one' : ['one'], { deleteFiles: true });
      assert.equal(result.success, false, conflict); assert.equal(result.count, 0); assert.equal(result.freed, 0); assert.equal(result.fileCount, 0);
      assert.match(result.error, /保留/); assert.match(result.warning, /保留/);
      for (const name of family) assert.equal(fs.existsSync(name), true, conflict);
      assert.equal(h.run('downloadTasks.some(t => t.id === "one")'), true);
    }
  });
  await check('single and automatic episode deletion preserve registrations belonging to other owners', async () => {
    for (const channel of ['delete-episode-file', 'cleanup-watched-episode']) for (const conflict of ['cross-series', 'same-series', 'merge']) {
      const h = load(), own = task('one', h.dir), other = { ...own, id: 'other', hongguoInfo: { ...own.hongguoInfo, series_id: conflict === 'same-series' ? 'S' : 'OTHER', vid_index: 2 } };
      h.set('seriesRegistry', series()); h.set('downloadTasks', conflict === 'merge' ? [own] : [own, other]);
      const family = [own.savePath, own.savePath + '.enc.tmp', own.savePath + '.enc.tmp.decoded']; family.forEach(file);
      if (conflict === 'merge') h.set('mergeTasks', [{ seriesId: 'OTHER', status: 'completed', output: own.savePath }]);
      const result = await h.handlers[channel]({}, 'S', 1);
      assert.equal(result.success, false, conflict); assert.equal(result.count, 0); assert.equal(result.freed, 0); assert.match(result.error, /保留/);
      for (const name of family) assert.equal(fs.existsSync(name), true, conflict);
      assert.equal(h.run('downloadTasks.some(t => t.id === "one")'), true);
    }
  });
  await check('single and automatic episode cleanup removes owned temporary files with and without task records', async () => {
    for (const channel of ['delete-episode-file', 'cleanup-watched-episode']) for (const recorded of [false, true]) for (const finalExists of [false, true]) {
      const h = load(); h.set('seriesRegistry', series());
      const dir = h.context.seriesDownloadDir(h.dir, 'S', 'Short'); fs.mkdirSync(dir, { recursive: true });
      const own = task('one', dir, 'completed', 'Short 001.mp4'); h.set('downloadTasks', recorded ? [own] : []);
      if (finalExists) file(own.savePath); file(own.savePath + '.enc.tmp'); file(own.savePath + '.enc.tmp.decoded');
      const result = await h.handlers[channel]({}, 'S', 1);
      assert.equal(result.success, true, result.error); assert.equal(result.count, finalExists ? 3 : 2); assert.equal(result.freed, (finalExists ? 3 : 2) * 120000);
      assert.equal((await h.handlers['get-storage-usage']({})).totalFiles, 0);
      assert.equal(h.run('downloadTasks.length'), 0);
    }
  });
  await check('episode cleanup retains its recovery record when only a temporary file fails deletion', async () => {
    let blocked; const fakeFs = Object.create(fs);
    fakeFs.unlinkSync = name => { if (name === blocked) throw new Error('fixture locked'); fs.unlinkSync(name); };
    const h = load({}, { fs: fakeFs }), own = task('one', h.dir); h.set('downloadTasks', [own]); h.set('seriesRegistry', series());
    file(own.savePath); blocked = own.savePath + '.enc.tmp'; file(blocked);
    const result = await h.handlers['delete-episode-file']({}, 'S', 1);
    assert.equal(result.success, false); assert.equal(result.count, 1); assert.equal(result.freed, 120000); assert.equal(result.failed, 1);
    assert.equal(h.run('downloadTasks.length'), 1); assert.equal(fs.existsSync(blocked), true);
  });
  await check('task deletion rechecks the same task after cancellation wait before touching files or records', async () => {
    for (const channel of ['delete-task', 'delete-tasks']) for (const deleteFiles of [false, true]) for (const status of ['pending', 'completed']) {
      const h = load(), own = task('one', h.dir, 'downloading'); file(own.savePath); h.set('downloadTasks', [own]);
      let release; const wait = new Promise(resolve => { release = resolve; });
      h.context.stopTaskAndWait = async item => { item.status = 'stopped'; item.cancelled = true; await wait; };
      const pending = h.handlers[channel]({}, channel === 'delete-task' ? 'one' : ['one'], { deleteFiles });
      own.status = status; own.cancelled = false; release();
      const result = await pending;
      assert.equal(result.success, false, status); assert.equal(result.count, 0); assert.equal(result.freed, 0);
      assert.equal(fs.existsSync(own.savePath), true); assert.equal(h.run('downloadTasks.length'), 1);
    }
  });
  for (const channel of ['delete-task', 'delete-tasks', 'delete-series-files', 'delete-all-downloaded', 'delete-episode-file', 'cleanup-watched-episode']) {
    await check(`deletion cancels and persists scheduled retries even when records remain: ${channel}`, async () => {
      for (const outcome of ['deleted', 'file-failure', 'conflict', 'save-failure']) {
        let disk, blocked;
        const fakeFs = Object.create(fs); fakeFs.unlinkSync = name => { if (name === blocked) throw new Error('fixture locked'); fs.unlinkSync(name); };
        const store = { getSettings: () => ({}), saveTasks: rows => { if (outcome === 'save-failure') throw new Error('fixture save failure'); disk = structuredClone(rows); } };
        const h = load({}, { fs: fakeFs, './src/store': store }); h.set('seriesRegistry', series());
        const own = { ...task('one', h.dir, 'failed'), retryAt: Date.now() + 60000, sourceRetries: 1, error: '来源暂不可用 将在 3 分钟后自动重试（1/3）。' };
        file(own.savePath); if (outcome === 'file-failure') blocked = own.savePath;
        const other = { ...own, id: 'other', status: 'completed', hongguoInfo: { ...own.hongguoInfo, series_id: 'OTHER' } }; delete other.retryAt;
        const rows = outcome === 'conflict' ? [own, other] : [own]; h.set('downloadTasks', rows); disk = structuredClone(rows);
        const timers = new Map(), callbacks = [];
        h.context.setTimeout = fn => { const id = callbacks.length; callbacks.push(fn); timers.set(id, fn); return id; };
        h.context.clearTimeout = id => timers.delete(id);
        h.context.armSourceRetry(own);
        const target = channel === 'delete-task' ? 'one' : channel === 'delete-tasks' ? ['one'] : 'S';
        const options = channel === 'delete-task' || channel === 'delete-tasks' ? { deleteFiles: true } : 1;
        const result = await h.handlers[channel]({}, target, options);
        assert.equal(h.run('sourceRetryTimers.size'), 0, outcome); assert.equal(timers.size, 0, outcome);
        assert.equal(own.retryAt, undefined, outcome); assert.match(own.error, /来源暂不可用.*已取消自动重试/, outcome); assert.doesNotMatch(own.error, /将在/);
        for (const callback of callbacks) callback();
        assert.equal(h.run('downloadQueue.length'), 0, 'an already queued timer callback must not resurrect the task');
        assert.notEqual(own.status, 'pending');
        if (outcome === 'save-failure') { assert.equal(result.success, false); assert.match(result.error, /保存失败/); assert.ok(disk[0].retryAt); }
        else { assert.ok(disk.every(row => row.id !== 'one' || !row.retryAt), 'restart must not restore the cancelled retry'); }
      }
    });
  }
  await check('retry cancellation respects series and episode scope and running merge protection', async () => {
    for (const channel of ['delete-series-files', 'delete-episode-file', 'cleanup-watched-episode']) for (const merging of [false, true]) {
      const h = load(); h.set('seriesRegistry', series());
      const own = { ...task('one', h.dir, 'failed'), retryAt: Date.now() + 60000 };
      const other = { ...task('other', h.dir, 'failed'), retryAt: own.retryAt, hongguoInfo: { ...own.hongguoInfo, series_id: 'OTHER' } };
      h.set('downloadTasks', [own, other]); if (merging) h.set('mergeTasks', [{ seriesId: 'S', status: 'running' }]);
      h.context.setTimeout = () => ({}); h.context.clearTimeout = () => {};
      h.context.armSourceRetry(own); h.context.armSourceRetry(other);
      await h.handlers[channel]({}, 'S', 1);
      assert.equal(h.run('sourceRetryTimers.size'), merging ? 2 : 1);
      assert.equal(!!own.retryAt, merging); assert.ok(other.retryAt);
    }
  });
  for (const channel of ['delete-series-files', 'delete-all-downloaded', 'delete-episode-file', 'cleanup-watched-episode']) {
    await check(`invalid merge metadata fails before changing retry or files: ${channel}`, async () => {
      let saves = 0;
      const store = { getSettings: () => ({}), saveTasks: () => { saves++; } };
      const h = load({}, { './src/store': store }); h.set('seriesRegistry', series());
      const own = { ...task('one', h.dir, 'failed'), retryAt: Date.now() + 60000, sourceRetries: 1, error: '来源暂不可用 将在 3 分钟后自动重试（1/3）。' };
      file(own.savePath); h.set('downloadTasks', [own]);
      h.set('mergeTasks', [{ seriesId: 'OTHER', output: { invalid: true }, status: 'completed' }]);
      h.context.setTimeout = () => ({}); h.context.clearTimeout = () => {};
      h.context.armSourceRetry(own); const before = JSON.stringify(own);
      const result = await h.handlers[channel]({}, 'S', 1);
      assert.equal(result.success, false); assert.ok(result.error);
      assert.equal(JSON.stringify(own), before, 'failed scanning must not partially cancel retry state');
      assert.equal(h.run('sourceRetryTimers.size'), 1); assert.equal(saves, 0);
      assert.equal(fs.existsSync(own.savePath), true);
    });
  }
  await check('merge list excludes online-only and deleted files without hiding the library', async () => {
    const h = load(); h.set('seriesRegistry', series());
    const list = () => h.handlers['get-series-list']({}, { downloadedOnly: true });
    assert.equal((await list()).length, 0, 'online-only series must not be merge candidates');
    const one = task('one', h.dir); file(one.savePath); h.set('downloadTasks', [one]);
    assert.equal((await list()).length, 1, 'existing downloaded episode must remain mergeable');
    fs.unlinkSync(one.savePath);
    assert.equal((await list()).length, 0, 'deleted files must not leave merge candidates');
    assert.equal((await h.handlers['get-series-list']({})).length, 1, 'online library must remain intact');
    h.set('downloadTasks', []);
    const dir = h.context.seriesDownloadDir(h.dir, 'S', 'Short'); fs.mkdirSync(dir, { recursive: true });
    file(path.join(dir, 'Short 001.mp4'));
    assert.equal((await list()).length, 1, 'disk files retained after record cleanup remain mergeable');
  });
  await check('record-only deletion keeps downloaded files mergeable for built-in naming formats', async () => {
    for (const name_format of ['剧名', '剧名 集数', '剧名 集数 标题']) {
      const h = load({ name_format });
      const entry = series()[0]; entry.episodes[0].title = 'Story 999'; h.set('seriesRegistry', [entry]);
      await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: entry.episodes });
      const tasks = h.run('downloadTasks');
      for (const item of tasks) { fs.mkdirSync(path.dirname(item.savePath), { recursive: true }); file(item.savePath); item.status = 'completed'; }
      const removed = await h.handlers['delete-tasks']({}, tasks.map(item => item.id), { deleteFiles: false });
      assert.equal(removed.success, true); assert.ok(tasks.every(item => fs.existsSync(item.savePath)));
      assert.equal((await h.handlers['get-series-list']({}, { downloadedOnly: true })).length, 1, name_format);
      assert.equal(JSON.stringify(h.context.collectSeriesEpisodeFiles('S', 'Short').ordered.map(item => item.vid_index)), '[1,2]', name_format);
    }
  });
  await check('title-only preset keeps episode destinations unique', async () => {
    const h = load({ name_format: '剧名' });
    await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: series()[0].episodes });
    const paths = h.run('downloadTasks.map(task => task.savePath)');
    assert.equal(new Set(paths).size, 2, 'different episodes must not share a final or temporary path');
  });
  await check('same-title series use independent directories; legacy records still resolve', () => {
    const h = load();
    assert.notEqual(h.context.seriesDownloadDir(h.dir, 'S1', 'Short'), h.context.seriesDownloadDir(h.dir, 'S2', 'Short'));
    const old = task('old', h.dir); file(old.savePath); h.set('downloadTasks', [old]);
    assert.equal(h.context.collectSeriesEpisodeFiles('S', 'Short').ordered[0].path, old.savePath);
  });
  await check('missing completed file is shown missing and can be downloaded again', async () => {
    const h = load(); h.set('seriesRegistry', series()); h.set('downloadTasks', [task('one', h.dir)]);
    const detail = await h.handlers['get-series-episodes']({}, 'S');
    assert.equal(detail.data.episodes[0].status, 'missing', 'a missing file cannot remain completed');
    const added = await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: [series()[0].episodes[0]] });
    assert.equal(added, 1); assert.equal(h.run('downloadTasks.length'), 1); assert.equal(h.run('downloadTasks[0].status'), 'pending');
  });
  await check('delete downloaded files preserves active and waiting downloads', async () => {
    const h = load(); const completed = task('one', h.dir), active = task('two', h.dir, 'downloading', 'two.mp4', 2), waiting = task('three', h.dir, 'pending', 'three.mp4', 3);
    file(completed.savePath); h.set('seriesRegistry', series()); h.set('downloadTasks', [completed, active, waiting]); h.set('downloadQueue', [waiting]);
    const result = await h.handlers['delete-all-downloaded']({});
    assert.equal(result.success, true); assert.equal(fs.existsSync(completed.savePath), false);
    assert.equal(h.run('downloadTasks.some(task => task.id === "two")'), true, 'active task disappeared');
    assert.equal(h.run('downloadQueue.some(task => task.id === "three")'), true, 'waiting task disappeared');
  });
  await check('delete all finds merged files after record cleanup and preserves unknown directories', async () => {
    for (const legacy of [false, true]) {
      const h = load(); h.set('seriesRegistry', series());
      const dir = legacy ? path.join(h.dir, '红果短剧', 'Short') : h.context.seriesDownloadDir(h.dir, 'S', 'Short');
      fs.mkdirSync(dir, { recursive: true });
      const one = task('one', dir, 'completed', 'Short 001.mp4'); file(one.savePath);
      const merged = path.join(dir, 'Short 合集.mp4'); file(merged);
      const unknownDir = path.join(h.dir, 'unknown'); fs.mkdirSync(unknownDir);
      const unrelated = path.join(unknownDir, 'Other 合集.mp4'); file(unrelated);
      h.set('downloadTasks', [one]);
      assert.equal((await h.handlers['delete-tasks']({}, ['one'], { deleteFiles: false })).success, true);
      assert.equal(h.run('downloadTasks.length'), 0);
      assert.ok(fs.existsSync(one.savePath) && fs.existsSync(merged));
      const result = await h.handlers['delete-all-downloaded']({});
      assert.equal(result.success, true);
      assert.equal(fs.existsSync(merged), false, 'merged file remains after record cleanup');
      assert.equal(fs.existsSync(one.savePath), false);
      assert.equal(result.count, 2); assert.equal(result.freed, 240000);
      assert.equal(fs.existsSync(unrelated), true, 'unknown directory must not be scanned');
      assert.equal(h.run('seriesRegistry.length'), 1);
      const empty = await h.handlers['delete-all-downloaded']({});
      assert.equal(empty.success, true); assert.equal(empty.count, 0);
    }
  });
  await check('auto-delete uses task identity with title suffixes', async () => {
    const h = load(); const one = task('one', h.dir, 'completed', 'Short 001 Reunion.mp4');
    const two = task('two', h.dir, 'completed', 'Short 002 Story 001.mp4', 2);
    file(one.savePath); file(two.savePath); h.set('seriesRegistry', series()); h.set('downloadTasks', [one, two]);
    const result = await h.handlers['delete-episode-file']({}, 'S', 1);
    assert.equal(result.count, 1); assert.equal(fs.existsSync(one.savePath), false, 'target episode remains');
    assert.equal(fs.existsSync(two.savePath), true, 'unrelated episode was deleted by title digits');
  });
  await check('explicit task deletion waits for an active lookup to finish cancelling', async () => {
    let finishLookup;
    const h = load({}, { './src/native/hongguo': { fetchPlayUrlSingle: () => new Promise(resolve => { finishLookup = resolve; }) } });
    const one = task('one', h.dir, 'pending'); h.set('downloadTasks', [one]); h.set('downloadQueue', [one]); h.pump();
    for (let i = 0; i < 20 && !finishLookup; i++) await new Promise(setImmediate);
    assert.equal(typeof finishLookup, 'function', 'the source lookup must be active before deletion');
    const deleting = h.handlers['delete-task']({}, 'one', { deleteFiles: true });
    assert.equal(h.run('downloadTasks.length'), 1, 'record removed before its active run settled');
    finishLookup({ url: null }); await deleting;
    assert.equal(h.run('downloadTasks.length'), 0); assert.equal(h.run('runningDownloads.size'), 0);
  });
  await check('failed file deletion keeps the task record', async () => {
    const denied = Object.create(fs); denied.unlinkSync = () => { throw new Error('permission denied'); };
    const h = load({}, { fs: denied }); const one = task('one', h.dir, 'completed', 'Short 001.mp4');
    file(one.savePath); h.set('seriesRegistry', series()); h.set('downloadTasks', [one]);
    const result = await h.handlers['delete-episode-file']({}, 'S', 1);
    assert.ok(result.success === false || result.failed > 0, 'deletion failure must reach caller');
    assert.equal(h.run('downloadTasks.length'), 1, 'failed deletion lost its recovery record');
  });
  await check('task file deletion preserves running merge inputs and records', async () => {
    for (const handler of ['delete-task', 'delete-tasks']) {
      const h = load(), one = task('one', h.dir); file(one.savePath);
      h.set('downloadTasks', [one]); h.set('mergeTasks', [{seriesId:'S', status:'running'}]);
      const result = await h.handlers[handler]({}, handler === 'delete-task' ? 'one' : ['one'], {deleteFiles:true});
      assert.equal(result.success, false, handler);
      assert.equal(fs.existsSync(one.savePath), true);
      assert.equal(h.run('downloadTasks.length'), 1);
      assert.equal(h.run('downloadTasks[0].status'), 'completed');
    }
  });
  await check('merge episode selection retains the newest task regardless of array order', () => {
    const h = load(), latest = {...task('latest', h.dir), startTime:30}, old = {...task('old', h.dir), startTime:10};
    file(latest.savePath); file(old.savePath); h.set('downloadTasks', [latest, old]);
    assert.equal(h.context.collectSeriesEpisodeFiles('S','Short').ordered[0].path, latest.savePath);
  });
  await check('store save failure is reported and retains the durable snapshot', () => {
    const dir = path.join(root, 'store'); fs.mkdirSync(dir); const target = path.join(dir, 'data.json');
    let fail = false; const fakeFs = Object.create(fs); fakeFs.writeFileSync = (...args) => { if (fail) throw new Error('simulated disk full'); return fs.writeFileSync(...args); };
    const context = vm.createContext({ require: name => name === 'fs' ? fakeFs : req(name), module: { exports: {} }, Buffer, URL, structuredClone, console: { error() {} } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/store.js'), 'utf8'), context);
    const store = context.module.exports; store.init(target); store.saveTasks([{ id: 'saved' }]); const before = fs.readFileSync(target, 'utf8'); fail = true;
    assert.throws(() => store.saveTasks([{ id: 'unsaved' }]), /simulated disk full/);
    assert.equal(fs.readFileSync(target, 'utf8'), before); assert.equal(store.getTasks()[0].id, 'saved');
  });
  await check('folder names reject Windows reserved device names without splitting emoji', () => {
    const name = load().context.sanitizeFolderName;
    assert.equal(name('CON'), '_CON');
    assert.equal(name('con.txt'), '_con.txt');
    assert.equal(name('aux'), '_aux');
    assert.equal(name('nul '), '_nul');
    assert.equal(name('COM1'), '_COM1');
    assert.equal(name('LPT9.dat'), '_LPT9.dat');
    assert.equal(name('ok.'), 'ok');
    assert.equal(name('concert'), 'concert');
    const emoji = '😀'.repeat(81);
    assert.equal(Array.from(name(emoji)).length, 80);
    assert.equal(name('尾部空格  '), '尾部空格');
  });
  await check('show-in-folder reveals only real files inside the download root', async () => {
    const h = load();
    const inside = path.join(h.dir, 'clip.mp4');
    fs.writeFileSync(inside, 'video');
    assert.equal((await h.handlers['show-in-folder']({}, inside)).success, true);
    assert.deepEqual(h.opened, [inside]);
    const outside = path.join(root, 'outside.exe');
    fs.writeFileSync(outside, 'nope');
    h.opened.length = 0;
    assert.equal((await h.handlers['show-in-folder']({}, outside)).success, false);
    assert.equal((await h.handlers['show-in-folder']({}, path.join(outside, 'missing'))).success, false);
    const link = path.join(h.dir, 'linked.mp4');
    fs.symlinkSync(outside, link);
    assert.equal((await h.handlers['show-in-folder']({}, link)).success, false);
    assert.deepEqual(h.opened, []);
  });
  await check('playback transcode rejects an existing file outside the download root', async () => {
    const h = load();
    const outside = path.join(root, 'foreign.mp4');
    fs.writeFileSync(outside, Buffer.alloc(1200));
    const result = await h.handlers['transcode-for-playback']({}, { seriesId: 'S', vidIndex: 1, filePath: outside });
    assert.equal(result.success, false);
    assert.match(result.error, /下载目录/);
    const inside = path.join(h.dir, 'local.mp4');
    fs.writeFileSync(inside, Buffer.alloc(1200));
    const allowed = h.context.isInsideMediaRoot(inside);
    assert.equal(allowed, true);
  });
  await check('settings omit the proxy password and ignore undeclared keys', async () => {
    const h = load({ proxy_password: 'secret-fixture', proxy_username: 'test-user', custom_sources: [{ id: 'keep' }] });
    const visible = await h.handlers['get-settings']({});
    assert.equal(visible.proxy_password, undefined);
    assert.equal(visible.proxy_password_set, true);
    assert.equal(JSON.stringify(visible).includes('secret-fixture'), false);
    const saved = await h.handlers['save-settings']({}, { proxy_password: '', injected: true, max_concurrent: 4, custom_sources: [{ id: 'evil' }] });
    assert.equal(saved.success, true);
    assert.equal(h.settings().proxy_password, 'secret-fixture');
    assert.equal(h.settings().injected, undefined);
    assert.equal(h.settings().max_concurrent, 4);
    assert.deepEqual(h.settings().custom_sources, [{ id: 'keep' }]);
    await h.handlers['save-settings']({}, { proxy_password: 'next-secret' });
    assert.equal(h.settings().proxy_password, 'next-secret');
    await h.handlers['save-settings']({}, { clear_proxy_password: true });
    assert.equal(h.settings().proxy_password, '');
    assert.equal((await h.handlers['get-settings']({})).proxy_password_set, false);
  });
  await check('old download records remain playable and revealable after changing the root', async () => {
    const h = load();
    const oldDir = path.join(root, 'old-downloads'); fs.mkdirSync(oldDir);
    const one = task('one', oldDir); file(one.savePath);
    const merged = path.join(oldDir, 'merged.mp4'); file(merged);
    h.set('downloadTasks', [one]); h.set('mergeTasks', [{ output: merged, status: 'completed' }]);
    file(h.context.compatPathFor('S', 1));
    assert.equal((await h.handlers['show-in-folder']({}, one.savePath)).success, true, 'old registered episode must remain revealable');
    assert.equal((await h.handlers['show-in-folder']({}, merged)).success, true, 'old registered merge must remain revealable');
    const playable = await h.handlers['transcode-for-playback']({}, { seriesId: 'S', vidIndex: 1, vid: 'one', filePath: one.savePath });
    assert.equal(playable.success, true, playable.error);
    assert.equal(playable.cached, true);
  });
  await check('historical media authorization rejects siblings, mismatched episodes and symlink escapes', async () => {
    const h = load();
    const oldDir = path.join(root, 'historical-safety'); fs.mkdirSync(oldDir);
    const one = task('one', oldDir); file(one.savePath); h.set('downloadTasks', [one]);
    const sibling = path.join(oldDir, 'unregistered.mp4'); file(sibling);
    assert.equal((await h.handlers['show-in-folder']({}, sibling)).success, false);
    for (const identity of [{ seriesId: 'other', vidIndex: 1, vid: 'one' }, { seriesId: 'S', vidIndex: 2, vid: 'one' }, { seriesId: 'S', vidIndex: 1, vid: 'other' }]) {
      const result = await h.handlers['transcode-for-playback']({}, { ...identity, filePath: one.savePath });
      assert.equal(result.success, false); assert.match(result.error, /下载目录/);
    }
    fs.unlinkSync(one.savePath); fs.symlinkSync(sibling, one.savePath);
    assert.equal((await h.handlers['show-in-folder']({}, one.savePath)).success, false, 'a registered name must not grant access to a replacement symlink');
    const denied = await h.handlers['transcode-for-playback']({}, { seriesId: 'S', vidIndex: 1, vid: 'one', filePath: one.savePath });
    assert.equal(denied.success, false); assert.match(denied.error, /下载目录/);
    const linkedDir = path.join(oldDir, 'linked');
    const outsideDir = path.join(root, 'unregistered-directory'); fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = task('two', oldDir, 'completed', path.join('linked', 'two.mp4'), 2);
    file(escaped.savePath); h.set('downloadTasks', [escaped]);
    assert.equal((await h.handlers['show-in-folder']({}, escaped.savePath)).success, false);
    const escapedResult = await h.handlers['transcode-for-playback']({}, { seriesId: 'S', vidIndex: 2, vid: 'two', filePath: escaped.savePath });
    assert.equal(escapedResult.success, false);
  });
  await check('IPv6 proxy rules have one bracket pair and matching login challenges receive credentials', async () => {
    const h = load();
    await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'custom', proxy_host: 'http://[::1]:7890', proxy_username: 'user', proxy_password: 'pw' });
    assert.equal(h.proxyCalls.at(-1).proxyRules, 'http://[::1]:7890');
    for (const host of ['::1', '[::1]']) {
      let auth = null;
      h.app.emit('login', { preventDefault() {} }, null, null, { isProxy: true, host, port: 7890 }, (user, password) => { auth = [user, password]; });
      assert.deepEqual(auth, ['user', 'pw'], host);
    }
    for (const challenge of [{ isProxy: true, host: '::2', port: 7890 }, { isProxy: true, host: '::1', port: 7891 }, { isProxy: false, host: '::1', port: 7890 }]) {
      let called = false;
      h.app.emit('login', { preventDefault() {} }, null, null, challenge, () => { called = true; });
      assert.equal(called, false);
    }
    const overridden = h.context.resolveProxyConfig({ proxy_enabled: true, proxy_mode: 'custom', proxy_host: 'http://[::1]:7890', proxy_port: 7891 });
    assert.equal(overridden.url, 'http://[::1]:7891');
    const encoded = h.context.resolveProxyConfig({ proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1:80', proxy_username: 'user%40', proxy_password: 'pw%40:@' });
    const parsed = new URL(encoded.url);
    assert.equal(decodeURIComponent(parsed.username), 'user%40');
    assert.equal(decodeURIComponent(parsed.password), 'pw%40:@');
  });
  await check('credentials pasted in a proxy URL are hidden and survive settings round trips', async () => {
    let seen;
    const h = load({ proxy_enabled: true, proxy_mode: 'custom', proxy_host: 'http://url-user:secret%40fixture@[::1]:7890', proxy_port: '' }, {
      axios: { get: async (_url, options) => { seen = options; return { status: 200 }; } },
    });
    const visible = await h.handlers['get-settings']({});
    assert.equal(JSON.stringify(visible).includes('secret'), false, 'embedded URL password reached the renderer');
    assert.equal(visible.proxy_password_set, true);
    assert.equal((await h.handlers['save-settings']({}, { ...visible, proxy_password: '' })).success, true);
    assert.equal((await h.handlers['test-proxy']({}, { ...visible, proxy_password: '' })).success, true);
    assert.equal(seen.proxy.auth.username, 'url-user');
    assert.equal(seen.proxy.auth.password, 'secret@fixture');
    await h.handlers['save-settings']({}, { clear_proxy_password: true });
    assert.equal((await h.handlers['get-settings']({})).proxy_password_set, false);
    assert.equal(h.context.resolveProxyConfig(h.context.getCurrentSettings()).url.includes('secret'), false);
    await h.handlers['save-settings']({}, { proxy_host: 'http://new-user:new-secret@127.0.0.1:80', proxy_port: '' });
    const next = await h.handlers['get-settings']({});
    assert.equal(next.proxy_password_set, true);
    assert.equal(JSON.stringify(next).includes('new-secret'), false);
    assert.equal((await h.handlers['test-proxy']({}, { ...next, proxy_password: '' })).success, true);
    assert.equal(seen.proxy.auth.password, 'new-secret');
    assert.equal(seen.proxy.port, 80);
  });
  await check('system proxy restores the startup environment and proxy auth stays out of proxy rules', async () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://startup-proxy:1';
    try {
      const h = load();
      await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: '9', proxy_username: 'user', proxy_password: 'pw' });
      assert.equal(h.context.process.env.HTTPS_PROXY, 'http://user:pw@127.0.0.1:9');
      assert.equal(JSON.stringify(h.proxyCalls).includes('pw'), false);
      assert.equal(h.proxyCalls.at(-1).proxyRules, 'http://127.0.0.1:9');
      let auth = null;
      h.app.emit('login', { preventDefault() {} }, null, null, { isProxy: true, host: '127.0.0.1', port: 9 }, (user, password) => { auth = [user, password]; });
      assert.deepEqual(auth, ['user', 'pw']);
      auth = null;
      h.app.emit('login', { preventDefault() {} }, null, null, { isProxy: false, host: '127.0.0.1', port: 9 }, (user, password) => { auth = [user, password]; });
      assert.equal(auth, null);
      await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'system' });
      assert.equal(h.context.process.env.HTTPS_PROXY, 'http://startup-proxy:1');
      await h.context.applyProxySettings({ proxy_enabled: false });
      assert.equal(h.context.process.env.HTTPS_PROXY, undefined);
      await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'system' });
      assert.equal(h.context.process.env.HTTPS_PROXY, 'http://startup-proxy:1');
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });
  for (const key of ['ALL_PROXY', 'all_proxy']) await check(`${key} follows direct, custom and system proxy mode changes`, async () => {
    const startup = 'http://127.0.0.1:19191';
    const h = load({}, {}, { [key]: startup });
    // Execute axios's real environment resolver against the isolated app environment.
    const proxyModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(req.resolve('proxy-from-env'), 'utf8'), { require: req, module: proxyModule, exports: proxyModule.exports, process: h.context.process, URL });
    const route = () => proxyModule.exports.getProxyForUrl('https://media.example.test/episode.mp4');
    assert.equal(route(), startup);
    await h.context.applyProxySettings({ proxy_enabled: false });
    assert.equal(route(), '', 'disabled proxy must bypass inherited ALL_PROXY');
    assert.equal(h.context.process.env[key], undefined);
    await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'system' });
    assert.equal(route(), startup);
    assert.equal(h.context.resolveProxyConfig({ proxy_enabled: true, proxy_mode: 'system' }).url, startup);
    await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 19192 });
    assert.equal(route(), 'http://127.0.0.1:19192');
    assert.equal(h.context.process.env[key], 'http://127.0.0.1:19192');
    await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'direct' });
    assert.equal(route(), '');
    await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'system' });
    assert.equal(route(), startup);
    assert.deepEqual({ ...h.context.process.env }, { [key]: startup });
  });
  await check('proxy connectivity test keeps a saved password when the draft leaves it blank', async () => {
    let seen;
    const settings = { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 7890, proxy_username: 'test-user', proxy_password: 'secret-fixture' };
    const h = load(settings, { axios: { get: async (_url, options) => { seen = options; return { status: 200 }; } } });
    const result = await h.handlers['test-proxy']({}, { ...settings, proxy_password: '' });
    assert.equal(seen.proxy.auth.password, 'secret-fixture');
    assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
  });
  await check('proxy status and test result never expose credentials', async () => {
    const settings = { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 7890, proxy_username: 'test-user', proxy_password: 'secret-fixture' };
    const h = load(settings, { axios: { get: async () => ({ status: 200 }) } });
    const result = [await h.handlers['get-proxy-status']({}), await h.handlers['test-proxy']({}, settings)];
    assert.ok(!JSON.stringify(result).includes('secret-fixture')); assert.ok(!JSON.stringify(result).includes('test-user'));
  });
  await check('failed queue persistence returns failure and leaves no ghost submission', async () => {
    const h = load({}, { './src/store': { getSettings: () => ({ root }), saveTasks() { throw new Error('simulated disk full'); } } });
    const result = await h.handlers['hongguo-download-batch']({}, { seriesId: 'S', seriesTitle: 'Short', episodes: series()[0].episodes });
    assert.equal(result.success, false); assert.equal(h.run('downloadTasks.length'), 0); assert.equal(h.run('downloadQueue.length'), 0);
  });
  assert.equal(failures, 0, `${failures} download safety regressions`);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
