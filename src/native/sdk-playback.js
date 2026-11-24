// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 512 * 1024;
const MAX_BATCH_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT = 45000;
const MAX_CONCURRENT_HELPERS = 3;
const MAX_BATCH_VIDEOS = 8;
const MAX_PROTOCOL_BATCH = 10;
const MODEL_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_MODEL_CACHE = 128;
let activeHelpers = 0;
const helperWaiters = [];
const sdkModelCache = new Map();
const pendingBatches = new Map();

function electronApp() {
    try {
        const electron = require('electron');
        return electron?.app?.getPath ? electron.app : null;
    } catch {
        return null;
    }
}

function executablePath(app) {
    if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) return null;
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'sdk-playback',
            `darwin-${process.arch}`, 'hongguo-sdk-playback');
    }
    return path.join(__dirname, '..', '..', 'build', 'sdk-playback',
        `darwin-${process.arch}`, 'hongguo-sdk-playback');
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSinglePayload(stdout) {
    const payload = JSON.parse(stdout);
    if (payload?.ok !== true || !isPlainObject(payload.model) ||
        typeof payload.userAgent !== 'string' || !payload.userAgent.trim()) {
        return null;
    }
    return { model: payload.model, userAgent: payload.userAgent.slice(0, 512) };
}

function parseBatchPayload(stdout, requested) {
    const payload = JSON.parse(stdout);
    if (payload?.ok !== true || !isPlainObject(payload.models) ||
        typeof payload.userAgent !== 'string' || !payload.userAgent.trim()) {
        return null;
    }
    const userAgent = payload.userAgent.slice(0, 512);
    const models = new Map();
    for (const vid of requested) {
        if (!Object.prototype.hasOwnProperty.call(payload.models, vid)) continue;
        const model = payload.models[vid];
        if (isPlainObject(model)) models.set(vid, { model, userAgent });
    }
    return models.size ? models : null;
}

function normalizeBatchVids(vids, max = MAX_BATCH_VIDEOS) {
    if (!Array.isArray(vids)) return [];
    const ordered = [];
    const seen = new Set();
    for (const raw of vids) {
        const vid = String(raw ?? '').trim();
        if (!/^\d{1,30}$/.test(vid) || seen.has(vid)) continue;
        seen.add(vid);
        ordered.push(vid);
        if (ordered.length >= max) break;
    }
    return ordered;
}

function readCachedModel(vid) {
    const entry = sdkModelCache.get(vid);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        sdkModelCache.delete(vid);
        return null;
    }
    return entry.value;
}

function storeCachedModels(models) {
    const expiresAt = Date.now() + MODEL_CACHE_TTL_MS;
    for (const [vid, value] of models) {
        sdkModelCache.delete(vid);
        sdkModelCache.set(vid, { value, expiresAt });
    }
    while (sdkModelCache.size > MAX_MODEL_CACHE) {
        const oldest = sdkModelCache.keys().next().value;
        sdkModelCache.delete(oldest);
    }
}

function clearSdkModelCache() {
    sdkModelCache.clear();
}

