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

function fixture(concurrency = 1) {
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
      for (let n = 0; n < 30; n++) {
        if (!run('downloadRuns.size')) return;
        await run('Promise.all([...downloadRuns.values()])');
      }
      throw new Error('Queue did not settle');
    },
    liveTimers: () => timers.filter(timer => !timer.cleared),
  };
}
async function tick() { for (let n = 0; n < 10; n++) await new Promise(setImmediate); }

const checks = [
  ['registration and App HTTP rejection preserve unstarted tasks instead of failing the queue', async () => {
    for (const code of ['DEVICE_REGISTRATION_FAILED', 'HTTP_403', 'HTTP_429']) {
      const h = fixture(); h.add('1'); const next = h.add('2'), later = h.add('3');
      h.state.load = async () => rejected(code);
      h.pump(); await h.drain();
      assert.equal(next.status, 'stopped', `${code}: next task must stay unstarted`);
      assert.equal(later.status, 'stopped');
      assert.equal(h.state.calls.length, 1, `${code}: no fallback or subsequent source lookup`);
      assert.match(next.error, /暂停.*手动/);
      assert.equal(h.run('downloadQueue.length'), 0);
      assert.equal(h.liveTimers().length, 0);
      assert.equal(h.state.saved.find(task => task.id === '2').status, 'stopped');
      h.run('loadDownloadTasks(); enqueuePendingTasks(); pumpQueue()'); await h.drain();
      assert.equal(h.state.calls.length, 1, 'restart must not automatically probe paused tasks');
    }
  }],
  ['thrown registration failures stop before quality fallback without inspecting error text', async () => {
    for (const registrationFailure of ['HTTP_403', 'HTTP_429', 'INVALID_RESPONSE']) {
      const h = fixture(); h.add('1'); const next = h.add('2');
      h.state.load = async () => { throw Object.assign(new Error('注册失败'), { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure }); };
      h.pump(); await h.drain();
      assert.equal(next.status, 'stopped'); assert.equal(h.state.calls.length, 1);
    }
  }],
  ['rejection cancels numeric-source retry timers but keeps other-source timers', async () => {
    const h = fixture(); h.add('1');
    const numeric = h.add('2', '2', 'failed'), other = h.add('x', 'xifan:2', 'failed');
    for (const task of [numeric, other]) { task.retryAt = Date.now() + 60000; task.sourceRetries = 1; }
    h.run('for (const task of downloadTasks.filter(t => t.retryAt)) armSourceRetry(task)');
    const staleTimer = h.timers[0];
    h.state.load = async () => rejected('HTTP_429');
    h.pump(); await h.drain();
    assert.equal(numeric.status, 'stopped'); assert.equal(numeric.retryAt, undefined);
    assert.equal(numeric.sourceRetries, undefined); assert.equal(staleTimer.cleared, true);
    const savedAt = h.state.operations.findIndex(op => op.event === 'saved' && op.tasks.find(task => task.id === '2')?.status === 'stopped');
    const clearedAt = h.state.operations.findIndex(op => op.event === 'clear' && op.timer === staleTimer);
    assert.ok(savedAt >= 0 && savedAt < clearedAt, 'paused state must be saved before cancelling its timer');
    assert.equal(other.status, 'failed'); assert.ok(other.retryAt); assert.equal(h.liveTimers().length, 1);
    staleTimer.fn(); await h.drain();
    assert.equal(h.state.calls.length, 1, 'late cancelled timer cannot restart a paused task');
  }],
  ['active transfer completes while pending numeric tasks stop and another source continues', async () => {
    const h = fixture(2), lookup = deferred(), transfer = deferred();
    h.add('1'); const active = h.add('2'), pending = h.add('3'), other = h.add('x', 'xifan:4');
    h.state.load = async vid => vid === '1' ? lookup.promise : info(vid);
    h.state.holdTransfer = async playInfo => { if (playInfo.vid === '2') await transfer.promise; };
    h.pump(); await tick();
    assert.ok(h.state.transfers.includes('2'));
    lookup.resolve(rejected('HTTP_403')); await tick();
    assert.equal(pending.status, 'stopped'); assert.equal(active.status, 'downloading');
    assert.equal(active.cancelSource.token.reason, undefined);
    transfer.resolve(); await h.drain();
    assert.equal(active.status, 'completed'); assert.equal(other.status, 'completed');
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
  ['manual retry, selected retry and resume keep the same paused task identity and quality', async () => {
    for (const channel of ['retry-task', 'retry-tasks', 'resume-all']) {
      const h = fixture(); h.add('1'); const next = h.add('2');
      h.state.load = async () => rejected('HTTP_429'); h.pump(); await h.drain();
      assert.equal(next.status, 'stopped');
      h.state.load = async vid => info(vid);
      const result = await h.handlers[channel]({}, channel === 'retry-tasks' ? ['2'] : '2');
      assert.equal(result.success, true); await h.drain();
      assert.equal(next.status, 'completed'); assert.equal(next.downloadQuality, '1080p');
      assert.equal(h.tasks.filter(task => task.id === '2').length, 1);
    }
  }],
  ['save failure keeps rejected-source work stopped in memory without automatic retries', async () => {
    const h = fixture(); h.add('1'); const next = h.add('2');
    const delayed = h.add('3', '3', 'failed'); delayed.retryAt = Date.now() + 60000;
    h.run('armSourceRetry(downloadTasks[2])');
    const staleTimer = h.timers[0];
    h.state.load = async () => { h.state.saveError = new Error('disk full'); return rejected('HTTP_429'); };
    h.pump(); await h.drain();
    assert.equal(next.status, 'stopped'); assert.equal(delayed.status, 'stopped');
    assert.equal(h.state.calls.length, 1);
    assert.equal(staleTimer.cleared, false, 'failed persistence must not cancel resources');
    assert.equal(h.state.saved.find(task => task.id === '3').status, 'failed', 'paused state was not persisted');
    assert.equal(delayed.retryAt, undefined); assert.equal(delayed.sourceRetries, undefined);
    staleTimer.fn(); await h.drain();
    assert.equal(delayed.status, 'stopped'); assert.equal(h.state.calls.length, 1, 'late timer must not fetch again');
    assert.equal(h.run('sourceRetryTimers.has("3")'), false);
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
