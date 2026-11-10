const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { deferred, loadNative, turn } = require('../../src/native/hongguo-cancellation-fixture.cjs');

// Reuse G1's isolated main/IPC/store fixture without executing its test suite.
function desktop(t) {
    const file = path.resolve(__dirname, '../check-download-source-rejection.cjs');
    const source = fs.readFileSync(file, 'utf8');
    const end = source.indexOf('\nconst checks = [');
    if (end < 0) throw new Error('G1 fixture boundary changed');
    const module = { exports: {} };
    new Function('require', 'module', '__dirname', source.slice(0, end) + '\nmodule.exports = { fixture, roots };')(
        createRequire(file), module, path.dirname(file));
    const h = module.exports.fixture(), calls = [], lookups = [], parents = [], entered = deferred();
    const native = loadNative({ appFetch(vid, config) {
        const pending = deferred(); calls.push({ ...pending, vid, signal: config.signal }); entered.resolve(); return pending.promise;
    } });
    h.state.load = (vid, options) => {
        lookups.push(options);
        return native.fetchPlayUrlSingle(vid, '100', options);
    };
    t.after(async () => {
        h.state.saveError = null;
        for (const controller of parents) controller.abort();
        h.run('pauseAllTasks(); for (const id of [...onlineSessions.keys()]) releaseOnlineSession(id);');
        for (const call of calls) call.resolve(info(call.vid));
        await h.drain();
        await turn();
        for (const root of module.exports.roots) fs.rmSync(root, { recursive: true, force: true });
    });
    return Object.assign(h, { calls, lookups, native, entered: entered.promise, recover: h.run('withMediaRecovery'),
        controller() { const controller = new AbortController(); parents.push(controller); return controller; },
        async expireLookup(t) {
            t.mock.timers.tick(30000);
            // The pre-fix code owns its wait timer in G1's VM fixture, rather than boundedSignal.
            for (const timer of h.liveTimers()) if (timer.ms === 30000) timer.fn();
            await turn();
        },
    });
}
const info = (vid, name = 'synthetic') => ({ url: `https://qznovelvod.com/${name}.mp4`, source: 'app', vid: String(vid) });
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
const boundedOutcome = promise => Promise.race([promise,
    new Promise(resolve => setTimeout(() => resolve({ error: { code: 'CANCEL_NOT_DELIVERED' } }), 200))]);
module.exports = { desktop, info, outcome, boundedOutcome, turn };
