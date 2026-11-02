// NAS export checks use disposable folders and byte fixtures; no playback or user data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
let nas = {};
try { nas = require('../src/native/nas-export'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const seriesId = '7691228619774905368';
const series = { series_id: seriesId, series_title: '示例剧第二季', cover: 'https://example.invalid/poster',
  episodes: [1, 2].map(index => ({ vid: `769124936409782991${index}`, vid_index: index, title: `第${index}集` })) };
const metadataFetcher = async () => ({ success: true, description: '剧情 <简介> & 人物', cover: series.cover });
const posterFetcher = async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
function temp(t) { const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-nas-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const prepare = root => nas.prepareNasExport({ root, folderName: '示例剧-identity', series }, { metadataFetcher, posterFetcher });

test('public metadata uses the matching source introduction and cover', () => {
  const { parsePublicDetails } = require('../src/native/public-details');
  const html = `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { detail_page: { isSuccess: true,
    seriesDetail: { series_id: seriesId, series_intro: '真实来源简介', series_cover: 'https://example.invalid/cover.jpg' } } } })}</script>`;
  const metadata = parsePublicDetails(html, seriesId);
  assert.equal(metadata.description, '真实来源简介');
  assert.equal(metadata.cover, 'https://example.invalid/cover.jpg');
  assert.throws(() => parsePublicDetails(html, '7691228619774905369'), /不匹配/);
});

test('NAS writes actual-format poster, readable introduction and escaped NFO; supplements missing files', async t => {
  assert.equal(typeof nas.prepareNasExport, 'function', 'NAS export is not implemented');
  const root = temp(t), { destination, warnings } = await prepare(root);
  assert.equal(destination.directory, root, 'the selected directory must be the actual save directory');
  assert.equal(warnings.length, 0);
  assert.equal(destination.season, 2);
  assert.equal(fs.readFileSync(path.join(destination.directory, 'poster.jpg'))[0], 0xff);
  assert.match(fs.readFileSync(path.join(destination.directory, '简介.txt'), 'utf8'), /剧情 <简介> & 人物/);
  assert.match(fs.readFileSync(path.join(destination.directory, 'tvshow.nfo'), 'utf8'), /剧情 &lt;简介&gt; &amp; 人物/);
  const editedNfo = fs.readFileSync(path.join(destination.directory, 'tvshow.nfo'), 'utf8').replace('</tvshow>', '<tag>user edited</tag></tvshow>');
  fs.writeFileSync(path.join(destination.directory, 'tvshow.nfo'), editedNfo);
  fs.unlinkSync(path.join(destination.directory, 'poster.jpg'));
  await prepare(root);
  assert.equal(fs.readFileSync(path.join(destination.directory, 'tvshow.nfo'), 'utf8'), editedNfo);
  assert.ok(fs.existsSync(path.join(destination.directory, 'poster.jpg')));
});

test('NAS copies with season/episode numbering, reuses identical files and preserves conflicts', async t => {
  const root = temp(t), { destination } = await prepare(root), ep = series.episodes[0];
  const source = path.join(root, 'source.mp4'); fs.writeFileSync(source, Buffer.alloc(120000, 7));
  const task = { savePath: source, hongguoInfo: { ...ep, series_id: seriesId } };
  const result = await nas.copyNasEpisode(task, destination);
  assert.match(result.path, /S02E001\.mp4$/);
  assert.equal(path.dirname(result.path), root, 'video and metadata must share the selected directory');
  assert.equal(fs.statSync(result.path).size, 120000);
  assert.equal(fs.existsSync(result.path.replace(/\.mp4$/, '.nfo')), false, 'new exports must not create per-episode NFO');
  assert.ok(fs.existsSync(path.join(root, '.hongguo-nas.json')), 'new exports must record identity in the hidden index');
  assert.equal((await nas.inspectNasEpisode(destination, ep)).status, 'existing');
  assert.equal((await nas.copyNasEpisode(task, destination)).copied, false);
  fs.writeFileSync(result.path, Buffer.alloc(120000, 9));
  await assert.rejects(() => nas.copyNasEpisode(task, destination), /同名|覆盖/);
  assert.equal(fs.readFileSync(result.path)[0], 9);
  fs.unlinkSync(source);
  assert.ok(fs.existsSync(result.path), 'NAS copy survives local deletion');
  fs.unlinkSync(path.join(root, '.hongguo-nas.json'));
  assert.equal((await nas.inspectNasEpisode(destination, ep)).status, 'conflict');
});

test('NAS refuses an orphan NFO that belongs to another episode', async t => {
  const root = temp(t), { destination } = await prepare(root), ep = series.episodes[0];
  const source = path.join(root, 'source.mp4'); fs.writeFileSync(source, Buffer.alloc(120000, 7));
  const nfo = path.join(root, '示例剧-identity S02E001.nfo');
  fs.writeFileSync(nfo, `<episodedetails><uniqueid type="hongguo" default="true">${series.episodes[1].vid}</uniqueid></episodedetails>`);
  assert.equal((await nas.inspectNasEpisode(destination, ep)).status, 'conflict');
  await assert.rejects(() => nas.copyNasEpisode({ savePath: source, hongguoInfo: { ...ep, series_id: seriesId } }, destination), /身份冲突/);
  assert.equal(fs.existsSync(path.join(root, '示例剧-identity S02E001.mp4')), false);
  assert.match(fs.readFileSync(nfo, 'utf8'), new RegExp(series.episodes[1].vid));
});

test('NAS rejects detached roots, unsafe folder names, symlinks and fake posters', async t => {
  const root = temp(t);
  await assert.rejects(() => nas.prepareNasExport({ root, folderName: '../outside', series }), /目录|路径/);
  const other = temp(t); fs.writeFileSync(path.join(other, 'foreign.nfo'), 'foreign');
  fs.symlinkSync(path.join(other, 'foreign.nfo'), path.join(root, 'tvshow.nfo'));
  await assert.rejects(() => prepare(root), /目录|链接/);
  fs.unlinkSync(path.join(root, 'tvshow.nfo'));
  const { destination } = await prepare(root);
  fs.renameSync(root, `${root}-detached`); t.after(() => fs.rmSync(`${root}-detached`, { recursive: true, force: true }));
  await assert.rejects(() => nas.inspectNasEpisode(destination, series.episodes[0]), /NAS|目录/);
  assert.equal(fs.existsSync(root), false, 'must not recreate an unmounted root');
  const blank = temp(t);
  const result = await nas.prepareNasExport({ root: blank, folderName: 'blank', series }, {
    metadataFetcher: async () => ({ success: false }), posterFetcher: async () => Buffer.from('<html>error</html>'),
  });
  assert.ok(result.warnings.some(message => /简介/.test(message)));
  assert.ok(result.warnings.some(message => /封面/.test(message)));
  assert.match(fs.readFileSync(path.join(result.destination.directory, 'tvshow.nfo'), 'utf8'), new RegExp(seriesId));
});

function fixture(t, { cancel = false, failSave = false } = {}) {
  const root = temp(t), target = path.join(root, 'share'); fs.mkdirSync(target);
  const handlers = {}, events = [], opened = [], app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
  const context = vm.createContext({ require: name => name === 'electron'
    ? { app, ipcMain: { handle: (key, fn) => { handlers[key] = fn; } }, protocol: { registerSchemesAsPrivileged() {} },
      dialog: { showOpenDialog: async () => ({ canceled: cancel, filePaths: [target] }) },
      shell: { openPath: async directory => { opened.push(directory); return ''; } } }
    : name === './src/store' ? { getSettings: () => ({ root }), saveTasks() { if (failSave) throw new Error('disk full'); } }
    : name === './src/native/nas-export' ? { ...nas, prepareNasExport: options => nas.prepareNasExport(options, { metadataFetcher, posterFetcher }) }
    : req(name), __dirname: path.dirname(source), process, Buffer, URL, Response, Request, Headers, AbortController,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  context.fixtureSeries = series; context.captureEvent = (channel, data) => events.push({ channel, data });
  const run = code => vm.runInContext(code, context);
  run('seriesRegistry = [fixtureSeries]; sendToRenderer = captureEvent; pumpQueue = () => {}; verifyDownloadQuality = async () => "1080p";');
  return { root, target, handlers, events, opened, context, run };
}

test('NAS IPC downloads into the selected directory and opens that same directory', async t => {
  const h = fixture(t);
  assert.equal(typeof h.handlers['download-series-to-nas'], 'function');
  const result = await h.handlers['download-series-to-nas']({}, seriesId, 'auto');
  assert.equal(result.success, true); assert.equal(result.count, 2);
  assert.equal(h.run('downloadTasks.length'), 2);
  assert.equal(result.directory, h.target);
  assert.equal(h.run('downloadTasks[0].nasDestination.directory'), h.target);
  assert.equal(h.run('downloadTasks[0].customDir'), h.target);
  assert.equal(path.dirname(h.run('downloadTasks[0].savePath')), h.target);
  assert.equal(h.run('downloadTasks[0].nasTargets'), undefined);
  const task = h.run('downloadTasks[0]');
  fs.mkdirSync(path.dirname(task.savePath), { recursive: true }); fs.writeFileSync(task.savePath, Buffer.alloc(120000, 3));
  await h.run('executeHongguoDownload(downloadTasks[0])');
  assert.equal(task.status, 'completed');
  assert.ok(h.events.some(event => event.channel === 'nas-export-done' && event.data.success));
  const exported = await nas.inspectNasEpisode(task.nasDestination, task.hongguoInfo);
  assert.equal(exported.status, 'existing');
  assert.ok(fs.existsSync(path.join(h.target, 'poster.jpg')));
  assert.ok(fs.existsSync(path.join(h.target, '简介.txt')));
  assert.ok(fs.existsSync(path.join(h.target, 'tvshow.nfo')));
  assert.equal((await h.handlers['open-folder']({}, task.id)).success, true);
  assert.equal(h.opened.at(-1), h.target);
  assert.equal((await h.handlers['cleanup-watched-episode']({}, seriesId, task.hongguoInfo.vid_index)).skipped, true);
  assert.ok(fs.existsSync(exported.path), 'automatic cleanup must not delete a direct NAS download');
  assert.equal(fs.existsSync(path.join(h.root, '红果短剧')), false, 'new NAS downloads must not create a second ordinary directory');
});

test('NAS reuses completed local tasks and does not restart video transfer for metadata-only retries', async t => {
  const h = fixture(t);
  const source = path.join(h.root, 'old.mp4'); fs.writeFileSync(source, Buffer.alloc(120000, 3));
  h.context.oldTask = { id: 'old', type: 'hongguo', status: 'completed', savePath: source, customDir: h.root,
    downloadQuality: 'auto', hongguoInfo: { ...series.episodes[0], series_id: seriesId, series_title: series.series_title } };
  h.run('downloadTasks = [oldTask];');
  let result = await h.handlers['download-series-to-nas']({}, seriesId, 'auto');
  assert.equal(result.success, true); assert.equal(result.copied, 1); assert.equal(result.count, 1);
  assert.equal(path.dirname(h.run('downloadTasks.find(task => task.id === "old").savePath')), h.target);
  assert.ok(fs.existsSync(source), 'retargeting must preserve the original video');
  const count = h.run('downloadTasks.length');
  result = await h.handlers['download-series-to-nas']({}, seriesId, 'auto');
  assert.equal(result.success, true); assert.equal(result.count, 0); assert.equal(h.run('downloadTasks.length'), count);
  const local = h.run('downloadTasks.find(task => task.id === "old")');
  const exported = await nas.inspectNasEpisode(local.nasDestination, local.hongguoInfo);
  const index = path.join(h.target, '.hongguo-nas.json');
  fs.unlinkSync(index);
  assert.equal((await h.handlers['download-series-to-nas']({}, seriesId, 'auto')).success, true);
  assert.ok(fs.existsSync(index), 'missing identity index is restored only after matching the local video');
  h.run('for (const task of downloadTasks) { task.nasDestination.device = -1; task.nasWarning = "offline"; }');
  assert.equal((await h.handlers['download-series-to-nas']({}, seriesId, 'auto')).success, true);
  assert.notEqual(h.run('downloadTasks[0].nasDestination.device'), -1, 'reselecting a remounted share refreshes its identity');
});

test('NAS cancel and queue persistence failure do not start unregistered export jobs', async t => {
  const canceled = fixture(t, { cancel: true });
  const result = await canceled.handlers['download-series-to-nas']({}, seriesId, 'auto');
  assert.equal(result.canceled, true); assert.equal(canceled.run('downloadTasks.length'), 0);
  assert.equal(fs.readdirSync(canceled.target).length, 0);
  const failed = fixture(t, { failSave: true });
  const failure = await failed.handlers['download-series-to-nas']({}, seriesId, 'auto');
  assert.equal(failure.success, false); assert.match(failure.error, /disk full/);
  assert.equal(failed.run('downloadTasks.length'), 0); assert.equal(failed.run('downloadQueue.length'), 0);
  const retry = fixture(t, { failSave: true });
  retry.context.stopped = { id: 'stopped', type: 'hongguo', status: 'stopped', savePath: path.join(retry.root, 'old.mp4'),
    hongguoInfo: { ...series.episodes[0], series_id: seriesId } };
  retry.run('downloadTasks = [stopped];');
  assert.equal((await retry.handlers['download-series-to-nas']({}, seriesId, 'auto')).success, false);
  assert.equal(retry.run('downloadTasks[0].status'), 'stopped');
  assert.equal(retry.run('downloadTasks[0].nasTargets'), undefined, 'failed persistence must roll back newly attached destinations');
  assert.equal(retry.run('downloadTasks[0].nasDestination'), undefined);
});

test('detached NAS fails in place without recreating a mount or falling back to ordinary downloads', async t => {
  const h = fixture(t);
  assert.equal((await h.handlers['download-series-to-nas']({}, seriesId, 'auto')).success, true);
  const task = h.run('downloadTasks[0]');
  fs.mkdirSync(path.dirname(task.savePath), { recursive: true }); fs.writeFileSync(task.savePath, Buffer.alloc(120000, 4));
  fs.renameSync(h.target, `${h.target}-detached`);
  await h.run('executeHongguoDownload(downloadTasks[0])');
  assert.equal(task.status, 'failed');
  assert.match(task.error, /NAS|目录/);
  assert.equal(fs.existsSync(h.target), false);
  assert.equal(fs.existsSync(path.join(h.root, '红果短剧')), false);
  fs.renameSync(`${h.target}-detached`, h.target);
  await h.run('executeHongguoDownload(downloadTasks[0])');
  assert.equal(task.status, 'completed');
  assert.ok(fs.existsSync(task.savePath));
});

test('preload NAS bridge forwards identity/quality/folder option and removes its subscription', async () => {
  let api;
  const emitter = new EventEmitter(), calls = [];
  emitter.invoke = (...args) => { calls.push(args); };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } }, ipcRenderer: emitter }),
  });
  const options = { createFolder: true };
  api.downloadSeriesToNas(seriesId, 'auto', options);
  assert.deepEqual(calls[0], ['download-series-to-nas', seriesId, 'auto', options]);
  let count = 0; const off = api.onNasExportDone(() => { count++; });
  emitter.emit('nas-export-done', {}, {}); off(); emitter.emit('nas-export-done', {}, {});
  assert.equal(count, 1);
});

