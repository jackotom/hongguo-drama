const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWebLoginObserver } = require('./account-web-login');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('closing during the cookie read cannot start login verification', async () => {
  const read = deferred(); let verified = 0, cancelled = 0;
  const observer = createWebLoginObserver({ readCookies: () => read.promise, complete: () => verified++, cancel: () => cancelled++, onSignedIn: () => assert.fail('closed login') });
  const pending = observer.inspect(); observer.close(); observer.close();
  read.resolve([{ name:'sessionid', value:'fixture' }]); await pending;
  assert.equal(verified, 0); assert.equal(cancelled, 1);
});
test('multiple cookie events share verification and closed windows receive no success', async () => {
  const gate = deferred(); let active = 0, maximum = 0, success = 0;
  const observer = createWebLoginObserver({ readCookies: async () => [{ name:'sessionid', value:'fixture' }], complete: async () => { active++; maximum = Math.max(maximum,active); await gate.promise; active--; return {status:'signed-in'}; }, cancel: () => {}, onSignedIn: () => success++ });
  const first = observer.inspect(); await Promise.resolve(); await observer.inspect();
  observer.close(); gate.resolve(); await first;
  assert.equal(maximum, 1); assert.equal(success, 0);
});
