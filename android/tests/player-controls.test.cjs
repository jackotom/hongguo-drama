const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('../../node_modules/esbuild');

const root = path.join(__dirname, '../..');
const code = transformSync(fs.readFileSync(path.join(root, 'src/components/PlayerControls.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
function mount(platform = 'android') {
  const slots = [], effects = [], cleanups = [], timers = new Map();
  let cursor = 0, dirty = false, tree, now = 0, timerId = 0;
  const emitter = extra => ({ ...extra, listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); },
  });
  const window = emitter({ electronAPI: { platform } });
  const document = emitter({ defaultView: window, activeElement: null, fullscreenElement: null });
  const video = emitter({ paused: false, ended: false, currentTime: 12, duration: 100, volume: 0, muted: true });
  const stage = emitter({ ownerDocument: document });
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; dirty ||= !Object.is(next, slots[i]); slots[i] = next; }]; },
    useRef(initial) { return slots[cursor++] ||= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((value, j) => value !== slots[i][j])) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const module = { exports: {} };
  const schedule = (fn, delay) => { timers.set(++timerId, { at: now + delay, fn }); return timerId; };
  const context = { module, exports: module.exports, window, document,
    Date: class extends Date { static now() { return now; } },
    setTimeout: schedule, clearTimeout: id => timers.delete(id), setInterval: schedule, clearInterval: id => timers.delete(id),
    require(name) {
      if (name === 'react') return react;
      if (name === './useDialogKeyboard') return { __esModule: true, default() {} };
      if (name === '../i18n') return { t: (text, values = []) => typeof text === 'string' ? text.replace(/\{(\d+)\}/g, (_, i) => values[i]) : text, useLanguage() {} };
      if (name === '../shortcuts') return { DEFAULT_SHORTCUTS: {}, SHORTCUT_ACTIONS: [], formatShortcut: () => '', ignoresPlaybackShortcut: () => false, shortcutKey: () => '' };
      if (name === '../playerDisplay.mjs') return { formatClock: () => '12:00', formatQualityMeta: () => '' };
      return {};
    },
  };
  vm.runInNewContext(code, context);
  const props = { videoRef: { current: video }, stageRef: { current: stage }, source: 'one', available: true, rate: 1, episodes: [{ vid_index: 1 }, { vid_index: 2 }], currentIndex: 1, onEpisodeChange() {} };
  const nodes = () => { const list = []; const walk = node => { if (!node || typeof node !== 'object') return; list.push(node); node.children?.forEach(walk); }; walk(tree); return list; };
  const render = () => { do { dirty = false; cursor = 0; tree = module.exports.default(props); for (const node of nodes()) if (node.props.ref) node.props.ref.current = { contains: target => target === node, focus() {}, querySelector: () => null }; effects.splice(0).forEach(fn => fn()); } while (dirty); };
  const emit = (target, name, event = {}) => { target.listeners.get(name)?.(event); render(); };
  render();
  return { window, document, stage, video, props, render, emit, nodes,
    find: label => nodes().find(node => node.props['aria-label'] === label),
    hidden: () => tree.props.className.includes('controls-hidden'),
    advance(ms) { const end = now + ms; for (;;) { const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); render(); } now = end; },
    unmount: () => cleanups.forEach(fn => fn?.()),
  };
}

test('手机点按立即显示控制层，滑动只恢复计时；桌面保留鼠标移动控制', () => {
  const ui = mount();
  ui.advance(2000); assert.equal(ui.hidden(), true);
  ui.emit(ui.stage, 'pointerdown', { target: ui.video });
  assert.equal(ui.hidden(), false, '点按必须立即显示控制层');
  ui.advance(2000); assert.equal(ui.hidden(), true);
  ui.emit(ui.stage, 'pointermove', { pointerType: 'touch', screenX: 100, screenY: 100, movementX: 50 });
  assert.equal(ui.hidden(), false, '滑动视频时恢复控制层');
  ui.advance(2000); assert.equal(ui.hidden(), true);
  ui.video.paused = true; ui.emit(ui.video, 'pause');
  assert.equal(ui.hidden(), false, '暂停时控制层保持显示');
  ui.unmount();
  const desktop = mount('darwin');
  desktop.emit(desktop.stage, 'pointermove', { screenX: 10, screenY: 10, movementX: 5 });
  assert.equal(desktop.hidden(), false);
  desktop.unmount();
});

