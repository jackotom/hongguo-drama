// Offline App playback-source checks: empty 200 responses and automatic quality locking.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '../src/native/app-source.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const vid = '7700946421087751193';

function load(axios, { realDevice = false, getPlaybackDevice, registerPlaybackDevice = getPlaybackDevice, now } = {}) {
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require(name) {
      if (name === 'node:crypto') return crypto;
      if (name === './sm3') return require('../src/native/sm3');
      if (name === './download-quality') return require('../src/native/download-quality');
      if (name === './request-signal') return require('../src/native/request-signal');
      if (name === './playback-signature') return require('../src/native/playback-signature');
      if (name === './playback-device') return getPlaybackDevice || registerPlaybackDevice ? {
        getPlaybackDevice: getPlaybackDevice || (async () => ({ device_id: '1000000000000001', iid: '1000000000000002', cdid: 'fixture' })),
        registerPlaybackDevice: registerPlaybackDevice || (async () => ({ device_id: '1000000000000001', iid: '1000000000000002', cdid: 'fixture' })),
      } : realDevice ? require('../src/native/playback-device')
        : {
          getPlaybackDevice: async () => ({ device_id: '1000000000000001', iid: '1000000000000002', cdid: 'fixture' }),
          registerPlaybackDevice: async () => ({ device_id: '1000000000000001', iid: '1000000000000002', cdid: 'fixture' }),
        };
      if (name === 'axios') return axios;
      return require(name);
    },
    Date: class extends Date { static now() { return now ? now() : Date.now(); } },
    Buffer,
    URL,
    AbortSignal,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(source, context, { filename: sourcePath });
  return module.exports;
}

function modelResponse(rows) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({
      code: 0,
      data: {
        [vid]: {
          video_model: {
            fallback_api: 'https://api5-normal-sinfonlineb.fqnovel.com/fallback',
          },
        },
      },
    }),
  };
}

function fallbackResponse(rows) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ code: 0, video_info: { data: { video_list: rows } } }),
  };
}

function row(definition, width, height, suffix) {
  return {
    codec_type: 'h264',
    quality_desc: definition,
    video_meta: { codec_type: 'h264', definition, vwidth: width, vheight: height },
    main_url: `https://qznovelvod.com/${suffix}.mp4`,
    backup_url: `https://fqnovelvod.com/${suffix}-backup.mp4`,
  };
}

