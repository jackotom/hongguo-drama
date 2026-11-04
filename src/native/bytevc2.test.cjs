const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function fixture(t, { code = 0, seconds = 60, wait = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-bytevc2-'));
  const input = path.join(root, 'input'), output = path.join(root, 'output');
  fs.writeFileSync(input, 'synthetic process fixture, never played');
  const calls = [], kills = [];
  t.after(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });
  mock.method(cp, 'spawn', (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => {
      fs.writeFileSync(output, 'process output');
      child.stderr.write('PRIVATE_KEY_AND_PATH_SENTINEL');
      if (!wait) {
        child.stdout.write(`out_time_us=${seconds * 1000000}\nprogress=end\n`);
        child.emit('close', code);
      }
    });
    return child;
  });
  return { input, output, calls, kills, run: extra => require('./bytevc2').convertBytevc2({ executable: '/fixture/librempeg', input, output, duration: 60, ...extra }) };
}

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
  assert.equal(progress.at(-1), 60);
  assert.equal(f.calls[0].options.shell, undefined);
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
