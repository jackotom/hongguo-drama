const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../src/native/hongguo.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const page = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
  'player_(series_id)/(vid)/page': { vid: '11', series_id: '1', seriesDetail: { series_id: '1', vid_list: ['11', '12'], series_name: '测试剧' },
    publicVideoSeo: { available: true, itemId: '11', seriesId: '1' } },
} })}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', url: 'https://hongguoduanju.com/player/1/11', contentUrl: 'https://media.example/video.mp4' })}</script>`;

function fixture({ web = true, api = false, app = false, blockedVids = [], html = page, stalledPlayer = false } = {}) {
  let now = 0;
  const state = { web, api, app, get: 0, post: 0, appCalls: 0, waits: 0, playerCancelled: false };
  require('../src/native/source-order').setSourceOrder(['web', 'app', 'sdk', 'openhongguo']);
  const axios = {
    async get(url, options) {
      state.get++;
      if (stalledPlayer && url.endsWith('/player/1')) return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          state.playerCancelled = true;
          reject(new Error('cancelled'));
        }, { once: true });
      });
      if (!state.web || blockedVids.some(vid => url.endsWith(`/${vid}`))) throw new Error('web unavailable');
      return { data: html };
    },
    async post(url, body) {
      state.post++;
      if (!state.api) return { status: 200, headers: {}, data: Buffer.alloc(0) };
      const data = url.includes('multi_video_detail')
        ? { '1': { video_data: { series_title: '测试剧', video_list: [{ vid: '11', vid_index: 1 }] } } }
        : { [body.mixed_video_id_map['1004'][0]]: { video_model: JSON.stringify({ video_list: [{ main_url: 'https://media.example/encrypted.mp4', encrypt_info: { spade_a: 'test-key' } }] }) } };
      return { status: 200, headers: {}, data: Buffer.from(JSON.stringify({ code: 0, data })) };
    },
  };
  const context = {
    module: { exports: {} }, Buffer, AbortController, process: { env: {} },
    require: name => name === 'axios' ? axios
      : name === './app-source' ? { fetchAppPlayUrl: async (_vid, options) => {
        if (options?.allowV8 === false) throw Error('sdk unavailable');
        state.appCalls++;
        if (!state.app) throw Error('app unavailable');
        return { url: 'https://media.example/app.mp4', contentKey: '01'.repeat(16), source: 'app' };
      } }
      : name === './openhongguo-source' ? { fetchPlayUrlSingle: async () => { throw Error('openhongguo unavailable'); } }
      : require(name.startsWith('.') ? path.join(path.dirname(sourcePath), name) : name),
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { if (ms === 600) return setTimeout(fn, 0); state.waits++; fn(); },
    console: { warn() {}, log() {} },
  };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return { native: context.module.exports, state, advance: ms => { now += ms; } };
}

