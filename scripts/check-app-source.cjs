const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nativeDir = path.join(__dirname, '../src/native');
const playbackDevice = Object.freeze({ device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '00000000-0000-4000-8000-000000000003' });

// Published SM3 vectors plus a long input cross-checked with Node 22/OpenSSL.
const vectors = [
  ['abc', '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0'],
  ['abcd'.repeat(16), 'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732'],
  ['x'.repeat(10000), '335de0cbf893f7af9a3e548067c72f47630b9fa9293d93959c79c2085fab7e5e'],
];
const keyHex = '0123456789abcdef0123456789abcdef';
function encodedKey() {
  const plain = Buffer.from(`0${keyHex}`);
  const raw = Buffer.alloc(34);
  const previous = [246, 85];
  for (let i = 0; i < plain.length; i++) {
    const pop = i.toString(2).split('1').length - 1;
    raw[i + 1] = ((plain[i] + 21 + pop) & 255) ^ previous[i & 1];
    previous[i & 1] = raw[i + 1];
  }
  raw[0] = 48 ^ raw[1] ^ raw[2];
  return raw.toString('base64');
}
function fixture({ wrongVid = false, fallback = 'https://vod.snssdk.com/info', media = 'https://v3-reading.qznovelvod.com/video.mp4', redirect = '', malformedKey = false, videoList = null, encrypted = true } = {}) {
  const calls = [];
  const seed = Buffer.alloc(16, 7);
  const constants = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
  const material = crypto.createHash('sha512').update(Buffer.concat([crypto.createHash('sha512').update(seed).digest(), constants])).digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  const encryptedUrl = Buffer.concat([Buffer.from([0xa8, 0, 1, 0]), cipher.update(media), cipher.final()]).toString('base64');
  const axios = async config => {
    calls.push(config);
    assert.equal(config.maxRedirects, 0);
    assert.ok(config.timeout > 0 && config.timeout <= 12000);
    assert.ok(config.signal);
    assert.equal(config.responseType, 'text');
    if (config.method === 'POST') {
      assert.match(config.headers['User-Agent'], /^com\.phoenix\.read\/74332 /);
      const query = new URL(config.url).searchParams;
      const timestamp = Number(config.headers['x-khronos']);
      assert.equal(query.get('ts'), String(timestamp));
      assert.equal(query.get('_rticket'), config.headers['x-ss-req-ticket']);
      assert.ok(Buffer.isBuffer(config.data));
      assert.deepEqual(JSON.parse(config.headers['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(config.data) : config.data).mixed_video_id_map['1004'], ['11']);
      assert.equal(config.headers['x-ss-stub'], crypto.createHash('md5').update(config.data).digest('hex'));
      assert.notEqual(config.headers['x-ss-stub'], crypto.createHash('md5').update(zlib.gunzipSync(config.data)).digest('hex'));
      assert.ok(Buffer.from(config.headers['x-argus'], 'base64').length > 100);
      assert.equal(Buffer.from(config.headers['x-ladon'], 'base64').length, 36);
      for (const name of ['x-gorgon', 'x-medusa', 'x-helios']) assert.equal(config.headers[name], undefined);
      assert.equal(config.headers.Cookie, undefined);
      assert.equal(config.headers.Authorization, undefined);
      const model = { video_model: JSON.stringify({ fallback_api: fallback }) };
      return { status: 200, headers: {}, data: JSON.stringify({ code: 0, data: { '999': model, ...(wrongVid ? {} : { '11': model }) } }) };
    }
    if (redirect) return { status: 302, headers: { location: redirect }, data: '' };
    return { status: 200, headers: {}, data: JSON.stringify({ video_info: { data: { key_seed: encrypted ? seed.toString('base64') : null, video_list: videoList || {
      bad: { main_url: media, codec_type: 'bytevc2', quality_desc: '2160P', spade_a: encodedKey() },
      good: { main_url: encryptedUrl, codec_type: 'h264', quality_desc: '720P', spade_a: malformedKey ? 'bad' : encodedKey() },
    } } } }) };
  };
  const context = { Buffer, URL, URLSearchParams, AbortSignal, module: { exports: {} },
    require: name => {
      if (name === 'axios') return axios;
      if (name === './playback-device') return { registerPlaybackDevice: async requestJson => {
        assert.equal(typeof requestJson, 'function');
        return playbackDevice;
      } };
      if (name === './player-signature') return require(path.join(nativeDir, 'player-signature'));
      if (name === './sm3') return require(path.join(nativeDir, 'sm3'));
      if (name === './download-quality') return require(path.join(nativeDir, 'download-quality'));
      if (name === './request-signal') return require(path.join(nativeDir, 'request-signal'));
      if (name === 'node:zlib') return zlib;
      if (name === 'node:crypto') return { ...crypto, createHash(name, ...args) {
        assert.notEqual(name.toLowerCase(), 'sm3', 'must not depend on OpenSSL SM3');
        return crypto.createHash(name, ...args);
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(nativeDir, 'app-source.js'), 'utf8'), context);
  return { fetch: context.module.exports.fetchAppPlayUrl, calls };
}

function nativeFixture() {
  const pending = [];
  const context = { module: { exports: {} }, Buffer, URL, AbortController, process: { env: {} },
    require: name => name === 'axios' ? { get: () => new Promise(resolve => pending.push(resolve)) }
      : name === './app-source' ? { fetchAppPlayUrl: async () => { throw new Error('Unexpected App lookup in Web cache fixture'); } }
      : require(name.startsWith('.') ? path.join(nativeDir, name) : name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(nativeDir, 'hongguo.js'), 'utf8') + '\nmodule.exports.parseModelVideo = parseModelVideo;', context);
  return { ...context.module.exports, pending,
    finish(index, name) { pending[index]({ data: `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
      'player_(series_id)/(vid)/page': { vid: '11', series_id: '1', seriesDetail: { series_id: '1' }, publicVideoSeo: { available: true, itemId: '11', seriesId: '1' } },
    } })}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', url: 'https://hongguoduanju.com/player/1/11', contentUrl: `https://media.example/${name}.mp4` })}</script>` }); },
  };
}
const mediaUrl = name => `https://v3-reading.qznovelvod.com/${name}.mp4`;
const appRows = videoList => fixture({ videoList, encrypted: false }).fetch('11');
const turn = () => new Promise(resolve => setImmediate(resolve));

const checks = [
  ['sequential and concurrent signed lookups preserve the same valid device identity', async () => {
    const f = fixture();
    await f.fetch('11');
    await f.fetch('11');
    await Promise.all([f.fetch('11'), f.fetch('11'), f.fetch('11')]);
    const requests = f.calls.filter(call => call.method === 'POST');
    assert.equal(requests.length, 5, 'one model request per lookup; no retry loop');
    for (const field of ['iid', 'device_id']) {
      const ids = requests.map(call => new URL(call.url).searchParams.get(field));
      assert.ok(ids.every(id => /^[1-9]\d{15,29}$/.test(id)), `${field} must stay a valid device identifier`);
      assert.equal(new Set(ids).size, 1, `${field} must remain stable across lookups`);
      assert.ok(ids.every(id => id === playbackDevice[field]), `${field} must preserve the registered string without precision loss`);
    }
    const cdids = requests.map(call => new URL(call.url).searchParams.get('cdid'));
    assert.ok(cdids.every(id => id === playbackDevice.cdid), 'cdid must remain stable across lookups');
    assert.match(cdids[0], /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
    assert.equal(f.calls.length, 10, 'each lookup retains its two-stage flow');
  }],
  ['App H264 takes priority over higher-resolution HEVC', async () => {
    const result = await appRows({ hd: { main_url: mediaUrl('hevc'), codec_type: 'hevc', quality_desc: '1080P' },
      sd: { main_url: mediaUrl('avc'), codec_type: 'h264', quality_desc: '720P' } });
    assert.equal(result.url, mediaUrl('avc'));
  }],
  ['App invalid or missing main URL keeps validated same-stream backup', async () => {
    for (const main_url of ['', 'https://127.0.0.1/private', 'https://v3-reading.qznovelvod.com.attacker.test/video', 'http://v3-reading.qznovelvod.com/video']) {
      const result = await appRows({ one: { main_url, backup_url: mediaUrl('backup'), codec_type: 'h264' } });
      assert.equal(result.url, mediaUrl('backup'));
    }
  }],
  ['App skips unusable same-tier candidates but never ignores an invalid encryption key', async () => {
    const result = await appRows({ broken: { main_url: mediaUrl('broken'), codec_type: 'h264', quality_desc: '1080P', spade_a: 'bad' },
      working: { main_url: mediaUrl('working'), codec_type: 'h264', quality_desc: '1080P', spade_a: encodedKey() } });
    assert.equal(result.url, mediaUrl('working'));
    assert.equal(result.contentKey, keyHex);
    await assert.rejects(appRows({ broken: { main_url: mediaUrl('broken'), codec_type: 'h264', quality_desc: '1080P', spade_a: 'bad' },
      lower: { main_url: mediaUrl('lower'), codec_type: 'h264', quality_desc: '720P', spade_a: encodedKey() } }),
    /片源地址或密钥无法解析/);
    await assert.rejects(appRows({ one: { main_url: 'https://127.0.0.1/private', backup_url: 'file:///private', codec_type: 'h264' } }));
  }],
  ['legacy parser prefers H264 and keeps a usable backup', async () => {
    const { parseModelVideo } = nativeFixture();
    const choose = rows => parseModelVideo(JSON.stringify({ video_list: rows }));
    assert.equal(choose([{ main_url: mediaUrl('hevc'), video_meta: { codec_type: 'h265', definition: '1080p' } },
      { main_url: mediaUrl('avc'), video_meta: { codec_type: 'H264', definition: '720p' } }])[0], mediaUrl('avc'));
    assert.equal(choose([{ main_url: 'not a URL', backup_url: mediaUrl('backup'), video_meta: { codec_type: 'h264' } }])[0], mediaUrl('backup'));
    assert.equal(choose([{ main_url: 'file:///private', backup_url: 'https://user:pass@example.com/video' }])[0], null);
  }],
  ['legacy parser uses actual dimensions before quality labels', async () => {
    const { parseModelVideo } = nativeFixture();
    const result = parseModelVideo(JSON.stringify({ video_list: [
      { main_url: mediaUrl('low'), video_meta: { codec_type: 'h264', definition: '1080p', vwidth: 360, vheight: 640 } },
      { main_url: mediaUrl('high'), video_meta: { codec_type: 'h264', definition: '720p', vwidth: 1920, vheight: 1080 } },
    ] }));
    assert.equal(result[0], mediaUrl('high'));
  }],
  ['forced lookup bypasses settled play URL cache', async () => {
    const f = nativeFixture();
    const first = f.fetchPlayUrlSingle('11', '1'); await turn(); f.finish(0, 'old'); await first;
    const forced = f.fetchPlayUrlSingle('11', '1', { force: true }); await turn();
    assert.equal(f.pending.length, 2, 'force must fetch a new address');
    f.finish(1, 'new'); await forced;
    assert.equal((await f.fetchPlayUrlSingle('11', '1')).url, 'https://media.example/new.mp4');
  }],
  ['old in-flight lookup cannot overwrite forced cache or remove forced pending', async () => {
    for (const oldFinishesFirst of [true, false]) {
      const f = nativeFixture();
      const old = f.fetchPlayUrlSingle('11', '1'); await turn();
      const forced = f.fetchPlayUrlSingle('11', '1', { force: true }); await turn();
      assert.equal(f.pending.length, 2, 'force must bypass old in-flight request');
      if (oldFinishesFirst) {
        f.finish(0, 'old'); await old;
        const joined = f.fetchPlayUrlSingle('11', '1'); await turn();
        assert.equal(f.pending.length, 2, 'old completion must preserve forced request');
        f.finish(1, 'new'); await forced;
        assert.equal((await joined).url, 'https://media.example/new.mp4');
      } else {
        f.finish(1, 'new'); await forced;
        f.finish(0, 'old'); await old;
      }
      assert.equal((await f.fetchPlayUrlSingle('11', '1')).url, 'https://media.example/new.mp4');
    }
  }],
  ['pure JS SM3 vectors', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'sm3.js')), 'pure JS SM3 missing');
    const sm3 = require(path.join(nativeDir, 'sm3'));
    for (const [input, expected] of vectors) {
      assert.equal(sm3(input).toString('hex'), expected);
      if (crypto.getHashes().includes('sm3')) assert.equal(sm3(input).toString('hex'), crypto.createHash('sm3').update(input).digest('hex'));
    }
  }],
  ['signed exact-episode model, fallback and compatible media', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
    const { fetch, calls } = fixture();
    const result = await fetch('11');
    assert.equal(result.source, 'app');
    assert.equal(result.contentKey, keyHex);
    assert.equal(result.codec, 'h264');
    assert.equal(result.quality, '720P');
    assert.equal(calls.length, 2);
  }],
  ['no wrong-episode fallback', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
    const { fetch, calls } = fixture({ wrongVid: true });
    await assert.rejects(fetch('11'));
    assert.equal(calls.length, 1);
  }],
  ['URL boundary and redirect validation', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
    for (const fallback of ['http://vod.snssdk.com/info', 'https://127.0.0.1/info', 'https://vod.snssdk.com.attacker.test/info', 'https://user:pass@vod.snssdk.com/info']) {
      const { fetch, calls } = fixture({ fallback });
      await assert.rejects(fetch('11'));
      assert.equal(calls.length, 1);
    }
    const { fetch, calls } = fixture({ redirect: 'https://127.0.0.1/private' });
    await assert.rejects(fetch('11'));
    assert.equal(calls.length, 2);
    await assert.rejects(fixture({ media: 'https://127.0.0.1/video' }).fetch('11'));
  }],
  ['invalid input and invalid key rejected', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
    const { fetch, calls } = fixture();
    await assert.rejects(fetch('../11'));
    assert.equal(calls.length, 0);
    await assert.rejects(fixture({ malformedKey: true }).fetch('11'));
  }],
];
(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  console.log(`${checks.length - failed}/${checks.length} passed; Node ${process.versions.node}; OpenSSL SM3=${crypto.getHashes().includes('sm3')}`);
  process.exitCode = failed ? 1 : 0;
})();
