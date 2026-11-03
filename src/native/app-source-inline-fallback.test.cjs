const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

const vid = '7701643128951802904';
const fallbackUrl = 'https://api5-normal-sinfonlineb.fqnovel.com/fallback';
const row = (pixels = 1080, encrypt_info) => ({
    codec_type: 'h264', quality_desc: `${pixels}p`, vwidth: pixels, vheight: pixels * 2,
    main_url: 'https://qznovelvod.com/fixture.mp4',
    ...(encrypt_info === undefined ? {} : { encrypt_info }),
});
const model = (overrides = {}) => ({
    video_id: 'same-video', video_duration: 56.007,
    video_list: [row()], fallback_api: fallbackUrl, ...overrides,
});

function fixture(inline, fallback, { status = 200, code = 0, stringModel = false, empty = false } = {}) {
    const calls = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('./app-source'), 'utf8'), {
        module, Buffer, URL, AbortSignal, setTimeout, clearTimeout,
        require(name) {
            if (name === './playback-device') return {
                registerPlaybackDevice: async () => ({ device_id: '1000000000000001', iid: '1000000000000002', cdid: 'fixture' }),
            };
            if (name === 'axios') return async config => {
                calls.push(config);
                const isFallback = config.url === fallbackUrl;
                return { status: isFallback ? status : 200, headers: {}, data: isFallback && empty ? '' : JSON.stringify(isFallback
                    ? { code, video_info: { data: fallback } }
                    : { code: 0, data: { [vid]: { video_model: stringModel ? JSON.stringify(inline) : inline } } }) };
            };
            return require(name);
        },
    }, { filename: require.resolve('./app-source') });
    return { calls, fetch: options => module.exports.fetchAppPlayUrl(vid, options) };
}

test('missing inline encryption metadata recovers through one verified fallback', async () => {
    const f = fixture(model(), model({ video_list: [row(1080, { encrypt: false })] }), { stringModel: true });
    const result = await f.fetch({ quality: 'auto' });
    assert.equal(result.vid, vid);
    assert.equal(result.contentKey, null);
    assert.equal(result.url, 'https://qznovelvod.com/fixture.mp4');
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].url, fallbackUrl);
    assert.equal(f.calls[1].signal, f.calls[0].signal);
    assert.ok(f.calls[1].timeout <= f.calls[0].timeout);
});

test('complete inline metadata does not request fallback', async () => {
    const f = fixture(model({ video_list: [row(1080, { encrypt: false })] }), null);
    await f.fetch({ quality: '1080p' });
    assert.equal(f.calls.length, 1);
});

test('verified fallback decodes key_seed URLs and preserves validated backups', async () => {
    const seed = Buffer.alloc(16, 7);
    const constants = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
    const material = crypto.createHash('sha512').update(Buffer.concat([crypto.createHash('sha512').update(seed).digest(), constants])).digest();
    const encode = url => {
        const cipher = crypto.createCipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
        return Buffer.concat([Buffer.from([0xa8, 0, 1, 0]), cipher.update(url), cipher.final()]).toString('base64');
    };
    const f = fixture(model(), model({ key_seed: seed.toString('base64'), video_list: [{
        ...row(1080, { encrypt: false }), main_url: encode('https://qznovelvod.com/main.mp4'),
        backup_url: encode('https://fqnovelvod.com/backup.mp4'),
    }] }));
    const result = await f.fetch({ quality: '1080p' });
    assert.equal(result.variants.length, 2);
    assert.equal(result.variants[0].url, 'https://qznovelvod.com/main.mp4');
    assert.equal(result.variants[1].url, 'https://fqnovelvod.com/backup.mp4');
    assert.equal(result.width, 1080);
});

test('every recovered variant respects the original resolution floor', async () => {
    const f = fixture(model(), model({ video_list: [row(1080, { encrypt: false }), row(720, { encrypt: false })] }));
    const result = await f.fetch({ quality: '1080p', allowLowerQuality: true });
    assert.equal(result.variants.length, 1);
    assert.equal(result.width, 1080);
});

