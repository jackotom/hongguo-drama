const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { after, test } = require('node:test');

const originalLoad = Module._load;
const children = [];
const spawnedArgs = [];

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
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                child.killed = false;
                child.kill = () => { child.killed = true; };
                children.push(child);
                spawnedArgs.push(args);
                return child;
            },
        };
    }
    return originalLoad.apply(this, arguments);
};

const {
    resolveSdkPlayback,
    resolveSdkPlaybackBatch,
    clearSdkModelCache,
} = require('./sdk-playback');

after(() => {
    clearSdkModelCache();
    Module._load = originalLoad;
});

function withDarwin(t) {
    if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) return;
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const origArch = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    t.after(() => {
        Object.defineProperty(process, 'platform', origPlatform);
        Object.defineProperty(process, 'arch', origArch);
    });
}

function finish(child, payload = { ok: true, model: {}, userAgent: 'fixture' }) {
    child.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
    child.emit('close', 0);
}

test('SDK helpers are capped at three concurrent processes', async t => {
    withDarwin(t);
    clearSdkModelCache();
    children.length = 0;
    spawnedArgs.length = 0;
    const pending = ['11', '12', '13', '14'].map(vid => resolveSdkPlayback(vid));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 3);
    finish(children[0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 4);
    for (const child of children.slice(1)) finish(child);
    assert.deepEqual(await Promise.all(pending), Array.from({ length: 4 }, () => ({ model: {}, userAgent: 'fixture' })));
});

test('batchVids coalesces concurrent episodes into one --videos call and caches remaining episodes', async t => {
    withDarwin(t);
    clearSdkModelCache();
    children.length = 0;
    spawnedArgs.length = 0;

    const batchVids = ['10000001', '10000002', '10000003'];
    const p1 = resolveSdkPlayback('10000001', { batchVids });
    const p2 = resolveSdkPlayback('10000002', { batchVids });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(children.length, 1);
    assert.equal(spawnedArgs[0][0], '--videos');
    assert.equal(spawnedArgs[0][1], '10000001,10000002,10000003');

    finish(children[0], {
        ok: true,
        models: {
            '10000001': { ep: 1 },
            '10000002': { ep: 2 },
            '10000003': { ep: 3 },
            '99999999': { ep: 99 },
        },
        userAgent: 'batch-ua',
    });

    assert.deepEqual(await p1, { model: { ep: 1 }, userAgent: 'batch-ua' });
    assert.deepEqual(await p2, { model: { ep: 2 }, userAgent: 'batch-ua' });

    // Third episode from the same batch resolves from memory without spawning another process.
    const r3 = await resolveSdkPlayback('10000003');
    assert.deepEqual(r3, { model: { ep: 3 }, userAgent: 'batch-ua' });
    assert.equal(children.length, 1);

    // fresh: true bypasses the batch cache and spawns a fresh single --video lookup.
    const pFresh = resolveSdkPlayback('10000003', { fresh: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 2);
    assert.equal(spawnedArgs[1][0], '--video');
    assert.equal(spawnedArgs[1][1], '10000003');
    finish(children[1], { ok: true, model: { ep: 3, fresh: true }, userAgent: 'fresh-ua' });
    assert.deepEqual(await pFresh, { model: { ep: 3, fresh: true }, userAgent: 'fresh-ua' });
});

test('cancelling one batch waiter preserves other waiters; cancelling all kills the helper', async t => {
    withDarwin(t);
    clearSdkModelCache();
    children.length = 0;
    spawnedArgs.length = 0;

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = resolveSdkPlayback('20000001', { batchVids: ['20000001', '20000002'], signal: c1.signal });
    const p2 = resolveSdkPlayback('20000002', { batchVids: ['20000001', '20000002'], signal: c2.signal });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 1);

    c1.abort();
    assert.equal(await p1, null);
    assert.equal(children[0].killed, false, 'helper must stay alive while another waiter remains');

    c2.abort();
    assert.equal(await p2, null);
    assert.equal(children[0].killed, true, 'helper must be killed once all waiters cancel');
});

test('older helper without --videos falls back cleanly to single --video', async t => {
    withDarwin(t);
    clearSdkModelCache();
    children.length = 0;
    spawnedArgs.length = 0;

    const pending = resolveSdkPlayback('30000001', { batchVids: ['30000001', '30000002'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 1);
    assert.equal(spawnedArgs[0][0], '--videos');
    children[0].stderr.emit('data', Buffer.from('error: unrecognized arguments: --videos 30000001,30000002\n'));
    children[0].emit('close', 2);

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 2);
    assert.equal(spawnedArgs[1][0], '--video');
    assert.equal(spawnedArgs[1][1], '30000001');
    finish(children[1], { ok: true, model: { fallback: true }, userAgent: 'single-ua' });
    assert.deepEqual(await pending, { model: { fallback: true }, userAgent: 'single-ua' });
});

test('resolveSdkPlaybackBatch returns only requested models and populates cache', async t => {
    withDarwin(t);
    clearSdkModelCache();
    children.length = 0;
    spawnedArgs.length = 0;

    const pending = resolveSdkPlaybackBatch(['40000001', '40000002', '40000001']);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 1);
    assert.deepEqual(spawnedArgs[0].slice(0, 2), ['--videos', '40000001,40000002']);
    finish(children[0], {
        ok: true,
        models: { '40000001': { a: 1 }, '40000002': { b: 2 }, '49999999': { extra: true } },
        userAgent: 'batch-ua',
    });
    const map = await pending;
    assert.equal(map.size, 2);
    assert.equal(map.has('49999999'), false);
    assert.deepEqual(map.get('40000001'), { model: { a: 1 }, userAgent: 'batch-ua' });
    assert.deepEqual(map.get('40000002'), { model: { b: 2 }, userAgent: 'batch-ua' });
});
