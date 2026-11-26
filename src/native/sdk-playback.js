// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 512 * 1024;
const MAX_BATCH_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT = 45000;
const MAX_CONCURRENT_HELPERS = 3;
const MAX_BATCH_VIDEOS = 8;
const MODEL_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_MODEL_CACHE = 128;
let activeHelpers = 0;
const helperWaiters = [];
const priorityHelperWaiters = [];
const sdkModelCache = new Map();
const pendingBatches = new Map();

function sdkError(message, code = 'SDK_PLAYBACK_FAILED') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function safeDetail(value) {
    return String(value || '').replace(/https?:\/\/\S+/gi, '[url]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validVideo(vid) {
    return /^[1-9]\d{0,29}$/.test(String(vid));
}

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
    return path.join(__dirname, '..', '..', 'build', 'sdk-playback', target.dir, target.binary);
}

function resolveCacheDir(app, options = {}) {
    if (options.cacheDir) return path.resolve(String(options.cacheDir));
    if (app?.getPath) return path.join(app.getPath('userData'), 'sdk-playback');
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

function parseSinglePayload(raw) {
    const payload = JSON.parse(raw);
    if (payload?.ok !== true || !isPlainObject(payload.model) ||
        typeof payload.userAgent !== 'string' || !payload.userAgent.trim()) {
        throw sdkError('SDK 返回数据无效', 'SDK_INVALID_RESPONSE');
    }
    return { result: { model: payload.model, userAgent: payload.userAgent.slice(0, 512) } };
}

function parseBatchPayload(raw, requested) {
    const payload = JSON.parse(raw);
    if (payload?.ok !== true || !isPlainObject(payload.models) ||
        typeof payload.userAgent !== 'string' || !payload.userAgent.trim()) {
        throw sdkError('SDK 批量返回数据无效', 'SDK_INVALID_RESPONSE');
    }
    const userAgent = payload.userAgent.slice(0, 512);
    const models = new Map();
    for (const vid of requested) {
        if (!Object.prototype.hasOwnProperty.call(payload.models, vid)) continue;
        const model = payload.models[vid];
        if (isPlainObject(model)) models.set(vid, { model, userAgent });
    }
    if (!models.size) throw sdkError('SDK 批量结果未包含请求分集', 'SDK_INVALID_RESPONSE');
    return { result: models };
}

function killChildSafely(child) {
    if (!child || child.killed) return;
    try { child.kill('SIGTERM'); } catch {}
    const force = setTimeout(() => {
        try { if (!child.killed && child.exitCode === null) child.kill('SIGKILL'); } catch {}
    }, 2000);
    force.unref?.();
    child.once?.('close', () => clearTimeout(force));
}

function runHelper(executable, args, signal, timeoutMs, maxOutput = MAX_OUTPUT, parser = parseSinglePayload) {
    return new Promise(resolve => {
        if (signal?.aborted) {
            resolve({ error: sdkError('SDK 取源已取消', 'ERR_CANCELED') });
            return;
        }
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
        const fail = (message, code) => finish({ error: sdkError(message, code) });
        const cancel = () => {
            killChildSafely(child);
            fail('SDK 取源已取消', 'ERR_CANCELED');
        };
        const timer = setTimeout(() => {
            killChildSafely(child);
            fail('SDK 取源超时', 'SDK_TIMEOUT');
        }, timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        child.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
            if (stdout.length > maxOutput) {
                killChildSafely(child);
                fail('SDK 返回数据过长', 'SDK_INVALID_RESPONSE');
            }
        });
        child.stderr.on('data', chunk => {
            stderr = (stderr + chunk.toString('utf8')).slice(-4096);
        });
        child.on('error', () => fail('SDK 执行文件启动失败', 'SDK_SPAWN_FAILED'));
        child.on('close', code => {
            if (settled) return;
            if (code !== 0) {
                if (args[0] === '--videos' && /unrecognized arguments:\s*--videos/i.test(stderr)) {
                    finish({ unsupportedBatch: true });
                    return;
                }
                let detail = '';
                try { detail = safeDetail(JSON.parse(stdout)?.error); } catch {}
                if (!detail) detail = safeDetail(stderr);
                fail(`SDK 取源失败${detail ? `：${detail}` : `（退出码 ${code}）`}`, 'SDK_HELPER_FAILED');
                return;
            }
            try {
                finish(parser(stdout));
            } catch (error) {
                fail(error?.message || 'SDK 返回数据无法解析', error?.code || 'SDK_INVALID_RESPONSE');
            }
        });
    });
}

