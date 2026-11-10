const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getEventListeners } = require('node:events');
const http = require('node:http');
const axios = require('axios');
const { deferred, loadNative, info, turn } = require('./hongguo-cancellation-fixture.cjs');
const options = signal => ({ quality: '1080p', signal });
const canceled = promise => Promise.race([promise,
    new Promise(resolve => setTimeout(() => resolve({ code: 'CANCEL_NOT_DELIVERED' }), 200))]);

function controlled() {
    const calls = [];
    const native = loadNative({ appFetch: (_vid, config) => {
        const pending = deferred(); calls.push({ ...pending, signal: config.signal }); return pending.promise;
    } });
    return { native, calls };
}

test('pre-canceled consumers neither start requests nor remove a valid cache hit', async () => {
    const f = controlled(), controller = new AbortController(); controller.abort();
    assert.equal((await canceled(f.native.fetchPlayUrlSingle('11', '1', options(controller.signal)))).code, 'ERR_CANCELED');
    assert.equal(f.calls.length, 0);
    const first = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
    f.calls[0].resolve(info('cached')); await first;
    assert.equal((await f.native.fetchPlayUrlSingle('11', '1', options(controller.signal))).code, 'ERR_CANCELED');
    assert.equal((await f.native.fetchPlayUrlSingle('11', '1', options())).url, info('cached').url);
    assert.equal(f.calls.length, 1);
});

test('synchronous final cancellation stops the deferred provider before any transport starts', async () => {
    const f = controlled(), controller = new AbortController();
    const result = f.native.fetchPlayUrlSingle('11', '1', options(controller.signal));
    controller.abort(); assert.equal((await result).code, 'ERR_CANCELED');
    await turn(); assert.equal(f.calls.length, 0);
});

