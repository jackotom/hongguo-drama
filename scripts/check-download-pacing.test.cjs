const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { deferred, turn } = require('../src/native/hongguo-cancellation-fixture.cjs');

function fixture(concurrency = 1) {
    const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const start = main.indexOf('// ===== 下载队列调度 ====='), end = main.indexOf('// ===== 下载分发 =====', start);
    const tasks = [], started = [], timers = [], running = [], handlers = {};
    let now = 10000;
    const context = vm.createContext({ quitCleanup: null, downloadQueue: tasks, downloadTasks: [], activeDownloads: 0,
        MAX_CONCURRENT_DOWNLOADS: concurrency, runningDownloads: new Set(), runningDownloadPaths: new Set(), downloadRuns: new Map(),
        repairTaskDestination() {}, saveDownloadTasks() {}, sendToRenderer() {}, hasCompleteTaskFile: () => true,
        ipcMain: { handle: (channel, fn) => handlers[channel] = fn }, console, Date: { now: () => now },
        executeDownload: task => { const pending = deferred(); started.push(task.id); running.push(pending); return pending.promise; },
        setTimeout: (fn, ms) => { const timer = { fn, at: now + ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
        clearTimeout: timer => { if (timer) timer.cleared = true; },
    });
    vm.runInContext(main.slice(start, end), context);
    vm.runInContext(main.slice(main.indexOf('function snapshotQueueTasks('), main.indexOf('// ===== 短剧档案')), context);
    vm.runInContext(main.slice(main.indexOf("ipcMain.handle('retry-task'"), main.indexOf('// ===== IPC：一键启动')), context);
    return { started, running, timers, handlers,
        add(id, vid = id, seriesId, vidIndex) {
            const task = { id, type: 'hongguo', hongguoInfo: { vid, series_id: seriesId, vid_index: vidIndex }, status: 'pending', savePath: id };
            context.downloadQueue.push(task); context.downloadTasks.unshift(task); return task;
        },
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

test('resume orders episodes within the existing series slots instead of reversing the whole queue', () => {
    const h = fixture();
    for (const [id, sid, index] of [['a1', 'A', 1], ['b1', 'B', 1], ['a2', 'A', 2], ['b2', 'B', 2], ['a3', 'A', 3]]) {
        h.add(id, id, sid, index).status = 'stopped';
    }
    h.context.downloadQueue = [];
    h.context.resumeAllTasks();
    assert.deepEqual(h.started, ['a1']);
    assert.deepEqual(Array.from(h.context.downloadQueue, task => task.id), ['b1', 'a2', 'b2', 'a3']);
});

test('batch retry keeps an existing other-series task first and restores the same-series episode order', async () => {
    const h = fixture(); h.add('b1', 'b1', 'B', 1); h.add('a3', 'a3', 'A', 3);
    const a1 = h.add('a1', 'a1', 'A', 1), a2 = h.add('a2', 'a2', 'A', 2);
    a1.status = a2.status = 'failed';
    h.context.downloadQueue = h.context.downloadQueue.filter(task => task.status === 'pending');
    assert.equal((await h.handlers['retry-tasks'](null, ['a2', 'a1'])).success, true);
    assert.deepEqual(h.started, ['b1']);
    assert.deepEqual(Array.from(h.context.downloadQueue, task => task.id), ['a1', 'a2', 'a3']);
});

test('an automatic retry joins the earlier episode slot without moving another series', async () => {
    const h = fixture(); h.add('a3', 'a3', 'A', 3); h.add('b1', 'b1', 'B', 1); h.add('a2', 'a2', 'A', 2);
    const retry = h.add('a1', 'a1', 'A', 1); retry.status = 'failed'; retry.retryAt = 11000;
    h.context.downloadQueue = h.context.downloadQueue.filter(task => task.status === 'pending');
    h.context.activeDownloads = 1;
    h.context.armSourceRetry(retry); await h.advance(1000);
    h.context.activeDownloads = 0; h.pump();
    assert.deepEqual(h.started, ['a1']);
    assert.deepEqual(Array.from(h.context.downloadQueue, task => task.id), ['b1', 'a2', 'a3']);
});

test('episode ordering retains running-path and concurrent-download protection', () => {
    const h = fixture(2); h.add('a3', 'a3', 'A', 3); h.add('a2', 'a2', 'A', 2); h.add('a1', 'a1', 'A', 1);
    h.context.runningDownloadPaths.add('a1'); h.pump();
    assert.deepEqual(h.started, ['a2', 'a3']);
    assert.deepEqual(Array.from(h.context.downloadQueue, task => task.id), ['a1']);
    assert.equal(h.context.activeDownloads, 2);
});

test('a failed resume persistence restores the queue before any sorted work starts', () => {
    const h = fixture(); h.add('a1', 'a1', 'A', 1).status = 'stopped'; h.add('a2', 'a2', 'A', 2).status = 'stopped';
    h.context.downloadQueue = [];
    h.context.saveDownloadTasks = () => { throw new Error('disk full'); };
    assert.throws(() => h.context.resumeAllTasks(), /disk full/);
    assert.deepEqual(h.started, []);
    assert.equal(h.context.downloadQueue.length, 0);
    assert.equal(h.context.downloadTasks.every(task => task.status === 'stopped'), true);
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
