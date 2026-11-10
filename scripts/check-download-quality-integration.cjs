// Isolated main-process checks: exercise real task/IPC code without user data.
const assert = require('node:assert/strict');
const { createTranslator } = require('../src/i18n/translator.mjs');
const english = createTranslator(require('../src/i18n/en.json'), require('../src/i18n/templates.json'));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { Readable, PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const dirs = [];
function fixture({ width = 1080, height = 1920, quality = 'auto', realMedia = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-quality-'));
  dirs.push(root);
  const handlers = {}, calls = [], events = [], app = new EventEmitter();
  let settings = { root, download_quality: quality }, saved;
  Object.assign(app, { getVersion: () => 'test', getPath: () => root,
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const context = vm.createContext({ require: n => n === 'electron'
    ? { app, ipcMain: { handle: (n, f) => handlers[n] = f }, protocol: { registerSchemesAsPrivileged() {} } }
    : n === './src/native/hongguo' ? { fetchPlayUrlSingle: async (...args) => { calls.push(args); return { url: 'https://media.example/video.mp4' }; } }
    : n === './src/store' ? { getSettings: () => settings, saveSettings: s => settings = s,
      saveTasks: tasks => { saved = JSON.parse(JSON.stringify(tasks)); } } : req(n),
    __dirname: path.dirname(source), console: { log() {}, warn() {}, error() {} },
    process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout,
    testEvents: events, testReadStream: () => Readable.from([Buffer.alloc(200000)]), testDimensions: { w: width, h: height, duration: 12, codec: "h264" } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  const run = text => vm.runInContext(text, context);
  run(`globalThis.originalProbeVideoInfo = probeVideoInfo; globalThis.originalRequestMedia = requestMedia;
    sendToRenderer = (channel, data) => testEvents.push({channel, data: {...data}}); pumpQueue = () => {};
    requestMedia = async () => ({headers: {'content-length': '200000'}, data: testReadStream()});
    seriesRegistry = [{series_id:'1',series_title:'测试剧',episodes:[{vid:'11',vid_index:1},{vid:'12',vid_index:2}]}];`);
  // Synthetic transfers mock validation; realMedia keeps the production probe, decoder and tool discovery.
  if (!realMedia) run(`resolveFfmpeg = () => '/test/ffprobe'; verifyDownloadDecode = async () => {};
    probeVideoInfo = async () => testDimensions;`);
  return { root, context, run, handlers, calls, events, saved: () => saved,
    setQuality: value => { settings.download_quality = value; } };
}
const payload = quality => ({ seriesId: '1', seriesTitle: '测试剧', episodes: [{vid:'11',vid_index:1}], ...(quality ? {quality} : {}) });
async function bytevc2Fixture(check, { conflict = false, cancel = false, replaceCenc = false } = {}) {
  const h = fixture(), cp = require('node:child_process'), promises = require('node:fs/promises');
  const spawn = cp.spawn, open = promises.open;
  let foreignOutput, spawns = 0, closed = false;
  promises.open = async (file, flags, ...args) => {
    if (conflict && flags === 'wx' && (file.endsWith('.decoded') || path.basename(file) === 'decoded.mp4')) {
      foreignOutput = file; fs.writeFileSync(file, 'unrelated output');
    }
    return open(file, flags, ...args);
  };
  cp.spawn = (_exe, args) => {
    spawns++;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => { closed = true; child.emit('close', null); }); return true; };
    queueMicrotask(() => {
      fs.writeFileSync(args.at(-1), Buffer.alloc(200000));
      if (replaceCenc) {
        foreignOutput = args.at(-1);
        fs.renameSync(foreignOutput, foreignOutput + '.original');
        fs.writeFileSync(foreignOutput, 'unrelated CENC output');
        closed = true; child.emit('close', replaceCenc === 'success' ? 0 : 1); return;
      }
      if (cancel) h.run("downloadTasks[0].cancelSource.cancel('fixture cancellation')");
      else { child.stdout.write('out_time_us=12000000\n'); closed = true; child.emit('close', 0); }
    });
    return child;
  };
  try {
    h.run("hongguo.fetchPlayUrlSingle = async () => ({url:'https://media.example/video.mp4',codec:'bytevc2',duration:12})");
    if (replaceCenc) h.run("hongguo.fetchPlayUrlSingle = async () => ({url:'https://media.example/video.mp4',contentKey:Buffer.alloc(16).toString('hex')})");
    await h.handlers['hongguo-download-batch']({}, payload());
    await check(h, () => ({ foreignOutput, spawns, closed }));
  } finally { promises.open = open; cp.spawn = spawn; }
}
async function realFootageCatalog(browseList) {
  let catalog = await browseList({ category: 'hot-real-drama' });
  if (!catalog.success && catalog.code === 'APP_TIMEOUT') {
    console.log('RETRY real Hongguo catalog once (APP_TIMEOUT)');
    catalog = await browseList({ category: 'hot-real-drama', forceRefresh: true });
  }
  if (!catalog.success) throw Object.assign(new Error('Real Hongguo catalog unavailable'), {
    code: /^APP_[A-Z_]+$/.test(catalog.code || '') ? catalog.code : 'APP_SCHEMA',
  });
  assert(Array.isArray(catalog.results) && catalog.results.length);
  return catalog;
}
const checks = [
  ['disk cache download preserves ownership and allows deleting its record', async () => {
    const h = fixture();
    const cache = path.join(h.root, 'cached.mp4');
    fs.writeFileSync(cache, Buffer.alloc(200000, 9));
    h.context.diskCachePath = cache;
    h.run(`onlineCache.set('11:auto', { filePath:diskCachePath, disk:{readers:0}, size:200000,
      lastUsed:Date.now(), seriesId:'1', vid:'11', source:'hongguo', complete:true });
      requestMedia = async () => { throw new Error('unexpected duplicate download'); };`);
    await h.handlers['hongguo-download-batch']({}, payload());
    await h.run('executeHongguoDownload(downloadTasks[0])');
    const task = h.saved()[0];
    assert.equal(task.status, 'completed', task.error);
    assert.equal(fs.readFileSync(task.savePath)[0], 9);
    assert.equal(fs.readdirSync(h.root).some(name => name.startsWith('.hongguo-download-')), false);
    const deleted = await h.handlers['delete-tasks']({}, [task.id], {deleteFiles:false});
    assert.equal(deleted.success, true, deleted.error);
    assert.equal(deleted.count, 1);
    assert.equal(fs.existsSync(task.savePath), true, 'deleting records must preserve the downloaded video');
    assert.equal(fs.existsSync(cache), true, 'playback cache must remain available');
  }],
  ['astra receipt is saved before media transfer', async () => {
    const h = fixture(); await h.handlers['hongguo-download-batch']({}, payload());
    let durable = false;
    h.context.testReadStream = () => {
      const record = h.saved()[0].temporaryDownloads?.[0];
      durable = record?.owner?.taskId === h.saved()[0].id && record?.files?.['input.enc.tmp']?.ino > 0;
      return Readable.from([Buffer.alloc(200000)]);
    };
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(durable, true, 'ownership must reach task persistence before media bytes');
    assert.equal(h.saved()[0].status, 'completed');
  }],
  ...['plain', 'cache', 'hls'].map(mode => [`astra input ${mode} rejects a source replaced during validation`, async () => {
    const h = fixture();
    if (mode === 'cache') await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', prefetch:true });
    if (mode === 'hls') h.run(`hongguo.fetchPlayUrlSingle = async () => ({url:'https://media.example/hls',format:'hls'});
      prepareHlsFile = async (_info, output) => fs.writeFileSync(output, Buffer.alloc(200000));`);
    await h.handlers['hongguo-download-batch']({}, payload());
    let replaced;
    h.context.replaceInput = file => {
      replaced = file;
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, Buffer.alloc(200000, 7));
    };
    h.run(`probeVideoInfo = async (_tool, file) => { replaceInput(file); return testDimensions; };`);
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed', 'a replaced input must not become completed media');
    assert.equal(fs.existsSync(h.saved()[0].savePath), false);
    assert.equal(fs.readFileSync(replaced)[0], 7, 'the replacement must remain at its own path');
    assert.equal(fs.existsSync(replaced + '.original'), true, 'the original must also remain');
  }]),
  ['temporary workspace preserves legacy input and decoded conflicts while finishing a download', async () => {
    await bytevc2Fixture(async (h, state) => {
      const task = h.saved()[0], legacyInput = task.savePath + '.enc.tmp', legacyOutput = legacyInput + '.decoded';
      fs.writeFileSync(legacyInput, 'unrelated legacy input'); fs.writeFileSync(legacyOutput, 'unrelated legacy output');
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'completed', h.saved()[0].error);
      assert.equal(state().spawns, 1); assert.equal(fs.statSync(task.savePath).size, 200000);
      assert.equal(fs.readFileSync(legacyInput, 'utf8'), 'unrelated legacy input');
      assert.equal(fs.readFileSync(legacyOutput, 'utf8'), 'unrelated legacy output');
      assert.equal(fs.readdirSync(task.customDir).some(name => name.startsWith('.hongguo-download-')), false);
      assert(h.events.some(e => /视频已下载/.test(e.data.qualityNotice || '')));
      for (const text of ['视频已下载，等待其他视频转换完成', '视频已下载，正在转换为可播放格式']) {
        assert.doesNotMatch(english(text), /[\u4e00-\u9fff]/);
      }
    });
  }],
  ['temporary workspace preserves a raced unknown output instead of deleting it', async () => {
    await bytevc2Fixture(async (h, state) => {
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'failed'); assert.equal(state().spawns, 0);
      assert.ok(state().foreignOutput, 'the real converter must attempt exclusive output creation');
      assert.equal(fs.readFileSync(state().foreignOutput, 'utf8'), 'unrelated output');
      assert.equal(fs.existsSync(h.saved()[0].savePath), false);
      assert(!h.saved()[0].error.includes(h.root), 'public errors must not contain local paths');
      assert.equal(english(h.saved()[0].error), 'A temporary download file conflicts with another file or has changed. Existing files have been kept. Retry the download.');
    }, { conflict: true });
  }],
  ['temporary workspace waits for a cancelled converter and cleans only its own files', async () => {
    await bytevc2Fixture(async (h, state) => {
      const task = h.saved()[0]; fs.writeFileSync(task.savePath + '.enc.tmp.decoded', 'keep legacy');
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'stopped'); assert.equal(state().closed, true);
      assert.equal(fs.existsSync(task.savePath), false);
      assert.equal(fs.readFileSync(task.savePath + '.enc.tmp.decoded', 'utf8'), 'keep legacy');
      assert.equal(fs.readdirSync(task.customDir).some(name => name.startsWith('.hongguo-download-')), false);
    }, { cancel: true });
  }],
  ['temporary workspace preserves a CENC output replaced during a failed decrypt', async () => {
    await bytevc2Fixture(async (h, state) => {
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'failed');
      assert.equal(fs.readFileSync(state().foreignOutput, 'utf8'), 'unrelated CENC output');
      assert.equal(fs.existsSync(h.saved()[0].savePath), false);
      assert(!h.saved()[0].error.includes(h.root));
    }, { replaceCenc: true });
  }],
  ['temporary workspace cannot publish a CENC output replaced during a successful decrypt', async () => {
    await bytevc2Fixture(async (h, state) => {
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'failed');
      assert.equal(fs.readFileSync(state().foreignOutput, 'utf8'), 'unrelated CENC output');
      assert.equal(fs.existsSync(h.saved()[0].savePath), false);
    }, { replaceCenc: 'success' });
  }],
  ['real footage catalog retries one timeout and preserves terminal failures', async () => {
    for (const codes of [['APP_TIMEOUT', null], ['APP_TIMEOUT', 'APP_TIMEOUT'], ['APP_SCHEMA'], ['APP_BUSINESS'], ['APP_NETWORK']]) {
      const calls = [];
      const result = realFootageCatalog(async options => {
        calls.push(options);
        assert(calls.length <= codes.length, 'catalog retries must stay bounded');
        const code = codes[calls.length - 1];
        return code ? { success: false, code } : { success: true, results: [{ series_id: '1' }] };
      });
      if (codes.at(-1)) await assert.rejects(result, error => error.code === codes.at(-1));
      else assert.equal((await result).results.length, 1);
      assert.equal(calls.length, codes.length);
      assert(calls.every(options => options.category === 'hot-real-drama'));
      if (calls.length === 2) assert.equal(calls[1].forceRefresh, true);
    }
  }],
  ['real decoder recovers corrupt Web through healthy App and rejects probeable corrupt App once', async () => {
    const h = fixture({ realMedia: true });
    const ffmpeg = h.context.resolveFfmpeg('ffmpeg');
    assert.ok(ffmpeg && h.context.resolveFfmpeg('ffprobe'), 'local FFmpeg and ffprobe are required');
    const valid = path.join(h.root, 'valid.mp4'), broken = path.join(h.root, 'broken.mp4');
    // Load real native modules outside the VM's mocked source lookup.
    const native = require('../src/native/hongguo');
    Object.assign(h.run('hongguo'), { UA: native.UA, WEB_UA: native.WEB_UA,
      VIDEO_REFERER: native.VIDEO_REFERER, WEB_REFERER: native.WEB_REFERER });
    const original = path.join(h.root, 'original.mp4');
    let info, stage = 'catalog lookup';
    try {
      const catalog = await realFootageCatalog(require('../src/native/hongguo-app-catalog').browseList);
      const drama = catalog.results[Math.floor(Math.random() * catalog.results.length)];
      stage = 'episode lookup';
      const series = await native.fetchEpisodeList(drama.series_id);
      const episodes = series.episodes.filter(episode => episode.vid && episode.web_available !== false);
      assert(episodes.length);
      const episode = episodes[Math.floor(Math.random() * episodes.length)];
      console.log('REAL Hongguo source ' + JSON.stringify({ seriesId: series.series_id,
        title: series.series_title, vid: episode.vid, episode: episode.vid_index }));
      stage = 'media lookup';
      info = await native.fetchPlayUrlSingle(episode.vid, series.series_id, { force: true });
      assert(info.url);
      assert.equal(String(info.vid), String(episode.vid));
      stage = 'media download';
      const response = await h.context.originalRequestMedia(info, {
        responseType: 'arraybuffer', maxContentLength: 128 * 1024 * 1024,
      });
      assert(response.data.byteLength > 0);
      const expectedLength = Number(response.headers['content-length']);
      assert(!expectedLength || response.data.byteLength === expectedLength);
      fs.writeFileSync(original, response.data);
      stage = 'media decode';
      const key = info.contentKey;
      assert(!key || /^[a-f\d]{32}$/i.test(key));
      let input = original;
      if (!key && info.spadeA) {
        const derived = native.deriveKey(info.spadeA);
        assert(derived);
        input = path.join(h.root, 'decrypted.mp4');
        native.decryptMp4File(original, input, derived);
      }
      const decoder = info.codec === 'bytevc2' ? h.context.resolveFfmpeg('librempeg') : ffmpeg;
      assert(decoder, 'source codec requires the matching bundled decoder');
      const decoded = spawnSync(decoder, ['-v', 'error', '-nostdin', ...(key ? ['-decryption_key', key] : []),
        '-i', input, '-t', '1', '-map', '0:v:0', '-an', '-vf', 'scale=640:360', '-r', '24',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', valid],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, windowsHide: true });
      assert.equal(decoded.status, 0);
      fs.unlinkSync(original);
    } catch (error) {
      const status = Number(error.response?.status);
      const reason = status >= 100 && status <= 599 ? `HTTP ${status}`
        : /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : 'unavailable';
      throw new Error(`Real Hongguo ${stage} failed (${reason}); no substitute footage or sensitive details logged`);
    }
    const bytes = fs.readFileSync(valid), damaged = Buffer.from(bytes);
    const mdat = damaged.indexOf(Buffer.from('mdat'));
    assert.ok(mdat >= 4, 'fixture must contain an MP4 media-data box');
    const end = mdat - 4 + damaged.readUInt32BE(mdat - 4);
    assert.ok(end > mdat + 4 && end <= damaged.length);
    damaged.fill(0, mdat + 4, end);
    fs.writeFileSync(broken, damaged);
    assert.equal(await h.context.verifyDownloadQuality(broken, 'auto'), '360p', 'corruption must survive the real metadata probe');
    const attempts = [];
    h.context.localMedia = info => {
      attempts.push(info.source);
      const file = info.source === 'web' ? broken : valid;
      return { headers: { 'content-length': String(fs.statSync(file).size) }, data: fs.createReadStream(file) };
    };
    h.context.sourceCalls = h.calls;
    h.run(`globalThis.webFailed = false;
      hongguo.markWebMediaFailure = info => { if (info.source === 'web') webFailed = true; };
      hongguo.fetchPlayUrlSingle = async (...args) => {
        sourceCalls.push(args);
        const source = webFailed ? 'app' : 'web';
        return { url: 'https://media.example/' + source, source, vid: '11' };
      };
      requestMedia = async info => localMedia(info);`);
    await h.handlers['hongguo-download-batch']({}, payload());
    await h.run('executeHongguoDownload(downloadTasks[0])');
    const completed = h.saved()[0];
    assert.equal(completed.status, 'completed', completed.error);
    assert.deepEqual(attempts, ['web', 'app']);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(call => call[2].quality === 'auto' && call[2].allowLowerQuality === false));
    assert.equal(h.calls[1][2].force, true);
    assert.deepEqual(fs.readFileSync(completed.savePath), bytes);
    assert.equal(fs.existsSync(completed.savePath + '.enc.tmp'), false);
    assert.equal(h.events.filter(event => event.channel === 'download-completed').length, 1);

    const bad = fixture({ realMedia: true });
    let appTransfers = 0;
    bad.context.localMedia = () => {
      appTransfers++;
      return { headers: { 'content-length': String(damaged.length) }, data: fs.createReadStream(broken) };
    };
    bad.context.sourceCalls = bad.calls;
    bad.run(`hongguo.fetchPlayUrlSingle = async (...args) => {
        sourceCalls.push(args); return { url: 'https://media.example/broken-app', source: 'app', vid: '11' };
      };
      requestMedia = async () => localMedia();`);
    await bad.handlers['hongguo-download-batch']({}, payload());
    await bad.run('executeHongguoDownload(downloadTasks[0])');
    const failed = bad.saved()[0];
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /解码校验失败/);
    assert.equal(bad.calls.length, 1, 'decode failures must not repeatedly resolve the same bad App rendition');
    assert.equal(appTransfers, 1);
    assert.equal(fs.existsSync(failed.savePath), false);
    assert.equal(fs.existsSync(failed.savePath + '.enc.tmp'), false);
    assert.equal(bad.events.filter(event => event.channel === 'download-completed').length, 0);
  }],
  ['batch snapshots chosen quality and passes it through to source lookup', async () => {
    const h = fixture({ quality: '720p' });
    assert.equal((await h.handlers['hongguo-download-batch']({}, payload('1080p'))).success, true);
    assert.equal(h.saved()[0].downloadQuality, '1080p');
    h.setQuality('auto');
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.calls[0][2].quality, '1080p');
    assert.equal(h.saved()[0].status, 'completed');
    assert.equal(h.saved()[0].actualQuality, '1080p');
  }],
  ['single download accepts override and falls back to saved default', async () => {
    const h = fixture({ quality: '720p' });
    await h.handlers['download-single-episode']({}, '1', 1, '1080p');
    await h.handlers['download-single-episode']({}, '1', 2);
    assert.equal(h.saved().find(t => t.hongguoInfo.vid === '11').downloadQuality, '1080p');
    assert.equal(h.saved().find(t => t.hongguoInfo.vid === '12').downloadQuality, '720p');
  }],
  ['download accepts lower measured quality and reports it without an early failure', async () => {
    const h = fixture({ width:720, height:1280 });
    await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    const t = h.saved()[0];
    assert.equal(t.status, 'completed', t.error);
    assert.equal(t.downloadQuality, '1080p');
    assert.equal(t.actualQuality, '720p');
    assert.match(t.qualityNotice, /已下载更低质量.*720P.*1080P/);
    assert.equal(h.events.some(e => e.channel === 'download-failed'),false);
  }],
  ['failed higher variants exhaust all tiers, including after four addresses, before reporting an error', async () => {
    const h = fixture();
    h.run(`hongguo.fetchPlayUrlSingle = async (_vid,_sid,options) => {
      if (!options.allowLowerQuality) return {url:null,error:'1080 unavailable'};
      const variants = Array.from({length:7},(_,i) => ({url:'https://media.example/'+i,width:i<5?1080:i===5?720:480,height:1920}));
      return {...variants[0],variants};
    }; requestMedia = async info => {
      if (!info.url.endsWith('/6')) throw Object.assign(new Error('bad stream'),{mediaRetryable:true});
      testDimensions = {w:480,h:854,duration:12,codec:'h264'};
      return {headers:{'content-length':'200000'},data:testReadStream()};
    };`);
    await h.handlers['hongguo-download-batch']({},payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status,'completed',h.saved()[0].error);
    assert.equal(h.saved()[0].actualQuality,'480p');
    const notices = h.events.filter(e=>e.channel==='download-progress'&&e.data.qualityNotice).map(e=>e.data.qualityNotice);
    assert(notices.some(s=>/正在下载更低质量.*720P/.test(s)));
    assert(notices.some(s=>/正在下载更低质量.*480P/.test(s)));
    assert.equal(h.events.filter(e=>e.channel==='download-failed').length,0);
  }],
  ['all tiers unavailable reports one failure only after lower candidates were attempted', async () => {
    const h = fixture();
    h.run(`globalThis.attempts=[]; hongguo.fetchPlayUrlSingle = async () => ({url:'https://media.example/high',width:1080,height:1920,variants:[{url:'https://media.example/low',width:360,height:640}]});
      requestMedia = async info => { attempts.push(info.url); throw new Error('invalid video'); };`);
    await h.handlers['hongguo-download-batch']({},payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status,'failed');
    assert(h.run("attempts.includes('https://media.example/low')"));
    assert.equal(h.events.filter(e=>e.channel==='download-failed').length,1);
    assert.equal(fs.existsSync(h.saved()[0].savePath),false);
  }],
  ['disk errors and cancellation never trigger a lower-quality download', async () => {
    for(const code of ['ENOSPC','EACCES','ENOTDIR','EMFILE','EBUSY','SECURITY_BLOCKED','LOCAL_MEDIA_TOOL_ERROR','ERR_CANCELED']) {
      const h = fixture();
      h.context.failureCode=code;
      h.run(`globalThis.attempts=0; hongguo.fetchPlayUrlSingle = async () => ({url:'https://media.example/high',variants:[{url:'https://media.example/low',width:480,height:854}]});
        requestMedia = async () => { attempts++; if(failureCode==='ERR_CANCELED') downloadTasks[0].cancelSource.cancel('stop'); throw Object.assign(new Error('stop'),{code:failureCode}); };`);
      await h.handlers['hongguo-download-batch']({},payload('1080p'));
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.run('attempts'),1,code);
      assert.equal(h.saved()[0].status,code==='ERR_CANCELED'?'stopped':'failed');
    }
  }],
  ['missing probe tool stops without downloading lower candidates', async () => {
    for (const tool of [null, '/nonexistent/hongguo-fixture-ffprobe']) {
      const h = fixture(); h.context.probeTool = tool;
      h.run(`globalThis.attempts=0; probeVideoInfo=originalProbeVideoInfo; resolveFfmpeg=()=>probeTool;
        hongguo.fetchPlayUrlSingle=async()=>({url:'https://media.example/high',variants:[{url:'https://media.example/low',width:480,height:854}]});
        requestMedia=async()=>{attempts++;return {headers:{'content-length':'200000'},data:testReadStream()};};`);
      await h.handlers['hongguo-download-batch']({},payload('1080p'));
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status,'failed');
      assert.equal(h.run('attempts'),1);
      assert.match(h.saved()[0].error,/工具/);
    }
  }],
  ['lost files and interrupted or stopped tasks never retain a download notice', async () => {
    const h = fixture({width:720,height:1280});
    await h.handlers['hongguo-download-batch']({},payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    fs.unlinkSync(h.saved()[0].savePath);
    const rows=await h.handlers['get-download-tasks']({});
    assert.equal(rows[0].status,'failed'); assert.equal(rows[0].qualityNotice,'');
    h.run(`store.getTasks = () => [{id:'interrupted',status:'downloading',qualityNotice:'正在下载更低质量片源'}, {id:'stopped',status:'stopped',qualityNotice:'正在下载更低质量片源'}]; loadDownloadTasks();`);
    assert.equal(h.run('downloadTasks[0].qualityNotice'),'');
    assert.equal(h.run('downloadTasks[1].qualityNotice'),'');
  }],
  ['unverifiable resolution fails closed for explicit quality', async () => {
    const h = fixture(); h.context.testDimensions = null;
    await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.match(h.saved()[0].error, /分辨率|清晰度/);
  }],
  ['existing low-resolution file remains unchanged and is not counted as 1080', async () => {
    const h = fixture({ width:720, height:1280 });
    await h.handlers['hongguo-download-batch']({}, payload());
    const t = h.saved()[0]; fs.writeFileSync(t.savePath, Buffer.alloc(200000, 42));
    h.run('downloadTasks[0].status = "completed"');
    const result = await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    assert.equal(result.success, false);
    assert.match(result.error, /已有|本地/);
    assert.equal(fs.readFileSync(t.savePath)[0], 42);
    assert.equal(h.run('downloadTasks[0].status'), 'completed');
  }],
  ['different quality cannot silently reuse an in-flight task', async () => {
    const h = fixture();
    await h.handlers['hongguo-download-batch']({}, payload('720p'));
    const result = await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    assert.equal(result.success, false);
    assert.equal(h.run('downloadTasks[0].downloadQuality'), '720p');
  }],
  ['invalid quality is rejected before adding any tasks', async () => {
    const h = fixture();
    assert.equal((await h.handlers['hongguo-download-batch']({}, payload('4k'))).success, false);
    assert.equal(h.run('downloadTasks.length'), 0);
  }],
  ['automatic downloads reject an invalid media probe before publishing', async () => {
    const h = fixture(); h.context.testDimensions = null;
    await h.handlers['hongguo-download-batch']({}, payload());
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.equal(fs.existsSync(h.saved()[0].savePath), false);
  }],
  ['all modes reject missing or nonfinite video duration', async () => {
    for (const quality of ['auto', '720p', '1080p']) for (const duration of [0, NaN, Infinity]) {
      const h = fixture(); h.context.testDimensions.duration = duration;
      await h.handlers['hongguo-download-batch']({}, payload(quality));
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'failed', `${quality} ${duration}`);
      assert.equal(fs.existsSync(h.saved()[0].savePath), false);
    }
  }],
  ['existing invalid file is retained and cannot be completed in auto mode', async () => {
    const h = fixture(); h.context.testDimensions = null;
    await h.handlers['hongguo-download-batch']({}, payload());
    const t = h.saved()[0]; fs.writeFileSync(t.savePath, Buffer.alloc(200000, 42));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.equal(fs.readFileSync(t.savePath)[0], 42);
    assert.equal(h.calls.length, 0);
  }],
  ['complete matching decrypted cache avoids a second media transfer', async () => {
    const h = fixture();
    await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', vidIndex:1, prefetch:true });
    assert.equal(h.run("onlineCache.has('11')"), true);
    h.run("requestMedia = async () => { throw new Error('unexpected duplicate media transfer'); }");
    await h.handlers['hongguo-download-batch']({}, payload());
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'completed', h.saved()[0].error);
    assert.equal(fs.statSync(h.saved()[0].savePath).size, 200000);
  }],
  ['1080p prepared cache satisfies auto and 720p downloads without another transfer', async () => {
    for (const quality of ['auto', '720p']) {
      const h = fixture();
      await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', quality:'1080p', prefetch:true });
      assert.equal(h.run("onlineCache.has('11:1080p')"), true);
      h.run("requestMedia = async () => { throw new Error('unexpected repeated transfer or conversion'); }");
      await h.handlers['hongguo-download-batch']({}, payload(quality));
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'completed', h.saved()[0].error);
      assert.equal(h.saved()[0].actualQuality, '1080p');
      assert.equal(h.calls.length, 1, 'source lookup and media conversion must not repeat for a complete cache');
    }
  }],
  ['cross-quality prepared cache still rejects foreign identity and incomplete results', async () => {
    for (const field of ["entry.vid = 'other'", "entry.seriesId = 'other'", "entry.source = 'hema'", "entry.complete = false"]) {
      const h = fixture();
      await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', quality:'1080p', prefetch:true });
      h.run(`{ const entry = onlineCache.get('11:1080p'); ${field}; }`);
      h.run("requestMedia = async () => { throw new Error('network required'); }");
      await h.handlers['hongguo-download-batch']({}, payload());
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'failed', field);
    }
  }],
  ['download waits for the same in-progress episode instead of preparing it twice', async () => {
    for (const quality of ['auto', '1080p']) {
      const h = fixture();
      if (quality === '1080p') {
        h.context.testDimensions = { w:720, h:1280, duration:12, codec:'h264' };
        await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', quality:'720p', prefetch:true });
      }
      let phase, timer;
      const workPhase = new Promise(resolve => { phase = resolve; });
      h.context.workPhase = phase;
      h.context.sendToRenderer = (channel, data) => { h.events.push({channel, data}); if (data.qualityNotice?.startsWith('等待同集')) phase('waiting'); };
      h.run("transferCount=0; finishTransfers=[]; requestMedia=async()=>{ transferCount++; if(transferCount>1)workPhase('duplicate'); await new Promise(resolve=>finishTransfers.push(resolve)); testDimensions={w:1080,h:1920,duration:12,codec:'h264'}; return {headers:{'content-length':'200000'},data:testReadStream()}; };");
      const online = h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', quality:'1080p', prefetch:true });
      while (!h.run('transferCount')) await new Promise(resolve => setImmediate(resolve));
      await h.handlers['hongguo-download-batch']({}, payload(quality));
      const download = h.run('executeHongguoDownload(downloadTasks[0])');
      download.then(() => phase('finished'));
      try {
        const observed = await Promise.race([workPhase, new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error('shared preparation state did not settle')),1000); })]);
        assert.equal(observed, 'waiting', 'download must join preparation after rejecting an insufficient cached rendition');
        assert.equal(h.run('transferCount'), 1, 'one media preparation must serve playback and download');
        h.run('finishTransfers.forEach(resolve=>resolve())');
        await download;
        assert.equal((await online).success, true);
        assert.equal(h.saved()[0].status, 'completed', h.saved()[0].error);
      } finally { clearTimeout(timer); h.run('finishTransfers.forEach(resolve=>resolve())'); await Promise.allSettled([online, download]); }
    }
  }],
  ['canceling a download waiting for shared preparation leaves playback running', async () => {
    const h = fixture();
    h.run("finishTransfers=[]; requestMedia=async()=>{ await new Promise(resolve=>finishTransfers.push(resolve)); return {headers:{'content-length':'200000'},data:testReadStream()}; };");
    const online = h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', quality:'1080p', prefetch:true });
    while (!h.run('finishTransfers.length')) await new Promise(resolve=>setImmediate(resolve));
    await h.handlers['hongguo-download-batch']({}, payload());
    const download = h.run('executeHongguoDownload(downloadTasks[0])');
    let timer;
    try {
      for (let i=0; i<10; i++) await new Promise(resolve=>setImmediate(resolve));
      h.run("downloadTasks[0].cancelSource.cancel('cancel waiting download')");
      await Promise.race([download, new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('waiting download did not cancel')),1000);})]);
      assert.equal(h.saved()[0].status, 'stopped');
      assert.equal(h.run("onlinePreparing.get('11:1080p').controller.signal.aborted"), false);
      h.run('finishTransfers.forEach(resolve=>resolve())');
      assert.equal((await online).success, true);
    } finally { clearTimeout(timer); h.run('finishTransfers.forEach(resolve=>resolve())'); await Promise.allSettled([online,download]); }
  }],
  ['failed shared episode preparation lets the download recover independently', async () => {
    const h = fixture();
    let phase, timer;
    const waiting = new Promise(resolve => { phase = resolve; });
    h.context.sendToRenderer = (channel,data) => { h.events.push({channel,data}); if(data.qualityNotice?.startsWith('等待同集'))phase(); };
    h.run("transferCount=0; failOnline=null; requestMedia=async()=>{ if(++transferCount===1)await new Promise((_,reject)=>failOnline=reject); return {headers:{'content-length':'200000'},data:testReadStream()}; };");
    const online=h.handlers['prepare-online-play']({}, {vid:'11',seriesId:'1',quality:'1080p',prefetch:true});
    while(!h.run('failOnline'))await new Promise(resolve=>setImmediate(resolve));
    await h.handlers['hongguo-download-batch']({},payload());
    const download=h.run('executeHongguoDownload(downloadTasks[0])');
    try {
      await Promise.race([waiting,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('download never joined online preparation')),1000);})]);
      h.run("failOnline(new Error('online preparation failed'))");
      assert.equal((await online).success,false);
      await download;
      assert.equal(h.saved()[0].status,'completed',h.saved()[0].error);
      assert.equal(h.run('transferCount'),2,'only a failed shared preparation may cause a fresh media transfer');
    } finally {clearTimeout(timer);h.run("failOnline(new Error('cleanup'))");await Promise.allSettled([online,download]);}
  }],
  ['completed preparation racing a rejected lower-quality cache is reused without another transfer', async () => {
    const h=fixture({width:720,height:1280});
    await h.handlers['prepare-online-play']({}, {vid:'11',seriesId:'1',quality:'720p',prefetch:true});
    h.run("transferCount=0; finishOnline=null; requestMedia=async()=>{if(++transferCount>1)throw new Error('unexpected duplicate transfer');await new Promise(resolve=>finishOnline=resolve);return {headers:{'content-length':'200000'},data:testReadStream()};};");
    const online=h.handlers['prepare-online-play']({}, {vid:'11',seriesId:'1',quality:'1080p',prefetch:true});
    while(!h.run('finishOnline'))await new Promise(resolve=>setImmediate(resolve));
    let first=true;
    h.context.probeVideoInfo=async()=>{
      if(first){first=false;h.run('finishOnline()');assert.equal((await online).success,true);return {w:720,h:1280,duration:12,codec:'h264'};}
      return {w:1080,h:1920,duration:12,codec:'h264'};
    };
    await h.handlers['hongguo-download-batch']({},payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status,'completed',h.saved()[0].error);
    assert.equal(h.saved()[0].actualQuality,'1080p');
    assert.equal(h.run('transferCount'),1);
  }],
  ['real converted ByteVC2 cache is downloaded without fetching or converting again', async () => {
    const sample=path.resolve(__dirname,'../.planning/playback-bytevc2/episode-1.h264.mp4');
    assert.ok(fs.existsSync(sample),'requires the real Hongguo ByteVC2 conversion fixture; no synthetic substitute');
    const h=fixture({realMedia:true}),bytes=fs.readFileSync(sample);
    h.context.realCacheBytes=bytes;
    h.run("onlineCache.set('11:1080p',{buffer:realCacheBytes,size:realCacheBytes.length,lastUsed:Date.now(),seriesId:'1',vidIndex:1,vid:'11',source:'hongguo',quality:'1080p',complete:true});requestMedia=async()=>{throw new Error('unexpected repeated media transfer')};");
    const cp=require('node:child_process'),spawn=cp.spawn;
    let conversions=0;
    cp.spawn=function(executable,...args){if(path.basename(String(executable)).startsWith('librempeg'))conversions++;return spawn.call(this,executable,...args);};
    try {
      await h.handlers['hongguo-download-batch']({},payload());
      const started=Date.now();
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status,'completed',h.saved()[0].error);
      assert.equal(h.saved()[0].actualQuality,'1080p');
      assert.equal(h.calls.length,0);assert.equal(conversions,0);
      const output=fs.readFileSync(h.saved()[0].savePath),hash=data=>require('node:crypto').createHash('sha256').update(data).digest('hex');
      assert.equal(hash(output),hash(bytes));
      const proof={sample:'real Hongguo ByteVC2 converted fixture',bytes:output.length,actualQuality:h.saved()[0].actualQuality,
        reuseMs:Date.now()-started,extraSourceLookups:h.calls.length,extraConversions:conversions,sha256:hash(output)};
      const destination=path.resolve(__dirname,'../.planning/bytevc2-6.3');fs.mkdirSync(destination,{recursive:true});
      fs.writeFileSync(path.join(destination,'real-cache-reuse.json'),JSON.stringify(proof,null,2)+'\n');
      console.log('REAL_CACHE '+JSON.stringify(proof));
    } finally {cp.spawn=spawn;}
  }, true],
  ['mismatched or unconfirmed cache cannot be downloaded', async () => {
    for (const field of ["entry.vid = 'other'", "entry.seriesId = 'other'", "entry.source = 'hema'", "entry.complete = false"]) {
      const h = fixture();
      await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', prefetch:true });
      h.run(`{ const entry = onlineCache.get('11'); ${field}; }`);
      h.run("requestMedia = async () => { throw new Error('network required'); }");
      await h.handlers['hongguo-download-batch']({}, payload());
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'failed', field);
    }
  }],
  ['cached 720p is not published for 1080p and fetches the requested quality', async () => {
    const h = fixture({ width:720, height:1280 });
    await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', prefetch:true });
    h.run("requestMedia = async () => { testDimensions = { w:1080, h:1920, duration:12, codec:'h264' }; return { headers:{'content-length':'200000'}, data:testReadStream() }; }");
    await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'completed', h.saved()[0].error);
    assert.equal(h.saved()[0].actualQuality, '1080p');
    assert.equal(h.calls.at(-1)[2].quality, '1080p');
  }],
  ['cancel during cached media verification prevents publication', async () => {
    const h = fixture();
    await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', prefetch:true });
    await h.handlers['hongguo-download-batch']({}, payload());
    h.run("probeVideoInfo = async () => { downloadTasks[0].cancelSource.cancel('test cancel'); return testDimensions; }");
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'stopped');
    assert.equal(fs.existsSync(h.saved()[0].savePath), false);
    assert.equal(fs.existsSync(h.saved()[0].savePath + '.enc.tmp'), false);
  }],
  ['a file appearing during verification is never overwritten', async () => {
    const h = fixture();
    await h.handlers['hongguo-download-batch']({}, payload());
    h.run("probeVideoInfo = async () => { fs.writeFileSync(downloadTasks[0].savePath, 'preserve existing file'); return testDimensions; }");
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.equal(fs.readFileSync(h.saved()[0].savePath, 'utf8'), 'preserve existing file');
  }],

  ['matching 1080 cache satisfies explicit quality without refetching', async () => {
    const h = fixture();
    await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', prefetch:true });
    h.run("requestMedia = async () => { throw new Error('unexpected duplicate media transfer'); }");
    await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'completed', h.saved()[0].error);
    assert.equal(h.saved()[0].actualQuality, '1080p');
  }],
  ['third-party cache cannot bypass a newly locked episode', async () => {
    const h = fixture();
    await h.handlers['prepare-online-play']({}, { vid:'xifan:1:11', seriesId:'xifan:1', prefetch:true });
    h.run("hongguo.fetchPlayUrlSingle = async () => ({ url:null, error:'该集已锁定' }); downloadTasks = [{ id:'locked', type:'hongguo', filename:'locked.mp4', hongguoInfo:{ vid:'xifan:1:11', series_id:'xifan:1', series_title:'Fixture' } }]");
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.match(h.saved()[0].error, /锁定/);
    assert.equal(fs.existsSync(h.saved()[0].savePath), false);
  }],
  ['list refresh never starts a media probe', async () => {
    const h = fixture();
    await h.handlers['hongguo-download-batch']({}, payload());
    const t = h.saved()[0]; fs.writeFileSync(t.savePath, Buffer.alloc(200000));
    h.run("downloadTasks[0].status = 'completed'; probeVideoInfo = () => { throw new Error('list refresh must not probe media'); }");
    for (let i = 0; i < 3; i++) await h.handlers['get-download-tasks']({});
  }],

  ['unsupported hard links publish through exclusive copy on removable disks', async () => {
    const originalLink = fs.linkSync, originalCopy = fs.copyFileSync;
    try {
      for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS']) {
        const h = fixture(); let copies = 0;
        fs.linkSync = () => { throw Object.assign(new Error('hard link unavailable'), { code }); };
        fs.copyFileSync = (source, destination, flags) => { copies++; assert.equal(flags, fs.constants.COPYFILE_EXCL); return originalCopy(source, destination, flags); };
        await h.handlers['hongguo-download-batch']({}, payload());
        await h.run('executeHongguoDownload(downloadTasks[0])');
        assert.equal(h.saved()[0].status, 'completed', `${code}: ${h.saved()[0].error}`);
        assert.equal(copies, 1);
        assert.equal(fs.statSync(h.saved()[0].savePath).size, 200000);
        assert.equal(fs.existsSync(h.saved()[0].savePath + '.enc.tmp'), false);
      }
    } finally { fs.linkSync = originalLink; fs.copyFileSync = originalCopy; }
  }],
  ['publication preserves raced existing files with or without hard-link support', async () => {
    const originalLink = fs.linkSync, originalCopy = fs.copyFileSync;
    try {
      for (const code of ['EEXIST', 'ENOTSUP', 'EIO']) {
        const h = fixture(); let copies = 0;
        fs.linkSync = (source, destination) => {
          fs.writeFileSync(destination, 'preserve user file');
          throw Object.assign(new Error('cannot link'), { code });
        };
        fs.copyFileSync = (...args) => { copies++; return originalCopy(...args); };
        await h.handlers['hongguo-download-batch']({}, payload());
        await h.run('executeHongguoDownload(downloadTasks[0])');
        assert.equal(h.saved()[0].status, 'failed', code);
        assert.equal(copies, code === 'ENOTSUP' ? 1 : 0, 'only unsupported links may fall back');
        assert.equal(fs.readFileSync(h.saved()[0].savePath, 'utf8'), 'preserve user file');
        assert.equal(fs.existsSync(h.saved()[0].savePath + '.enc.tmp'), false);
      }
    } finally { fs.linkSync = originalLink; fs.copyFileSync = originalCopy; }
  }],

];
(async () => {
  let failures = 0;
  // Local converted footage is excluded from published sources and runs only with an explicit selector.
  const selected = checks.filter(([name, , localFixture]) => process.argv[2] ? new RegExp(process.argv[2]).test(name) : !localFixture);
  assert(selected.length, 'no matching download integration checks');
  try { for (const [name, check] of selected) {
    try { await check(); console.log('PASS ' + name); }
    catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
  } } finally { for (const dir of dirs) fs.rmSync(dir, {recursive:true, force:true}); }
  console.log(`${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
})();
