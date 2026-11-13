const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browserTimers() {
  const file = path.join(__dirname, '../web/timers.cjs');
  assert(fs.existsSync(file), 'shared source pacing needs a browser timer adapter');
  const timers = new Map(), module = { exports: {} };
  let sequence = 0;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports,
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { delay: module.exports.setTimeout, timers, fire() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); timer.fn();
  } };
}

test('browser delay waits for the timer, returns its value and releases the abort listener', async () => {
  const f = browserTimers(), controller = new AbortController();
  let settled = false;
  const pending = f.delay(37, 'ready', { signal: controller.signal }).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal([...f.timers.values()][0].ms, 37);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  f.fire();
  assert.equal(await pending, 'ready');
  assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(await (() => { const p = f.delay(1); f.fire(); return p; })(), undefined);
});

test('cancelling a browser source delay rejects and clears the outstanding timer', async () => {
  const f = browserTimers(), controller = new AbortController(), reason = new Error('caller stopped');
  const pending = f.delay(1000, undefined, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'ABORT_ERR' && error.cause === reason);
  assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an already cancelled source delay never creates a timer', async () => {
  const f = browserTimers(), controller = new AbortController();
  controller.abort('already stopped');
  await assert.rejects(f.delay(1000, undefined, { signal: controller.signal }), error => error.name === 'AbortError' && error.cause === 'already stopped');
  assert.equal(f.timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
