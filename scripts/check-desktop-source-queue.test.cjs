const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { desktop, info, turn } = require('./fixtures/desktop-source.cjs');

test('manual pause is durable before source abort; late success cannot revive queue or erase foreign files', async t => {
    const h = desktop(t), task = h.add('11'), waiting = h.add('12');
    const foreign = path.join(path.dirname(task.savePath), 'unrelated.txt'); fs.writeFileSync(foreign, 'keep');
    h.pump(); await h.entered;
    assert.equal(h.calls.length, 1);
    const record = h.state.saved.find(item => item.id === task.id).temporaryDownloads[0];
    assert.equal(record.owner.taskId, task.id); assert.ok(record.files['input.enc.tmp'].ino > 0);
    let statusAtAbort;
    h.calls[0].signal.addEventListener('abort', () => { statusAtAbort = h.state.saved.find(item => item.id === task.id).status; }, { once: true });
    h.run('pauseAllTasks()'); await turn();
    assert.equal(h.calls[0].signal.aborted, true); assert.equal(statusAtAbort, 'stopped');
    h.calls[0].resolve(info('11', 'late')); await h.drain();
    assert.equal(task.status, 'stopped'); assert.equal(waiting.status, 'stopped');
    assert.equal(h.state.transfers.length, 0); assert.equal(h.liveTimers().length, 0);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep');
    assert.equal(fs.existsSync(task.savePath), false);
    h.run('loadDownloadTasks(); enqueuePendingTasks(); pumpQueue()'); await turn();
    assert.equal(h.calls.length, 1); assert.equal(h.run('downloadQueue.length'), 0);
    assert.equal(h.state.saved.every(item => item.status === 'stopped'), true);
});

test('failed pause persistence rolls status back and does not abort the source before a durable pause', async t => {
    const h = desktop(t), task = h.add('11'), waiting = h.add('12');
    h.pump(); await h.entered;
    assert.equal(h.calls.length, 1);
    h.state.saveError = new Error('FIXTURE_SAVE_FAILURE');
    assert.throws(() => h.run('pauseAllTasks()'), /FIXTURE_SAVE_FAILURE/);
    assert.equal(task.status, 'downloading'); assert.equal(waiting.status, 'pending');
    assert.equal(h.calls[0].signal.aborted, false); assert.ok(task.cancelSource);
    h.state.saveError = null; h.run('pauseAllTasks()'); await turn();
    assert.equal(h.calls[0].signal.aborted, true);
    h.calls[0].resolve(info('11', 'late')); await h.drain();
    assert.equal(h.state.saved.every(item => item.status === 'stopped'), true);
    assert.equal(h.state.transfers.length, 0);
});

for (const code of ['DEVICE_REGISTRATION_FAILED', 'HTTP_403', 'HTTP_429']) {
    test(`explicit ${code} still stops the pending queue without fallback, lowering quality or retry`, async t => {
        const h = desktop(t), active = h.add('11'), waiting = h.add('12');
        h.pump(); await h.entered;
        const error = code === 'DEVICE_REGISTRATION_FAILED' ? { code, registrationFailure: 'BUSINESS_REJECTED' }
            : { status: Number(code.slice(5)) };
        h.calls[0].reject(error); await h.drain();
        assert.equal(active.status, 'failed'); assert.equal(waiting.status, 'stopped');
        assert.equal(h.lookups.length, 1); assert.equal(h.state.transfers.length, 0);
        assert.equal(h.liveTimers().length, 0); assert.equal(h.run('downloadQueue.length'), 0);
        assert.equal(h.state.saved.find(item => item.id === waiting.id).status, 'stopped');
        h.run('loadDownloadTasks(); enqueuePendingTasks(); pumpQueue()'); await turn();
        assert.equal(h.lookups.length, 1);
    });
}
