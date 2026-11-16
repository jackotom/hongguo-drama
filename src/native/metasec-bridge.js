// SPDX-License-Identifier: GPL-3.0-only
// Optional local model provider. The executable is a separate program; its
// license and source accompany the local installation, not this GPL module.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { abortError, throwIfAborted } = require('./request-signal');

let config, child, pending, sequence = 0;
const MAX_RESPONSE = 2 * 1024 * 1024;

function configure(options) {
    if (!options || !path.isAbsolute(options.executable) || !path.isAbsolute(options.cacheDir)) return;
    try {
        if (!fs.lstatSync(options.executable).isFile()) return;
        config = { ...options };
    } catch (_) {}
}

function isAvailable() { return !!config; }

function stop(error) {
    const process = child;
    child = null;
    if (pending) {
        const request = pending;
        pending = null;
        request.reject(error);
    }
    if (process) {
        process.stdin.destroy();
        process.kill('SIGTERM');
        const timer = setTimeout(() => process.kill('SIGKILL'), 2000);
        timer.unref?.();
        process.once('exit', () => clearTimeout(timer));
    }
}

function start() {
    if (child) return child;
    fs.mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });
    const cache = path.join(config.cacheDir, 'metasec-v5-74332.cache');
    if (!fs.existsSync(cache) && config.materials) {
        try { fs.copyFileSync(config.materials, cache, fs.constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const environment = { ...global.process.env };
    for (const name of ['TT_DEBUG', 'HONGGUO_OFFLINE_QA', 'HONGGUO_REUSE_DEVICE_JSON']) delete environment[name];
    const process = spawn(config.executable, ['--serve', config.cacheDir], {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
        env: environment,
    });
    child = process;
    let buffer = '';
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', data => {
        if (child !== process) return;
        buffer += data;
        if (Buffer.byteLength(buffer) > MAX_RESPONSE) {
            stop(Object.assign(new Error('播放数据超过大小限制'), { code: 'INVALID_RESPONSE' }));
            return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            let result;
            try { result = JSON.parse(line); }
            catch (_) { stop(Object.assign(new Error('本机播放组件返回无效数据'), { code: 'INVALID_RESPONSE' })); return; }
            const request = pending;
            if (!request || result.id !== request.id || result.vid !== request.vid) {
                stop(Object.assign(new Error('本机播放组件响应分集不匹配'), { code: 'INVALID_RESPONSE' })); return;
            }
            pending = null;
            if (result.success === true && result.response && typeof result.response === 'object') request.resolve(result.response);
            else {
                const messages = { EMPTY_RESPONSE: '播放接口返回空响应，原因尚未确认',
                    BUSINESS_REJECTED: 'App 接口暂未提供本集播放信息',
                    DEVICE_REGISTRATION_FAILED: '匿名播放设备注册失败，请稍后重试',
                    ETIMEDOUT: '播放请求超时', INVALID_RESPONSE: '播放接口未返回有效模型',
                    SECURITY_BLOCKED: '播放请求被安全校验阻止', ERR_NETWORK: '播放网络请求失败，请稍后重试' };
                const code = Object.hasOwn(messages, result.code) ? result.code : 'ERR_NETWORK';
                const status = Number(result.status);
                request.reject(Object.assign(new Error(messages[code]), { code,
                    ...(Number.isInteger(status) && status >= 200 && status <= 599 ? { status } : {}),
                    ...(code === 'EMPTY_RESPONSE' && status === 200 ? { responseBytes: 0 } : {}),
                }));
            }
        }
    });
    const failed = () => {
        if (child === process) stop(Object.assign(new Error('本机播放组件已停止，请重试'), { code: 'ERR_NETWORK' }));
    };
    process.stdin.on('error', failed);
    process.on('error', failed);
    process.on('exit', failed);
    return process;
}

async function fetchModel(vid, { signal } = {}) {
    throwIfAborted(signal);
    if (!config || !/^\d{1,30}$/.test(String(vid))) throw new Error('播放组件或分集编号无效');
    if (pending) throw new Error('播放请求尚未结束');
    const process = start();
    const id = ++sequence;
    let timer, cancel;
    try {
        return await new Promise((resolve, reject) => {
            pending = { id, vid: String(vid), resolve, reject };
            cancel = () => stop(abortError(signal));
            signal?.addEventListener('abort', cancel, { once: true });
            timer = setTimeout(() => stop(Object.assign(new Error('播放请求超时'), { code: 'ETIMEDOUT' })), 30000);
            timer.unref?.();
            if (signal?.aborted) cancel();
            else process.stdin.write(JSON.stringify({ id, vid: String(vid) }) + '\n');
        });
    } finally {
        clearTimeout(timer);
        if (cancel) signal?.removeEventListener('abort', cancel);
    }
}

module.exports = { configure, isAvailable, fetchModel, close: () => stop(abortError()) };
