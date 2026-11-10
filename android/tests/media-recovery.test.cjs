const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('../../node_modules/esbuild');

const entry = path.join(__dirname, '../mobile/media.js');
const compiled = esbuild.build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'cjs', write: false, logLevel: 'silent', plugins: [{ name: 'controlled-source', setup(build) {
  build.onLoad({ filter: /native\/app-source\.js$/ }, () => ({ contents: 'export const fetchAppPlayUrl = (...args) => globalThis.fetchSource(...args);', loader: 'js' }));
  build.onLoad({ filter: /build\/mobile-decrypt\.js$/ }, () => ({ contents: 'export const decryptMp4Buffer = () => { throw new Error("unexpected decryption"); };', loader: 'js' }));
} }] });
const source = { variants: ['first', 'second', 'third', 'fourth', 'fifth'].map(host => ({ url: `https://${host}.qznovelvod.com/fixture`, source: 'app', codec: 'h264', quality: '1080p' })) };
const failedRegistration = reason => Object.assign(new Error('registration failed'), { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: reason });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function harness(fetchSource, respond) {
  const requests = [], timers = new Map();
  let timer = 0;
  const context = {
    module: { exports: {} }, URL, Date, console: { info() {} }, fetchSource,
    setTimeout(fn, ms) { const id = ++timer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    Native: { mediaSize: () => 16, deleteMedia() {}, cancel() {}, request(id, raw) {
      const options = JSON.parse(raw); requests.push(options);
      queueMicrotask(() => context.__nativeResponse(id, JSON.stringify(respond(requests.length, options))));
    } },
  };
  vm.runInNewContext((await compiled).outputFiles[0].text, context);
  return { prepare: context.module.exports.prepareMedia, requests, timers, runTimer() {
    const [id, task] = timers.entries().next().value; timers.delete(id); task.fn();
  } };
}
const success = () => ({ status: 200, token: '12345678-1234-1234-1234-123456789abc.mp4', bytes: 16 });

test('Android media recovery remains bounded and cancellable', async t => {
  await t.test('rejected redirect uses the next supplied candidate at the same quality', async () => {
    let sourceCalls = 0;
    const h = await harness(async () => { sourceCalls++; return source; }, n => n === 1 ? { error: 'redirect rejected', code: 'MEDIA_REDIRECT_REJECTED' } : success());
    const result = await h.prepare('111111', '1080p', new AbortController().signal);
    assert.equal(result.quality, '1080p'); assert.equal(h.requests.length, 2); assert.equal(sourceCalls, 1);
    assert.equal(new URL(h.requests[1].url).hostname, 'second.qznovelvod.com');
  });
  await t.test('redirect rejection stops at four candidates and fails safely', async () => {
    const h = await harness(async () => source, () => ({ error: 'redirect rejected', code: 'MEDIA_REDIRECT_REJECTED' }));
    await assert.rejects(h.prepare('111111', '1080p', new AbortController().signal), error => error.code === 'MEDIA_REDIRECT_REJECTED');
    assert.equal(h.requests.length, 4);
  });
  await t.test('cancel stops before a second candidate; original URL and business refusals do not rotate', async () => {
    const controller = new AbortController();
    const h = await harness(async () => source, () => { controller.abort(); return { error: 'redirect rejected', code: 'MEDIA_REDIRECT_REJECTED' }; });
    await assert.rejects(h.prepare('111111', '1080p', controller.signal), error => error.code === 'ERR_CANCELED');
    assert.equal(h.requests.length, 1);
    for (const code of ['ERR_NETWORK', 'SECURITY_BLOCKED', 'BUSINESS_REJECTED']) {
      const other = await harness(async () => source, () => ({ error: 'rejected', code }));
      await assert.rejects(other.prepare('111111', '1080p', new AbortController().signal), error => error.code === code);
      assert.equal(other.requests.length, 1);
    }
  });
  await t.test('transient registration retries only once after the existing ten-second cooldown', async () => {
    for (const reason of ['TIMEOUT', 'NETWORK_ERROR']) {
      let calls = 0;
      const h = await harness(async () => { if (++calls === 1) throw failedRegistration(reason); return source; }, success);
      const phases = [];
      const pending = h.prepare('111111', '1080p', new AbortController().signal, (phase, stats) => phases.push({ phase, ...stats }));
      pending.catch(() => {}); await flush();
      assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 10000); assert.equal(calls, 1);
      assert.deepEqual(phases, [{ phase: 'registration-retry', retryAfterMs: 10000 }]);
      h.runTimer(); await pending;
      assert.equal(calls, 2); assert.equal(h.timers.size, 0);
      assert.equal(phases[1].phase, 'preparing');
    }
    let calls = 0;
    const h = await harness(async () => { calls++; throw failedRegistration('TIMEOUT'); }, success);
    const pending = h.prepare('111111', '1080p', new AbortController().signal);
    pending.catch(() => {}); await flush(); assert.equal(h.timers.size, 1);
    h.runTimer(); await assert.rejects(pending, error => error.registrationFailure === 'TIMEOUT');
    assert.equal(calls, 2); assert.equal(h.timers.size, 0);
  });
  await t.test('cooldown is cancellable and explicit registration refusals never retry', async () => {
    let calls = 0;
    const h = await harness(async () => { calls++; throw failedRegistration('NETWORK_ERROR'); }, success);
    const controller = new AbortController(), pending = h.prepare('111111', '1080p', controller.signal);
    pending.catch(() => {}); await flush(); assert.equal(h.timers.size, 1);
    controller.abort(); await assert.rejects(pending, error => error.code === 'ERR_CANCELED');
    assert.equal(calls, 1); assert.equal(h.timers.size, 0);
    for (const reason of ['BUSINESS_REJECTED', 'SECURITY_BLOCKED', 'INVALID_RESPONSE', 'EMPTY_RESPONSE', 'HTTP_403', 'UNKNOWN']) {
      let attempts = 0;
      const other = await harness(async () => { attempts++; throw failedRegistration(reason); }, success);
      await assert.rejects(other.prepare('111111', '1080p', new AbortController().signal), error => error.registrationFailure === reason);
      assert.equal(attempts, 1); assert.equal(other.timers.size, 0);
    }
  });
  await t.test('native marks only caught media redirects, preserving the original URL guard', () => {
    const native = fs.readFileSync(path.join(__dirname, '../app/src/main/java/io/github/hongguo/personal/MainActivity.java'), 'utf8');
    const request = native.slice(native.indexOf('@JavascriptInterface public void request('));
    assert(/catch \(Exception redirectError\) \{\s*mediaRedirectRejected = true;/.test(request), 'mark the media redirect catch only');
    assert(/mediaRedirectRejected && getPackageName\(\)\.equals\("io\.github\.hongguo\.personal"\) \? "MEDIA_REDIRECT_REJECTED"/.test(request), 'return the stable rejection code only for the personal phone app; TV retains its previous network error');
    assert(request.indexOf('URL url = checked(') < request.indexOf('mediaRedirectRejected = true;'));
    assert(request.indexOf('if (status >= 300 && status <= 399 && isMedia)') < request.indexOf('mediaRedirectRejected = true;'));
  });
});
