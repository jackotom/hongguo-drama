const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const vid = '7704577082471014042';
const identity = { device_id: '9007199254740993', iid: '9007199254741993', cdid: '00000000-0000-4000-8000-000000000001' };
const media = 'https://qznovelvod.com/current-recovery.mp4';
const model = {
  video_id: 'current-recovery', video_duration: 95,
  video_list: [{ codec_type: 'hevc', vwidth: 1080, vheight: 1920, quality_desc: '1080p',
    main_url: media, encrypt_info: { encrypt: false } }],
};
const answer = data => ({ status: 200, headers: {}, data: JSON.stringify(data) });

function fixture(tabAnswer, v5Answer = '') {
  const calls = [], registrations = [];
  let resets = 0, cached = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./app-source'), 'utf8'), {
    module, Buffer, URL, AbortSignal, setTimeout, clearTimeout,
    require(name) {
      if (name === './playback-device') return {
        async registerPlaybackDevice() { if (!cached) registrations.push(identity); cached = true; return identity; },
        async getPlaybackDevice() { if (!cached) registrations.push(identity); cached = true; return identity; },
        resetPlaybackDevice() { resets++; cached = false; },
      };
      if (name === './sdk-playback') return { resolveSdkPlayback: async () => null };
      if (name === 'axios') return async config => {
        calls.push(config);
        const url = new URL(config.url);
        if (url.pathname === '/novel/player/multi_video_model/preload/v1'
            || url.pathname === '/novel/player/multi_video_model/player/v1') {
          const answer = typeof v5Answer === 'function' ? v5Answer(config, calls.length) : v5Answer;
          return typeof answer === 'string' ? { status: 200, headers: {}, data: answer } : answer;
        }
        if (url.pathname === '/reading/bookapi/video_tab/multi_video_model/v1/') {
          const answer = typeof tabAnswer === 'function' ? tabAnswer(config, calls.length) : tabAnswer;
          return typeof answer === 'string' ? { status: 200, headers: {}, data: answer } : answer;
        }
        if (url.pathname === '/novel/player/video_model/v1/') return { status: 200, headers: {}, data: '' };
        if (url.pathname === '/novel/player/multi_video_model/v1/') return { status: 200, headers: {}, data: '' };
        throw new Error(`unexpected request ${url.pathname}`);
      };
      return require(name.startsWith('.') ? path.join(__dirname, name) : name);
    },
  }, { filename: require.resolve('./app-source') });
  return { calls, fetch: options => module.exports.fetchAppPlayUrl(vid, { quality: '1080p', ...options }),
    registrations: () => registrations.length, resets: () => resets };
}

test('empty V5 responses recover through the current episode video_tab with the same identity', async () => {
  const f = fixture(answer({ code: 0, data: { video_model_data: { [vid]: { video_model: model } } } }));
  assert.equal((await f.fetch()).url, media);
  assert.equal(f.registrations(), 1);
  const tab = f.calls.find(call => new URL(call.url).pathname === '/reading/bookapi/video_tab/multi_video_model/v1/');
  assert.ok(tab, 'video_tab fallback must be requested');
  assert.equal(tab.method, 'GET');
  assert.equal(new URL(tab.url).searchParams.get('video_id'), vid);
  assert.equal(new URL(tab.url).searchParams.get('device_id'), identity.device_id);
  for (const name of ['x-khronos', 'x-helios', 'x-medusa']) assert.ok(tab.headers[name], name);
  for (const name of ['x-ss-stub', 'x-ss-req-ticket', 'x-argus', 'x-ladon']) assert.equal(tab.headers[name], undefined, name);
});

test('empty current routes keep the failure bounded and never accept the preview page', async () => {
  const f = fixture({ status: 200, headers: {}, data: '' });
  await assert.rejects(f.fetch(), { code: 'EMPTY_RESPONSE' });
  assert.equal(f.calls.length, 28);
  assert.equal(f.registrations(), 2);
  assert.ok(f.calls.some(call => new URL(call.url).pathname === '/novel/player/video_model/v1/'));
  assert.ok(f.calls.some(call => new URL(call.url).pathname === '/reading/bookapi/video_tab/multi_video_model/v1/'));
  assert.equal(new URL(f.calls.at(-1).url).pathname, '/novel/player/multi_video_model/v1/');
});

test('an empty route is reprobed with the same identity instead of registering again', async () => {
  let tabAttempts = 0;
  const f = fixture(() => {
    tabAttempts++;
    return tabAttempts === 1
      ? { status: 200, headers: {}, data: '' }
      : answer({ code: 0, data: { video_model_data: { [vid]: { video_model: model } } } });
  });
  assert.equal((await f.fetch()).url, media);
  assert.equal(f.registrations(), 1);
  assert.equal(f.resets(), 0);
  assert.equal(f.calls.length, 4);
});

test('business code 110001 rotates the anonymous identity and retries', async () => {
  let v5Attempts = 0;
  const f = fixture('', () => {
    v5Attempts++;
    return v5Attempts === 1
      ? answer({ code: 110001 })
      : answer({ code: 0, data: { '1004': { [vid]: { video_model: model } } } });
  });
  assert.equal((await f.fetch()).url, media);
  assert.equal(f.registrations(), 2);
  assert.equal(f.calls.length, 2);
  assert.equal(f.resets(), 1);
});

test('a timeout is surfaced without immediately rotating the anonymous identity', async () => {
  const f = fixture('', () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
  await assert.rejects(f.fetch(), { code: 'ETIMEDOUT' });
  assert.equal(f.registrations(), 1);
  assert.equal(f.resets(), 0);
  assert.equal(f.calls.length, 1);
});
