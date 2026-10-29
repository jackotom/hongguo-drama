// SPDX-License-Identifier: GPL-3.0-only
// Offline protocol checks for playback-device.js; all responses and identities are synthetic.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'playback-device.js'), 'utf8');
const endpoint = 'https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
const failureMessage = '匿名播放设备注册失败，请检查网络，10 秒后重试';
function load(clock = Date) {
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module, Buffer, AbortSignal, Date: clock,
        require(name) {
            assert.ok(['node:crypto', 'node:zlib'].includes(name), 'no transport or persistence dependencies');
            return require(name);
        },
        console: { log() { assert.fail('no logging'); }, warn() { assert.fail('no logging'); }, error() { assert.fail('no logging'); } },
    }, { filename: 'playback-device.js' });
    return module.exports.getPlaybackDevice;
}

test('lazy registration shares one promise and one exact identity across concurrent and later playback', async () => {
    const get = load();
    let calls = 0, finish;
    const request = () => {
        calls++;
        return new Promise(resolve => { finish = resolve; });
    };
    assert.equal(calls, 0);
    const first = get(request);
    const pending = Array.from({ length: 20 }, () => get(request));
    assert.ok(pending.every(item => item === first), 'concurrent callers share the promise itself');
    await Promise.resolve();
    assert.equal(calls, 1);
    const response = {
        device_id_str: '9007199254740993', install_id_str: '9007199254741993',
        device_id: 9007199254740992, install_id: 9007199254741992,
    };
    for (const name of ['device_token', 'cookies', 'account']) {
        Object.defineProperty(response, name, { get() { assert.fail('must not read ' + name); } });
    }
    finish(response);
    const identity = await first;
    assert.equal(identity.device_id, '9007199254740993');
    assert.equal(identity.iid, '9007199254741993');
    assert.deepEqual(Object.keys(identity).sort(), ['cdid', 'device_id', 'iid']);
    assert.match(identity.cdid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(Object.isFrozen(identity));
    assert.ok((await Promise.all(pending)).every(item => item === identity));
    assert.equal(get(() => assert.fail('must not register again')), first);
    assert.equal(calls, 1);
});

test('empty playback can renew a rejected identity once and concurrent failures share the replacement', async () => {
    let now = Date.now(), calls = 0;
    const get = load({ now: () => now });
    const request = async () => ({ device_id: String(++calls), install_id: String(calls + 100) });
    const rejected = await get(request);
    const renewed = await Promise.all(Array.from({ length: 20 }, () => get(request, rejected)));
    assert.equal(calls, 2, 'one initial registration plus one shared renewal');
    assert.ok(renewed.every(identity => identity === renewed[0]));
    assert.notEqual(renewed[0], rejected);
    assert.equal(await get(request, rejected), renewed[0], 'late rejection cannot replace a newer identity');
    assert.equal(await get(request, renewed[0]), renewed[0], 'persistent empty responses cannot churn devices');
    now += 60001;
    assert.notEqual(await get(request, renewed[0]), renewed[0], 'later transient failures can recover after cooldown');
    assert.equal(calls, 3);
});

test('failed renewal stays shared and retains the previous device for other callers', async () => {
    const get = load();
    const rejected = await get(async () => ({ device_id: '123', install_id: '456' }));
    let calls = 0;
    const fail = async () => { calls++; throw new Error('PRIVATE_RESPONSE_SENTINEL'); };
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => get(fail, rejected)));
    assert.equal(calls, 1);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'DEVICE_REGISTRATION_FAILED'));
    assert.doesNotMatch(JSON.stringify(results), /PRIVATE_RESPONSE_SENTINEL/);
    assert.equal(await get(fail), rejected, 'a failed refresh must not poison search or account identity reads');
    assert.equal(await get(fail, rejected), rejected, 'cooldown also bounds failed registration attempts');
    assert.equal(calls, 1);
});

