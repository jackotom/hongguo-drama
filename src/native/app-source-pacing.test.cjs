const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gunzipSync } = require('node:zlib');
const { deferred, turn } = require('./hongguo-cancellation-fixture.cjs');

function fixture(reply, registrationError, sdkReply) {
    let now = 1800000000000;
    const calls = [], registrations = [], sdkCalls = [], timers = [], module = { exports: {} };
    function later(fn, ms) { const timer = { fn, at: now + ms, cleared: false }; timers.push(timer); return timer; }
    const clear = timer => { if (timer) timer.cleared = true; };
    vm.runInNewContext(fs.readFileSync(require.resolve('./app-source'), 'utf8'), {
        module, Buffer, URL, AbortSignal, setTimeout: later, clearTimeout: clear,
        Date: class extends Date { static now() { return now; } },
        require(name) {
            if (name === './playback-device') return { registerPlaybackDevice: async () => {
                registrations.push(now);
                const error = typeof registrationError === 'function' ? registrationError(registrations.length)
                    : registrations.length === 1 ? registrationError : undefined;
                if (error) throw error;
                return { device_id: '1000000000000001', iid: '1000000000000002', cdid: 'fixture' };
            } };
            if (name === 'node:timers/promises') return { setTimeout: (ms, value, { signal } = {}) => new Promise((resolve, reject) => {
                const abort = () => { clear(timer); reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); };
                const timer = later(() => { signal?.removeEventListener('abort', abort); resolve(value); }, ms);
                if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
            }) };
            if (name === 'axios') return async config => {
                calls.push({ ...config, at: now });
                return reply ? reply(config, calls.length) : success(config);
            };
            if (name === './sdk-playback') return {
                resolveSdkPlayback: (vid, options) => {
                    sdkCalls.push({ vid, at: now });
                    return sdkReply ? sdkReply(vid, options) : null;
                },
            };
            return require(name.startsWith('.') ? path.join(__dirname, name) : name);
        },
    });
    return { calls, registrations, sdkCalls, fetch: (vid = '11', options) => module.exports.fetchAppPlayUrl(vid, options),
        async advance(ms) {
            now += ms;
            for (let idle = 0, rounds = 0; rounds < 50; rounds++) {
                await turn();
                const timer = timers.find(item => !item.cleared && item.at <= now);
                if (!timer) {
                    if (++idle > 1) break;
                    continue;
                }
                idle = 0;
                timer.cleared = true;
                timer.fn();
            }
        },
        liveTimers: () => timers.filter(timer => !timer.cleared),
    };
}

function success(config) {
    const vid = new URL(config.url).searchParams.get('video_id') || '11';
    const entry = { video_model: {
        video_id: 'same-video', video_duration: 60, video_list: { hd: { codec_type: 'h264',
            vwidth: 1080, vheight: 1920, main_url: 'https://qznovelvod.com/fixture.mp4', encrypt_info: { encrypt: false } } },
    } };
    return { status: 200, headers: {}, data: JSON.stringify({ code: 0, data: { [vid]: entry, '12': entry } }) };
}

function sdkSuccess(name) {
    return {
        model: {
            video_id: `sdk-${name}`, video_duration: 60,
            video_list: { hd: { codec_type: 'h264', vwidth: 1080, vheight: 1920,
                main_url: `https://qznovelvod.com/${name}.mp4`, encrypt_info: { encrypt: false } } },
        },
        userAgent: 'sdk-fixture',
    };
}

test('Parallel SDK-first downloads resolve without consuming playback pacing', async () => {
    const held = [deferred(), deferred()], vids = [];
    const f = fixture(undefined, undefined, vid => {
        vids.push(vid);
        return held[vids.length - 1].promise;
    });
    const first = f.fetch('11', { preferSdk: true, parallelSdk: true });
    const second = f.fetch('12', { preferSdk: true, parallelSdk: true });
    await turn();
    assert.deepEqual(vids, ['11', '12']);
    assert.equal(f.calls.length, 0, 'SDK-first downloads must skip empty official routes');
    assert.equal(f.registrations.length, 0, 'SDK-first downloads must not spend the anonymous App identity');
    held[0].resolve(sdkSuccess('first'));
    held[1].resolve(sdkSuccess('second'));
    assert.deepEqual([(await first).url, (await first).sourceProvider], ['https://qznovelvod.com/first.mp4', 'sdk']);
    assert.deepEqual([(await second).url, (await second).sourceProvider], ['https://qznovelvod.com/second.mp4', 'sdk']);
});

