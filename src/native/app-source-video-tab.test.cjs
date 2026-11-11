// Current video_tab first; legacy is a single bounded recovery for an empty response.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { signPlayer } = require('./playback-signature');
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

function fixture(tabResponse, { legacyResponse, signal } = {}) {
    const calls = [], signatures = [];
    let registrations = 0;
    const module = { exports: {} };
    const context = { module, Buffer, URL, AbortSignal, setTimeout, clearTimeout, require(name) {
        if (name === './playback-device') return { registerPlaybackDevice: async () => {
            registrations++;
            return identity;
        } };
        if (name === './playback-signature') return { signPlayer: input => {
            signatures.push(input);
            return signPlayer({ ...input, ...signerEntropy });
        } };
        if (name === 'axios') return async config => {
            calls.push(config);
            if (config.method === 'POST') return legacyResponse || { status: 200, headers: {}, data: '' };
            assert.equal(config.method, 'GET');
            assert.equal(new URL(config.url).pathname, '/reading/bookapi/video_tab/multi_video_model/v1/');
            return typeof tabResponse === 'function' ? tabResponse(config) : tabResponse;
        };
        return require(name.startsWith('.') ? path.join(__dirname, name) : name);
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('./app-source'), 'utf8'), context);
    return { context, calls, signatures, registrations: () => registrations,
        fetch: options => module.exports.fetchAppPlayUrl(vid, { quality: '1080p', signal, ...options }) };
}

function assertPlayerBinding(f, request, index) {
    const input = f.signatures[index], url = new URL(request.url);
    assert.ok(input, 'model must use the real PlayerSigner family');
    assert.equal(input.query, url.search.slice(1));
    assert.equal(input.body, request.data, 'sign the actual sent Buffer, not the JSON before gzip');
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

test('model first GET uses one real551/Ladon signature over its final query and time', async () => {
    const f = fixture(response(nested(model())));
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 1); assert.equal(f.registrations(), 1); assert.equal(f.signatures.length, 1);
    assertPlayerBinding(f, f.calls[0], 0);
    assert.equal(f.calls[0].data, null); assert.equal(f.calls[0].headers['x-ss-stub'], undefined);
});

test('only empty current recovers once with a new551 signature over the actual legacy gzip bytes', async () => {
    const f = fixture({ status: 200, headers: {}, data: '' }, {
        legacyResponse: response({ code: 0, data: { [vid]: { video_model: model() } } }),
    });
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 2); assert.equal(f.registrations(), 2); assert.equal(f.signatures.length, 2);
    assertPlayerBinding(f, f.calls[0], 0); assertPlayerBinding(f, f.calls[1], 1);
    const request = f.calls[1], plain = require('node:zlib').gunzipSync(request.data);
    const payload = JSON.parse(plain);
    assert.equal(payload.biz_param.device_level, 3);
    assert.equal(new URL(request.url).searchParams.get('version_code'), '74332');
    assert.match(request.headers['User-Agent'], /^com\.phoenix\.read\/74332 /);
    assert.notEqual(request.headers['x-ss-stub'], signPlayer({ ...f.signatures[1], ...signerEntropy, body: plain })['x-ss-stub']);
    assert.notEqual(request.headers['x-argus'], signPlayer({ ...f.signatures[1], ...signerEntropy, query: f.signatures[1].query + '&different=1' })['x-argus']);
});

for (const target of ['https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/?changed=1',
    'https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/']) {
    test('signed current GET refuses a redirect before forwarding real signatures: ' + new URL(target).hostname, async () => {
        const f = fixture({ status: 302, headers: { location: target }, data: '' });
        await assert.rejects(f.fetch(), { code: 'SECURITY_BLOCKED' });
        assert.equal(f.calls.length, 1, 'no redirect request and no legacy recovery');
        assert.equal(f.registrations(), 1); assert.equal(f.signatures.length, 1);
    });
}

test('unsigned official JSON requests retain bounded validated redirects', async () => {
    let returned = false;
    const f = fixture(() => {
        if (!returned) { returned = true; return { status: 302, headers: { location: 'https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/' }, data: '' }; }
        return response({ allowed: true });
    });
    const value = await f.context.module.exports.requestJson('https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/',
        { method: 'GET', headers: { 'User-Agent': 'unsigned-fixture' } }, Date.now() + 1000);
    assert.equal(value.allowed, true); assert.equal(f.calls.length, 2); assert.equal(f.registrations(), 0);
    for (const request of f.calls) for (const name of ['x-argus', 'x-ladon', 'Cookie']) assert.equal(request.headers[name], undefined);
});

test('current video_tab first succeeds with one registration and one model request', async () => {
    const f = fixture(response(nested(model())));
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 1, 'successful current API must not probe legacy');
    assert.equal(f.registrations(), 1);
    assert.equal(f.calls[0].method, 'GET');
    assert.equal(f.calls[0].data, null);
});

