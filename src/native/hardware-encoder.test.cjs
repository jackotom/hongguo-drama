const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture({ platform = 'win32', listed = true, failure = '', hang = false, frames = 12 } = {}) {
  const calls = [], children = [];
  const spawn = (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { child.killedWith = signal; setImmediate(() => child.emit('close', 1)); };
    children.push(child);
    setImmediate(() => {
      if (args.includes('-encoders')) { child.stdout.emit('data', listed ? ' V....D h264_nvenc NVIDIA\n V....D h264_videotoolbox Apple\n' : ' V....D libx264 software\n'); child.emit('close', 0); }
      else if (!hang) { child.stdout.emit('data', `frame=${frames}\nprogress=end\n`); if (failure) child.stderr.emit('data', failure); child.emit('close', failure ? 1 : 0); }
    });
    return child;
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'hardware-encoder.js'), 'utf8'), {
    module, exports: module.exports, require: name => name === 'node:child_process' ? { spawn } : require(name),
    process: { platform }, setTimeout, clearTimeout, Buffer,
  });
  return { ...module.exports, calls, children };
}
const input = { executable: '/bundled/ffmpeg', input: '/private/current.mp4', contentKey: 'a'.repeat(32) };

test('listed NVENC must encode the current input before selection, with bounded threads and no output file', async () => {
  const h = fixture();
  assert.equal((await h.pickHardwareEncoder(input))?.encoder, 'h264_nvenc');
  assert.equal(h.calls.length, 2);
  const args = h.calls[1].args;
  assert.equal(args[args.indexOf('-i') + 1], input.input);
  assert.equal(args[args.indexOf('-decryption_key') + 1], input.contentKey);
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  assert.equal(args[args.indexOf('-threads') + 1], '2');
  assert.equal(args[args.indexOf('-threads:v') + 1], '2');
  assert.equal(args[args.indexOf('-frames:v') + 1], '12');
  assert.equal(args.at(-1), '-'); assert.equal(args[args.indexOf('-f') + 1], 'null');
});
test('missing encoder or unsupported platform does not spawn an encode', async () => {
  const h = fixture({ listed: false }); assert.equal(await h.pickHardwareEncoder(input), null); assert.equal(h.calls.length, 1);
  const other = fixture({ platform: 'freebsd' }); assert.equal(await other.pickHardwareEncoder(input), null); assert.equal(other.calls.length, 0);
});
test('Apple hardware probe refuses software VideoToolbox fallback', async () => {
  const h = fixture({ platform: 'darwin' }); assert.equal((await h.pickHardwareEncoder(input))?.encoder, 'h264_videotoolbox');
  const args = h.calls[1].args; assert.equal(args[args.indexOf('-allow_sw') + 1], '0'); assert.equal(args[args.indexOf('-q:v') + 1], '68');
});
test('unavailable driver returns null, while corrupt input throws a redacted terminal error', async () => {
  assert.equal(await fixture({ failure: 'Cannot load nvcuda.dll' }).pickHardwareEncoder(input), null);
  await assert.rejects(fixture({ failure: 'Error opening input file /private/current.mp4: Invalid data found when processing input key=' + input.contentKey }).pickHardwareEncoder(input), error => {
    assert.equal(error.code, 'HARDWARE_PROBE_INPUT_FAILED'); assert(!error.message.includes(input.input)); assert(!error.message.includes(input.contentKey)); return true;
  });
});
test('a successful exit without an encoded frame cannot prove usable hardware', async () => {
  assert.equal(await fixture({ frames: 0 }).pickHardwareEncoder(input), null);
});
test('explicit decoder and memory errors never become hardware-unavailable fallback', async () => {
  for (const failure of ['Error while decoding stream', 'Error submitting packet to decoder', 'corrupt input', 'decryption failed', 'Cannot allocate memory']) {
    await assert.rejects(fixture({ failure }).pickHardwareEncoder(input), { code: 'HARDWARE_PROBE_INPUT_FAILED' });
  }
});
test('already cancelled and active aborts never select hardware and stop the running child', async () => {
  const h = fixture({ hang: true }), controller = new AbortController(); controller.abort();
  await assert.rejects(h.pickHardwareEncoder({ ...input, signal: controller.signal }), { code: 'ERR_CANCELED' }); assert.equal(h.calls.length, 0);
  const active = fixture({ hang: true }), second = new AbortController();
  const pending = active.pickHardwareEncoder({ ...input, signal: second.signal });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve))); second.abort();
  await assert.rejects(pending, { code: 'ERR_CANCELED' }); assert.equal(active.children.at(-1).killedWith, 'SIGTERM');
});
test('Axios cancellation and timeout stop an active probe without exposing diagnostics', async () => {
  let subscriber;
  const cancelToken = { subscribe(fn) { subscriber = fn; }, unsubscribe(fn) { if (subscriber === fn) subscriber = null; } };
  const h = fixture({ hang: true }); const pending = h.pickHardwareEncoder({ ...input, cancelToken });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve))); cancelToken.reason = new Error('cancel'); subscriber();
  await assert.rejects(pending, { code: 'ERR_CANCELED' }); assert.equal(subscriber, null);
  const timed = fixture({ hang: true }); assert.equal(await timed.pickHardwareEncoder({ ...input, timeoutMs: 5 }), null); assert.equal(timed.children.at(-1).killedWith, 'SIGTERM');
});
test('only trusted local input argument shapes reach the executable', async () => {
  const h = fixture();
  await assert.rejects(h.pickHardwareEncoder({ ...input, inputArgs: ['-i', 'https://example.test/media'] }), { code: 'HARDWARE_PROBE_INPUT_FAILED' });
  assert.equal(h.calls.length, 0);
  assert.throws(() => h.hardwareEncoderArgs('libx264'), /不支持的硬件编码器/);
});