function runHelper(executable, args, signal, timeoutMs, maxOutput = MAX_OUTPUT, parser = parseSinglePayload) {
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
            if (stdout.length > maxOutput) cancel();
        });
        child.stderr.on('data', chunk => {
            stderr = (stderr + chunk.toString('utf8')).slice(-4096);
        });
        child.on('error', () => finish(null));
        child.on('close', code => {
            if (settled) return;
            if (code !== 0) {
                if (args[0] === '--videos' && /unrecognized arguments:\s*--videos/i.test(stderr)) {
                    finish({ unsupportedBatch: true });
                    return;
                }
                if (stderr) console.warn('[SDK playback] helper failed:', stderr.replace(/\s+/g, ' ').slice(0, 240));
                finish(null);
                return;
            }
            try {
                finish(parser(stdout));
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

function resolveEnvironment() {
    const app = electronApp();
    if (!app) return null;
    const executable = executablePath(app);
    if (!executable) return null;
    if (!fs.statSync(executable).isFile()) return null;
    const cachePath = path.join(app.getPath('userData'), 'sdk-playback');
    fs.mkdirSync(cachePath, { recursive: true });
    const cacheDir = fs.realpathSync(cachePath);
    return { executable, cacheDir };
}

function awaitBatchEntry(entry, vid, signal) {
    if (signal?.aborted) return Promise.resolve(null);
    entry.waiters++;
    let released = false;
    const releaseWaiter = () => {
        if (released) return;
        released = true;
        entry.waiters--;
        if (entry.waiters <= 0 && !entry.settled) entry.controller.abort();
    };
    return new Promise(resolve => {
        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => {
            releaseWaiter();
            finish(null);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }
        entry.promise.then(
            result => {
                releaseWaiter();
                if (result?.unsupportedBatch) finish(result);
                else finish(result instanceof Map ? (result.get(vid) || null) : null);
            },
            () => {
                releaseWaiter();
                finish(null);
            }
        );
    });
}

function startBatch(vids, env, timeoutMs) {
    const controller = new AbortController();
    const entry = { controller, waiters: 0, settled: false, promise: null };
    for (const vid of vids) pendingBatches.set(vid, entry);
    entry.promise = (async () => {
        try {
            await acquireHelper(controller.signal);
            try {
                const result = await runHelper(
                    env.executable,
                    ['--videos', vids.join(','), '--cache', env.cacheDir],
                    controller.signal,
                    timeoutMs,
                    MAX_BATCH_OUTPUT,
                    stdout => parseBatchPayload(stdout, vids)
                );
                if (result instanceof Map) storeCachedModels(result);
                return result;
            } finally {
                releaseHelper();
            }
        } catch {
            return null;
        } finally {
            entry.settled = true;
            for (const vid of vids) {
                if (pendingBatches.get(vid) === entry) pendingBatches.delete(vid);
            }
        }
    })();
    return entry;
}

async function resolveSdkPlaybackBatch(vids, options = {}) {
    const requested = normalizeBatchVids(vids, MAX_PROTOCOL_BATCH);
    if (!requested.length || options.signal?.aborted) return null;
    try {
        const env = resolveEnvironment();
        if (!env) return null;
        const results = new Map();
        const missing = [];
        for (const vid of requested) {
            const cached = options.fresh ? null : readCachedModel(vid);
            if (cached) results.set(vid, cached);
            else {
                if (options.fresh) sdkModelCache.delete(vid);
                missing.push(vid);
            }
        }
        if (!missing.length) return results;
        const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT;
        await acquireHelper(options.signal);
        try {
            const fetched = await runHelper(
                env.executable,
                ['--videos', missing.join(','), '--cache', env.cacheDir],
                options.signal,
                timeoutMs,
                MAX_BATCH_OUTPUT,
                stdout => parseBatchPayload(stdout, missing)
            );
            if (fetched instanceof Map) {
                storeCachedModels(fetched);
                for (const [vid, value] of fetched) results.set(vid, value);
            }
        } finally {
            releaseHelper();
        }
        return results.size ? results : null;
    } catch {
        return null;
    }
}

async function resolveSdkPlayback(vid, options = {}) {
    const key = String(vid ?? '');
    if (!/^\d{1,30}$/.test(key) || options.signal?.aborted) return null;
    try {
        const env = resolveEnvironment();
        if (!env) return null;
        const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT;
        if (!options.fresh) {
            const cached = readCachedModel(key);
            if (cached) return cached;
            const inflight = pendingBatches.get(key);
            if (inflight) {
                const shared = await awaitBatchEntry(inflight, key, options.signal);
                if (!shared?.unsupportedBatch) return shared;
            }
            if (Array.isArray(options.batchVids) && options.batchVids.length > 1) {
                const candidates = normalizeBatchVids([key, ...options.batchVids], MAX_BATCH_VIDEOS)
                    .filter(item => item === key || (!readCachedModel(item) && !pendingBatches.has(item)));
                if (candidates.length > 1) {
                    const entry = startBatch(candidates, env, timeoutMs);
                    const batchResult = await awaitBatchEntry(entry, key, options.signal);
                    if (!batchResult?.unsupportedBatch) return batchResult;
                }
            }
        } else {
            sdkModelCache.delete(key);
        }
        await acquireHelper(options.signal);
        try {
            return await runHelper(env.executable, ['--video', key, '--cache', env.cacheDir],
                options.signal, timeoutMs);
        } finally {
            releaseHelper();
        }
    } catch {
        return null;
    }
}

module.exports = {
    resolveSdkPlayback,
    resolveSdkPlaybackBatch,
    clearSdkModelCache,
    MAX_BATCH_VIDEOS,
};
