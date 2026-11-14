const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function loadNative({ axios = {}, appFetch, timers } = {}) {
    const modules = new Map();
    let requestSignal;
    if (timers) {
        requestSignal = { exports: {} };
        new Function('module', 'exports', 'setTimeout', 'clearTimeout', fs.readFileSync(path.join(__dirname, 'request-signal.js'), 'utf8'))(
            requestSignal, requestSignal.exports, timers.setTimeout, timers.clearTimeout);
    }
    function local(name) {
        if (name === 'axios') return axios;
        if (name === './app-source' && appFetch) return { fetchAppPlayUrl: appFetch };
        if (name === './request-signal' && requestSignal) return requestSignal.exports;
        if (!name.startsWith('.')) return require(name);
        const file = require.resolve(path.join(__dirname, name));
        if (!['hongguo.js', 'app-source.js', 'playback-device.js'].includes(path.basename(file))) return require(file);
        if (!modules.has(file)) {
            const module = { exports: {} };
            modules.set(file, module);
            const extra = path.basename(file) === 'hongguo.js' ? '\nmodule.exports.cachedRequest = cachedRequest;' : '';
            new Function('require', 'module', 'exports', 'console', fs.readFileSync(file, 'utf8') + extra)(
                local, module, module.exports, { warn() {} });
        }
        return modules.get(file).exports;
    }
    return local('./hongguo');
}

function loadMedia(native) {
    const file = path.resolve(__dirname, '../../server/media.cjs'), req = createRequire(file);
    const module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(name => {
        if (name === '../src/native/hongguo') return native;
        if (name === 'node:fs') return { existsSync: () => false,
            mkdtempSync() { throw new Error('UNEXPECTED_MEDIA_WRITE'); } };
        return req(name);
    }, module, module.exports);
    return module.exports;
}

const info = name => ({ url: `https://qznovelvod.com/${name}.mp4`, vid: '11', source: 'app' });
const turn = () => new Promise(resolve => setImmediate(resolve));
module.exports = { deferred, loadNative, loadMedia, info, turn };
