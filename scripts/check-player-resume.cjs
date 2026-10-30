// Run: node scripts/check-player-resume.cjs [name-filter]. In-memory media only; no playback/network/files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');
const videoEnhancementStub = {
  __esModule: true, default: () => null, VideoEnhancementControls: () => null,
  useVideoEnhancement: () => ({ mode: 'original', strength: 50, update() {}, status: {}, setStatus() {} }),
};
const shortcutSource = transformSync(fs.readFileSync(path.join(__dirname, '../src/shortcuts.js'), 'utf8'), { loader: 'js', format: 'cjs' }).code;
const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/components/Player.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;

function mount({ local = false, localIndexes = [], localQuality, saved = null, transcode, prepare, props = {}, episodeCount = 2, storage = new Map(), seriesId = 'A', settings = {}, lockedIndexes = [], apiOverrides = {}, now = () => Date.now() } = {}) {
  // Playback fixtures model an explicit play command; target:null exercises passive library entry.
  props = { setEpisodesOpen() {}, ...((local || saved) ? { target: { seriesId, resume: true, ts: 1 } } : {}), ...props };
  const slots = [], effects = [], cleanups = [], saves = [], prepares = [], transcodes = [], cancelled = [];
  const releases = [], settingsSaved = [], historyListeners = new Set();
  const events = new Map(), mediaEvents = new Map(), timers = new Map();
  const listenerOptions = new Map(), mediaCalls = { play: 0, pause: 0 };
  const documentEvents = new Map();
  let pipExits = 0, floating = false;
  const floatingEvents = new Map();
  const floatingWindow = { addEventListener: (name, fn) => floatingEvents.set(name, fn), removeEventListener: name => floatingEvents.delete(name) };
  const document = { activeElement: null, querySelector: () => null, fullscreenElement: null, pictureInPictureElement: null,
    pictureInPictureEnabled: true, exitPictureInPicture: async () => { pipExits++; floating = false; stage.ownerDocument = document; document.pictureInPictureElement = null; mediaEvents.get('leavepictureinpicture')?.(); render(); },
    addEventListener: (name, fn) => documentEvents.set(name, fn), removeEventListener: name => documentEvents.delete(name),
    exitFullscreen: async () => { document.fullscreenElement = null; documentEvents.get('fullscreenchange')?.(); } };
  const scrollArea = { scrollTop: 360 };
  const stage = { ownerDocument: document, closest: selector => selector === '.main-content' ? scrollArea : null,
    requestFullscreen: async () => { document.fullscreenElement = stage; scrollArea.scrollTop = 0; documentEvents.get('fullscreenchange')?.(); } };
  let cursor = 0, tree, timerId = 0, oldSrc = '', oldKey;
  let transcodeProgress;
  const media = { currentTime: 0, duration: 100, readyState: 0, videoWidth: 640, paused: false,
    play: async () => {
      mediaCalls.play++;
      media.paused = false;
      const video = find(n => n.type === 'video');
      video?.props.onPlay?.({ currentTarget: media });
      if (!media.paused) video?.props.onPlaying?.({ currentTarget: media });
    }, pause: () => { mediaCalls.pause++; media.paused = true; },
    focus: () => { document.activeElement = media; },
    removeAttribute: name => { if (name === 'src') media.src = ''; },
    load: () => { media.currentTime = 0; media.readyState = 0; media.currentSrc = ''; media.paused = true; },
    addEventListener: (name, fn) => mediaEvents.set(name, fn), removeEventListener: name => mediaEvents.delete(name) };
  const changed = (old, deps) => !old || deps.some((d, i) => !Object.is(d, old[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback: (fn, deps) => react.useMemo(fn, deps),
    useEffect: (fn, deps) => { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  // useCallback returns the callback, unlike useMemo.
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps);
  const episodes = Array.from({ length: episodeCount }, (_, i) => i + 1).map(n => {
    const isLocal = local || localIndexes.includes(n);
    return { vid_index: n, vid: `v${n}`, locked: lockedIndexes.includes(n), status: isLocal ? 'completed' : 'missing',
      ...(isLocal ? { fileUrl: `file:///mock-${n}.mp4`, savePath: `/mock-${n}.mp4`, ...(localQuality ? { actualQuality: localQuality } : {}) } : {}) };
  });
  const api = {
    getSeriesList: async () => [{ series_id: seriesId }],
    getSeriesEpisodes: async () => ({ success: true, data: { series_id: seriesId, series_title: '测试剧', total: episodeCount, episodes } }),
    getPlaybackPosition: async () => saved,
    savePlaybackPosition: async (...args) => saves.push(args),
    onWatchHistoryUpdated: listener => { historyListeners.add(listener); return () => historyListeners.delete(listener); },
    prepareOnlinePlay: async p => { prepares.push(p); return prepare ? prepare(p) : { success: true, url: `hongguo-stream://mock-${prepares.length}` }; },
    transcodeForPlayback: async p => { transcodes.push(p); return transcode ? transcode(p) : { success: true, url: 'file:///mock-compat.mp4' }; },
    cancelTranscodeForPlayback: async p => cancelled.push(p),
    onTranscodeProgress: fn => { transcodeProgress = fn; return () => { transcodeProgress = null; }; },
    getSettings: async () => ({ compat_mode: true, ...settings }),
    saveSettings: async s => { settingsSaved.push(s); return { success: true }; },
    releaseOnlinePlay: p => { structuredClone(p); releases.push(p); return Promise.resolve(); },
    compatCacheStatus: async () => ({ success: true, files: 1, bytes: 10 }),
    clearCompatCache: async () => ({ success: true, count: 1 }),
    clearOnlineCache: async () => ({ success: true }),
    ...apiOverrides,
  };
  const window = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, electronAPI: new Proxy(api, { get: (o, k) => o[k] || (k.startsWith('on') ? () => () => {} : async () => ({})) }),
    addEventListener: (k, f, options) => { events.set(k, f); listenerOptions.set(k, options); },
    removeEventListener: k => { events.delete(k); listenerOptions.delete(k); },
    dispatchEvent: event => { events.get(event.type)?.(event); return !event.defaultPrevented; } };
  document.defaultView = window;
  const popupDocument = { ...document, defaultView: floatingWindow };
  const shortcutModule = { exports: {} };
  vm.runInNewContext(shortcutSource, { module: shortcutModule, exports: shortcutModule.exports, window, Event });
  const setTimer = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; };
  const context = { module: { exports: {} }, Date: class extends Date { static now() { return now(); } }, require: n => n === 'react-dom' ? { createPortal: children => children } : n === './useFloatingPlayer' ? { __esModule: true, default: () => ({ host: {}, attachSlot() {}, floating, toggle() { floating = !floating; stage.ownerDocument = floating ? popupDocument : document; render(); } }) } : n === 'react' ? react : n === './useDialogKeyboard' ? () => {} : n === '../shortcuts' ? shortcutModule.exports : n === './VideoEnhancement' ? videoEnhancementStub : n === './danmakuSource.mjs' ? { useDanmakuSource: () => 'official', writeDanmakuSource() {} } : n === './OfficialDanmaku' ? { useOfficialDanmaku: ({ preferences, active }) => ({ ...preferences, active }) } : n === './CommentDanmaku' ? { useCommentDanmaku: () => ({ enabled: false, settings: {}, comments: [] }) } : {}, window, document, navigator: {}, crypto: require('node:crypto').webcrypto, setTimeout: setTimer, clearTimeout: id => timers.delete(id), setInterval: setTimer, clearInterval: id => timers.delete(id), requestAnimationFrame: fn => setTimer(fn, 0), cancelAnimationFrame: id => timers.delete(id), console };
  context.exports = context.module.exports;
  vm.runInNewContext(source, context);
  const nodes = () => { const out = []; const walk = n => { if (!n || typeof n !== 'object') return; out.push(n); n.children?.forEach(walk); }; walk(tree); return out; };
  const find = fn => nodes().find(fn);
  const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(text).join('') || '';
  const render = () => {
    cursor = 0; tree = context.module.exports.default(props);
    const video = find(n => n.type === 'video');
    const stageNode = find(n => n.props.className?.split(' ').includes('player-stage'));
    if (stageNode) stageNode.props.ref.current = stage;
    if (video) { if (video.props.src !== oldSrc || video.props.key !== oldKey) { media.src = video.props.src; media.load(); oldSrc = video.props.src; oldKey = video.props.key; } video.props.ref.current = media; }
    else for (const slot of slots) if (slot?.current === media) slot.current = null;
    effects.splice(0).forEach(fn => fn()); return tree;
  };
  const flush = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); render(); } };
  const metadata = () => { media.readyState = 1; media.currentSrc = media.src; find(n => n.type === 'video')?.props.onLoadedMetadata?.({ currentTarget: media }); mediaEvents.get('loadedmetadata')?.(); };
  // Follow DOM propagation order; targetAction models a focused control's own listener.
  const dispatchKey = (type, init, targetAction) => {
    const event = { type, target: document.activeElement, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.propagationStopped = true; }, ...init };
    const options = listenerOptions.get(type);
    const capture = options === true || options?.capture === true;
    if (capture) events.get(type)?.(event);
    if (!event.propagationStopped) targetAction?.(event);
    if (!capture && !event.propagationStopped) events.get(type)?.(event);
    return event;
  };
  render();
  return { props, render, flush, find, media, metadata, saves, prepares, transcodes, cancelled, events, timers, listenerOptions, mediaCalls, document, dispatchKey,
    releases, settingsSaved, stage, scrollArea, mediaEvents,
    text: () => text(tree),
    historyUpdated: payload => [...historyListeners].forEach(listener => listener(payload)),
    flushBatched: async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); render(); },
    transcodeProgress: payload => transcodeProgress?.(payload),
    button: label => find(n => n.type === 'button' && text(n).includes(label)),
    enterFloatingPlayer: () => { floating = true; stage.ownerDocument = popupDocument; document.pictureInPictureElement = media; render(); },
    exitFloatingPlayer: () => document.exitPictureInPicture(),
    isFloating: () => floating,
    pictureInPictureExits: () => pipExits,
    episode: n => find(x => x.props['aria-label'] === `第 ${n} 集`).props.onClick(),
    error: code => find(n => n.type === 'video').props.onError({ currentTarget: Object.assign(media, { error: { code } }) }),
    unmount: () => cleanups.forEach(fn => fn?.()) };
}

