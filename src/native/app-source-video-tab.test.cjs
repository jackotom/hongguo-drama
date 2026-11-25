// Android v5 is the production path; legacy remains a bounded empty-response fallback.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { signPlayer } = require('./playback-signature');
const sourcePolicy = require('./source-policy');
const signerEntropy = { randField: 420072733, ladonRandom: Buffer.from('01020304', 'hex') };

const vid = '7700946421087751193';
const identity = { device_id: '9007199254740993', iid: '9007199254741993', cdid: 'synthetic' };
const media = 'https://qznovelvod.com/synthetic.mp4';
const model = () => ({ video_id: 'synthetic-video', video_duration: 60, video_list: {
    hd: { codec_type: 'h264', vwidth: 1080, vheight: 1920, quality_desc: '1080p',
        main_url: media, encrypt_info: { encrypt: false } },
} });
const response = data => ({ status: 200, headers: {}, data: JSON.stringify(data) });
const nested = value => ({ code: 0, data: { video_model_data: { [vid]: { video_model: value } } } });

function fixture(tabResponse, { legacyResponse, preloadResponse = tabResponse, v5Response = tabResponse, signal } = {}) {
    const calls = [], signatures = [];
    let registrations = 0, resets = 0, cached = false;
    const module = { exports: {} };
    const context = { module, Buffer, URL, AbortSignal, setTimeout, clearTimeout, require(name) {
        if (name === './playback-device') {
            const get = async () => { if (!cached) registrations++; cached = true; return identity; };
            return { registerPlaybackDevice: get, getPlaybackDevice: get, resetPlaybackDevice() { resets++; cached = false; } };
        }
        if (name === './sdk-playback') return { resolveSdkPlayback: async () => null };
        if (name === './playback-v5') return { signPlaybackV5: input => {
            const signed = require('./playback-v5').signPlaybackV5(input);
            signatures.push({ ...input, signed, v5: true });
            return signed;
        } };
        if (name === './playback-signature') return { signPlayer: input => {
            signatures.push(input);
            return signPlayer({ ...input, ...signerEntropy });
        } };
        if (name === 'axios') return async config => {
            calls.push(config);
            const path = new URL(config.url).pathname;
            if (path === '/novel/player/multi_video_model/v1/') return legacyResponse || { status: 200, headers: {}, data: '' };
            if (path === '/novel/player/multi_video_model/player/v1') {
                return typeof v5Response === 'function' ? v5Response(config) : v5Response;
            }
            if (path === '/novel/player/multi_video_model/preload/v1') {
                return typeof preloadResponse === 'function' ? preloadResponse(config) : preloadResponse;
            }
            return typeof tabResponse === 'function' ? tabResponse(config) : tabResponse;
        };
        return require(name.startsWith('.') ? path.join(__dirname, name) : name);
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('./app-source'), 'utf8'), context);
    return { context, calls, signatures, registrations: () => registrations, resets: () => resets,
        fetch: options => module.exports.fetchAppPlayUrl(vid, { quality: '1080p', signal, ...options }) };
}

function assertPlayerBinding(f, request, index) {
    const input = f.signatures[index], url = new URL(request.url);
    assert.ok(input, 'model must use the real PlayerSigner family');
    assert.equal(input.query, url.search.slice(1));
    assert.deepEqual(Buffer.from(input.body), Buffer.from(request.data), 'sign the actual sent Buffer, not the JSON before gzip');
    assert.equal(input.ts, Number(request.headers['x-khronos']));
    const expected = signPlayer({ ...input, ...signerEntropy });
    for (const name of ['x-ss-req-ticket', 'x-khronos', 'x-argus', 'x-ladon', 'x-ss-stub']) assert.equal(request.headers[name], expected[name], name);
    assert.equal(request.headers['x-ss-req-ticket'], String(input.ts * 1000));
    const ticket = Number(url.searchParams.get('_rticket'));
    assert.ok(ticket >= input.ts * 1000 && ticket < input.ts * 1000 + 1000);
    for (const name of ['x-gorgon', 'x-medusa', 'x-helios']) assert.equal(request.headers[name], undefined, name);
    assert.ok(Buffer.from(request.headers['x-argus'], 'base64').length > 4);
    assert.ok(Buffer.from(request.headers['x-ladon'], 'base64').length > 4);
}

