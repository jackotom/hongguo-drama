// Offline regression for #130: a legacy empty 200 must recover through video_tab.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    const calls = [];
    let registrations = 0;
    const module = { exports: {} };
    const context = { module, Buffer, URL, AbortSignal, setTimeout, clearTimeout, require(name) {
        if (name === './playback-device') return { registerPlaybackDevice: async () => {
            registrations++;
            return identity;
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
    return { context, calls, registrations: () => registrations,
        fetch: options => module.exports.fetchAppPlayUrl(vid, { quality: '1080p', signal, ...options }) };
}

for (const stringify of [false, true]) {
    test(`empty legacy response recovers the exact nested video_tab model (${stringify ? 'string' : 'object'})`, async () => {
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
        assert.equal(f.calls.length, 2, 'one legacy request and one video_tab recovery; no metadata fallback');
        assert.equal(f.registrations(), 2, 'retain the existing fresh-identity recovery budget');

        const request = f.calls[1], url = new URL(request.url), query = url.searchParams;
        assert.notEqual(request.headers['x-argus'], f.calls[0].headers['x-argus'], 'recovery must sign the new GET query and absent body');
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
        assert.equal(query.get('_rticket'), request.headers['x-ss-req-ticket']);
        const timestamp = Number(request.headers['x-khronos']);
        assert.equal(query.get('ts'), String(timestamp));
        assert.ok(Buffer.from(request.headers['x-argus'], 'base64').length > 100);
        assert.equal(Buffer.from(request.headers['x-ladon'], 'base64').length, 36);
        for (const name of ['x-gorgon', 'x-medusa', 'x-helios']) assert.equal(request.headers[name], undefined);
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
        assert.equal(f.calls.length, 2);
        assert.equal(f.registrations(), 2);
    });
}

test('successful legacy requests retain their original one-request path', async () => {
    const f = fixture(() => assert.fail('video_tab must not be requested'), {
        legacyResponse: response({ code: 0, data: { [vid]: { video_model: model() } } }),
    });
    assert.equal((await f.fetch()).url, media);
    assert.equal(f.calls.length, 1);
    assert.equal(f.registrations(), 1);
});

for (const legacyResponse of [response({ code: 1 }), { status: 429, headers: {}, data: '' }]) {
    test(`explicit legacy rejection remains terminal (${legacyResponse.status})`, async () => {
        const f = fixture(() => assert.fail('explicit rejection must not start video_tab'), { legacyResponse });
        await assert.rejects(f.fetch());
        assert.equal(f.calls.length, 1);
        assert.equal(f.registrations(), 1);
    });
}

test('cancellation during video_tab prevents any further route or registration', async () => {
    const controller = new AbortController();
    const f = fixture(async () => {
        controller.abort();
        return response(nested(model()));
    }, { signal: controller.signal });
    await assert.rejects(f.fetch(), { code: 'ERR_CANCELED' });
    assert.equal(f.calls.length, 2);
    assert.equal(f.registrations(), 2);
});

for (const [changes, code] of [[{ main_url: 'https://127.0.0.1/private' }, 'SECURITY_BLOCKED'],
    [{ encrypt_info: { encrypt: true } }, 'INVALID_RESPONSE']]) {
    test(`video_tab retains media URL and key validation: ${JSON.stringify(changes)}`, async () => {
        const value = model();
        Object.assign(value.video_list.hd, changes);
        const f = fixture(response(nested(value)));
        await assert.rejects(f.fetch(), error => error.code === code);
        assert.equal(f.calls.length, 2);
    });
}
