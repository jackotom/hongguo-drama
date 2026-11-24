const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const { after, test } = require('node:test');

const originalLoad = Module._load;
const children = [];
const spawnedCalls = [];
let mockElectron = { app: { isPackaged: false, getPath: () => '/tmp/hongguo-sdk-test' } };

Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
        if (mockElectron instanceof Error) throw mockElectron;
        return mockElectron;
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
    executablePath,
    resolveCacheDir,
    createSdkPlaybackSession,
} = require('./sdk-playback');

after(() => {
    Module._load = originalLoad;
});

function finish(child) {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, model: {}, userAgent: 'fixture' })));
    child.emit('close', 0);
}

function withPlatform(t, platform, arch) {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const origArch = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
    t.after(() => {
        Object.defineProperty(process, 'platform', origPlatform);
        Object.defineProperty(process, 'arch', origArch);
    });
}

function withElectron(t) {
    const origVersions = Object.getOwnPropertyDescriptor(process, 'versions');
    Object.defineProperty(process, 'versions', {
        value: { ...process.versions, electron: '44.9.1' },
        configurable: true,
    });
    t.after(() => {
        Object.defineProperty(process, 'versions', origVersions);
    });
}

test('SDK helpers are capped at three concurrent processes', async t => {
    children.length = 0;
    spawnedCalls.length = 0;
    withElectron(t);
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
        withPlatform(t, 'win32', 'x64');
    }
    const pending = ['11', '12', '13', '14'].map(vid => resolveSdkPlayback(vid));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 3);
    finish(children[0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 4);
    for (const child of children.slice(1)) finish(child);
    assert.deepEqual(await Promise.all(pending), Array.from({ length: 4 }, () => ({ model: {}, userAgent: 'fixture' })));
});

test('executablePath resolves win32-x64 .exe and darwin binaries for dev and packaged apps', t => {
    const origResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { value: path.join('/opt', 'hongguo', 'resources'), configurable: true });
    t.after(() => {
        if (origResources) Object.defineProperty(process, 'resourcesPath', origResources);
        else delete process.resourcesPath;
    });

    const devWin = executablePath({ isPackaged: false }, 'win32', 'x64');
    assert.equal(devWin.endsWith(path.join('build', 'sdk-playback', 'win32-x64', 'hongguo-sdk-playback.exe')), true);

    const packedWin = executablePath({ isPackaged: true }, 'win32', 'x64');
    assert.equal(
        packedWin,
        path.join('/opt', 'hongguo', 'resources', 'app.asar.unpacked', 'build', 'sdk-playback', 'win32-x64', 'hongguo-sdk-playback.exe')
    );

    const standaloneWin = executablePath(null, 'win32', 'x64');
    assert.equal(standaloneWin.endsWith(path.join('build', 'sdk-playback', 'win32-x64', 'hongguo-sdk-playback.exe')), true);

    const devMac = executablePath({ isPackaged: false }, 'darwin', 'arm64');
    assert.equal(devMac.endsWith(path.join('build', 'sdk-playback', 'darwin-arm64', 'hongguo-sdk-playback')), true);

    assert.equal(executablePath({ isPackaged: false }, 'win32', 'arm64'), null);
    assert.equal(executablePath({ isPackaged: false }, 'linux', 'x64'), null);
});

test('resolveSdkPlayback and resolveCacheDir work outside Electron', async t => {
    children.length = 0;
    spawnedCalls.length = 0;
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
        withPlatform(t, 'win32', 'x64');
    }

    const fallbackCache = resolveCacheDir(null);
    assert.equal(path.basename(fallbackCache), 'sdk-playback');
    assert.equal(path.isAbsolute(fallbackCache), true);

    const customCache = path.resolve('/tmp/custom-sdk-cache');
    assert.equal(resolveCacheDir(null, { cacheDir: customCache }), customCache);

    const promise = resolveSdkPlayback('12345678', { cacheDir: customCache });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 1);
    assert.deepEqual(spawnedCalls[0].args, ['--video', '12345678', '--cache', customCache]);
    finish(children[0]);
    assert.deepEqual(await promise, { model: {}, userAgent: 'fixture' });
});

test('createSdkPlaybackSession reuses one --serve process across requests', async t => {
    children.length = 0;
    spawnedCalls.length = 0;
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
        withPlatform(t, 'win32', 'x64');
    }

    const session = createSdkPlaybackSession({ cacheDir: '/tmp/serve-cache' });
    t.after(() => {
        session.close();
    });

    const first = session.resolve('10000001');
    const second = session.resolve('10000002');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(children.length, 1);
    assert.equal(spawnedCalls[0].args[0], '--serve');
    assert.equal(children[0].stdin.writes.length, 1);
    const req1 = JSON.parse(children[0].stdin.writes[0]);
    assert.equal(req1.video, '10000001');

    children[0].stdout.emit('data', Buffer.from(JSON.stringify({ id: req1.id, ok: true, model: { ep: 1 }, userAgent: 'ua-1' }) + '\n'));
    assert.deepEqual(await first, { model: { ep: 1 }, userAgent: 'ua-1' });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 1);
    assert.equal(children[0].stdin.writes.length, 2);
    const req2 = JSON.parse(children[0].stdin.writes[1]);
    assert.equal(req2.video, '10000002');

    children[0].stdout.emit('data', Buffer.from(JSON.stringify({ id: req2.id, ok: true, model: { ep: 2 }, userAgent: 'ua-2' }) + '\n'));
    assert.deepEqual(await second, { model: { ep: 2 }, userAgent: 'ua-2' });
});