function acquireHelper(signal, priority = false) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (activeHelpers < MAX_CONCURRENT_HELPERS) {
        activeHelpers++;
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const queue = priority ? priorityHelperWaiters : helperWaiters;
        const waiter = { resolve, reject, signal, queue };
        waiter.abort = () => {
            const index = queue.indexOf(waiter);
            if (index >= 0) queue.splice(index, 1);
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        };
        signal?.addEventListener('abort', waiter.abort, { once: true });
        queue.push(waiter);
        if (signal?.aborted) waiter.abort();
    });
}

function releaseHelper() {
    const waiter = priorityHelperWaiters.shift() || helperWaiters.shift();
    if (!waiter) {
        activeHelpers--;
        return;
    }
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve();
}

function normalizeBatchVids(vids) {
    if (!Array.isArray(vids)) return [];
    const ordered = [];
    const seen = new Set();
    for (const raw of vids) {
        const vid = String(raw ?? '').trim();
        if (!validVideo(vid) || seen.has(vid)) continue;
        seen.add(vid);
        ordered.push(vid);
        if (ordered.length >= MAX_BATCH_VIDEOS) break;
    }
    return ordered;
}

function cacheKey(vid, contentType) {
    return `${String(contentType || '1004')}:${String(vid)}`;
}

function readCachedModel(vid, contentType) {
    const key = cacheKey(vid, contentType);
    const entry = sdkModelCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        sdkModelCache.delete(key);
        return null;
    }
    return entry.value;
}

function storeCachedModels(models, contentType) {
    const expiresAt = Date.now() + MODEL_CACHE_TTL_MS;
    for (const [vid, value] of models) {
        const key = cacheKey(vid, contentType);
        sdkModelCache.delete(key);
        sdkModelCache.set(key, { value, expiresAt });
    }
    while (sdkModelCache.size > MAX_MODEL_CACHE) {
        sdkModelCache.delete(sdkModelCache.keys().next().value);
    }
}

function clearSdkModelCache() {
    sdkModelCache.clear();
}

function resolveEnvironment(app, options = {}) {
    if (!app) throw sdkError('SDK 运行环境不可用', 'SDK_UNAVAILABLE');
    const executable = executablePath(app);
    if (!executable) throw sdkError('当前平台未启用后续集 SDK', 'SDK_UNAVAILABLE');
    if (!fs.statSync(executable).isFile()) throw sdkError('SDK 执行文件不存在', 'SDK_UNAVAILABLE');
    const cachePath = resolveCacheDir(app, options);
    fs.mkdirSync(cachePath, { recursive: true });
    return { executable, cacheDir: fs.realpathSync(cachePath) };
}

function reportFailure(options, error) {
    if (error?.code !== 'ERR_CANCELED') options.onError?.({ code: error.code, message: error.message });
}

function awaitBatchEntry(entry, key, signal) {
    if (signal?.aborted) return Promise.resolve(null);
    entry.waiters++;
    let released = false;
    const releaseWaiter = () => {
        if (released) return;
        released = true;
        entry.waiters--;
        if (entry.waiters <= 0) entry.controller.abort();
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
                if (result?.unsupportedBatch || result?.failure) finish(result);
                else finish(result instanceof Map ? (result.get(key) || null) : null);
            },
            () => {
                releaseWaiter();
                finish(null);
            }
        );
    });
}

function startBatch(vids, contentType, env, timeoutMs, priority = false) {
    const controller = new AbortController();
    const entry = { controller, waiters: 0, settled: false, promise: null };
    for (const vid of vids) pendingBatches.set(cacheKey(vid, contentType), entry);
    entry.promise = (async () => {
        try {
            await acquireHelper(controller.signal, priority);
            try {
                const args = ['--videos', vids.join(','), '--cache', env.cacheDir];
                if (contentType !== '1004') args.push('--content-type', contentType);
                const outcome = await runHelper(
                    env.executable,
                    args,
                    controller.signal,
                    timeoutMs,
                    MAX_BATCH_OUTPUT,
                    stdout => parseBatchPayload(stdout, vids),
                );
                if (outcome.unsupportedBatch) return outcome;
                if (outcome.error) return { failure: outcome.error };
                storeCachedModels(outcome.result, contentType);
                return outcome.result;
            } finally {
                releaseHelper();
            }
        } catch {
            return null;
        } finally {
            entry.settled = true;
            for (const vid of vids) {
                const key = cacheKey(vid, contentType);
                if (pendingBatches.get(key) === entry) pendingBatches.delete(key);
            }
        }
    })();
    return entry;
}