(async () => {
  const empty = await load(async () => ({
    status: 200,
    headers: { 'content-type': 'application/json', 'x-tt-logid': 'empty-log' },
    data: '',
  })).fetchAppPlayUrl(vid, { quality: 'auto' }).then(
    () => { throw new Error('empty 200 response must fail'); },
    error => error,
  );
  assert.equal(empty.code, 'EMPTY_RESPONSE');
  assert.match(empty.message, /空响应/);

  let call = 0;
  const api = load(async () => {
    call += 1;
    return call === 1
      ? modelResponse()
      : fallbackResponse([row('1080p', 1080, 1920, 'best'), row('720p', 720, 1280, 'lower')]);
  });
  const selected = await api.fetchAppPlayUrl(vid, { quality: 'auto' });
  assert.equal(selected.quality, '1080p');
  assert.equal(selected.variants.length, 2, 'main and backup URLs for the best rendition only');
  assert.ok(selected.variants.every(item => item.url.includes('best')), 'auto must not silently fall through to 720p');

  const inlineResponse = (rows, id = vid) => ({ status: 200, headers: {}, data: JSON.stringify({ code: 0,
    data: { [id]: { video_model: { video_list: rows, fallback_api: 'https://vod.snssdk.com/must-not-fetch' } } } }) });
  const plain = { ...row('1080p', 1080, 1920, 'inline'), encrypt_info: { encrypt: false } };
  const identities = [{ device_id: '11', iid: '12', cdid: 'fixture' }, { device_id: '21', iid: '22', cdid: 'fixture' }];
  let recoverCalls = 0, renewals = 0, recoveryRegistrations = 0;
  const recovery = load(async config => {
    recoverCalls++;
    if (new URL(config.url).searchParams.get('device_id') === '11') return { status: 200, headers: {}, data: '' };
    return inlineResponse([plain]);
  }, { registerPlaybackDevice: async () => {
    recoveryRegistrations++;
    if (recoveryRegistrations > 1) renewals++;
    return identities[recoveryRegistrations - 1];
  } });
  assert.equal((await recovery.fetchAppPlayUrl(vid)).url, plain.main_url, 'empty model response renews the device and recovers');
  assert.equal(recoverCalls, 2);
  assert.equal(renewals, 1);
  for (const status of [200, 403, 404]) {
    let calls = 0, registrations = 0;
    const unavailable = load(async () => { calls++; return { status, headers: {}, data: '' }; },
      { registerPlaybackDevice: async () => identities[registrations++] });
    await assert.rejects(unavailable.fetchAppPlayUrl(vid), error => status === 200 ? error.code === 'EMPTY_RESPONSE' : error.status === status);
    assert.equal(calls, status === 200 ? 2 : 1, 'one recovery only; HTTP rejection must not retry the model request');
    assert.equal(registrations, status === 200 ? 2 : 1);
  }
  let cooldownCalls = 0;
  await assert.rejects(load(async () => { cooldownCalls++; return { status: 200, headers: {}, data: '' }; },
    { getPlaybackDevice: async () => identities[0] }).fetchAppPlayUrl(vid), error => error.code === 'EMPTY_RESPONSE');
  assert.equal(cooldownCalls, 2, 'empty response permits one fresh-device alternate route');
  let clock = Date.now(), slowCalls = 0;
  const slowRegistration = load(async config => {
    slowCalls++;
    assert.ok(config.timeout > 11000, 'slow initial registration must not consume the model budget');
    return inlineResponse([plain]);
  }, { now: () => clock, getPlaybackDevice: async () => { clock += 7900; return identities[0]; } });
  assert.equal((await slowRegistration.fetchAppPlayUrl(vid)).url, plain.main_url);
  assert.equal(slowCalls, 1);
  const routes = [];
  const alternate = load(async config => {
    routes.push([config.method, new URL(config.url).pathname]);
    if (routes.length === 1) return { status: 200, headers: {}, data: '' };
    assert.equal(config.headers.Connection, 'close');
    return inlineResponse([plain]);
  }, { getPlaybackDevice: async () => identities[0] });
  assert.equal((await alternate.fetchAppPlayUrl(vid)).url, plain.main_url);
  assert.deepEqual(routes, [['GET', '/reading/bookapi/video_tab/multi_video_model/v1/'],
    ['POST', '/novel/player/multi_video_model/v1/']]);
  let inlineCalls = 0;
  const direct = load(async config => {
    inlineCalls++;
    assert.equal(new URL(config.url).searchParams.get('device_id'), '1000000000000001');
    assert.ok(Buffer.from(config.headers['x-argus'], 'base64').length > 4);
    assert.ok(Buffer.from(config.headers['x-ladon'], 'base64').length > 4);
    for (const name of ['x-medusa', 'x-gorgon', 'x-helios']) assert.equal(config.headers[name], undefined);
    assert.equal(config.headers.Cookie, undefined);
    return inlineResponse([plain]);
  });
  assert.equal((await direct.fetchAppPlayUrl(vid)).url, plain.main_url);
  assert.equal(inlineCalls, 1, 'inline model must not fetch the obsolete fallback endpoint');
  assert.equal((await direct.fetchAppPlayUrl(vid, { quality: '1080p' })).width, 1080);

  let registrations = 0;
  const oneUseDevice = load(async config => inlineResponse([plain]), {
    getPlaybackDevice: async () => assert.fail('playback model must not reuse the cached device'),
    registerPlaybackDevice: async () => ({ device_id: String(++registrations), iid: '2', cdid: 'fixture' }),
  });
  await oneUseDevice.fetchAppPlayUrl(vid);
  await oneUseDevice.fetchAppPlayUrl(vid);
  assert.equal(registrations, 2, 'each model request registers a device because the upstream may allow one request per identity');

  // Encode a synthetic Spade key, so the real decoder is exercised without captured credentials.
  const keyHex = '0123456789abcdef0123456789abcdef';
  const raw = Buffer.alloc(34), previous = [246, 85], keyPlain = Buffer.from(`0${keyHex}`);
  for (let i = 0; i < keyPlain.length; i++) {
    raw[i + 1] = ((keyPlain[i] + 21 + i.toString(2).split('1').length - 1) & 255) ^ previous[i & 1];
    previous[i & 1] = raw[i + 1];
  }
  raw[0] = 48 ^ raw[1] ^ raw[2];
  const encrypted = { ...plain, encrypt_info: { encrypt: true, spade_a: raw.toString('base64') } };
  const keyed = await load(async () => inlineResponse([encrypted])).fetchAppPlayUrl(vid);
  assert.equal(keyed.contentKey, keyHex);
  for (const info of [{ encrypt: true }, {}, { encrypt: true, spade_a: 'bad' }]) {
    await assert.rejects(load(async () => inlineResponse([{ ...plain, encrypt_info: info }])).fetchAppPlayUrl(vid),
      error => error.code === 'INVALID_RESPONSE');
  }
  await assert.rejects(load(async () => inlineResponse([plain], '999')).fetchAppPlayUrl(vid),
    error => error.code === 'MISSING_MODEL');
  await assert.rejects(load(async () => inlineResponse([{ ...plain, main_url: 'https://127.0.0.1/private', backup_url: '' }])).fetchAppPlayUrl(vid),
    error => error.code === 'SECURITY_BLOCKED');
  registrations = 0;
  let modelCalls = 0;
  const registered = load(async config => {
    if (new URL(config.url).pathname === '/service/2/device_register/') {
      registrations++;
      assert.equal(config.method, 'POST');
      assert.ok(Buffer.isBuffer(config.data));
      assert.ok(config.timeout > 0 && config.timeout <= 8000);
      return { status: 200, headers: {}, data: '{"device_id_str":"9007199254740993","install_id_str":"9007199254741993","device_token":"synthetic-unused-token"}' };
    }
    modelCalls++;
    const query = new URL(config.url).searchParams;
    assert.equal(query.get('device_id'), '9007199254740993');
    assert.equal(query.get('iid'), '9007199254741993');
    assert.equal(config.headers.Cookie, undefined);
    return inlineResponse([plain]);
  }, { realDevice: true });
  const simultaneous = await Promise.all([registered.fetchAppPlayUrl(vid), registered.fetchAppPlayUrl(vid)]);
  assert.equal(registrations, 2, 'each model request uses a separately registered device');
  assert.equal(modelCalls, 2);
  assert.ok(simultaneous.every(result => result.url === plain.main_url));
  assert.doesNotMatch(JSON.stringify(simultaneous), /synthetic-unused-token/);
  console.log('PASS app source recovery: empty response, legacy quality lock, inline URLs/keys and trust boundaries');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
