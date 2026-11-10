const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const success = { device_id: '123', install_id: '456' };
function device(clock = Date) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('./playback-device'), 'utf8'), { module, Buffer,
        Date: clock, AbortController, AbortSignal, setTimeout, clearTimeout, require: name =>
            require(name.startsWith('.') ? path.join(__dirname, name) : name) });
    return module.exports;
}
function sourceMapping() {
    const source = fs.readFileSync(require.resolve('./hongguo'), 'utf8');
    const context = vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('function sourceFailure('), source.indexOf('function unavailableSources(')), context);
    return context.sourceFailure;
}

test('empty playback responses retain transport evidence without guessing the cause', async () => {
    for (const data of ['', ' \r\n\t']) {
        const api = app(async () => ({ status: 200, headers: { 'x-tt-logid': 'PRIVATE_SENTINEL' }, data }));
        await assert.rejects(api.requestJson('https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/',
            { method: 'POST', data: Buffer.from('{}') }, Date.now() + 1000), error => {
            assert.equal(error.code, 'EMPTY_RESPONSE');
            assert.equal(error.status, 200);
            assert.match(error.message, /空响应.*HTTP 200/);
            assert.match(error.message, /原因尚未确认/);
            assert.doesNotMatch(error.stack + JSON.stringify(error), /签名|鉴权|请检查网络|PRIVATE_SENTINEL/);
            return true;
        });
    }
});

test('empty playback responses keep their classification through the public source entry', async () => {
    const { loadNative } = require('./hongguo-cancellation-fixture.cjs');
    let registrations = 0, models = 0;
    const native = loadNative({ axios: async config => {
        if (new URL(config.url).pathname.includes('device_register')) {
            registrations++;
            return response({ device_id: String(100 + registrations), install_id: '456' });
        }
        models++;
        return { status: 200, headers: { 'x-tt-logid': 'PRIVATE_SENTINEL' }, data: '' };
    } });
    const result = await native.fetchPlayUrlSingle('11', '22', { quality: '1080p' });
    assert.equal(result.url, null);
    assert.equal(result.code, 'SOURCE_UNAVAILABLE');
    assert.deepEqual(result.sources.map(item => item.code), ['EMPTY_RESPONSE']);
    assert.match(result.error, /所选清晰度 1080p，未降级/);
    assert.match(result.error, /空响应.*原因尚未确认/);
    assert.doesNotMatch(JSON.stringify(result), /签名|鉴权|请检查网络|PRIVATE_SENTINEL/);
    assert.equal(registrations, 2, 'retain exactly one existing registration recovery');
    assert.equal(models, 2, 'retain exactly one existing alternate-host attempt');
});

function app(transport, clock = Date) {
    const module = { exports: {} }, registration = device(clock);
    vm.runInNewContext(fs.readFileSync(require.resolve('./app-source'), 'utf8'), { module, Buffer, URL,
        Date: clock, AbortController, AbortSignal, setTimeout, clearTimeout, require(name) {
            if (name === 'axios') return transport;
            if (name === './playback-device') return registration;
            return require(name.startsWith('.') ? path.join(__dirname, name) : name);
        } });
    return { ...module.exports, ...registration };
}
const response = data => ({ status: 200, headers: {}, data: JSON.stringify(data) });
const playModel = { video_id: 'synthetic-video', video_duration: 60, video_list: [{
    main_url: 'https://qznovelvod.com/synthetic.mp4', codec_type: 'h264', vwidth: 1080, vheight: 1920,
    encrypt_info: { encrypt: false },
}] };
const playResponse = () => response({ code: 0, data: { '11': { video_model: playModel } } });

