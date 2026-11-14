import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as shortcuts from '../../shortcuts.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const realShortcuts = (bindings = {}) => ({
  ...shortcuts,
  readShortcuts: () => ({ ...shortcuts.DEFAULT_SHORTCUTS, speedStep: 1, ...bindings }),
  subscribeShortcuts: () => () => {},
});

function makeVideo() {
  const video = new EventTarget();
  video.paused = true;
  video.currentTime = 0;
  video.duration = NaN;
  video.readyState = 0;
  video.videoWidth = 0;
  video.videoHeight = 0;
  video.playbackRate = 1;
  video.defaultPlaybackRate = 1;
  video.volume = 1;
  video.muted = false;
  video.currentSrc = '';
  video.ended = false;
  video.error = null;
  video.srcObject = null;
  video.src = '';
  video.play = async () => { video.paused = false; video.dispatchEvent(new Event('play')); };
  video.pause = () => { if (!video.paused) { video.paused = true; video.dispatchEvent(new Event('pause')); } };
  video.load = () => {};
  video.removeAttribute = () => {};
  video.ownerDocument = { pictureInPictureElement: null, defaultView: { devicePixelRatio: 1 } };
  return video;
}

function playerApi(overrides = {}) {
  const base = {
    platform: 'darwin',
    getSeriesList: async () => [{ series_id: 's1', updatedAt: Date.now() }],
    getSeriesEpisodes: async () => ({ success: true, data: {
      series_id: 's1', series_title: '剧', total: 1, completedCount: 1,
      episodes: [{ vid: 'v1', vid_index: 1, status: 'completed', fileUrl: 'hongguo-local://f/token', locked: false }],
    } }),
    getPlaybackPosition: async () => null,
    getSettings: async () => ({}),
    savePlaybackPosition: async () => {},
    saveSettings: async () => ({ success: true }),
    ...overrides,
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) return undefined;
      return async () => undefined;
    },
  });
}

