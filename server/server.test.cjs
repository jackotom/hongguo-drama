const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp, makeTask } = require('./index.cjs');
const { Storage } = require('./storage.cjs');
const { mediaGuard } = require('./media.cjs');
const TOKEN = 'test-only-'.repeat(6);
const detail = { series_id: '123', series_title: '安全/剧名', total: 2, episodes: [{ vid: '456', vid_index: 1, title: '第一集' }, { vid: '789', vid_index: 2, title: '第二集' }] };
async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-server-test-'));
  const app = createApp({ token: TOKEN, dataRoot: path.join(root, 'data'), downloadRoot: path.join(root, 'downloads'), autoStart: false, media: { series: async () => detail }, ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (route, payload, headers = {}) => {
    const response = await fetch(base + route, { method: payload === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${TOKEN}`, ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, root, api, base };
}
test('requires a strong token and rejects unauthorized/cross-origin writes', async t => {
  assert.throws(() => createApp({ token: 'short' }), /HONGGUO_TOKEN/);
  const { api } = await setup(t);
  assert.equal((await api('/api/tasks', undefined, { Authorization: '' })).status, 401);
  assert.equal((await api('/api/downloads', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('/health', undefined, { Authorization: '' })).status, 200);
});
test('accepts only catalogue episode IDs and does not accept URLs or paths', async t => {
  const { api } = await setup(t);
  for (const payload of [{ seriesId: '../123', episodeIds: ['456'] }, { seriesId: '123', episodeIds: ['999'] }, { seriesId: '123', episodeIds: ['456'], url: 'http://127.0.0.1' }, { seriesId: '123', episodeIds: ['456'], directory: '/tmp' }, { seriesId: '123', episodeIds: ['456', '456'] }]) assert.equal((await api('/api/downloads', payload)).status, 400);
  const first = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  const second = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  assert.equal(first.status, 202); assert.equal(first.body.tasks[0].id, second.body.tasks[0].id);
});
test('persistent queue survives restart; running tasks require explicit retry', async t => {
  const { app, api, root } = await setup(t);
  const { body } = await api('/api/downloads', { seriesId: '123', episodeIds: ['456', '789'] });
  app.store.update(app.store.get(body.tasks[0].id), { status: 'running' });
  const loaded = new Storage(path.join(root, 'data'), path.join(root, 'downloads'));
  assert.equal(loaded.tasks[0].status, 'interrupted'); assert.equal(loaded.tasks[1].status, 'queued');
});
test('downloads wait one second after completion and shutdown cancels queued wakeups', async t => {
  let calls = 0;
  const { app, api } = await setup(t, { media: { series: async () => detail, download: async () => { calls++; } } });
  await api('/api/downloads', { seriesId: '123', episodeIds: ['456', '789'] });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const turn = () => new Promise(resolve => setImmediate(resolve));
  try {
    app.drain(); await turn(); await turn();
    assert.equal(calls, 1, 'the next download must not start immediately');
    t.mock.timers.tick(999); await turn(); assert.equal(calls, 1);
    t.mock.timers.tick(1); await turn(); await turn(); assert.equal(calls, 2);
    app.store.add([makeTask({ type: 'download', seriesId: '123', vid: '999', episodeIndex: 3, quality: 'auto' })]);
    app.drain(); await app.close();
    t.mock.timers.tick(1000); await turn(); assert.equal(calls, 2, 'shutdown must not start another download');
  } finally { t.mock.timers.reset(); }
});
test('rejects destination symlinks and never overwrites a conflicting file', async t => {
  const { app, api, root } = await setup(t);
  const added = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  const task = app.store.get(added.body.tasks[0].id), file = app.store.output(task), outside = path.join(root, 'outside');
  fs.writeFileSync(outside, 'keep'); fs.symlinkSync(outside, file);
  assert.throws(() => app.store.output(task), /普通文件/); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  fs.unlinkSync(file); fs.rmdirSync(path.dirname(file)); fs.symlinkSync(root, path.dirname(file));
  assert.throws(() => app.store.output(task), /符号链接/);
});
test('CDN guard blocks arbitrary destinations and redirect escapes', () => {
  for (const url of ['http://v.qznovelvod.com/a.mp4', 'https://127.0.0.1/a', 'https://example.org/a', 'https://qznovelvod.com.evil.org/a', 'https://v.bdcgslb.com.evil.org/a', 'http://v.bdcgslb.com/a', 'https://user:pass@v.qznovelvod.com/a']) assert.throws(() => mediaGuard(url));
  const guard = mediaGuard('https://v.qznovelvod.com/a');
  assert.equal(guard.proxy, false);
  assert.doesNotThrow(() => guard.beforeRedirect({}, { headers: { location: 'https://v.bdcgslb.com/video.mp4' } }, { url: 'https://v.qznovelvod.com/a' }));
  const redirected = mediaGuard('https://v.bdcgslb.com/video.mp4');
  assert.throws(() => redirected.beforeRedirect({}, { headers: { location: 'https://127.0.0.1/' } }, { url: 'https://v.bdcgslb.com/video.mp4' }));
  assert.throws(() => guard.beforeRedirect({}, { headers: { location: 'https://127.0.0.1/' } }, { url: 'https://v.qznovelvod.com/a' }));
});
test('cancel state is persisted before abort and late completion cannot revive it', async t => {
  let abortedStatus, release;
  const { app, api } = await setup(t, { media: { series: async () => detail, download: async (task, store, signal) => new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => { abortedStatus = JSON.parse(fs.readFileSync(store.stateFile)).tasks[0].status; resolve(); }); }) } });
  const added = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  app.drain();
  const cancelled = await api(`/api/tasks/${added.body.tasks[0].id}/cancel`, {});
  assert.equal(cancelled.status, 200); assert.equal(abortedStatus, 'cancelled'); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(app.store.tasks[0].status, 'cancelled');
});
test('merge rejects unrelated, duplicate or missing files and sorts by episode', async t => {
  const { app, api } = await setup(t);
  const added = await api('/api/downloads', { seriesId: '123', episodeIds: ['456', '789'] });
  const ids = added.body.tasks.map(task => task.id);
  assert.equal((await api('/api/merge', { taskIds: ids })).status, 400);
  for (const task of app.store.tasks) { fs.writeFileSync(app.store.output(task), 'metadata-only fixture, never a playback video'); app.store.update(task, { status: 'completed' }); }
  assert.equal((await api('/api/merge', { taskIds: [ids[0], ids[0]] })).status, 400);
  const merged = await api('/api/merge', { taskIds: [...ids].reverse() });
  assert.equal(merged.status, 202); assert.deepEqual(app.store.get(merged.body.task.id).taskIds, ids);
});
test('failed persistence rolls status back before cancellation occurs', async t => {
  const { app, api } = await setup(t);
  const added = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  const oldSave = app.store.save; app.store.save = () => { throw new Error('write failed'); };
  assert.equal((await api(`/api/tasks/${added.body.tasks[0].id}/cancel`, {})).status, 500);
  assert.equal(app.store.tasks[0].status, 'queued'); app.store.save = oldSave;
});
test('progress persistence failure aborts work safely and stops queue', async t => {
  let updateProgress, aborted = false;
  const { app, api } = await setup(t, { media: { series: async () => detail, download: async (task, store, signal, update) => new Promise(resolve => { updateProgress = update; signal.addEventListener('abort', () => { aborted = true; resolve(); }); }) } });
  await api('/api/downloads', { seriesId: '123', episodeIds: ['456', '789'] });
  app.drain(); const save = app.store.save; app.store.save = () => { throw new Error('disk full'); };
  assert.doesNotThrow(() => updateProgress(10));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true); assert.equal(app.store.tasks[1].status, 'queued'); assert.equal((await api('/health')).status, 503);
  await app.close(); app.store.save = save;
});
test('explicit source rejection pauses pending episodes without another request', async t => {
  let calls = 0;
  const { app, api } = await setup(t, { media: { series: async () => detail, download: async () => { calls++; throw Object.assign(new Error('没有完整片源'), { code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code: 'HTTP_403' }] }); } } });
  await api('/api/downloads', { seriesId: '123', episodeIds: ['456', '789'] }); app.drain();
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(app.store.tasks[0].status, 'failed'); assert.equal(app.store.tasks[1].status, 'interrupted');
});
for (const status of [403, 429]) {
  test(`CDN HTTP ${status} pauses pending downloads without another request`, async t => {
    let calls = 0;
    const { app, api } = await setup(t, { media: { series: async () => detail, download: async () => { calls++; throw Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } }); } } });
    await api('/api/downloads', { seriesId: '123', episodeIds: ['456', '789'] }); app.drain();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1); assert.equal(app.store.tasks[0].status, 'failed'); assert.equal(app.store.tasks[1].status, 'interrupted');
  });
}
test('replaced task mount stops persistence without creating a new state file', async t => {
  const { app } = await setup(t);
  const dir = app.store.dataRoot; fs.renameSync(dir, dir + '-old'); fs.mkdirSync(dir);
  assert.throws(() => app.store.save(), /挂载已变化/); assert.equal(fs.existsSync(path.join(dir, 'tasks.json')), false);
});
test('retry cannot duplicate another active task for the same episode and quality', async t => {
  const { api } = await setup(t);
  const first = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  await api(`/api/tasks/${first.body.tasks[0].id}/cancel`, {});
  const second = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  assert.notEqual(first.body.tasks[0].id, second.body.tasks[0].id);
  assert.equal((await api(`/api/tasks/${first.body.tasks[0].id}/retry`, {})).status, 409);
});
test('completed task with a deleted artifact is requeued instead of reused', async t => {
  const { app, api } = await setup(t);
  const added = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  const id = added.body.tasks[0].id, task = app.store.get(id), file = app.store.output(task);
  fs.writeFileSync(file, 'stub completed artifact'); app.store.update(task, { status: 'completed', progress: 100 });
  const reuse = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  assert.equal(reuse.status, 202); assert.equal(reuse.body.tasks[0].id, id); assert.equal(app.store.get(id).status, 'completed');
  fs.rmSync(file);
  const redownload = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  assert.equal(redownload.status, 202); assert.equal(redownload.body.tasks[0].id, id);
  assert.equal(app.store.tasks.filter(item => item.type === 'download' && item.vid === '456').length, 1);
  assert.equal(app.store.get(id).status, 'queued');
});
test('missing download mount returns safe 409 and interrupts queued downloads', async t => {
  const { app, api, root } = await setup(t);
  await api('/api/downloads', { seriesId: '123', episodeIds: ['456', '789'] });
  fs.rmSync(path.join(root, 'downloads'), { recursive: true, force: true });
  const result = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  assert.equal(result.status, 409); assert.equal(result.body.code, 'MOUNT_CHANGED');
  assert.equal(result.body.error.includes(root), false);
  assert.deepEqual(app.store.tasks.map(task => task.status), ['interrupted', 'interrupted']);
});
test('changed completed artifact is requeued by repeated submission', async t => {
  const { app, api } = await setup(t);
  const added = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  const id = added.body.tasks[0].id, task = app.store.get(id), file = app.store.output(task);
  fs.writeFileSync(file, 'verified fixture'); app.store.complete(task);
  fs.appendFileSync(file, ' changed');
  const repeated = await api('/api/downloads', { seriesId: '123', episodeIds: ['456'] });
  assert.equal(repeated.status, 202); assert.equal(repeated.body.tasks[0].id, id);
  assert.equal(app.store.get(id).status, 'queued');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.startsWith(`.invalid-${id}-`)), true);
});
test('missing, zero-size and non-regular completed artifacts become interrupted', async t => {
  const { app, api } = await setup(t);
  const tasks = [1, 2, 3].map(index => makeTask({ type: 'download', seriesId: '123', seriesTitle: '测试', vid: String(100 + index), episodeIndex: index, quality: 'auto' }));
  app.store.add(tasks);
  for (const task of tasks) { fs.writeFileSync(app.store.output(task), 'verified fixture'); app.store.complete(task); }
  fs.rmSync(app.store.output(tasks[0]));
  fs.truncateSync(app.store.output(tasks[1]), 0);
  fs.rmSync(app.store.output(tasks[2])); fs.mkdirSync(app.store.output(tasks[2]));
  const listed = await api('/api/tasks');
  assert.equal(listed.status, 200);
  for (const task of tasks) {
    assert.equal(app.store.get(task.id).status, 'interrupted');
    assert.equal(listed.body.tasks.find(item => item.id === task.id).file, undefined);
  }
});
test('startup removes stale download staging directories only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-server-cleanup-'));
  const data = path.join(root, 'data'), downloads = path.join(root, 'downloads'), series = path.join(downloads, '测试_123');
  fs.mkdirSync(data); fs.mkdirSync(series, { recursive: true });
  const stale = path.join(series, '.download-A1B2C3'); fs.mkdirSync(stale); fs.writeFileSync(path.join(stale, 'input.mp4'), 'partial');
  const userDir = path.join(series, '.download-notes'); fs.mkdirSync(userDir);
  const keep = path.join(series, '.download-note'); fs.writeFileSync(keep, 'keep');
  new Storage(data, downloads);
  assert.equal(fs.existsSync(stale), false); assert.equal(fs.readFileSync(keep, 'utf8'), 'keep');
  assert.equal(fs.existsSync(userDir), true);
  fs.rmSync(root, { recursive: true, force: true });
});
