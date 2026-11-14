const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getEventListeners } = require('node:events');
const { desktop, info, outcome, boundedOutcome, turn } = require('./fixtures/desktop-source.cjs');
const opts = signal => ({ quality: '1080p', signal });

test('desktop consumers share native lookup; canceling one preserves the other consumer', async t => {
    const h = desktop(t), a = h.controller(), b = h.controller(); let consumed = 0;
    const first = outcome(h.recover('11', '100', opts(a.signal), async () => ++consumed));
    const second = outcome(h.recover('11', '100', opts(b.signal), async () => ++consumed));
    await turn();
    assert.equal(h.calls.length, 1);
    assert.ok(h.lookups[0].signal instanceof AbortSignal);
    assert.notEqual(h.lookups[0].signal, h.lookups[1].signal);
    a.abort(); assert.equal((await boundedOutcome(first)).error?.code, 'ERR_CANCELED');
    assert.equal(h.calls[0].signal.aborted, false);
    h.calls[0].resolve(info('11'));
    assert.equal((await second).value, 1); assert.equal(consumed, 1);
    assert.equal(getEventListeners(a.signal, 'abort').length, 0);
    assert.equal(getEventListeners(b.signal, 'abort').length, 0);
});

test('online session release preserves another session sharing its preparation', async t => {
    const h = desktop(t);
    const payload = requestId => ({ vid: '11', seriesId: '100', quality: '1080p', requestId });
    const first = h.handlers['prepare-online-play']({}, payload('a'));
    const second = h.handlers['prepare-online-play']({}, payload('b'));
    await turn(); assert.equal(h.calls.length, 1);
    const job = [...h.run('onlinePreparing').values()][0];
    await h.handlers['release-online-play']({}, { requestId: 'a' });
    assert.equal(job.controller.signal.aborted, false); assert.equal(h.calls[0].signal.aborted, false);
    h.calls[0].resolve(info('11'));
    assert.equal((await first).success, false); assert.equal((await second).success, true);
});

test('last online session cancels source and a late result cannot restore sessions/preparation/cache', async t => {
    const h = desktop(t);
    const payload = requestId => ({ vid: '11', seriesId: '100', quality: '1080p', requestId });
    const first = h.handlers['prepare-online-play']({}, payload('a'));
    const second = h.handlers['prepare-online-play']({}, payload('b'));
    await turn();
    await h.handlers['release-online-play']({}, { requestId: 'a' });
    await h.handlers['release-online-play']({}, { requestId: 'b' }); await turn();
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal((await first).success, false); assert.equal((await second).success, false);
    h.calls[0].resolve(info('11', 'late')); await turn();
    assert.equal(h.run('onlineSessions.size + onlinePreparing.size + onlineCache.size'), 0);
});

for (const shared of [false, true]) test(`lookup timeout releases only its consumer, allows recovery, shared=${shared}`, async t => {
    const h = desktop(t), parent = h.controller(); let consumed = 0;
    const independent = shared ? h.native.fetchPlayUrlSingle('11', '100', { quality: '1080p' }) : null;
    const result = outcome(h.recover('11', '100', opts(parent.signal), async candidate => { consumed++; return candidate.url; }));
    await turn(); assert.equal(h.calls.length, 1);
    await h.expireLookup(t);
    assert.equal(h.lookups[0].signal?.aborted, true, '30s wait must release its provider consumer');
    assert.equal(h.calls[0].signal.aborted, !shared);
    assert.equal(parent.signal.aborted, false, 'lookup timeout must not abort the job');
    await new Promise(resolve => setTimeout(resolve, 5)); await turn();
    assert.equal(h.calls.length, 2); assert.equal(h.lookups[1].force, true);
    assert.equal(h.calls[1].signal.aborted, false);
    h.calls[0].resolve(info('11', 'late'));
    if (shared) assert.equal((await independent).url, info('11', 'late').url);
    h.calls[1].resolve(info('11', 'new'));
    assert.equal((await result).value, info('11', 'new').url); assert.equal(consumed, 1);
    assert.equal(parent.signal.aborted, false);
    assert.equal((await h.native.fetchPlayUrlSingle('11', '100', { quality: '1080p' })).url, info('11', 'new').url);
});

test('all lookup timeouts abort each exclusive source and remain bounded to three recovery rounds', async t => {
    const h = desktop(t), parent = h.controller(); let consumed = 0;
    const result = outcome(h.recover('11', '100', opts(parent.signal), async () => { consumed++; }));
    for (let round = 0; round < 3; round++) {
        await turn(); assert.equal(h.calls.length, round + 1);
        await h.expireLookup(t);
        assert.equal(h.calls[round].signal.aborted, true);
        assert.equal(parent.signal.aborted, false);
        await new Promise(resolve => setTimeout(resolve, 5)); await turn();
    }
    const error = (await result).error;
    assert.equal(error.code, 'MEDIA_TRANSFER_ERROR'); assert.equal(error.mediaRetryable, true);
    assert.equal(consumed, 0); assert.equal(h.lookups.length, 3);
    for (const call of h.calls) call.resolve(info('11', 'late'));
    await new Promise(resolve => setTimeout(resolve, 5)); await turn(); assert.equal(h.calls.length, 3);
});

test('pre-canceled job never invokes provider or consumes existing playInfo', async t => {
    const h = desktop(t), parent = h.controller(); parent.abort();
    const result = await outcome(h.recover('11', '100', { ...opts(parent.signal), playInfo: info('11') },
        async () => assert.fail('canceled job cannot consume')));
    assert.equal(result.error.code, 'ERR_CANCELED'); assert.equal(h.lookups.length, 0);
});

test('existing playInfo keeps the original no-lookup path and cleans job listeners', async t => {
    const h = desktop(t), parent = h.controller();
    assert.equal(await h.recover('11', '100', { ...opts(parent.signal), playInfo: info('11') }, async candidate => candidate.url), info('11').url);
    assert.equal(h.lookups.length, 0); assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});
