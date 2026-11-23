const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');

const originalLoad = Module._load;
const children = [];

Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
        return { app: { isPackaged: false, getPath: () => '/tmp/hongguo-sdk-test' } };
    }
    if (request === 'node:fs') {
        return {
            statSync: () => ({ isFile: () => true }),
            mkdirSync: () => {},
            realpathSync: value => value,
        };
    }
    if (request === 'node:child_process') {
        return {
            spawn: () => {
                const child = new EventEmitter();
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                child.killed = false;
                child.kill = () => { child.killed = true; };
                children.push(child);
                return child;
            },
        };
    }
    return originalLoad.apply(this, arguments);
};

const { resolveSdkPlayback } = require('./sdk-playback');

function finish(child) {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, model: {}, userAgent: 'fixture' })));
    child.emit('close', 0);
}

test('SDK helpers are capped at three concurrent processes', { skip: process.platform !== 'darwin' }, async t => {
    t.after(() => { Module._load = originalLoad; });
    const pending = ['11', '12', '13', '14'].map(vid => resolveSdkPlayback(vid));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 3);
    finish(children[0]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 4);
    for (const child of children.slice(1)) finish(child);
    assert.deepEqual(await Promise.all(pending), Array.from({ length: 4 }, () => ({ model: {}, userAgent: 'fixture' })));
});
