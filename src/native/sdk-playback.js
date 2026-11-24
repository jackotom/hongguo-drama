// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 512 * 1024;
const DEFAULT_TIMEOUT = 45000;
const MAX_CONCURRENT_HELPERS = 3;
let activeHelpers = 0;
const helperWaiters = [];

function electronApp() {
    if (!process.versions?.electron) return null;
    try {
        const electron = require('electron');
        return electron?.app?.getPath ? electron.app : null;
    } catch {
        return null;
    }
}

function targetSpec(platform = process.platform, arch = process.arch) {
    if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
        return { dir: `darwin-${arch}`, binary: 'hongguo-sdk-playback' };
    }
    if (platform === 'win32' && arch === 'x64') {
        return { dir: 'win32-x64', binary: 'hongguo-sdk-playback.exe' };
    }
    return null;
}

function executablePath(app, platform = process.platform, arch = process.arch) {
    const target = targetSpec(platform, arch);
    if (!target) return null;
    if (app?.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'sdk-playback',
            target.dir, target.binary);
    }
    return path.join(__dirname, '..', '..', 'build', 'sdk-playback',
        target.dir, target.binary);
}

function resolveCacheDir(app, options = {}) {
    if (options.cacheDir) return path.resolve(String(options.cacheDir));
    if (app) return path.join(app.getPath('userData'), 'sdk-playback');
    if (process.platform === 'win32') {
        const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(base, 'hongguo-drama', 'sdk-playback');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'hongguo-drama', 'sdk-playback');
    }
    const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    return path.join(base, 'hongguo-drama', 'sdk-playback');
}

function parseHelperPayload(raw) {
    const payload = JSON.parse(raw);
    if (payload?.ok !== true || !payload.model || typeof payload.model !== 'object' ||
        Array.isArray(payload.model) || typeof payload.userAgent !== 'string' || !payload.userAgent.trim()) {
        return null;
    }
    return { model: payload.model, userAgent: payload.userAgent.slice(0, 512) };
}

function runHelper(executable, args, signal, timeoutMs) {
    return new Promise(resolve => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const child = spawn(executable, args, {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            resolve(value);
        };
        const cancel = () => {
            if (!child.killed) child.kill();
            finish(null);
        };
        const timer = setTimeout(() => {
            if (!child.killed) child.kill();
            finish(null);
        }, timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        child.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
            if (stdout.length > MAX_OUTPUT) cancel();
        });
        child.stderr.on('data', chunk => {
            stderr = (stderr + chunk.toString('utf8')).slice(-4096);
        });
        child.on('error', () => finish(null));
        child.on('close', code => {
            if (settled) return;
            if (code !== 0) {
                if (stderr) console.warn('[SDK playback] helper failed:', stderr.replace(/\s+/g, ' ').slice(0, 240));
                finish(null);
                return;
            }
            try {
                finish(parseHelperPayload(stdout));
            } catch {
                finish(null);
            }
        });
    });
}

function acquireHelper(signal) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (activeHelpers < MAX_CONCURRENT_HELPERS) {
        activeHelpers++;
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal };
        waiter.abort = () => {
            const index = helperWaiters.indexOf(waiter);
            if (index >= 0) helperWaiters.splice(index, 1);
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        };
        signal?.addEventListener('abort', waiter.abort, { once: true });
        helperWaiters.push(waiter);
        if (signal?.aborted) waiter.abort();
    });
}

function releaseHelper() {
    const waiter = helperWaiters.shift();
    if (!waiter) {
        activeHelpers--;
        return;
    }
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve();
}