test('production playback uses current-app preload first and the exact episode', async () => {
    const f = fixture(response({ code: 0, data: { '1004': { [vid]: { video_model: model() }, '999': {} } } }));
    assert.equal((await f.fetch()).url, media);
    const request = f.calls[0], url = new URL(request.url);
    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/novel/player/multi_video_model/preload/v1');
    assert.equal(f.calls.length, 1); assert.equal(f.registrations(), 1);
    const body = JSON.parse(require('node:zlib').gunzipSync(request.data));
    assert.equal(body.dr_scene, 'preload');
    assert.equal(body.biz_param.device_level, 2);
    assert.equal(body.mixed_video_id_map['1004'][0], vid);
    assert.equal(url.searchParams.get('version_code'), '74532');
    assert.equal(url.searchParams.get('device_id'), identity.device_id);
    assert.equal(url.searchParams.get('iid'), identity.iid);
    assert.ok(Buffer.from(request.headers['x-medusa'], 'base64').length > 248);
    assert.ok(Buffer.from(request.headers['x-helios'], 'base64').length > 4);
    assert.ok(request.headers['x-ss-stub']);
    assert.equal(request.headers['Content-Encoding'], 'gzip');
    for (const key of ['x-ss-req-ticket', 'x-argus', 'x-ladon', 'Cookie', 'Authorization']) assert.equal(request.headers[key], undefined, key);
    assert.deepEqual(Buffer.from(f.signatures[0].body), Buffer.from(request.data));
    assert.equal(f.signatures[0].signed.url, request.url);
    assert.ok(request.timeout > 0 && request.timeout <= 12000);
    assert.ok(request.signal);
});

test('signed source policy can reorder, disable and change official request fields', async () => {
    sourcePolicy.setPolicy(sourcePolicy.normalizePolicy({
        revision: 9,
        routes: [
            { id: 'preload_current', enabled: false },
            { id: 'video_tab', order: 0, url: 'https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/',
                values: { version_code: '75555', version_name: '7.5.5.55' } },
        ],
    }));
    try {
        const f = fixture(response({ code: 0, data: { '1004': { [vid]: { video_model: model() } } } }));
        assert.equal((await f.fetch()).url, media);
        assert.equal(f.calls.length, 1);
        const request = f.calls[0], url = new URL(request.url);
        assert.equal(url.hostname, 'api5-normal-sinfonlinea.fqnovel.com');
        assert.equal(url.searchParams.get('version_code'), '75555');
        assert.equal(url.searchParams.get('version_name'), '7.5.5.55');
    } finally {
        sourcePolicy.setPolicy(null);
    }
});

for (const wrap of [value => ({ code: 0, data: { [vid]: { video_model: value } } }), nested,
    value => ({ code: 0, data: { '1004': { [vid]: { video_model: JSON.stringify(value) } } } })]) {
    test('v5 accepts existing flat, video_model_data and new 1004 model maps', async () => {
        const f = fixture(response(wrap(model())));
        const result = await f.fetch();
        assert.equal(result.url, media); assert.equal(result.vid, vid);
        assert.equal(result.width, 1080); assert.equal(result.height, 1920);
        assert.equal(f.calls.length, 1);
    });
}

test('backup_url_1 remains available when the primary media URL is rejected', async () => {
    const value = model();
    value.video_list.hd.main_url = 'https://127.0.0.1/private';
    value.video_list.hd.backup_url_1 = media;
    const f = fixture(response({ code: 0, data: { '1004': { [vid]: { video_model: value } } } }));
    assert.equal((await f.fetch()).url, media);
});