function mountPlayer(props, { api, softwareDecode = false, shortcuts } = {}) {
  let cursor = 0, tree;
  const stateSlots = [];
  const effectSlots = [];
  const callbackSlots = [];
  const memoSlots = [];
  const react = {
    createElement: (type, nodeProps, ...children) => ({ type, props: nodeProps || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const at = cursor++;
      if (!(at in stateSlots)) stateSlots[at] = typeof initial === 'function' ? initial() : initial;
      return [stateSlots[at], value => { stateSlots[at] = typeof value === 'function' ? value(stateSlots[at]) : value; }];
    },
    useRef(initial) { const at = cursor++; return stateSlots[at] ||= { current: initial }; },
    useCallback(fn, deps) {
      const at = cursor++, previous = callbackSlots[at];
      if (!previous || (deps || []).some((value, index) => value !== previous.deps[index])) {
        callbackSlots[at] = { fn, deps: deps || [] };
      }
      return callbackSlots[at].fn;
    },
    useMemo(fn, deps) {
      const at = cursor++, previous = memoSlots[at];
      if (!previous || (deps || []).some((value, index) => value !== previous.deps[index])) {
        memoSlots[at] = { value: fn(), deps: deps || [] };
      }
      return memoSlots[at].value;
    },
    useEffect(effect, deps) {
      const at = cursor++, previous = effectSlots[at];
      if (!previous || (deps || []).some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        effectSlots[at] = { deps: deps || [], cleanup: undefined };
        effectSlots[at].cleanup = effect();
      }
    },
  };
  react.useLayoutEffect = react.useEffect;

  const modules = {
    '../i18n': { t: value => value, useLanguage() {} },
    'react-dom': { createPortal: element => element },
    './useFloatingPlayer': () => ({ floating: false, toggle() {}, attachSlot: {} }),
    './useDialogKeyboard': () => {},
    './PlayerControls': 'PlayerControls',
    './SoftwareVideo': 'SoftwareVideo',
    './touchHoldSpeed.mjs': { bindTouchHoldSpeed: () => () => {} },
    './CommentDanmaku': { default: 'CommentDanmaku', useCommentDanmaku: () => ({}) },
    './OfficialDanmaku': { default: 'OfficialDanmaku', useOfficialDanmaku: () => ({}) },
    './danmakuSource.mjs': { useDanmakuSource: () => ({ sourceKind: 'off', setSource() {} }), writeDanmakuSource: () => {} },
    '../shortcuts': shortcuts || {
      SHORTCUT_ACTIONS: [], formatShortcut: () => '', ignoresPlaybackShortcut: () => false,
      readShortcuts: () => ({}), shortcutKey: () => '', subscribeShortcuts: () => () => {},
    },
    './CommunityPanel': 'CommunityPanel',
    './SequelFinder': 'SequelFinder',
    './NasDownload': 'NasDownload',
    './CastPanel': 'CastPanel',
    './VideoEnhancement': { default: 'VideoEnhancement', useVideoEnhancement: () => ({}) },
    './Player.css': {},
    './icons': Object.fromEntries(['Play', 'Film', 'Download', 'Check', 'RefreshCw', 'Layers', 'X', 'Trash2', 'ChevronDown', 'Zap'].map(name => [name, name])),
  };
  const module = { exports: {} };
  const source = transformSync(fs.readFileSync(new URL('../Player.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const windowMock = Object.assign(new EventTarget(), {
    electronAPI: api,
    localStorage: { getItem: key => (key === 'hongguo:software-decode' ? (softwareDecode ? 'true' : null) : null), setItem() {} },
  });
  const documentMock = {
    baseURI: 'file:///software/',
    querySelector: () => null,
    fullscreenElement: null,
    pictureInPictureElement: null,
    addEventListener() {}, removeEventListener() {},
  };
  const fullProps = { setEpisodesOpen: () => {}, onSeriesSelected: () => {}, onFloatingChange: () => {}, ...props };
  const context = {
    module, exports: module.exports,
    require(id) {
      if (id === 'react') return react;
      if (id in modules) return modules[id];
      throw new Error(`Unexpected import: ${id}`);
    },
    window: windowMock,
    document: documentMock,
    localStorage: windowMock.localStorage,
    setTimeout: (fn, ms, ...args) => { const timer = setTimeout(fn, ms, ...args); timer.unref?.(); return timer; },
    clearTimeout,
    setInterval: (fn, ms, ...args) => { const timer = setInterval(fn, ms, ...args); timer.unref?.(); return timer; },
    clearInterval, console,
    requestAnimationFrame: fn => { setTimeout(fn, 0); return 0; },
    cancelAnimationFrame: () => {},
    crypto,
  };
  vm.runInNewContext(source, context);

  const findAll = predicate => {
    const matches = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (predicate(node)) matches.push(node);
      node.children?.forEach(visit);
    };
    visit(tree);
    return matches;
  };
  const render = () => {
    cursor = 0;
    tree = module.exports.default(fullProps);
    const video = findAll(node => node.type === 'video')[0];
    const software = findAll(node => node.type === 'SoftwareVideo')[0];
    if (video?.props.ref) video.props.ref.current = video.props.ref.current || makeVideo();
    if (software?.props.videoRef) software.props.videoRef.current = software.props.videoRef.current || makeVideo();
  };
  const unmount = () => {
    for (const slot of effectSlots) {
      if (typeof slot?.cleanup === 'function') { try { slot.cleanup(); } catch {} }
    }
    effectSlots.length = 0;
  };
  render();
  render();
  return {
    render,
    unmount,
    find: predicate => findAll(predicate)[0],
    findAll,
    video: () => findAll(node => node.type === 'video')[0] || findAll(node => node.type === 'SoftwareVideo')[0],
    window: windowMock,
  };
}

function mountShortcutSettings(bindings) {
  let cursor = 0, tree;
  const stateSlots = [], refSlots = [], effectSlots = [];
  const react = {
    Fragment: Symbol.for('Fragment'),
    createElement: (type, nodeProps, ...children) => ({ type, props: nodeProps || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const at = cursor++;
      if (!(at in stateSlots)) stateSlots[at] = typeof initial === 'function' ? initial() : initial;
      return [stateSlots[at], value => { stateSlots[at] = typeof value === 'function' ? value(stateSlots[at]) : value; }];
    },
    useRef(initial) { const at = cursor++; return refSlots[at] ||= { current: initial }; },
    useEffect(effect, deps) {
      const at = cursor++, previous = effectSlots[at];
      if (!previous || (deps || []).some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        effectSlots[at] = { deps: deps || [], cleanup: effect() };
      }
    },
  };
  const module = { exports: {} };
  const source = transformSync(fs.readFileSync(new URL('../ShortcutSettings.jsx', import.meta.url), 'utf8'), {
    loader: 'jsx', format: 'cjs',
  }).code;
  const context = {
    module, exports: module.exports,
    require(id) {
      if (id === 'react') return react;
      if (id === '../i18n') return { t: value => value, useLanguage() {} };
      if (id === '../shortcuts') return realShortcuts(bindings);
      if (id === './BossKeySettings') return { default: 'BossKeySettings' };
      throw new Error(`Unexpected import: ${id}`);
    },
    window: Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem() {} } }),
    document: {},
    console,
  };
  vm.runInNewContext(source, context);
  cursor = 0;
  tree = module.exports.default({ active: true });
  const findAll = predicate => {
    const matches = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (predicate(node)) matches.push(node);
      node.children?.forEach(visit);
    };
    visit(tree);
    return matches;
  };
  return { find: predicate => findAll(predicate)[0] };
}

