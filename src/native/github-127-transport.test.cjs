// Offline: real axios sockets, synthetic responses, no upstream registration or media.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const axios = require('axios');
const { setTimeout: delay } = require('node:timers/promises');

const vid = '11';
const metadata = 'https://vod.snssdk.com/info';
const model = (inline = true) => ({ video_id: 'synthetic-video', video_duration: 60,
    fallback_api: metadata, ...(inline ? { video_list: [{ codec_type: 'h264', vwidth: 1080, vheight: 1920,
        main_url: 'https://qznovelvod.com/synthetic.mp4', encrypt_info: { encrypt: false } }] } : {}) });

function load(transport) {
    const cache = new Map();
    function local(name) {
        if (name === 'axios') return transport;
        if (!name.startsWith('./')) return require(name);
        const file = require.resolve(path.join(__dirname, name));
        if (!['app-source.js', 'playback-device.js'].includes(path.basename(file))) return require(file);
        if (!cache.has(file)) {
            const module = { exports: {} };
            cache.set(file, module);
            vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: local,
                Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout }, { filename: file });
        }
        return cache.get(file).exports;
    }
    return local('./app-source');
}

for (const target of ['registration', 'model', 'renewal', 'alternate', 'video-tab', 'fallback', 'encryption-metadata']) {
    test(`caller cancellation closes the real axios socket during ${target}`, { timeout: 3000 }, async () => {
        const stages = [];
        let registrations = 0, enter, closed;
        const entered = new Promise(resolve => { enter = resolve; });
        const disconnected = new Promise(resolve => { closed = resolve; });
        const server = http.createServer((request, response) => {
            request.resume();
            const stage = request.url.slice(1);
            if (stage === target) {
                response.on('close', () => { if (!response.writableEnded) closed(); });
                enter();
                return;
            }
            const emptyModel = target === 'renewal' && ['model', 'alternate', 'video-tab'].includes(stage)
                || target === 'alternate' && stage === 'model'
                || target === 'video-tab' && ['model', 'alternate'].includes(stage);
            let data = stage === 'registration' || stage === 'renewal'
                ? { device_id: '123', install_id: '456' }
                : { code: 0, data: { [vid]: { video_model: model(!['fallback', 'encryption-metadata'].includes(target)) } } };
            if (target === 'encryption-metadata' && stage === 'model') {
                data.data[vid].video_model = model();
                delete data.data[vid].video_model.video_list[0].encrypt_info;
            }
            response.end(emptyModel ? '' : JSON.stringify(data));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const api = load(config => {
            const url = new URL(config.url);
            let stage;
            if (url.pathname.includes('device_register')) stage = ++registrations === 1 ? 'registration' : 'renewal';
            else if (config.url === metadata) stage = target;
            else if (url.pathname === '/reading/bookapi/video_tab/multi_video_model/v1/') {
                assert.equal(config.method, 'GET');
                stage = 'video-tab';
            }
            else {
                assert.equal(config.method, 'POST');
                assert.equal(url.pathname, '/novel/player/multi_video_model/player/v1');
                assert.ok(['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-sinfonlinea.fqnovel.com'].includes(url.hostname));
                stage = url.hostname === 'api5-normal-sinfonlineb.fqnovel.com' ? 'model' : 'alternate';
            }
            stages.push(stage);
            return axios({ ...config, url: `http://127.0.0.1:${server.address().port}/${stage}`, proxy: false });
        });
        const controller = new AbortController();
        const result = api.fetchAppPlayUrl(vid, { signal: controller.signal }).then(value => ({ value }), error => ({ error }));
        try {
            await Promise.race([entered, delay(1500).then(() => assert.fail('target stage was not reached'))]);
            controller.abort(new Error('PRIVATE_CANCEL_REASON'));
            const outcome = await Promise.race([result, delay(400).then(() => ({ error: { code: 'CANCEL_NOT_DELIVERED' } }))]);
            assert.equal(outcome.error?.code, 'ERR_CANCELED');
            assert.doesNotMatch(JSON.stringify(outcome.error) + outcome.error.stack, /PRIVATE_CANCEL_REASON/);
            await Promise.race([disconnected, delay(400).then(() => assert.fail('axios socket remained open'))]);
            assert.equal(stages.at(-1), target, 'cancellation must not trigger another registration or route');
            const expectedStages = target === 'registration' ? ['registration'] : target === 'model'
                ? ['registration', 'model'] : target === 'renewal'
                    ? ['registration', 'model', 'alternate', 'video-tab', 'renewal'] : target === 'video-tab'
                        ? ['registration', 'model', 'alternate', 'video-tab'] : ['registration', 'model', target];
            assert.deepEqual(stages, expectedStages, 'each cancellation target must be reached through its actual route');
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await result;
        }
    });
}

test('an already canceled lookup performs no registration or transport', async () => {
    let calls = 0;
    const api = load(async () => { calls++; return { status: 200, headers: {}, data: '{"device_id":"123","install_id":"456"}' }; });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(api.fetchAppPlayUrl(vid, { signal: controller.signal }), { code: 'ERR_CANCELED' });
    assert.equal(calls, 0);
});
