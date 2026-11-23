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
                const payload = JSON.parse(stdout);
                if (payload?.ok !== true || !payload.model || typeof payload.model !== 'object' ||
                    Array.isArray(payload.model) || typeof payload.userAgent !== 'string' || !payload.userAgent.trim()) {
                    finish(null);
                    return;
                }
                finish({ model: payload.model, userAgent: payload.userAgent.slice(0, 512) });
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

async function resolveSdkPlayback(vid, options = {}) {
    const app = electronApp();
    if (!app || !/^\d{1,30}$/.test(String(vid))) return null;
    const executable = executablePath(app);
    if (!executable) return null;
    try {
        if (!fs.statSync(executable).isFile()) return null;
        const cachePath = path.join(app.getPath('userData'), 'sdk-playback');
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

module.exports = { resolveSdkPlayback };