function mountSettings() {
  let cursor = 0, tree;
  let stored = { download_quality: 'auto', picture_in_picture_mode: 'custom', show_danmaku_controls: false };
  const stateSlots = [], refSlots = [], effectSlots = [];
  const react = {
    Fragment: Symbol.for('Fragment'),
    createElement: (type, nodeProps, ...children) => ({ type, props: nodeProps || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const at = cursor++;
      if (!(at in stateSlots)) stateSlots[at] = typeof initial === 'function' ? initial() : initial;
      return [stateSlots[at], value => { stateSlots[at] = typeof value === 'function' ? value(stateSlots[at]) : value; }];
    },
    useRef(initial) { const at = cursor++; return refSlots[at] ||= { current: initial }; },
    useEffect(effect, deps) {
      const at = cursor++, previous = effectSlots[at];
      if (!previous || (deps || []).some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        effectSlots[at] = { deps: deps || [], cleanup: effect() };
      }
    },
  };
  const windowMock = Object.assign(new EventTarget(), {
    electronAPI: {
      platform: 'darwin',
      getSettings: async () => ({ ...stored }),
      saveSettings: async patch => { stored = { ...stored, ...patch }; return { success: true }; },
    },
    localStorage: { getItem: () => null, setItem() {} },
  });
  const module = { exports: {} };
  const source = transformSync(fs.readFileSync(new URL('../Settings.jsx', import.meta.url), 'utf8'), {
    loader: 'jsx', format: 'cjs',
  }).code;
  const context = {
    module, exports: module.exports,
    require(id) {
      if (id === 'react') return react;
      if (id === '../i18n') return { t: value => value, useLanguage() {} };
      if (id === './danmakuSource.mjs') return { useDanmakuSource: () => 'official', writeDanmakuSource() {} };
      if (id === './useDialogKeyboard') return () => {};
      if (id === './Settings.css') return {};
      if (id === './icons') return Object.fromEntries(['Settings', 'Folder', 'Check', 'Globe', 'X', 'RefreshCw', 'AlertCircle'].map(name => [name, name]));
      if (/^\.\/(?:AppearanceSettings|ShortcutSettings|StealthWakeRegion\.jsx|CustomSources|BuiltinSources|AnnouncementSettings)$/.test(id)) {
        return { default: id.replace('./', '') };
      }
      throw new Error(`Unexpected import: ${id}`);
    },
    window: windowMock,
    document: {},
    CustomEvent,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(source, context);
  const findAll = predicate => {
    const matches = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (predicate(node)) matches.push(node);
      node.children?.forEach(visit);
    };
    visit(tree);
    return matches;
  };
  const render = () => {
    cursor = 0;
    tree = module.exports.default({ active: true });
  };
  render();
  return {
    window: windowMock,
    render,
    find: predicate => findAll(predicate)[0],
  };
}

const autoDeleteButton = page => page.find(node => node.type === 'button'
  && node.children?.some(child => child?.type === 'Trash2'));
const playerControls = page => page.find(node => node.type === 'PlayerControls');

test('a retained player syncs auto-delete and danmaku controls from a settings save', async () => {
  const api = playerApi();
  const page = mountPlayer({ active: false, target: { seriesId: 's1', vidIndex: 1, autoplay: true } }, { api });
  await tick(); await tick();
  page.render();
  const button = autoDeleteButton(page);
  assert.ok(button, 'player renders the auto-delete toggle');
  assert.equal(button.props['aria-pressed'], false);
  assert.equal(playerControls(page).props.danmaku, null);
  page.window.dispatchEvent(new CustomEvent('hongguo-playback-settings'));
  page.render();
  assert.equal(autoDeleteButton(page).props['aria-pressed'], false, 'an empty event keeps the current switch');
  assert.equal(playerControls(page).props.danmaku, null, 'an empty event keeps danmaku controls hidden');
  page.window.dispatchEvent(new CustomEvent('hongguo-playback-settings', {
    detail: { auto_delete_watched: true, show_danmaku_controls: true },
  }));
  page.render();
  assert.equal(autoDeleteButton(page).props['aria-pressed'], true, 'saved switch reaches an inactive player');
  assert.ok(playerControls(page).props.danmaku, 'saved danmaku setting reaches an inactive player');
  page.window.dispatchEvent(new CustomEvent('hongguo-playback-settings', {
    detail: { auto_delete_watched: false, show_danmaku_controls: false },
  }));
  page.render();
  assert.equal(autoDeleteButton(page).props['aria-pressed'], false, 'turning auto-delete off in settings disables it here');
  assert.equal(playerControls(page).props.danmaku, null, 'turning danmaku off in settings disables it here');
  page.unmount();
});

test('S/D use the real configured speed step for repeated keyboard changes', async () => {
  const page = mountPlayer({ active: true, target: { seriesId: 's1', vidIndex: 1, autoplay: true } }, {
    api: playerApi(), shortcuts: realShortcuts(),
  });
  await tick(); await tick();
  page.render();
  const media = page.video().props.ref.current;
  const key = (type, value) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, { key: { value }, code: { value: `Key${value.toUpperCase()}` }, repeat: { value: false } });
    page.window.dispatchEvent(event);
  };
  key('keydown', 'd');
  assert.equal(media.playbackRate, 2, 'one D press jumps from 1x to 2x');
  key('keydown', 's');
  assert.equal(media.playbackRate, 1, 'one S press returns from 2x to 1x');
  page.unmount();
});