test('empty v5 model retains the bounded signed legacy fallback', async () => {
    const f = fixture({ status: 200, headers: {}, data: '' }, { legacyResponse: response(nested(model())) });
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 14); assert.equal(f.registrations(), 1);
    for (let i = 0; i < 3; i++) {
        assert.equal(f.calls[i].method, 'POST');
        assert.equal(new URL(f.calls[i].url).pathname, '/novel/player/multi_video_model/preload/v1');
    }
    for (let i = 3; i < 5; i++) {
        assert.equal(f.calls[i].method, 'GET');
        assert.equal(new URL(f.calls[i].url).pathname, '/reading/bookapi/video_tab/multi_video_model/v1/');
    }
    assert.equal(f.calls.at(-4).method, 'POST');
    assert.equal(new URL(f.calls.at(-4).url).pathname, '/novel/player/video_model/v1/');
    const legacy = f.calls.at(-1);
    assert.equal(new URL(legacy.url).pathname, '/novel/player/multi_video_model/v1/');
    assert.equal(legacy.headers.Connection, 'close');
    const legacySignatureIndex = f.signatures.findLastIndex(item => !item.v5);
    assert.ok(legacySignatureIndex >= 0);
    assertPlayerBinding(f, legacy, legacySignatureIndex);
});

for (const [name, result, code] of [
    ['empty response', { status: 200, headers: {}, data: '' }, 'EMPTY_RESPONSE'],
    ['invalid JSON', { status: 200, headers: {}, data: '{' }, 'INVALID_RESPONSE'],
    ['business rejection', response({ code: 100103 }), 'BUSINESS_REJECTED'],
    ['missing episode', response({ code: 0, data: { video_model_data: { '999': { video_model: model() } } } }), 'MISSING_MODEL'],
    ['malformed model', response(nested('{')), 'INVALID_RESPONSE'],
    ['HTTP rejection', { status: 403, headers: {}, data: '' }, undefined],
]) {
    test(`v5 ${name} stops within the existing request budget`, async () => {
        const f = fixture(result);
        await assert.rejects(f.fetch(), error => code ? error.code === code : error.status === 403);
        assert.equal(f.calls.length, code === 'EMPTY_RESPONSE' ? 15 : 1);
        assert.equal(f.registrations(), 1);
    });
}

test('an empty current response retains the successful legacy recovery', async () => {
    const f = fixture({ status: 200, headers: {}, data: '' }, {
        legacyResponse: response({ code: 0, data: { [vid]: { video_model: model() } } }),
    });
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 14);
    assert.equal(f.registrations(), 1);
});

test('current-app V5 preload is a signed fallback and is preferred after success', async () => {
    const empty = { status: 200, headers: {}, data: '' };
    let preloadCalls = 0;
    const f = fixture(empty, {
        v5Response: empty,
        preloadResponse: () => {
            preloadCalls++;
            return response({ code: 0, data: { [vid]: { video_model: model() } } });
        },
    });
    assert.equal((await f.fetch()).url, media);
    const firstPreload = f.calls.find(call => new URL(call.url).pathname === '/novel/player/multi_video_model/preload/v1');
    assert.ok(firstPreload);
    const body = JSON.parse(require('node:zlib').gunzipSync(firstPreload.data));
    assert.equal(body.dr_scene, 'preload');
    assert.equal(body.biz_param.device_level, 2);
    assert.equal(body.mixed_video_id_map['1004'][0], vid);
    assert.equal(new URL(firstPreload.url).searchParams.get('version_code'), '74532');
    assert.ok(firstPreload.headers['x-medusa']);
    assert.ok(firstPreload.headers['x-ss-stub']);
    assert.equal(preloadCalls, 1);

    assert.equal((await f.fetch()).url, media);
    assert.equal(new URL(f.calls.at(-1).url).pathname, '/novel/player/multi_video_model/preload/v1');
    assert.equal(preloadCalls, 2);
});

test('incompatible official model negotiates the App codec fallback', async () => {
    const fallback = 'https://reading.snssdk.com/fallback/video';
    const incompatible = {
        ...model(), video_id: 'synthetic-video', video_duration: 60, fallback_api: fallback,
        video_list: {
            unsupported: { codec_type: 'unknown', vwidth: 1080, vheight: 1920, main_url: media },
        },
    };
    const f = fixture(config => {
        const url = new URL(config.url);
        if (url.pathname === '/fallback/video') {
            assert.equal(url.searchParams.get('codec_type'), '1');
            return response({ code: 0, video_info: { code: 0, data: model() } });
        }
        return response({ code: 0, data: { '1004': { [vid]: { video_model: incompatible } } } });
    });
    const result = await f.fetch();
    assert.equal(result.url, media);
    assert.equal(result.quality, '1080p');
    assert.equal(new URL(f.calls.at(-1).url).searchParams.get('codec_type'), '1');
});