test('verified fallback accepts a valid content key using the existing decoder', async () => {
    const keyHex = '0123456789abcdef0123456789abcdef';
    const raw = Buffer.alloc(34), previous = [246, 85], plain = Buffer.from(`0${keyHex}`);
    for (let i = 0; i < plain.length; i++) {
        raw[i + 1] = ((plain[i] + 21 + i.toString(2).split('1').length - 1) & 255) ^ previous[i & 1];
        previous[i & 1] = raw[i + 1];
    }
    raw[0] = 48 ^ raw[1] ^ raw[2];
    const f = fixture(model(), model({ video_list: [row(1080, { encrypt: true, spade_a: raw.toString('base64') })] }));
    assert.equal((await f.fetch()).contentKey, keyHex);
    assert.equal(f.calls.length, 2);
});

test('unsafe fallback endpoint is rejected before another network request', async () => {
    const f = fixture(model({ fallback_api: 'https://127.0.0.1/private' }), null);
    await assert.rejects(f.fetch(), error => error.code === 'SECURITY_BLOCKED');
    assert.equal(f.calls.length, 1);
});

test('small duration rounding differences are accepted', async () => {
    const f = fixture(model(), model({ video_duration: 56.006644, video_list: [row(1080, { encrypt: false })] }));
    await f.fetch();
    assert.equal(f.calls.length, 2);
});

for (const [name, overrides] of [
    ['different video', { video_id: 'other-video' }],
    ['missing video ID', { video_id: undefined }],
    ['preview', { video_duration: 10 }],
    ['missing duration', { video_duration: undefined }],
    ['non-positive duration', { video_duration: 0 }],
    ['duration outside tolerance', { video_duration: 56.508 }],
    ['unknown encryption', { video_list: [row()] }],
    ['encrypted without key', { video_list: [row(1080, { encrypt: true })] }],
    ['invalid key', { video_list: [{ ...row(), spade_a: 'invalid' }] }],
    ['lower resolution', { video_list: [row(720, { encrypt: false })] }],
    ['unconfirmed dimensions', { video_list: [{ ...row(1080, { encrypt: false }), vwidth: 0 }] }],
    ['unsafe media URL', { video_list: [{ ...row(1080, { encrypt: false }), main_url: 'http://127.0.0.1/media' }] }],
]) {
    test(`verified fallback rejects ${name}`, async () => {
        const f = fixture(model(), model({ video_list: [row(1080, { encrypt: false })], ...overrides }));
        await assert.rejects(f.fetch({ quality: 'auto' }));
        assert.equal(f.calls.length, 2);
    });
}

test('allowLowerQuality cannot downgrade the original inline resolution during recovery', async () => {
    const f = fixture(model(), model({ video_list: [row(720, { encrypt: false })] }));
    await assert.rejects(f.fetch({ quality: '1080p', allowLowerQuality: true }));
    assert.equal(f.calls.length, 2);
});

for (const overrides of [{ video_id: undefined }, { video_id: 9007199254740992 }, { video_duration: undefined }, { video_duration: 0 },
    { video_list: [{ ...row(), vwidth: 0 }] }, { video_list: [row(1080, { encrypt: true })] },
    { video_list: [{ ...row(), spade_a: 'invalid' }] }]) {
    test(`ineligible inline model does not use fallback: ${JSON.stringify(overrides)}`, async () => {
        const f = fixture(model(overrides), model({ video_list: [row(1080, { encrypt: false })] }));
        await assert.rejects(f.fetch({ quality: 'auto' }));
        assert.equal(f.calls.length, 1);
    });
}

for (const options of [{ status: 403 }, { status: 429 }, { code: 1 }, { empty: true }]) {
    test(`fallback failure is terminal without another model request: ${JSON.stringify(options)}`, async () => {
        const f = fixture(model(), model({ video_list: [row(1080, { encrypt: false })] }), options);
        await assert.rejects(f.fetch({ quality: 'auto' }));
        assert.equal(f.calls.length, 2);
    });
}