const checks = [
  ['App 源补齐网页缺失分集并复用短缓存', async () => {
    const { native, state } = fixture({ web: false, app: true });
    const result = await native.fetchPlayUrlSingle('12', '1');
    assert.equal(result.source, 'app');
    assert.equal(result.contentKey.length, 32);
    await native.fetchPlayUrlSingle('12', '1');
    assert.equal(state.appCalls, 1);
    assert.equal(state.post, 0, 'App 新接口可用时不调用旧接口');
  }],
  ['分集网页优先、并发合并、短期复用', async () => {
    const { native, state } = fixture();
    const results = await Promise.all([native.fetchEpisodeList('1'), native.fetchEpisodeList('1')]);
    assert.equal(results[0].total, 2);
    await native.fetchEpisodeList('1');
    assert.equal(state.post, 0, '有效网页不应等待 API');
    assert.equal(state.waits, 0, '正常竞速不能因测试环境缺失而误入重试');
    assert.equal(state.get, 2, '同一分集竞速的两条路径各取一次，重复调用复用结果');
  }],
  ['分集竞速采用有效详情并取消慢播放页', async () => {
    const { native, state } = fixture({ stalledPlayer: true });
    const result = await native.fetchEpisodeList('1');
    assert.equal(result.total, 2);
    assert.equal(state.playerCancelled, true, '详情成功后应取消仍在等待的播放页');
    assert.equal(state.get, 2, '两条网页路径各请求一次');
    assert.equal(state.waits, 0, '成功竞速不进入退避');
  }],
  ['播放地址网页优先、并发合并、短期复用', async () => {
    const { native, state } = fixture();
    const results = await Promise.all([native.fetchPlayUrlSingle('11', '1'), native.fetchPlayUrlSingle('11', '1')]);
    assert.equal(results[0].source, 'web');
    await native.fetchPlayUrlSingle('11', '1');
    assert.equal(state.post, 0, '有效网页不应等待 API');
    assert.equal(state.get, 1, '相同播放地址只取一次');
  }],
  ['分集 60 秒、播放地址 30 秒到期刷新', async () => {
    const { native, state, advance } = fixture();
    await native.fetchEpisodeList('1');
    await native.fetchPlayUrlSingle('11', '1');
    advance(29999);
    await native.fetchEpisodeList('1');
    await native.fetchPlayUrlSingle('11', '1');
    assert.equal(state.get, 3, '未到期不重复访问');
    advance(2);
    await native.fetchPlayUrlSingle('11', '1');
    assert.equal(state.get, 4, '播放地址到期后刷新');
    advance(30000);
    await native.fetchEpisodeList('1');
    assert.equal(state.get, 6, '分集到期后重新竞速两条网页路径');
  }],
  ['空响应不重试，网页失败后仍重试两条路径', async () => {
    const { native, state } = fixture({ web: false });
    await assert.rejects(native.fetchEpisodeList('1'));
    assert.equal(state.get, 6, '网页失败后应各用可信/普通 DNS 重新竞速 player 与 detail');
    assert.equal((await native.fetchPlayUrlSingle('11', '1')).url, null);
    assert.equal(state.post, 2, '分集与播放地址空响应各只尝试一次');
    assert.equal(state.waits, 0, '空响应不进入退避');
    state.web = true;
    assert.equal((await native.fetchEpisodeList('1')).total, 2);
    assert.equal((await native.fetchPlayUrlSingle('11', '1')).source, 'web');
  }],
  ['网页失败仍可回退分集 API 和加密播放源', async () => {
    const { native, state } = fixture({ web: false, api: true });
    assert.equal((await native.fetchEpisodeList('1')).total, 1);
    const play = await native.fetchPlayUrlSingle('11', '1');
    assert.equal(play.source, 'api');
    assert.equal(play.spadeA, 'test-key');
    assert.ok(state.get > 0, '优先尝试网页源');
    assert.equal(state.post, 2);
  }],
  ['网页可用范围与后续集数错误，仍保留 API 回退', async () => {
    const { native, state } = fixture({
      html: page.replace('"vid_list"', '"accessible_episode_cnt":1,"vid_list"'),
      blockedVids: ['11', '12'],
    });
    const unavailable = await native.fetchPlayUrlSingle('12', '1');
    const list = await native.fetchEpisodeList('1');
    assert.equal(list.web_accessible_episodes, 1);
    assert.equal(list.episodes[0].web_available, true);
    assert.equal(list.episodes[1].web_available, false);
    assert.equal(unavailable.url, null);
    assert.equal(unavailable.code, 'SOURCE_UNAVAILABLE');
    assert.doesNotMatch(unavailable.error, /前 1 集.*第 2 集/);
    assert.doesNotMatch(unavailable.error, /付费|会员/);
    state.api = true;
    const restored = await native.fetchPlayUrlSingle('12', '1');
    assert.equal(restored.source, 'api');
    assert.equal(restored.spadeA, 'test-key');
  }],
];

(async () => {
  let failed = 0;
  const selected = process.argv.includes('--app') ? checks.filter(([name]) => name.startsWith('App ')) : process.argv.includes('--availability') ? checks.filter(([name]) => name.startsWith('网页可用范围')) : checks;
  for (const [name, run] of selected) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  console.log(`${selected.length - failed}/${selected.length} checks passed`);
  if (!failed && process.argv.includes('--live')) {
    const native = require(sourcePath);
    for (const [name, load] of [
      ['episodes', () => native.fetchEpisodeList('7687919221593885758')],
      ['play', () => native.fetchPlayUrlSingle('7687921187195735102', '7687919221593885758')],
    ]) {
      const start = performance.now();
      const result = await load();
      const firstMs = Math.round(performance.now() - start);
      const cachedStart = performance.now();
      await load();
      console.log(JSON.stringify({ name, source: result.source, total: result.total, hasUrl: !!result.url, firstMs, cachedMs: Math.round(performance.now() - cachedStart) }));
    }
  }
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
