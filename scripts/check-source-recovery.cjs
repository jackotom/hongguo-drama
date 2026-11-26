const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const nativeDir = path.join(__dirname, '../src/native');
const playbackDevice = Object.freeze({ device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '00000000-0000-4000-8000-000000000003' });
const media = name => `https://v3-reading.qznovelvod.com/${name}.mp4`;
function appRoute(config) {
  const url = new URL(config.url);
  if (url.pathname === '/service/2/device_register/') {
    assert.equal(config.method, 'POST');
    assert.equal(url.hostname, 'log5-applog-lf.fqnovel.com');
    return 'registration';
  }
  if (url.pathname === '/novel/player/multi_video_model/preload/v1') {
    assert.equal(config.method, 'POST');
    assert.equal(url.hostname, 'reading.snssdk.com');
    return 'model';
  }
  if (url.pathname === '/novel/player/multi_video_model/player/v1') {
    assert.equal(config.method, 'POST');
    assert.ok(['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-sinfonlinea.fqnovel.com'].includes(url.hostname));
    return 'model';
  }
  if (url.pathname === '/reading/bookapi/video_tab/multi_video_model/v1/') {
    assert.equal(config.method, 'GET');
    assert.equal(url.hostname, 'api5-normal-sinfonlineb.fqnovel.com');
    return 'videoTab';
  }
  if (url.pathname === '/novel/player/multi_video_model/v1/') {
    assert.equal(config.method, 'POST');
    assert.equal(url.hostname, 'api5-normal-sinfonlineb.fqnovel.com');
    return 'legacy';
  }
  assert.equal(config.url, 'https://vod.snssdk.com/info', 'unexpected fixture route');
  assert.equal(config.method || 'GET', 'GET');
  return 'metadata';
}
const webPage = (vid = '11', sid = '1', extra = {}) => `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
  'player_(series_id)/(vid)/page': { isSuccess: true, vid, series_id: sid, seriesDetail: { series_id: sid, vid_list: ['11'] },
    publicVideoSeo: { available: true, itemId: vid, seriesId: sid }, ...extra },
} })}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', url: `https://hongguoduanju.com/player/${sid}/${vid}`, contentUrl: media('web') })}</script>`;
function load(file, dependencies) {
  dependencies = {
    './playback-device': { registerPlaybackDevice: async () => playbackDevice },
    './openhongguo-source': {
      fetchEpisodeList: async () => { throw new Error('openhongguo unavailable'); },
      fetchPlayUrlSingle: async () => { throw new Error('openhongguo unavailable'); },
    },
    ...(file === 'hongguo.js' ? {
      './app-source': {
        fetchAppEpisodeList: async () => { throw Object.assign(new Error('app detail unavailable'), { code: 'EMPTY_RESPONSE' }); },
        fetchAppPlayUrl: async () => { throw new Error('app unavailable'); },
      },
    } : {}),
    ...dependencies,
  };
  const context = { Buffer, URL, URLSearchParams, AbortSignal, AbortController, process: { env: {} }, module: { exports: {} },
    console: { warn() {} },
    setTimeout: (fn, ms) => { if (ms === 600) { const timer = setTimeout(fn, 0); return { _timer: timer }; } return fn(); },
    clearTimeout: (timer) => clearTimeout(timer?._timer ?? timer),
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name.startsWith('.') ? path.join(nativeDir, name) : name) };
  vm.runInNewContext(fs.readFileSync(path.join(nativeDir, file), 'utf8'), context);
  return context.module.exports;
}
function encodedKey(hex) {
  const plain = Buffer.from(`0${hex}`), raw = Buffer.alloc(34), previous = [246, 85];
  for (let i = 0; i < plain.length; i++) {
    raw[i + 1] = ((plain[i] + 21 + (i.toString(2).split('1').length - 1)) & 255) ^ previous[i & 1];
    previous[i & 1] = raw[i + 1];
  }
  raw[0] = 48 ^ raw[1] ^ raw[2];
  return raw.toString('base64');
}
function appFixture(rows) {
  const calls = [];
  const app = load('app-source.js', { axios: async config => {
    calls.push(config);
    const route = appRoute(config);
    let data;
    if (route === 'videoTab') data = '';
    else if (route === 'registration') data = { device_id: playbackDevice.device_id, install_id: playbackDevice.iid };
    else if (route === 'model' || route === 'legacy') {
      for (const key of ['device_id', 'iid', 'cdid']) assert.equal(new URL(config.url).searchParams.get(key), playbackDevice[key]);
      data = { data: { '11': { video_model: { fallback_api: 'https://vod.snssdk.com/info' } } } };
    } else data = { video_info: { data: { video_list: rows } } };
    return { status: 200, headers: {}, data: typeof data === 'string' ? data : JSON.stringify(data) };
  } });
  return { ...app, calls };
}
function routeFixture() {
  const state = { web: true, app: false, openhongguo: false, calls: [], sdkPriority: null };
  const native = load('hongguo.js', {
    axios: {
      get: async url => { state.calls.push('web'); return { data: state.web && url.endsWith('/11') ? webPage() : '' }; },
      post: async () => { state.calls.push('api'); return { status: 200, headers: {}, data: Buffer.alloc(0) }; },
    },
    './app-source': { fetchAppPlayUrl: async (_vid, options) => {
      state.calls.push(options?.allowV8 === false ? 'sdk' : 'app');
      if (options?.allowV8 === false) state.sdkPriority = options.sdkPriority;
      if (!state.app) throw new Error('secret https://signed.invalid/?token=private');
      return { url: media('app'), source: 'app' };
    } },
    './openhongguo-source': { fetchPlayUrlSingle: async () => {
      state.calls.push('openhongguo');
      if (!state.openhongguo) throw new Error('unavailable');
      return { url: media('openhongguo'), source: 'openhongguo' };
    } },
  });
  return { ...native, state };
}
async function withSourceOrder(value, run) {
  const sourceOrder = require('../src/native/source-order');
  const previous = sourceOrder.getSourceOrder();
  sourceOrder.setSourceOrder(value);
  try { return await run(); } finally { sourceOrder.setSourceOrder(previous); }
}
const checks = [
  ['Missing explicit quality remains distinct from incompatible automatic sources without leaking raw messages', () => withSourceOrder(['app', 'sdk', 'web', 'openhongguo'], async () => {
    for (const quality of ['720p', '1080p']) {
      const app = appFixture({ low: { main_url: media('low'), codec_type: 'h264', width: 360, height: 640 } });
      const f = load('hongguo.js', { './app-source': app });
      const result = await f.fetchPlayUrlSingle('11', '1', { quality });
      assert.equal(result.sources[0].code, 'QUALITY_UNAVAILABLE');
      assert(result.error.includes(`满足 ${quality}`));
      assert(result.error.includes('未降级'));
    }
    const app = appFixture({ incompatible: { main_url: media('av1'), codec_type: 'av1', width: 1080, height: 1920 } });
    await assert.rejects(app.fetchAppPlayUrl('11'), error => error.code === 'NO_COMPATIBLE_SOURCE');
    for (const quality of ['720p', '1080p']) {
      const f = load('hongguo.js', { './app-source': app });
      const result = await f.fetchPlayUrlSingle('11', '1', { quality });
      assert.equal(result.sources[0].code, 'NO_COMPATIBLE_SOURCE', 'incompatible codecs must not be misreported as missing resolution');
    }
    for (const code of ['QUALITY_UNAVAILABLE', 'NO_COMPATIBLE_SOURCE']) {
      const f = load('hongguo.js', { './app-source': { fetchAppPlayUrl: async () => {
        throw Object.assign(new Error('secret https://signed.invalid/?token=private'), { code, quality: 'secret' });
      } } });
      const result = await f.fetchPlayUrlSingle('11', '1', { quality: '1080p' });
      assert.equal(result.sources[0].code, code);
      assert.doesNotMatch(JSON.stringify(result), /secret|signed\.invalid|private/);
    }
  })],
  ['Registration failures retain safe details and remain retryable only for transient causes', () => withSourceOrder(['app', 'sdk', 'web', 'openhongguo'], async () => {
    for (const [failure, expected, detail] of [
      [{ code: 'ECONNRESET' }, 'NETWORK_ERROR', '连接失败'],
      [{ code: 'ETIMEDOUT' }, 'TIMEOUT', '请求超时'],
      [{ status: 503 }, 'HTTP_503', 'HTTP 503'],
      [{ status: 403 }, 'HTTP_403', 'HTTP 403'],
      [{ code: 'EMPTY_RESPONSE' }, 'DEVICE_REGISTRATION_FAILED', '空响应'],
      [{ code: 'INVALID_RESPONSE' }, 'DEVICE_REGISTRATION_FAILED', '有效设备编号'],
      [{ code: 'BUSINESS_REJECTED' }, 'DEVICE_REGISTRATION_FAILED', '拒绝注册'],
      [{ code: 'SECURITY_BLOCKED' }, 'DEVICE_REGISTRATION_FAILED', '安全校验'],
      [{ code: 'secret' }, 'DEVICE_REGISTRATION_FAILED', '10 秒后重试'],
    ]) {
      const device = load('playback-device.js', {});
      const registerPlaybackDevice = async request => device.registerPlaybackDevice(async (...args) => {
        if (['EMPTY_RESPONSE', 'INVALID_RESPONSE', 'BUSINESS_REJECTED', 'SECURITY_BLOCKED'].includes(failure.code)) {
          throw Object.assign(new Error('secret'), failure);
        }
        return request(...args);
      });
      const routedApp = load('app-source.js', { './playback-device': { registerPlaybackDevice }, axios: async config => {
        assert.equal(appRoute(config), 'registration');
        if (failure.status) return { status: failure.status, headers: {}, data: 'secret' };
        throw Object.assign(new Error('secret https://signed.invalid/?token=private'), failure);
      } });
      const f = load('hongguo.js', { './app-source': routedApp });
      const result = await f.fetchPlayUrlSingle('11', '1', { quality: '720p' });
      assert.equal(result.sources[0].code, failure.code === 'secret' ? 'NETWORK_ERROR' : expected);
      assert.match(result.error, /匿名播放设备注册失败/);
      assert.ok(result.error.includes(detail));
      assert.doesNotMatch(JSON.stringify(result), /secret|signed\.invalid|private/);
    }
    for (const registrationFailure of ['secret', 'constructor', 'toString', '__proto__']) {
      const f = load('hongguo.js', { './app-source': { fetchAppPlayUrl: async () => {
        throw Object.assign(new Error('secret'), { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure });
      } } });
      const result = await f.fetchPlayUrlSingle('11', '1', { quality: '720p' });
      assert.equal(result.sources[0].message, '匿名播放设备注册失败；本机冷却 10 秒后可手动重试，上游何时恢复暂无法确认');
      assert.doesNotMatch(JSON.stringify(result), /secret|function|\[object/);
    }
  })],
  ['App network failures retain only safe codes and aggregate into distinct reasons', () => withSourceOrder(['app', 'sdk', 'web', 'openhongguo'], async () => {
    for (const [code, expected] of [['ECONNABORTED', 'TIMEOUT'], ['ETIMEDOUT', 'TIMEOUT'],
      ['ENOTFOUND', 'NETWORK_ERROR'], ['ECONNRESET', 'NETWORK_ERROR'], ['ERR_NETWORK', 'NETWORK_ERROR'],
      ['secret-token-code', 'NETWORK_ERROR']]) {
      const app = load('app-source.js', { axios: async config => {
        assert.ok(['videoTab', 'model', 'legacy'].includes(appRoute(config)));
        throw Object.assign(new Error('secret https://signed.invalid/?token=private'), { code, config: { secret: true } });
      } });
      await assert.rejects(app.fetchAppPlayUrl('11'), error => {
        assert.equal(error.code, code === 'secret-token-code' ? 'ERR_NETWORK' : code);
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret|signed\.invalid|private/);
        return true;
      });
      const f = load('hongguo.js', { './app-source': app });
      const result = await f.fetchPlayUrlSingle('11', '1', { quality: '720p' });
      assert.equal(result.sources[0].code, expected);
      assert.doesNotMatch(JSON.stringify(result), /secret|signed\.invalid|private/);
    }
  })],
  ['App distinguishes HTTP, business refusal, absent model, parsing and unsafe media', () => withSourceOrder(['app', 'sdk', 'web', 'openhongguo'], async () => {
    const first = { data: { '11': { video_model: { fallback_api: 'https://vod.snssdk.com/info' } } } };
    const cases = [
      [{ status: 403 }, null, 'HTTP_403'],
      [{ data: { code: 8, message: 'secret' } }, null, 'BUSINESS_REJECTED'],
      [{ data: { data: {} } }, null, 'MISSING_MODEL'],
      [{ data: 'not json secret' }, null, 'INVALID_RESPONSE'],
      [{ data: { data: { '11': { video_model: 'not json secret' } } } }, null, 'INVALID_RESPONSE'],
      [{ data: first }, { code: 8, message: 'secret' }, 'BUSINESS_REJECTED'],
      [{ data: first }, { video_info: { data: { video_list: { one: { codec_type: 'h264', width: 720, height: 1280, main_url: 'https://127.0.0.1/private' } } } } }, 'SECURITY_BLOCKED'],
    ];
    for (const [response, second, expected] of cases) {
      const stages = [];
      const app = load('app-source.js', { axios: async config => {
        const route = appRoute(config);
        stages.push(route);
        assert.notEqual(route, 'registration', 'registration is isolated from model failures');
        const result = { status: 200, headers: {},
          ...(route === 'videoTab' ? { data: '' } : route === 'model' || route === 'legacy' ? response : { data: second }) };
        if (typeof result.data !== 'string') result.data = JSON.stringify(result.data);
        return result;
      } });
      const f = load('hongguo.js', { './app-source': app });
      const result = await f.fetchPlayUrlSingle('11', '1', { quality: '720p' });
      assert.equal(result.sources[0].code, expected);
      assert.doesNotMatch(JSON.stringify(result), /secret|127\.0\.0\.1|private/);
      assert.deepEqual(stages.filter(stage => stage !== 'videoTab'),
        second === null ? ['model'] : ['model', 'metadata'], 'explicit failures must not start another model route');
    }
  })],
  ['Web keeps null compatibility but reports actual failures on first and final fallback', async () => {
    for (const [failure, expected] of [
      [Object.assign(new Error('secret URL'), { response: { status: 404 } }), 'HTTP_404'],
      [Object.assign(new Error('secret URL'), { code: 'ETIMEDOUT' }), 'TIMEOUT'],
      [Object.assign(new Error('secret URL'), { code: 'ERR_WEB_MEDIA_ADDRESS' }), 'SECURITY_BLOCKED'],
      [webPage().replace(media('web'), 'https://127.0.0.1/private'), 'SECURITY_BLOCKED'],
      ['', 'MISSING_MODEL'],
    ]) {
      const f = load('hongguo.js', {
        axios: { get: async () => { if (typeof failure !== 'string') throw failure; return { data: failure }; },
          post: async () => ({ status: 200, headers: {}, data: Buffer.alloc(0) }) },
        './app-source': { fetchAppPlayUrl: async () => { throw new Error('unavailable'); } },
      });
      assert.equal(await f.fetchPlayUrlFromWeb('11', '1'), null);
      for (const skipWeb of [false, true]) {
        if (skipWeb) f.markWebMediaFailure({ source: 'web', vid: '11' });
        const result = await f.fetchPlayUrlSingle('11', '1', { force: true });
        assert.equal(result.sources.find(item => item.source === 'web').code, expected);
        assert.doesNotMatch(JSON.stringify(result), /secret|127\.0\.0\.1|private/);
      }
    }
  }],
  ['Playback route budgets reach App after Web timeout and bound legacy API to one attempt', async () => {
    const webTimeouts = [], apiTimeouts = [];
    let appAvailable = true, webAvailable = false;
    const f = load('hongguo.js', {
      axios: {
        get: async (_url, options) => {
          webTimeouts.push(options.timeout);
          if (webAvailable) return { data: webPage() };
          throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        },
        post: async (_url, _body, options) => {
          apiTimeouts.push(options.timeout);
          throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        },
      },
      './app-source': { fetchAppPlayUrl: async () => {
        if (!appAvailable) throw new Error('App 片源请求超时');
        return { url: media('app'), source: 'app' };
      } },
    });
    assert.equal((await f.fetchPlayUrlSingle('11', '1')).source, 'app');
    assert.deepEqual(webTimeouts, [], 'App-first lookup must not spend the Web timeout budget');
    assert.deepEqual(apiTimeouts, []);
    appAvailable = false; webTimeouts.length = 0;
    assert.equal((await f.fetchPlayUrlSingle('11', '1', { force: true })).code, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(webTimeouts, [4000, 4000]);
    assert.deepEqual(apiTimeouts, [6000], 'legacy playback lookup must not repeat after timeout');
    webAvailable = true; webTimeouts.length = 0;
    assert.equal((await f.fetchEpisodeListFromWeb('1')).series_id, '1');
    assert.deepEqual(webTimeouts, [1500, 1500], 'episode page first race bounds each web route');
  }],
  ['Web rejects wrong or missing current episode identity even when vid_list contains the request', async () => {
    for (const data of [
      { vid: '10', seriesDetail: { series_id: '1', vid_list: ['10', '11'] } },
      { seriesDetail: { series_id: '1', vid_list: ['11'] } },
      { vid: '11', seriesDetail: { series_id: '2', vid_list: ['11'] } },
      { vid: '11' },
    ]) {
      const html = `window._ROUTER_DATA=${JSON.stringify({ loaderData: { player: data }, recommendation: { main_url: media('wrong') } })}`;
      const f = load('hongguo.js', { axios: { get: async () => ({ data: html }) } });
      assert.equal(await f.fetchPlayUrlFromWeb('11', '1'), null, 'unverified webpage must not be labelled as the requested episode');
    }
  }],
  ['Episode list retries both web routes, then retries a transient network failure', async () => {
    const webCalls = [], apiCalls = [], sid = '918273645';
    const f = load('hongguo.js', {
      axios: {
        get: async url => {
          webCalls.push(url);
          throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
        },
        post: async () => {
          apiCalls.push(1);
          if (apiCalls.length < 3) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
          return { status: 200, headers: {}, data: Buffer.from(JSON.stringify({ code: 0, data: {
            [sid]: { video_data: { series_title: '重试成功', video_list: [
              { vid: '101', vid_index: 1 }, { vid: '102', vid_index: 2 },
            ] } },
          } })) };
        },
      },
    });
    const data = await f.fetchEpisodeList(sid);
    assert.equal(data.total, 2);
    assert.equal(apiCalls.length, 3, 'transient network failures must still be retried');
    assert.equal(webCalls.filter(url => url.includes(`/player/${sid}`)).length, 3, 'the retry must try the player route with both resolvers');
    assert.equal(webCalls.filter(url => url.includes(`series_id=${sid}`)).length, 3, 'the retry must try the detail route with both resolvers');
  }],
  ['Episode list turns repeated aborts and empty responses into one readable failure', async () => {
    let apiCalls = 0;
    const f = load('hongguo.js', {
      './openhongguo-source': {
        fetchEpisodeList: async () => { throw Object.assign(new Error('secret https://signed.invalid aborted'), { code: 'ERR_CANCELED' }); },
        fetchPlayUrlSingle: async () => { throw new Error('openhongguo unavailable'); },
      },
      axios: {
        get: async () => { throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' }); },
        post: async () => { apiCalls++; return { status: 200, headers: {}, data: Buffer.alloc(0) }; },
      },
    });
    await assert.rejects(f.fetchEpisodeList('918273646'), error => {
      assert.match(error.message, /加载超时或连接中断/);
      assert.match(error.message, /0 字节/);
      assert.doesNotMatch(error.message, /aborted|secret|signed\.invalid/);
      return true;
    });
    assert.equal(apiCalls, 1, 'empty 200 responses must stop without retrying');
  }],
  ['Episode list prefers openhongguo full batch, rejects incomplete web preview and bounds SDK timeout', async () => {
    const sid = '918273647';
    let sdkCalls = 0, webCalls = 0, apiCalls = 0;
    const sdkFirst = load('hongguo.js', {
      './openhongguo-source': {
        fetchEpisodeList: async (id, opts) => {
          sdkCalls++;
          assert.equal(id, sid);
          assert.ok(opts?.signal instanceof AbortSignal, 'openhongguo list must receive a bounded abort signal');
          return { series_id: sid, series_title: '完整剧', total: 6, episodes: Array.from({ length: 6 }, (_, i) => ({ vid: String(100 + i), vid_index: i + 1 })), source: 'openhongguo' };
        },
        fetchPlayUrlSingle: async () => { throw new Error('openhongguo unavailable'); },
      },
      axios: {
        get: async () => { webCalls++; return { data: '' }; },
        post: async () => { apiCalls++; return { status: 200, headers: {}, data: Buffer.alloc(0) }; },
      },
    });
    const full = await sdkFirst.fetchEpisodeList(sid);
    assert.equal(full.source, 'openhongguo');
    assert.equal(full.total, 6);
    assert.equal(sdkCalls, 1);
    assert.equal(webCalls, 0);
    assert.equal(apiCalls, 0);

    const previewHtml = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
      'player_(series_id)/page': { isSuccess: true, series_id: sid, seriesDetail: {
        series_id: sid, series_name: '预览剧', episode_cnt: 71, accessible_episode_cnt: 3, vid_list: ['101', '102', '103'],
      } },
    } })}</script>`;
    let detailCalls = 0;
    const previewFallback = load('hongguo.js', {
      axios: {
        get: async () => ({ data: previewHtml }),
        post: async () => {
          detailCalls++;
          return { status: 200, headers: {}, data: Buffer.from(JSON.stringify({ code: 0, data: {
            [sid]: { video_data: { series_title: '完整回退', video_list: Array.from({ length: 71 }, (_, i) => ({ vid: String(200 + i), vid_index: i + 1 })) } },
          } })) };
        },
      },
    });
    const parsedPreview = await previewFallback.fetchEpisodeListFromWeb(sid);
    assert.equal(parsedPreview.episode_count, 71);
    assert.equal(parsedPreview.complete, false);
    const recovered = await previewFallback.fetchEpisodeList(sid);
    assert.equal(recovered.total, 71);
    assert.equal(detailCalls, 1, 'incomplete web preview must not be accepted as a full series');

    let timedOutSignal = false, webBudgetOk = false;
    const deadline = Date.now() + 300;
    const bounded = load('hongguo.js', {
      './openhongguo-source': {
        fetchEpisodeList: async (_id, opts) => new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => { timedOutSignal = true; reject(new Error('aborted')); }, { once: true });
        }),
        fetchPlayUrlSingle: async () => { throw new Error('openhongguo unavailable'); },
      },
      axios: {
        get: async () => {
          webBudgetOk = deadline - Date.now() > 0;
          return { data: `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
            'player_(series_id)/page': { isSuccess: true, series_id: sid, seriesDetail: {
              series_id: sid, series_name: '完整网页剧', episode_cnt: 2, vid_list: ['301', '302'],
            } },
          } })}</script>` };
        },
        post: async () => ({ status: 200, headers: {}, data: Buffer.alloc(0) }),
      },
    });
    const keepAlive = setInterval(() => {}, 50);
    try {
      const fromWeb = await bounded.fetchEpisodeList(sid, { deadline, force: true });
      assert.equal(timedOutSignal, true, 'stalled openhongguo list must abort before outer deadline');
      assert.equal(webBudgetOk, true, 'web fallback must retain positive remaining deadline');
      assert.equal(fromWeb.total, 2);
    } finally { clearInterval(keepAlive); }
  }],
  ['Episode list falls back to signed App video_detail/v1 preserving 64-bit series_id and full numeric vids', async () => {
    const sid = '7706908220253555737';
    let detailCalled = 0, webCalled = 0;
    const app = load('app-source.js', {
      axios: async config => {
        detailCalled++;
        const url = new URL(config.url);
        assert.equal(url.pathname, '/novel/player/video_detail/v1/');
        assert.equal(config.method, 'POST');
        assert.ok(config.headers['x-medusa'] && config.headers['x-helios'] && config.headers['x-khronos']);
        const raw = `{"code":0,"data":{"video_data":{"series_id":${sid},"series_title":"完整真剧","series_cover":"https://img.example/c.jpg","series_intro":"简介","episode_cnt":3,"content_type":1001,"video_list":[{"vid":7706910230088518718,"vid_index":1,"title":"第1集"},{"vid":7706910230088518719,"vid_index":2,"title":"第2集"},{"vid":7706910230088518720,"vid_index":3,"title":"第3集","disable_play":true}]}}}`;
        return { status: 200, headers: {}, data: raw };
      },
    });
    const f = load('hongguo.js', {
      './app-source': app,
      axios: { get: async () => { webCalled++; return { data: '' }; }, post: async () => ({ status: 200, headers: {}, data: Buffer.alloc(0) }) },
    });
    const result = await f.fetchEpisodeList(sid);
    assert.equal(detailCalled, 1);
    assert.equal(webCalled, 0);
    assert.equal(result.source, 'app');
    assert.equal(result.series_id, sid);
    assert.equal(result.content_type, '1001');
    assert.equal(result.total, 3);
    assert.deepEqual(Array.from(result.episodes, e => e.vid), ['7706910230088518718', '7706910230088518719', '7706910230088518720']);
    assert.deepEqual(Array.from(result.episodes, e => e.locked), [false, false, true]);
  }],
  ['Web public fallback maps numeric vid to v1_ token via cached episode index when numeric fallback is unavailable', async () => {
    const sid = '7690112243203050521', vid1 = '7690125606729550872', vid3 = '7690125616825256984';
    const token1 = 'v1_invniDx7dcZhofRa2PNnTxWThlE', token3 = 'v1_BkUI5CKWjPF9YEPfGC637Xc5xsg';
    const playerHtml = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
      'player_(series_id)/page': { isSuccess: true, series_id: sid, seriesDetail: {
        series_id: sid, series_name: '测试剧', episode_cnt: 100, vid_list: [token1, 'v1_FjeBprkuoqDaLWspFe7ylPPWIJw', token3],
      } },
    } })}</script>`;
    const fallbackCalls = [];
    let htmlCalls = 0;
    const axiosMock = Object.assign(async config => {
      if (config.url.includes('/fallback-play-info')) {
        fallbackCalls.push(config.data?.item_id);
        if (config.data?.item_id === token1) return { status: 200, data: { main_url: media('web-v1-ep1'), url_expire: Math.floor(Date.now() / 1000) + 3600 } };
        if (config.data?.item_id === token3) return { status: 200, data: { main_url: media('web-v1-ep3'), url_expire: Math.floor(Date.now() / 1000) + 3600 } };
        return { status: 400, data: { error: 'public_fallback_unavailable' } };
      }
      throw new Error('unexpected axios call');
    }, {
      get: async url => {
        if (url === `https://hongguoduanju.com/player/${sid}`) { htmlCalls++; return { data: playerHtml }; }
        return { data: '' };
      },
      post: async () => ({ status: 200, headers: {}, data: Buffer.alloc(0) }),
    });
    const f = load('hongguo.js', {
      axios: axiosMock,
      './openhongguo-source': {
        fetchEpisodeList: async () => ({
          series_id: sid, series_title: '测试剧', total: 3, source: 'openhongguo',
          episodes: [
            { vid: vid1, vid_index: 1 },
            { vid: '7690125606729550873', vid_index: 2 },
            { vid: vid3, vid_index: 3 },
          ],
        }),
        fetchPlayUrlSingle: async () => { throw new Error('unavailable'); },
      },
    });
    await f.fetchEpisodeList(sid);
    const r1 = await f.fetchPlayUrlFromWeb(vid1, sid);
    const r3 = await f.fetchPlayUrlFromWeb(vid3, sid);
    assert.equal(r1?.url, media('web-v1-ep1'));
    assert.equal(r1?.vid, vid1);
    assert.equal(r3?.url, media('web-v1-ep3'));
    assert.equal(r3?.vid, vid3);
    assert.equal(htmlCalls, 1, 'player page token list must be cached across episodes');
    assert.deepEqual(fallbackCalls, [vid1, token1, vid3, token3]);
  }],
  ['Protected website SEO preview never replaces the complete App episode', () => withSourceOrder(['app', 'sdk', 'web', 'openhongguo'], async () => {
    const calls = [];
    let protectedPlayback = true, appAvailable = true;
    const f = load('hongguo.js', {
      axios: {
        get: async () => { calls.push('web'); return { data: webPage('11', '1', { protectedPlayback,
          publicVideoSeo: { available: true, itemId: '11', seriesId: '1', durationSeconds: 166.488 } }) }; },
        post: async () => { calls.push('api'); return { status: 200, headers: {}, data: Buffer.alloc(0) }; },
      },
      './app-source': { fetchAppPlayUrl: async (_vid, options) => {
        calls.push(options?.allowV8 === false ? 'sdk' : 'app');
        if (!appAvailable) throw new Error('unavailable');
        return { url: media('complete'), source: 'app' };
      } },
    });
    const result = await f.fetchPlayUrlSingle('11', '1');
    assert.equal(result.source, 'app', 'SEO duration describes the episode, not the public preview file');
    assert.deepEqual(calls, ['app'], 'known preview must not preempt the complete App episode');
    appAvailable = false; calls.length = 0;
    const unavailable = await f.fetchPlayUrlSingle('11', '1', { force: true });
    assert.equal(unavailable.code, 'SOURCE_UNAVAILABLE');
    assert.equal(unavailable.sources.find(item => item.source === 'web').code, 'PREVIEW_ONLY');
    f.markWebMediaFailure({ source: 'web', vid: '11' }); calls.length = 0;
    assert.equal((await f.fetchPlayUrlSingle('11', '1', { force: true })).code, 'SOURCE_UNAVAILABLE',
      'final web recovery must not reintroduce the preview');
    protectedPlayback = false;
    assert.equal((await f.fetchPlayUrlSingle('11', '1', { force: true })).source, 'web', 'complete public web remains a valid recovery');
    appAvailable = true; calls.length = 0;
    assert.equal((await f.fetchPlayUrlSingle('11', '1', { quality: '1080p' })).source, 'app');
    assert.deepEqual(calls, ['app'], 'explicit quality remains App-only');
  })],
  ['Web accepts only an identity-bound VideoObject and ignores earlier recommended media', async () => {
    const unrelated = `<script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', url: 'https://hongguoduanju.com/player/2/22', contentUrl: media('recommendation') })}</script>`;
    let html = unrelated + webPage();
    const f = load('hongguo.js', { axios: { get: async () => ({ data: html }) } });
    assert.equal((await f.fetchPlayUrlFromWeb('11', '1')).url, media('web'));
    for (const bad of [webPage('10'), webPage('11', '2'), webPage('11', '1', { vid: undefined }),
      webPage('11', '1', { publicVideoSeo: { available: true, itemId: '10', seriesId: '1' } }),
      webPage().replace('/player/1/11', '/player/1/10'), webPage().replace('https://hongguoduanju.com/player/', 'https://other.invalid/player/')]) {
      html = bad; assert.equal(await f.fetchPlayUrlFromWeb('11', '1'), null);
    }
  }],
  ['Web accepts the current series canonical URL only with episode-bound official media', async () => {
    const url = 'https://hongguoduanju.com/video/public/11/360p.mp4';
    const page = webPage().replace('/player/1/11', '/player/1').replace(media('web'), url);
    let html = page;
    const f = load('hongguo.js', { axios: { get: async () => ({ data: html }) } });
    assert.equal((await f.fetchPlayUrlFromWeb('11', '1'))?.url, url);
    assert.equal((await f.fetchPlayUrlFromWeb('11'))?.url, url);
    for (const bad of [
      page.replace('/public/11/', '/public/12/'),
      page.replace(url, media('recommended')),
      page.replace('/player/1', '/player/2'),
      page.replace('"itemId":"11"', '"itemId":"12"'),
      page.replace('"available":true', '"available":false'),
      page.replace('"isSuccess":true', '"isSuccess":false'),
      page.replace('"@type":"VideoObject"', '"@type":"VideoObject","@id":"https://hongguoduanju.com/player/2#video"'),
    ]) {
      html = bad; assert.equal(await f.fetchPlayUrlFromWeb('11', '1'), null);
    }
    html = page.replace('"@type":"VideoObject"', '"@type":"VideoObject","@id":"https://hongguoduanju.com/player/1#video"');
    assert.equal((await f.fetchPlayUrlFromWeb('11', '1'))?.url, url);
    html = page.replace('/public/11/', '/public/12/') + page;
    assert.equal((await f.fetchPlayUrlFromWeb('11', '1'))?.url, url, 'skip earlier recommendation from the same series');
  }],
  ['Media 403 switches App/API Referer once and preserves ranges, cancellation and other sources', async () => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ path: request.url, referer: request.headers.referer, range: request.headers.range, ua: request.headers['user-agent'] });
      const accepted = request.url === '/needs-referer' ? !!request.headers.referer : !request.headers.referer;
      if (!accepted || request.url === '/denied') { response.writeHead(403); response.end(); return; }
      response.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 2-4/10' }); response.end('234');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
      const context = vm.createContext({ URL, axios: require('axios'), hongguo: { UA: 'test', WEB_UA: 'browser', VIDEO_REFERER: 'https://novelquickapp.com/', WEB_REFERER: 'https://hongguoduanju.com/' },
        checkCustomAccess() {}, require: () => ({ webMediaRequestOptions: () => ({}) }) });
      vm.runInContext(main.slice(main.indexOf('async function requestMedia('), main.indexOf('function awaitMediaOperation(')), context);
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const source of ['app', 'api']) {
        const before = requests.length;
        const result = await context.requestMedia({ url: base + '/no-referer', source, userAgent: 'app-agent', referer: 'https://novelquickapp.com/' }, { headers: { Range: 'bytes=2-4' } });
        let body = ''; for await (const chunk of result.data) body += chunk;
        assert.equal(body, '234'); assert.equal(requests.length - before, 2);
        assert.equal(requests.at(-1).referer, undefined);
        assert.equal(requests.at(-1).ua, 'app-agent'); assert.equal(requests.at(-1).range, 'bytes=2-4');
      }
      const added = await context.requestMedia({ url: base + '/needs-referer', source: 'app' }, { headers: { Range: 'bytes=2-4' } });
      added.data.destroy(); assert.equal(requests.at(-1).referer, 'https://novelquickapp.com/');
      for (const source of ['web', 'custom']) {
        const before = requests.length;
        await assert.rejects(context.requestMedia({ url: base + '/no-referer', source, referer: 'https://provider.example/' }));
        assert.ok(requests.slice(before).every(request => request.referer === 'https://provider.example/'));
      }
      const before = requests.length;
      await assert.rejects(context.requestMedia({ url: base + '/denied', source: 'app' }));
      assert.equal(requests.length - before, 2, 'persistent 403 remains bounded');
      const controller = new AbortController(); controller.abort();
      await assert.rejects(context.requestMedia({ url: base + '/denied', source: 'app' }, { signal: controller.signal }));
      assert.equal(requests.length - before, 2, 'cancelled requests must not retry');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }],
  ['App preserves safe alternates and binds keys and request identity to each candidate', async () => {
    const key1 = '01'.repeat(16), key2 = '02'.repeat(16);
    const f = appFixture({ first: { main_url: media('main'), backup_url: media('backup'), backup_url_list: [media('extra'), media('backup'), 'https://127.0.0.1/private'], codec_type: 'h264', width: 1080, height: 1920, spade_a: encodedKey(key1) },
      second: { main_url: media('hevc'), codec_type: 'hevc', width: 1080, height: 1920, spade_a: encodedKey(key2) },
      listOnly: { backup_url_list: [media('list')], codec_type: 'hevc', width: 1080, height: 1920 } });
    const result = await f.fetchAppPlayUrl('11');
    assert.ok(Array.isArray(result.variants), 'media candidates must survive address lookup');
    assert.deepEqual(Array.from(result.variants, v => v.url), ['main', 'backup', 'extra', 'hevc', 'list'].map(media));
    const metadataCall = f.calls.findLast(call => ['model', 'metadata', 'legacy'].includes(appRoute(call)));
    for (const candidate of result.variants) {
      assert.equal(candidate.source, 'app'); assert.equal(candidate.vid, '11');
      assert.equal(candidate.userAgent, metadataCall.headers['User-Agent']);
      assert.equal(candidate.referer, undefined, 'App media must not start with the rejected website Referer');
      assert.equal(candidate.variants, undefined);
    }
    assert.equal(result.variants[2].contentKey, key1); assert.equal(result.variants[3].contentKey, key2);
    assert.equal(result.variants[4].contentKey, null);
    assert.deepEqual(f.calls.map(appRoute).filter(route => route !== 'videoTab'), ['model', 'metadata'], 'no media preflight');
  }],
  ['Strict quality alternatives never include smaller or unknown-size streams', async () => {
    const f = appFixture({ low: { main_url: media('low'), codec_type: 'h264', width: 720, height: 1280 },
      unknown: { main_url: media('unknown'), codec_type: 'h264' },
      high: { main_url: media('high'), backup_url_list: [media('high2')], codec_type: 'hevc', width: 1080, height: 1920 } });
    const result = await f.fetchAppPlayUrl('11', { quality: '1080p' });
    assert.ok(result.variants, 'strict-quality candidate list missing');
    assert.deepEqual(Array.from(result.variants, v => v.url), ['high', 'high2'].map(media));
    assert.ok(result.variants.every(v => v.width === 1080 && v.quality === '1080p'));
  }],
  ['Recent web failure prefers App but allows fresh web as final recovery', async () => {
    const f = routeFixture(), first = await f.fetchPlayUrlSingle('11', '1');
    f.markWebMediaFailure(first); f.state.calls.length = 0;
    const recovered = await f.fetchPlayUrlSingle('11', '1', { force: true });
    assert.equal(recovered.source, 'web', 'five-minute penalty must not hide the only working source');
    assert.deepEqual(f.state.calls, ['openhongguo', 'sdk', 'app', 'api', 'web']);
    f.state.app = true; f.state.calls.length = 0;
    assert.equal((await f.fetchPlayUrlSingle('11', '1', { force: true })).source, 'app');
    assert.deepEqual(f.state.calls.slice(0, 2), ['openhongguo', 'sdk'], 'the new default is attempted before App');
    assert.ok(!f.state.calls.includes('web'), 'web penalty remains after last-resort recovery');
  }],
  ['Unavailable source reports safe per-route reasons without declaring web metadata a global block', async () => {
    const f = routeFixture(); f.state.web = false;
    const unavailable = await f.fetchPlayUrlSingle('11', '1');
    assert.equal(unavailable.code, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(Array.from(unavailable.sources, item => item.source), ['openhongguo', 'sdk', 'app', 'api', 'web']);
    assert.doesNotMatch(JSON.stringify(unavailable), /secret|signed\.invalid|private|前.*集|付费|会员/);
    assert.ok(unavailable.sources.every(item => item.code && item.message));
    f.state.app = true;
    assert.equal((await f.fetchPlayUrlSingle('11', '1')).source, 'app', 'failures must not be cached');
  }],
  ['User source priority controls App, SDK and web dispatch order', async () => {
    const sourceOrder = require('../src/native/source-order');
    try {
      sourceOrder.setSourceOrder(['sdk', 'web', 'app']);
      const f = routeFixture();
      assert.equal((await f.fetchPlayUrlSingle('11', '1', { sdkPriority: true })).source, 'web');
      assert.deepEqual(f.state.calls, ['sdk', 'web']);
      assert.equal(f.state.sdkPriority, true);

      sourceOrder.setSourceOrder(['web', 'app', 'sdk']);
      const webFirst = routeFixture();
      assert.equal((await webFirst.fetchPlayUrlSingle('11', '1')).source, 'web');
      assert.deepEqual(webFirst.state.calls, ['web']);
    } finally {
      sourceOrder.setSourceOrder(['app', 'sdk', 'web']);
    }
  }],
  ['Explicit quality moves the lower-quality web provider behind HD-capable providers', async () => {
    const sourceOrder = require('../src/native/source-order');
    try {
      sourceOrder.setSourceOrder(['web', 'app', 'sdk', 'openhongguo']);
      const f = routeFixture();
      assert.equal((await f.fetchPlayUrlSingle('11', '1', { quality: '1080p', allowLowerQuality: true })).source, 'web');
      assert.deepEqual(f.state.calls, ['app', 'api', 'sdk', 'openhongguo', 'web']);
    } finally {
      sourceOrder.setSourceOrder(['openhongguo', 'sdk', 'app', 'web']);
    }
  }],
];
(async () => {
  let failed = 0;
  for (const [name, run] of checks) { try { await run(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); } }
  console.log(`${checks.length - failed}/${checks.length} source recovery checks passed`);
  process.exitCode = failed ? 1 : 0;
})();