test('binary request decrypts to authenticated gzip JSON with the fixed anonymous phone profile', async () => {
    const get = load();
    const started = Date.now();
    let request;
    const identity = await get(async (...args) => {
        request = args;
        return { device_id: '12345', install_id: '67890' };
    });
    const [url, options, deadline, signal] = request;
    assert.equal(url, endpoint);
    assert.equal(options.method, 'POST');
    assert.ok(Buffer.isBuffer(options.data), 'send raw binary, not base64 text');
    assert.ok(deadline >= started + 8000 && deadline <= Date.now() + 8000);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    assert.equal(options.headers['Content-Type'], 'application/octet-stream;tt-data=a');
    assert.equal(options.headers['log-encode-type'], 'gzip');
    assert.equal(options.headers['x-ss-dp'], '8662');
    assert.equal(options.headers['x-neptune'], '-8|50:51:59:30:40:47:49:39');
    assert.equal(options.headers['x-ss-stub'], crypto.createHash('md5').update(options.data).digest('hex').toUpperCase());
    assert.equal(options.headers['User-Agent'], 'com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)');
    for (const name of Object.keys(options.headers)) {
        assert.doesNotMatch(name, /^(?:cookie|authorization|x-gorgon|x-khronos|x-ladon|x-argus|x-helios|x-medusa)$/i);
    }
    const data = options.data;
    assert.equal(data.subarray(0, 6).toString('hex'), '746305100000');
    assert.equal((data.length - 38) % 16, 0);
    const salt = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
    const derived = crypto.createHash('sha512').update(Buffer.concat([
        crypto.createHash('sha512').update(data.subarray(6, 38)).digest(), salt,
    ])).digest();
    const decipher = crypto.createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
    const plaintext = Buffer.concat([decipher.update(data.subarray(38)), decipher.final()]);
    const compressed = plaintext.subarray(64);
    assert.deepEqual(plaintext.subarray(0, 64), crypto.createHash('sha512').update(compressed).digest());
    assert.equal(compressed.subarray(0, 3).toString('hex'), '1f8b08');
    const payload = JSON.parse(gunzipSync(compressed).toString('utf8'));
    assert.equal(payload.magic_tag, 'ss_app_log');
    assert.equal(payload._gen_time, Number(options.headers['x-ss-req-ticket']));
    const header = payload.header;
    assert.equal(header.os, 'Android');
    assert.equal(header.os_version, '16');
    assert.equal(typeof header.os_version, 'string');
    assert.equal(header.os_api, 36);
    assert.equal(header.device_model, '25053RT47C');
    assert.equal(header.device_brand, 'Redmi');
    assert.equal(header.device_manufacturer, 'Redmi');
    assert.equal(header.density_dpi, 520);
    assert.equal(header.display_density, 'mdpi');
    assert.equal(header.rom, 'eng.root.20231116.160340');
    assert.equal(header.rom_version, 'W528JS release-keys');
    assert.equal(header.resolution, '1280x2772');
    assert.equal(header.version_code, 73932);
    assert.equal(header.manifest_version_code, 73932);
    assert.equal(header.update_version_code, 73932);
    assert.equal(header.cdid, identity.cdid);
    assert.deepEqual(header.custom, { account_region_src: 'fallback', account_region: 'cn', host_bit: 64, dragon_device_type: 'phone' });
    assert.equal(header.apk_first_install_time, payload._gen_time);
    assert.equal(header.device_id, undefined);
    assert.equal(header.install_id, undefined);
    assert.doesNotMatch(JSON.stringify(payload), /"(?:account|account_id|user_id|uid|sessionid|session_id|device_token|access_token|refresh_token|cookie|cookies|authorization|password|phone_number)"\s*:/i);
});

test('synchronous and asynchronous failures share a safe error during cooldown', async () => {
    for (const synchronous of [true, false]) {
        const get = load();
        let calls = 0;
        const unsafe = Object.assign(new Error('PRIVATE_RESPONSE_SENTINEL'), { code: 'ETIMEDOUT', response: { device_token: 'PRIVATE_RESPONSE_SENTINEL' } });
        const first = get(() => {
            calls++;
            if (synchronous) throw unsafe;
            return Promise.reject(unsafe);
        });
        const results = await Promise.allSettled(Array.from({ length: 10 }, () => get(() => assert.fail('no retry'))));
        assert.equal(calls, 1);
        assert.ok(results.every(result => result.status === 'rejected' && result.reason === results[0].reason));
        const error = results[0].reason;
        assert.equal(error.code, 'DEVICE_REGISTRATION_FAILED');
        assert.equal(error.message, failureMessage);
        assert.deepEqual(Object.keys(error), ['code', 'registrationFailure']);
        assert.equal(error.registrationFailure, 'TIMEOUT');
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /PRIVATE_RESPONSE_SENTINEL/);
        assert.equal(get(() => assert.fail('no later retry')), first);
        await assert.rejects(first, { code: 'DEVICE_REGISTRATION_FAILED' });
    }
});

