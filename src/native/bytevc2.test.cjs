const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');

function fixture(t, { code = 0, seconds = 60, wait = false, hardware = false, codes = [], errors = [], outputBytes = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bytevc2-'));
  const input = path.join(root, 'input'), output = path.join(root, 'output');
  fs.writeFileSync(input, 'synthetic process fixture, never played');
  const calls = [], kills = [], children = [];
  t.after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });
  mock.method(cp, 'spawn', (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter();
    children.push(child);
    const index = children.length - 1;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => {
      fs.writeFileSync(args.at(-1), outputBytes[index] ? Buffer.alloc(outputBytes[index]) : 'process output');
      child.stderr.write(errors[index] || 'PRIVATE_KEY_AND_PATH_SENTINEL');
      if (!wait) {
        child.stdout.write(`out_time_us=${seconds * 1000000}\nprogress=end\n`);
        child.emit('close', codes[index] ?? code);
      }
    });
    return child;
  });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'bytevc2.js'), 'utf8'), {
    module, require, process: { platform: hardware ? 'darwin' : 'linux', arch: hardware ? 'arm64' : 'x64' },
    setTimeout, clearTimeout,
  });
  return { input, output, calls, kills, children, finish: (index, code = 0) => {
    children[index].stdout.write('out_time_us=60000000\nprogress=end\n');
    children[index].emit('close', code);
  }, run: extra => module.exports.convertBytevc2({ executable: '/fixture/librempeg', input, output, duration: 60, ...extra }) };
}

test('arm64 Mac uses calibrated hardware H264 encoding without changing dimensions or audio', async t => {
  const f = fixture(t, { hardware: true });
  const result = await f.run();
  const args = f.calls[0].args;
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_videotoolbox');
  assert.equal(args[args.indexOf('-allow_sw') + 1], '0');
  assert.equal(args[args.indexOf('-realtime') + 1], '0');
  assert.equal(args[args.indexOf('-q:v') + 1], '68');
  assert.equal(args[args.indexOf('-profile:v') + 1], 'high');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.equal(args[args.indexOf('-threads:v') + 1], '2');
  assert.equal(args.includes('-vf'), false);
  assert.equal(args.includes('-r'), false);
  assert.equal(args.includes('-crf'), false);
  assert.equal(result.encoder, 'h264_videotoolbox');
});

test('hardware encoder initialization failure retries original software encoding once', async t => {
  const f = fixture(t, { hardware: true, codes: [1, 0], errors: ['[h264_videotoolbox] cannot create compression session', ''] });
  const result = await f.run();
  assert.equal(f.calls.length, 2);
  const args = f.calls[1].args;
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-preset') + 1], 'veryfast');
  assert.equal(args[args.indexOf('-crf') + 1], '23');
  assert.equal(result.encoder, 'libx264');
});

for (const message of ['No space left on device', 'Permission denied', 'Input/output error', 'Invalid data found when processing input']) {
  test(`hardware attempt never retries terminal input or storage failure: ${message}`, async t => {
    const f = fixture(t, { hardware: true, code: 1, errors: [`[h264_videotoolbox] ${message}`] });
    await assert.rejects(f.run(), error => error.code === 'BYTEVC2_CONVERSION_FAILED' && !error.message.includes('PRIVATE_KEY'));
    assert.equal(f.calls.length, 1);
    assert.equal(fs.existsSync(f.output), false);
  });
}

test('hardware output hitting the existing byte limit gets one bounded software fallback', async t => {
  const f = fixture(t, { hardware: true, outputBytes: [20, 10] });
  const result = await f.run({ maxBytes: 15 });
  assert.equal(result.encoder, 'libx264');
  assert.equal(result.size, 10);
  assert.equal(f.calls.length, 2);
});

for (const tooLarge of [false, true]) test(`both encoders failing cleans output and releases the queue (${tooLarge ? 'byte limit' : 'encoder error'})`, async t => {
  const f = fixture(t, { hardware: true, codes: tooLarge ? [] : [1, 1, 0],
    errors: ['[h264_videotoolbox] cannot create compression session'], outputBytes: tooLarge ? [20, 20, 10] : [] });
  await assert.rejects(f.run(tooLarge ? { maxBytes: 15 } : {}),
    error => error.code === (tooLarge ? 'MEDIA_TOO_LARGE' : 'BYTEVC2_CONVERSION_FAILED'));
  assert.equal(f.calls.length, 2, 'no third encoding attempt');
  assert.equal(fs.existsSync(f.output), false);
  const next = await f.run({ output: f.output + '-next' });
  assert.equal(next.encoder, 'h264_videotoolbox');
  assert.equal(f.calls.length, 3, 'the next episode can start');
});

test('canceling hardware conversion does not start the software retry', async t => {
  const f = fixture(t, { hardware: true, wait: true }), controller = new AbortController();
  const run = f.run({ signal: controller.signal });
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(run, error => error.code === 'ERR_CANCELED');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(f.output), false);
});

test('ByteVC2 converts to H.264, copies audio and never exposes native diagnostics', async t => {
  const f = fixture(t), progress = [];
  const result = await f.run({ contentKey: '01'.repeat(16), onProgress: value => progress.push(value) });
  assert.equal(result.codec, 'h264');
  assert.equal(result.size, fs.statSync(f.output).size);
  assert.equal(f.calls.length, 1);
  const args = f.calls[0].args;
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.equal(args[args.indexOf('-decryption_key') + 1], '01'.repeat(16));
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  assert.equal(args[args.indexOf('-threads:v') + 1], '2', 'decoder must have a bounded worker count');
  assert(args.indexOf('-threads:v') < args.indexOf('-i'));
  assert.equal(args[args.lastIndexOf('-threads:v') + 1], '2', 'encoder must have a bounded worker count');
  assert(args.lastIndexOf('-threads:v') > args.indexOf('-i'));
  assert.equal(args[args.indexOf('-x264-params') + 1], 'lookahead_threads=1');
  assert.equal(progress.at(-1), 60);
  assert.equal(f.calls[0].options.shell, undefined);
});