test('registration retains the old protocol and adds only whitelisted DNS/connection/TLS details', async () => {
    const map = sourceMapping();
    for (const [code, detail] of [['ENOTFOUND', 'DNS'], ['EAI_AGAIN', 'DNS'], ['ECONNRESET', 'CONNECTION'],
        ['ECONNREFUSED', 'CONNECTION'], ['EHOSTUNREACH', 'CONNECTION'], ['ENETUNREACH', 'CONNECTION'], ['EPIPE', 'CONNECTION'],
        ['CERT_HAS_EXPIRED', 'TLS'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS'],
        ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS']]) {
        let calls = 0;
        const api = device();
        const request = async () => { calls++; throw Object.assign(new Error('PRIVATE_SENTINEL'), {
            code, config: { headers: { Authorization: 'PRIVATE_SENTINEL' } }, response: { data: 'PRIVATE_SENTINEL' },
            cause: new Error('PRIVATE_SENTINEL'), networkFailure: 'PRIVATE_SENTINEL' }); };
        for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(api.registerPlaybackDevice(request), error => {
                assert.equal(error.code, 'DEVICE_REGISTRATION_FAILED');
                assert.equal(error.registrationFailure, 'NETWORK_ERROR');
                assert.equal(error.networkFailure, detail);
                assert.deepEqual(Object.keys(error).sort(), ['code', 'networkFailure', 'registrationFailure']);
                assert.doesNotMatch(error.stack + JSON.stringify(error), /PRIVATE_SENTINEL/);
                const mapped = map('app', error);
                assert.equal(mapped.code, 'NETWORK_ERROR');
                assert.equal(mapped.networkFailure, detail);
                assert.doesNotMatch(JSON.stringify(mapped), /PRIVATE_SENTINEL/);
                assert.match(mapped.message, /DNS|连接|TLS/);
                return true;
            });
        }
        assert.equal(calls, 1, 'real failure still enters the ten-second cooldown');
    }
});

test('active and late registration cancellation do not poison cooldown or shared identity', async () => {
    for (const late of [false, true]) {
        const api = device();
        const shared = await api.getPlaybackDevice(async () => success);
        const controller = new AbortController();
        await assert.rejects(api.registerPlaybackDevice(async (_url, _options, _deadline, signal) => {
            controller.abort(new Error('PRIVATE_SENTINEL'));
            if (late) return success;
            assert.equal(signal.aborted, true);
            throw Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'ERR_CANCELED' });
        }, { signal: controller.signal }), error => {
            assert.equal(error.code, 'ERR_CANCELED');
            assert.equal(error.registrationFailure, undefined);
            assert.doesNotMatch(error.stack + JSON.stringify(error), /PRIVATE_SENTINEL/);
            return true;
        });
        assert.equal(await api.getPlaybackDevice(() => assert.fail('shared identity must survive')), shared);
        assert.equal((await api.registerPlaybackDevice(async () => success)).device_id, '123');
    }
});

