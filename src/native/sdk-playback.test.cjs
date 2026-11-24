const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { after, test } = require('node:test');

const originalLoad = Module._load;
const originalVersions = process.versions;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
const children = [];
const spawnedCalls = [];

Object.defineProperty(process, 'versions', {
    value: { ...originalVersions, electron: '44.11.5' },
    configurable: true,
});
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });

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
            spawn: (executable, args, opts) => {
                const child = new EventEmitter();
                child.args = args;
                child.stdin = new EventEmitter();
                child.stdin.writes = [];
                child.stdin.write = chunk => {
                    child.stdin.writes.push(String(chunk));
                    return true;
                };
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                child.killed = false;
                child.kill = () => { child.killed = true; };
                child.unref = () => {};
                children.push(child);
                spawnedCalls.push({ executable, args, opts });
                return child;
            },
        };
    }
    return originalLoad.apply(this, arguments);
};

const {
    resolveSdkPlayback,
    resolveSdkPlaybackBatch,
    createSdkPlaybackSession,
    clearSdkModelCache,
    executablePath,
} = require('./sdk-playback');

after(() => {
    Module._load = originalLoad;
    Object.defineProperty(process, 'versions', {
        value: originalVersions,
        configurable: true,
    });
    Object.defineProperty(process, 'platform', originalPlatform);
    Object.defineProperty(process, 'arch', originalArch);
});

function resetFixtures() {
    clearSdkModelCache();
    children.length = 0;
    spawnedCalls.length = 0;
}

function finish(child, payload = { ok: true, model: {}, userAgent: 'fixture' }) {
    child.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
    child.emit('close', 0);
}

function finishBatch(child, models, userAgent = 'batch-ua') {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, models, userAgent })));
    child.emit('close', 0);
}

test('executablePath resolves macOS arm64/x64 and Windows x64 binaries', () => {
    const devApp = { isPackaged: false };
    assert.ok(executablePath(devApp, 'darwin', 'arm64')
        .endsWith(path.join('build', 'sdk-playback', 'darwin-arm64', 'hongguo-sdk-playback')));
    assert.ok(executablePath(devApp, 'darwin', 'x64')
        .endsWith(path.join('build', 'sdk-playback', 'darwin-x64', 'hongguo-sdk-playback')));
    assert.ok(executablePath(devApp, 'win32', 'x64')
        .endsWith(path.join('build', 'sdk-playback', 'win32-x64', 'hongguo-sdk-playback.exe')));
    assert.equal(executablePath(devApp, 'win32', 'arm64'), null);
    assert.equal(executablePath(devApp, 'linux', 'x64'), null);
});

test('SDK helpers are capped at three concurrent processes and report failures', async () => {
    resetFixtures();
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
    children.at(-1).stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, error: 'RuntimeError: fixture failure' })));
    children.at(-1).emit('close', 1);
    assert.equal(await failed, null);
    assert.equal(errors[0].code, 'SDK_HELPER_FAILED');
    assert.match(errors[0].message, /fixture failure/);
});