for (const legacyResponse of [response({ code: 1 }), { status: 429, headers: {}, data: '' }]) {
    test(`explicit legacy rejection remains terminal (${legacyResponse.status})`, async () => {
        const f = fixture({ status: 200, headers: {}, data: '' }, { legacyResponse });
        await assert.rejects(f.fetch());
        assert.equal(f.calls.length, 14);
        assert.equal(f.registrations(), 1);
    });
}

test('cancellation during v5 prevents any further route or registration', async () => {
    const controller = new AbortController();
    const f = fixture(async () => {
        controller.abort();
        return response(nested(model()));
    }, { signal: controller.signal });
    await assert.rejects(f.fetch(), { code: 'ERR_CANCELED' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.registrations(), 1);
});

for (const [changes, code] of [[{ main_url: 'https://127.0.0.1/private' }, 'SECURITY_BLOCKED'],
    [{ encrypt_info: { encrypt: true } }, 'INVALID_RESPONSE']]) {
    test(`v5 retains media URL and key validation: ${JSON.stringify(changes)}`, async () => {
        const value = model();
        Object.assign(value.video_list.hd, changes);
        const f = fixture(response(nested(value)));
        await assert.rejects(f.fetch(), error => error.code === code);
        assert.equal(f.calls.length, 1);
    });
}

// An empty primary host recovers with the same identity through another current route.
test('empty primary host recovers on another official route without registration churn', async () => {
    const empty = { status: 200, headers: {}, data: '' };
    const f = fixture(config => new URL(config.url).hostname === 'api5-normal-sinfonlineb.fqnovel.com'
        ? empty : response(nested(model())), { preloadResponse: empty, v5Response: empty });
    assert.equal((await f.fetch()).url, media);
    assert.ok(f.calls.length >= 2);
    assert.equal(f.registrations(), 1);
    assert.equal(new URL(f.calls.at(-1).url).hostname, 'api5-normal-sinfonlinea.fqnovel.com');
    assert.equal(new URL(f.calls.at(-1).url).pathname, '/novel/player/video_model/v1/');
    assert.equal(f.calls.at(-1).method, 'POST');
    const modelBody = JSON.parse(require('node:zlib').gunzipSync(f.calls.at(-1).data));
    assert.equal(modelBody.content_type, 1004);
    assert.equal(modelBody.video_id, vid);
    assert.equal(modelBody.biz_param.video_platform, 3);
    assert.ok(f.calls.at(-1).timeout <= f.calls[0].timeout);
});

for (const status of [403, 429]) {
    test(`alternate official host HTTP ${status} stops without legacy`, async () => {
        const empty = { status: 200, headers: {}, data: '' };
        const f = fixture(config => ({ status: new URL(config.url).hostname.includes('sinfonlineb') ? 200 : status,
            headers: {}, data: '' }), { preloadResponse: empty });
        await assert.rejects(f.fetch(), { status });
        assert.ok(f.calls.length >= 5);
        assert.equal(new URL(f.calls.at(-1).url).hostname, 'api5-normal-sinfonlinea.fqnovel.com');
        assert.equal(f.registrations(), 1);
    });
}
test('cancelling on the alternate host stops without legacy', async () => {
    const controller = new AbortController();
    const empty = { status: 200, headers: {}, data: '' };
    const f = fixture(config => {
        if (new URL(config.url).hostname.includes('sinfonlinea')) controller.abort();
        return { status: 200, headers: {}, data: '' };
    }, { preloadResponse: empty, signal: controller.signal });
    await assert.rejects(f.fetch(), { code: 'ERR_CANCELED' });
    assert.ok(f.calls.length >= 5);
    assert.equal(f.registrations(), 1);
});

for (const target of ['https://api5-normal-sinfonlinea.fqnovel.com/novel/player/multi_video_model/player/v1',
    'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/player/v1?changed=1']) {
    test('v5 rejects signed redirects before forwarding headers: ' + new URL(target).hostname, async () => {
        const f = fixture({ status: 302, headers: { location: target }, data: '' });
        await assert.rejects(f.fetch(), { code: 'SECURITY_BLOCKED' });
        assert.equal(f.calls.length, 1); assert.equal(f.registrations(), 1);
    });
}