test('the single legacy fallback signs its final host query gzip body and fresh timestamp', async () => {
    const f = fixture({ status: 200, headers: {}, data: '' }, {
        legacyResponse: response({ code: 0, data: { [vid]: { video_model: model() } } }),
    });
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 2); assert.equal(f.registrations(), 2);
    const first = f.calls[0], request = f.calls[1], url = new URL(request.url);
    assert.equal(first.method, 'GET'); assert.equal(request.method, 'POST');
    assert.equal(url.hostname, 'api5-normal-sinfonlineb.fqnovel.com');
    assert.equal(url.pathname, '/novel/player/multi_video_model/v1/');
    assert.equal(request.headers.Connection, 'close');
    assert.equal(request.headers['Content-Encoding'], 'gzip');
    const body = JSON.parse(require('node:zlib').gunzipSync(request.data));
    assert.deepEqual(body.mixed_video_id_map['1004'], [vid]);
    const timestamp = Number(request.headers['x-khronos']);
    assert.equal(url.searchParams.get('ts'), String(timestamp));
    assertPlayerBinding(f, request, 1);
    assert.ok(timestamp > Number(first.headers['x-khronos']), 'recovery must sign after its one-second wait');
});

for (const stringify of [false, true]) {
    test(`current API returns the exact nested video_tab model (${stringify ? 'string' : 'object'})`, async () => {
        const value = model();
        const payload = nested(stringify ? JSON.stringify(value) : value);
        payload.data.video_model_data['999'] = { video_model: { ...value, video_list: [] } };
        const f = fixture(response(payload));
        const result = await f.fetch();
        assert.equal(result.url, media);
        assert.equal(result.vid, vid);
        assert.equal(result.width, 1080);
        assert.equal(result.height, 1920);
        assert.equal(result.contentKey, null);
        assert.equal(f.calls.length, 1, 'current success must not send legacy or metadata requests');
        assert.equal(f.registrations(), 1, 'current success needs only its initial registration');

        const request = f.calls[0], url = new URL(request.url), query = url.searchParams;
        for (const [key, value] of Object.entries({ video_id: vid, video_id_type: '0', device_level: '1',
            need_all_video_definition: '1', need_mp4_align: '0', use_os_player: '0',
            video_platform: '1024', source: '0', from_video_id: '', device_id: identity.device_id, iid: identity.iid,
            version_code: '73932', version_name: '7.3.9.32', manifest_version_code: '73932',
            update_version_code: '73932', pv_player: '73932' })) assert.equal(query.get(key), value, key);
        assert.equal(request.data, null, 'GET must not send the legacy gzip body');
        for (const name of ['Content-Type', 'Content-Encoding', 'x-ss-stub', 'Cookie', 'Authorization']) {
            assert.equal(request.headers[name], undefined, name);
        }
        assert.match(request.headers['User-Agent'], /^com\.phoenix\.read\/73932 /);
        assertPlayerBinding(f, request, 0);
        const timestamp = Number(request.headers['x-khronos']);
        assert.equal(query.get('ts'), String(timestamp));
        assert.ok(request.timeout > 0 && request.timeout <= 12000);
        assert.ok(request.signal);
    });
}

test('video_tab accepts array renditions using the same media validation', async () => {
    const value = model();
    value.video_list = Object.values(value.video_list);
    assert.equal((await fixture(response(nested(value))).fetch()).url, media);
});

for (const [name, result, code] of [
    ['empty response', { status: 200, headers: {}, data: '' }, 'EMPTY_RESPONSE'],
    ['invalid JSON', { status: 200, headers: {}, data: '{' }, 'INVALID_RESPONSE'],
    ['business rejection', response({ code: 100103 }), 'BUSINESS_REJECTED'],
    ['missing episode', response({ code: 0, data: { video_model_data: { '999': { video_model: model() } } } }), 'MISSING_MODEL'],
    ['malformed model', response(nested('{')), 'INVALID_RESPONSE'],
    ['HTTP rejection', { status: 403, headers: {}, data: '' }, undefined],
]) {
    test(`video_tab ${name} stops within the existing request budget`, async () => {
        const f = fixture(result);
        await assert.rejects(f.fetch(), error => code ? error.code === code : error.status === 403);
        assert.equal(f.calls.length, code === 'EMPTY_RESPONSE' ? 2 : 1);
        assert.equal(f.registrations(), code === 'EMPTY_RESPONSE' ? 2 : 1);
    });
}

test('an empty current response retains the successful legacy recovery', async () => {
    const f = fixture({ status: 200, headers: {}, data: '' }, {
        legacyResponse: response({ code: 0, data: { [vid]: { video_model: model() } } }),
    });
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 2);
    assert.equal(f.registrations(), 2);
});

for (const legacyResponse of [response({ code: 1 }), { status: 429, headers: {}, data: '' }]) {
    test(`explicit legacy rejection remains terminal (${legacyResponse.status})`, async () => {
        const f = fixture({ status: 200, headers: {}, data: '' }, { legacyResponse });
        await assert.rejects(f.fetch());
        assert.equal(f.calls.length, 2);
        assert.equal(f.registrations(), 2);
    });
}

test('cancellation during video_tab prevents any further route or registration', async () => {
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
    test(`video_tab retains media URL and key validation: ${JSON.stringify(changes)}`, async () => {
        const value = model();
        Object.assign(value.video_list.hd, changes);
        const f = fixture(response(nested(value)));
        await assert.rejects(f.fetch(), error => error.code === code);
        assert.equal(f.calls.length, 1);
    });
}