test('SDK timeout and cancellation clean up helper processes', async () => {
    resetFixtures();
    const timeoutErrors = [];
    const timedOut = resolveSdkPlayback('16', { timeoutMs: 5, onError: error => timeoutErrors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await timedOut, null);
    assert.equal(children.at(-1).killed, true);
    assert.equal(timeoutErrors[0].code, 'SDK_TIMEOUT');

    const controller = new AbortController();
    const errors = [];
    const pending = resolveSdkPlayback('17', { contentType: '1001', signal: controller.signal, onError: error => errors.push(error) });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(children.at(-1).killed, true);
    assert.deepEqual(children.at(-1).args.slice(-2), ['--content-type', '1001']);
    assert.deepEqual(errors, []);
});

test('batchVids coalesces concurrent episodes and caches remaining models', async () => {
    resetFixtures();
    const batchVids = ['10000001', '10000002', '10000003'];
    const first = resolveSdkPlayback('10000001', { batchVids });
    const second = resolveSdkPlayback('10000002', { batchVids });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(children.length, 1);
    assert.equal(spawnedCalls[0].args[0], '--videos');
    assert.equal(spawnedCalls[0].args[1], '10000001,10000002,10000003');
    finishBatch(children[0], {
        '10000001': { ep: 1 },
        '10000002': { ep: 2 },
        '10000003': { ep: 3 },
        '99999999': { ep: 99 },
    });

    assert.deepEqual(await first, { model: { ep: 1 }, userAgent: 'batch-ua' });
    assert.deepEqual(await second, { model: { ep: 2 }, userAgent: 'batch-ua' });
    assert.deepEqual(await resolveSdkPlayback('10000003'), { model: { ep: 3 }, userAgent: 'batch-ua' });
    assert.equal(children.length, 1);

    const fresh = resolveSdkPlayback('10000003', { fresh: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 2);
    assert.equal(spawnedCalls[1].args[0], '--video');
    finish(children[1], { ok: true, model: { ep: 3, fresh: true }, userAgent: 'fresh-ua' });
    assert.deepEqual(await fresh, { model: { ep: 3, fresh: true }, userAgent: 'fresh-ua' });
});

test('batch cancellation preserves other waiters and falls back to single lookup', async () => {
    resetFixtures();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = resolveSdkPlayback('20000001', {
        batchVids: ['20000001', '20000002'],
        signal: firstController.signal,
    });
    const second = resolveSdkPlayback('20000002', {
        batchVids: ['20000001', '20000002'],
        signal: secondController.signal,
    });
    await new Promise(resolve => setImmediate(resolve));
    firstController.abort();
    assert.equal(await first, null);
    assert.equal(children[0].killed, false);
    secondController.abort();
    assert.equal(await second, null);
    assert.equal(children[0].killed, true);

    resetFixtures();
    const pending = resolveSdkPlayback('30000001', { batchVids: ['30000001', '30000002'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 1);
    children[0].stderr.emit('data', Buffer.from('error: unrecognized arguments: --videos 30000001,30000002\n'));
    children[0].emit('close', 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 2);
    assert.equal(spawnedCalls[1].args[0], '--video');
    finish(children[1], { ok: true, model: { fallback: true }, userAgent: 'single-ua' });
    assert.deepEqual(await pending, { model: { fallback: true }, userAgent: 'single-ua' });
});

test('resolveSdkPlaybackBatch filters requested models and content type', async () => {
    resetFixtures();
    const pending = resolveSdkPlaybackBatch(['40000001', '40000002', '40000001'], { contentType: '1001' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 1);
    assert.deepEqual(spawnedCalls[0].args.slice(0, 2), ['--videos', '40000001,40000002']);
    assert.deepEqual(spawnedCalls[0].args.slice(-2), ['--content-type', '1001']);
    finishBatch(children[0], {
        '40000001': { a: 1 },
        '40000002': { b: 2 },
        '49999999': { extra: true },
    });
    const models = await pending;
    assert.equal(models.size, 2);
    assert.equal(models.has('49999999'), false);
    assert.deepEqual(models.get('40000001'), { model: { a: 1 }, userAgent: 'batch-ua' });
});

test('batch failure is reported without rerunning the same episode as a single request', async () => {
    resetFixtures();
    const errors = [];
    const pending = resolveSdkPlayback('31000001', {
        batchVids: ['31000001', '31000002'],
        onError: error => errors.push(error),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 1);
    children[0].stdout.emit('data', Buffer.from(JSON.stringify({
        ok: false,
        stage: 'playback-send',
        error: 'RuntimeError: fixture batch failure',
    })));
    children[0].emit('close', 1);
    assert.equal(await pending, null);
    assert.equal(children.length, 1);
    assert.equal(errors[0].code, 'SDK_HELPER_FAILED');
    assert.match(errors[0].message, /fixture batch failure/);
});

test('createSdkPlaybackSession reuses one --serve process across requests', async () => {
    resetFixtures();
    const session = createSdkPlaybackSession({ cacheDir: '/tmp/serve-cache' });
    try {
        const first = session.resolve('50000001', { contentType: '1001' });
        const second = session.resolve('50000002');
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(children.length, 1);
        assert.equal(spawnedCalls[0].args[0], '--serve');
        const req1 = JSON.parse(children[0].stdin.writes[0]);
        assert.equal(req1.video, '50000001');
        assert.equal(req1.contentType, '1001');
        children[0].stdout.emit('data', Buffer.from(JSON.stringify({
            id: req1.id,
            ok: true,
            model: { ep: 1 },
            userAgent: 'ua-1',
        }) + '\n'));
        assert.deepEqual(await first, { model: { ep: 1 }, userAgent: 'ua-1' });
        await new Promise(resolve => setImmediate(resolve));
        const req2 = JSON.parse(children[0].stdin.writes[1]);
        assert.equal(req2.video, '50000002');
        assert.equal(req2.contentType, '1004');
        children[0].stdout.emit('data', Buffer.from(JSON.stringify({
            id: req2.id,
            ok: true,
            model: { ep: 2 },
            userAgent: 'ua-2',
        }) + '\n'));
        assert.deepEqual(await second, { model: { ep: 2 }, userAgent: 'ua-2' });
    } finally {
        session.close();
    }
});

test('createSdkPlaybackSession reports a failed response immediately and keeps the worker reusable', async () => {
    resetFixtures();
    const errors = [];
    const session = createSdkPlaybackSession({ cacheDir: '/tmp/serve-cache' });
    try {
        const failed = session.resolve('51000001', { onError: error => errors.push(error) });
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        const failedRequest = JSON.parse(children[0].stdin.writes[0]);
        children[0].stdout.emit('data', Buffer.from(JSON.stringify({
            id: failedRequest.id,
            ok: false,
            stage: 'playback-send',
            error: 'RuntimeError: fixture session failure',
        }) + '\n'));
        assert.equal(await failed, null);
        assert.equal(errors[0].code, 'SDK_HELPER_FAILED');
        assert.match(errors[0].message, /fixture session failure/);
        assert.equal(children[0].killed, false);

        const recovered = session.resolve('51000002');
        await new Promise(resolve => setImmediate(resolve));
        const recoveredRequest = JSON.parse(children[0].stdin.writes[1]);
        children[0].stdout.emit('data', Buffer.from(JSON.stringify({
            id: recoveredRequest.id,
            ok: true,
            model: { recovered: true },
            userAgent: 'ua-recovered',
        }) + '\n'));
        assert.deepEqual(await recovered, { model: { recovered: true }, userAgent: 'ua-recovered' });
    } finally {
        session.close();
    }
});