test('the speed-step label follows the current slower and faster bindings', () => {
  const page = mountShortcutSettings({ slower: 'j', faster: 'k' });
  assert.ok(page.find(node => node.type === 'span' && node.children?.includes('J / K 倍速调节')));
});

test('saving playback settings dispatches the retained-player sync event', async () => {
  const page = mountSettings();
  const events = [];
  page.window.addEventListener('hongguo-playback-settings', event => events.push(event.detail));
  await tick();
  page.render();
  const danmaku = page.find(node => node.type === 'input' && node.props['aria-label'] === '显示弹幕按钮');
  assert.ok(danmaku);
  danmaku.props.onChange({ target: { checked: true } });
  page.render();
  const save = page.find(node => node.type === 'button' && node.props['aria-label'] === '保存当前设置');
  assert.ok(save);
  await save.props.onClick();
  assert.equal(events.length, 1);
  assert.equal(events[0].show_danmaku_controls, true);
});

test('software decode ends the buffering overlay on metadata and stays paused', async () => {
  const page = mountPlayer({ active: false, target: { seriesId: 's1', vidIndex: 1, autoplay: true } },
    { api: playerApi(), softwareDecode: true });
  await tick(); await tick();
  page.render();
  const node = page.video();
  assert.ok(node, 'software video element renders');
  const media = node.props.videoRef.current;
  node.props.onWaiting();
  page.render();
  assert.ok(page.find(n => n.type === 'p' && n.children?.some(c => c === '正在加载视频…')),
    'waiting shows the buffering overlay');
  node.props.onLoadedMetadata({ currentTarget: media });
  page.render();
  assert.equal(page.find(n => n.type === 'p' && n.children?.some(c => c === '正在加载视频…')),
    undefined, 'metadata clears the buffering overlay');
  assert.equal(media.paused, true, 'a paused software decode is not resumed by metadata');
  page.unmount();
});

test('a saved decoder position is not overwritten by the parent cleanup after destroy', async () => {
  const saved = [];
  const page = mountPlayer({ active: true, target: { seriesId: 's1', vidIndex: 1, autoplay: true } },
    { api: playerApi({ savePlaybackPosition: async (seriesId, vidIndex, seconds) => { saved.push(seconds); } }), softwareDecode: true });
  await tick(); await tick();
  page.render();
  const node = page.video();
  assert.ok(node);
  const media = node.props.videoRef.current;
  media.currentTime = 37.25;
  node.props.onLoadedMetadata({ currentTarget: media });
  node.props.onPlaying({ currentTarget: media });
  node.props.onBeforeDestroy();
  media.__softwareDestroyed = true;
  media.currentTime = 0;
  page.unmount();
  assert.ok(saved.length > 0, 'a position was persisted before unmount');
  assert.ok(saved.every(seconds => seconds === 37.25), `only the logical position is saved, got ${JSON.stringify(saved)}`);
});