test('pre-cancellation wins over an existing failure cooldown', async () => {
    const api = device();
    await assert.rejects(api.registerPlaybackDevice(async () => { throw { code: 'ETIMEDOUT' }; }), { registrationFailure: 'TIMEOUT' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.registerPlaybackDevice(() => assert.fail('no new transport'), { signal: controller.signal }), { code: 'ERR_CANCELED' });
});

test('HTTP/business/security and unknown errors keep their existing safe cooldown classification', async () => {
    for (const [input, reason] of [[{ code: 'ETIMEDOUT' }, 'TIMEOUT'],
        [{ status: 403 }, 'HTTP_403'], [{ status: 429 }, 'HTTP_429'], [{ code: 'BUSINESS_REJECTED' }, 'BUSINESS_REJECTED'],
        [{ code: 'SECURITY_BLOCKED' }, 'SECURITY_BLOCKED'], [{ code: 'PRIVATE_SENTINEL', networkFailure: 'PRIVATE_SENTINEL' }, 'UNKNOWN']]) {
        await assert.rejects(device().registerPlaybackDevice(async () => { throw input; }), error => {
            assert.equal(error.registrationFailure, reason);
            assert.equal(error.networkFailure, undefined);
            assert.doesNotMatch(error.stack + JSON.stringify(error), /PRIVATE_SENTINEL/);
            return true;
        });
    }
    const mapped = sourceMapping()('app', { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: 'NETWORK_ERROR', networkFailure: 'PRIVATE_SENTINEL' });
    assert.equal(mapped.networkFailure, undefined);
    assert.doesNotMatch(JSON.stringify(mapped), /PRIVATE_SENTINEL/);
});

test('raw transport cancellation is sanitized and never starts registration cooldown', async () => {
    const api = device();
    await assert.rejects(api.registerPlaybackDevice(async () => { throw Object.assign(new Error('PRIVATE_SENTINEL'), {
        code: 'ERR_CANCELED', config: { url: 'PRIVATE_SENTINEL' },
    }); }), error => {
        assert.equal(error.code, 'ERR_CANCELED');
        assert.equal(error.registrationFailure, undefined);
        assert.doesNotMatch(error.stack + JSON.stringify(error), /PRIVATE_SENTINEL/);
        return true;
    });
    assert.equal((await api.registerPlaybackDevice(async () => success)).device_id, '123');
});

test('actual request boundary sanitizes network errors and still supports no signal', async () => {
    for (const [code, detail] of [['ENOTFOUND', 'DNS'], ['ECONNREFUSED', 'CONNECTION'], ['CERT_HAS_EXPIRED', 'TLS'],
        ['ETIMEDOUT', undefined], ['ERR_NETWORK', undefined], ['PRIVATE_SENTINEL', undefined]]) {
        const api = app(async () => { throw Object.assign(new Error('PRIVATE_SENTINEL'), {
            code, cause: { config: 'PRIVATE_SENTINEL' }, response: 'PRIVATE_SENTINEL',
        }); });
        await assert.rejects(api.requestJson('https://vod.snssdk.com/info', {}, Date.now() + 1000), error => {
            assert.equal(error.code, code === 'PRIVATE_SENTINEL' ? 'ERR_NETWORK' : code);
            assert.equal(error.networkFailure, detail);
            assert.doesNotMatch(error.stack + JSON.stringify(error), /PRIVATE_SENTINEL/);
            if (detail) assert.equal(sourceMapping()('app', error).networkFailure, detail);
            return true;
        });
    }
});

test('late model, metadata and redirect responses cannot return success or start a fallback', async () => {
    for (const target of ['registration', 'model', 'metadata', 'redirect']) {
        const controller = new AbortController();
        let calls = 0;
        const api = app(async config => {
            calls++;
            if (calls === 1) {
                if (target === 'registration') controller.abort();
                return response(success);
            }
            if (target === 'model' || target === 'redirect') controller.abort();
            if (target === 'redirect') return { status: 302, headers: { location: 'https://vod.snssdk.com/late' }, data: '' };
            if (target === 'metadata') {
                if (calls === 2) return response({ data: { '11': { video_model: { fallback_api: 'https://vod.snssdk.com/info' } } } });
                controller.abort();
                return response({ video_info: { data: playModel } });
            }
            return playResponse();
        });
        await assert.rejects(api.fetchAppPlayUrl('11', { signal: controller.signal }), { code: 'ERR_CANCELED' });
        assert.equal(calls, target === 'registration' ? 1 : target === 'metadata' ? 3 : 2);
    }
});

test('canceling one lookup leaves another lookup and shared search/account registration alive', async () => {
    const controller = new AbortController();
    let calls = 0, modelCalls = 0, independentSignal;
    const api = app(async config => {
        calls++;
        if (new URL(config.url).pathname.includes('device_register')) return response(success);
        modelCalls++;
        if (modelCalls === 1) {
            controller.abort();
            return playResponse();
        }
        independentSignal = config.signal;
        const requested = JSON.parse(config.headers['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(config.data) : config.data).mixed_video_id_map['1004'][0];
        return response({ data: { [requested]: { video_model: playModel } } });
    });
    const shared = await api.getPlaybackDevice(api.requestJson);
    const canceled = api.fetchAppPlayUrl('11', { signal: controller.signal });
    const independent = api.fetchAppPlayUrl('12');
    const failed = assert.rejects(canceled, { code: 'ERR_CANCELED' });
    assert.equal((await independent).source, 'app');
    await failed;
    assert.equal(independentSignal.aborted, false);
    assert.equal(await api.getPlaybackDevice(() => assert.fail('must keep shared registration')), shared);
    assert.equal(calls, 5);
});

test('registration and models retain separate 8s/12s budgets; failed renewal stays bounded', async () => {
    let now = Date.now(), calls = 0;
    const api = app(async config => {
        calls++;
        if (calls === 1) {
            assert.ok(config.timeout > 0 && config.timeout <= 8000);
            now += 7900;
            return response(success);
        }
        if (calls === 2) {
            assert.equal(config.timeout, 12000);
            return { status: 200, headers: {}, data: '' };
        }
        if (calls === 3) throw { code: 'ENOTFOUND' };
        assert.ok(config.timeout > 0 && config.timeout <= 12000);
        return playResponse();
    }, { now: () => now });
    assert.equal((await api.fetchAppPlayUrl('11')).source, 'app');
    assert.equal(calls, 4);
});

test('cancellation mapping preserves ERR_CANCELED instead of retryable NETWORK_ERROR', () => {
    const mapped = sourceMapping()('app', { code: 'ERR_CANCELED', message: 'PRIVATE_SENTINEL' });
    assert.equal(mapped.code, 'ERR_CANCELED');
    assert.doesNotMatch(JSON.stringify(mapped), /PRIVATE_SENTINEL/);
});

test('internal registration timeout aborts its transport and retains failure cooldown', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal, calls = 0;
    const api = app(config => {
        calls++; signal = config.signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject({ code: 'ERR_CANCELED' }), { once: true }));
    });
    const failed = assert.rejects(api.fetchAppPlayUrl('11'), { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: 'TIMEOUT' });
    t.mock.timers.tick(7999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await failed;
    assert.equal(signal.aborted, true);
    await assert.rejects(api.fetchAppPlayUrl('11'), { registrationFailure: 'TIMEOUT' });
    assert.equal(calls, 1);
});

test('internal model timeout aborts its transport without triggering a renewal or alternate host', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal, calls = 0, enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const api = app(config => {
        calls++;
        if (calls === 1) return Promise.resolve(response(success));
        signal = config.signal; enter();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject({ code: 'ERR_CANCELED' }), { once: true }));
    });
    const failed = assert.rejects(api.fetchAppPlayUrl('11'), { code: 'ETIMEDOUT' });
    await entered;
    t.mock.timers.tick(11999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await failed;
    assert.equal(calls, 2);
});