function createSdkPlaybackSession(options = {}) {
    const app = electronApp();
    const executable = executablePath(app);
    const cachePath = resolveCacheDir(app, options);
    let child = null;
    let buffer = '';
    let stderr = '';
    let nextId = 1;
    let closed = false;
    let queue = Promise.resolve();
    const pending = new Map();

    function resetWorker() {
        if (child && !child.killed) child.kill();
        child = null;
        buffer = '';
        stderr = '';
        for (const entry of pending.values()) entry.finish(null);
        pending.clear();
    }

    function ensureWorker() {
        if (closed || !executable) return null;
        if (child && !child.killed) return child;
        if (!fs.statSync(executable).isFile()) return null;
        fs.mkdirSync(cachePath, { recursive: true });
        const cacheDir = fs.realpathSync(cachePath);
        const proc = spawn(executable, ['--serve', '--cache', cacheDir], {
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.unref?.();
        proc.stdout.on('data', chunk => {
            buffer += chunk.toString('utf8');
            if (buffer.length > MAX_OUTPUT * 2) {
                resetWorker();
                return;
            }
            for (;;) {
                const nl = buffer.indexOf('\n');
                if (nl < 0) break;
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                try {
                    const raw = JSON.parse(line);
                    const entry = pending.get(raw?.id);
                    if (!entry) continue;
                    pending.delete(raw.id);
                    entry.finish(parseHelperPayload(line));
                } catch {
                    resetWorker();
                    break;
                }
            }
        });
        proc.stdin.on('error', () => {
            if (child === proc) resetWorker();
        });
        proc.stderr.on('data', chunk => {
            stderr = (stderr + chunk.toString('utf8')).slice(-4096);
        });
        proc.on('error', () => {
            if (child === proc) resetWorker();
        });
        proc.on('close', code => {
            if (code && stderr) {
                console.warn('[SDK playback] helper failed:', stderr.replace(/\s+/g, ' ').slice(0, 240));
            }
            if (child === proc) resetWorker();
        });
        child = proc;
        return proc;
    }

    function sendOne(vid, callOptions = {}) {
        return new Promise(resolve => {
            if (closed || !/^\d{1,30}$/.test(String(vid)) || callOptions.signal?.aborted) {
                resolve(null);
                return;
            }
            let proc;
            try {
                proc = ensureWorker();
            } catch {
                resolve(null);
                return;
            }
            if (!proc) {
                resolve(null);
                return;
            }
            const id = nextId++;
            const timeoutMs = Number(callOptions.timeoutMs) || DEFAULT_TIMEOUT;
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callOptions.signal?.removeEventListener('abort', cancel);
                pending.delete(id);
                resolve(value);
            };
            const cancel = () => {
                resetWorker();
                finish(null);
            };
            const timer = setTimeout(cancel, timeoutMs);
            timer.unref?.();
            callOptions.signal?.addEventListener('abort', cancel, { once: true });
            pending.set(id, { finish });
            try {
                proc.stdin.write(JSON.stringify({ id, video: String(vid) }) + '\n');
            } catch {
                resetWorker();
                finish(null);
            }
        });
    }

    return {
        resolve(vid, callOptions = {}) {
            const run = queue.then(() => sendOne(vid, callOptions));
            queue = run.catch(() => null);
            return run;
        },
        close() {
            closed = true;
            resetWorker();
        },
    };
}

async function resolveSdkPlayback(vid, options = {}) {
    if (!/^\d{1,30}$/.test(String(vid))) return null;
    if (options.session) return options.session.resolve(vid, options);
    const app = electronApp();
    const executable = executablePath(app);
    if (!executable) return null;
    try {
        if (!fs.statSync(executable).isFile()) return null;
        const cachePath = resolveCacheDir(app, options);
        fs.mkdirSync(cachePath, { recursive: true });
        const cacheDir = fs.realpathSync(cachePath);
        await acquireHelper(options.signal);
        try {
            return await runHelper(executable, ['--video', String(vid), '--cache', cacheDir],
                options.signal, Number(options.timeoutMs) || DEFAULT_TIMEOUT);
        } finally {
            releaseHelper();
        }
    } catch {
        return null;
    }
}

module.exports = { resolveSdkPlayback, executablePath, resolveCacheDir, createSdkPlaybackSession };
