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

test('手机轻触切换控制层，长按和滑动不抢走视频手势；桌面保持原样', () => {
  const ui = mount();
  ui.advance(2000); assert.equal(ui.hidden(), true);
  ui.emit(ui.stage, 'pointerdown', { target: ui.video });
  assert.equal(ui.hidden(), true, '按下不立刻改变控制层，留给长按识别');
  ui.emit(ui.stage, 'click', { target: ui.video, detail: 1 });
  assert.equal(ui.hidden(), false);
  ui.emit(ui.stage, 'pointerdown', { target: ui.video });
  ui.emit(ui.stage, 'click', { target: ui.video, detail: 1 });
  assert.equal(ui.hidden(), true, '再次轻触立即收起');
  ui.emit(ui.stage, 'pointermove', { pointerType: 'touch', screenX: 100, screenY: 100, movementX: 50 });
  assert.equal(ui.hidden(), true, '滑动不显示控件');
  ui.video.paused = true; ui.emit(ui.video, 'pause');
  ui.emit(ui.stage, 'click', { target: ui.video, detail: 1 });
  assert.equal(ui.hidden(), false, '暂停时播放按钮保持可用');
  ui.unmount();
  const desktop = mount('darwin');
  assert.equal(desktop.stage.listeners.has('click'), false, '不接管桌面视频单击');
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
  ui.find('关闭').props.onClick(); ui.render(); assert.equal(ui.find('播放选项'), undefined);
  ui.find('选集').props.onClick(); ui.render(); assert.ok(ui.find('选集面板'));
  ui.find('关闭选集').props.onClick(); ui.render(); assert.equal(ui.find('选集面板'), undefined);
  ui.unmount();
});

test('手机返回优先关闭弹层，再退出全屏，最后回上一页', () => {
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
  assert.equal(back(), true); assert.deepEqual(actions, ['Escape']);
  dialogs = false; assert.equal(back(), true); assert.deepEqual(actions, ['Escape', 'fullscreen']);
  context.document.fullscreenElement = null;
  assert.equal(back(), true); assert.equal(actions.at(-1), 'browse');
  assert.equal(back(), false);
});


test('沉浸播放器：20集分页、真实状态、抽屉互斥及已有回调', () => {
  const ui = mount();
  const selected = [];
  ui.props.currentIndex = 41;
  ui.props.episodes = Array.from({ length: 49 }, (_, index) => ({ vid_index: index + 1, locked: index === 41, status: index === 42 ? 'completed' : 'pending' }));
  ui.props.onEpisodeChange = value => selected.push(['episode', value]);
  ui.props.onRateChange = value => selected.push(['rate', value]);
  ui.props.onQualityChange = value => selected.push(['quality', value]);
  ui.props.onBack = () => selected.push(['back']);
  ui.props.onCloseEpisodes = () => { ui.props.episodesOpen = false; };
  ui.props.supportsOnlineQuality = true;
  ui.render();
  ui.find('选集').props.onClick(); ui.render();
  assert.equal(ui.find('第 41 至 49 集').props['aria-pressed'], true);
  assert.equal(ui.find('播放第 41 集').props['aria-current'], 'true');
  assert.equal(ui.find('播放第 42 集').props.disabled, true);
  assert.equal(ui.find('播放第 1 集'), undefined, '只显示当前20集区间');
  assert.ok(ui.find('播放第 43 集').children.some(node => node?.children?.includes('已下载')));
  ui.find('第 1 至 20 集').props.onClick(); ui.render();
  assert.ok(ui.find('播放第 1 集')); assert.equal(ui.find('播放第 21 集'), undefined);
  ui.find('播放第 2 集').props.onClick(); ui.render();
  assert.deepEqual(selected.pop(), ['episode', 2]); assert.equal(ui.find('选集面板'), undefined);
  ui.find('播放速度').props.onClick(); ui.render();
  assert.equal(ui.nodes().filter(node => node.props.role === 'dialog').length, 1);
  ui.find('播放速度 1.5×').props.onClick(); ui.render();
  assert.deepEqual(selected.pop(), ['rate', 1.5]); assert.equal(ui.nodes().filter(node => node.props.role === 'dialog').length, 0);
  ui.find('清晰度').props.onClick(); ui.render();
  ui.nodes().find(node => node.type === 'button' && node.children.some(child => child?.children?.includes('720P'))).props.onClick(); ui.render();
  assert.deepEqual(selected.pop(), ['quality', '720p']);
  ui.find('返回上一页').props.onClick(); assert.deepEqual(selected.pop(), ['back']);
  ui.props.episodesOpen = true; ui.render();
  assert.ok(ui.find('选集面板'));
  assert.equal(ui.props.episodesOpen, false, '父页面打开选集的请求已被抽屉接管，返回不会多一层');
  ui.find('关闭选集').props.onClick(); ui.render();
  assert.equal(ui.find('选集面板'), undefined);
  assert.equal(ui.video.currentTime, 12, '抽屉不修改媒体进度');
  assert.equal(ui.video.paused, false, '抽屉不改变播放状态');
  ui.unmount();
});

test('手机拖动显示目标时间，松手与取消后不跳回旧显示值', () => {
  const ui = mount();
  ui.find('播放进度').props.onPointerDown({ currentTarget: { value: '12' } }); ui.render();
  ui.find('播放进度').props.onChange({ target: { value: '72.5' } }); ui.render();
  assert.equal(ui.find('播放进度').props.value, 72.5);
  assert.ok(ui.nodes().some(node => node.type === 'output' && node.children.includes('1:12')));
  ui.find('播放进度').props.onPointerUp(); ui.render();
  assert.equal(ui.find('播放进度').props.value, 72.5);
  assert.equal(ui.nodes().some(node => node.type === 'output'), false);
  ui.find('播放进度').props.onPointerDown({ currentTarget: { value: '72.5' } }); ui.render();
  ui.find('播放进度').props.onPointerCancel(); ui.render();
  assert.equal(ui.find('播放进度').props.value, 72.5);
  ui.unmount();
});
