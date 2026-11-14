const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../src/native/xifan.js');
const sid = 'xifan:huabo:drama1';
const vid = `${sid}:episode1`;
const list = { elements: [{ contents: [{ duanjuVo: { source: 'huabo', duanjuId: 'drama1', title: '<tag>测试剧</tag>', total: 3, categories: ['都市'] } }] }], hasMore: true, offset: 30 };
const detail = { source: 'huabo', duanjuId: 'drama1', title: '测试剧', episodeList: [
  { episodeId: 'episode1', index: 1, unlock: true, playUrl: 'https://dj.youlishipin.com/duanju/video302?episodeId=episode1' },
  { episodeId: 'episode2', index: 2, unlock: false, playUrl: 'https://dj.youlishipin.com/duanju/video302?episodeId=episode2' },
  { episodeId: 'episode3', index: 3, playUrl: 'https://dj.youlishipin.com/duanju/video302?episodeId=episode3' },
] };

async function check() {
  assert.ok(fs.existsSync(sourcePath), '缺少西饭原生适配器');
  const requests = [];
  const axios = { get: async (url, options) => {
    requests.push({ url, options });
    assert.equal(new URL(url).origin, 'https://xifan-api-cn.youlishipin.com');
    assert.ok(!/cookie|authorization|session|token/i.test(JSON.stringify(options)));
    const data = url.includes('getDuanjuInfo') ? detail : options.params.reqType === 'duanjuCategory'
      ? { elements: [{ contents: [
        { categoryItemVo: { categoryId: 68, oppoCategory: '都市', version: 1 } },
        { categoryItemVo: { categoryId: 68, oppoCategory: '青春', version: 1 } },
      ] }] } : list;
    return { data: { ret: 0, result: structuredClone(data) } };
  } };
  const context = { module: { exports: {} }, require: name => name === 'axios' ? axios :
    ['./src/native/web-media-guard', './web-media-guard'].includes(name) ? require('../src/native/web-media-guard') : require(name),
    Buffer, URL, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const xifan = context.module.exports;
  const browse = await xifan.browseList({ page: 1 });
  assert.equal(browse.success, true);
  assert.equal(browse.results[0].series_id, sid);
  assert.equal(browse.results[0].series_title, '测试剧');
  assert.equal(browse.genres.length, 2);
  assert.notEqual(browse.genres[0].slug, browse.genres[1].slug, '同分类号不同名称不能碰撞');
  assert.equal(browse.totalPages, 0, '来源无总页数，不应虚构');
  assert.equal(browse.hasMore, true);
  await xifan.browseList({ page: 2, genre: browse.genres[1].slug });
  assert.equal(requests.at(-1).options.params.offset, 30);
  assert.equal(requests.at(-1).options.params.categoryNames, '青春');
  const search = await xifan.search('测试剧', 2);
  assert.equal(search.success, true);
  assert.equal(search.results[0].series_title, '测试剧');
  assert.equal(requests.at(-1).options.params.keyword, '测试剧');
  assert.equal(requests.at(-1).options.params.pageIndex, 2);
  const episodes = await xifan.fetchEpisodeList(sid);
  assert.equal(episodes.episodes.length, 3);
  assert.equal(episodes.episodes[0].vid, vid);
  assert.equal(episodes.episodes[0].locked, false);
  assert.equal(episodes.episodes[1].locked, true);
  assert.equal(episodes.episodes[2].locked, true, '缺少unlock必须拒绝');
  assert.ok(!JSON.stringify(episodes).includes('playUrl'), '分集不泄露锁定集媒体地址');

  const originalDetail = structuredClone(detail);
  Object.assign(detail, { source: 'jiuzhou', duanjuId: '253', title: '天龙战神',
    episodeList: [
      { episodeId: '65863', index: 1, title: '爱归良辰', unlock: true, playUrl: originalDetail.episodeList[0].playUrl },
      { episodeId: '50846', index: 2, title: '爱归良辰', unlock: false, playUrl: originalDetail.episodeList[1].playUrl },
    ] });
  const known = await xifan.fetchEpisodeList('xifan:jiuzhou:253');
  assert.equal(known.episodes[0].title, '', '已核实的上游冲突标题不能显示为可信分集名');
  assert.equal(known.series_title, '天龙战神');
  assert.deepEqual(Array.from(known.episodes, ep => [ep.vid, ep.vid_index, ep.locked]), [
    ['xifan:jiuzhou:253:65863', 1, false], ['xifan:jiuzhou:253:50846', 2, true],
  ], '去除标题不能改变分集编号、顺序或权限');
  assert.equal((await xifan.fetchPlayUrlSingle(known.episodes[0].vid, known.series_id)).url, originalDetail.episodeList[0].playUrl);
  for (const [seriesId, seriesTitle, title] of [
    ['xifan:jiuzhou:254', '天龙战神', '爱归良辰'],
    ['xifan:huabo:253', '天龙战神', '爱归良辰'],
    ['xifan:jiuzhou:253', '爱归良辰', '爱归良辰'],
    ['xifan:jiuzhou:253', '天龙战神', '天龙战神'],
    ['xifan:jiuzhou:253', '天龙战神', '第一章：归来'],
    ['xifan:jiuzhou:253', '天龙战神', '第二章：重逢'],
    ['xifan:jiuzhou:253', '天龙战神', '来源正式别名'],
    ['xifan:jiuzhou:253', '天龙战神', ''],
  ]) {
    assert.equal(xifan.episodeDisplayTitle(seriesId, seriesTitle, title), title, '其他来源、剧名、正常分集或别名不得误伤');
  }
  assert.equal(xifan.episodeDisplayTitle('xifan:jiuzhou:253', '天龙战神', '爱归良辰'), '', '旧资料使用同一纯展示规则');
  Object.assign(detail, originalDetail);
  console.log('PASS 西饭已核实冲突标题回退，保留剧名、分集身份、权限、媒体映射及其他别名');

  assert.ok((await xifan.fetchPlayUrlSingle(vid, sid)).url);
  detail.episodeList[0].unlock = false;
  assert.equal((await xifan.fetchPlayUrlSingle(vid, sid)).url, null, '原先可用地址也必须重新验锁');
  assert.equal((await xifan.fetchPlayUrlSingle(`${sid}:episode2`, sid)).locked, true);
  detail.episodeList[0].unlock = true;
  for (const invalid of ['http://media.example/file.mp4', 'https://user:pass@dj.youlishipin.com/file', 'file:///tmp/video.mp4']) {
    detail.episodeList[0].playUrl = invalid;
    assert.equal((await xifan.fetchPlayUrlSingle(vid, sid)).url, null);
  }
  assert.equal((await xifan.fetchPlayUrlSingle(vid, 'xifan:other:drama1')).url, null);
  assert.equal((await xifan.fetchPlayUrlSingle('123', sid)).url, null);
  await assert.rejects(xifan.fetchEpisodeList('xifan:huabo:../outside'));
  const nativeContext = { module: { exports: {} }, Buffer, process: { env: {} },
    require: name => name === './xifan' ? xifan : name === 'axios' ? { get: () => { throw Error('西饭不得回退红果'); } } : require(name.startsWith('.') ? path.join(__dirname, '../src/native', name) : name), console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/native/hongguo.js'), 'utf8'), nativeContext);
  assert.equal((await nativeContext.module.exports.fetchEpisodeList(sid)).source, 'xifan');
  assert.equal((await nativeContext.module.exports.fetchPlayUrlSingle(`${sid}:episode2`, sid)).locked, true);
  assert.equal((await nativeContext.module.exports.fetchPlayUrlSingle(vid, '123')).url, null);
  console.log('PASS 西饭目录、搜索、分页、命名空间、实时锁定、URL边界与红果分发');
}

async function live() {
  const xifan = require('../src/native/xifan');
  const browse = await xifan.browseList({});
  assert.equal(browse.success, true);
  assert.ok(browse.results.length);
  const next = await xifan.browseList({ page: 2 });
  assert.equal(next.success, true);
  assert.ok(next.results.length);
  assert.notEqual(next.results[0].series_id, browse.results[0].series_id);
  const search = await xifan.search('老婆大人别想逃');
  assert.ok(search.results.length);
  const detail = await xifan.fetchEpisodeList('xifan:huabo:hbEpisodes0000000000000000000083');
  const locked = detail.episodes.find(episode => episode.locked);
  assert.ok(locked);
  assert.equal((await xifan.fetchPlayUrlSingle(locked.vid, detail.series_id)).url, null);
  const play = await xifan.fetchPlayUrlSingle(detail.episodes[0].vid, detail.series_id);
  assert.ok(play.url);
  const head = await require('axios').head(play.url, { timeout: 10000, maxRedirects: 5 });
  assert.equal(head.status, 200);
  assert.match(head.headers['content-type'], /video/);
  console.log(JSON.stringify({ live: 'PASS', browse: browse.results.length, page2: next.results.length,
    search: search.results.length, episodes: detail.episodes.length, locked: detail.episodes.filter(e => e.locked).length,
    headStatus: head.status, mediaType: head.headers['content-type'], bytes: head.headers['content-length'] }));
}

check().then(() => process.argv.includes('--live') ? live() : undefined).catch(error => { console.error(error.message); process.exitCode = 1; });
