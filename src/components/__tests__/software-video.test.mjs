import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachSoftwareVideo } from '../../softwareVideo.mjs';

class Video extends EventTarget {
  _paused = true;
  playbackRate = 1;
  async play() { this._paused = false; this.dispatchEvent(new Event('play')); }
  pause() { this._paused = true; }
  get paused() { return this._paused; }
  get currentTime() { return 0; }
  get duration() { return Infinity; }
  removeAttribute() {}
}
class Stream {
  tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  getTracks() { return this.tracks; }
}
globalThis.MediaStream = Stream;
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ loading } = {}) {
  const instances = [];
  class Player {
    currentTime = 0n;
    listeners = new Map();
    seeks = [];
    constructor(options) { this.options = options; instances.push(this); }
    on(event, fn) { this.listeners.set(event, fn); }
    setVolume(value) { this.volume = value; }
    setPlaybackRate(value) { this.rate = value; }
    async load(source) { await loading; this.loaded = true; this.source = source; }
    getDuration() { assert(this.loaded, 'duration is unavailable before format analysis'); return 120000n; }
    async play() { this.playing = true; }
    async pause() { this.playing = false; }
    async seek(value) { this.seeks.push(value); this.currentTime = value; }
    async destroy() { this.currentTime = 0n; this.destroyed = true; }
  }
  const video = new Video();
  const adapter = attachSoftwareVideo(video, async () => Player, 'file:///software');
  return { video, adapter, instances, Player };
}

test('CPU decoder disables native codecs/MSE, keeps timeline, speed and pause', async () => {
  const { video, adapter, instances } = fixture();
  adapter.load('hongguo-local://registered-token');
  await tick();
  const player = instances[0];
  assert.equal(player.options.enableHardware, false);
  assert.equal(player.options.enableWebCodecs, false);
  assert.equal(player.options.checkUseMSE(), false);
  assert.equal(video.duration, 120);
  assert.equal(video.currentSrc, player.source);
  video.currentTime = 37.25;
  video.playbackRate = 2;
  await video.play();
  assert.equal(video.paused, false);
  assert.equal(video.currentTime, 37.25);
  assert.deepEqual(player.seeks, [37250n]);
  assert.equal(player.rate, 2);
  video.pause();
  await tick();
  assert.equal(video.paused, true);
  assert.equal(player.playing, false);
  adapter.destroy();
  assert.equal(player.destroyed, true);
  assert.equal(player.options.container.tracks[0].stopped, true);
});

test('source change cancels stale imports, decode events and playback', async () => {
  const { video, adapter, instances } = fixture();
  adapter.load('hongguo-local://first');
  await tick();
  const first = instances[0];
  let ended = 0;
  video.addEventListener('ended', () => ended++);
  adapter.load('hongguo-local://second');
  first.listeners.get('ended')();
  await tick();
  assert.equal(first.destroyed, true);
  assert.equal(ended, 0);
  assert.equal(video.currentSrc, 'hongguo-local://second');
  const pending = video.play();
  video.pause();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(video.paused, true);
  instances[1].listeners.get('ended')();
  assert.equal(ended, 1);
  assert.equal(video.ended, true);
  adapter.destroy();
});

test('media errors are reported; clearing source releases old media', async () => {
  const { video, adapter, instances } = fixture();
  adapter.load('hongguo-local://first'); await tick();
  let errors = 0;
  video.addEventListener('error', () => errors++);
  instances[0].currentTime = 37250n;
  instances[0].listeners.get('error')(new Error('decoder unavailable'));
  assert.equal(errors, 1);
  assert.equal(video.error.message, 'decoder unavailable');
  assert.equal(video.currentTime, 37.25, 'decoder cleanup must not reset the saved position');
  video.removeAttribute('src'); video.load(); await tick();
  assert.equal(video.currentSrc, '');
  assert.equal(instances[0].destroyed, true);
  adapter.destroy();
});

test('immediate resume waits for the asynchronous decoder pause', async () => {
  const { video, adapter, instances } = fixture();
  adapter.load('hongguo-local://first'); await tick(); await video.play();
  let finish;
  instances[0].pause = () => new Promise(resolve => { finish = resolve; });
  video.pause();
  video.currentTime = 27;
  const resume = video.play();
  await tick();
  assert.equal(video.paused, true);
  assert.deepEqual(instances[0].seeks, []);
  finish(); await resume;
  assert.equal(video.paused, false);
  assert.deepEqual(instances[0].seeks, [27000n]);
  adapter.destroy();
});

test('media getters stay safe while source analysis is pending', async () => {
  let finish;
  const { video, adapter } = fixture({ loading: new Promise(resolve => { finish = resolve; }) });
  adapter.load('hongguo-local://first'); await tick();
  assert.equal(video.duration, 0); assert.equal(video.currentTime, 0);
  video.currentTime = 25;
  assert.equal(video.currentTime, 25);
  finish(); await tick();
  assert.equal(video.duration, 120); assert.equal(video.currentTime, 25);
  adapter.destroy();
});

test('destroy flags the element so a later persist cannot write the native clock', async () => {
  const { video, adapter } = fixture();
  adapter.load('hongguo-local://first'); await tick();
  video.currentTime = 37.25;
  assert.equal(video.currentTime, 37.25, 'decoder position is readable before destroy');
  adapter.destroy();
  assert.equal(video.currentTime, 0, 'removing the accessor exposes the media-free native clock');
  assert.equal(video.__softwareDestroyed, true, 'callers can detect the accessor removal');
});

test('re-attach on the same element clears the destroy flag', async () => {
  const { video, adapter, instances } = fixture();
  adapter.load('hongguo-local://first'); await tick();
  adapter.destroy();
  assert.equal(video.__softwareDestroyed, true);
  const second = attachSoftwareVideo(video, async () => instances[0].constructor, 'file:///software');
  assert.equal(video.__softwareDestroyed, undefined, 'a fresh adapter must not inherit the old destroy flag');
  second.destroy();
});

test('a timed-out load cannot later fire metadata or autoplay', async () => {
  const nativeTimeout = globalThis.setTimeout;
  let finish;
  globalThis.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 20000 ? 5 : ms, ...args);
  const { video, adapter, instances } = fixture({ loading: new Promise(resolve => { finish = resolve; }) });
  let metadata = 0;
  video.addEventListener('loadedmetadata', () => { metadata++; video.play().catch(() => {}); });
  try {
    adapter.load('hongguo-local://slow');
    await new Promise(resolve => nativeTimeout(resolve, 12));
    assert.equal(video.error.code, 3);
    finish(); await tick();
    assert.equal(metadata, 0); assert.equal(video.paused, true);
    assert.equal(instances[0].destroyed, true);
  } finally { adapter.destroy(); globalThis.setTimeout = nativeTimeout; }
});