test('Online SDK-first playback waits for a FIFO slot and one-second pacing', async () => {
    const held = [deferred(), deferred()], vids = [];
    const f = fixture(undefined, undefined, vid => {
        vids.push(vid);
        return held[vids.length - 1].promise;
    });
    const first = f.fetch('11', { preferSdk: true });
    const second = f.fetch('12', { preferSdk: true });
    await turn();
    assert.deepEqual(f.sdkCalls.map(call => call.vid), ['11']);
    assert.equal(f.calls.length, 0, 'online SDK-first must not run in parallel');
    held[0].resolve(sdkSuccess('first'));
    assert.equal((await first).url, 'https://qznovelvod.com/first.mp4');
    await f.advance(999); await turn();
    assert.deepEqual(f.sdkCalls.map(call => call.vid), ['11']);
    await f.advance(1); await turn();
    assert.deepEqual(f.sdkCalls.map(call => call.vid), ['11', '12']);
    assert.equal(f.sdkCalls[1].at - f.sdkCalls[0].at, 1000);
    held[1].resolve(sdkSuccess('second'));
    assert.equal((await second).url, 'https://qznovelvod.com/second.mp4');
});

test('content type 1001 is sent and parsed through the 1001 model bucket', async () => {
    let payload;
    const f = fixture(config => {
        if (config.method === 'GET') return { status: 200, headers: {}, data: '' };
        payload = gunzipSync(config.data).toString('utf8');
        const model = sdkSuccess('creator').model;
        return { status: 200, headers: {}, data: JSON.stringify({ code: 0, data: { 1001: { 11: { video_model: model } } } }) };
    });
    const pending = f.fetch('11', { contentType: '1001' });
    await turn(); await f.advance(250);
    const result = await pending;
    assert.equal(result.url, 'https://qznovelvod.com/creator.mp4');
    assert.match(payload, /"mixed_video_id_map":\{"1001":\["11"\]\}/);
});

test('V8 official route is attempted before SDK fallback for downloads', async () => {
    const f = fixture(() => ({ status: 200, headers: {}, data: '{"code":12345}' }), undefined,
        async () => sdkSuccess('recovered'));
    const result = await f.fetch('11');
    assert.equal(result.url, 'https://qznovelvod.com/recovered.mp4');
    assert.equal(result.source, 'app');
    assert.equal(result.sourceProvider, 'sdk');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.sdkCalls.map(call => call.vid), ['11']);
});

test('SDK unavailable under preferSdk still falls back to the official route', async () => {
    const f = fixture(undefined, undefined, async (_vid, options) => {
        options.onError({ code: 'SDK_UNAVAILABLE', message: '当前平台未启用后续集 SDK' });
        return null;
    });
    const result = await f.fetch('11', { preferSdk: true });
    assert.equal(result.url, 'https://qznovelvod.com/fixture.mp4');
    assert.equal(result.source, 'app');
    assert.equal(result.sourceProvider, 'official');
    assert.equal(result.sdkFailure.code, 'SDK_UNAVAILABLE');
    assert.equal(f.calls.length, 1);
    assert.equal(f.registrations.length, 1);
});

test('SDK failure detail remains attached when App playback also fails', async () => {
    const f = fixture(() => ({ status: 200, headers: {}, data: '{"code":12345}' }), undefined,
        async (_vid, options) => {
            options.onError({ code: 'SDK_UNAVAILABLE', message: '当前平台未启用后续集 SDK' });
            return null;
        });
    await assert.rejects(f.fetch('11'), error => {
        assert.equal(error.code, 'BUSINESS_REJECTED');
        assert.equal(error.sdkFailure.code, 'SDK_UNAVAILABLE');
        assert.match(error.sdkFailure.message, /当前平台/);
        return true;
    });
});

test('concurrent playback and prefetch register and request serially with a one-second gap', async () => {
    const held = deferred(), f = fixture((config, count) => count === 1 ? held.promise : success(config));
    const first = f.fetch(), second = f.fetch(); await turn();
    assert.equal(f.calls.length, 1, 'parallel consumers must not burst model requests');
    assert.equal(f.registrations.length, 1, 'registration must wait for the same source turn');
    held.resolve(success(f.calls[0])); await first; await turn();
    await f.advance(999); assert.equal(f.calls.length, 1);
    await f.advance(1); await second;
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].at - f.calls[0].at, 1000);
    assert.equal(f.calls[1].timeout, 12000, 'queue waiting must not spend the actual request budget');
    assert.equal(Number(f.calls[1].headers['x-khronos']), f.calls[1].at / 1000, 'sign after the wait');
});

