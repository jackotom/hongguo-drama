const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { test, after } = require('node:test');

const originalLoad = Module._load;
const children = [];

Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
        return { app: { isPackaged: false, getPath: () => '/tmp/hongguo-sdk-test' } };
    }
    if (request === 'node:fs') {
        return {
            statSync: () => ({ isFile: () => true }),
            mkdirSync: () => {},
            realpathSync: value => value,
        };
    }
    if (request === 'node:child_process') {
        return {
            spawn: (_executable, args) => {
                const child = new EventEmitter();
                child.args = args;
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                child.killed = false;
                child.kill = () => { child.killed = true; };
                children.push(child);
                return child;
            },
        };
    }
    return originalLoad.apply(this, arguments);
};

const { resolveSdkPlayback, executablePath } = require('./sdk-playback');
const sdkSupportedHost = process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64');

after(() => { Module._load = originalLoad; });

function finish(child) {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, model: {}, userAgent: 'fixture' })));
    child.emit('close', 0);
}

test('executablePath resolves macOS arm64/x64 and Windows x64 binaries and rejects unsupported targets', () => {
    const devApp = { isPackaged: false };
    const macArm = executablePath(devApp, 'darwin', 'arm64');
    const macX64 = executablePath(devApp, 'darwin', 'x64');
    const winX64 = executablePath(devApp, 'win32', 'x64');
    assert.ok(macArm && macArm.endsWith(path.join('build', 'sdk-playback', 'darwin-arm64', 'hongguo-sdk-playback')));
    assert.ok(macX64 && macX64.endsWith(path.join('build', 'sdk-playback', 'darwin-x64', 'hongguo-sdk-playback')));
    assert.ok(winX64 && winX64.endsWith(path.join('build', 'sdk-playback', 'win32-x64', 'hongguo-sdk-playback.exe')));
    assert.equal(executablePath(devApp, 'win32', 'arm64'), null);
    assert.equal(executablePath(devApp, 'linux', 'x64'), null);
});

test('SDK helpers are capped at three concurrent processes', { skip: !sdkSupportedHost }, async () => {
    const pending = ['11', '12', '13', '14'].map(vid => resolveSdkPlayback(vid));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 3);
    finish(children[0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 4);
    for (const child of children.slice(1)) finish(child);
    assert.deepEqual(await Promise.all(pending), Array.from({ length: 4 }, () => ({ model: {}, userAgent: 'fixture' })));
    const errors = [];
    const failed = resolveSdkPlayback('15', { onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    children[4].stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, error: 'RuntimeError: fixture failure' })));
    children[4].emit('close', 1);
    assert.equal(await failed, null);
    assert.equal(errors[0].code, 'SDK_HELPER_FAILED');
    assert.match(errors[0].message, /fixture failure/);
});

test('SDK timeout kills the helper and reports SDK_TIMEOUT', { skip: !sdkSupportedHost }, async () => {
    const errors = [];
    const pending = resolveSdkPlayback('16', { timeoutMs: 5, onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await pending, null);
    assert.equal(children.at(-1).killed, true);
    assert.equal(errors[0].code, 'SDK_TIMEOUT');
});

test('SDK cancellation kills the helper without reporting a failure', { skip: !sdkSupportedHost }, async () => {
    const controller = new AbortController(), errors = [];
    const pending = resolveSdkPlayback('17', { contentType: '1001', signal: controller.signal, onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(children.at(-1).killed, true);
    assert.deepEqual(children.at(-1).args.slice(-2), ['--content-type', '1001']);
    assert.deepEqual(errors, []);
});

test('SDK spawn failure reports SDK_SPAWN_FAILED', { skip: !sdkSupportedHost }, async () => {
    const errors = [];
    const pending = resolveSdkPlayback('18', { onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    children.at(-1).emit('error', new Error('fixture spawn failure'));
    assert.equal(await pending, null);
    assert.equal(errors[0].code, 'SDK_SPAWN_FAILED');
});

test('SDK invalid output reports SDK_INVALID_RESPONSE', { skip: !sdkSupportedHost }, async () => {
    const errors = [];
    const pending = resolveSdkPlayback('19', { onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    children.at(-1).stdout.emit('data', Buffer.from(JSON.stringify({ ok: false })));
    children.at(-1).emit('close', 0);
    assert.equal(await pending, null);
    assert.equal(errors[0].code, 'SDK_INVALID_RESPONSE');
});

test('priority playback starts before queued SDK downloads', { skip: !sdkSupportedHost }, async () => {
    const start = children.length;
    const active = ['20', '21', '22'].map(vid => resolveSdkPlayback(vid));
    await new Promise(resolve => setImmediate(resolve));
    const download = resolveSdkPlayback('23');
    const playback = resolveSdkPlayback('24', { priority: true });
    await new Promise(resolve => setImmediate(resolve));
    finish(children[start]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(children[start + 3].args.slice(0, 2), ['--video', '24']);
    finish(children[start + 1]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(children[start + 4].args.slice(0, 2), ['--video', '23']);
    finish(children[start + 2]);
    finish(children[start + 3]);
    finish(children[start + 4]);
    await Promise.all([...active, download, playback]);
});
