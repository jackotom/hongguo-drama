// Isolated main/store behavior: no real media, windows, network or user files.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source), dirs = [];
function fixture(platform = 'darwin', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-lifecycle-')); dirs.push(root);
  const handlers = {}, app = new EventEmitter(), windows = [], state = { quits: 0, requests: [], errors: [], mergeSaves: [] };
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }), quit: () => state.quits++ });
  const store = { getSettings: () => ({ root }), saveSettings() {}, setErrorHandler: fn => state.storage = fn, saveTasks() {},
    saveMergeTasks: tasks => state.mergeSaves.push(JSON.parse(JSON.stringify(tasks))) };
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; windows.push(this); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.setZoomFactor = value => { this.zoomFactor = value; }; }
    getContentSize() { return [this.options.width, this.options.height]; }
    setMenuBarVisibility() {} loadFile() {} isDestroyed() { return false; }
  }
  const axios = Object.assign(async config => {
    state.requests.push({ ...config.headers });
    throw Object.assign(new Error('denied'), { response: { status: 403 } });
  }, { isCancel: () => false });
  const context = vm.createContext({ require: name => name === 'electron' ? { app, BrowserWindow: Window,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showErrorBox: (title, message) => state.errors.push({ title, message }) } }
    : name === 'fs' ? Object.create(fs) : name === './src/store' ? store : name === 'axios' ? axios
    : name === 'child_process' && options.childProcess ? options.childProcess
    : name === './src/native/merge-runner' && options.mergeRunner ? options.mergeRunner : req(name),
    __dirname: path.dirname(source), process: { ...process, platform, env: {} }, Buffer, URL, Response, Request, Headers,
    AbortController, setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
    setInterval, clearInterval, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context);
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  return { root, context, handlers, app, windows, state, run: text => vm.runInContext(text, context) };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function timers() {
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) { const timer = { unref() {} }; pending.set(timer, { fn, ms }); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    async expire() {
      for (const [timer, { fn, ms }] of [...pending].sort((a, b) => a[1].ms - b[1].ms)) {
        if (ms <= 10000 && pending.delete(timer)) fn();
      }
      await flush();
    },
  };
}
const checks = [
  ['Windows main close requests normal quit even when a hidden search window survives', async () => {
    const h = fixture('win32');
    h.context.createWindow();
    assert.equal(h.windows[0].zoomFactor, 1, 'main window initializes default font size');
    h.context.getSearchWindow(true);
    let prevented = false;
    h.windows[0].emit('close', { preventDefault: () => prevented = true });
    assert.equal(prevented, true, 'main window must remain available while before-quit decides');
    assert.equal(h.state.quits, 1, 'hidden browser must not keep an invisible Windows app alive');
    h.app.emit('before-quit', { preventDefault() { throw new Error('idle quit should pass'); } });
    h.windows[0].emit('close', { preventDefault() { throw new Error('approved quit must close'); } });
    assert.equal(h.state.quits, 1, 'approved close must not request quit recursively');
  }],
  ['repeat merge chooses a new filename and preserves existing collections', async () => {
    const h = fixture('darwin', { mergeRunner: { runMerge: async ({ task }) => { task.status = 'completed'; } } });
    const input = path.join(h.root, 'ep.mp4'); fs.writeFileSync(input, 'original');
    h.context.collectSeriesEpisodeFiles = () => ({ dir: h.root, ordered: [{ path: input, vid_index: 1 }] });
    h.context.resolveFfmpeg = () => '/fixture/ffmpeg';
    fs.writeFileSync(path.join(h.root, '未命名短剧_合集.mp4'), 'first');
    fs.writeFileSync(path.join(h.root, '未命名短剧_合集 (2).mp4'), 'second');
    const result = await h.handlers['merge-series']({}, '1');
    assert.equal(result.success, true, result.error);
    assert.equal(result.outputName, '未命名短剧_合集 (3).mp4');
    assert.equal(fs.readFileSync(path.join(h.root, '未命名短剧_合集.mp4'), 'utf8'), 'first');
    await flush();
  }],
  ['startup cleans abandoned merge work only in recorded output directories', async () => {
    const h = fixture(), dir = path.join(h.root, 'series'); fs.mkdirSync(dir);
    for (const name of ['.merge-Ab1234', '.merge-user', '.merge-Zz9876']) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, '.merge-Ab1234', '0.mp4'), 'temporary');
    fs.writeFileSync(path.join(dir, '.merge-Zz9876', 'keep.txt'), 'unrelated');
    fs.writeFileSync(path.join(dir, 'original.mp4'), 'original');
    h.run('store.getMergeTasks = () => [{ output: ' + JSON.stringify(path.join(dir, '合集.mp4')) + ", status: 'running' }]; loadMergeTasks();");
    await h.run('mergeTempCleanup');
    assert.equal(fs.existsSync(path.join(dir, '.merge-Ab1234')), false);
    assert.ok(fs.existsSync(path.join(dir, '.merge-user')));
    assert.ok(fs.existsSync(path.join(dir, '.merge-Zz9876', 'keep.txt')));
    assert.equal(fs.readFileSync(path.join(dir, 'original.mp4'), 'utf8'), 'original');
  }],
  ['quit cancels downloads and retries, waits for temporary cleanup and does not start the queue', async () => {
    const h = fixture(); let cancelled = false, closed = false, release;
    const partial = path.join(h.root, 'ep.enc.tmp'); fs.writeFileSync(partial, 'partial');
    h.context.activeTask = { id: 'download', status: 'downloading', cancelSource: { cancel() { cancelled = true; } }, writer: { destroy() { closed = true; } } };
    h.context.downloadPromise = new Promise(resolve => { release = () => { fs.rmSync(partial, { force: true }); h.run("downloadRuns.delete('download')"); resolve(); }; });
    h.run("downloadTasks=[activeTask,{id:'queued',status:'pending'},{id:'retry',status:'failed',retryAt:Date.now()+600000}]; downloadQueue=[downloadTasks[1]]; downloadRuns.set('download',downloadPromise); armSourceRetry(downloadTasks[2]);");
    try {
      let prevented = false; h.app.emit('before-quit', { preventDefault: () => prevented = true });
      assert.equal(prevented, true); assert.ok(cancelled && closed);
      assert.equal(h.run('sourceRetryTimers.size'), 0); assert.equal(h.run('downloadQueue.length'), 0);
      assert.equal(h.run('downloadTasks[1].status'), 'stopped'); assert.equal(h.run('downloadTasks[2].status'), 'stopped');
      assert.equal(h.state.quits, 0); release(); await flush();
      assert.equal(h.state.quits, 1); assert.equal(fs.existsSync(partial), false);
    } finally { h.run('for (const timer of sourceRetryTimers.values()) clearTimeout(timer);'); release(); }
  }],
  ['compat rejects non-positive, fractional and path episode indices through both IPC entries', async () => {
    const h = fixture();
    for (const index of ['../../escape', '../1', '1/../../file', 0, -1, 1.5, true, {}, '1e2', ' 1', Number.MAX_SAFE_INTEGER + 1]) {
      for (const channel of ['transcode-for-playback', 'cancel-transcode-for-playback']) {
        const result = await h.handlers[channel]({}, { seriesId: '1', vidIndex: index });
        assert.equal(result.success, false, `${channel}: ${String(index)}`);
        assert.match(result.error || '', /集数/);
      }
    }
    assert.equal(h.context.compatPathFor('1', 2), h.context.compatPathFor('1', '2'));
  }],
  ['cache trimming retains temporary inputs and active files under budget pressure', async () => {
    const h = fixture(), dir = h.context.getCompatDir(), current = path.join(dir, '1_001.mp4');
    for (const name of ['.tmp_active.mp4', 'old.mp4', '1_001.mp4']) fs.writeFileSync(path.join(dir, name), 'data');
    const nativeStat = h.run('fs.statSync');
    h.context.cacheStat = file => ({ ...nativeStat(file), size: 3 * 1024 ** 3, atimeMs: file.endsWith('old.mp4') ? 2 : 1 });
    // Override only this VM's fs facade, never the real shared module.
    const realFs = h.run('fs'); const descriptor = Object.getOwnPropertyDescriptor(realFs, 'statSync');
    try {
      realFs.statSync = h.context.cacheStat;
      h.context.activeFile = current;
      h.run('compatPreparing.set(activeFile, { files: new Set([activeFile]) }); trimCompatCache();');
    } finally { if (descriptor) Object.defineProperty(realFs, 'statSync', descriptor); else delete realFs.statSync; }
    assert.ok(fs.existsSync(path.join(dir, '.tmp_active.mp4')), 'temporary input was evicted');
    assert.ok(fs.existsSync(current), 'active output was evicted');
    assert.equal(fs.existsSync(path.join(dir, 'old.mp4')), false);
  }],
  ['oversized completed output survives its own trim', async () => {
    const h = fixture(), dir = h.context.getCompatDir(), out = path.join(dir, 'large.mp4');
    fs.writeFileSync(out, 'data');
    const realFs = h.run('fs'), nativeStat = realFs.statSync;
    try { realFs.statSync = file => ({ ...nativeStat(file), size: 5 * 1024 ** 3 }); h.context.trimCompatCache(out); }
    finally { realFs.statSync = nativeStat; }
    assert.ok(fs.existsSync(out), 'new >4GB output was deleted');
  }],
  ['first cache access cleans abandoned parts without deleting completed output', async () => {
    const h = fixture(), dir = path.join(h.root, 'compat-cache'); fs.mkdirSync(dir);
    for (const name of ['.tmp_abandoned.mp4', '1_001.mp4.part', '1_001.mp4']) fs.writeFileSync(path.join(dir, name), 'data');
    h.context.getCompatDir();
    assert.deepEqual(fs.readdirSync(dir), ['1_001.mp4']);
  }],
  ['successful store retry clears only transient write failures', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-store-retry-')); dirs.push(root);
    const file = path.join(root, 'data.json'), events = [], store = req('./src/store');
    store.setErrorHandler(value => events.push(value)); store.init(file);
    fs.mkdirSync(file + '.tmp'); assert.throws(() => store.saveSettings({ keep: false }));
    fs.rmdirSync(file + '.tmp'); store.saveSettings({ keep: true });
    assert.equal(events.at(-1), null, 'write failure remains latched after successful save');
    fs.writeFileSync(file, '{bad'); store.init(file);
    assert.throws(() => store.saveSettings({ lost: true }), /读取本地数据/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{bad'); assert.ok(events.at(-1)?.error);
  }],
  ['non-App providers never gain a Hongguo Referer on 403', async () => {
    for (const source of ['xifan', 'hema', 'custom']) {
      const h = fixture();
      await assert.rejects(h.context.requestMedia({ url: 'https://example.com/a.mp4', source }, { headers: { Range: 'bytes=2-4' } }));
      assert.ok(h.state.requests.every(headers => !headers.Referer), source);
      assert.ok(h.state.requests.every(headers => headers.Range === 'bytes=2-4'));
      assert.ok(h.state.requests.length <= 2);
    }
  }],
  ['delete waiting retry releases timer and update blocker immediately', async () => {
    const h = fixture(); h.run("downloadTasks=[{id:'retry',status:'failed',retryAt:Date.now()+600000}]; armSourceRetry(downloadTasks[0]);");
    try { await h.handlers['delete-task']({}, 'retry'); assert.equal(h.run('sourceRetryTimers.size'), 0); }
    finally { h.run('for (const timer of sourceRetryTimers.values()) clearTimeout(timer);'); }
  }],
  ['quit waits for compat and merge cleanup; closing a Mac window keeps merge alive', async () => {
    const h = fixture(), child = new EventEmitter(); let stopped = false, releaseCompat, releaseMerge;
    child.kill = () => { stopped = true; };
    h.context.compatJob = { controller: new AbortController(), promise: new Promise(resolve => releaseCompat = resolve) };
    h.context.mergeTask = { id: 'm', status: 'running', child };
    h.context.mergePromise = new Promise(resolve => releaseMerge = resolve);
    h.run("compatPreparing.set('key',compatJob); mergeTasks=[mergeTask]; if (typeof mergeRuns !== 'undefined') mergeRuns.set('m',mergePromise);");
    h.app.emit('window-all-closed'); assert.equal(stopped, false); assert.equal(h.state.quits, 0);
    let prevented = false;
    h.app.emit('before-quit', { preventDefault: () => prevented = true });
    try {
      assert.equal(prevented, true, 'quit must wait before closing the app');
      assert.equal(h.context.compatJob.controller.signal.aborted, true);
      assert.equal(stopped, true, 'merge child must stop');
      assert.equal(h.state.quits, 0);
      child.emit('close'); releaseCompat(); await Promise.resolve(); assert.equal(h.state.quits, 0);
      releaseMerge(); for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(h.state.quits, 1);
    } finally { child.emit('close'); releaseCompat(); releaseMerge(); }
  }],
  ['real transcode IPC waits for child close and removes temporary output before quitting', async () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let killed = false, output;
    child.kill = () => { killed = true; };
    const h = fixture('darwin', { childProcess: { spawn: (_file, args) => { output = args.at(-1); fs.writeFileSync(output, 'partial'); return child; } } });
    const input = path.join(h.root, 'original.mp4'); fs.writeFileSync(input, 'original');
    h.context.resolveFfmpeg = () => '/fixture/ffmpeg'; h.context.probeDuration = async () => 1;
    const pending = h.handlers['transcode-for-playback']({}, { seriesId: '1', vidIndex: 1, filePath: input, force: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.ok(output);
    let prevented = false; h.app.emit('before-quit', { preventDefault: () => prevented = true });
    assert.ok(prevented && killed); assert.equal(h.state.quits, 0); assert.ok(fs.existsSync(output));
    child.emit('close', 143); assert.equal((await pending).cancelled, true);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(h.state.quits, 1); assert.equal(fs.existsSync(output), false); assert.equal(fs.readFileSync(input, 'utf8'), 'original');
    let blocked = false; h.app.emit('before-quit', { preventDefault: () => blocked = true });
    assert.equal(blocked, false, 'completed cleanup must not prevent the final quit');
  }],
  ['merge IPC registers cleanup until completion and idle update quit stays unblocked', async () => {
    const child = new EventEmitter(); let killed = false, finish;
    child.kill = () => { killed = true; };
    const h = fixture('darwin', { mergeRunner: {
      stopMergeChildren: req('./src/native/merge-runner').stopMergeChildren,
      runMerge: async ({ task }) => { task.child = child; await new Promise(resolve => finish = resolve); task.status = 'stopped'; },
    } });
    const input = path.join(h.root, 'ep.mp4'); fs.writeFileSync(input, 'original');
    h.context.collectSeriesEpisodeFiles = () => ({ dir: h.root, ordered: [{ path: input, vid_index: 1 }] });
    h.context.resolveFfmpeg = () => '/fixture/ffmpeg';
    const result = await h.handlers['merge-series']({}, '1'); assert.equal(result.success, true, result.error);
    assert.equal(h.run('mergeRuns.size'), 1);
    let prevented = false; h.app.emit('before-quit', { preventDefault: () => prevented = true });
    try {
      assert.ok(prevented && killed); assert.equal(h.state.quits, 0);
      child.emit('close'); finish(); for (let i = 0; i < 15; i++) await Promise.resolve();
      assert.equal(h.run('mergeRuns.size'), 0); assert.equal(h.state.quits, 1);
      let blocked = false; h.app.emit('before-quit', { preventDefault: () => blocked = true }); assert.equal(blocked, false);
    } finally { child.emit('close'); finish(); }
  }],
  ['stalled transcode cancels quit within ten seconds; late close cannot finish a newer quit', async () => {
    const clock = timers(), child = new EventEmitter(), signals = [];
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = signal => signals.push(signal);
    let output;
    const h = fixture('darwin', { ...clock, childProcess: { spawn: (_file, args) => {
      output = args.at(-1); fs.writeFileSync(output, 'partial'); return child;
    } } });
    const input = path.join(h.root, 'original.mp4'); fs.writeFileSync(input, 'original');
    h.context.resolveFfmpeg = () => '/fixture/ffmpeg'; h.context.probeDuration = async () => 1;
    const pending = h.handlers['transcode-for-playback']({}, { seriesId: '1', vidIndex: 1, filePath: input, force: true });
    await flush(); assert.ok(output);
    try {
      h.app.emit('before-quit', { preventDefault() {} });
      assert.match((await h.handlers['compat-cache-status']({})).error, /正在退出/);
      await clock.expire();
      assert.equal(h.state.errors.length, 1, 'stalled cleanup must cancel quit and tell the user');
      assert.match(h.state.errors[0].message, /取消.*退出/);
      assert.equal(h.state.quits, 0); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
      assert.equal((await h.handlers['compat-cache-status']({})).success, true, 'IPC stays locked after timeout');
      assert.equal(h.run('storageError'), null, 'quit timeout must not create an update storage blocker');
      assert.equal(fs.readFileSync(input, 'utf8'), 'original'); assert.ok(fs.existsSync(output));
      let releaseOther;
      h.context.otherJob = { controller: new AbortController(), promise: new Promise(resolve => releaseOther = resolve) };
      h.run("compatPreparing.set('other',otherJob)");
      h.app.emit('before-quit', { preventDefault() {} });
      child.emit('close', 143); await pending; await flush();
      assert.equal(h.state.quits, 0, 'old timeout callback quit during a new cleanup');
      assert.match((await h.handlers['compat-cache-status']({})).error, /正在退出/);
      h.run("compatPreparing.delete('other')"); releaseOther(); await flush();
      assert.equal(h.state.quits, 1); assert.equal(clock.pending.size, 0);
      assert.equal(fs.existsSync(output), false); assert.equal(fs.readFileSync(input, 'utf8'), 'original');
    } finally { child.emit('close', 143); await pending; }
  }],
  ['predecessor and cache-clear waits share the quit deadline and late cleanup cannot quit', async () => {
    const clock = timers(), h = fixture('darwin', clock); let release;
    h.context.oldJob = { cancelled: true, controller: new AbortController(), promise: new Promise(resolve => release = resolve) };
    h.run("compatPreparing.set(compatPathFor('1',1),oldJob)");
    const clearing = h.handlers['clear-compat-cache']({});
    const retry = h.handlers['transcode-for-playback']({}, { seriesId: '1', vidIndex: 1 });
    await flush();
    try {
      h.app.emit('before-quit', { preventDefault() {} }); await clock.expire();
      assert.equal(h.state.errors.length, 1, 'waiting predecessor/clear must not trap quit');
      assert.equal(h.state.quits, 0); assert.equal(h.run('quitCleanup'), null);
    } finally { release(); await clearing; await retry; await flush(); }
    assert.equal(h.state.quits, 0, 'late chain completion must leave the cancelled quit cancelled');
    let prevented = false; h.app.emit('before-quit', { preventDefault: () => prevented = true });
    assert.equal(prevented, false, 'a later idle quit should remain available');
  }],
  ['cache clearing alone is included in the bounded quit wait', async () => {
    const clock = timers(), h = fixture('darwin', clock); let release;
    h.context.clearing = new Promise(resolve => release = resolve); h.run('compatClearing=clearing');
    try {
      let prevented = false; h.app.emit('before-quit', { preventDefault: () => prevented = true });
      assert.equal(prevented, true, 'standalone cache cleanup was ignored');
      await clock.expire(); assert.equal(h.state.errors.length, 1); assert.equal(h.state.quits, 0);
    } finally { release(); await flush(); }
    assert.equal(h.state.quits, 0);
  }],
  ['merge timeout preserves records and lets late finally save without quitting', async () => {
    const clock = timers(), child = new EventEmitter(), signals = []; let finish;
    child.kill = signal => signals.push(signal);
    const h = fixture('darwin', { ...clock, mergeRunner: {
      stopMergeChildren: req('./src/native/merge-runner').stopMergeChildren,
      runMerge: async ({ task }) => { task.child = child; await new Promise(resolve => finish = resolve); task.status = 'stopped'; },
    } });
    const input = path.join(h.root, 'ep.mp4'); fs.writeFileSync(input, 'original');
    h.context.collectSeriesEpisodeFiles = () => ({ dir: h.root, ordered: [{ path: input, vid_index: 1 }] });
    h.context.resolveFfmpeg = () => '/fixture/ffmpeg';
    assert.equal((await h.handlers['merge-series']({}, '1')).success, true);
    try {
      h.app.emit('before-quit', { preventDefault() {} }); await clock.expire();
      assert.equal(h.state.errors.length, 1, 'stalled merge must cancel quit');
      assert.ok(signals.includes('SIGTERM')); assert.equal(h.state.quits, 0);
      assert.equal(h.state.mergeSaves.at(-1)[0].status, 'running');
    } finally { child.emit('close'); finish(); await flush(); }
    assert.equal(h.state.mergeSaves.at(-1)[0].status, 'stopped');
    assert.equal(h.state.quits, 0); assert.equal(fs.readFileSync(input, 'utf8'), 'original');
  }],
];
(async () => {
  let failed = 0;
  for (const [name, run] of checks) try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  console.log(`${checks.length - failed}/${checks.length} backend lifecycle checks passed`); process.exitCode = failed ? 1 : 0;
})().finally(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
