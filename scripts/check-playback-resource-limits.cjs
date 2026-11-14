// Offline resource regressions with a tiny buffer budget; no large allocations or external media.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { mount } = require('./check-player-resume.cjs');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-resources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = {}, protocols = {}, app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (n, fn) => handlers[n] = fn }, protocol: { registerSchemesAsPrivileged() {}, handle: (n, fn) => protocols[n] = fn } };
  const native = { fetchPlayUrlSingle: async () => ({ url: 'https://fixture.invalid/media' }) };
  const context = vm.createContext({ require: n => n === 'electron' ? electron : n === './src/native/hongguo' ? native : n === './src/store' ? { getSettings: () => ({ root }), saveTasks() {} } : req(n), __dirname: path.dirname(source), process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } });
  const code = fs.readFileSync(source, 'utf8');
  assert.ok(code.includes('const ONLINE_MAX_BYTES = 300 * 1024 * 1024;'));
  vm.runInContext(code.replace('const ONLINE_MAX_BYTES = 300 * 1024 * 1024;', 'const ONLINE_MAX_BYTES = 8;'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  context.verifyDownloadQuality = async () => '1080p';
  return { root, context, handlers, protocols, run: code => vm.runInContext(code, context),
    media(chunks, headers = {}) {
      const data = Readable.from(chunks.map(chunk => Buffer.from(chunk)));
      context.requestMedia = async () => ({ data, headers, status: 200 });
      return data;
    } };
}
const oversized = error => error.code === 'MEDIA_TOO_LARGE' && /本集过大，请下载后播放/.test(error.message);

test('whole-file buffer reads reject declared and undeclared oversize even when a caller passes Infinity', async t => {
  const h = fixture(t), info = { url: 'https://fixture.invalid/media' };
  for (const [chunks, headers, limit] of [[['123456789'], { 'content-length': '9' }, undefined], [['1234', '56789'], {}, Infinity]]) {
    const stream = h.media(chunks, headers);
    await assert.rejects(h.context.fetchDecryptedEpisodeOnce('11', null, '1', info, undefined, limit), oversized);
    assert.equal(stream.destroyed, true);
  }
  h.media(['12345678']);
  assert.equal((await h.context.fetchDecryptedEpisodeOnce('11', null, '1', info)).toString(), '12345678');
});

test('decrypted file is checked before loading it into memory and its temporary directory is removed', async t => {
  const h = fixture(t);
  h.media(['1234']);
  h.context.decryptContentKeyFile = async (_, output) => fs.promises.writeFile(output, '123456789');
  await assert.rejects(h.context.fetchDecryptedEpisodeOnce('11', null, '1', { url: 'https://fixture.invalid/media', contentKey: 'a'.repeat(32) }), oversized);
  assert.deepEqual(fs.readdirSync(h.root), []);
});

test('online preparation returns actionable oversized error without caching bytes', async t => {
  const h = fixture(t);
  h.media(['123456789'], { 'content-length': '9' });
  const result = await h.handlers['prepare-online-play']({}, { vid: '11', seriesId: '1', prefetch: true });
  assert.equal(result.success, false);
  assert.equal(result.code, 'MEDIA_TOO_LARGE');
  assert.match(result.error, /本集过大，请下载后播放/);
  assert.equal(h.run('onlineCache.size'), 0);
});

test('a streaming source switching to oversized encrypted media notifies its matching player request', async t => {
  const h = fixture(t), events = [];
  h.context.sendToRenderer = (channel, payload) => events.push({ channel, payload });
  const prepared = await h.handlers['prepare-online-play']({}, { vid: '11', seriesId: '1', requestId: 'playing' });
  assert.equal(prepared.streaming, true);
  h.context.withMediaRecovery = async (_, __, ___, consume) => consume({ url: 'https://fixture.invalid/media', spadeA: 'encrypted' });
  h.media(['123456789'], { 'content-length': '9' });
  h.context.registerStreamProtocol();
  const result = await h.protocols['hongguo-stream'](new Request(prepared.url));
  assert.equal(result.status, 502);
  assert.ok(events.some(event => event.channel === 'online-play-progress' && event.payload.requestId === 'playing'
    && event.payload.code === 'MEDIA_TOO_LARGE' && /本集过大，请下载后播放/.test(event.payload.error)));
});

test('ordinary disk download can exceed the buffer budget and task changes notify playback', async t => {
  const h = fixture(t), events = [];
  h.context.sendToRenderer = (channel, payload) => events.push({ channel, payload });
  h.media(['123456789'], { 'content-length': '9' });
  const task = { id: 'one', type: 'hongguo', filename: 'one.mp4', customDir: h.root, hongguoInfo: { vid: '11', series_id: '1' } };
  h.context.fixtureTask = task; h.run('downloadTasks = [fixtureTask]');
  await h.context.executeHongguoDownload(task);
  assert.equal(task.status, 'completed', task.error);
  assert.equal(fs.readFileSync(task.savePath, 'utf8'), '123456789');
  h.context.fixtureTask = task; h.run('downloadTasks = [fixtureTask]');
  events.length = 0;
  assert.equal((await h.handlers['delete-task']({}, task.id)).success, true);
  assert.ok(events.some(event => event.channel === 'download-queue-changed'));
});

test('idle player avoids repeated directory scans while download events and page return refresh details', async () => {
  let calls = 0, status = 'completed', retryAt, episodeCount = 1;
  const listeners = new Map();
  const subscriptions = Object.fromEntries(['onDownloadTaskAdded', 'onDownloadCompleted', 'onDownloadFailed', 'onDownloadStopped', 'onDownloadQueueChanged', 'onWatchHistoryUpdated'].map(name => [name, fn => { listeners.set(name, fn); return () => listeners.delete(name); }]));
  const ui = mount({ local: true, apiOverrides: { ...subscriptions, getSeriesEpisodes: async () => {
    calls++;
    return { success: true, data: { series_id: 'A', episodes: Array.from({ length: episodeCount }, (_, index) => ({ vid: `v${index + 1}`, vid_index: index + 1, status, retryAt, ...(status === 'completed' ? { fileUrl: `file:///mock-${index + 1}.mp4`, savePath: `/mock-${index + 1}.mp4` } : {}) })) } };
  } } });
  const poll = async () => { await [...ui.timers.values()].find(timer => timer.delay === 2000)?.fn(); await ui.flush(); };
  try {
    await ui.flush(); await poll();
    let before = calls;
    await poll(); await poll();
    assert.equal(calls, before, 'unchanged playback must not rescan files every two seconds');
    for (const name of Object.keys(subscriptions)) {
      listeners.get(name)?.(); await poll();
      assert.equal(calls, ++before, name);
    }
    episodeCount = 2; listeners.get('onWatchHistoryUpdated')?.(); await poll();
    assert.ok(ui.find(node => node.props['aria-label'] === '第 2 集'), 'newly published episode must appear without reopening playback');
    status = 'pending'; listeners.get('onDownloadTaskAdded')?.(); await poll(); before = calls;
    await poll(); assert.equal(calls, before, 'pending download waits for events without scanning');
    status = 'failed'; retryAt = Date.now() + 60000; listeners.get('onDownloadFailed')?.(); await poll(); before = calls;
    await poll(); assert.equal(calls, before, 'scheduled retry waits for events without scanning');
    status = 'completed'; retryAt = null; listeners.get('onDownloadCompleted')?.(); await poll(); before = calls;
    await poll(); assert.equal(calls, before, 'completed download returns to idle');
    ui.props.active = false; ui.render(); await ui.flush();
    ui.props.active = true; ui.render(); await ui.flush(); await poll();
    assert.ok(calls > before, 'returning to playback must refresh files changed elsewhere');
  } finally { ui.unmount(); }
  assert.equal(listeners.size, 0);
});

test('oversized prepare and protocol errors remain visible while automatic download recovery stays available', async () => {
  let downloads = 0, progress;
  const tooLarge = { success: false, code: 'MEDIA_TOO_LARGE', error: '本集过大，请下载后播放' };
  const ui = mount({ prepare: async () => tooLarge, props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
    apiOverrides: { downloadSingleEpisode: async () => { downloads++; return { success: true }; } } });
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  try {
    await ui.flush(); assert.match(text(ui.find(n => n.props.className?.includes('dm-toast'))), /本集过大，请下载后播放/);
    assert.equal(downloads, 1); assert.ok(ui.button('取消等待'));
  }
  finally { ui.unmount(); }
  const streaming = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, apiOverrides: {
    onOnlinePlayProgress: fn => { progress = fn; return () => {}; },
  } });
  try {
    await streaming.flush();
    progress({ ...tooLarge, requestId: streaming.prepares.at(-1).requestId }); await streaming.flush();
    assert.match(text(streaming.find(n => n.props.className?.includes('dm-toast'))), /本集过大，请下载后播放/);
  } finally { streaming.unmount(); }
});