test('cancelling a queued consumer returns immediately without consuming another consumer or registering', async () => {
    const held = deferred(), f = fixture((config, count) => count === 1 ? held.promise : success(config));
    const first = f.fetch(), controller = new AbortController();
    const cancelled = assert.rejects(f.fetch('12', { signal: controller.signal }), { code: 'ERR_CANCELED' });
    await turn(); controller.abort(); await cancelled;
    assert.equal(f.calls.length, 1); assert.equal(f.registrations.length, 1);
    const third = f.fetch(); held.resolve(success(f.calls[0])); await first; await turn();
    await f.advance(1000); await third;
    assert.equal(f.calls.length, 2); assert.equal(f.registrations.length, 2);
});

test('cancelling the source cooldown does not send a request or extend the next consumer cooldown', async () => {
    const f = fixture(); await f.fetch();
    const controller = new AbortController();
    const cancelled = assert.rejects(f.fetch('12', { signal: controller.signal }), { code: 'ERR_CANCELED' });
    await turn(); await f.advance(200); controller.abort(); await cancelled;
    const next = f.fetch(); await turn(); await f.advance(800); await next;
    assert.equal(f.calls.length, 2); assert.equal(f.registrations.length, 2);
    assert.equal(f.calls[1].at - f.calls[0].at, 1000);
});

test('empty current routes rotate identity once and stop', async () => {
    const f = fixture(() => ({ status: 200, headers: {}, data: '' }));
    const result = f.fetch().then(value => ({ value }), error => ({ error }));
    await turn();
    for (let round = 0; round < 30; round++) await f.advance(250);
    const settled = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 100))]);
    assert.equal(settled.timeout, undefined, JSON.stringify({ calls: f.calls.length, liveTimers: f.liveTimers().length }));
    assert.equal(settled.error.code, 'EMPTY_RESPONSE');
    assert.equal(f.registrations.length, 2, 'one empty-result identity rotation is bounded');
    const round = [
        '/novel/player/multi_video_model/preload/v1',
        '/novel/player/multi_video_model/preload/v1',
        '/reading/bookapi/video_tab/multi_video_model/v1/',
        '/reading/bookapi/video_tab/multi_video_model/v1/',
        '/novel/player/multi_video_model/player/v1',
        '/novel/player/multi_video_model/player/v1',
        '/novel/player/multi_video_model/player/v1',
        '/novel/player/multi_video_model/player/v1',
        '/novel/player/video_model/v1/',
        '/novel/player/video_model/v1/',
        '/novel/player/video_model/v1/',
        '/novel/player/video_model/v1/',
        '/novel/player/multi_video_model/v1/',
        '/novel/player/multi_video_model/v1/',
    ];
    assert.deepEqual(f.calls.map(config => new URL(config.url).pathname), [...round, ...round]);
});

test('explicit HTTP refusal remains terminal for queued consumers and permits a later action', async () => {
    const f = fixture((config, count) => count === 1 ? { status: 429, headers: {}, data: '' } : success(config));
    const first = assert.rejects(f.fetch(), { status: 429 });
    const queued = assert.rejects(f.fetch('12'), { status: 429 });
    await first; await queued;
    assert.equal(f.calls.length, 1); assert.equal(f.registrations.length, 1);
    const next = f.fetch(); await turn(); await f.advance(1000); await next;
    assert.equal(f.calls.length, 2);
});

test('timeout is surfaced without rotating the shared identity or probing later routes', async () => {
    const f = fixture(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    await assert.rejects(f.fetch(), { code: 'ETIMEDOUT' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.registrations.length, 1);
});

test('110001 rotates the identity once before retrying a single route', async () => {
    const f = fixture((config, count) => count === 1
        ? { status: 200, headers: {}, data: '{"code":110001}' }
        : success(config));
    assert.equal((await f.fetch()).url, 'https://qznovelvod.com/fixture.mp4');
    assert.equal(f.registrations.length, 2);
    assert.equal(f.calls.length, 2);
});
