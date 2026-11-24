// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 512 * 1024;
const DEFAULT_TIMEOUT = 45000;
const MAX_CONCURRENT_HELPERS = 3;
let activeHelpers = 0;
const helperWaiters = [];
const priorityHelperWaiters = [];

function sdkError(message, code = 'SDK_PLAYBACK_FAILED') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function safeDetail(value) {
    return String(value || '').replace(/https?:\/\/\S+/gi, '[url]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function electronApp() {
    try {
        const electron = require('electron');
        return electron?.app?.getPath ? electron.app : null;
    } catch {
        return null;
    }
}

function executablePath(app, platform = process.platform, arch = process.arch) {
    let targetDir = null;
    let binaryName = null;
    if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
        targetDir = `darwin-${arch}`;
        binaryName = 'hongguo-sdk-playback';
    } else if (platform === 'win32' && arch === 'x64') {
        targetDir = 'win32-x64';
        binaryName = 'hongguo-sdk-playback.exe';
    } else {
        return null;
    }
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'sdk-playback',
            targetDir, binaryName);
    }
    return path.join(__dirname, '..', '..', 'build', 'sdk-playback',
        targetDir, binaryName);
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
        const fail = (message, code) => finish({ error: sdkError(message, code) });
        const cancel = () => {
            if (!child.killed) child.kill();
            fail('SDK 取源已取消', 'ERR_CANCELED');
        };
        const timer = setTimeout(() => {
            if (!child.killed) child.kill();
            fail('SDK 取源超时', 'SDK_TIMEOUT');
        }, timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        child.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
            if (stdout.length > MAX_OUTPUT) {
                if (!child.killed) child.kill();
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
                let detail = '';
                try { detail = safeDetail(JSON.parse(stdout)?.error); } catch {}
                if (!detail) detail = safeDetail(stderr);
                fail(`SDK 取源失败${detail ? `：${detail}` : `（退出码 ${code}）`}`, 'SDK_HELPER_FAILED');
                return;
            }
            try {
                const payload = JSON.parse(stdout);
                if (payload?.ok !== true || !payload.model || typeof payload.model !== 'object' ||
                    Array.isArray(payload.model) || typeof payload.userAgent !== 'string' || !payload.userAgent.trim()) {
                    fail('SDK 返回数据无效', 'SDK_INVALID_RESPONSE');
                    return;
                }
                finish({ result: { model: payload.model, userAgent: payload.userAgent.slice(0, 512) } });
            } catch {
                fail('SDK 返回数据无法解析', 'SDK_INVALID_RESPONSE');
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

async function resolveSdkPlayback(vid, options = {}) {
    const report = error => {
        if (error?.code !== 'ERR_CANCELED') options.onError?.({ code: error.code, message: error.message });
    };
    const app = electronApp();
    if (!/^\d{1,30}$/.test(String(vid))) {
        report(sdkError('分集编号无效', 'SDK_INVALID_VIDEO'));
        return null;
    }
    if (!app) {
        report(sdkError('SDK 运行环境不可用', 'SDK_UNAVAILABLE'));
        return null;
    }
    const executable = executablePath(app);
    if (!executable) {
        report(sdkError('当前平台未启用后续集 SDK', 'SDK_UNAVAILABLE'));
        return null;
    }
    try {
        if (!fs.statSync(executable).isFile()) {
            report(sdkError('SDK 执行文件不存在', 'SDK_UNAVAILABLE'));
            return null;
        }
        const cachePath = path.join(app.getPath('userData'), 'sdk-playback');
        fs.mkdirSync(cachePath, { recursive: true });
        const cacheDir = fs.realpathSync(cachePath);
        await acquireHelper(options.signal, options.priority === true);
        try {
            const args = ['--video', String(vid), '--cache', cacheDir];
            if (String(options.contentType || '1004') !== '1004') args.push('--content-type', String(options.contentType));
            const outcome = await runHelper(executable, args,
                options.signal, Number(options.timeoutMs) || DEFAULT_TIMEOUT);
            if (outcome.error) {
                report(outcome.error);
                return null;
            }
            return outcome.result;
        } finally {
            releaseHelper();
        }
    } catch (error) {
        report(error?.name === 'AbortError' ? sdkError('SDK 取源已取消', 'ERR_CANCELED')
            : sdkError(`SDK 初始化失败：${safeDetail(error?.message) || '未知错误'}`, 'SDK_INIT_FAILED'));
        return null;
    }
}

module.exports = { resolveSdkPlayback, executablePath };
