const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
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

const { resolveSdkPlayback } = require('./sdk-playback');

after(() => { Module._load = originalLoad; });

function finish(child) {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, model: {}, userAgent: 'fixture' })));
    child.emit('close', 0);
}

test('SDK helpers are capped at three concurrent processes', { skip: process.platform !== 'darwin' }, async () => {
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

test('SDK timeout kills the helper and reports SDK_TIMEOUT', { skip: process.platform !== 'darwin' }, async () => {
    const errors = [];
    const pending = resolveSdkPlayback('16', { timeoutMs: 5, onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await pending, null);
    assert.equal(children.at(-1).killed, true);
    assert.equal(errors[0].code, 'SDK_TIMEOUT');
});

test('SDK cancellation kills the helper without reporting a failure', { skip: process.platform !== 'darwin' }, async () => {
    const controller = new AbortController(), errors = [];
    const pending = resolveSdkPlayback('17', { contentType: '1001', signal: controller.signal, onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(children.at(-1).killed, true);
    assert.deepEqual(children.at(-1).args.slice(-2), ['--content-type', '1001']);
    assert.deepEqual(errors, []);
});

test('SDK spawn failure reports SDK_SPAWN_FAILED', { skip: process.platform !== 'darwin' }, async () => {
    const errors = [];
    const pending = resolveSdkPlayback('18', { onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    children.at(-1).emit('error', new Error('fixture spawn failure'));
    assert.equal(await pending, null);
    assert.equal(errors[0].code, 'SDK_SPAWN_FAILED');
});

test('SDK invalid output reports SDK_INVALID_RESPONSE', { skip: process.platform !== 'darwin' }, async () => {
    const errors = [];
    const pending = resolveSdkPlayback('19', { onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    children.at(-1).stdout.emit('data', Buffer.from(JSON.stringify({ ok: false })));
    children.at(-1).emit('close', 0);
    assert.equal(await pending, null);
    assert.equal(errors[0].code, 'SDK_INVALID_RESPONSE');
});
