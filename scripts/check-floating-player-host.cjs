const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

module.exports = function checkFloatingPlayerHost(onSend = () => {}) {
function node() {
  const events = new Map();
  return { children: [], style: {}, dataset: {},
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); },
    dispatchEvent(event) { for (const fn of events.get(event.type) || []) fn(event); },
    appendChild(child) {
    if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
    child.parentNode = this; this.children.push(child); return child;
  }, cloneNode() { return node(); }, setAttribute() {} };
}
const document = { createElement: node, querySelectorAll: () => [], documentElement: { dataset: { theme: 'dark' } } };
let bridge;
const bridgeCalls = [];
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8'), {
  require(name) {
    assert.equal(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'electronAPI'); bridge = value; } },
      ipcRenderer: { send(channel, size) {
        assert.equal(channel, 'floating-player-aspect-ratio');
        bridgeCalls.push({ width: size.width, height: size.height });
        onSend(channel, size);
      } },
    };
  },
});
assert.equal(typeof bridge.setFloatingPlayerAspectRatio, 'function', 'real preload must expose the narrow bridge');
const slots = [], effects = [], cleanups = [], setups = [], changes = [];
let cursor = 0, child, blocked = false, title = '真实剧名 · 第 1 集', api;
const react = {
  useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
  useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
  useCallback(fn) { cursor++; return fn; },
  useEffect(fn, dependencies) { const index = cursor++; if (!slots[index] || dependencies.some((value, i) => value !== slots[index][i])) {
    slots[index] = dependencies; setups.push(fn); effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); });
  } },
};
const window = { electronAPI: bridge, open(url, name) {
  assert.equal(url, 'about:blank'); assert.equal(name, 'hongguo-floating-player');
  if (blocked) return null;
  const events = new Map();
  child = { document: { head: node(), body: node(), documentElement: node(), createElement: node, title: '' }, closed: false,
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name), focus() {},
    close() { events.get('beforeunload')?.(); events.get('pagehide')?.(); this.closed = true; } };
  return child;
} };
const file = path.resolve(__dirname, '../src/components/useFloatingPlayer.js');
const moduleFixture = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { format: 'cjs' }).code,
  { module: moduleFixture, exports: moduleFixture.exports, require: name => { assert.equal(name, 'react'); return react; }, document, window });
const onChange = value => changes.push(value);
const render = () => { cursor = 0; api = moduleFixture.exports.default(title, onChange); effects.splice(0).forEach(fn => fn()); };
render();
// React StrictMode replays mount cleanup before the live mount.
cleanups.forEach(fn => fn?.());
setups.at(-1)();
const slot = node(), mediaIdentity = node(); api.host.appendChild(mediaIdentity); api.attachSlot(slot);
const mediaEvents = new Map();
Object.assign(mediaIdentity, { currentTime: 24, paused: false, muted: true, volume: 0.4, playbackRate: 1.5,
  videoWidth: 1080, videoHeight: 1920,
  src: 'local-media://real-download', currentSrc: 'local-media://real-download', readyState: 1,
  pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
  addEventListener: (name, fn) => mediaEvents.set(name, fn), removeEventListener: name => mediaEvents.delete(name) });
api.host.querySelector = () => mediaIdentity;
assert.equal(api.host.parentNode, slot);
api.toggle(); render();
assert.equal(api.floating, true);
assert.equal(api.host.parentNode, child.document.body);
assert.equal(api.host.children[0], mediaIdentity, 'moving to a floating window must retain the same media node');
assert.equal(child.document.title, title);
assert.equal(mediaIdentity.currentTime, 24, 'entering must retain playback position');
assert.equal(mediaIdentity.muted, true);
assert.equal(mediaIdentity.playbackRate, 1.5);
assert.deepEqual(bridgeCalls, [{ width: 1080, height: 1920 }], 'opening sends intrinsic video dimensions through actual preload');
mediaIdentity.videoWidth = 1920; mediaIdentity.videoHeight = 1080;
api.host.dispatchEvent({ type: 'resize', target: mediaIdentity });
api.host.dispatchEvent({ type: 'loadedmetadata', target: mediaIdentity });
assert.deepEqual(bridgeCalls.at(-1), { width: 1920, height: 1080 }, 'landscape episode updates the content ratio');
assert.equal(bridgeCalls.length, 2, 'duplicate metadata must not repeatedly resize');
assert.equal(mediaIdentity.currentTime, 24);
assert.equal(mediaIdentity.paused, false, 'aspect update must not interrupt playback');
mediaIdentity.videoWidth = 1080; mediaIdentity.videoHeight = 1920;
api.host.dispatchEvent({ type: 'loadedmetadata', target: mediaIdentity });
assert.deepEqual(bridgeCalls.at(-1), { width: 1080, height: 1920 }, 'portrait episode restores its own ratio');
const count = bridgeCalls.length;
api.host.dispatchEvent({ type: 'resize', target: {} });
mediaIdentity.videoWidth = 0;
api.host.dispatchEvent({ type: 'resize', target: mediaIdentity });
mediaIdentity.videoWidth = 1080;
assert.equal(bridgeCalls.length, count, 'foreign nodes and missing metadata cannot change ratio');
mediaIdentity.currentTime = 38;
mediaIdentity.paused = true;
title = '真实剧名 · 第 2 集'; render();
assert.equal(child.document.title, title, 'the native title must follow automatic episode changes');
child.close(); render();
assert.equal(api.floating, false);
assert.equal(api.host.parentNode, slot);
assert.equal(api.host.children[0], mediaIdentity);
mediaIdentity.currentTime = 0; mediaIdentity.readyState = 1;
mediaEvents.get('loadedmetadata')?.();
assert.equal(mediaIdentity.currentTime, 38, 'returning must restore position after a media reload');
assert.equal(mediaIdentity.paused, true, 'returning must preserve manual pause');
assert.deepEqual(changes, [true, false]);
blocked = true;
assert.throws(() => api.toggle(), /悬浮/);
assert.equal(api.host.parentNode, slot, 'a blocked popup must leave the current player in place');
blocked = false; api.toggle(); render(); cleanups.forEach(fn => fn?.());
assert.equal(child.closed, true, 'unmount must close the owned window');
console.log('PASS floating host: one media node, dynamic title, close restoration, blocked popup, and unmount cleanup');
};
if (require.main === module) module.exports();
