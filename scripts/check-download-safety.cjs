// Offline behavioral checks. All files live in a disposable directory; no app data/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-safety-'));
let serial = 0, failures = 0;
function load(settings = {}, overrides = {}) {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  const handlers = {}, app = new EventEmitter(), opened = [], proxyCalls = [];
  let stored = { root: dir, ...settings };
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = {
    app, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} },
    shell: { showItemInFolder: target => { opened.push(target); }, openPath: async target => { opened.push(`open:${target}`); return ''; } },
    session: { defaultSession: { setProxy: async options => { proxyCalls.push(options); } } },
  };
  const store = { getSettings: () => ({ ...stored }), saveTasks() {}, saveSeries() {}, saveSettings(next) { stored = { ...next }; } };
  const context = vm.createContext({ require: name => overrides[name] || (name === 'electron' ? electron : name === './src/store' ? store : req(name)), __dirname: path.dirname(source), process: { ...process, env: { ...process.env } }, console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  const pump = context.pumpQueue;
  context.pumpQueue = () => {}; // Inspect queued destinations without fetching media.
  return { app, context, handlers, dir, pump, opened, proxyCalls, settings: () => stored, run: code => vm.runInContext(code, context), set(name, value) { context.fixture = value; vm.runInContext(`${name} = fixture`, context); } };
}
function task(id, dir, status = 'completed', filename = `${id}.mp4`, index = 1) {
  return { id, type: 'hongguo', status, filename, savePath: path.join(dir, filename), customDir: dir, hongguoInfo: { vid: id, series_id: 'S', series_title: 'Short', vid_index: index } };
}
function series() { return [{ series_id: 'S', series_title: 'Short', episodes: [{ vid: 'one', vid_index: 1 }, { vid: 'two', vid_index: 2 }] }]; }
function file(p) { fs.writeFileSync(p, Buffer.alloc(120000)); }
async function check(name, run) { try { await run(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); } }
(async () => {
  await check('merge list excludes online-only and deleted files without hiding the library', async () => {
    const h = load(); h.set('seriesRegistry', series());
    const list = () => h.handlers['get-series-list']({}, { downloadedOnly: true });
    assert.equal((await list()).length, 0, 'online-only series must not be merge candidates');
    const one = task('one', h.dir); file(one.savePath); h.set('downloadTasks', [one]);
    assert.equal((await list()).length, 1, 'existing downloaded episode must remain mergeable');
    fs.unlinkSync(one.savePath);
    assert.equal((await list()).length, 0, 'deleted files must not leave merge candidates');
    assert.equal((await h.handlers['get-series-list']({})).length, 1, 'online library must remain intact');
    h.set('downloadTasks', []);
    const dir = h.context.seriesDownloadDir(h.dir, 'S', 'Short'); fs.mkdirSync(dir, { recursive: true });
    file(path.join(dir, 'Short 001.mp4'));
    assert.equal((await list()).length, 1, 'disk files retained after record cleanup remain mergeable');
  });
  await check('record-only deletion keeps downloaded files mergeable for built-in naming formats', async () => {
    for (const name_format of ['剧名', '剧名 集数', '剧名 集数 标题']) {
      const h = load({ name_format });
      const entry = series()[0]; entry.episodes[0].title = 'Story 999'; h.set('seriesRegistry', [entry]);
      await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: entry.episodes });
      const tasks = h.run('downloadTasks');
      for (const item of tasks) { fs.mkdirSync(path.dirname(item.savePath), { recursive: true }); file(item.savePath); item.status = 'completed'; }
      const removed = await h.handlers['delete-tasks']({}, tasks.map(item => item.id), { deleteFiles: false });
      assert.equal(removed.success, true); assert.ok(tasks.every(item => fs.existsSync(item.savePath)));
      assert.equal((await h.handlers['get-series-list']({}, { downloadedOnly: true })).length, 1, name_format);
      assert.equal(JSON.stringify(h.context.collectSeriesEpisodeFiles('S', 'Short').ordered.map(item => item.vid_index)), '[1,2]', name_format);
    }
  });
  await check('title-only preset keeps episode destinations unique', async () => {
    const h = load({ name_format: '剧名' });
    await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: series()[0].episodes });
    const paths = h.run('downloadTasks.map(task => task.savePath)');
    assert.equal(new Set(paths).size, 2, 'different episodes must not share a final or temporary path');
  });
  await check('same-title series use independent directories; legacy records still resolve', () => {
    const h = load();
    assert.notEqual(h.context.seriesDownloadDir(h.dir, 'S1', 'Short'), h.context.seriesDownloadDir(h.dir, 'S2', 'Short'));
    const old = task('old', h.dir); file(old.savePath); h.set('downloadTasks', [old]);
    assert.equal(h.context.collectSeriesEpisodeFiles('S', 'Short').ordered[0].path, old.savePath);
  });
  await check('missing completed file is shown missing and can be downloaded again', async () => {
    const h = load(); h.set('seriesRegistry', series()); h.set('downloadTasks', [task('one', h.dir)]);
    const detail = await h.handlers['get-series-episodes']({}, 'S');
    assert.equal(detail.data.episodes[0].status, 'missing', 'a missing file cannot remain completed');
    const added = await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: [series()[0].episodes[0]] });
    assert.equal(added, 1); assert.equal(h.run('downloadTasks.length'), 1); assert.equal(h.run('downloadTasks[0].status'), 'pending');
  });
  await check('delete downloaded files preserves active and waiting downloads', async () => {
    const h = load(); const completed = task('one', h.dir), active = task('two', h.dir, 'downloading', 'two.mp4', 2), waiting = task('three', h.dir, 'pending', 'three.mp4', 3);
    file(completed.savePath); h.set('seriesRegistry', series()); h.set('downloadTasks', [completed, active, waiting]); h.set('downloadQueue', [waiting]);
    const result = await h.handlers['delete-all-downloaded']({});
    assert.equal(result.success, true); assert.equal(fs.existsSync(completed.savePath), false);
    assert.equal(h.run('downloadTasks.some(task => task.id === "two")'), true, 'active task disappeared');
    assert.equal(h.run('downloadQueue.some(task => task.id === "three")'), true, 'waiting task disappeared');
  });
  await check('auto-delete uses task identity with title suffixes', async () => {
    const h = load(); const one = task('one', h.dir, 'completed', 'Short 001 Reunion.mp4');
    const two = task('two', h.dir, 'completed', 'Short 002 Story 001.mp4', 2);
    file(one.savePath); file(two.savePath); h.set('seriesRegistry', series()); h.set('downloadTasks', [one, two]);
    const result = await h.handlers['delete-episode-file']({}, 'S', 1);
    assert.equal(result.count, 1); assert.equal(fs.existsSync(one.savePath), false, 'target episode remains');
    assert.equal(fs.existsSync(two.savePath), true, 'unrelated episode was deleted by title digits');
  });
  await check('explicit task deletion waits for an active lookup to finish cancelling', async () => {
    let finishLookup;
    const h = load({}, { './src/native/hongguo': { fetchPlayUrlSingle: () => new Promise(resolve => { finishLookup = resolve; }) } });
    const one = task('one', h.dir, 'pending'); h.set('downloadTasks', [one]); h.set('downloadQueue', [one]); h.pump();
    const deleting = h.handlers['delete-task']({}, 'one', { deleteFiles: true });
    assert.equal(h.run('downloadTasks.length'), 1, 'record removed before its active run settled');
    finishLookup({ url: null }); await deleting;
    assert.equal(h.run('downloadTasks.length'), 0); assert.equal(h.run('runningDownloads.size'), 0);
  });
  await check('failed file deletion keeps the task record', async () => {
    const denied = Object.create(fs); denied.unlinkSync = () => { throw new Error('permission denied'); };
    const h = load({}, { fs: denied }); const one = task('one', h.dir, 'completed', 'Short 001.mp4');
    file(one.savePath); h.set('seriesRegistry', series()); h.set('downloadTasks', [one]);
    const result = await h.handlers['delete-episode-file']({}, 'S', 1);
    assert.ok(result.success === false || result.failed > 0, 'deletion failure must reach caller');
    assert.equal(h.run('downloadTasks.length'), 1, 'failed deletion lost its recovery record');
  });
  await check('task file deletion preserves running merge inputs and records', async () => {
    for (const handler of ['delete-task', 'delete-tasks']) {
      const h = load(), one = task('one', h.dir); file(one.savePath);
      h.set('downloadTasks', [one]); h.set('mergeTasks', [{seriesId:'S', status:'running'}]);
      const result = await h.handlers[handler]({}, handler === 'delete-task' ? 'one' : ['one'], {deleteFiles:true});
      assert.equal(result.success, false, handler);
      assert.equal(fs.existsSync(one.savePath), true);
      assert.equal(h.run('downloadTasks.length'), 1);
      assert.equal(h.run('downloadTasks[0].status'), 'completed');
    }
  });
  await check('merge episode selection retains the newest task regardless of array order', () => {
    const h = load(), latest = {...task('latest', h.dir), startTime:30}, old = {...task('old', h.dir), startTime:10};
    file(latest.savePath); file(old.savePath); h.set('downloadTasks', [latest, old]);
    assert.equal(h.context.collectSeriesEpisodeFiles('S','Short').ordered[0].path, latest.savePath);
  });
  await check('store save failure is reported and retains the durable snapshot', () => {
    const dir = path.join(root, 'store'); fs.mkdirSync(dir); const target = path.join(dir, 'data.json');
    let fail = false; const fakeFs = Object.create(fs); fakeFs.writeFileSync = (...args) => { if (fail) throw new Error('simulated disk full'); return fs.writeFileSync(...args); };
    const context = vm.createContext({ require: name => name === 'fs' ? fakeFs : req(name), module: { exports: {} }, console: { error() {} } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/store.js'), 'utf8'), context);
    const store = context.module.exports; store.init(target); store.saveTasks([{ id: 'saved' }]); const before = fs.readFileSync(target, 'utf8'); fail = true;
    assert.throws(() => store.saveTasks([{ id: 'unsaved' }]), /simulated disk full/);
    assert.equal(fs.readFileSync(target, 'utf8'), before); assert.equal(store.getTasks()[0].id, 'saved');
  });
  await check('folder names reject Windows reserved device names without splitting emoji', () => {
    const name = load().context.sanitizeFolderName;
    assert.equal(name('CON'), '_CON');
    assert.equal(name('con.txt'), '_con.txt');
    assert.equal(name('aux'), '_aux');
    assert.equal(name('nul '), '_nul');
    assert.equal(name('COM1'), '_COM1');
    assert.equal(name('LPT9.dat'), '_LPT9.dat');
    assert.equal(name('ok.'), 'ok');
    assert.equal(name('concert'), 'concert');
    const emoji = '😀'.repeat(81);
    assert.equal(Array.from(name(emoji)).length, 80);
    assert.equal(name('尾部空格  '), '尾部空格');
  });
  await check('show-in-folder reveals only real files inside the download root', async () => {
    const h = load();
    const inside = path.join(h.dir, 'clip.mp4');
    fs.writeFileSync(inside, 'video');
    assert.equal((await h.handlers['show-in-folder']({}, inside)).success, true);
    assert.deepEqual(h.opened, [inside]);
    const outside = path.join(root, 'outside.exe');
    fs.writeFileSync(outside, 'nope');
    h.opened.length = 0;
    assert.equal((await h.handlers['show-in-folder']({}, outside)).success, false);
    assert.equal((await h.handlers['show-in-folder']({}, path.join(outside, 'missing'))).success, false);
    const link = path.join(h.dir, 'linked.mp4');
    fs.symlinkSync(outside, link);
    assert.equal((await h.handlers['show-in-folder']({}, link)).success, false);
    assert.deepEqual(h.opened, []);
  });
  await check('playback transcode rejects an existing file outside the download root', async () => {
    const h = load();
    const outside = path.join(root, 'foreign.mp4');
    fs.writeFileSync(outside, Buffer.alloc(1200));
    const result = await h.handlers['transcode-for-playback']({}, { seriesId: 'S', vidIndex: 1, filePath: outside });
    assert.equal(result.success, false);
    assert.match(result.error, /下载目录/);
    const inside = path.join(h.dir, 'local.mp4');
    fs.writeFileSync(inside, Buffer.alloc(1200));
    const allowed = h.context.isInsideMediaRoot(inside);
    assert.equal(allowed, true);
  });
  await check('settings omit the proxy password and ignore undeclared keys', async () => {
    const h = load({ proxy_password: 'secret-fixture', proxy_username: 'test-user', custom_sources: [{ id: 'keep' }] });
    const visible = await h.handlers['get-settings']({});
    assert.equal(visible.proxy_password, undefined);
    assert.equal(visible.proxy_password_set, true);
    assert.equal(JSON.stringify(visible).includes('secret-fixture'), false);
    const saved = await h.handlers['save-settings']({}, { proxy_password: '', injected: true, max_concurrent: 4, custom_sources: [{ id: 'evil' }] });
    assert.equal(saved.success, true);
    assert.equal(h.settings().proxy_password, 'secret-fixture');
    assert.equal(h.settings().injected, undefined);
    assert.equal(h.settings().max_concurrent, 4);
    assert.deepEqual(h.settings().custom_sources, [{ id: 'keep' }]);
    await h.handlers['save-settings']({}, { proxy_password: 'next-secret' });
    assert.equal(h.settings().proxy_password, 'next-secret');
    await h.handlers['save-settings']({}, { clear_proxy_password: true });
    assert.equal(h.settings().proxy_password, '');
    assert.equal((await h.handlers['get-settings']({})).proxy_password_set, false);
  });
  await check('system proxy restores the startup environment and proxy auth stays out of proxy rules', async () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://startup-proxy:1';
    try {
      const h = load();
      await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: '9', proxy_username: 'user', proxy_password: 'pw' });
      assert.equal(h.context.process.env.HTTPS_PROXY, 'http://user:pw@127.0.0.1:9');
      assert.equal(JSON.stringify(h.proxyCalls).includes('pw'), false);
      assert.equal(h.proxyCalls.at(-1).proxyRules, 'http://127.0.0.1:9');
      let auth = null;
      h.app.emit('login', { preventDefault() {} }, null, null, { isProxy: true, host: '127.0.0.1', port: 9 }, (user, password) => { auth = [user, password]; });
      assert.deepEqual(auth, ['user', 'pw']);
      auth = null;
      h.app.emit('login', { preventDefault() {} }, null, null, { isProxy: false, host: '127.0.0.1', port: 9 }, (user, password) => { auth = [user, password]; });
      assert.equal(auth, null);
      await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'system' });
      assert.equal(h.context.process.env.HTTPS_PROXY, 'http://startup-proxy:1');
      await h.context.applyProxySettings({ proxy_enabled: false });
      assert.equal(h.context.process.env.HTTPS_PROXY, undefined);
      await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'system' });
      assert.equal(h.context.process.env.HTTPS_PROXY, 'http://startup-proxy:1');
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });
  await check('proxy connectivity test keeps a saved password when the draft leaves it blank', async () => {
    let seen;
    const settings = { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 7890, proxy_username: 'test-user', proxy_password: 'secret-fixture' };
    const h = load(settings, { axios: { get: async (_url, options) => { seen = options; return { status: 200 }; } } });
    const result = await h.handlers['test-proxy']({}, { ...settings, proxy_password: '' });
    assert.equal(seen.proxy.auth.password, 'secret-fixture');
    assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
  });
  await check('proxy status and test result never expose credentials', async () => {
    const settings = { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 7890, proxy_username: 'test-user', proxy_password: 'secret-fixture' };
    const h = load(settings, { axios: { get: async () => ({ status: 200 }) } });
    const result = [await h.handlers['get-proxy-status']({}), await h.handlers['test-proxy']({}, settings)];
    assert.ok(!JSON.stringify(result).includes('secret-fixture')); assert.ok(!JSON.stringify(result).includes('test-user'));
  });
  await check('failed queue persistence returns failure and leaves no ghost submission', async () => {
    const h = load({}, { './src/store': { getSettings: () => ({ root }), saveTasks() { throw new Error('simulated disk full'); } } });
    const result = await h.handlers['hongguo-download-batch']({}, { seriesId: 'S', seriesTitle: 'Short', episodes: series()[0].episodes });
    assert.equal(result.success, false); assert.equal(h.run('downloadTasks.length'), 0); assert.equal(h.run('downloadQueue.length'), 0);
  });
  assert.equal(failures, 0, `${failures} download safety regressions`);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
