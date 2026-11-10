const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('../../node_modules/esbuild');

test('registration diagnostics preserve timeout cancellation and expose only approved metadata', async () => {
  const logs = [], requests = [], cancelled = [];
  const context = {
    module: { exports: {} }, URL, Date, setTimeout, clearTimeout,
    console: { info: line => logs.push(line) },
    Native: { request(id, raw) { requests.push({ id, raw }); }, cancel(id) { cancelled.push(id); } },
  };
  const transport = await esbuild.build({ entryPoints: [path.join(__dirname, '../web/transport.js')], bundle: true, platform: 'browser', format: 'cjs', write: false, logLevel: 'silent' });
  vm.runInNewContext(transport.outputFiles[0].text, context);
  const request = context.module.exports.default;
  const url = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/?secret=must_not_be_logged';
  const deadline = new AbortController();
  const pending = request({ url, method: 'POST', data: 'private-body', headers: { Cookie: 'private-cookie' }, signal: deadline.signal, timeout: 8000 });
  assert.equal(JSON.parse(requests[0].raw).timeout, 8000);
  deadline.abort(new DOMException('private-deadline-message', 'TimeoutError'));
  await assert.rejects(pending, error => error.code === 'ERR_CANCELED');
  assert.deepEqual(cancelled, [1]);
  context.__nativeResponse(1, JSON.stringify({ status: 200, data: 'private-late-response' }));
  assert(logs.some(line => /^HG:register:1:deadline:\d+$/.test(line)));
  assert(!logs.some(line => line.includes('HTTP_200')), 'late callbacks remain ignored');
  const success = request({ url });
  context.__nativeResponse(2, JSON.stringify({ status: 200, data: 'private-registration-response' }));
  assert.equal((await success).data, 'private-registration-response');

  const media = await esbuild.build({ entryPoints: [path.join(__dirname, '../mobile/media.js')], bundle: true, platform: 'browser', format: 'cjs', write: false, logLevel: 'silent', plugins: [{ name: 'isolated-registration', setup(build) {
    build.onLoad({ filter: /native\/app-source\.js$/ }, () => ({ contents: 'export const fetchAppPlayUrl = async () => { throw globalThis.registrationError; };', loader: 'js' }));
    build.onResolve({ filter: /^android-decrypt$/ }, () => ({ path: 'decoder', namespace: 'isolated-decoder' }));
    build.onLoad({ filter: /.*/, namespace: 'isolated-decoder' }, () => ({ contents: 'export const decryptMp4Buffer = () => { throw new Error("unexpected decode"); };', loader: 'js' }));
  } }] });
  vm.runInNewContext(media.outputFiles[0].text, context);
  for (const reason of ['TIMEOUT', 'private-unapproved-reason']) {
    const error = Object.assign(new Error('private-original-error'), { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: reason });
    context.registrationError = error;
    await assert.rejects(context.module.exports.prepareMedia('111111', '1080p', new AbortController().signal), actual => actual === error);
  }
  assert(logs.some(line => /register_failed:TIMEOUT:\d+$/.test(line)));
  assert(logs.some(line => /register_failed:UNKNOWN:\d+$/.test(line)));
  assert(logs.every(line => /^HG:[A-Za-z0-9_:.-]{1,100}$/.test(line)));
  assert(!logs.join('\n').includes('private'));
  assert(!logs.join('\n').includes('must_not_be_logged'));
  assert(!logs.join('\n').includes('https'));

  const native = fs.readFileSync(path.join(__dirname, '../app/src/main/java/io/github/hongguo/personal/MainActivity.java'), 'utf8');
  const traceLines = native.split('\n').filter(line => line.includes('trace.log('));
  assert(traceLines.some(line => line.includes('cancel_')));
  assert(traceLines.some(line => line.includes('start_queue_ms')));
  assert(traceLines.some(line => line.includes('http_')));
  assert(traceLines.some(line => line.includes('body_ms')));
  assert(traceLines.every(line => !/getMessage\(|getHeaderField\(|getString\(|\braw\b|\burl\b|\bdata\b/.test(line)), 'native traces must not emit URLs, bodies or exception messages');
});
