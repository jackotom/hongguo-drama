// Offline regression: real HTTP streams, isolated main process, no GUI/user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-stream-'));
const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function load(fetchPlayUrlSingle, overrides = {}) {
  const handlers = {}, protocols = {}, app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (n, f) => handlers[n] = f }, protocol: { registerSchemesAsPrivileged() {}, handle: (n, f) => protocols[n] = f } };
  const native = { fetchPlayUrlSingle, UA: 'test', WEB_UA: 'browser-test', WEB_REFERER: 'https://hongguoduanju.com/', VIDEO_REFERER: 'https://example.com/', deriveKey: () => Buffer.alloc(16), decryptMp4Buffer: b => b };
  // These transport fixtures intentionally use a loopback server; the real guard has its own boundary tests.
  const mediaGuard = req('./src/native/web-media-guard');
  overrides = { './src/native/web-media-guard': { webMediaRequestOptions: value => {
    if (new URL(value).hostname === '127.0.0.1') return {};
    return mediaGuard.webMediaRequestOptions(value);
  } }, ...overrides };
  const context = vm.createContext({ require: n => overrides[n] || (n === 'electron' ? electron : n === './src/native/hongguo' ? native : n === './src/store' ? { saveTasks() {}, getSettings: () => ({ root }) } : req(n)), __dirname: path.dirname(source), console: { log() {}, warn() {}, error() {} }, process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  // These transport/decryption fixtures are synthetic; real media validity is checked separately.
  context.probeVideoInfo = async () => ({ w: 1080, h: 1920, duration: 12, codec: 'h264' });
  context.verifyDownloadDecode = async () => {};
  context.resolveFfmpeg = () => '/fixture/ffprobe';
  context.registerStreamProtocol();
  context.registerLocalProtocol();
  return { context, handlers, protocols, run: s => vm.runInContext(s, context) };
}
(async () => {
  let hits = 0, streamClosed = false;
  const requests = []; const endpointHits = new Map();
  const server = http.createServer((r, s) => {
    hits++;
    requests.push({ url: r.url, method: r.method, headers: r.headers });
    endpointHits.set(r.url, (endpointHits.get(r.url) || 0) + 1);
    if (r.url === '/web-identity' && (r.headers['user-agent'] !== 'browser-test' || r.headers.referer !== 'https://hongguoduanju.com/')) { s.writeHead(404); s.end('wrong identity'); return; }
    const unstable = /^\/unstable-(404|410|503)/.exec(r.url);
    if (unstable && endpointHits.get(r.url) % 2 === 1) { s.writeHead(Number(unstable[1])); s.end('temporary'); return; }
    if (r.url.startsWith('/status-')) { s.writeHead(Number(r.url.slice(8))); s.end('unavailable'); return; }
    if (r.url === '/full-partial') { s.writeHead(206, { 'content-length': '10', 'content-range': 'bytes 0-9/10' }); s.end('0123456789'); return; }
    if (r.url === '/short-partial') { s.writeHead(206, { 'content-length': '3', 'content-range': 'bytes 0-9/10' }); s.end('012'); return; }
    if (r.url === '/partial') { s.writeHead(206, { 'content-length': '3', 'content-range': 'bytes 2-4/10' }); s.end('234'); return; }
    if (r.url === '/empty') { s.writeHead(200, { 'content-length': '0' }); s.end(); return; }
    if (r.url === '/error-page') { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<html>expired</html>'); return; }
    if (r.url === '/missing') { s.writeHead(404); s.end('missing'); return; }
    if (r.url === '/referer' && !r.headers.referer) { s.writeHead(403); s.end('forbidden'); return; }
    if (r.url === '/large') { s.writeHead(200, { 'content-length': String(301 * 1024 * 1024) }); s.write('hello'); return; }
    if (r.url === '/slow') { s.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '99999' }); s.write('hello'); r.on('close', () => streamClosed = true); return; }
    if (r.url === '/broken') { s.writeHead(200, { 'content-length': '99999' }); s.write('hello'); setTimeout(() => s.destroy(), 20); return; }
    const body = Buffer.from('0123456789');
    if (r.headers.range === 'bytes=2-4') { s.writeHead(206, { 'content-type': 'video/mp4', 'content-length': '3', 'content-range': 'bytes 2-4/10' }); s.end(body.subarray(2,5)); }
    else { s.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length }); s.end(body); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failures = 0;
  async function check(name, f) { if (process.argv.includes('--prefetch') && !name.startsWith('prefetch:')) return; if (process.argv.includes('--extras') && !name.startsWith('extra:')) return; try { await f(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); } }
  const harnesses = [];
  const hload = (fn, overrides) => { const h = load(fn, overrides); harnesses.push(h); return h; };
  await check('web: stream, prefetch, download and compatibility input retain browser identity', async () => {
    const h = hload(async () => ({ url: base + '/web-identity', source: 'web', vid: '11' }));
    const before = hits;
    const p = await h.handlers['prepare-online-play']({}, { vid: '11' });
    assert.equal(hits, before, 'do not probe media before playback');
    const response = await h.protocols['hongguo-stream'](new Request(p.url, { headers: { range: 'bytes=2-4' } }));
    assert.equal(response.status, 206); assert.equal(await response.text(), '234');
    assert.equal((await h.handlers['prepare-online-play']({}, { vid: '12', prefetch: true })).success, true);
    assert.equal((await h.context.fetchDecryptedEpisode('13')).toString(), '0123456789');
    const task = { id: 'web', type: 'hongguo', filename: 'web.mp4', customDir: root, hongguoInfo: { vid: '14' } };
    await h.context.executeHongguoDownload(task); assert.equal(task.status, 'completed');
  });
  await check('web: transient HTTP failures retry once with identical method, Range and identity', async () => {
    const h = hload(async () => ({}));
    for (const status of [404, 410, 503]) {
      const before = requests.length;
      const response = await h.context.requestMedia({ url: base + '/unstable-' + status, source: 'web' }, { headers: { Range: 'bytes=2-4' } });
      let data = ''; for await (const chunk of response.data) data += chunk;
      assert.equal(data, '234'); assert.equal(requests.length, before + 2);
      assert.deepEqual(requests[before], requests[before + 1]);
    }
  });
  await check('web: persistent GET failure records only failed web episode; HEAD and cancellation do not', async () => {
    const marked = [];
    const native = { UA: 'test', WEB_UA: 'browser-test', WEB_REFERER: 'https://hongguoduanju.com/', markWebMediaFailure: info => marked.push(info.vid) };
    const h = hload(async () => ({}), { './src/native/hongguo': native });
    const info = { url: base + '/missing', source: 'web', vid: '11' };
    const before = hits;
    await assert.rejects(h.context.requestMedia(info), /HTTP 404/);
    assert.equal(hits, before + 2); assert.deepEqual(marked, ['11']);
    await assert.rejects(h.context.requestMedia(info, { method: 'HEAD' }));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.context.requestMedia(info, { signal: controller.signal }));
    assert.deepEqual(marked, ['11']);
    await assert.rejects(h.context.requestMedia({ ...info, source: 'app', vid: '12' }));
    assert.deepEqual(marked, ['11']);
  });
  await check('web: App identity and non-transient responses keep existing retry policy', async () => {
    const h = hload(async () => ({}));
    for (const [source, status] of [['app', 404], ['web', 401], ['web', 429]]) {
      const before = hits;
      await assert.rejects(h.context.requestMedia({ url: base + '/status-' + status, source }));
      assert.equal(hits, before + 1);
      assert.equal(requests.at(-1).headers['user-agent'], source === 'web' ? 'browser-test' : 'test');
    }
    const response = await h.context.requestMedia({ url: base + '/range', source: 'app' });
    response.data.destroy(); assert.equal(requests.at(-1).headers.referer, undefined);
  });
  await check('web: real provider switches cached failed episode to App for five minutes, isolates episodes and expires', async () => {
    let now = Date.now(), webHits = 0, appHits = 0;
    const nativePath = path.resolve(__dirname, '../src/native/hongguo.js');
    const nativeRequire = createRequire(nativePath);
    const context = vm.createContext({ module: { exports: {} }, Buffer, URL, process: { env: {} }, console,
      Date: class extends Date { static now() { return now; } },
      require: name => name === 'axios' ? { get: async url => {
        webHits++;
        const vid = /\/(\d+)$/.exec(url)?.[1];
        return { data: `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
          'player_(series_id)/(vid)/page': { vid, series_id: '1', seriesDetail: { series_id: '1' },
            publicVideoSeo: { available: true, itemId: vid, seriesId: '1' } },
        } })}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', url: `https://hongguoduanju.com/player/1/${vid}`, contentUrl: 'https://media.example/web.mp4' })}</script>` };
      } }
        : name === './app-source' ? { fetchAppPlayUrl: async () => { appHits++; return { url: 'https://media.example/app.mp4', source: 'app' }; } } : nativeRequire(name),
    });
    vm.runInContext(fs.readFileSync(nativePath, 'utf8'), context);
    const native = context.module.exports;
    const first = await native.fetchPlayUrlSingle('11', '1');
    assert.equal(first.source, 'web'); assert.equal(first.vid, '11');
    const h = hload(native.fetchPlayUrlSingle, { './src/native/hongguo': native });
    await assert.rejects(h.context.requestMedia({ ...first, url: base + '/missing' }));
    assert.equal((await native.fetchPlayUrlSingle('11', '1')).source, 'app', 'failed cached URL must not be returned again');
    assert.equal((await native.fetchPlayUrlSingle('11', '1', { force: true })).source, 'app');
    assert.equal(webHits, 1); assert.equal(appHits, 2);
    assert.equal((await native.fetchPlayUrlSingle('22', '1')).source, 'web');
    now += 5 * 60 * 1000 + 1;
    assert.equal((await native.fetchPlayUrlSingle('11', '1')).source, 'web');
  });
  await check('prefetch: plain bytes are cached and reused without another media request', async () => {
    const h = hload(async () => ({ url: base + '/range' }));
    const before = hits;
    const p = await h.handlers['prepare-online-play']({}, { vid: 'next', requestId: 'prefetch', prefetch: true });
    assert.equal(p.success, true);
    assert.equal(p.streaming, false, 'prefetch must retain actual media bytes');
    assert.equal(p.size, 10);
    assert.equal(hits, before + 1);
    await h.handlers['release-online-play']({}, { streamId: p.streamId });
    const next = await h.handlers['prepare-online-play']({}, { vid: 'next' });
    assert.equal(next.cached, true);
    assert.equal(await (await h.protocols['hongguo-stream'](new Request(next.url))).text(), '0123456789');
    assert.equal(hits, before + 1);
  });
  await check('prefetch: cancellation and rejected sources do not populate cache', async () => {
    const h = hload(async () => ({ url: base + '/slow' }));
    const pending = h.handlers['prepare-online-play']({}, { vid: 'next', requestId: 'cancel', prefetch: true });
    await sleep(30);
    await h.handlers['release-online-play']({}, { requestId: 'cancel' });
    assert.equal((await pending).success, false);
    assert.equal(h.run('onlineCache.size'), 0);
    const locked = hload(async () => ({ error: 'locked' }));
    assert.equal((await locked.handlers['prepare-online-play']({}, { vid: 'hema:locked', prefetch: true })).success, false);
  });
  await check('prefetch: cancel during source validation prevents a late download; oversized media is skipped', async () => {
    let resolve;
    const h = hload(() => new Promise(r => { resolve = r; }));
    const before = hits;
    const pending = h.handlers['prepare-online-play']({}, { vid: 'hema:next', requestId: 'late', prefetch: true });
    await h.handlers['release-online-play']({}, { requestId: 'late' });
    resolve({ url: base + '/range' });
    assert.equal((await pending).success, false);
    assert.equal(hits, before, 'cancelled lookup must not start downloading');
    const large = hload(async () => ({ url: base + '/large' }));
    const result = await large.handlers['prepare-online-play']({}, { vid: 'large', prefetch: true });
    assert.equal(result.success, false);
    assert.match(result.error, /过大/);
    assert.equal(large.run('onlineCache.size'), 0);
  });
  await check('plain source returns before downloading a single byte', async () => {
    const h = hload(async () => ({ url: base + '/slow', spadeA: '' }));
    const before = hits;
    const result = await Promise.race([h.handlers['prepare-online-play']({}, { vid: 'plain', requestId: 'one' }), sleep(150).then(() => ({ timedOut: true }))]);
    assert.equal(result.success, true, 'prepare must not wait for complete media');
    assert.equal(hits, before, 'media must be requested by video, not prepare');
    assert.ok(result.streamId);
  });
  await check('Range is forwarded; opaque sessions are released', async () => {
    const h = hload(async () => ({ url: base + '/range' }));
    const p = await h.handlers['prepare-online-play']({}, { vid: 'range', requestId: 'range-request' });
    const response = await h.protocols['hongguo-stream'](new Request(p.url, { headers: { range: 'bytes=2-4' } }));
    assert.equal(response.status, 206); assert.equal(await response.text(), '234');
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/10');
    assert.ok(h.handlers['release-online-play'], 'release IPC must exist');
    await h.handlers['release-online-play']({}, { streamId: p.streamId });
    assert.equal((await h.protocols['hongguo-stream'](new Request(p.url))).status, 404);
  });
  await check('release aborts active upstream body', async () => {
    const h = hload(async () => ({ url: base + '/slow' }));
    const p = await Promise.race([h.handlers['prepare-online-play']({}, { vid: 'abort' }), sleep(150).then(() => ({}))]);
    assert.ok(p.url, 'prepare must return a stream URL');
    streamClosed = false;
    const response = await h.protocols['hongguo-stream'](new Request(p.url));
    const reader = response.body.getReader(); await reader.read();
    await h.handlers['release-online-play']({}, { streamId: p.streamId });
    await sleep(30); assert.equal(streamClosed, true);
    await reader.cancel().catch(() => {});
  });
  await check('cancel during address lookup prevents stale ready state', async () => {
    let resolve; const h = hload(() => new Promise(r => resolve = r));
    const pending = h.handlers['prepare-online-play']({}, { vid: 'pending', requestId: 'cancel-me' });
    assert.ok(h.handlers['release-online-play']);
    await h.handlers['release-online-play']({}, { requestId: 'cancel-me' });
    resolve({ url: base + '/range' });
    assert.equal((await pending).success, false);
  });
  await check('encrypted fallback retains bytes and correct suffix/invalid Range', async () => {
    const h = hload(async () => ({ url: base + '/range', spadeA: 'encrypted' }), {
      './src/native/decrypt-worker.cjs': { decryptInWorker: async ({ buffer }) => buffer },
    });
    const p = await h.handlers['prepare-online-play']({}, { vid: 'encrypted' });
    let r = await h.protocols['hongguo-stream'](new Request(p.url, { headers: { range: 'bytes=-3' } }));
    assert.equal(await r.text(), '789');
    r = await h.protocols['hongguo-stream'](new Request(p.url, { headers: { range: 'bytes=12-20' } }));
    assert.equal(r.status, 416);
  });
  await check('broken upstream settles failed download and removes partial file', async () => {
    const h = hload(async () => ({ url: base + '/broken' }));
    const task = { id: 'broken', type: 'hongguo', filename: 'broken.mp4', customDir: root, hongguoInfo: { vid: 'broken' } };
    const settled = await Promise.race([h.context.executeHongguoDownload(task).then(() => true), sleep(250).then(() => false)]);
    assert.equal(settled, true, 'upstream failure must not leave queue hanging');
    assert.equal(task.status, 'failed'); assert.equal(fs.existsSync(path.join(root, 'broken.mp4.enc.tmp')), false);
  });
  await check('stop during lookup stays stopped and retry cannot overlap old run', async () => {
    let resolve; const h = hload(() => new Promise(r => resolve = r));
    h.run("downloadTasks = [{id:'stop',status:'pending',type:'hongguo',filename:'stop.mp4',customDir:" + JSON.stringify(root) + ",hongguoInfo:{vid:'stop'}}]; downloadQueue = downloadTasks.slice(); pumpQueue();");
    await h.handlers['stop-download']({}, 'stop');
    resolve({ url: base + '/range' }); await sleep(50);
    assert.equal(h.run('downloadTasks[0].status'), 'stopped');
    assert.equal(fs.existsSync(path.join(root, 'stop.mp4')), false);
  });
  await check('immediate retry cannot let cancelled lookup start a competing media writer', async () => {
    let resolve, lookups = 0;
    const before = hits;
    const h = hload(() => { lookups++; return lookups === 1 ? new Promise(r => resolve = r) : Promise.resolve({ url: base + '/range' }); });
    h.run("downloadTasks = [{id:'retry',status:'pending',type:'hongguo',filename:'retry.mp4',customDir:" + JSON.stringify(root) + ",hongguoInfo:{vid:'retry'}}]; downloadQueue = downloadTasks.slice(); pumpQueue();");
    await h.handlers['stop-download']({}, 'retry');
    await h.handlers['retry-task']({}, 'retry');
    assert.ok(h.run('runningDownloads.size') <= 1, 'only one task may own the destination');
    resolve({ url: base + '/range' }); await sleep(80);
    assert.equal(lookups, 2); assert.equal(h.run('downloadTasks[0].status'), 'completed');
    assert.equal(fs.readFileSync(path.join(root, 'retry.mp4'), 'utf8'), '0123456789');
    assert.equal(hits, before + 1, 'late cancelled lookup must not start a second media transfer');
  });
  await check('extra: enqueue reuses failed task instead of competing destination writers', async () => {
    const h = hload(() => new Promise(() => {}));
    h.run("downloadTasks = [{id:'old-failed',status:'failed',type:'hongguo',filename:'again.mp4',customDir:" + JSON.stringify(root) + ",hongguoInfo:{vid:'same',series_id:'S'}}];");
    h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Retry', episodes: [{ vid: 'same', vid_index: 1 }] });
    assert.equal(h.run('downloadTasks.length'), 1, 'one episode must retain one task');
    assert.equal(h.run('downloadTasks[0].id'), 'old-failed');
  });
  await check('extra: concurrent compatibility requests share one encoder and result', async () => {
    let spawned = 0;
    const h = hload(async () => ({ url: base + '/range' }), { child_process: {
      spawn: (_file, args) => {
        spawned++;
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        setTimeout(() => { fs.writeFileSync(args.at(-1), Buffer.alloc(120000)); child.emit('close', 0); }, 20);
        return child;
      }
    } });
    h.context.resolveFfmpeg = () => '/fake/ffmpeg';
    h.context.probeDuration = async () => 1;
    h.context.pickH264Encoder = async () => 'libx264';
    const input = path.join(root, 'compat-input.mp4'); fs.writeFileSync(input, 'fixture');
    const payload = { seriesId: 'same-series', vidIndex: 1, filePath: input, force: true };
    const results = await Promise.all([h.handlers['transcode-for-playback']({}, payload), h.handlers['transcode-for-playback']({}, payload)]);
    assert.equal(spawned, 1, 'same episode cannot run two encoders against one output');
    assert.ok(results.every(r => r.success)); assert.equal(results[0].url, results[1].url);
  });
  await check('recovery: forced reconnect bypasses cached bytes and refreshes source', async () => {
    let lookups = 0, forced = false;
    const h = hload(async (_vid, _sid, options) => { lookups++; forced = options?.force === true; return { url: base + '/range' }; });
    const cached = await h.handlers['prepare-online-play']({}, { vid: 'refresh', prefetch: true });
    assert.equal(cached.success, true);
    const fresh = await h.handlers['prepare-online-play']({}, { vid: 'refresh', force: true });
    assert.equal(fresh.success, true); assert.equal(fresh.cached, false, 'failed cache was reused');
    assert.equal(fresh.streaming, true); assert.equal(lookups, 2); assert.equal(forced, true);
  });
  await check('recovery: forced reconnect avoids stale pending prefetch and stale cache publication', async () => {
    let finishOld, lookups = 0;
    const h = hload(async () => { lookups++; return lookups === 1 ? new Promise(resolve => { finishOld = resolve; }) : { url: base + '/range' }; });
    const old = h.handlers['prepare-online-play']({}, { vid: 'pending-refresh', prefetch: true });
    const freshWork = h.handlers['prepare-online-play']({}, { vid: 'pending-refresh', force: true });
    const fresh = await Promise.race([freshWork, sleep(100).then(() => ({ timeout: true }))]);
    finishOld({ url: base + '/range' }); await old; await freshWork;
    assert.equal(fresh.success, true, 'forced request waited for stale preparation');
    assert.equal(fresh.streaming, true); assert.equal(h.run('onlineCache.size'), 0, 'old prefetch republished stale bytes');
  });
  await check('recovery: releasing superseded prefetch cancels only its own transfer', async () => {
    const h = hload(async () => ({ url: base + '/range' }));
    let finishBody, oldSignal;
    h.context.fetchDecryptedEpisodeOnce = async (_vid, _progress, _sid, _info, signal) => {
      oldSignal = signal; return new Promise(resolve => { finishBody = resolve; });
    };
    const old = h.handlers['prepare-online-play']({}, { vid: 'superseded', requestId: 'old-prefetch', prefetch: true });
    await sleep(0);
    const fresh = await h.handlers['prepare-online-play']({}, { vid: 'superseded', requestId: 'fresh-stream', force: true });
    await h.handlers['release-online-play']({}, { requestId: 'old-prefetch' });
    const aborted = oldSignal.aborted;
    finishBody(Buffer.from('stale')); await old;
    assert.equal(aborted, true, 'superseded preparation lost its cancellation owner');
    assert.equal((await h.protocols['hongguo-stream'](new Request(fresh.url))).status, 200);
  });
  await check('recovery: forced compatibility input asks native provider for fresh URL', async () => {
    let forced = false;
    const h = hload(async (_vid, _sid, options) => { forced = options?.force === true; return { url: base + '/range' }; });
    assert.equal((await h.context.fetchDecryptedEpisode('compat-refresh', null, 'S', undefined, undefined, Infinity, true)).length, 10);
    assert.equal(forced, true);
  });
  for (const endpoint of ['partial', 'short-partial', 'empty', 'error-page', 'missing']) {
    await check('recovery: ' + endpoint + ' response never becomes playback cache', async () => {
      const h = hload(async () => ({ url: base + '/' + endpoint }));
      const result = await h.handlers['prepare-online-play']({}, { vid: endpoint, prefetch: true });
      assert.equal(result.success, false, endpoint + ' response was accepted as full video');
      assert.equal(h.run('onlineCache.size'), 0);
    });
  }
  await check('recovery: empty download never publishes a completed file', async () => {
    const h = hload(async () => ({ url: base + '/empty' }));
    const task = { id: 'empty', type: 'hongguo', filename: 'empty.mp4', customDir: root, hongguoInfo: { vid: 'empty' } };
    await h.context.executeHongguoDownload(task);
    assert.equal(task.status, 'failed'); assert.equal(fs.existsSync(path.join(root, 'empty.mp4')), false);
    assert.equal(fs.existsSync(path.join(root, 'empty.mp4.enc.tmp')), false);
  });
  await check('recovery: complete 206 response remains usable for full prefetch', async () => {
    const h = hload(async () => ({ url: base + '/full-partial' }));
    const result = await h.handlers['prepare-online-play']({}, { vid: 'full-partial', prefetch: true });
    assert.equal(result.success, true); assert.equal(result.size, 10);
  });
  await check('recovery: 403 retries once with provider Referer and preserves valid body', async () => {
    const h = hload(async () => ({ url: base + '/referer', source: 'app' })), before = hits;
    const result = await h.handlers['prepare-online-play']({}, { vid: 'referer', prefetch: true });
    assert.equal(result.success, true); assert.equal(result.size, 10); assert.equal(hits, before + 2);
  });
  await check('recovery: unknown and third-party sources never acquire the App Referer', async () => {
    const h = hload(async () => ({}));
    for (const source of [undefined, 'xifan', 'hema', 'custom']) {
      const before = requests.length;
      await assert.rejects(h.context.requestMedia({ url: base + '/referer', source }), /HTTP 403/);
      assert.equal(requests.length - before, 2, '403 retries remain bounded');
      assert.ok(requests.slice(before).every(request => request.headers.referer === undefined));
    }
  });
  await check('recovery: local files serve suffix and reject malformed or unsatisfiable Range', async () => {
    const h = hload(async () => ({})), file = path.join(root, 'local-range.mp4');
    fs.writeFileSync(file, '0123456789'); const url = h.context.localPlayUrl(file);
    const suffix = await h.protocols['hongguo-local'](new Request(url, { headers: { range: 'bytes=-3' } }));
    assert.equal(suffix.status, 206); assert.equal(await suffix.text(), '789');
    assert.equal(suffix.headers.get('content-range'), 'bytes 7-9/10');
    for (const range of ['bytes=12-20', 'bytes=5-2', 'bytes=0-2,4-6', 'junk']) {
      const response = await h.protocols['hongguo-local'](new Request(url, { headers: { range } }));
      assert.equal(response.status, 416, range); assert.equal(response.headers.get('content-range'), 'bytes */10');
    }
  });
  await check('recovery: cancelling local reads during seek never closes an already closed stream', async () => {
    const h = hload(async () => ({})), file = path.join(root, 'local-cancel.mp4');
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
    const url = h.context.localPlayUrl(file), errors = [];
    const onError = error => errors.push(error);
    process.on('uncaughtException', onError);
    try {
      for (const headers of [{}, { range: 'bytes=65536-' }]) {
        for (let index = 0; index < 40; index++) {
          const response = await h.protocols['hongguo-local'](new Request(url, { headers }));
          const reader = response.body.getReader();
          for (let count = 0; count < index % 18; count++) if ((await reader.read()).done) break;
          const pending = reader.read();
          await new Promise(resolve => setImmediate(resolve));
          await reader.cancel();
          await pending;
        }
      }
      await sleep(20);
      assert.deepEqual(errors.map(error => error.code), [], 'seeking must not raise an uncaught stream-close error');
    } finally {
      process.removeListener('uncaughtException', onError);
    }
  });
  for (const h of harnesses) {
    h.context.clearOnlineCache();
    h.run('for (const task of downloadTasks) task.cancelSource?.cancel("fixture cleanup")');
  }
  await sleep(0);
  server.closeAllConnections(); await new Promise(r => server.close(r));
  assert.equal(failures, 0, `${failures} streaming regressions`);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