test('initial registration failure recovers after cooldown without a restart or concurrent device churn', async () => {
    let now = Date.now(), calls = 0;
    const get = load({ now: () => now });
    const fail = async () => { calls++; throw Object.assign(new Error('PRIVATE_RESPONSE_SENTINEL'), { code: 'ECONNRESET' }); };
    const first = get(fail);
    await assert.rejects(first, { code: 'DEVICE_REGISTRATION_FAILED' });
    now += 9999;
    assert.equal(get(() => assert.fail('cooldown must prevent retries')), first);
    assert.equal(calls, 1);
    now++;
    let finish;
    const recovered = get(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
    assert.notEqual(recovered, first, 'a transient failure must not stay cached for the entire process');
    const concurrent = Array.from({ length: 20 }, () => get(() => assert.fail('share recovery')));
    assert.ok(concurrent.every(promise => promise === recovered));
    await Promise.resolve();
    finish({ device_id: '123', install_id: '456' });
    const identity = await recovered;
    assert.ok((await Promise.all(concurrent)).every(value => value === identity));
    now += 60000;
    assert.equal(get(() => assert.fail('keep successful identity')), recovered);
    assert.equal(calls, 2);
});

test('a repeated registration failure starts a new cooldown instead of a retry storm', async () => {
    let now = Date.now(), calls = 0;
    const get = load({ now: () => now });
    const fail = async () => { calls++; throw new Error('PRIVATE_RESPONSE_SENTINEL'); };
    const first = get(fail);
    await assert.rejects(first);
    now += 10000;
    const second = get(fail);
    assert.notEqual(second, first);
    await assert.rejects(second);
    now += 9999;
    assert.equal(get(() => assert.fail('second cooldown')), second);
    assert.equal(calls, 2);
});

test('registration reports only whitelisted failure reasons without retaining response or credentials', async () => {
    for (const [input, expected] of [
        [{ code: 'ETIMEDOUT' }, 'TIMEOUT'], [{ code: 'ECONNABORTED' }, 'TIMEOUT'],
        [{ code: 'ENOTFOUND' }, 'NETWORK_ERROR'], [{ code: 'ECONNRESET' }, 'NETWORK_ERROR'],
        [{ code: 'ERR_NETWORK' }, 'NETWORK_ERROR'], [{ status: 403 }, 'HTTP_403'],
        [{ status: 503 }, 'HTTP_503'], [{ code: 'EMPTY_RESPONSE' }, 'EMPTY_RESPONSE'],
        [{ code: 'INVALID_RESPONSE' }, 'INVALID_RESPONSE'], [{ code: 'SECURITY_BLOCKED' }, 'SECURITY_BLOCKED'],
        [{ code: 'PRIVATE_RESPONSE_SENTINEL', status: 'PRIVATE_RESPONSE_SENTINEL' }, 'UNKNOWN'],
    ]) {
        await assert.rejects(load()(async () => {
            throw Object.assign(new Error('PRIVATE_RESPONSE_SENTINEL'), input, { response: { device_token: 'PRIVATE_RESPONSE_SENTINEL' } });
        }), error => {
            assert.equal(error.code, 'DEVICE_REGISTRATION_FAILED');
            assert.equal(error.registrationFailure, expected);
            assert.equal(error.message, failureMessage);
            assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /PRIVATE_RESPONSE_SENTINEL/);
            return true;
        });
    }
    await assert.rejects(load()(async () => ({ device_id: '0', install_id: '456' })), { registrationFailure: 'INVALID_RESPONSE' });
    await assert.rejects(load()(async () => ({ code: 1, device_id: '123', install_id: '456' })), { registrationFailure: 'BUSINESS_REJECTED' });
});

test('fallback IDs accept only positive digit strings or safe integers without losing precision', async () => {
    for (const [response, device, install] of [
        [{ device_id: 123, install_id: Number.MAX_SAFE_INTEGER }, '123', String(Number.MAX_SAFE_INTEGER)],
        [{ device_id: '9007199254740993', install_id: '9007199254741993' }, '9007199254740993', '9007199254741993'],
        [{ device_id: '1'.repeat(30), install_id: '2'.repeat(30) }, '1'.repeat(30), '2'.repeat(30)],
        [{ device_id_str: '', device_id: '123', install_id_str: null, install_id: 456 }, '123', '456'],
    ]) {
        const identity = await load()(async () => response);
        assert.equal(identity.device_id, device);
        assert.equal(identity.iid, install);
    }
});

test('zero, unsafe, malformed or missing IDs reject safely and cannot create a retry device', async () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '', '0', '000', '1e3', ' 123', '1'.repeat(31), true, {}, undefined]) {
        for (const name of ['device_id', 'install_id']) {
            const get = load();
            let calls = 0;
            const first = get(async () => { calls++; return { device_id: '123', install_id: '456', [name]: value }; });
            await assert.rejects(first, { code: 'DEVICE_REGISTRATION_FAILED', message: failureMessage });
            assert.equal(get(() => assert.fail('invalid identity must not retry')), first);
            assert.equal(calls, 1);
        }
    }
    await assert.rejects(load()(async () => ({ device_id_str: '0', device_id: '123', install_id: '456' })), { code: 'DEVICE_REGISTRATION_FAILED' });
    for (const name of ['device_id', 'install_id']) {
        await assert.rejects(load()(async () => ({ device_id: '123', install_id: '456', [`${name}_str`]: '1'.repeat(31) })), { code: 'DEVICE_REGISTRATION_FAILED' });
    }
    await assert.rejects(load()(async () => null), { code: 'DEVICE_REGISTRATION_FAILED' });
});

test('business rejection cannot be accepted even if IDs are present', async () => {
    for (const status of [{ code: 1 }, { Code: 1 }]) {
        await assert.rejects(load()(async () => ({ ...status, device_id: '123', install_id: '456', message: 'PRIVATE_RESPONSE_SENTINEL' })), {
            code: 'DEVICE_REGISTRATION_FAILED', message: failureMessage,
        });
    }
});
