const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { deferred, turn } = require('./hongguo-cancellation-fixture.cjs');

function fixture(reply, registrationError) {
    let now = 1800000000000;
    const calls = [], registrations = [], timers = [], module = { exports: {} };
    function later(fn, ms) { const timer = { fn, at: now + ms, cleared: false }; timers.push(timer); return timer; }
    const clear = timer => { if (timer) timer.cleared = true; };
    vm.runInNewContext(fs.readFileSync(require.resolve('./app-source'), 'utf8'), {
        module, Buffer, URL, AbortSignal, setTimeout: later, clearTimeout: clear,
        Date: class extends Date { static now() { return now; } },
        require(name) {
            if (name === './playback-device') return { registerPlaybackDevice: async () => {
                registrations.push(now);
                if (registrations.length === 1 && registrationError) throw registrationError;
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
            return require(name.startsWith('.') ? path.join(__dirname, name) : name);
        },
    });
    return { calls, registrations, fetch: (vid = '11', options) => module.exports.fetchAppPlayUrl(vid, options),
        async advance(ms) { now += ms; for (const timer of timers) if (!timer.cleared && timer.at <= now) { timer.cleared = true; timer.fn(); } await turn(); },
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
    assert.equal(Number(new URL(f.calls[1].url).searchParams.get('ts')), f.calls[1].at / 1000, 'sign after the wait');
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

test('empty legacy responses wait one second before the single existing alternate attempt', async () => {
    const f = fixture((config, count) => count === 1 ? { status: 200, headers: {}, data: '' } : success(config));
    const result = f.fetch(); await turn();
    await f.advance(999); assert.equal(f.calls.length, 1, '300ms recovery still bursts the API');
    await f.advance(1); await result;
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].method, 'GET');
});

test('explicit rejection remains terminal and releases the queue for an independent later action', async () => {
    const f = fixture((config, count) => count === 1 ? { status: 429, headers: {}, data: '' } : success(config));
    await assert.rejects(f.fetch(), { status: 429 });
    assert.equal(f.calls.length, 1); assert.equal(f.registrations.length, 1);
    const next = f.fetch(); await turn(); await f.advance(1000); await next;
    assert.equal(f.calls.length, 2);
});

for (const status of [403, 429]) {
    test(`HTTP ${status} also stops callers already waiting for the same source turn`, async () => {
        const held = deferred(), f = fixture((config, count) => count === 1 ? held.promise : success(config));
        const first = assert.rejects(f.fetch(), { status });
        const queued = assert.rejects(f.fetch(), { status });
        await turn(); held.resolve({ status, headers: {}, data: '' }); await first; await turn();
        await f.advance(1000); await queued;
        assert.equal(f.calls.length, 1); assert.equal(f.registrations.length, 1);
        assert.equal((await f.fetch()).url, 'https://qznovelvod.com/fixture.mp4', 'a new explicit action may retry');
    });
}

test('an explicit registration refusal stops queued registrations without poisoning a later retry', async () => {
    const error = Object.assign(new Error('registration refused'), { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: 'BUSINESS_REJECTED' });
    const f = fixture(undefined, error);
    const first = assert.rejects(f.fetch(), { code: error.code }), queued = assert.rejects(f.fetch(), { code: error.code });
    await first; await queued;
    assert.equal(f.registrations.length, 1); assert.equal(f.calls.length, 0);
    await f.advance(1000); await f.fetch();
    assert.equal(f.registrations.length, 2); assert.equal(f.calls.length, 1);
});

for (const route of ['model', 'fallback']) {
    test(`a ${route} business refusal stops already queued requests without a status field`, async () => {
        const requests = route === 'model' ? 1 : 2;
        const f = fixture((config, count) => {
            if (route === 'fallback' && count === 1) return { status: 200, headers: {}, data: JSON.stringify({
                code: 0, data: { '11': { video_model: { fallback_api: 'https://fqnovel.com/fallback' } } },
            }) };
            if (count === requests) return { status: 200, headers: {}, data: '{"code":100103}' };
            return success(config);
        });
        const first = assert.rejects(f.fetch(), error => error.code === 'BUSINESS_REJECTED' && error.status === undefined);
        const queued = f.fetch().then(value => ({ value }), error => ({ error }));
        await first; await turn(); await f.advance(1000);
        assert.equal((await queued).error?.code, 'BUSINESS_REJECTED', 'queued work must retain the refusal');
        assert.equal(f.calls.length, requests); assert.equal(f.registrations.length, 1);
        assert.equal((await f.fetch()).url, 'https://qznovelvod.com/fixture.mp4', 'a later explicit retry remains available');
    });
}
