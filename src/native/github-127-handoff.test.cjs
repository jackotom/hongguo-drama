// Same-realm reproduction of Astra R1: cancel after requestJson's response check.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const response = data => ({ status: 200, headers: {}, data: JSON.stringify(data) });
const model = { video_id: 'synthetic-video', video_duration: 60, video_list: [{
    main_url: 'https://qznovelvod.com/synthetic.mp4', codec_type: 'h264',
    vwidth: 1080, vheight: 1920, encrypt_info: { encrypt: false },
}] };
const fallback = 'https://vod.snssdk.com/info';

for (const [target, depth] of [['model', 2], ['fallback', 2], ['encryption-metadata', 2],
    ['fallback', 3], ['encryption-metadata', 3], ['alternate', 2], ['registration', 2]]) {
    test(`same-realm ${target} handoff rejects cancellation at microtask ${depth}`, async () => {
        const controller = new AbortController(), modules = new Map();
        let calls = 0, canceledCalls = 0, armed = true;
        const stages = [];
        const cancelAfterHandoff = remaining => queueMicrotask(() => {
            if (remaining > 1) cancelAfterHandoff(remaining - 1);
            else {
                canceledCalls = calls;
                controller.abort(new Error('PRIVATE_CANCEL_SENTINEL'));
            }
        });
        function transport(config) {
            const url = new URL(config.url);
            if (url.pathname === '/reading/bookapi/video_tab/multi_video_model/v1/') {
                return Promise.resolve({ status: 200, headers: {}, data: '' });
            }
            if (url.pathname === '/novel/player/multi_video_model/preload/v1') {
                return Promise.resolve({ status: 200, headers: {}, data: '' });
            }
            calls++;
            let stage;
            if (url.pathname.includes('device_register')) stage = 'registration';
            else if (config.url === fallback) stage = 'metadata';
            else {
                assert.equal(config.method, 'POST');
                assert.equal(url.pathname, '/novel/player/multi_video_model/player/v1');
                assert.ok(['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-sinfonlinea.fqnovel.com'].includes(url.hostname));
                stage = url.hostname === 'api5-normal-sinfonlineb.fqnovel.com' ? 'primary' : 'alternate';
            }
            stages.push(stage);
            if (stage === 'registration') {
                if (armed && target === 'registration') { armed = false; cancelAfterHandoff(depth); }
                return Promise.resolve(response({ device_id: '123', install_id: '456' }));
            }
            if (armed && stage === 'primary' && target === 'alternate') {
                return Promise.resolve({ status: 200, headers: {}, data: '' });
            }
            if (armed && stage === 'primary' && ['fallback', 'encryption-metadata'].includes(target)) {
                const initial = target === 'fallback' ? { fallback_api: fallback }
                    : { ...model, fallback_api: fallback, video_list: [{ ...model.video_list[0], encrypt_info: undefined }] };
                return Promise.resolve(response({ data: { '11': { video_model: initial } } }));
            }
            if (armed) { armed = false; cancelAfterHandoff(depth); }
            return Promise.resolve(response(config.url === fallback ? { video_info: { data: model } }
                : { data: { '11': { video_model: model } } }));
        }
        function local(name) {
            if (name === 'axios') return transport;
            if (!name.startsWith('.')) return require(name);
            const filename = require.resolve(path.join(__dirname, name));
            if (!['app-source.js', 'playback-device.js'].includes(path.basename(filename))) return require(filename);
            if (!modules.has(filename)) {
                const module = { exports: {} };
                modules.set(filename, module);
                new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(local, module, module.exports);
            }
            return modules.get(filename).exports;
        }
        const api = local('./app-source');
        await assert.rejects(api.fetchAppPlayUrl('11', { signal: controller.signal }), error => {
            assert.equal(error.code, 'ERR_CANCELED');
            assert.equal(error.registrationFailure, undefined);
            assert.doesNotMatch(error.stack + JSON.stringify(error), /PRIVATE_CANCEL_SENTINEL/);
            return true;
        });
        assert.equal(controller.signal.aborted, true);
        assert.equal(calls, canceledCalls, 'no request may start after handoff cancellation');
        const expectedStages = target === 'registration' ? ['registration'] : target === 'model'
            ? ['registration', 'primary'] : target === 'alternate'
                ? ['registration', 'primary', 'primary', 'alternate'] : ['registration', 'primary', 'metadata'];
        assert.deepEqual(stages, expectedStages, 'cancellation must occur at the intended response handoff');
        assert.equal(calls, expectedStages.length);
        const beforeRecovery = calls;
        assert.equal((await api.fetchAppPlayUrl('11')).source, 'app', 'same module still accepts an independent no-signal lookup');
        const recoveryStages = target === 'registration' ? ['registration', 'primary'] : ['primary'];
        assert.equal(calls, beforeRecovery + recoveryStages.length, 'recovery reuses a completed identity');
        assert.deepEqual(stages.slice(beforeRecovery), recoveryStages);
    });
}