module.exports = { mount };

if (require.main === module) (async () => {
  let failures = 0;
  const fixedPlayback = () => ({ storage: new Map([['hongguo:online-quality', '1080p']]), localQuality: '1080p' });
  const test = async (name, fn) => { if (process.argv[2] && !name.includes(process.argv[2])) return; try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.stack}`); } };
  await test('removed history stays removed through hidden player unload and new playback can record again', async () => {
    for (const resume of [false, true]) {
      const ui = mount({ local: true }); await ui.flush(); ui.metadata();
      ui.media.currentTime = 42; ui.props.active = false; ui.render();
      ui.historyUpdated({ removedSeriesId: 'A' }); await ui.flush();
      const afterRemoval = ui.saves.length;
      ui.events.get('beforeunload')();
      ui.find(n => n.type === 'video').props.onPause();
      for (const timer of ui.timers.values()) if (timer.delay === 5000) timer.fn();
      assert.equal(ui.saves.length, afterRemoval, 'old pause/timer/unload must not restore removed history');
      if (resume) {
        ui.props.active = true; ui.render(); await ui.media.play();
        assert.ok(ui.saves.length > afterRemoval, 'new real playback may create a fresh history record');
      }
      const beforeUnmount = ui.saves.length; ui.unmount();
      if (!resume) assert.equal(ui.saves.length, beforeUnmount, 'hidden player cleanup must not restore removed history');
    }
  });
  await test('history completion forwards valid media duration and the ended event without auto-delete', async () => {
    const ui = mount({ local: true, episodeCount: 1 }); await ui.flush(); ui.metadata();
    ui.media.currentTime = 100;
    ui.find(n => n.type === 'video').props.onEnded(); await ui.flush();
    assert.ok(ui.saves.some(args => args[1] === 1 && args[2] === 100 && args[3]?.duration === 100 && args[3]?.ended === true));
    ui.unmount();
  });
  await test('fullscreen scroll restores the player page after button and Escape exits', async () => {
    const ui = mount(); await ui.flush();
    try {
      for (const fromButton of [true, false]) {
        ui.scrollArea.scrollTop = fromButton ? 360 : 280;
        const expected = ui.scrollArea.scrollTop;
        const toggle = ui.find(n => typeof n.props.onToggleFullscreen === 'function').props.onToggleFullscreen;
        await toggle();
        assert.equal(ui.scrollArea.scrollTop, 0, 'entering fullscreen removes the player from the page flow');
        if (fromButton) await toggle(); else await ui.document.exitFullscreen();
        for (const [id, timer] of ui.timers) if (timer.delay === 0) { ui.timers.delete(id); timer.fn(); }
        assert.equal(ui.scrollArea.scrollTop, expected, 'exit must restore the page position from before fullscreen');
      }
    } finally { ui.unmount(); }
  });
  await test('fullscreen scroll is restored after a rejected request and remains usable', async () => {
    const ui = mount(); await ui.flush();
    try {
      ui.stage.requestFullscreen = async () => { ui.scrollArea.scrollTop = 0; throw new Error('denied'); };
      await ui.find(n => typeof n.props.onToggleFullscreen === 'function').props.onToggleFullscreen();
      assert.equal(ui.scrollArea.scrollTop, 360);
    } finally { ui.unmount(); }
  });
  await test('fixed-quality online unsupported-source error reconnects once without decoder certainty or automatic transcode', async () => {
    const ui = mount({ ...fixedPlayback(), props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } } }); await ui.flush();
    ui.error(4); await ui.flush();
    assert.equal(ui.prepares.length, 2); assert.equal(ui.prepares[1].force, true);
    ui.error(4); await ui.flush();
    assert.equal(ui.prepares.length, 2, 'reconnect must remain bounded');
    assert.equal(ui.transcodes.length, 0, 'unavailable source is not proof of codec failure');
    assert.ok(!ui.find(n => n.type === 'p' && n.children.includes('当前片源无法正常解码')));
    assert.ok(ui.button('重新连接片源')); assert.ok(ui.button('转码后播放'), 'manual fallback remains available');
    ui.unmount();
  });
  await test('saved online episode resumes after metadata', async () => {
    const ui = mount({ saved: { vid_index: 2, currentTime: 34 } }); await ui.flush();
    assert.equal(ui.prepares.at(-1)?.vidIndex, 2, 'saved online episode must be prepared');
    ui.metadata(); assert.equal(ui.media.currentTime, 34); ui.unmount();
  });
  await test('local episode saves exact position before switching and on hide', async () => {
    const ui = mount({ local: true, saved: { vid_index: 1, currentTime: 21 } }); await ui.flush(); ui.metadata();
    assert.equal(ui.media.currentTime, 21); ui.media.currentTime = 22.2; ui.episode(2);
    assert.ok(ui.saves.some(p => p[1] === 1 && p[2] === 22.2), 'switch must save latest second');
    await ui.flush(); ui.metadata(); ui.media.currentTime = 1.2; ui.props.active = false; ui.render();
    assert.ok(ui.saves.some(p => p[1] === 2 && p[2] === 1.2), 'hide must bypass periodic save threshold');
    assert.equal(ui.events.has('keydown'), false, 'hidden player must not capture keys');
    assert.equal([...ui.timers.values()].some(t => t.delay === 2000), false, 'hidden idle detail polling must stop'); ui.unmount();
  });
  await test('fixed-quality online decoding error auto-falls back once and retains time', async () => {
    const ui = mount({ ...fixedPlayback(), props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } } }); await ui.flush(); ui.metadata(); ui.media.currentTime = 27;
    ui.error(3); ui.error(3); await ui.flush(); assert.equal(ui.transcodes.length, 1);
    assert.equal(ui.find(n => n.type === 'video').props.src, 'file:///mock-compat.mp4'); ui.metadata();
    assert.equal(ui.media.currentTime, 27); ui.error(4); await ui.flush();
    assert.equal(ui.transcodes.length, 2, 'failed compatibility media gets one forced rebuild');
    assert.equal(ui.transcodes[1].force, true);
    ui.metadata(); assert.equal(ui.media.currentTime, 27, 'forced rebuild retains position');
    ui.error(4); await ui.flush(); assert.equal(ui.transcodes.length, 2, 'forced compatibility errors must not loop');
    assert.ok(ui.button('重试本集'), 'compat failure must offer explicit retry');
    ui.find(n => n.props.className?.includes('series-picker-btn')).props.onClick(); await ui.flush();
    await ui.button('清空转码缓存').props.onClick(); await ui.flush();
    assert.ok(ui.find(n => n.type === 'video'), 'cache clear keeps the fullscreen node');
    assert.equal(ui.media.paused, true, 'cleared cached media must stop safely');
    assert.ok(ui.button('重试本集'), 'cache clear must offer explicit recovery');
    await ui.button('重试本集').props.onClick(); await ui.flush(); ui.metadata();
    assert.equal(ui.media.currentTime, 27, 'retry after clearing current cache retains position'); ui.unmount();
  });
  await test('same-url fast compatibility rebuild restores the DOM source after batched state updates', async () => {
    const ui = mount({ local: true }); await ui.flush(); ui.metadata();
    ui.media.currentTime = 19; ui.error(3); await ui.flush(); ui.metadata();
    const source = ui.media.src;
    ui.error(3); await ui.flushBatched();
    assert.equal(ui.transcodes.length, 2);
    assert.equal(ui.media.src, source, 'same virtual src must still restore the imperatively removed DOM src');
    ui.metadata(); assert.equal(ui.media.currentTime, 19); ui.unmount();
  });
  await test('compatibility rebuild releases the old source and ignores obsolete results', async () => {
    let resolve, calls = 0;
    const ui = mount({ local: true, transcode: async () => ++calls === 1
      ? { success: true, cached: true, url: 'file:///cached-compat.mp4' }
      : new Promise(done => { resolve = done; }) });
    await ui.flush(); ui.metadata(); ui.media.currentTime = 31;
    ui.error(3); await ui.flush(); ui.metadata();
    ui.error(3); await ui.flush();
    assert.equal(ui.transcodes.length, 2, 'cached decode failure must force a rebuild');
    assert.equal(ui.transcodes[1].force, true);
    assert.equal(ui.find(n => n.type === 'video').props.src, undefined, 'release old file while replacing Windows cache');
    assert.equal(ui.media.currentSrc, '');
    ui.episode(2); await ui.flush();
    assert.equal(ui.cancelled.at(-1).requestId, ui.transcodes[1].requestId);
    resolve({ success: true, url: 'file:///cached-compat.mp4' }); await ui.flush();
    assert.equal(ui.find(n => n.type === 'video').props.src, 'file:///mock-2.mp4');
    ui.unmount();
  });
  await test('manual compatibility retry forces rebuilding and automatic compatibility can stay off', async () => {
    const ui = mount({ local: true, settings: { compat_mode: false }, transcode: async () => ({ success: false, error: 'software conversion failed' }) });
    await ui.flush(); ui.metadata(); ui.error(3); await ui.flush();
    assert.equal(ui.transcodes.length, 0);
    await ui.button('转码后播放').props.onClick(); await ui.flush();
    assert.equal(ui.transcodes[0].force, true, 'explicit retry must not reuse a failed cache');
    assert.ok(ui.find(n => n.props.role === 'alert' && n.children.includes('software conversion failed')), 'retain diagnostic message after toast expires');
    ui.error(3); await ui.flush(); assert.equal(ui.transcodes.length, 1);
    ui.unmount();
  });
  await test('failed automatic transcode does not loop on repeated decode events', async () => {
    const ui = mount({ ...fixedPlayback(), local: true, transcode: async () => ({ success: false, error: 'mock failure' }) }); await ui.flush(); ui.metadata();
    ui.error(3); await ui.flush(); ui.error(3); await ui.flush();
    ui.error(3); await ui.flush();
    assert.equal(ui.transcodes[0].filePath, '/mock-1.mp4');
    assert.equal(ui.transcodes[1].filePath, null, 'decode failure after reconnect must convert the online source');
    assert.equal(ui.prepares.length, 1, 'failed conversion must not restart online recovery indefinitely');
    assert.equal(ui.transcodes.length, 2, 'one original and one refreshed-source conversion, then stop'); assert.ok(ui.button('转码后播放')); ui.unmount();
    let resolve;
    const pending = mount({ local: true, transcode: () => new Promise(r => { resolve = r; }) });
    await pending.flush(); pending.metadata(); pending.error(3); await pending.flush();
    assert.ok(pending.button('取消转码')); pending.episode(2); await pending.flush();
    assert.equal(pending.cancelled[0]?.vidIndex, 1, 'switch must cancel old transcode');
    resolve({ success: true, url: 'file:///late-compat.mp4' }); await pending.flush();
    assert.equal(pending.find(n => n.type === 'video').props.src, 'file:///mock-2.mp4'); pending.unmount();
  });
  await test('reconnecting online does not transcode the failed local download again', async () => {
    const ui = mount({ ...fixedPlayback(), local: true, settings: { cache_next_episode: false, compat_mode: false }, transcode: async () => ({ success: false, error: 'bad local media' }) });
    await ui.flush(); ui.metadata(); ui.error(3); await ui.flush();
    await ui.button('转码后播放').props.onClick(); await ui.flush();
    assert.equal(ui.transcodes[0].filePath, '/mock-1.mp4');
    await ui.button('重新连接片源').props.onClick(); await ui.flush(); ui.metadata();
    ui.error(3); await ui.flush(); await ui.button('转码后播放').props.onClick(); await ui.flush();
    assert.equal(ui.transcodes[1].filePath, null, 'online recovery must use its online source');
    ui.unmount();
  });
  await test('failed local conversion followed by unavailable online source does not invent a decode failure', async () => {
    const ui = mount({ ...fixedPlayback(), local: true, transcode: async () => ({ success: false, error: 'mock failure' }) });
    await ui.flush(); ui.metadata(); ui.error(4); await ui.flush();
    assert.equal(ui.transcodes.length, 1, 'local unsupported media gets one conversion attempt');
    assert.equal(ui.prepares.length, 1, 'failed local conversion reconnects online once');
    assert.equal(ui.prepares[0].force, true);
    ui.error(4); await ui.flush(); ui.error(4); await ui.flush();
    assert.equal(ui.transcodes.length, 1, 'online unsupported-source may mean unavailable HTTP, not codec failure');
    assert.equal(ui.prepares.length, 1, 'persistent unavailable source must not loop reconnects');
    assert.ok(ui.button('重新连接片源')); assert.ok(ui.button('转码后播放'), 'explicit recovery remains available');
    ui.unmount();
  });
  await test('fixed-quality network failure refreshes the same episode once and retains position', async () => {
    const ui = mount({ ...fixedPlayback(), settings: { cache_next_episode: false } }); await ui.flush(); await ui.button('播放本集').props.onClick(); await ui.flush(); ui.metadata();
    ui.media.currentTime = 42; ui.error(2); await ui.flush();
    assert.equal(ui.prepares.length, 2, 'network failure should reconnect once');
    assert.equal(ui.prepares[1].force, true);
    ui.metadata(); assert.equal(ui.media.currentTime, 42);
    ui.error(2); await ui.flush();
    assert.equal(ui.prepares.length, 2, 'persistent network failure must stop');
    assert.ok(ui.button('重试本集')); ui.unmount();
  });
  await test('failed local conversion falls back online once without deleting the download', async () => {
    const ui = mount({ ...fixedPlayback(), local: true, settings: { cache_next_episode: false }, transcode: async () => ({ success: false, error: 'bad local media' }) });
    await ui.flush(); ui.metadata(); ui.media.currentTime = 18;
    ui.error(3); await ui.flush();
    assert.equal(ui.prepares.length, 1, 'failed local conversion should reconnect online');
    assert.equal(ui.prepares[0].force, true); ui.metadata(); assert.equal(ui.media.currentTime, 18);
    ui.error(3); await ui.flush();
    assert.equal(ui.transcodes.length, 2); assert.equal(ui.transcodes[1].filePath, null);
    assert.equal(ui.prepares.length, 1, 'a bad online source must not loop back through reconnection');
    ui.error(3); await ui.flush(); assert.equal(ui.transcodes.length, 2);
    ui.unmount();
  });
  await test('retry keeps online recovery instead of returning to the broken local file', async () => {
    const ui = mount({ ...fixedPlayback(), local: true, settings: { cache_next_episode: false } });
    await ui.flush(); ui.metadata(); ui.media.currentTime = 23;
    ui.error(2); await ui.flush(); ui.metadata();
    ui.error(2); await ui.flush();
    assert.ok(ui.button('重试本集'));
    await ui.button('重试本集').props.onClick(); await ui.flush();
    assert.equal(ui.prepares.length, 2, 'manual retry must retain the online source choice');
    assert.equal(ui.prepares[1].force, true);
    assert.notEqual(ui.find(n => n.type === 'video').props.src, 'file:///mock-1.mp4');
    ui.metadata(); assert.equal(ui.media.currentTime, 23); ui.unmount();
  });
  await test('aborted local loading exposes retry and preserves the second', async () => {
    const ui = mount({ local: true }); await ui.flush(); ui.metadata(); ui.media.currentTime = 42;
    ui.error(1); await ui.flush(); assert.ok(ui.button('重试本集'));
    await ui.button('重试本集').props.onClick(); await ui.flush(); ui.metadata();
    assert.equal(ui.media.currentTime, 42);
    ui.find(n => n.props.className?.includes('series-picker-btn')).props.onClick(); await ui.flush();
    await ui.button('清空播放缓存').props.onClick(); await ui.flush();
    assert.equal(ui.find(n => n.type === 'video').props.src, 'file:///mock-1.mp4', 'clearing online cache must not interrupt local media');
    assert.equal(ui.media.currentTime, 42); ui.unmount();
  });
  await test('transcode request identity ignores old progress and cancels the original request', async () => {
    const ui = mount({ local: true, transcode: () => new Promise(() => {}) });
    await ui.flush(); ui.metadata(); ui.error(3); await ui.flush();
    const first = ui.transcodes[0];
    ui.button('取消转码').props.onClick(); await ui.flush();
    await ui.button('重试本集').props.onClick(); await ui.flush(); ui.metadata(); ui.error(3); await ui.flush();
    const second = ui.transcodes[1];
    assert.ok(second, 'retry must create a second request for the same episode');
    const progress = (request, percent) => ui.transcodeProgress({ seriesId: 'A', vidIndex: 1, requestId: request.requestId, percent });
    progress(second, 20); ui.render();
    assert.equal(ui.find(n => n.props.className === 'player-wait-fill').props.style.width, '20%');
    progress(first, 87); ui.render();
    assert.equal(ui.find(n => n.props.className === 'player-wait-fill').props.style.width, '20%', 'old request must not overwrite retry progress');
    assert.ok(first.requestId && second.requestId && first.requestId !== second.requestId, 'each attempt needs a unique request ID');
    assert.equal(ui.cancelled[0].requestId, first.requestId, 'cancel must carry the original request snapshot');
    ui.unmount(); assert.equal(ui.cancelled[1].requestId, second.requestId, 'unmount cancels only the current request');
  });
  await test('fullscreen playback keeps the video key across local auto-next and compatibility changes', async () => {
    const ui = mount({ local: true }); await ui.flush(); ui.metadata();
    const key = ui.find(n => n.type === 'video').props.key;
    ui.find(n => n.type === 'video').props.onEnded(); await ui.flush();
    assert.equal(ui.find(n => n.type === 'video').props.key, key, 'auto-next must not replace the fullscreen video element');
    assert.equal(ui.find(n => n.type === 'video').props.src, 'file:///mock-2.mp4');
    ui.metadata(); ui.error(3); await ui.flush();
    assert.equal(ui.find(n => n.type === 'video').props.key, key, 'compatibility source swap must not replace the fullscreen video element');
    assert.equal(ui.find(n => n.type === 'video').props.src, 'file:///mock-compat.mp4'); ui.unmount();
  });
  await test('fullscreen playback retains video and last source while the next online episode prepares', async () => {
    let finishNext;
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, prepare: p => p.vidIndex === 1 ? { success: true, url: 'hongguo-stream://one' } : new Promise(r => { finishNext = r; }) });
    await ui.flush(); ui.metadata();
    const first = ui.find(n => n.type === 'video'); first.props.onEnded(); await ui.flush();
    const preparing = ui.find(n => n.type === 'video');
    assert.ok(preparing, 'preparing the next episode must not unmount the fullscreen video');
    assert.equal(preparing.props.key, first.props.key); assert.equal(preparing.props.src, first.props.src, 'retain the ended frame until the next source is ready');
    finishNext({ success: true, url: 'hongguo-stream://two' }); await ui.flush();
    assert.equal(ui.find(n => n.type === 'video').props.key, first.props.key);
    assert.equal(ui.find(n => n.type === 'video').props.src, 'hongguo-stream://two'); ui.unmount();
  });
  await test('merge quality mode preserves the dialog on 1080P rejection and supports fallback modes', async () => {
    let resolveHigh;
    const calls = [];
    const ui = mount({
      local: true,
      apiOverrides: {
        mergeSeries: (...args) => {
          calls.push(args);
          if (args[2].require1080) return new Promise(resolve => { resolveHigh = resolve; });
          return Promise.resolve({ success: true, count: 2, totalBytes: 1000 });
        },
      },
    });
    await ui.flush();
    ui.button('合并导出全集').props.onClick(); ui.render();
    assert.match(ui.text(), /逐集检查实际文件，全部达到1080P才能开始/);
    assert.match(ui.text(), /优先无损拼接，保留每段原分辨率/);
    assert.match(ui.text(), /必要时转为H\.264\/AAC，仍保留每段原分辨率/);
    assert.match(ui.text(), /三种方式都保留原文件，只合并已下载分集/);
    const high = ui.button('高质量分辨率合并');
    const quick = ui.button('快速合并');
    assert.ok(high);
    high.props.onClick();
    quick.props.onClick();
    ui.render();
    assert.equal(calls.length, 1, 'rapid mode clicks must submit once');
    assert.equal(calls[0][0], 'A');
    assert.equal(calls[0][1], '');
    assert.equal(calls[0][2].compatible, false);
    assert.equal(calls[0][2].require1080, true);
    assert.deepEqual(Object.keys(calls[0][2]).sort(), ['compatible', 'require1080']);
    assert.equal(ui.button('高质量分辨率合并').props.disabled, true);
    assert.equal(ui.button('兼容合并（H.264）').props.disabled, true);
    assert.equal(ui.button('快速合并').props.disabled, true);
    resolveHigh({
      success: false,
      code: 'MERGE_1080_UNAVAILABLE',
      error: '第2集实际为720P，请选择快速合并或兼容合并',
    });
    await ui.flush();
    assert.ok(ui.button('高质量分辨率合并'), '1080P failure must keep the merge dialog open');
    assert.ok(ui.find(node => node.props.role === 'alert' && ui.text().includes('第2集实际为720P')), '1080P failure must be shown inline');
    await ui.button('快速合并').props.onClick();
    await ui.flush();
    assert.equal(ui.button('高质量分辨率合并'), undefined, 'successful merge must close the dialog');
    assert.equal(calls[1][2].compatible, false);
    assert.deepEqual(Object.keys(calls[1][2]), ['compatible']);
    ui.button('合并导出全集').props.onClick(); ui.render();
    assert.ok(!ui.text().includes('第2集实际为720P'), 'reopening must clear the old error');
    await ui.button('兼容合并（H.264）').props.onClick();
    await ui.flush();
    assert.equal(calls[2][2].compatible, true);
    assert.deepEqual(Object.keys(calls[2][2]), ['compatible']);
    assert.equal(ui.button('高质量分辨率合并'), undefined);

    ui.button('合并导出全集').props.onClick(); ui.render();
    ui.button('高质量分辨率合并').props.onClick(); ui.render();
    ui.button('取消').props.onClick(); ui.render();
    ui.button('提交中...').props.onClick(); ui.render();
    resolveHigh({
      success: false,
      code: 'MERGE_1080_UNAVAILABLE',
      error: '旧剧第2集实际为720P',
    });
    await ui.flush();
    assert.ok(ui.button('高质量分辨率合并'), 'late failure from a closed dialog must not close the new dialog');
    assert.ok(!ui.text().includes('旧剧第2集实际为720P'), 'late failure from a closed dialog must not leak into the new dialog');

    ui.button('高质量分辨率合并').props.onClick(); ui.render();
    ui.button('取消').props.onClick(); ui.render();
    ui.button('提交中...').props.onClick(); ui.render();
    resolveHigh({ success: true, count: 2, totalBytes: 1000 });
    await ui.flush();
    assert.ok(ui.button('高质量分辨率合并'), 'late success from a closed dialog must not close the new dialog');
    ui.unmount();
  });
  process.exitCode = failures ? 1 : 0;
})();
