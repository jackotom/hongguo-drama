const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../src/native/hema.js');
const sid = 'hema:41000115014';
const vid = `${sid}:591821028`;
// Public response fields captured on 2026-10-07; signed URLs replaced with inert examples.
// Remaining episode IDs are synthetic; preserve the observed 74 total / 5 free / 69 charged shape.
const detail = { bookInfoVo: { bookId: '41000115014', bookName: '出手', totalChapterNum: '74', coverWap: 'https://images.example/cover.jpg' },
  chapterList: Array.from({ length: 74 }, (_, i) => ({ chapterId: String(591821028 + i), chapterName: `第${i + 1}集`,
    chapterIndex: i + 1, isCharge: i < 5 ? '0' : '1', ...(i < 5 ? { chapterVideoVo: {
      mp4720p: 'https://media.example/720.mp4', mp4: 'https://media.example/video.mp4', encryptUrl: 'https://media.example/forbidden' } } : {}) })) };
const list = { retCode: 0, data: { isMore: 1, totalSize: 241, bookList: [{ bookId: '41000115014',
  bookName: '<em>出手</em>', totalChapterNum: '74', coverWap: 'https://images.example/cover.jpg', bookTypeThree: [{ id: 1, name: '都市' }] }] } };

async function check() {
  assert.ok(fs.existsSync(sourcePath), '缺少河马原生适配器');
  const requests = [];
  let failure, malformedHtml = false, expireTimer = false;
  async function request(method, url, body, options) {
    requests.push({ method, url, body, options });
    assert.equal(new URL(url).origin, 'https://www.kuaikaw.cn');
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxContentLength, 8 * 1024 * 1024);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.headers.pname, 'www.kuaikaw.cn');
    assert.equal(options.headers.Origin, 'https://www.kuaikaw.cn');
    assert.ok(!/cookie|authorization|session|token/i.test(JSON.stringify(options.headers)));
    if (expireTimer) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted'))));
    if (failure) throw failure;
    return { data: method === 'POST' ? structuredClone(list) : malformedHtml ? '<html>unavailable</html>'
      : `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: detail } })}</script>` };
  }
  const context = { module: { exports: {} }, require: name => name === 'axios' ? {
    get: (url, options) => request('GET', url, null, options), post: (url, body, options) => request('POST', url, body, options),
  } : ['./src/native/web-media-guard', './web-media-guard'].includes(name) ? require('../src/native/web-media-guard') : require(name),
    Buffer, URL, AbortController, setTimeout: (fn, ms) => setTimeout(fn, expireTimer ? 0 : ms), clearTimeout };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const hema = context.module.exports;
  const search = await hema.search('总裁', 2);
  assert.equal(search.success, true);
  assert.equal(search.results[0].series_id, sid);
  assert.equal(search.results[0].series_title, '出手');
  assert.equal(search.results[0].episode_count, 74);
  assert.equal(search.results[0].tags[0], '都市');
  assert.equal(search.hasMore, true);
  assert.equal(search.nextPage, 3);
  assert.equal(search.total, 241);
  assert.equal(requests.at(-1).body.keyword, '总裁');
  assert.equal(requests.at(-1).body.index, 2);
  assert.equal(requests.at(-1).body.sourceType, 1);
  assert.equal(requests.at(-1).url, 'https://www.kuaikaw.cn/seo/video/6007');
  list.data.isMore = 0;
  assert.equal((await hema.search('总裁')).hasMore, false);
  list.retCode = 1;
  assert.equal((await hema.search('总裁')).success, false);
  list.retCode = 0;
  const beforeBlank = requests.length;
  assert.equal((await hema.search('   ')).success, false);
  assert.equal(requests.length, beforeBlank);

  const episodes = await hema.fetchEpisodeList(sid);
  assert.equal(episodes.total, 74);
  assert.equal(episodes.episodes.filter(e => e.locked).length, 69);
  assert.equal(episodes.episodes[0].vid, vid);
  assert.equal(episodes.episodes[0].vid_index, 1);
  assert.equal(episodes.episodes[0].series_title, '出手');
  assert.ok(!JSON.stringify(episodes).includes('media.example'));
  assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).url, 'https://media.example/720.mp4');
  assert.equal((await hema.fetchPlayUrlSingle(`${sid}:591821033`, sid)).locked, true);
  for (const charge of ['1', undefined, null, false, '', 'false', '00']) {
    detail.chapterList[0].isCharge = charge;
    assert.equal((await hema.fetchEpisodeList(sid)).episodes[0].locked, true);
    const play = await hema.fetchPlayUrlSingle(vid, sid);
    assert.equal(play.url, null, 'cached free status must never bypass a changed/unknown charge flag');
    assert.equal(play.locked, true);
  }
  detail.chapterList[0].isCharge = '0';
  const media = detail.chapterList[0].chapterVideoVo;
  delete media.mp4720p;
  assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).url, 'https://media.example/video.mp4');
  for (const invalid of ['http://media.example/video.mp4', 'https://user:pass@media.example/video.mp4', 'file:///tmp/video.mp4', '']) {
    media.mp4 = invalid;
    assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).url, null, 'must not fall back to encryptUrl');
  }
  const beforeInvalid = requests.length;
  for (const invalid of ['123', 'xifan:41000115014:591821028', `${vid}:extra`, 'hema:../evil:1']) {
    assert.equal((await hema.fetchPlayUrlSingle(invalid, sid)).url, null);
  }
  for (const invalidSid of ['hema:123', 'xifan:41000115014', 'https://evil.example/']) {
    assert.equal((await hema.fetchPlayUrlSingle(vid, invalidSid)).url, null);
  }
  await assert.rejects(hema.fetchEpisodeList('hema:../evil'));
  assert.equal(requests.length, beforeInvalid, 'invalid identity must fail before network access');
  assert.equal((await hema.fetchPlayUrlSingle(`${sid}:999`, sid)).url, null);
  detail.bookInfoVo.bookId = '999';
  await assert.rejects(hema.fetchEpisodeList(sid));
  assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).url, null);
  detail.bookInfoVo.bookId = '41000115014';
  malformedHtml = true;
  await assert.rejects(hema.fetchEpisodeList(sid));
  malformedHtml = false;
  for (const code of ['ECONNABORTED', 'ERR_BAD_RESPONSE']) {
    failure = Object.assign(Error('private response must not leak'), { code });
    const result = await hema.search('总裁');
    assert.equal(result.success, false);
    assert.ok(!result.error.includes('private'));
    if (code === 'ECONNABORTED') assert.match(result.error, /超时/);
  }
  failure = undefined;
  expireTimer = true;
  assert.match((await hema.search('总裁')).error, /超时/);
  console.log('PASS 河马搜索分页、74集/69收费、实时权限、身份归属、HTTPS、无加密回退、错误与超时');
}

async function live() {
  const hema = require('../src/native/hema');
  const search = await hema.search('总裁');
  assert.equal(search.success, true);
  assert.ok(search.results.length);
  const episodes = await hema.fetchEpisodeList(sid);
  const free = episodes.episodes.find(e => !e.locked);
  const locked = episodes.episodes.find(e => e.locked);
  assert.ok(free && locked);
  assert.ok((await hema.fetchPlayUrlSingle(free.vid, sid)).url);
  assert.equal((await hema.fetchPlayUrlSingle(locked.vid, sid)).url, null);
  console.log(JSON.stringify({ live: 'PASS', search: search.results.length, episodes: episodes.total,
    locked: episodes.episodes.filter(e => e.locked).length, freeAddress: true, mediaDownloaded: false }));
}

check().then(() => process.argv.includes('--live') ? live() : undefined)
  .catch(error => { console.error(error.message); process.exitCode = 1; });