test('conversion queue serializes helpers and prioritizes playback without restarting work', async t => {
  const f = fixture(t, { wait: true }), controllers = Array.from({ length: 4 }, () => new AbortController());
  const work = [];
  t.after(async () => { controllers.forEach(c => c.abort()); await Promise.allSettled(work); });
  const start = (index, getPriority = () => 0) => {
    const promise = f.run({ output: f.output + index, signal: controllers[index].signal, getPriority });
    work.push(promise); return promise;
  };
  start(0);
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  start(1);
  let promoted = false;
  start(2, () => promoted ? 2 : 1);
  start(3, () => 1);
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1, 'downloads and prefetches must not start parallel helpers');
  promoted = true;
  f.finish(0); await work[0];
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls[1].args.at(-1), f.output + 2);
  f.finish(1); await work[2];
  while (f.calls.length < 3) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls[2].args.at(-1), f.output + 3);
  f.finish(2); await work[3];
  while (f.calls.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls[3].args.at(-1), f.output + 1);
  f.finish(3); await work[1];
});

test('conversion reports queued work separately from the active converter', async t => {
  const f = fixture(t, { wait: true }), controller = new AbortController(), phases = [];
  const first = f.run({ signal: controller.signal });
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  const second = f.run({ output: f.output + '-queued-phase', signal: controller.signal,
    onPhase: phase => phases.push(phase) });
  t.after(async () => { controller.abort(); await Promise.allSettled([first, second]); });
  assert.deepEqual(phases, ['queued'], 'queued work must not claim to be converting');
  f.finish(0); await first;
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(phases, ['queued', 'transcoding']);
  f.finish(1); await second;
});

for (const token of [false, true]) test(`queued cancellation removes work before creating output (${token ? 'download token' : 'signal'})`, async t => {
  const f = fixture(t, { wait: true }), activeController = new AbortController();
  const active = f.run({ signal: activeController.signal });
  t.after(async () => { activeController.abort(); await active.catch(() => {}); });
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController(), source = require('axios').CancelToken.source();
  const queuedOutput = f.output + '-queued';
  const queued = f.run({ output: queuedOutput, ...(token ? { cancelToken: source.token } : { signal: controller.signal }) });
  const rejection = assert.rejects(queued, error => error.code === 'ERR_CANCELED');
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1, 'queued work must remain cancellable without spawning');
  if (token) source.cancel('PRIVATE_REASON'); else controller.abort();
  await rejection;
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(queuedOutput), false);
  f.finish(0); await active;
});

test('failed conversion releases the queue for the next episode', async t => {
  const f = fixture(t, { wait: true }), controller = new AbortController();
  const first = f.run({ signal: controller.signal });
  const failed = assert.rejects(first, error => error.code === 'BYTEVC2_CONVERSION_FAILED');
  const second = f.run({ output: f.output + '-second', signal: controller.signal });
  t.after(async () => { controller.abort(); await Promise.allSettled([first, second]); });
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  f.finish(0, 9); await failed;
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  f.finish(1); await second;
  assert.equal(fs.existsSync(f.output), false);
});

test('missing helper fails before creating output', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ executable: null }), /ByteVC2.*重新/);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.output), false);
});

test('invalid encryption keys are rejected before running a process', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ contentKey: 'private' }), /密钥/);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.output), false);
});

test('conversion never overwrites an existing output', async t => {
  const f = fixture(t); fs.writeFileSync(f.output, 'keep');
  await assert.rejects(f.run(), error => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'keep'); assert.equal(f.calls.length, 0);
});

test('native failure removes only the partial output and hides diagnostics', async t => {
  const f = fixture(t, { code: 9 });
  await assert.rejects(f.run(), error => error.code === 'BYTEVC2_CONVERSION_FAILED' && !/SENTINEL|PRIVATE/.test(error.message));
  assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.input), true);
});

test('partial duration cannot be published as a complete episode', async t => {
  const f = fixture(t, { seconds: 10 });
  await assert.rejects(f.run(), /不完整/);
  assert.equal(fs.existsSync(f.output), false);
});

test('online conversion respects the output byte limit', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ maxBytes: 10 }), /过大/);
  assert.equal(fs.existsSync(f.output), false);
});

test('pre-cancelled conversion does not create files or processes', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.run({ signal: controller.signal }), error => error.code === 'ERR_CANCELED');
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.output), false);
});

test('cancelling active conversion stops the helper and removes partial output', async t => {
  const f = fixture(t, { wait: true }), controller = new AbortController();
  const promise = f.run({ signal: controller.signal });
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(promise, error => error.code === 'ERR_CANCELED');
  assert.deepEqual(f.kills, ['SIGTERM']); assert.equal(fs.existsSync(f.output), false);
});

test('download cancellation tokens also stop conversion without exposing their reason', async t => {
  const f = fixture(t, { wait: true }), source = require('axios').CancelToken.source();
  const promise = f.run({ cancelToken: source.token });
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  source.cancel('PRIVATE_CANCELLATION_SENTINEL');
  await assert.rejects(promise, error => error.code === 'ERR_CANCELED' && !/SENTINEL/.test(error.message));
  assert.deepEqual(f.kills, ['SIGTERM']); assert.equal(fs.existsSync(f.output), false);
});
