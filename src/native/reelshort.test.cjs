const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sid = 'reelshort:abc123:love-again';
const vid = `${sid}:1:chapter1`;
const book = { _id: 'abc123', book_title: 'Love Again', book_pic: 'https://cdn.example.com/cover.jpg', chapter_count: 2 };
const episodes = [{ serial_number: 1, chapter_id: 'chapter1' }, { serial_number: 2, chapter_id: 'chapter2', is_locked: true }];
const html = pageProps => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></html>`;

function fixture(overrides = {}) {
  const calls = [], module = { exports: {} };
  const pages = {
    '/': { fallback: { '/api/ms/hall/webInfo': { bookShelfList: [{ bookshelf_name: 'New Releases', books: [book, book] }] } } },
    '/search': { books: [book] },
    '/movie/love-again-abc123': { data: { ...book, online_base: episodes } },
    '/episodes/episode-1-love-again-abc123-chapter1': { data: { serial_number: 1, chapter_id: 'chapter1', video_url: 'https://cdn.example.com/episode.m3u8?token=temporary' } },
    ...overrides,
  };
  const axios = { get: async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, options });
    assert.equal(parsed.origin, 'https://www.reelshort.com');
    assert.equal(options.maxRedirects, 0);
    assert.equal(typeof options.lookup, 'function');
    assert.ok(options.timeout > 0 && options.timeout <= 10000);
    const page = pages[parsed.pathname];
    if (page instanceof Error) throw page;
    assert.ok(page, `unexpected route ${parsed.pathname}`);
    return { data: typeof page === 'string' ? page : html(page) };
  } };
  const file = path.join(__dirname, 'reelshort.js');
  assert.ok(fs.existsSync(file), 'ReelShort direct adapter must exist');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, require: name => name === 'axios' ? axios : require(name), URL, Buffer, AbortController, setTimeout, clearTimeout,
  }, { filename: file });
  return { api: module.exports, calls };
}

test('ReelShort is opt-in and source preferences survive storage', () => {
  const sources = require('./media-sources');
  assert.equal(sources.getMediaSources({}).some(item => item.id === 'reelshort'), false);
  const settings = sources.setBuiltinSourceEnabled({ root: '/downloads' }, 'reelshort', true);
  assert.equal(settings.root, '/downloads');
  assert.equal(sources.getMediaSources(JSON.parse(JSON.stringify(settings))).some(item => item.id === 'reelshort'), true);
});

test('official catalog/search retain order, deduplicate and never invent pagination', async () => {
  const { api, calls } = fixture();
  const page = await api.browseList();
  assert.equal(page.success, true);
  assert.deepEqual(Array.from(page.results, item => item.series_id), [sid]);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextPage, null);
  const result = await api.search('love & again');
  assert.equal(result.results[0].series_id, sid);
  assert.equal(calls.at(-1).options.params.keywords, 'love & again');
  assert.equal((await api.search('love', 2)).hasMore, false);
  const before = calls.length;
  assert.equal((await api.browseList({ page: 2 })).results.length, 0);
  assert.equal(calls.length, before);
  assert.equal(api.resolveSeriesId('https://www.reelshort.com/movie/love-again-abc123'), sid);
  assert.throws(() => api.resolveSeriesId('https://www.reelshort.com.evil.test/movie/love-again-abc123'));
});

test('homepage books without IDs resolve through exact official search within the same budget', async () => {
  const noId = { ...book }; delete noId._id;
  const { api, calls } = fixture({ '/': { fallback: { '/api/ms/hall/webInfo': { bookShelfList: [{ bookshelf_name: 'New', books: [noId, noId] }] } } } });
  const page = await api.browseList();
  assert.equal(page.success, true);
  assert.equal(page.results[0].series_id, sid);
  assert.equal(calls.length, 2, 'duplicate titles do not repeat the ID lookup');
  const wrong = fixture({
    '/': { fallback: { '/api/ms/hall/webInfo': { bookShelfList: [{ bookshelf_name: 'New', books: [noId] }] } } },
    '/search': { books: [{ ...book, book_title: 'Different Drama' }] },
  });
  assert.equal((await wrong.api.browseList()).success, false, 'never guess a same-query result belongs to this book');
});

test('episode list, public playback and locked/mismatched episodes use the same identity', async () => {
  const { api, calls } = fixture();
  const list = await api.fetchEpisodeList(sid);
  assert.equal(list.episodes[0].vid, vid);
  assert.equal(list.episodes[1].locked, true);
  const playback = await api.fetchPlayUrlSingle(vid, sid);
  assert.equal(playback.format, 'hls');
  assert.equal(playback.source, 'reelshort');
  assert.equal(playback.referer, 'https://www.reelshort.com/');
  const before = calls.length;
  assert.equal((await api.fetchPlayUrlSingle(vid, 'reelshort:other:wrong')).url, null);
  assert.equal(calls.length, before, 'mismatched IDs must fail before network');
  const locked = await api.fetchPlayUrlSingle(`${sid}:2:chapter2`, sid);
  assert.equal(locked.url, null);
  assert.equal(locked.locked, true);
});

test('missing, locked, private or mismatched playback data never becomes a playable URL', async () => {
  for (const data of [
    { serial_number: 1, chapter_id: 'chapter1', video_url: 'http://127.0.0.1/video.mp4' },
    { serial_number: 1, chapter_id: 'chapter1', video_url: 'https://u:p@cdn.example.com/video.mp4' },
    { serial_number: 2, chapter_id: 'chapter1', video_url: 'https://cdn.example.com/video.mp4' },
    { serial_number: 1, chapter_id: 'other', video_url: 'https://cdn.example.com/video.mp4' },
    { serial_number: 1, chapter_id: 'chapter1', video_url: '' },
    { serial_number: 1, chapter_id: 'chapter1', is_locked: true, video_url: 'https://cdn.example.com/video.mp4' },
  ]) {
    const { api } = fixture({ '/episodes/episode-1-love-again-abc123-chapter1': { data } });
    assert.equal((await api.fetchPlayUrlSingle(vid, sid)).url, null);
  }
  const { api } = fixture({ '/search': '<html>site changed</html>' });
  assert.equal((await api.search('love')).success, false);
});

test('region rejection is explicit, bounded and does not leak remote diagnostics', async () => {
  const failure = Object.assign(new Error('https://host.invalid/?secret=do-not-log'), { response: { status: 403 } });
  const { api, calls } = fixture({ '/search': failure });
  const result = await api.search('love');
  assert.equal(result.success, false);
  assert.match(result.error, /地区|网络/);
  assert.doesNotMatch(result.error, /secret|host.invalid/);
  assert.equal(calls.length, 1);
  const expired = await api.search('love', 1, { deadline: Date.now() - 1 });
  assert.equal(expired.success, false);
  assert.equal(calls.length, 1);
});

test('frontend registry and random recommendations recognize enabled overseas identities', async () => {
  const model = await import('../components/mediaSourcesModel.mjs');
  const random = await import('../components/randomDramaModel.mjs');
  assert.equal(model.createMediaSourcesStore(async () => ({})).getSnapshot().sources.some(item => item.id === 'reelshort'), false);
  const available = [{ id: 'reelshort', label: 'ReelShort（海外）' }];
  assert.equal(model.normalizeMediaSources(available).length, 1);
  assert.match(model.mediaSourceLabel(sid), /ReelShort/);
  const pool = await random.loadRandomPool(async () => ({ success: true, results: [{ series_id: sid, series_title: 'Love Again' }] }), { sources: available });
  assert.equal(pool.items[0].series_id, sid);
});

test('desktop routes catalog, search, share links and episodes to ReelShort; downloads reject foreign or locked episodes', async () => {
  const { api, calls } = fixture();
  let enabled = false;
  const handlers = {}, main = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const context = vm.createContext({
    require: name => {
      if (['./reelshort', './src/native/reelshort'].includes(name)) return api;
      throw new Error(`unexpected dependency ${name}`);
    },
    getCurrentSettings: () => ({ builtin_sources: { reelshort: enabled } }), proxyStartupFallback: false,
    ipcMain: { handle: (name, handler) => handlers[name] = handler },
    normalizeDownloadQuality: value => value || 'auto', throwIfAborted: () => {}, URL,
  });
  const load = (source, name) => {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
  };
  const native = fs.readFileSync(path.join(__dirname, 'hongguo.js'), 'utf8');
  for (const name of ['resolveSeriesId', 'fetchEpisodeList', 'fetchPlayUrlSingle']) load(native, name);
  context.hongguo = { fetchEpisodeList: context.fetchEpisodeList };
  for (const name of ['searchAtSource', 'searchAtSourcePage', 'enqueueEpisodes']) load(main, name);
  const start = main.indexOf("ipcMain.handle('browse-list'");
  vm.runInContext(main.slice(start, main.indexOf('\n});', start) + 4), context);
  assert.equal((await handlers['browse-list']({}, { source: 'reelshort' })).success, false);
  await assert.rejects(context.searchAtSource('love', { source: 'reelshort' }), /来源已关闭/);
  assert.equal(calls.length, 0);
  enabled = true;
  assert.equal((await handlers['browse-list']({}, { source: 'reelshort' })).results[0].series_id, sid);
  assert.equal((await context.searchAtSource('love', { source: 'reelshort' })).channel, 'reelshort');
  assert.equal(await context.resolveSeriesId(sid), sid);
  assert.equal((await context.fetchEpisodeList(sid)).series_id, sid);
  assert.equal((await context.fetchPlayUrlSingle(vid, sid, {})).format, 'hls');
  await assert.rejects(context.enqueueEpisodes({ seriesId: sid, episodes: [{ vid: `${sid}:2:chapter2`, vid_index: 2 }] }), /锁定/);
  await assert.rejects(context.enqueueEpisodes({ seriesId: '123456', episodes: [{ vid, vid_index: 1 }] }), /来源不匹配/);
});

test('desktop media transfer uses the existing public-network guard and source headers', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  let captured;
  const context = vm.createContext({
    URL, checkCustomAccess: () => {}, hongguo: {},
    require: name => { assert.equal(name, './src/native/web-media-guard'); return require('./web-media-guard'); },
    axios: async config => { captured = config; return { status: 200, headers: { 'content-type': 'video/mp4' } }; },
  });
  const start = main.indexOf('async function requestMedia(');
  vm.runInContext(main.slice(start, main.indexOf('\n}', start) + 2), context);
  await context.requestMedia({ url: 'https://cdn.example.com/episode.mp4', source: 'reelshort', userAgent: 'source-agent', referer: 'https://www.reelshort.com/' });
  assert.equal(typeof captured.lookup, 'function');
  assert.equal(captured.headers['User-Agent'], 'source-agent');
  assert.equal(captured.headers.Referer, 'https://www.reelshort.com/');
  await assert.rejects(context.requestMedia({ url: 'https://127.0.0.1/episode.mp4', source: 'reelshort' }), /公网/);
});
