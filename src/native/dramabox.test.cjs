const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sid = 'dramabox:42000000481', vid = `${sid}:700030540`;
const book = { bookId: '42000000481', bookName: 'Love You To Death', chapterCount: 2, cover: 'https://img.dramaboxdb.com/cover.jpg' };
const chapters = [
  { id: '700030540', index: 0, name: 'Episode 1', unlock: true, duration: 140681, mp4: 'https://hwztvideo.dramaboxdb.com/episode.mp4' },
  { id: '700030541', index: 1, name: 'Episode 2', unlock: false, chapterPrice: 0, mp4: 'https://hwztvideo.dramaboxdb.com/preview.mp4' },
];
function fixture(overrides = {}) {
  const file = path.join(__dirname, 'dramabox.js'), module = { exports: {} }, calls = [];
  assert.ok(fs.existsSync(file), 'DramaBox public source must exist');
  const axios = { get: async (url, config) => {
    const pathname = new URL(url).pathname; calls.push({ pathname, config });
    assert.equal(new URL(url).origin, 'https://www.dramabox.com');
    assert.equal(config.maxRedirects, 0);
    const data = overrides[pathname] || (pathname === '/drama/42000000481'
      ? { bookInfo: book, chapterList: chapters } : { bookList: [book], pageNo: config.params?.page || 1, totalPage: 3, pages: 3, totalNum: 3 });
    if (data instanceof Error) throw data;
    if (typeof data === 'string') return { data };
    return { data: `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { locale: 'en', ...data } } })}</script>` };
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: name => name === 'axios' ? axios : require(name),
    URL, AbortController, setTimeout, clearTimeout }, { filename: file });
  return { api: module.exports, calls };
}

test('DramaBox searches and browses real upstream pages with bounded requests', async () => {
  const { api, calls } = fixture();
  const found = await api.search('love & time', 2);
  assert.equal(found.results[0].series_id, sid); assert.equal(found.page, 2); assert.equal(found.hasMore, true);
  assert.equal(calls[0].config.params.searchValue, 'love & time');
  await api.browseList({ page: 2 }); assert.equal(calls.at(-1).pathname, '/browse/0/2');
  const bad = fixture({ '/search': { bookList: [book], pageNo: 1, totalPage: 3 } });
  assert.equal((await bad.api.search('love', 2)).success, false);
  const start = calls.length; assert.equal((await api.search('love', 1, { deadline: Date.now() - 1 })).success, false);
  assert.equal(calls.length, start);
});

test('DramaBox keeps full episode identity and refuses unknown access, even with zero price or a preview URL', async () => {
  const { api } = fixture(); const detail = await api.fetchEpisodeList(sid);
  assert.equal(detail.total, 2); assert.equal(detail.episodes[0].vid, vid); assert.equal(detail.episodes[1].locked, true);
  assert.equal((await api.fetchPlayUrlSingle(vid, sid)).source, 'dramabox');
  assert.equal((await api.fetchPlayUrlSingle(`${sid}:700030541`, sid)).locked, true);
  const unknown = fixture({ '/drama/42000000481': { bookInfo: book, chapterList: [{ ...chapters[0], unlock: undefined }, chapters[1]] } });
  assert.equal((await unknown.api.fetchPlayUrlSingle(vid, sid)).locked, true);
  assert.equal((await api.fetchPlayUrlSingle(vid, 'dramabox:99999999')).url, null);
});

test('DramaBox rejects truncated, duplicate, non-contiguous and foreign chapter lists', async () => {
  for (const data of [
    { bookInfo: book, chapterList: [chapters[0]] },
    { bookInfo: book, chapterList: [chapters[0], chapters[0]] },
    { bookInfo: book, chapterList: [chapters[0], { ...chapters[1], index: 3 }] },
    { bookInfo: { ...book, bookId: '99999999' }, chapterList: chapters },
  ]) await assert.rejects(fixture({ '/drama/42000000481': data }).api.fetchEpisodeList(sid));
});

test('DramaBox accepts only official HTTPS MP4 media and checks redirect destinations', async () => {
  const { api } = fixture();
  for (const url of ['http://hwztvideo.dramaboxdb.com/a.mp4', 'https://127.0.0.1/a.mp4', 'https://dramaboxdb.com.evil.test/a.mp4', 'https://u:p@hwztvideo.dramaboxdb.com/a.mp4']) {
    assert.throws(() => api.mediaRequestOptions(url));
  }
  const options = api.mediaRequestOptions('https://hwztvideo.dramaboxdb.com/a.mp4');
  assert.throws(() => options.beforeRedirect({}, { headers: { location: 'http://127.0.0.1/private' } }, { url: 'https://hwztvideo.dramaboxdb.com/a.mp4' }));
});

test('DramaBox share IDs are scoped and network errors are sanitized', async () => {
  const { api } = fixture();
  assert.equal(api.resolveSeriesId('https://www.dramabox.com/drama/42000000481/love-you-to-death'), sid);
  assert.equal(api.resolveSeriesId('https://www.dramaboxdb.com/movie/42000000481/drama'), sid);
  assert.throws(() => api.resolveSeriesId('https://www.dramabox.com.evil.test/drama/42000000481'));
  const error = Object.assign(new Error('secret signed URL'), { response: { status: 403 } });
  const failed = await fixture({ '/search': error }).api.search('love');
  assert.match(failed.error, /403/); assert.doesNotMatch(failed.error, /secret|signed/);
});

test('DramaBox enforces English even when Next locale is only at the root', async () => {
  for (const locale of ['zh', undefined]) {
    const envelope = { locale, props: { pageProps: { bookList: [book], pageNo: 1, totalPage: 1 } } };
    const { api } = fixture({ '/search': `<script id="__NEXT_DATA__">${JSON.stringify(envelope)}</script>` });
    assert.equal((await api.search('love')).success, false);
  }
});

test('DramaBox registry, source labels and desktop permission routes retain their source identity', async () => {
  const registry = require('./media-sources');
  assert.equal(registry.getMediaSources({}).some(item => item.id === 'dramabox'), false);
  const settings = registry.setBuiltinSourceEnabled({}, 'dramabox', true);
  assert.equal(registry.getMediaSources(settings).some(item => item.id === 'dramabox'), true);
  const model = await import('../components/mediaSourcesModel.mjs');
  assert.equal(model.normalizeMediaSources([{ id: 'dramabox', label: 'DramaBox（海外）' }]).length, 1);
  assert.match(model.mediaSourceLabel(sid), /DramaBox/);
  const main = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const context = vm.createContext({ getCurrentSettings: () => ({}), normalizeDownloadQuality: () => 'auto',
    hongguo: { fetchEpisodeList: async () => ({ episodes: [{ vid, vid_index: 1, locked: true }] }) } });
  const start = main.indexOf('async function enqueueEpisodes(');
  vm.runInContext(main.slice(start, main.indexOf('\n}', start) + 2), context);
  await assert.rejects(context.enqueueEpisodes({ seriesId: sid, episodes: [{ vid, vid_index: 1 }] }), /锁定/);
  await assert.rejects(context.enqueueEpisodes({ seriesId: '123456', episodes: [{ vid, vid_index: 1 }] }), /来源不匹配/);
});
