// Offline queue regressions. Real main-process scheduling; isolated files and mocked providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const roots = [];
const info = vid => ({ url: 'https://fixture.invalid/video.mp4', source: 'app', vid });
const rejected = code => ({ url: null, code: 'SOURCE_UNAVAILABLE', error: '取源被拒绝',
  sources: [{ source: 'web', code: 'TIMEOUT' }, { source: 'app', code }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(concurrency = 1, { requestSignal = req('./src/native/request-signal') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-source-rejection-'));
  roots.push(root);
  const handlers = {}, timers = [], events = [], app = new EventEmitter();
  const state = { calls: [], transfers: [], operations: [], load: async vid => info(vid) };
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const network = () => { throw new Error('Unexpected network request'); };
  const axios = Object.assign(network, req('axios'), { get: network, post: network, request: network });
  const context = vm.createContext({ require: name => name === 'electron'
    ? { app, ipcMain: { handle: (channel, fn) => handlers[channel] = fn }, protocol: { registerSchemesAsPrivileged() {} } }
    : name === 'axios' ? axios
    : name === './src/native/request-signal' ? requestSignal
    : name === './src/native/hongguo' ? { fetchPlayUrlSingle: async (vid, sid, options) => {
      state.calls.push([vid, options.quality]); return state.load(vid, options);
    }, markWebMediaFailure() {} }
    : name === './src/store' ? { getSettings: () => ({ root, max_concurrent: concurrency }),
      getTasks: () => state.saved || [], saveTasks: tasks => {
        state.operations.push({ event: 'save' });
        if (state.saveError) throw state.saveError;
        state.saved = JSON.parse(JSON.stringify(tasks));
        state.operations.push({ event: 'saved', tasks: state.saved });
      } } : req(name),
    __dirname: path.dirname(source), process, Buffer, URL, Response, Request, Headers, AbortController,
    console: { log() {}, warn() {}, error() {} }, setInterval: () => ({ unref() {} }),
    setTimeout: (fn, ms) => {
      if (ms < 10000) return setTimeout(fn, 0);
      const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer;
    }, clearTimeout: timer => {
      if (timer && typeof timer === 'object' && 'cleared' in timer) {
        state.operations.push({ event: 'clear', timer }); timer.cleared = true;
      } else clearTimeout(timer);
    },
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  const run = code => vm.runInContext(code, context);
  context.sendToRenderer = (channel, payload) => events.push({ channel, payload });
  context.verifyDownloadQuality = async () => '1080p';
  context.requestMedia = async playInfo => {
    state.transfers.push(playInfo.vid);
    await state.holdTransfer?.(playInfo);
    return { headers: { 'content-length': '4' }, data: Readable.from([Buffer.from('data')]) };
  };
  run('getCurrentSettings()');
  const tasks = [];
  return { state, timers, events, handlers, run, tasks,
    add(id, vid = id, status = 'pending') {
      const task = { id, type: 'hongguo', status, filename: `${id}.mp4`, customDir: root,
        savePath: path.join(root, `${id}.mp4`), downloadQuality: '1080p',
        hongguoInfo: { vid, series_id: '100', series_title: '测试剧', vid_index: tasks.length + 1 } };
      tasks.push(task); context.testTasks = tasks; run('downloadTasks = testTasks');
      return task;
    },
    pump() { run('enqueuePendingTasks(); pumpQueue()'); },
    async drain() {
      for (let n = 0; n < 100; n++) {
        if (run('downloadRuns.size')) await run('Promise.all([...downloadRuns.values()])');
        await new Promise(resolve => setTimeout(resolve, 5));
        if (!run('downloadRuns.size') && run('downloadQueue.length') && !run('activeDownloads')) {
          run('hongguoDownloadReadyAt=0;pumpQueue()');
        }
        if (!run('downloadRuns.size') && !run('downloadQueue.length') && !run('activeDownloads')) return;
      }
      throw new Error('Queue did not settle: ' + JSON.stringify({
        runs: run('downloadRuns.size'), queue: run('downloadQueue.length'), active: run('activeDownloads'),
        tasks: tasks.map(task => ({ id: task.id, status: task.status, error: task.error, retryAt: task.retryAt })),
        calls: state.calls, transfers: state.transfers,
      }));
    },
    liveTimers: () => timers.filter(timer => !timer.cleared),
  };
}
async function tick() { await new Promise(resolve => setTimeout(resolve, 25)); }

const gateMs = h => h.run('hongguoDownloadReadyAt - Date.now()');
const checks = [
  ['rejection retries only the failing episode with spacing; waiting episodes stay queued', async () => {
    for (const code of ['DEVICE_REGISTRATION_FAILED', 'HTTP_403', 'HTTP_429']) {
      const h = fixture(); const first = h.add('1'), next = h.add('2'), later = h.add('3');
      h.state.load = async () => rejected(code);
      h.pump(); await tick();
      assert.equal(first.status, 'failed', code); assert.ok(first.retryAt > Date.now());
      assert.equal(first.sourceRetries, 1); assert.equal(first.sourceRetryLimit, 6);
      assert.equal(next.status, 'pending', `${code}: waiting episode must not be stopped`);
      assert.equal(later.status, 'pending');
      assert.equal(h.state.calls.length, 1, `${code}: no lookup while the gate is closed`);
      assert.ok(gateMs(h) >= 10000, 'new lookups are held back');
      assert.equal(h.run('downloadQueue.length'), 2);
      assert.ok(h.run('sourceRetryTimers.has("1")'), 'retry timer for the failing episode');
      assert.equal(h.run('sourceRetryTimers.size'), 1);
      h.state.load = async vid => info(vid);
      h.run('sourceRetryTimers.get("1")').fn(); await h.drain();
      for (const task of h.tasks) assert.equal(task.status, 'completed', `${code}: ${task.id}`);
    }
  }],
  ['thrown registration failures and empty replies schedule per-episode retries', async () => {
    const errors = [...['HTTP_403', 'HTTP_429', 'INVALID_RESPONSE'].map(registrationFailure =>
      Object.assign(new Error('注册失败'), { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure })),
      { code: 'SOURCE_UNAVAILABLE', error: '空响应', message: '空响应', sources: [{ source: 'app', code: 'EMPTY_RESPONSE' }] }];
    for (const error of errors) {
      const h = fixture(); const first = h.add('1'), next = h.add('2');
      h.state.load = async () => { throw error; };
      h.pump(); await tick();
      assert.equal(first.status, 'failed'); assert.ok(first.retryAt); assert.equal(next.status, 'pending');
      if (error.code === 'DEVICE_REGISTRATION_FAILED') assert.equal(h.state.calls.length, 1, 'no quality fallback after a registration rejection');
    }
  }],
  ['retry spacing grows and ends in a manual failure after the last round', async () => {
    const h = fixture(); const first = h.add('1');
    h.state.load = async () => rejected('HTTP_429');
    const waits = [];
    h.pump();
    for (let round = 0; round < 6; round++) {
      await tick(); assert.equal(first.status, 'failed'); waits.push(first.retryAt - Date.now());
      h.run('sourceRetryTimers.get("1")').fn(); h.run('hongguoDownloadReadyAt=0; pumpQueue()');
    }
    await tick();
    assert.ok(waits.every((wait, i) => i === 0 || wait > waits[i - 1] - 1000), JSON.stringify(waits));
    assert.ok(waits[5] > 5 * 60000, 'last wait is minutes long');
    assert.equal(first.status, 'failed'); assert.equal(first.retryAt, undefined, 'budget exhausted: manual retry only');
  }],
  ['active transfer is unaffected and another source continues while the App gate is closed', async () => {
    const h = fixture(2), lookup = deferred(), transfer = deferred();
    h.add('1'); const active = h.add('2'), pending = h.add('3'), other = h.add('x', 'xifan:4');
    h.state.load = async vid => vid === '1' ? lookup.promise : info(vid);
    h.state.holdTransfer = async playInfo => { if (playInfo.vid === '2') await transfer.promise; };
    h.pump(); await tick();
    assert.ok(h.state.transfers.includes('2'));
    lookup.resolve(rejected('HTTP_403')); await tick();
    assert.equal(pending.status, 'pending'); assert.equal(active.status, 'downloading');
    assert.equal(active.cancelSource.token.reason, undefined);
    transfer.resolve(); await tick();
    assert.equal(active.status, 'completed'); assert.equal(other.status, 'completed');
    assert.equal(pending.status, 'pending', 'gate still closed for App lookups');
    assert.equal(h.run('activeDownloads'), 0); assert.equal(h.run('runningDownloads.size'), 0);
  }],
  ['ordinary episode errors and media HTTP errors do not pause the source', async () => {
    for (const code of ['BUSINESS_REJECTED', 'QUALITY_UNAVAILABLE', 'NO_COMPATIBLE_SOURCE', 'MISSING_MODEL', 'SECURITY_BLOCKED']) {
      const h = fixture(); const first = h.add('1'), next = h.add('2');
      h.state.load = async vid => vid === '1' ? rejected(code) : info(vid);
      h.pump(); await h.drain();
      assert.equal(first.status, 'failed'); assert.equal(next.status, 'completed', code);
    }
    const h = fixture(); h.add('1'); const next = h.add('2');
    h.state.holdTransfer = async playInfo => { if (playInfo.vid === '1') throw Object.assign(new Error('CDN HTTP 403'), { mediaStatus: 403 }); };
    h.pump(); await h.drain(); assert.equal(next.status, 'completed', 'CDN refusal is not an App source refusal');
  }],
  ['unstructured error messages and other-source structured errors cannot stop numeric tasks', async () => {
    for (const error of [new Error('DEVICE_REGISTRATION_FAILED HTTP_429'),
      { code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'web', code: 'HTTP_403' }] }]) {
      const h = fixture(); h.add('1'); const next = h.add('2');
      h.state.load = async vid => { if (vid === '1') throw error; return info(vid); };
      h.pump(); await h.drain(); assert.equal(next.status, 'completed');
    }
    const h = fixture(); h.add('x', 'xifan:1'); const next = h.add('2');
    h.state.load = async vid => vid === 'xifan:1' ? rejected('HTTP_429') : info(vid);
    h.pump(); await h.drain(); assert.equal(next.status, 'completed');
  }],
  ['manual retry, selected retry and resume take over a waiting retry without changing identity or quality', async () => {
    for (const channel of ['retry-task', 'retry-tasks', 'resume-all']) {
      const h = fixture(); const first = h.add('1');
      h.state.load = async () => rejected('HTTP_429'); h.pump(); await tick();
      assert.equal(first.status, 'failed'); assert.ok(first.retryAt);
      h.state.load = async vid => info(vid);
      const result = await h.handlers[channel]({}, channel === 'retry-tasks' ? ['1'] : '1');
      assert.equal(result.success, true); await h.drain();
      assert.equal(first.status, 'completed'); assert.equal(first.downloadQuality, '1080p');
      assert.equal(first.retryAt, undefined); assert.equal(h.tasks.filter(task => task.id === '1').length, 1);
    }
  }],
  ['source rejection raised during consumption stops before trying quality alternatives', async () => {
    const h = fixture(); h.state.load = async vid => ({ ...info(vid), variants: [info('backup')] });
    let consumes = 0;
    await assert.rejects(h.run('withMediaRecovery')( '1', '100', { quality: '1080p', allowLowerQuality: true }, async () => {
      consumes++; throw rejected('HTTP_429');
    }));
    assert.equal(consumes, 1); assert.equal(h.state.calls.length, 1);
  }],
];

(async () => {
  let failures = 0;
  try {
    for (const [name, check] of checks) {
      try { await check(); console.log(`PASS ${name}`); }
      catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
    }
  } finally { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); }
  console.log(`${checks.length - failures}/${checks.length} download source rejection checks passed`);
  process.exitCode = failures ? 1 : 0;
})();
