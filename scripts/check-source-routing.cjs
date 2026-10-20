const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, randomUUID } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start, source.indexOf('\n}', start) + 2);
}
const checks = [
  ['compatibility cache and shared preparation cannot bypass source access', async () => {
    const handlers = {};
    let cacheReads = 0;
    const context = { AbortController, randomUUID, console, playbackQuality: (value = 'auto', vid = '') => {
      if (!['auto', '720p', '1080p'].includes(value)) throw new Error('在线播放清晰度无效，请选择自动、720p 或 1080p');
      if (value !== 'auto' && /^(xifan|hema|custom):/.test(String(vid))) throw new Error('此来源暂不支持指定在线播放清晰度，请选择自动');
      return value;
    }, ipcMain: { handle: (name, fn) => handlers[name] = fn },
      hongguo: { fetchEpisodeList: async () => ({ episodes: [{ vid: 'xifan:huabo:a:2', vid_index: 2, locked: true }] }) },
      compatPreparing: new Map(), compatRequests: new Map(), compatClearing: null, compatPathFor: () => 'cached',
      fs: { existsSync: () => { cacheReads++; return true; }, statSync: () => ({ size: 200000 }), utimesSync() {} },
      localPlayUrl: () => 'file:///cached.mp4' };
    vm.runInNewContext(extract('transcodeForPlayback'), context);
    const start = source.indexOf("ipcMain.handle('transcode-for-playback'");
    vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
    // A cache is not a downloaded original; exercise the real access check before reading it.
    const payload = { seriesId: 'xifan:huabo:a', vidIndex: 2, vid: 'xifan:huabo:a:2' };
    const first = handlers['transcode-for-playback']({}, payload);
    const shared = handlers['transcode-for-playback']({}, payload);
    assert.equal(context.compatPreparing.size, 1);
    assert.equal(context.compatRequests.size, 2);
    for (const result of await Promise.all([first, shared])) {
      assert.equal(result.success, false, 'locked episode must not reuse the in-flight/cache result');
      assert.match(result.error, /锁定/);
    }
    assert.equal(cacheReads, 0, 'access must be checked before reading the existing cache');
  }],
  ['source URL accepts only the exact HTTPS origin', () => {
    const context = { URL, SEARCH_SITE: 'https://hongguoduanju.com' };
    vm.runInNewContext(extract('sourcePageUrl'), context);
    assert.equal(context.sourcePageUrl('https://hongguoduanju.com/category/comic'), 'https://hongguoduanju.com/category/comic');
    for (const value of ['https://hongguoduanju.com.evil.test/', 'http://hongguoduanju.com/', 'https://user@hongguoduanju.com/', 'javascript:alert(1)']) assert.throws(() => context.sourcePageUrl(value));
  }],
  ['different sources and same-title Xifan series use different folders', () => {
    const context = { path, createHash, sanitizeFolderName: value => value };
    vm.runInNewContext(extract('seriesDownloadDir'), context);
    const resolve = context.seriesDownloadDir;
    const official = resolve('/downloads', '123', '同名剧');
    assert.equal(official, '/downloads/红果短剧/同名剧-' + createHash('sha256').update('123').digest('hex').slice(0, 12));
    assert.notEqual(official, resolve('/downloads', '456', '同名剧'));
    const a = resolve('/downloads', 'xifan:huabo:a', '同名剧');
    assert.notEqual(a, resolve('/downloads', '123', '同名剧'));
    assert.notEqual(a, resolve('/downloads', 'xifan:huabo:b', '同名剧'));
  }],
  ['queue rejects spoofed lock state before filesystem writes', async () => {
    const context = { getCurrentSettings: () => ({}), normalizeDownloadQuality: () => 'auto',
      hongguo: { fetchEpisodeList: async () => ({ episodes: [{ vid: 'xifan:huabo:a:2', vid_index: 2, locked: true }] }) } };
    vm.runInNewContext(extract('enqueueEpisodes'), context);
    await assert.rejects(async () => context.enqueueEpisodes({ seriesId: 'xifan:huabo:a', seriesTitle: 'test', episodes: [{ vid: 'xifan:huabo:a:2', vid_index: 2, locked: false }] }), /锁定/);
  }],
];
(async () => {
  let failures = 0;
  const selected = checks.filter(([name]) => !process.argv.includes('--compat') || name.startsWith('compatibility'));
  for (const [name, run] of selected) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  console.log(`${selected.length - failures}/${selected.length} checks passed`);
  process.exitCode = failures ? 1 : 0;
})();