test('ordinary downloads retain their original directory and legacy NAS tasks open their export directory', async t => {
  const h = fixture(t);
  assert.equal((await h.handlers['hongguo-download-batch']({}, { seriesId, seriesTitle: series.series_title, episodes: series.episodes })).success, true);
  const ordinary = h.run('downloadTasks[0]');
  assert.equal(ordinary.customDir, h.context.seriesDownloadDir(h.root, seriesId, series.series_title));
  assert.equal(ordinary.nasDestination, undefined);
  const legacy = path.join(h.target, 'legacy'); fs.mkdirSync(legacy);
  ordinary.nasTargets = [{ directory: legacy }];
  await h.handlers['open-folder']({}, ordinary.id);
  assert.equal(h.opened.at(-1), legacy);
  fs.rmdirSync(legacy);
  assert.equal((await h.handlers['open-folder']({}, ordinary.id)).success, false, 'a missing NAS export must not silently open the ordinary directory');
});

test('active downloads cannot be retargeted while their writer is still running', async t => {
  const h = fixture(t);
  const source = path.join(h.root, 'active.mp4');
  h.context.activeTask = { id: 'active', type: 'hongguo', status: 'downloading', savePath: source, downloadQuality: 'auto',
    customDir: h.root, hongguoInfo: { ...series.episodes[0], series_id: seriesId } };
  h.run('downloadTasks = [activeTask];');
  const result = await h.handlers['download-series-to-nas']({}, seriesId, 'auto');
  assert.equal(result.success, false); assert.match(result.error, /先暂停/);
  assert.equal(h.run('downloadTasks[0].savePath'), source);
  assert.equal(h.run('downloadTasks[0].nasDestination'), undefined);
});

