const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nativeDir = path.join(__dirname, '../src/native');
const playbackDevice = Object.freeze({ device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '00000000-0000-4000-8000-000000000003' });
const mediaUrl = name => `https://v3-reading.qznovelvod.com/${name}.mp4`;
const stream = (name, width, height, codec_type = 'h264') => ({ main_url: mediaUrl(name), width, height, codec_type, definition: '1080p' });
function load(name, dependencies) {
  dependencies = { './playback-device': { getPlaybackDevice: async () => playbackDevice }, ...dependencies };
  const context = { Buffer, URL, URLSearchParams, AbortSignal, process: { env: {} }, module: { exports: {} },
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name.startsWith('.') ? path.join(nativeDir, name) : name) };
  vm.runInNewContext(fs.readFileSync(path.join(nativeDir, name), 'utf8'), context);
  return context.module.exports;
}
function appFixture(videoList) {
  const calls = [];
  const app = load('app-source.js', { axios: async config => {
    calls.push(config);
    return { status: 200, headers: {}, data: JSON.stringify(config.method === 'POST'
      ? { data: { '11': { video_model: { fallback_api: 'https://vod.snssdk.com/info' } } } }
      : { video_info: { data: { video_list: videoList } } }) };
  } });
  return { ...app, calls };
}
function routeFixture(appError = false) {
  const calls = [];
  const native = load('hongguo.js', {
    axios: { get: async () => { calls.push('web'); return { data: `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
      'player_(series_id)/(vid)/page': { vid: '11', series_id: '1', seriesDetail: { series_id: '1' }, publicVideoSeo: { available: true, itemId: '11', seriesId: '1' } },
    } })}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', url: 'https://hongguoduanju.com/player/1/11', contentUrl: mediaUrl('web') })}</script>` }; } },
    './app-source': { fetchAppPlayUrl: async (_vid, options) => {
      calls.push(options.allowLowerQuality ? options.quality + ':fallback' : options.quality);
      if (appError) throw new Error('没有符合所选清晰度的片源');
      return { url: mediaUrl(`${options.quality}-${calls.length}`), quality: options.quality };
    } },
    './hema': { fetchPlayUrlSingle: async () => { calls.push('hema'); return { url: mediaUrl('hema') }; } },
    './xifan': { fetchPlayUrlSingle: async () => { calls.push('xifan'); return { url: mediaUrl('xifan') }; } },
  });
  return { ...native, calls };
}
const checks = [
  ['download fallback keeps all lower tiers in descending order without changing strict playback', async () => {
    const f = appFixture({ low: stream('360', 360, 640), mid: stream('720', 720, 1280), high: stream('1080', 1080, 1920), sd: stream('480', 480, 854) });
    const result = await f.fetchAppPlayUrl('11', { quality:'1080p', allowLowerQuality:true });
    assert.deepEqual(Array.from(result.variants, item => item.url), ['1080','720','480','360'].map(mediaUrl));
    assert.equal(result.variants[1].quality, '720p');
    const onlyLow = await appFixture({ low:stream('480',480,854) }).fetchAppPlayUrl('11',{quality:'1080p',allowLowerQuality:true});
    assert.equal(onlyLow.quality,'480p');
    await assert.rejects(f.fetchAppPlayUrl('11',{quality:'4k',allowLowerQuality:true}), /清晰度/);
  }],
  ['download fallback cache never leaks lower variants into strict playback', async () => {
    const f = routeFixture();
    const strict = await f.fetchPlayUrlSingle('11','1',{quality:'1080p'});
    const fallback = await f.fetchPlayUrlSingle('11','1',{quality:'1080p',allowLowerQuality:true});
    assert.notEqual(fallback.url,strict.url);
    assert.equal((await f.fetchPlayUrlSingle('11','1',{quality:'1080p'})).url,strict.url);
    assert.deepEqual(f.calls,['1080p','1080p:fallback']);
  }],
  ['1080 rejects a fake label with only 720 pixels', async () => {
    await assert.rejects(appFixture({ fake: stream('fake', 720, 1280) }).fetchAppPlayUrl('11', { quality: '1080p' }), /1080p/);
  }],
  ['1080 chooses real dimensions before codec and returns measured metadata', async () => {
    const result = await appFixture({ fake: stream('fake', 720, 1280), true: stream('true', 1080, 1920, 'hevc') }).fetchAppPlayUrl('11', { quality: '1080p' });
    assert.equal(result.url, mediaUrl('true'));
    assert.equal(result.width, 1080); assert.equal(result.height, 1920); assert.equal(result.quality, '1080p');
  }],
  ['720 chooses smallest adequate tier and H264 within that tier', async () => {
    const result = await appFixture({ high: stream('high', 1080, 1920), hevc: stream('hevc', 720, 1280, 'hevc'), avc: { main_url: mediaUrl('avc'), video_meta: { codec_type: 'h264', vwidth: 720, vheight: 1280 } } }).fetchAppPlayUrl('11', { quality: '720p' });
    assert.equal(result.url, mediaUrl('avc'));
    const higher = await appFixture({ high: stream('high', 1440, 2560) }).fetchAppPlayUrl('11', { quality: '1080p' });
    assert.equal(higher.url, mediaUrl('high'));
  }],
  ['explicit tiers reject absent, unknown-size and unsupported streams', async () => {
    for (const [rows, code] of [
      [{}, 'NO_COMPATIBLE_SOURCE'],
      [{ unknown: stream('unknown', 0, 0) }, 'QUALITY_UNAVAILABLE'],
      [{ unsupported: stream('bad', 1080, 1920, 'bytevc2') }, 'NO_COMPATIBLE_SOURCE'],
    ]) {
      await assert.rejects(appFixture(rows).fetchAppPlayUrl('11', { quality: '1080p' }), { code });
    }
  }],
  ['auto preserves H264 priority and accepts legacy missing dimensions', async () => {
    const rows = { high: stream('high', 1080, 1920, 'hevc'), low: { main_url: mediaUrl('low'), codec_type: 'h264', quality_desc: '720P' } };
    for (const options of [undefined, { quality: 'auto' }]) {
      const result = await appFixture(rows).fetchAppPlayUrl('11', options);
      assert.equal(result.url, mediaUrl('low')); assert.equal(result.quality, '720P');
    }
  }],
  ['auto uses actual dimensions when labels are missing or overstate quality', async () => {
    for (const label of ['1080p', '']) {
      const result = await appFixture({
        low: { ...stream('low', 360, 640), definition: label },
        high: { ...stream('high', 1920, 1080), definition: '720p' },
      }).fetchAppPlayUrl('11');
      assert.equal(result.url, mediaUrl('high'));
      assert.deepEqual(Array.from(result.variants, item => item.url), [mediaUrl('high')], 'auto recovery must stay within the best tier');
    }
    const nested = await appFixture({
      low: { main_url: mediaUrl('low'), video_meta: { codec_type: 'h264', vwidth: 360, vheight: 640 } },
      high: { main_url: mediaUrl('high'), video_meta: { codec_type: 'h264', vwidth: 1080, vheight: 1920 } },
    }).fetchAppPlayUrl('11');
    assert.equal(nested.url, mediaUrl('high'));
  }],
  ['unknown quality is rejected before network or third-party dispatch', async () => {
    const app = appFixture({ one: stream('one', 1080, 1920) });
    await assert.rejects(app.fetchAppPlayUrl('11', { quality: '4k' }), /清晰度/); assert.equal(app.calls.length, 0);
    const f = routeFixture();
    for (const vid of ['11', 'hema:11', 'xifan:11']) {
      const result = await f.fetchPlayUrlSingle(vid, '1', { quality: '4k' });
      assert.equal(result.url, null); assert.match(result.error, /清晰度/);
    }
    assert.equal(f.calls.length, 0);
  }],
  ['quality caches are separate, force refresh is confined to its tier', async () => {
    const f = routeFixture();
    const auto = await f.fetchPlayUrlSingle('11', '1');
    const hd = await f.fetchPlayUrlSingle('11', '1', { quality: '1080p' });
    const sd = await f.fetchPlayUrlSingle('11', '1', { quality: '720p' });
    assert.equal(auto.url, mediaUrl('web')); assert.equal(hd.quality, '1080p'); assert.equal(sd.quality, '720p');
    assert.equal((await f.fetchPlayUrlSingle('11', '1', { quality: '1080p' })).url, hd.url);
    const fresh = await f.fetchPlayUrlSingle('11', '1', { quality: '1080p', force: true });
    assert.notEqual(fresh.url, hd.url);
    assert.equal((await f.fetchPlayUrlSingle('11', '1', { quality: 'auto' })).url, auto.url);
    assert.equal((await f.fetchPlayUrlSingle('11', '1', { quality: '720p' })).url, sd.url);
    assert.deepEqual(f.calls, ['web', '1080p', '720p', '1080p']);
  }],
  ['explicit App failure returns no URL and never silently falls back to web', async () => {
    const f = routeFixture(true);
    const result = await f.fetchPlayUrlSingle('11', '1', { quality: '1080p' });
    assert.equal(result.url, null); assert.match(result.error, /清晰度/); assert.deepEqual(f.calls, ['1080p']);
  }],
  ['third-party source keeps its authorized URL for later local resolution check', async () => {
    const f = routeFixture();
    for (const name of ['hema', 'xifan']) assert.equal((await f.fetchPlayUrlSingle(`${name}:11`, `${name}:1`, { quality: '1080p' })).url, mediaUrl(name));
    assert.deepEqual(f.calls, ['hema', 'xifan']);
  }],
  ['shared quality validator handles landscape, portrait, missing and higher dimensions', () => {
    const file = path.join(nativeDir, 'download-quality.js');
    assert.ok(fs.existsSync(file), 'shared download quality validator missing');
    const { normalizeDownloadQuality, meetsDownloadQuality } = require(file);
    assert.equal(normalizeDownloadQuality(), 'auto');
    for (const quality of ['auto', '720p', '1080p']) assert.equal(normalizeDownloadQuality(quality), quality);
    for (const quality of [null, '', '1080', '4k']) assert.throws(() => normalizeDownloadQuality(quality), /清晰度/);
    assert.ok(meetsDownloadQuality({}, 'auto'));
    for (const dimensions of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }, { width: 1440, height: 2560 }]) assert.ok(meetsDownloadQuality(dimensions, '1080p'));
    for (const dimensions of [{}, { width: 720, height: 1920 }, { width: Infinity, height: 1080 }]) assert.equal(meetsDownloadQuality(dimensions, '1080p'), false);
  }],
];
(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  console.log(`${checks.length - failed}/${checks.length} download quality checks passed`);
  process.exitCode = failed ? 1 : 0;
})();
