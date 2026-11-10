const assert = require('node:assert/strict');
const { test } = require('node:test');
const { deferred, loadNative, loadMedia, info, turn } = require('../src/native/hongguo-cancellation-fixture.cjs');
const task = { seriesId: '1', vid: '11', episodeIndex: 1, quality: '1080p' };
const store = { output: () => '/synthetic/unwritten.mp4', directory: () => { throw new Error('UNEXPECTED_MEDIA_WRITE'); } };
const detail = { series_id: '1', total: 1, episodes: [{ vid: '11', vid_index: 1 }] };

test('Docker pre-cancellation starts neither directory lookup nor source preparation', async () => {
    let calls = 0;
    const media = loadMedia({ fetchEpisodeList: async () => { calls++; return detail; }, fetchPlayUrlSingle: () => assert.fail('no lookup') });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(media.download(task, store, controller.signal, () => {}), { code: 'ERR_CANCELED' });
    assert.equal(calls, 0);
});

for (const shared of [false, true]) test(`Docker source cancellation releases its consumer only, shared=${shared}`, async () => {
    const entered = deferred(), pending = deferred(); let signal, calls = 0;
    const native = loadNative({ appFetch(_vid, config) { calls++; signal = config.signal; entered.resolve(); return pending.promise; } });
    native.fetchEpisodeList = async () => detail;
    const media = loadMedia(native), controller = new AbortController();
    const independent = shared ? native.fetchPlayUrlSingle('11', '1', { quality: '1080p' }) : null;
    const outcome = media.download(task, store, controller.signal, () => {}).then(() => null, error => error);
    await entered.promise; await turn();
    try {
        controller.abort();
        const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve({ code: 'CANCEL_NOT_DELIVERED' }), 200))]);
        assert.equal(result.code, 'ERR_CANCELED'); assert.equal(signal.aborted, !shared);
        pending.resolve(info('independent'));
        if (shared) assert.equal((await independent).source, 'app');
        assert.equal(calls, 1);
    } finally { pending.resolve(info('cleanup')); await Promise.all([outcome, independent]); }
});

test('Docker ignores success handed back after cancellation before starting any file work', async () => {
    let received;
    const controller = new AbortController();
    const media = loadMedia({ fetchEpisodeList: async () => detail, fetchPlayUrlSingle: async (_vid, _sid, options) => {
        received = options.signal; controller.abort(); return info('late');
    } });
    await assert.rejects(media.download(task, store, controller.signal, () => {}), { code: 'ERR_CANCELED' });
    assert.equal(received, controller.signal);
});
