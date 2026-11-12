// Offline lifecycle checks through the real main IPC; no real media/network/FFmpeg.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-compat-lifecycle-'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let failures = 0, serial = 0;
function load({ permission, manual = false, probe, encoder = 'libx264', exitCodes = [] } = {}) {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  const handlers = {}, events = [], children = [], app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} } };
  const metrics = { media: 0, encoder: 0, permissions: 0 };
  const childProcess = { spawn(_file, args) {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.args = args; child.input = fs.readFileSync(args[args.indexOf('-i') + 1]); child.output = args.at(-1); child.killed = false; child.closed = false;
    child.finish = (code = 0) => { if (child.closed) return; child.closed = true; if (code === 0) fs.writeFileSync(child.output, Buffer.alloc(120000)); child.emit('close', code); };
    child.kill = () => { child.killed = true; if (!manual) setImmediate(() => child.finish(143)); return true; };
    const exitCode = exitCodes[children.length] ?? 0;
    children.push(child); if (!manual) setImmediate(() => child.finish(child.killed ? 143 : exitCode)); return child;
  } };
  const native = { fetchEpisodeList: async () => { metrics.permissions++; return permission ? permission() : { episodes: [{ vid: 'xifan:v', vid_index: 1, locked: false }] }; } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === 'child_process' ? childProcess : name === './src/native/hongguo' ? native : name === './src/store' ? { getSettings: () => ({}) } : req(name), __dirname: path.dirname(source), process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout, console: { log() {}, error() {}, warn() {} } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  context.resolveFfmpeg = () => '/fixture/ffmpeg';
  context.fetchDecryptedEpisode = async () => { metrics.media++; return Buffer.alloc(120000); };
  context.probeDuration = probe || (async () => 1);
  context.pickH264Encoder = async () => { metrics.encoder++; return encoder; };
  context.sendToRenderer = (name, data) => events.push({ name, ...data });
  return { context, handlers, dir, children, metrics, events, run: code => vm.runInContext(code, context) };
}
const payload = requestId => ({ seriesId: 'xifan:S', vid: 'xifan:v', vidIndex: 1, requestId, force: true });
const unlocked = { episodes: [{ vid: 'xifan:v', vid_index: 1, locked: false }] };
async function check(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); } }
(async () => {
  await check('cancel during source permission lookup prevents media and encoder work', async () => {
    const gate = deferred(), h = load({ permission: () => gate.promise });
    const started = h.handlers['transcode-for-playback']({}, payload('permission-cancel')); await tick();
    const stopped = h.handlers['cancel-transcode-for-playback']({}, payload('permission-cancel'));
    gate.resolve(unlocked); const result = await started; await stopped;
    assert.equal(result.success, false, 'cancelled permission lookup later started transcode');
    assert.equal(h.metrics.media, 0); assert.equal(h.children.length, 0); assert.equal(h.run('compatPreparing.size'), 0);
  });
  await check('same episode retry waits for old work; stale cancel cannot kill the retry', async () => {
    const h = load({ manual: true });
    const old = h.handlers['transcode-for-playback']({}, payload('old')); await tick(); await tick();
    assert.equal(h.children.length, 1);
    const cancelled = h.handlers['cancel-transcode-for-playback']({}, payload('old'));
    const next = h.handlers['transcode-for-playback']({}, payload('next')); await tick();
    assert.equal(h.children.length, 1, 'retry overlapped old encoder');
    h.children[0].finish(143); await old; await cancelled; await tick(); await tick();
    assert.equal(h.children.length, 2);
    const staleCancel = h.handlers['cancel-transcode-for-playback']({}, payload('old')); await tick();
    const wasKilled = h.children[1].killed;
    h.children[1].finish(wasKilled ? 143 : 0); const result = await next; await staleCancel;
    assert.equal(wasKilled, false, 'an old request ID cancelled the current request'); assert.equal(result.success, true);
    assert.ok(h.events.some(event => event.name === 'transcode-progress' && event.done && event.requestId === 'next'), 'progress must carry current request ID');
  });
  await check('locked source remains blocked even when compatibility cache exists', async () => {
    const h = load({ permission: async () => ({ episodes: [{ vid: 'xifan:v', vid_index: 1, locked: true }] }) });
    fs.writeFileSync(h.context.compatPathFor('xifan:S', 1), Buffer.alloc(120000));
    const result = await h.handlers['transcode-for-playback']({}, { ...payload('locked'), force: false });
    assert.equal(result.success, false); assert.match(result.error, /锁定/); assert.equal(h.metrics.media, 0); assert.equal(h.children.length, 0);
  });
  await check('clear cache cancels permission-pending jobs before they can publish output', async () => {
    const gate = deferred(), h = load({ permission: () => gate.promise });
    const started = h.handlers['transcode-for-playback']({}, payload('clear')); await tick();
    const cleared = h.handlers['clear-compat-cache']({}); gate.resolve(unlocked);
    const result = await started; await cleared;
    assert.equal(result.success, false, 'cleared pending work later published output'); assert.equal(h.metrics.media, 0);
    assert.deepEqual(fs.readdirSync(h.context.getCompatDir()), []); assert.equal(h.run('compatPreparing.size'), 0);
  });
  await check('cancel after duration probe never starts encoder discovery', async () => {
    const gate = deferred(), h = load({ probe: () => gate.promise });
    const started = h.handlers['transcode-for-playback']({}, payload('probe')); await tick(); await tick();
    const cancelled = h.handlers['cancel-transcode-for-playback']({}, payload('probe'));
    gate.resolve(1); const result = await started; await cancelled;
    assert.equal(result.success, false); assert.equal(h.metrics.encoder, 0, 'cancelled job still ran FFmpeg encoder probes');
    assert.deepEqual(fs.readdirSync(h.context.getCompatDir()), []);
  });
  await check('preparation error removes temporary input and releases its job', async () => {
    const h = load({ probe: async () => { throw new Error('fixture probe failure'); } });
    const result = await h.handlers['transcode-for-playback']({}, payload('probe-error'));
    assert.equal(result.success, false); assert.match(result.error, /fixture probe failure/);
    assert.deepEqual(fs.readdirSync(h.context.getCompatDir()), []); assert.equal(h.run('compatPreparing.size'), 0);
  });
  await check('cancelling one shared request keeps the other client alive', async () => {
    const gate = deferred(), h = load({ permission: () => gate.promise });
    const first = h.handlers['transcode-for-playback']({}, payload('shared-first'));
    const second = h.handlers['transcode-for-playback']({}, payload('shared-second')); await tick();
    await h.handlers['cancel-transcode-for-playback']({}, payload('shared-first'));
    gate.resolve(unlocked);
    assert.equal((await first).success, false); assert.equal((await second).success, true);
    assert.equal(h.metrics.permissions, 1); assert.equal(h.children.length, 1);
    assert.ok(h.events.filter(event => event.name === 'transcode-progress').every(event => event.requestId === 'shared-second'));
  });
  await check('new requests wait until cache clearing has finished', async () => {
    const gate = deferred(), h = load({ permission: () => gate.promise });
    const old = h.handlers['transcode-for-playback']({}, payload('before-clear')); await tick();
    const clearing = h.handlers['clear-compat-cache']({});
    const next = h.handlers['transcode-for-playback']({}, payload('after-clear')); await tick();
    assert.equal(h.metrics.permissions, 1, 'new work started during cache cleanup');
    gate.resolve(unlocked); await clearing;
    assert.equal((await old).success, false); assert.equal((await next).success, true);
    assert.equal(h.metrics.media, 1); assert.equal(fs.readdirSync(h.context.getCompatDir()).length, 1);
  });
  await check('actual hardware failure retries once with software and reports final encoder', async () => {
    const h = load({ encoder: 'h264_videotoolbox', exitCodes: [1, 0] });
    const result = await h.handlers['transcode-for-playback']({}, { ...payload('hardware-fallback'), force: false });
    assert.equal(result.success, true, 'hardware failure should retry in software');
    assert.equal(result.encoder, 'libx264'); assert.equal(h.children.length, 2);
    assert.deepEqual(h.children.map(child => child.args[child.args.indexOf('-c:v') + 1]), ['h264_videotoolbox', 'libx264']);
    assert.deepEqual(fs.readdirSync(h.context.getCompatDir()), [path.basename(h.context.compatPathFor('xifan:S', 1))]);
  });
  await check('software fallback failure stops after two attempts and cleans temporary files', async () => {
    const h = load({ encoder: 'h264_nvenc', exitCodes: [1, 2] });
    const result = await h.handlers['transcode-for-playback']({}, { ...payload('software-failure'), force: false });
    assert.equal(result.success, false); assert.equal(h.children.length, 2);
    assert.match(result.error, /软件转码失败.*2/);
    assert.deepEqual(fs.readdirSync(h.context.getCompatDir()), []); assert.equal(h.run('compatPreparing.size'), 0);
  });
  await check('cancelling hardware transcode never starts software fallback', async () => {
    const h = load({ encoder: 'h264_nvenc', manual: true });
    const started = h.handlers['transcode-for-playback']({}, { ...payload('hardware-cancel'), force: false }); await tick(); await tick();
    const cancelled = h.handlers['cancel-transcode-for-playback']({}, payload('hardware-cancel'));
    h.children[0].finish(143); const result = await started; await cancelled;
    assert.equal(result.cancelled, true); assert.equal(h.children.length, 1);
    assert.deepEqual(fs.readdirSync(h.context.getCompatDir()), []);
  });
  await check('force rebuild bypasses both caches and encoder probes', async () => {
    const h = load({ encoder: 'h264_nvenc' });
    fs.writeFileSync(h.context.compatPathFor('xifan:S', 1), Buffer.alloc(120000, 1));
    h.run("onlineCache.set('xifan:v', { buffer: Buffer.alloc(120000, 2) })");
    const result = await h.handlers['transcode-for-playback']({}, payload('force-rebuild'));
    assert.equal(result.success, true); assert.equal(result.cached, undefined);
    assert.equal(h.metrics.media, 1, 'force must fetch fresh source bytes'); assert.equal(h.metrics.encoder, 0, 'force must not probe hardware');
    assert.equal(result.encoder, 'libx264'); assert.equal(h.children.length, 1);
    assert.equal(h.children[0].input[0], 0); assert.equal(fs.readFileSync(h.context.compatPathFor('xifan:S', 1))[0], 0);
  });
  await check('force preserves downloaded original and uses it before online input', async () => {
    const h = load({ encoder: 'h264_nvenc' }), filePath = path.join(h.dir, 'downloaded.mp4');
    fs.writeFileSync(filePath, Buffer.alloc(120000, 7));
    const result = await h.handlers['transcode-for-playback']({}, { ...payload('force-local'), filePath });
    assert.equal(result.success, true); assert.equal(result.encoder, 'libx264');
    assert.equal(h.metrics.media, 0); assert.equal(h.children[0].input[0], 7);
    assert.equal(fs.readFileSync(filePath)[0], 7); assert.equal(fs.statSync(filePath).size, 120000);
  });
  await check('forced software failure stops after one attempt', async () => {
    const h = load({ encoder: 'h264_nvenc', exitCodes: [9] });
    const result = await h.handlers['transcode-for-playback']({}, payload('force-failure'));
    assert.equal(result.success, false); assert.match(result.error, /软件转码失败.*9/);
    assert.equal(h.children.length, 1); assert.equal(h.metrics.encoder, 0);
    assert.deepEqual(fs.readdirSync(h.context.getCompatDir()), []);
  });
  assert.equal(failures, 0, `${failures} compatibility lifecycle regressions`);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