test('an existing NAS video is adopted without another download and another series cannot overwrite its metadata', async t => {
  const h = fixture(t);
  const result = await nas.prepareNasExport({ root: h.target, folderName: series.series_title, series }, { metadataFetcher, posterFetcher });
  const source = path.join(h.root, 'existing.mp4'); fs.writeFileSync(source, Buffer.alloc(120000, 8));
  const copied = await nas.copyNasEpisode({ savePath: source, hongguoInfo: { ...series.episodes[0], series_id: seriesId } }, result.destination);
  const input = { ...series, series_id: '7691228619774905370' };
  await assert.rejects(() => nas.prepareNasExport({ root: h.target, folderName: 'other', series: input }, { metadataFetcher, posterFetcher }), /已有其他|归属/);
  assert.ok(fs.existsSync(copied.path));
  const response = await h.handlers['download-series-to-nas']({}, seriesId, 'auto');
  assert.equal(response.success, true); assert.equal(response.copied, 1); assert.equal(response.count, 1);
  const task = h.run('downloadTasks.find(task => task.status === "completed")');
  assert.equal(task.savePath, copied.path); assert.equal(task.customDir, h.target);
  assert.equal(h.run('downloadQueue.length'), 1);
});

test('NAS IPC can create a series folder while older callers retain the selected-directory behavior', async t => {
  const h = fixture(t);
  const result = await h.handlers['download-series-to-nas']({}, seriesId, 'auto', { createFolder: true });
  assert.equal(result.success, true, result.error);
  assert.equal(path.dirname(result.directory), h.target);
  assert.notEqual(result.directory, h.target);
  assert.ok(fs.existsSync(path.join(result.directory, 'tvshow.nfo')));
  assert.equal(h.run('downloadTasks[0].nasDestination.directory'), result.directory);
});

test('ordinary downloads optionally save series metadata without retargeting videos or writing episode NFO', async t => {
  const h = fixture(t);
  h.context.getCurrentSettings = () => ({ root: h.root, download_metadata: true });
  assert.equal(h.run('applyEditableSettings({}, {download_metadata:true}).download_metadata'), true);
  const result = await h.handlers['hongguo-download-batch']({}, { seriesId, seriesTitle: series.series_title,
    cover: series.cover, episodes: series.episodes, quality: 'auto' });
  assert.equal(result.success, true, result.error);
  const task = h.run('downloadTasks[0]');
  assert.equal(task.nasDestination, undefined);
  assert.ok(fs.existsSync(path.join(task.customDir, 'tvshow.nfo')));
  assert.ok(fs.existsSync(path.join(task.customDir, 'poster.jpg')));
  assert.ok(fs.existsSync(path.join(task.customDir, '简介.txt')));
  assert.deepEqual(fs.readdirSync(task.customDir).filter(name => name.endsWith('.nfo')), ['tvshow.nfo']);
});