test('hongguo fixed and automatic lookup both preserve cancellation without another source request', async () => {
    for (const quality of ['1080p', 'auto']) {
        let appCalls = 0;
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(require.resolve('./hongguo'), 'utf8') + '\nfetchPlayUrlFromWeb = async () => null;', {
            module, Buffer, URL, AbortController, process: { env: {} }, require(name) {
                if (name === 'axios') return { post: () => assert.fail('cancellation cannot try the old API') };
                if (name === './app-source') return { fetchAppPlayUrl: async () => {
                    appCalls++;
                    throw Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'ERR_CANCELED' });
                } };
                return require(name.startsWith('.') ? path.join(__dirname, name) : name);
            },
        });
        const result = await module.exports.fetchPlayUrlSingle('11', '1', { quality });
        assert.equal(result.code, 'ERR_CANCELED');
        assert.equal(result.url, null);
        assert.equal(result.sources, undefined);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
        assert.equal(appCalls, 1);
    }
});

test('shared registration cancellation clears the failed promise without a ten-second cooldown', async () => {
    const api = device();
    let calls = 0;
    const first = api.getPlaybackDevice(async () => { calls++; throw { code: 'ERR_CANCELED' }; });
    const joined = api.getPlaybackDevice(() => assert.fail('concurrent callers share the same request'));
    assert.equal(joined, first);
    await assert.rejects(first, { code: 'ERR_CANCELED' });
    const recovered = await api.getPlaybackDevice(async () => { calls++; return success; });
    assert.equal(recovered.device_id, '123');
    assert.equal(calls, 2);
});

test('diagnostic subtypes accept primitive whitelist strings only', () => {
    const map = sourceMapping();
    for (const networkFailure of [{ toString: () => 'DNS', private: 'PRIVATE_SENTINEL' }, ['TLS'], new String('CONNECTION')]) {
        const mapped = map('app', { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: 'NETWORK_ERROR', networkFailure });
        assert.equal(mapped.networkFailure, undefined);
        assert.doesNotMatch(JSON.stringify(mapped), /PRIVATE_SENTINEL/);
    }
});
