const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { deferred, turn } = require('../src/native/hongguo-cancellation-fixture.cjs');

function fixture(concurrency = 1) {
    const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const start = main.indexOf('// ===== 下载队列调度 ====='), end = main.indexOf('// 保留旧名', start);
    const tasks = [], started = [], timers = [], running = [];
    let now = 10000;
    const context = vm.createContext({ quitCleanup: null, downloadQueue: tasks, activeDownloads: 0,
        MAX_CONCURRENT_DOWNLOADS: concurrency, runningDownloads: new Set(), runningDownloadPaths: new Set(), downloadRuns: new Map(),
        repairTaskDestination() {}, console, Date: { now: () => now },
        executeDownload: task => { const pending = deferred(); started.push(task.id); running.push(pending); return pending.promise; },
        setTimeout: (fn, ms) => { const timer = { fn, at: now + ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
        clearTimeout: timer => { if (timer) timer.cleared = true; },
    });
    vm.runInContext(main.slice(start, end), context);
    return { started, running, timers,
        add(id, vid = id) { tasks.push({ id, type: 'hongguo', hongguoInfo: { vid }, status: 'pending', savePath: id }); },
        pump() { vm.runInContext('pumpQueue()', context); },
        async finish(index) { running[index].resolve(); await turn(); },
        async advance(ms) { now += ms; for (const timer of timers) if (!timer.cleared && timer.at <= now) { timer.cleared = true; timer.fn(); } await turn(); },
        context,
    };
}

test('a finished Hongguo download leaves one second before replacement even if the queue is pumped again', async () => {
    const h = fixture(); h.add('1'); h.add('2'); h.pump(); await h.finish(0);
    assert.deepEqual(h.started, ['1']); h.pump(); await h.advance(999); assert.deepEqual(h.started, ['1']);
    await h.advance(1); assert.deepEqual(h.started, ['1', '2']); await h.finish(1);
});

test('source cooldown keeps transfer concurrency and does not stall another source', async () => {
    const h = fixture(2); h.add('1'); h.add('2'); h.add('3'); h.add('x', 'xifan:1'); h.pump();
    assert.deepEqual(h.started, ['1', '2']); await h.finish(0);
    assert.deepEqual(h.started, ['1', '2', 'x']); await h.finish(2);
    await h.advance(1000); assert.deepEqual(h.started, ['1', '2', 'x', '3']);
    await h.finish(1); await h.finish(3);
});

test('a pending download paused during cooldown cannot be revived by its timer', async () => {
    const h = fixture(); h.add('1'); h.add('2'); h.pump(); await h.finish(0);
    h.context.downloadQueue[0].status = 'stopped'; await h.advance(1000);
    assert.deepEqual(h.started, ['1']);
});

test('quitting clears the scheduler timer without starting waiting work', async () => {
    const h = fixture(); h.add('1'); h.add('2'); h.pump(); await h.finish(0);
    h.context.quitCleanup = Promise.resolve(); h.pump(); await h.advance(1000);
    assert.deepEqual(h.started, ['1']); assert.equal(h.timers.every(timer => timer.cleared), true);
});