test('directory API keeps its old no-signal concurrency and successful cache reuse', async () => {
    let gets = 0;
    const page = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
        'player_(series_id)/(vid)/page': { vid: '11', series_id: '1', seriesDetail: {
            series_id: '1', vid_list: ['11', '12'], series_name: 'synthetic',
        }, publicVideoSeo: { available: true, itemId: '11', seriesId: '1' } },
    } })}</script>`;
    const native = loadNative({ axios: {
        get: async () => { gets++; return { data: page }; },
        post: () => assert.fail('valid web directory must not reach legacy API'),
    } });
    const [a, b] = await Promise.all([native.fetchEpisodeList('1'), native.fetchEpisodeList('1')]);
    assert.equal(a.total, 2); assert.equal(a, b); assert.equal(gets, 2);
    assert.equal(await native.fetchEpisodeList('1'), a); assert.equal(gets, 2);
});

for (const oldWithoutSignal of [false, true]) {
    test(`cancel one consumer preserves the other, including no-signal=${oldWithoutSignal}`, async () => {
        const f = controlled(), a = new AbortController(), b = new AbortController();
        const first = f.native.fetchPlayUrlSingle('11', '1', options(a.signal));
        const second = f.native.fetchPlayUrlSingle('11', '1', options(oldWithoutSignal ? undefined : b.signal));
        await turn();
        try {
            assert.equal(f.calls.length, 1);
            assert.ok(f.calls[0].signal instanceof AbortSignal);
            assert.notEqual(f.calls[0].signal, a.signal);
            a.abort();
            assert.equal((await canceled(first)).code, 'ERR_CANCELED');
            assert.equal(f.calls[0].signal.aborted, false);
            f.calls[0].resolve(info('shared'));
            assert.equal((await second).url, info('shared').url);
            assert.equal((await f.native.fetchPlayUrlSingle('11', '1', options())).url, info('shared').url);
            assert.equal(f.calls.length, 1);
            assert.equal(getEventListeners(a.signal, 'abort').length, 0);
            assert.equal(getEventListeners(b.signal, 'abort').length, 0);
        } finally { f.calls.forEach(call => call.resolve(info('cleanup'))); }
    });
}

test('last consumer aborts the owned request; an ignored late success cannot poison recovery/cache', async () => {
    const f = controlled(), a = new AbortController(), b = new AbortController();
    const first = f.native.fetchPlayUrlSingle('11', '1', options(a.signal));
    const second = f.native.fetchPlayUrlSingle('11', '1', options(b.signal));
    await turn();
    try {
        a.abort(); b.abort();
        assert.equal((await canceled(first)).code, 'ERR_CANCELED'); assert.equal((await canceled(second)).code, 'ERR_CANCELED');
        assert.equal(f.calls[0].signal.aborted, true);
        const recovered = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
        assert.equal(f.calls.length, 2);
        f.calls[0].resolve(info('late')); await turn();
        const joined = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
        assert.equal(f.calls.length, 2);
        f.calls[1].resolve(info('recovered'));
        assert.equal((await recovered).url, info('recovered').url);
        assert.equal((await joined).url, info('recovered').url);
        assert.equal((await f.native.fetchPlayUrlSingle('11', '1', options())).url, info('recovered').url);
    } finally { f.calls.forEach(call => call.resolve(info('cleanup'))); }
});

for (const oldFirst of [true, false]) {
    test(`force preserves separate request ownership/cache when oldFirst=${oldFirst}`, async () => {
        const f = controlled();
        const old = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
        const fresh = f.native.fetchPlayUrlSingle('11', '1', { ...options(), force: true }); await turn();
        try {
            assert.equal(f.calls.length, 2);
            assert.equal(f.calls[0].signal.aborted, false);
            if (oldFirst) { f.calls[0].resolve(info('old')); await old; }
            const joined = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
            assert.equal(f.calls.length, 2);
            f.calls[1].resolve(info('new')); await fresh;
            if (!oldFirst) { f.calls[0].resolve(info('old')); await old; }
            assert.equal((await joined).url, info('new').url);
            assert.equal((await f.native.fetchPlayUrlSingle('11', '1', options())).url, info('new').url);
        } finally { f.calls.forEach(call => call.resolve(info('cleanup'))); }
    });
}

test('canceling forced request does not abort old consumers or give the old request cache ownership', async () => {
    const f = controlled(), controller = new AbortController();
    const old = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
    const fresh = f.native.fetchPlayUrlSingle('11', '1', { ...options(controller.signal), force: true }); await turn();
    try {
        controller.abort(); assert.equal((await canceled(fresh)).code, 'ERR_CANCELED');
        assert.equal(f.calls[1].signal.aborted, true); assert.equal(f.calls[0].signal.aborted, false);
        f.calls[0].resolve(info('old')); await old;
        const replacement = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
        assert.equal(f.calls.length, 3);
        f.calls[2].resolve(info('replacement')); assert.equal((await replacement).url, info('replacement').url);
    } finally { f.calls.forEach(call => call.resolve(info('cleanup'))); }
});

test('failure is not cached and old directory no-signal calls still share/cache successfully', async () => {
    const f = controlled();
    const failed = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
    f.calls[0].reject({ code: 'BUSINESS_REJECTED' }); assert.equal((await failed).code, 'SOURCE_UNAVAILABLE');
    const recovered = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
    f.calls[1].resolve(info('ok')); assert.equal((await recovered).source, 'app');
    const pending = deferred(); let loads = 0;
    const load = () => { loads++; return pending.promise; };
    const a = f.native.cachedRequest('episodes:1', 60000, load), b = f.native.cachedRequest('episodes:1', 60000, load);
    await turn(); assert.equal(loads, 1); const detail = { total: 2 }; pending.resolve(detail);
    assert.equal(await a, detail); assert.equal(await b, detail);
    assert.equal(await f.native.cachedRequest('episodes:1', 60000, load), detail); assert.equal(loads, 1);
});

test('canceling old consumers preserves the forced request and its pending/cache ownership', async () => {
    const f = controlled(), controller = new AbortController();
    const old = f.native.fetchPlayUrlSingle('11', '1', options(controller.signal)); await turn();
    const fresh = f.native.fetchPlayUrlSingle('11', '1', { ...options(), force: true }); await turn();
    try {
        controller.abort(); assert.equal((await canceled(old)).code, 'ERR_CANCELED');
        assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls[1].signal.aborted, false);
        const joined = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
        assert.equal(f.calls.length, 2);
        f.calls[0].resolve(info('old')); f.calls[1].resolve(info('forced'));
        assert.equal((await fresh).url, info('forced').url); assert.equal((await joined).url, info('forced').url);
        assert.equal((await f.native.fetchPlayUrlSingle('11', '1', options())).url, info('forced').url);
    } finally { f.calls.forEach(call => call.resolve(info('cleanup'))); }
});

for (const quality of ['1080p', 'auto']) test(`same-realm ${quality} result handoff cannot revive a canceled consumer or fill cache`, async () => {
    const controller = new AbortController(); let calls = 0;
    const native = loadNative({ axios: { get: () => Promise.reject({ code: 'ENOTFOUND' }) },
        appFetch() {
            calls++;
            if (calls === 1) queueMicrotask(() => queueMicrotask(() => controller.abort()));
            return Promise.resolve(info(String(calls)));
        },
    });
    assert.equal((await native.fetchPlayUrlSingle('11', '1', { quality, signal: controller.signal })).code, 'ERR_CANCELED');
    assert.equal((await native.fetchPlayUrlSingle('11', '1', { quality })).url, info('2').url);
    assert.equal(calls, 2);
});

test('caller timeout remains ETIMEDOUT and does not abort a live independent consumer', async () => {
    const f = controlled(), controller = new AbortController();
    const timed = f.native.fetchPlayUrlSingle('11', '1', options(controller.signal));
    const independent = f.native.fetchPlayUrlSingle('11', '1', options()); await turn();
    try {
        controller.abort(Object.assign(new Error('PRIVATE_TIMEOUT_SENTINEL'), { name: 'TimeoutError' }));
        const result = await timed;
        assert.equal(result.code, 'ETIMEDOUT'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TIMEOUT_SENTINEL/);
        assert.equal(f.calls[0].signal.aborted, false);
        f.calls[0].resolve(info('independent')); assert.equal((await independent).source, 'app');
    } finally { f.calls.forEach(call => call.resolve(info('cleanup'))); }
});

for (const stage of ['web-first', 'web-second', 'app', 'legacy', 'web-final']) {
    test(`auto cancellation reaches ${stage} and does not request a subsequent source`, async () => {
        const entered = deferred(), pending = deferred(), controller = new AbortController(), calls = [];
        const hold = signal => { entered.resolve(signal); return pending.promise; };
        const native = loadNative({ axios: {
            get(url, config) {
                const current = stage === 'web-final' ? 'web-final' : url.includes('/_/') ? 'web-second' : 'web-first';
                calls.push(current); assert.equal(config.timeout, 4000);
                if (stage === current) return hold(config.signal);
                return Promise.reject({ code: 'ENOTFOUND' });
            },
            post(_url, _body, config) {
                calls.push('legacy'); assert.equal(config.timeout, 6000);
                if (stage === 'legacy') return hold(config.signal);
                return Promise.reject({ code: 'ETIMEDOUT' });
            },
        }, appFetch(_vid, config) {
            calls.push('app'); if (stage === 'app') return hold(config?.signal);
            return Promise.reject({ code: 'ERR_NETWORK' });
        } });
        if (stage === 'web-final') native.markWebMediaFailure({ source: 'web', vid: '11' });
        const result = native.fetchPlayUrlSingle('11', '1', { signal: controller.signal });
        const signal = await entered.promise;
        try {
            assert.ok(signal instanceof AbortSignal);
            controller.abort(); assert.equal((await result).code, 'ERR_CANCELED'); assert.equal(signal.aborted, true);
            const count = calls.length; pending.reject({ code: 'ERR_CANCELED' }); await turn();
            assert.equal(calls.length, count);
        } finally { pending.reject({ code: 'ERR_CANCELED' }); await result; }
    });
}

test('shared native consumers cancel a real axios registration socket only after the final release', { timeout: 3000 }, async () => {
    const entered = deferred(), closed = deferred(); let response, hits = 0;
    const server = http.createServer((request, res) => {
        request.resume(); response = res; hits++; res.on('close', closed.resolve); entered.resolve();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const native = loadNative({ axios: config => axios({ ...config,
        url: `http://127.0.0.1:${server.address().port}/registration`, proxy: false }) });
    const a = new AbortController(), b = new AbortController();
    const first = native.fetchPlayUrlSingle('11', '1', options(a.signal));
    const second = native.fetchPlayUrlSingle('11', '1', options(b.signal));
    try {
        await entered.promise; a.abort(); assert.equal((await canceled(first)).code, 'ERR_CANCELED');
        assert.equal(response.destroyed, false); assert.equal(hits, 1);
        b.abort(); assert.equal((await second).code, 'ERR_CANCELED');
        await closed.promise; assert.equal(hits, 1);
    } finally {
        a.abort(); b.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await Promise.all([first, second]);
    }
});
