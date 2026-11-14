// Offline app-source regression. No credentials, network beyond a local fixture, or GUI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-app-media-'));
const contentKey = '01'.repeat(16); // Synthetic test key, never a captured credential.
const clearBytes = Buffer.from('decrypted-mp4-fixture');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function load(url, mode = 'ok', key = contentKey) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const handlers = {}, protocols = {}, children = [], app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (n, f) => handlers[n] = f }, protocol: { registerSchemesAsPrivileged() {}, handle: (n, f) => protocols[n] = f } };
  const native = { fetchPlayUrlSingle: async () => ({ url, contentKey: key, source: 'app', codec: 'h264' }), UA: 'test', VIDEO_REFERER: 'https://example.com/', deriveKey: () => { throw new Error('contentKey must never go through spade'); } };
  const mediaGuard = req('./src/native/web-media-guard');
  const loopbackGuard = { webMediaRequestOptions: value => new URL(value).hostname === '127.0.0.1' ? {} : mediaGuard.webMediaRequestOptions(value) };
  const childProcess = { spawn: (file, args) => {
    assert.equal(file, '/bundled/ffmpeg');
    assert.equal(args[args.indexOf('-decryption_key') + 1], contentKey);
    assert.ok(args.includes('copy'), 'remux without lossy transcode');
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
    children.push(child);
    const output = args.at(-1);
    if (mode === 'wait') fs.writeFileSync(output, 'partial');
    else setImmediate(() => {
      fs.writeFileSync(output, mode === 'fail' ? 'partial' : clearBytes);
      if (mode === 'fail') child.stderr.emit('data', Buffer.from('bad media ' + contentKey));
      child.emit('close', mode === 'fail' ? 1 : 0);
    });
    return child;
  } };
  const context = vm.createContext({ require: n => n === 'electron' ? electron : n === './src/native/hongguo' ? native
    : n === './src/native/web-media-guard' ? loopbackGuard
    : n === 'child_process' || n === 'node:child_process' ? childProcess
    : n === './src/store' ? { saveTasks() {}, getSettings: () => ({ root: dir }) } : req(n),
    __dirname: path.dirname(source), console: { log() {}, warn() {}, error() {} }, process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  // These transport/decryption fixtures are synthetic; real media validity is checked separately.
  context.probeVideoInfo = async () => ({ w: 1080, h: 1920, duration: 12, codec: 'h264' });
  context.verifyDownloadDecode = async () => {};
  context.resolveFfmpeg = () => '/fixture/ffprobe';
  context.resolveFfmpeg = () => '/bundled/ffmpeg'; context.registerStreamProtocol();
  return { dir, handlers, protocols, children, context, run: source => vm.runInContext(source, context) };
}
(async () => {
  const server = http.createServer((r, s) => s.end('encrypted-fixture'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/media`;
  let failures = 0;
  async function check(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message.replaceAll(contentKey, '[test-key]')); } }
  await check('app prepare decrypts with bundled ffmpeg before exposing media', async () => {
    const h = load(url); const p = await h.handlers['prepare-online-play']({}, { vid: 'app' });
    assert.equal(p.success, true); assert.equal(p.streaming, false, 'contentKey is encrypted, not a plain proxy source');
    const response = await h.protocols['hongguo-stream'](new Request(p.url));
    assert.equal(await response.text(), clearBytes.toString()); assert.equal(h.children.length, 1);
    assert.deepEqual(fs.readdirSync(h.dir), [], 'prepare temporary files must be removed');
    h.context.clearOnlineCache();
  });
  await check('app download publishes decrypted bytes and removes intermediate files', async () => {
    const h = load(url), task = { id: 'download', type: 'hongguo', filename: 'final.mp4', customDir: h.dir,
      hongguoInfo: { vid: 'app', series_id: '1', vid_index: 1 } };
    h.context.fixtureTask = task; h.run('downloadTasks=[fixtureTask]');
    await h.context.executeHongguoDownload(task);
    assert.equal(task.status, 'completed'); assert.deepEqual(fs.readFileSync(task.savePath), clearBytes);
    assert.deepEqual(fs.readdirSync(h.dir), ['final.mp4'], h.run(`JSON.stringify({
      entries: ${JSON.stringify(fs.readdirSync(h.dir))},
      receipts: downloadTasks[0]?.temporaryDownloads || [],
      state: downloadTasks[0]?.temporaryDownloads?.[0] ? inspectDownloadTemporary(downloadTasks[0].temporaryDownloads[0], downloadTemporaryOwner(downloadTasks[0])) : null
    })`));
  });
  await check('cancel during native decryption kills child and removes partial output', async () => {
    const h = load(url, 'wait'); const pending = h.handlers['prepare-online-play']({}, { vid: 'cancel', requestId: 'cancel' });
    for (let i=0; i<30 && !h.children.length; i++) await sleep(5);
    assert.equal(h.children.length, 1, 'encrypted preparation must start ffmpeg');
    await h.handlers['release-online-play']({}, { requestId: 'cancel' });
    assert.equal((await pending).success, false); assert.equal(h.children[0].killed, true);
    assert.deepEqual(fs.readdirSync(h.dir), []);
  });
  await check('native failure does not expose keys or retain partial output', async () => {
    const h = load(url, 'fail'); const p = await h.handlers['prepare-online-play']({}, { vid: 'fail' });
    assert.equal(p.success, false); assert.ok(!p.error.includes(contentKey)); assert.deepEqual(fs.readdirSync(h.dir), []);
  });
  await check('invalid content key is rejected before launching native code', async () => {
    const h = load(url, 'ok', 'invalid'); const p = await h.handlers['prepare-online-play']({}, { vid: 'invalid' });
    assert.equal(p.success, false); assert.equal(h.children.length, 0); assert.deepEqual(fs.readdirSync(h.dir), []);
  });
  server.closeAllConnections(); await new Promise(r => server.close(r));
  assert.equal(failures, 0, `${failures} app-media regressions`);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
