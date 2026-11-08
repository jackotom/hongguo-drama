// Isolated main-process checks for delayed source retries. No network, GUI or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const dirs = [];
const unavailable = (sources) => ({ url: null, code: 'SOURCE_UNAVAILABLE', sources,
  error: '本集取源失败：网页：请求失败（HTTP 404）；App：暂未提供本集片源模型；旧接口：片源数据无法解析。请重试或在官方 App 确认可播情况。' });
const webGone = [{ source: 'web', code: 'HTTP_404' }, { source: 'app', code: 'MISSING_MODEL' }, { source: 'api', code: 'INVALID_RESPONSE' }];
function fixture(initialTasks) {
  const now = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-source-retry-'));
  dirs.push(root);
  const handlers = {}, timers = [], app = new EventEmitter(), state = { result: unavailable(webGone), calls: 0, qualities: [] };
  let settings = { root }, saved = initialTasks, ready, reportStorageError;
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, getLocale: () => 'zh-CN',
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then(fn) { ready = fn; } }) });
  // Scheduled retries are fired manually; immediate recovery still uses short timers.
  const fakeSetTimeout = (fn, ms, ...args) => {
    if (ms < 10000) return setTimeout(fn, Math.min(ms, 5), ...args);
    const timer = { fn, ms, cleared: false, unref() { this.background = true; return this; } }; timers.push(timer); return timer;
  };
  const fakeClearTimeout = timer => { if (timer && 'cleared' in timer) timer.cleared = true; else clearTimeout(timer); };
  const context = vm.createContext({ require: n => n === 'electron'
    ? { app, ipcMain: { handle: (n, f) => handlers[n] = f }, protocol: { registerSchemesAsPrivileged() {} },
      Menu: { buildFromTemplate: items => items, setApplicationMenu() {} } }
    : n === 'axios' ? Object.assign((...args) => state.transportError ? Promise.reject(state.transportError) : req(n)(...args), req(n))
    : n === './src/native/hongguo' ? { fetchPlayUrlSingle: async (_vid, _sid, options) => { state.calls++; state.qualities.push(options.quality); return state.result; }, markWebMediaFailure() {} }
    : n === './src/store' ? { getSettings: () => settings, saveSettings: s => settings = s,
      init() {}, getTasks: () => JSON.parse(JSON.stringify(saved || [])), getSeries: () => [], getMergeTasks: () => [],
      setErrorHandler: fn => reportStorageError = fn,
      saveTasks: tasks => {
        if (state.saveError) { reportStorageError({ error: '保存失败，请检查磁盘空间或目录权限；本次变更未能保存。' }); throw state.saveError; }
        saved = JSON.parse(JSON.stringify(tasks));
      } } : req(n),
    __dirname: path.dirname(source), Date: class extends Date { static now() { return now; } }, console: { log() {}, warn() {}, error() {} },
    process, Buffer, URL, Response, Request, Headers, AbortController, setInterval: () => ({ unref() {} }), setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    testReadStream: () => Readable.from([Buffer.alloc(200000)]) });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  const run = text => vm.runInContext(text, context);
  run(`const originalPumpQueue = pumpQueue, originalRequestMedia = requestMedia; pumpQueue = () => {}; resolveFfmpeg = () => '/test/ffprobe';
    verifyDownloadDecode = async () => {};
    probeVideoInfo = async () => ({ w: 1080, h: 1920, duration: 12, codec: 'h264' });
    requestMedia = async () => ({headers: {'content-length': '200000'}, data: testReadStream()});
    downloadTasks = [{ id: 't1', type: 'hongguo', status: 'pending', filename: 'ep13.mp4', downloadQuality: 'auto',
      hongguoInfo: { vid: '7688671683959327768', series_id: '1', series_title: '测试剧', vid_index: 13 } }];`);
  const task = () => run('downloadTasks[0]');
  const live = () => timers.filter(timer => !timer.cleared && !timer.background);
  return { run, handlers, state, timers, live, task, saved: () => saved,
    start: async () => {
      // Keep the actual app.whenReady callback, loadDownloadTasks and retry scheduling.
      run(`rebuildSeriesRegistryFromTasks = () => {}; rescanDownloadsFromDisk = () => {};
        registerStreamProtocol = () => {}; registerLocalProtocol = () => {};
        applyProxySettings = async () => {}; createWindow = () => {}; refreshWatchHistory = async () => {};`);
      await ready();
    },
    download: () => run('executeHongguoDownload(downloadTasks[0])'),
    fire: () => { const timer = live().at(-1); timer.cleared = true; timer.fn(); } };
}
const checks = [
  ['real media error wrapping preserves a security block without deferred retries', async () => {
    const h = fixture();
    h.state.result = {url:'https://media.example/video.mp4',source:'app'};
    h.state.transportError = Object.assign(new Error('blocked'), {cause:{code:'ERR_WEB_MEDIA_ADDRESS'}});
    h.run('requestMedia = originalRequestMedia');
    await h.download();
    assert.equal(h.task().status,'failed');
    assert.equal(h.live().length,0,'security rejection must not turn into a scheduled network retry');
  }],
  ['network outages and incomplete bodies recover with a bounded short delay', async () => {
    for (const code of ['ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ERR_NETWORK', 'incomplete']) {
      const h = fixture();
      h.state.result = { url: 'https://media.example/video.mp4', source: 'app' };
      h.run(code === 'incomplete'
        ? `requestMedia = async () => ({headers: {'content-length': '300000'}, data: testReadStream()});`
        : `requestMedia = async () => { throw Object.assign(new Error('offline'), { code: '${code}' }); };`);
      for (const [index, seconds] of [10, 30, 60].entries()) {
        await h.download();
        assert.equal(h.task().status, 'failed');
        assert.equal(h.live().length, 1, `${code}: must schedule recovery`);
        assert.equal(h.live()[0].ms, seconds * 1000);
        assert.equal(h.task().sourceRetries, index + 1);
        assert.match(h.task().error, new RegExp(`${seconds} 秒后自动重试`));
        assert.equal(fs.existsSync(h.task().savePath), false, 'never publish partial media');
        h.fire();
      }
      await h.download();
      assert.equal(h.live().length, 0, 'no infinite retry loop');
      assert.equal(h.task().retryAt, undefined);
    }
  }],
  ['short retry succeeds without overwriting completed files and stops on cancellation', async () => {
    const h = fixture();
    h.state.result = { url: 'https://media.example/video.mp4', source: 'app' };
    h.run(`requestMedia = async () => { throw Object.assign(new Error('offline'), {code: 'ENOTFOUND'}); };`);
    await h.download();
    assert.equal(h.live().length, 1);
    h.fire();
    h.run(`requestMedia = async () => ({headers: {'content-length': '200000'}, data: testReadStream()});`);
    await h.download();
    assert.equal(h.task().status, 'completed');
    const before = fs.readFileSync(h.task().savePath);
    h.run(`requestMedia = async () => { throw new Error('completed files must not be downloaded again'); };`);
    await h.download();
    assert.equal(h.task().status, 'completed');
    assert.deepEqual(fs.readFileSync(h.task().savePath), before);
    for (const action of ['stop-download', 'pause-all']) {
      const g = fixture();
      g.state.result = h.state.result;
      g.run(`requestMedia = async () => { throw Object.assign(new Error('offline'), {code: 'ENOTFOUND'}); };`);
      await g.download();
      const timer = g.live()[0];
      assert.ok(timer);
      await g.handlers[action]({}, 't1');
      timer.fn();
      assert.equal(g.task().status, 'stopped');
      assert.equal(g.live().length, 0);
      assert.equal(g.run('downloadQueue.length'), 0);
    }
  }],
  ['disk errors, security blocks and access refusals never schedule transport retries', async () => {
    for (const failure of [{code:'ENOSPC'}, {code:'EACCES'}, {code:'ERR_WEB_MEDIA_ADDRESS',mediaRetryable:true},
      {mediaStatus:401,mediaRetryable:true}, {mediaStatus:403,mediaRetryable:true}, {mediaStatus:429,mediaRetryable:true}]) {
      const h = fixture();
      h.state.result = {url:'https://media.example/video.mp4',source:'app'};
      h.run(`requestMedia = async () => { throw Object.assign(new Error('unrecoverable'), ${JSON.stringify(failure)}); };`);
      await h.download();
      assert.equal(h.live().length, 0, JSON.stringify(failure));
    }
  }],
  ['web 404 plus missing App model schedules bounded delayed retries', async () => {
    const h = fixture();
    for (const [index, minutes] of [3, 8, 15].entries()) {
      await h.download();
      assert.equal(h.task().status, 'failed');
      assert.equal(h.task().sourceRetries, index + 1);
      assert.match(h.task().error, new RegExp(`${minutes} 分钟后自动重试（${index + 1}/3）`));
      assert.equal(h.live().length, 1);
      assert.equal(h.live()[0].ms, minutes * 60000);
      assert.equal(h.saved()[0].retryAt, h.task().retryAt, 'schedule persists across restarts');
      h.fire();
      assert.equal(h.task().status, 'pending');
      assert.equal(h.run('downloadQueue.some(t => t.id === "t1")'), true);
    }
    await h.download();
    assert.equal(h.task().status, 'failed');
    assert.equal(h.task().retryAt, undefined, 'stops after the retry budget');
    assert.doesNotMatch(h.task().error, /自动重试/);
    assert.equal(h.live().length, 0);
  }],
  ['App refusal, security and third-party failures are not deferred', async () => {
    for (const [sources, vid] of [[[{ source: 'app', code: 'BUSINESS_REJECTED' }]], [[{ source: 'app', code: 'HTTP_403' }]], [[{ source: 'web', code: 'HTTP_404' }, { source: 'app', code: 'BUSINESS_REJECTED' }]], [[{ source: 'web', code: 'TIMEOUT' }, { source: 'app', code: 'DEVICE_REGISTRATION_FAILED' }]], [[{ source: 'web', code: 'SECURITY_BLOCKED' }]], [[{ source: 'app', code: 'TIMEOUT' }, { source: 'web', code: 'SECURITY_BLOCKED' }]], [webGone, 'custom:a:1']]) {
      const h = fixture();
      h.state.result = unavailable(sources);
      if (vid) h.run(`downloadTasks[0].hongguoInfo.vid = ${JSON.stringify(vid)}`);
      await h.download();
      assert.equal(h.task().status, 'failed');
      assert.equal(h.task().retryAt, undefined);
      assert.equal(h.live().length, 0);
    }
  }],
  ['temporary App-only failures retry later without losing selected quality', async () => {
    for (const quality of ['720p', '1080p']) for (const code of ['TIMEOUT', 'NETWORK_ERROR', 'HTTP_408', 'HTTP_503']) {
      const h = fixture();
      h.task().downloadQuality = quality;
      h.state.result = unavailable([{ source: 'app', code }]);
      await h.download();
      assert.equal(h.task().status, 'failed');
      assert.equal(h.live().length, 1, `${quality}: ${code} must retain delayed recovery`);
      assert.equal(h.live()[0].ms, 3 * 60000);
      assert.equal(h.task().sourceRetries, 1);
      h.fire();
      h.state.result = { url: 'https://media.example/video.mp4', source: 'app' };
      await h.download();
      assert.equal(h.task().status, 'completed', h.task().error);
      assert.ok(h.state.qualities.every(value => value === quality), 'retry must not fall back to automatic quality');
      assert.equal(h.task().retryAt, undefined);
      assert.equal(h.task().sourceRetries, undefined);
    }
  }],
  ['temporary transfer failures retry later while explicit refusals stay manual', async () => {
    for (const failure of [{ code: 'ECONNRESET' }, { mediaStatus: 408, mediaRetryable: true },
      { mediaStatus: 503, mediaRetryable: true }, { mediaStatus: 403, mediaRetryable: true }]) {
      const h = fixture();
      h.task().downloadQuality = '1080p';
      h.state.result = { url: 'https://media.example/video.mp4', source: 'app' };
      h.run(`requestMedia = async () => { throw Object.assign(new Error('transfer failed'), ${JSON.stringify(failure)}); };`);
      await h.download();
      assert.equal(h.task().status, 'failed');
      assert.equal(h.live().length, failure.mediaStatus === 403 ? 0 : 1, JSON.stringify(failure));
      assert.equal(h.task().downloadQuality, '1080p');
    }
  }],
  ['media 404/410 do not defer App-only explicit quality, but preserve automatic quality retries', async () => {
    for (const status of [404, 410]) for (const quality of ['720p', '1080p', 'auto', undefined]) {
      const h = fixture();
      h.task().downloadQuality = quality;
      h.state.result = { url: 'https://media.example/video.mp4', source: 'app' };
      h.run(`requestMedia = async () => { throw Object.assign(new Error('HTTP ${status}'), {mediaStatus: ${status}, mediaRetryable: true}); };`);
      await h.download();
      assert.equal(h.task().status, 'failed');
      assert.equal(h.state.calls, 3, 'immediate source refresh still runs');
      assert.equal(h.live().length, quality === 'auto' || quality === undefined ? 1 : 0, `${quality}: HTTP ${status}`);
    }
  }],
  ['expired retry waiting for a slot survives the actual startup loading path', async () => {
    const h = fixture();
    await h.download();
    const retryAt = h.task().retryAt;
    h.run('pumpQueue = originalPumpQueue; activeDownloads = MAX_CONCURRENT_DOWNLOADS');
    h.fire();
    assert.equal(h.task().status, 'pending');
    const restarted = fixture(h.saved());
    await restarted.start();
    assert.equal(restarted.task().status, 'failed');
    assert.equal(restarted.live().length, 1, 'startup must re-arm a retry that had only reached the queue');
    assert.equal(restarted.task().retryAt, retryAt);
    assert.equal(restarted.task().sourceRetries, 1, 'restart retains the used budget');
    restarted.fire();
    assert.equal(restarted.task().status, 'pending');
    restarted.state.result = { url: 'https://media.example/video.mp4', source: 'web' };
    await restarted.download();
    assert.equal(restarted.task().status, 'completed', restarted.task().error);
    assert.equal(restarted.task().retryAt, undefined, 'running the transfer consumes the plan');
  }],
  ['pausing a deferred task waiting for a slot clears its plan and budget', async () => {
    for (const action of ['pause-all', 'stop-download']) {
      const h = fixture();
      await h.download();
      h.fire();
      await h.handlers[action]({}, 't1');
      assert.equal(h.task().status, 'stopped');
      assert.equal(h.task().retryAt, undefined);
      assert.equal(h.task().sourceRetries, undefined, action);
      const restarted = fixture(h.saved());
      await restarted.start();
      assert.equal(restarted.live().length, 0, 'paused tasks stay paused on restart');
    }
  }],
  ['pause and stop preserve a durable retry plan when saving fails', async () => {
    for (const action of ['pause-all', 'stop-download']) {
      const h = fixture();
      await h.download();
      const retryAt = h.task().retryAt;
      h.state.saveError = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      await assert.rejects(h.handlers[action]({}, 't1'));
      assert.equal(h.task().status, 'failed', action);
      assert.equal(h.task().retryAt, retryAt, action);
      assert.equal(h.saved()[0].retryAt, retryAt, action);
      assert.equal(h.live().length, 1, action + ' must retain its original timer');
    }
  }],
  ['timer persistence failure is contained and leaves manual retry available', async () => {
    const h = fixture();
    await h.download();
    const retryAt = h.task().retryAt;
    h.state.saveError = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    assert.doesNotThrow(() => h.fire(), 'storage errors must not escape the timer');
    assert.equal(h.task().status, 'failed');
    assert.equal(h.task().retryAt, undefined, 'no active timer: expose manual retry in the current UI');
    assert.equal(h.saved()[0].retryAt, retryAt, 'keep the previous durable plan for restart recovery');
    assert.equal(h.run('downloadQueue.length'), 0, 'failed persistence removes this automatic queue entry');
    assert.equal(h.live().length, 0, 'do not create an automatic write-failure loop');
    assert.match(h.run('storageError.error'), /保存失败/);
    assert.equal(h.saved()[0].status, 'failed', 'last durable task remains untouched');
    h.state.saveError = null;
    assert.equal((await h.handlers['retry-task']({}, 't1')).success, true);
    assert.equal(h.task().status, 'pending');
    assert.equal(h.task().retryAt, undefined);
  }],
  ['manual retry and pause take over a scheduled retry', async () => {
    const h = fixture();
    await h.download();
    assert.equal(h.live().length, 1);
    assert.equal((await h.handlers['retry-task']({}, 't1')).success, true);
    assert.equal(h.live().length, 0);
    assert.equal(h.task().sourceRetries, undefined, 'manual retry restores the full budget');
    assert.equal(h.task().status, 'pending');
    await h.download();
    assert.equal(h.live().length, 1);
    assert.equal((await h.handlers['pause-all']({})).count, 1);
    assert.equal(h.task().status, 'stopped');
    assert.equal(h.live().length, 0);
  }],
  ['a stale timer after deletion does nothing; success clears the budget', async () => {
    const h = fixture();
    await h.download();
    const timer = h.live()[0];
    h.run('downloadTasks = []');
    timer.fn();
    assert.equal(h.run('downloadQueue.length'), 0);
    const g = fixture();
    await g.download();
    g.fire();
    g.state.result = { url: 'https://media.example/video.mp4', source: 'web' };
    await g.download();
    assert.equal(g.task().status, 'completed', g.task().error);
    assert.equal(g.task().sourceRetries, undefined);
    assert.equal(g.task().retryAt, undefined);
  }],
];
(async () => {
  let failed = 0;
  for (const [name, check] of checks) {
    try { await check(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})();
