// Android v5 is the production path; legacy remains a bounded empty-response fallback.
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
            if (new URL(config.url).pathname === '/novel/player/multi_video_model/v1/') return legacyResponse || { status: 200, headers: {}, data: '' };
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

test('production playback uses the v5 POST endpoint and exact nested 1004 episode', async () => {
    const f = fixture(response({ code: 0, data: { '1004': { [vid]: { video_model: model() }, '999': {} } } }));
    assert.equal((await f.fetch()).url, media);
    const request = f.calls[0], url = new URL(request.url);
    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/novel/player/multi_video_model/player/v1');
    assert.equal(f.calls.length, 1); assert.equal(f.registrations(), 1);
    const body = JSON.parse(require('node:zlib').gunzipSync(request.data));
    assert.deepEqual(body.mixed_video_id_map['1004'], [vid]);
    assert.equal(body.dr_scene, 'player');
    assert.equal(body.biz_param.disable_video_relate_book, false);
    assert.equal(url.searchParams.get('ts'), null);
    assert.equal(url.searchParams.get('version_code'), '74332');
    assert.equal(url.searchParams.get('device_id'), identity.device_id);
    assert.equal(url.searchParams.get('iid'), identity.iid);
    assert.equal(request.headers['Content-Encoding'], 'gzip');
    assert.equal(request.headers['x-ss-stub'], require('node:crypto').createHash('md5').update(request.data).digest('hex').toUpperCase());
    assert.ok(Buffer.from(request.headers['x-medusa'], 'base64').length > 248);
    assert.ok(Buffer.from(request.headers['x-helios'], 'base64').length > 4);
    for (const key of ['x-argus', 'x-ladon', 'Cookie', 'Authorization']) assert.equal(request.headers[key], undefined);
    assert.equal(f.signatures[0].body, request.data);
    assert.equal(f.signatures[0].signed.url, request.url);
    assert.ok(request.timeout > 0 && request.timeout <= 12000);
    assert.ok(request.signal);
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

test('empty v5 model retains the bounded signed legacy fallback', async () => {
    const f = fixture({ status: 200, headers: {}, data: '' }, { legacyResponse: response(nested(model())) });
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 4); assert.equal(f.registrations(), 2);
    for (let i = 0; i < 2; i++) {
        assert.equal(f.calls[i].method, 'POST');
        assert.equal(new URL(f.calls[i].url).pathname, '/novel/player/multi_video_model/player/v1');
        assert.equal(f.signatures[i].body, f.calls[i].data);
        assert.equal(f.signatures[i].signed.url, f.calls[i].url);
    }
    assert.equal(f.calls[2].method, 'GET');
    assert.equal(new URL(f.calls[2].url).pathname, '/reading/bookapi/video_tab/multi_video_model/v1/');
    const legacy = f.calls[3];
    assert.equal(new URL(legacy.url).pathname, '/novel/player/multi_video_model/v1/');
    assert.equal(legacy.headers.Connection, 'close');
    assertPlayerBinding(f, legacy, 3);
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
        assert.equal(f.calls.length, code === 'EMPTY_RESPONSE' ? 12 : 1);
        assert.equal(f.registrations(), code === 'EMPTY_RESPONSE' ? 6 : 1);
    });
}

test('an empty current response retains the successful legacy recovery', async () => {
    const f = fixture({ status: 200, headers: {}, data: '' }, {
        legacyResponse: response({ code: 0, data: { [vid]: { video_model: model() } } }),
    });
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 4);
    assert.equal(f.registrations(), 2);
});

for (const legacyResponse of [response({ code: 1 }), { status: 429, headers: {}, data: '' }]) {
    test(`explicit legacy rejection remains terminal (${legacyResponse.status})`, async () => {
        const f = fixture({ status: 200, headers: {}, data: '' }, { legacyResponse });
        await assert.rejects(f.fetch());
        assert.equal(f.calls.length, 4);
        assert.equal(f.registrations(), 2);
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

// A real empty response on the primary host recovered with the same identity on the alternate.
test('empty primary host recovers on the alternate official host without legacy or registration', async () => {
    const f = fixture(config => new URL(config.url).hostname === 'api5-normal-sinfonlineb.fqnovel.com'
        ? { status: 200, headers: {}, data: '' } : response(nested(model())));
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 2);
    assert.equal(f.registrations(), 1);
    assert.equal(new URL(f.calls[1].url).hostname, 'api5-normal-sinfonlinea.fqnovel.com');
    assert.equal(f.calls[1].method, 'POST');
    assert.equal(f.signatures[1].signed.url, f.calls[1].url);
    assert.equal(f.signatures[1].body, f.calls[1].data);
    assert.ok(f.calls[1].timeout <= f.calls[0].timeout);
});

for (const status of [403, 429]) {
    test(`alternate official host HTTP ${status} stops without legacy`, async () => {
        const f = fixture(config => ({ status: new URL(config.url).hostname.includes('sinfonlineb') ? 200 : status,
            headers: {}, data: '' }));
        await assert.rejects(f.fetch(), { status });
        assert.equal(f.calls.length, 2);
        assert.equal(f.registrations(), 1);
    });
}
test('cancelling on the alternate host stops without legacy', async () => {
    const controller = new AbortController();
    const f = fixture(config => {
        if (new URL(config.url).hostname.includes('sinfonlinea')) controller.abort();
        return { status: 200, headers: {}, data: '' };
    }, { signal: controller.signal });
    await assert.rejects(f.fetch(), { code: 'ERR_CANCELED' });
    assert.equal(f.calls.length, 2);
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