async function resolveSdkPlaybackBatch(vids, options = {}) {
    const requested = normalizeBatchVids(vids);
    const contentType = String(options.contentType || '1004');
    if (!requested.length || options.signal?.aborted) return null;
    try {
        const env = resolveEnvironment(electronApp(), options);
        const results = new Map();
        const missing = [];
        for (const vid of requested) {
            const cached = options.fresh ? null : readCachedModel(vid, contentType);
            if (cached) results.set(vid, cached);
            else missing.push(vid);
        }
        if (!missing.length) return results;
        await acquireHelper(options.signal, options.priority === true);
        try {
            const args = ['--videos', missing.join(','), '--cache', env.cacheDir];
            if (contentType !== '1004') args.push('--content-type', contentType);
            const outcome = await runHelper(
                env.executable,
                args,
                options.signal,
                Number(options.timeoutMs) || DEFAULT_TIMEOUT,
                MAX_BATCH_OUTPUT,
                stdout => parseBatchPayload(stdout, missing),
            );
            if (outcome.error) {
                reportFailure(options, outcome.error);
                return results.size ? results : null;
            }
            if (outcome.result) {
                storeCachedModels(outcome.result, contentType);
                for (const [vid, value] of outcome.result) results.set(vid, value);
            }
        } finally {
            releaseHelper();
        }
        return results.size ? results : null;
    } catch (error) {
        reportFailure(options, error);
        return null;
    }
}