test('拖动进度不隐藏，释放后恢复计时；手机菜单可明确关闭', () => {
  const ui = mount();
  ui.emit(ui.stage, 'pointerdown', { target: { closest: () => ({}) } });
  ui.advance(4000); assert.equal(ui.hidden(), false);
  ui.find('播放进度').props.onChange({ target: { value: '72.5' } });
  assert.equal(ui.video.currentTime, 72.5, '沿用原有进度跳转');
  ui.emit(ui.window, 'pointerup'); ui.advance(2000); assert.equal(ui.hidden(), true);
  ui.find('更多播放选项').props.onClick(); ui.render();
  assert.ok(ui.find('播放选项')); assert.equal(ui.hidden(), false);
  ui.find('更多播放选项').props.onClick(); ui.render(); assert.equal(ui.find('播放选项'), undefined);
  ui.find('选集').props.onClick(); ui.render(); assert.ok(ui.find('选集面板'));
  ui.find('选集').props.onClick(); ui.render(); assert.equal(ui.find('选集面板'), undefined);
  ui.unmount();
});

test('手机返回依次处理全屏、更多、选集、通用弹层和页面历史', () => {
  const source = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8');
  const body = source.match(/window\.appBack = \(\) => \{([\s\S]*?)\n    \};/)[1];
  let dialogs = true;
  const actions = [];
  const context = { moreOpen: false, episodesOpen: false,
    setMoreOpen: () => actions.push('more'), setEpisodesOpen: () => actions.push('episodes'),
    navigationHistory: { current: ['browse', 'player'] }, backNavigation: { current: false },
    navigate: page => actions.push(page), KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    document: { fullscreenElement: {}, querySelectorAll: () => dialogs ? [{ getClientRects: () => [1] }] : [], dispatchEvent: event => actions.push(event.key), exitFullscreen: () => { actions.push('fullscreen'); return Promise.resolve(); } },
  };
  const back = vm.runInNewContext(`() => {${body}}`, context);
  assert.equal(back(), true); assert.deepEqual(actions, ['fullscreen']);
  context.document.fullscreenElement = null;
  context.moreOpen = true; assert.equal(back(), true); assert.deepEqual(actions, ['fullscreen', 'more']);
  context.moreOpen = false; context.episodesOpen = true; assert.equal(back(), true);
  assert.deepEqual(actions, ['fullscreen', 'more', 'episodes']);
  context.episodesOpen = false; assert.equal(back(), true);
  assert.deepEqual(actions, ['fullscreen', 'more', 'episodes', 'Escape']);
  dialogs = false;
  assert.equal(back(), true); assert.equal(actions.at(-1), 'browse');
  assert.equal(back(), false);
});


test('手机播放器：倍速直选、父页面选集抽屉和更多菜单互斥', () => {
  const ui = mount();
  const selected = [];
  ui.props.currentIndex = 1;
  ui.props.onOpenEpisodes = () => selected.push(['episodes']);
  ui.props.onRateChange = value => selected.push(['rate', value]);
  ui.props.onQualityChange = value => selected.push(['quality', value]);
  ui.props.supportsOnlineQuality = true;
  ui.render();
  ui.find('选集').props.onClick(); ui.render();
  assert.deepEqual(selected.pop(), ['episodes']);
  ui.find('播放速度').props.onChange({ target: { value: '1.5' }, currentTarget: { blur() {} } }); ui.render();
  assert.deepEqual(selected.pop(), ['rate', 1.5]);
  ui.find('更多播放选项').props.onClick(); ui.render();
  assert.ok(ui.find('播放选项'));
  const qualityMenu = ui.nodes().find(node => node.type === 'button' && node.children?.[0] === '清晰度 · ');
  assert.ok(qualityMenu);
  qualityMenu.props.onClick(); ui.render();
  assert.equal(ui.find('播放选项'), undefined);
  assert.ok(ui.find('清晰度面板'));
  ui.find('选择 720P').props.onClick(); ui.render();
  assert.deepEqual(selected.pop(), ['quality', '720p']);
  assert.equal(ui.video.currentTime, 12, '抽屉不修改媒体进度');
  assert.equal(ui.video.paused, false, '抽屉不改变播放状态');
  ui.unmount();
});

test('手机拖动进度时不自动隐藏，松手后恢复计时', () => {
  const ui = mount();
  ui.emit(ui.stage, 'pointerdown', { target: { closest: () => ({}) } });
  ui.advance(4000); assert.equal(ui.hidden(), false);
  ui.find('播放进度').props.onChange({ target: { value: '72.5' } }); ui.render();
  assert.equal(ui.video.currentTime, 72.5);
  ui.emit(ui.video, 'timeupdate');
  assert.equal(ui.find('播放进度').props.value, 72.5);
  ui.emit(ui.window, 'pointerup');
  assert.equal(ui.find('播放进度').props.value, 72.5);
  ui.advance(2000); assert.equal(ui.hidden(), true);
  ui.unmount();
});