function createSdkPlaybackSession(options = {}) {
    const app = electronApp();
    const executable = executablePath(app);
    const cachePath = resolveCacheDir(app, options);
    let child = null;
    let childHoldsSlot = false;
    let buffer = '';
    let stderr = '';
    let nextId = 1;
    let closed = false;
    let queue = Promise.resolve();
    const pending = new Map();

    function releaseWorkerSlot() {
        if (!childHoldsSlot) return;
        childHoldsSlot = false;
        releaseHelper();
    }

    function resetWorker(code = 'SDK_HELPER_FAILED', reason = '') {
        killChildSafely(child);
        child = null;
        buffer = '';
        const detail = safeDetail(stderr) || reason;
        stderr = '';
        for (const entry of pending.values()) {
            if (detail || code === 'SDK_TIMEOUT') {
                entry.onError?.(sdkError(detail ? `SDK 会话失败：${detail}` : 'SDK 取源超时', code));
            }
            entry.finish(null);
        }
        pending.clear();
        releaseWorkerSlot();
    }

    async function ensureWorker(signal) {
        if (closed || !executable) return null;
        if (child && !child.killed) return child;
        if (!fs.statSync(executable).isFile()) throw sdkError('SDK 执行文件不存在', 'SDK_UNAVAILABLE');
        fs.mkdirSync(cachePath, { recursive: true });
        const cacheDir = fs.realpathSync(cachePath);
        await acquireHelper(signal, options.priority === true);
        if (closed || signal?.aborted) {
            releaseHelper();
            return null;
        }
        let proc;
        try {
            proc = spawn(executable, ['--serve', '--cache', cacheDir], {
                shell: false,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            releaseHelper();
            throw error;
        }
        childHoldsSlot = true;
        proc.unref?.();
        child = proc;
        proc.stdout.on('data', chunk => {
            buffer += chunk.toString('utf8');
            if (buffer.length > MAX_OUTPUT * 2) {
                resetWorker('SDK_INVALID_RESPONSE');
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
                    if (raw?.ok !== true) {
                        const error = sdkError(`SDK 会话取源失败：${safeDetail(raw?.error) || '未知错误'}`, 'SDK_HELPER_FAILED');
                        pending.delete(raw.id);
                        entry.onError?.(error);
                        entry.finish(null);
                        continue;
                    }
                    const parsed = parseSinglePayload(line).result;
                    pending.delete(raw.id);
                    entry.finish(parsed);
                } catch (error) {
                    resetWorker(error?.code || 'SDK_INVALID_RESPONSE');
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
            if (child === proc) resetWorker('SDK_SPAWN_FAILED');
        });
        proc.on('close', code => {
            if (code && stderr) {
                console.warn('[SDK playback] helper failed:', safeDetail(stderr));
            }
            if (child === proc) resetWorker();
        });
        return proc;
    }

    function sendOne(vid, callOptions = {}) {
        return new Promise(resolve => {
            if (closed || !validVideo(vid) || callOptions.signal?.aborted) {
                resolve(null);
                return;
            }
            const timeoutMs = Number(callOptions.timeoutMs) || DEFAULT_TIMEOUT;
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callOptions.signal?.removeEventListener('abort', onAbort);
                pending.delete(id);
                resolve(value);
            };
            const cancel = (code = 'ERR_CANCELED', reason = '') => {
                resetWorker(code, reason);
                finish(null);
            };
            const onAbort = () => cancel('ERR_CANCELED');
            const timer = setTimeout(() => cancel('SDK_TIMEOUT', '会话超时'), timeoutMs);
            timer.unref?.();
            callOptions.signal?.addEventListener('abort', onAbort, { once: true });
            const id = nextId++;
            pending.set(id, { finish, onError: callOptions.onError });
            ensureWorker(callOptions.signal).then(proc => {
                if (!proc) {
                    finish(null);
                    return;
                }
                try {
                    proc.stdin.write(JSON.stringify({
                        id,
                        video: String(vid),
                        contentType: String(callOptions.contentType || '1004'),
                    }) + '\n');
                } catch {
                    resetWorker();
                    finish(null);
                }
            }, error => {
                pending.delete(id);
                reportFailure(callOptions, error);
                finish(null);
            });
        });
    }

    const onProcessExit = () => {
        closed = true;
        killChildSafely(child);
    };
    process.once('exit', onProcessExit);

    return {
        resolve(vid, callOptions = {}) {
            const run = queue.then(() => sendOne(vid, callOptions));
            queue = run.catch(() => null);
            return run;
        },
        close() {
            closed = true;
            process.removeListener('exit', onProcessExit);
            resetWorker();
        },
    };
}

async function resolveSdkPlayback(vid, options = {}) {
    const key = String(vid ?? '');
    const contentType = String(options.contentType || '1004');
    if (!validVideo(key) || options.signal?.aborted) {
        if (!validVideo(key)) reportFailure(options, sdkError('分集编号无效', 'SDK_INVALID_VIDEO'));
        return null;
    }
    if (options.session) return options.session.resolve(key, options);
    const app = electronApp();
    try {
        const env = resolveEnvironment(app, options);
        const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT;
        if (!options.fresh) {
            const cached = readCachedModel(key, contentType);
            if (cached) return cached;
            const cacheKeyValue = cacheKey(key, contentType);
            const inflight = pendingBatches.get(cacheKeyValue);
            if (inflight) {
                const shared = await awaitBatchEntry(inflight, key, options.signal);
                if (options.signal?.aborted) return null;
                if (shared?.failure) {
                    reportFailure(options, shared.failure);
                    return null;
                }
                if (shared && !shared.unsupportedBatch) return shared;
            }
            if (Array.isArray(options.batchVids) && options.batchVids.length > 1) {
                const candidates = normalizeBatchVids([key, ...options.batchVids])
                    .filter(item => item === key || (!readCachedModel(item, contentType)
                        && !pendingBatches.has(cacheKey(item, contentType))));
                if (candidates.length > 1) {
                    const entry = startBatch(candidates, contentType, env, timeoutMs, options.priority === true);
                    const batchResult = await awaitBatchEntry(entry, key, options.signal);
                    if (options.signal?.aborted) return null;
                    if (batchResult?.failure) {
                        reportFailure(options, batchResult.failure);
                        return null;
                    }
                    if (batchResult && !batchResult.unsupportedBatch) return batchResult;
                }
            }
        } else {
            sdkModelCache.delete(cacheKey(key, contentType));
        }
        await acquireHelper(options.signal, options.priority === true);
        try {
            const args = ['--video', key, '--cache', env.cacheDir];
            if (contentType !== '1004') args.push('--content-type', contentType);
            const outcome = await runHelper(env.executable, args, options.signal, timeoutMs);
            if (outcome.error) {
                reportFailure(options, outcome.error);
                return null;
            }
            if (outcome.result) storeCachedModels([[key, outcome.result]], contentType);
            return outcome.result;
        } finally {
            releaseHelper();
        }
    } catch (error) {
        reportFailure(options, error?.name === 'AbortError'
            ? sdkError('SDK 取源已取消', 'ERR_CANCELED')
            : sdkError(`SDK 初始化失败：${safeDetail(error?.message) || '未知错误'}`, error?.code || 'SDK_INIT_FAILED'));
        return null;
    }
}

module.exports = {
    resolveSdkPlayback,
    resolveSdkPlaybackBatch,
    createSdkPlaybackSession,
    clearSdkModelCache,
    executablePath,
    resolveCacheDir,
    MAX_BATCH_VIDEOS,
};
