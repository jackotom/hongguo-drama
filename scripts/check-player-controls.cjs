const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const videoEnhancementStub = {
  __esModule: true, default: () => null, VideoEnhancementControls: () => null,
  useVideoEnhancement: () => ({ mode: 'original', strength: 50, update() {}, status: {}, setStatus() {} }),
};
const shortcutModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/shortcuts.js'), 'utf8'), { loader: 'js', format: 'cjs' }).code, { module: shortcutModule, exports: shortcutModule.exports });
const displayModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/playerDisplay.mjs'), 'utf8'), { loader: 'js', format: 'cjs' }).code, { module: displayModule, exports: displayModule.exports });
const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/components/PlayerControls.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;

(async () => {
  const slots = [], effects = [], cleanups = [], listeners = new Map(), documentListeners = new Map(), stageListeners = new Map(), windowListeners = new Map(), popupDocumentListeners = new Map(), popupWindowListeners = new Map(), timers = new Map();
  let nextTimer = 0, keyboardFocus = false, now = 0, blurs = 0;
  class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const advance = (milliseconds = 1000) => {
    const until = now + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = until;
  };
  let needsRender = false;
  let cursor = 0, tree, plays = 0, pauses = 0, fullscreenCalls = 0, selectedRate, floatingCalls = 0, floatingError = '', activeStageDocument = null;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(slots[i], next)) needsRender = true; slots[i] = next; }]; },
    useRef: value => { const i = cursor++; return slots[i] ||= { current: value }; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => v !== slots[i][j])) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const media = { paused: true, ended: false, currentTime: 12, duration: 100, muted: false, volume: 0.7,
    play: async () => { plays++; media.paused = false; listeners.get('play')?.(); },
    pause: () => { pauses++; media.paused = true; listeners.get('pause')?.(); },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const document = { activeElement: null, fullscreenElement: null, addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: (name, fn) => { if (documentListeners.get(name) === fn) documentListeners.delete(name); }, exitFullscreen: async () => { document.fullscreenElement = null; documentListeners.get('fullscreenchange')?.(); } };
  const popupDocument = { activeElement: null, fullscreenElement: null, addEventListener: (name, fn) => popupDocumentListeners.set(name, fn), removeEventListener: (name, fn) => { if (popupDocumentListeners.get(name) === fn) popupDocumentListeners.delete(name); }, exitFullscreen: async () => { popupDocument.fullscreenElement = null; popupDocumentListeners.get('fullscreenchange')?.(); } };
  const stage = { get ownerDocument() { return activeStageDocument; }, addEventListener: (name, fn) => stageListeners.set(name, fn), removeEventListener: name => stageListeners.delete(name), requestFullscreen: async () => { fullscreenCalls++; document.fullscreenElement = stage; documentListeners.get('fullscreenchange')?.(); } };
  const popupWindow = { addEventListener: (name, fn) => popupWindowListeners.set(name, fn), removeEventListener: (name, fn) => { if (popupWindowListeners.get(name) === fn) popupWindowListeners.delete(name); } };
  popupDocument.defaultView = popupWindow;
  const props = { videoRef: { current: media }, stageRef: { current: stage }, source: 'one', available: true, floating: false, rate: 1, onRateChange: rate => { selectedRate = rate; }, onError: message => { floatingError = message; } };
  props.onToggleFloating = async () => {
    floatingCalls++;
    props.floating = !props.floating;
    activeStageDocument = props.floating ? popupDocument : null;
  };
  props.onWindowFill = value => { props.windowFill = value; };
  props.onToggleFullscreen = async () => {
    if (props.portrait) props.onWindowFill(!props.windowFill);
    else if (document.fullscreenElement === stage) await document.exitFullscreen();
    else await stage.requestFullscreen();
  };
  const context = { module: { exports: {} }, document, Date: TestDate, window: { addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name) }, setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; }, clearTimeout: id => timers.delete(id), setInterval: (fn, delay) => { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; }, clearInterval: id => timers.delete(id), require: name => name === 'react' ? react : name === '../shortcuts' ? shortcutModule.exports : name === '../playerDisplay.mjs' ? displayModule.exports : name === './VideoEnhancement' ? videoEnhancementStub : {} };
  context.exports = context.module.exports; vm.runInNewContext(source, context);
  const nodes = () => { const out = []; const visit = node => { if (!node || typeof node !== 'object') return; out.push(node); node.children?.forEach(visit); }; visit(tree); return out; };
  const find = label => nodes().find(node => node.props['aria-label'] === label);
  const contains = (node, target) => node === target || !!node?.children?.some(child => contains(child, target));
  const render = () => { do { needsRender = false; cursor = 0; tree = context.module.exports.default(props); for (const node of nodes()) if (node.props.ref) node.props.ref.current = { contains: target => contains(node, target), focus() {}, querySelector: () => keyboardFocus ? {} : null }; effects.splice(0).forEach(fn => fn()); } while (needsRender); };
  render(); render();
  props.shortcuts = { ...shortcutModule.exports.DEFAULT_SHORTCUTS, play: 'shift+j', fullscreen: 'g' }; render();
  assert.equal(find('播放').props.title, '播放/暂停（Shift + J）');
  assert.equal(find('全屏').props.title, '全屏（G）');
  props.shortcuts = shortcutModule.exports.DEFAULT_SHORTCUTS; render();
  assert.equal(find('播放进度').props.max, 100); assert.equal(find('播放进度').props.value, 12);
  await find('播放').props.onClick(); render(); assert.equal(plays, 1); assert.ok(find('暂停'));
  find('暂停').props.onClick(); render(); assert.equal(pauses, 1);
  assert.equal(find('画中画').props['aria-pressed'], false);
  assert.match(find('画中画').props.title, /系统原生或应用自带/);
  await find('画中画').props.onClick(); render();
  assert.equal(floatingCalls, 1, 'floating control must delegate to its owner');
  assert.equal(find('退出画中画').props['aria-pressed'], true);
  assert.equal(find('退出画中画').props.title, '返回主窗口');
  assert.equal(windowListeners.has('keydown'), false, 'floating player releases main-window keyboard listeners');
  assert.ok(popupWindowListeners.has('keydown'), 'floating player listens for keyboard input in its own window');
  assert.equal(documentListeners.has('fullscreenchange'), false, 'floating player leaves main-document fullscreen events');
  assert.ok(popupDocumentListeners.has('fullscreenchange'), 'floating player follows fullscreen events in its own document');
  props.source = 'one-source-change'; render();
  assert.equal(floatingCalls, 1, 'source changes and auto-next must not close the custom floating window');
  assert.equal(find('退出画中画').props['aria-pressed'], true);
  await find('退出画中画').props.onClick(); render();
  assert.equal(floatingCalls, 2, 'floating control must request returning to the main window');
  assert.equal(find('画中画').props['aria-pressed'], false);
  assert.equal(find('画中画').props.title, '画中画：在设置中选择系统原生或应用自带小窗');
  assert.ok(windowListeners.has('keydown'), 'returning to the main window restores its keyboard listeners');
  assert.equal(popupWindowListeners.has('keydown'), false, 'returning to the main window releases floating-window listeners');
  assert.ok(documentListeners.has('fullscreenchange'), 'returning to the main window restores main-document fullscreen events');
  assert.equal(popupDocumentListeners.has('fullscreenchange'), false, 'returning to the main window releases floating-document fullscreen events');
  props.onToggleFloating = async () => { throw new Error('悬浮窗打开失败'); };
  render();
  await find('画中画').props.onClick(); render();
  assert.equal(floatingError, '悬浮窗打开失败', 'floating callback errors reach onError');
  props.onToggleFloating = async () => { props.floating = !props.floating; };
  find('播放进度').props.onChange({ target: { value: '37.5' } }); assert.equal(media.currentTime, 37.5);
  find('静音').props.onClick(); listeners.get('volumechange')?.(); render(); assert.equal(media.muted, true); assert.ok(find('取消静音'));
  find('音量').props.onChange({ target: { value: '0.4' } }); assert.equal(media.volume, 0.4); assert.equal(media.muted, false);
  assert.equal(find('播放速度'), undefined, 'speed belongs in the lower-right menu');
  assert.ok(find('增加播放速度'), 'speed number must be an independent button');
  find('增加播放速度').props.onClick(); render(); assert.equal(selectedRate, 1.25); assert.equal(find('播放速度'), undefined);
  props.rate = 3.75; render(); find('增加播放速度').props.onClick(); assert.equal(selectedRate, 4);
  props.rate = 4; render(); find('增加播放速度').props.onClick(); assert.equal(selectedRate, 1);
  find('更多播放选项').props.onClick(); render(); assert.ok(find('播放速度'));
  assert.deepEqual(find('播放速度').children.map(node => node.props.value), Array.from({ length: 16 }, (_, i) => (i + 1) / 4));
  find('播放速度').props.onChange({ target: { value: '4' } }); assert.equal(selectedRate, 4);
  documentListeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); render(); assert.equal(find('播放速度'), undefined);
  find('更多播放选项').props.onClick(); render(); documentListeners.get('pointerdown')({ target: {} }); render(); assert.equal(find('播放速度'), undefined);
  await find('全屏').props.onClick(); render(); assert.equal(fullscreenCalls, 1); assert.ok(find('退出全屏'));
  props.seriesTitle = '测试剧'; props.currentIndex = 1;
  props.episodes = [{ vid_index: 1 }, { vid_index: 2 }, { vid_index: 3, locked: true }];
  props.onEpisodeChange = index => { props.currentIndex = index; props.source = `episode-${index}`; };
  props.onlineQuality = 'auto'; props.supportsOnlineQuality = true;
  props.onQualityChange = quality => { props.onlineQuality = quality; };
  media.videoWidth = 640; media.videoHeight = 360; listeners.get('loadedmetadata')(); render();
  const nodeText = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(nodeText).join('') || '';
  assert.match(nodeText(find('当前播放信息')), /测试剧.*第 1 集/, 'fullscreen title includes series and episode');
  assert.match(nodeText(find('当前播放信息')), /当前画面 360P（640 × 360）/, 'fullscreen title shows the actual picture size');
  assert.ok(nodes().some(node => node.type === 'time' && /^当前时间 \d{2}:\d{2}$/.test(node.props['aria-label'] || '')), 'fullscreen status bar shows the current time');
  find('选集').props.onClick(); render();
  assert.ok(find('选集面板')); assert.equal(find('播放第 1 集').props['aria-current'], 'true');
  assert.equal(find('播放第 3 集').props.disabled, true);
  advance(); render(); assert.ok(!tree.props.className.includes('controls-hidden'), 'episode grid stays visible');
  find('播放第 2 集').props.onClick(); render();
  assert.equal(props.currentIndex, 2); assert.equal(find('选集面板'), undefined);
  assert.equal(document.fullscreenElement, stage, 'episode selection preserves fullscreen node');
  assert.match(nodeText(find('当前播放信息')), /第 2 集/);
  find('清晰度').props.onClick(); render();
  assert.match(nodeText(find('清晰度面板')), /360P.*640.*360/);
  assert.match(nodeText(find('清晰度面板')), /自动.*1080P.*720P.*兼容片源/);
  assert.match(nodeText(find('清晰度面板')), /手动720P \/ 1080P保持固定画质/);
  find('选择 1080P').props.onClick(); render(); assert.equal(props.onlineQuality, '1080p');
  find('清晰度').props.onClick(); render();
  assert.equal(find('选择 1080P').props['aria-pressed'], true);
  find('选集').props.onClick(); render(); assert.equal(find('清晰度面板'), undefined);
  documentListeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); render();
  assert.equal(find('选集面板'), undefined);
  find('清晰度').props.onClick(); render();
  documentListeners.get('pointerdown')({ target: {} }); render(); assert.equal(find('清晰度面板'), undefined);
  props.supportsOnlineQuality = false; props.onlineQuality = 'auto'; render();
  find('清晰度').props.onClick(); render(); assert.equal(find('选择 1080P'), undefined);
  assert.match(nodeText(find('清晰度面板')), /由片源决定/);
  find('更多播放选项').props.onClick(); render(); assert.equal(find('清晰度面板'), undefined);
  documentListeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); render();
  props.supportsOnlineQuality = true; render();
  await find('播放').props.onClick(); render(); advance(); render();
  const hidden = () => tree.props.className.includes('controls-hidden');
  let pointerX = 100;
  const movePointer = (delta = 1) => { pointerX += delta; stageListeners.get('pointermove')({ screenX: pointerX, screenY: 100, movementX: delta, movementY: 0 }); render(); };
  assert.ok(hidden(), 'playing in landscape fullscreen must hide idle controls');
  const keyTarget = { closest: () => null };
  const keyboard = (type, key, extra = {}) => {
    const event = { type, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, target: keyTarget, defaultPrevented: false, ...extra };
    windowListeners.get(type)?.(event); render();
  };
  for (const change of ['fullscreen', 'source', 'continuing']) {
    movePointer(); advance(900); render();
    if (change === 'fullscreen') await props.onToggleFullscreen();
    else if (change === 'source') props.source += '-idle';
    else props.continuing = true;
    render(); advance(99); render(); assert.ok(!hidden(), `${change}: one second has not elapsed`);
    advance(1); render(); assert.ok(hidden(), `${change}: passive effect rebuild must retain the pointer idle deadline`);
    if (change === 'fullscreen') await props.onToggleFullscreen();
    else if (change === 'continuing') props.continuing = false;
    render();
  }
  movePointer();
  document.activeElement = find('退出全屏');
  document.activeElement.blur = () => { blurs++; document.activeElement = null; };
  advance(); render();
  assert.equal(document.activeElement, null, 'auto-hide clears pointer focus left on fullscreen');
  assert.equal(blurs, 1);
  for (const portrait of [false, true]) {
    props.portrait = portrait; props.windowFill = portrait; render();
    for (const custom of [false, true]) {
      props.shortcuts = { ...shortcutModule.exports.DEFAULT_SHORTCUTS, ...(custom ? { backward: 'shift+h', forward: 'shift+l' } : {}) }; render();
      for (const key of custom ? ['h', 'l'] : ['ArrowLeft', 'ArrowRight']) {
        for (const defaultPrevented of [false, true]) {
          advance(); render(); assert.ok(hidden());
          keyboard('keydown', key, { shiftKey: custom, defaultPrevented });
          assert.ok(hidden(), `${key} seek keydown must preserve hidden controls`);
          keyboard('keydown', key, { shiftKey: custom, defaultPrevented, repeat: true });
          assert.ok(hidden(), `${key} held seek must preserve hidden controls`);
          listeners.get('timeupdate')(); render();
          movePointer(0); stageListeners.get('focusin')({ target: media }); render();
          assert.ok(hidden(), 'seek timeupdate/stationary pointer/video focus must preserve hidden controls');
          if (custom) keyboard('keyup', 'Shift');
          keyboard('keyup', key, { shiftKey: false, defaultPrevented });
          advance(3000); render();
          assert.ok(hidden(), `${key} seek release must stay hidden after Shift release`);
          movePointer(); assert.ok(!hidden(), 'real pointer movement reveals controls after seek');
          advance(900); render();
          keyboard('keydown', key, { shiftKey: custom }); keyboard('keyup', key, { shiftKey: custom });
          assert.ok(!hidden(), 'playback keys preserve the currently visible bar');
          advance(99); render(); assert.ok(!hidden(), 'pointer idle has not yet reached one second');
          advance(1); render(); assert.ok(hidden(), 'bar hides exactly one second after pointer movement, even after keyboard seeks');
          for (let repeat = 0; repeat < 6; repeat++) {
            keyboard('keydown', key, { shiftKey: custom, defaultPrevented, repeat: true });
            advance(100); render(); assert.ok(hidden(), 'held seek must not wake the bar or pointer');
          }
          if (custom) keyboard('keyup', 'Shift');
          keyboard('keyup', key, { shiftKey: false, defaultPrevented });
        }
      }
    }
  }
  for (const custom of [false, true]) {
    props.shortcuts = { ...shortcutModule.exports.DEFAULT_SHORTCUTS, ...(custom ? { faster: 'shift+q', slower: 'shift+w', autoNext: 'shift+e', fullscreen: 'shift+r' } : {}) }; render();
    for (const key of custom ? ['q', 'w', 'e', 'r'] : ['d', 's', 'a', 'f']) {
      for (const defaultPrevented of [false, true]) {
        advance(); render(); assert.ok(hidden());
        keyboard('keydown', key, { shiftKey: custom, defaultPrevented });
        keyboard('keydown', key, { shiftKey: custom, defaultPrevented, repeat: true });
        listeners.get('ratechange')?.(); listeners.get('volumechange')?.(); render();
        assert.ok(hidden(), `${key}: speed, volume and playback actions must not reveal hidden controls`);
        if (custom) keyboard('keyup', 'Shift');
        keyboard('keyup', key, { shiftKey: false, defaultPrevented });
        assert.ok(hidden(), `${key}: releasing a playback action must not reveal controls`);
        movePointer(); advance(900); render(); keyboard('keydown', key, { shiftKey: custom });
        keyboard('keyup', key, { shiftKey: custom }); advance(100); render();
        assert.ok(hidden(), `${key}: keyboard-only activity must not extend pointer idle`);
      }
    }
  }
  props.portrait = false; props.windowFill = false; render(); advance(); render();
  for (const custom of [false, true]) {
    props.shortcuts = { ...shortcutModule.exports.DEFAULT_SHORTCUTS, ...(custom ? { previous: 'shift+j', next: 'shift+k' } : {}) }; render();
    for (const key of custom ? ['j', 'k'] : ['ArrowUp', 'ArrowDown']) {
      for (const defaultPrevented of [false, true]) {
        advance(); render(); assert.ok(hidden());
        keyboard('keydown', key, { shiftKey: custom, defaultPrevented });
        assert.ok(hidden(), `${key} keydown preserves hidden controls regardless of parent listener order`);
        keyboard('keydown', key, { shiftKey: custom, repeat: true, defaultPrevented });
        assert.ok(hidden(), `${key} repeat must not reveal controls`);
        props.continuing = true; props.available = false; media.pause(); render();
        assert.ok(hidden(), `${key} reset and preparation preserve hidden controls`);
        if (custom) keyboard('keyup', 'Shift');
        keyboard('keyup', key, { shiftKey: false, defaultPrevented });
        assert.ok(hidden(), `${key} keyup preserves hidden controls even after Shift is released`);
        props.source += '-keyboard'; props.available = true; listeners.get('emptied')?.(); render();
        assert.ok(hidden(), `${key} source replacement preserves hidden controls`);
        listeners.get('loadedmetadata')?.(); render();
        assert.ok(hidden(), `${key} metadata preserves hidden controls before playing`);
        await media.play(); props.continuing = false; render();
        assert.ok(hidden(), `${key} playing preserves hidden controls`);
        keyboard('keydown', key, { shiftKey: custom, defaultPrevented });
        props.continuing = true; props.available = false; media.pause(); render();
        props.source += '-held'; props.available = true; render();
        await media.play(); props.continuing = false; render();
        keyboard('keyup', key, { shiftKey: custom, defaultPrevented });
        if (custom) keyboard('keyup', 'Shift');
        assert.ok(hidden(), `${key} release after playing and later Shift release preserve hidden controls`);
      }
    }
  }
  props.shortcuts = shortcutModule.exports.DEFAULT_SHORTCUTS; render();
  movePointer();
  keyboard('keydown', 'ArrowDown'); keyboard('keyup', 'ArrowDown');
  assert.ok(!hidden(), 'visible controls remain visible after an episode shortcut');
  advance(); render();
  keyboard('keydown', 'ArrowDown', { target: { closest: query => query.includes('[data-player-menu]') ? {} : null } });
  assert.ok(hidden(), 'keys owned by other menus must not reveal playback controls');
  advance(); render();
  keyboard('keydown', 'ArrowDown', { ctrlKey: true });
  assert.ok(hidden(), 'modified system keys must not disturb viewing');
  for (const key of ['x', 'Escape', 'AudioVolumeUp', 'AudioVolumeDown']) { keyboard('keydown', key); keyboard('keyup', key); assert.ok(hidden(), `${key}: unrelated keys stay quiet`); }
  keyboard('keydown', 'Tab'); assert.ok(!hidden(), 'Tab reveals controls for keyboard access');
  advance(); render();
  keyboard('keydown', ' '); media.pause(); render();
  assert.ok(!hidden(), 'intentional keyboard pause reveals controls');
  await media.play(); render(); advance(); render();
  keyboard('keydown', 'ArrowDown'); props.continuing = true; props.available = false; media.pause(); render();
  props.continuing = false; render();
  assert.ok(!hidden(), 'failed shortcut preparation restores controls');
  props.available = true; await media.play(); render(); advance(); render();
  keyboard('keyup', 'ArrowDown');

  // Replay previous -> playback -> natural end -> automatic next, including native event churn.
  props.autoContinue = true; render(); movePointer(); advance(); render();
  keyboard('keydown', 'ArrowUp');
  props.continuing = true; props.available = false; media.pause(); render();
  keyboard('keyup', 'ArrowUp');
  movePointer(0);
  assert.ok(hidden(), 'stationary pointer events during previous-episode handoff must not reveal controls');
  stageListeners.get('focusin')({ target: media }); stageListeners.get('focusout')({ target: media }); render();
  assert.ok(hidden(), 'video focus churn during previous-episode handoff must preserve hidden controls');
  props.source = 'previous-after-up'; props.available = true; media.ended = false;
  listeners.get('emptied')?.(); listeners.get('loadedmetadata')?.(); render();
  await media.play(); props.continuing = false; render();
  keyboard('keyup', 'ArrowUp'); stageListeners.get('focusin')({ target: media }); render();
  assert.ok(hidden(), 'previous episode starts with controls hidden');
  media.pause(); render(); advance(60); render();
  assert.ok(hidden(), 'pause arriving just before ended must not flash controls');
  media.ended = true; listeners.get('ended')?.(); render();
  props.continuing = true; props.available = false; render();
  movePointer(0); stageListeners.get('focusin')({ target: media }); render();
  props.source = 'next-after-previous'; props.available = true; media.ended = false;
  listeners.get('emptied')?.(); listeners.get('loadedmetadata')?.(); render();
  await media.play(); props.continuing = false; render(); advance(200); render();
  assert.ok(hidden(), 'automatic next after previous preserves hidden controls and cancels delayed pause reveal');
  movePointer(); assert.ok(!hidden(), 'real pointer movement still reveals controls'); advance(); render();
  props.continuing = true; render(); movePointer();
  assert.ok(!hidden(), 'real pointer movement during a handoff still reveals controls'); advance(); render();
  stageListeners.get('pointerdown')({ target: media }); render();
  assert.ok(!hidden(), 'clicking the video during a handoff reveals controls'); advance(); render();
  keyboardFocus = true; keyboard('keydown', 'Tab');
  stageListeners.get('focusin')({ target: find('暂停') }); render(); advance(); render();
  assert.ok(!hidden(), 'Tab focus on a control stays visible throughout a handoff');
  keyboardFocus = false; props.continuing = false; render(); advance(); render();
  stageListeners.get('focusin')({ target: find('暂停') }); render();
  assert.ok(!hidden(), 'programmatic focus on a control remains accessible'); advance(); render();
  keyboard('keydown', ' '); media.pause(); render();
  assert.ok(!hidden(), 'intentional keyboard pause is immediately visible even with auto-next');
  await media.play(); render(); advance(); render(); media.pause(); render();
  stageListeners.get('focusin')({ target: media }); stageListeners.get('focusout')({ target: media }); render();
  advance(200); render();
  assert.ok(!hidden(), 'persistent external pause reveals controls after the short event-settling delay');
  await media.play(); render(); advance(); render();

  props.autoContinue = true; render();
  media.ended = true; media.pause(); render();
  assert.ok(hidden(), 'end-of-episode pause before ended must not reveal controls when auto-next is available');
  props.continuing = true; props.autoContinue = false; props.available = false; render();
  assert.ok(hidden(), 'online preparation must retain hidden controls, including transition into the final episode');
  props.source = 'two'; props.available = true; media.ended = false;
  listeners.get('emptied')?.(); render();
  assert.ok(hidden(), 'loading the next source must not reveal controls');
  listeners.get('loadedmetadata')?.(); render();
  assert.ok(hidden(), 'metadata while paused must not reveal controls during auto-next');
  await media.play(); props.continuing = false; render();
  assert.ok(hidden(), 'starting the next episode must retain hidden controls');
  movePointer(); assert.ok(!hidden(), 'moving the pointer reveals controls');
  advance(); render(); assert.ok(hidden());
  media.ended = true; media.pause(); render();
  assert.ok(!hidden(), 'last episode or disabled auto-next restores controls at the end');
  media.ended = false; await media.play(); render(); advance(); render();
  media.pause(); render(); assert.ok(!hidden(), 'pausing keeps controls visible');
  await media.play(); render();
  find('更多播放选项').props.onClick(); render(); advance(); render(); assert.ok(!hidden(), 'open menu prevents hiding');
  find('更多播放选项').props.onClick(); render();
  stageListeners.get('pointerdown')({ target: { closest: () => ({}) } }); advance(); render(); assert.ok(!hidden(), 'dragging prevents hiding');
  windowListeners.get('pointerup')(); advance(); render(); assert.ok(hidden(), 'releasing the slider restarts hiding');
  keyboardFocus = true; stageListeners.get('focusin')({ target: find('暂停') }); advance(); render(); assert.ok(!hidden(), 'keyboard focus remains visible');
  keyboardFocus = false; stageListeners.get('focusout')(); advance(); render(); assert.ok(hidden());
  await find('退出全屏').props.onClick(); render(); render(); assert.equal(document.fullscreenElement, null);
  assert.equal(find('当前播放信息'), undefined, 'fullscreen title leaves with fullscreen');
  advance(); render(); assert.ok(hidden(), 'normal landscape must hide idle controls after exiting fullscreen');
  movePointer(); assert.ok(!hidden(), 'normal landscape movement reveals controls');
  windowListeners.get('blur')(); advance(); render(); assert.ok(hidden(), 'normal landscape hides with the pointer outside the app');
  media.pause(); render(); assert.ok(!hidden(), 'normal landscape pause stays accessible');
  await media.play(); render();
  find('更多播放选项').props.onClick(); render(); advance(); render(); assert.ok(!hidden(), 'normal landscape menu stays visible');
  find('更多播放选项').props.onClick(); render();
  stageListeners.get('pointerdown')({ target: { closest: () => ({}) } }); advance(); render(); assert.ok(!hidden(), 'normal landscape slider drag stays visible');
  windowListeners.get('pointerup')(); advance(); render(); assert.ok(hidden(), 'normal landscape release resumes hiding');
  keyboardFocus = true; stageListeners.get('focusin')({ target: find('暂停') }); advance(); render(); assert.ok(!hidden(), 'normal landscape keyboard focus stays visible');
  keyboardFocus = false; stageListeners.get('focusout')(); advance(); render(); assert.ok(hidden());
  props.portrait = true; render(); advance(); render(); assert.ok(hidden(), 'portrait retains auto-hide');
  props.windowFill = true; props.onWindowFill = value => { props.windowFill = value; }; render();
  movePointer(); assert.ok(!hidden()); advance(); render(); assert.ok(hidden(), 'window fill auto-hides');
  props.continuing = true; props.available = false; media.pause(); render();
  assert.ok(hidden(), 'window fill keeps controls hidden while auto-next prepares');
  props.continuing = false; props.autoContinue = true; media.ended = true; listeners.get('ended')?.(); render();
  assert.ok(!hidden(), 'failed auto-next restores controls even when the retained frame ended and later episodes exist');
  props.autoContinue = false; props.available = true; media.ended = false; await media.play(); render();
  const leavePointer = () => { stageListeners.get('pointerleave')?.(); render(); };
  for (const mode of ['landscape', 'portrait', 'window-fill', 'fullscreen']) {
    props.portrait = mode === 'portrait' || mode === 'window-fill';
    props.windowFill = mode === 'window-fill';
    document.fullscreenElement = mode === 'fullscreen' ? stage : null;
    documentListeners.get('fullscreenchange')(); render();
    movePointer(); assert.ok(!hidden());
    leavePointer(); assert.ok(hidden(), `${mode}: leaving the player hides immediately without advancing time`);
    stageListeners.get('pointermove')({ screenX: pointerX, screenY: 100, movementX: 20, movementY: 0 }); render();
    assert.ok(!hidden(), `${mode}: returning to the same stage coordinate after real outside movement reveals controls`);
    leavePointer();
    advance(); render(); assert.ok(hidden(), `${mode}: the old idle timer cannot reveal controls after leaving`);
    movePointer(); assert.ok(!hidden(), `${mode}: returning with real movement reveals controls`);
    media.pause(); render(); leavePointer(); assert.ok(!hidden(), `${mode}: paused controls remain accessible on leave`);
    await media.play(); render();
    find('更多播放选项').props.onClick(); render(); leavePointer(); assert.ok(!hidden(), `${mode}: an open menu stays accessible on leave`);
    find('更多播放选项').props.onClick(); render();
    stageListeners.get('pointerdown')({ target: { closest: () => ({}) } }); render();
    leavePointer(); assert.ok(!hidden(), `${mode}: leaving while dragging must not hide the slider`);
    windowListeners.get('pointerup')(); advance(); render(); assert.ok(hidden());
    keyboardFocus = true; stageListeners.get('focusin')({ target: find('暂停') }); render();
    leavePointer(); assert.ok(!hidden(), `${mode}: keyboard focus remains visible on leave`);
    keyboardFocus = false; stageListeners.get('focusout')(); advance(); render();
    movePointer(); windowListeners.get('blur')(); render();
    assert.ok(hidden(), `${mode}: leaving the app hides immediately without waiting for the idle timer`);
  }
  props.available = false; render(); render(); assert.ok(!hidden(), 'unavailable media keeps controls visible');
  media.pause(); render();

  media.duration = NaN; listeners.get('durationchange')(); render(); assert.equal(find('播放进度').props.disabled, true);
  props.available = false; render(); assert.equal(find('播放').props.disabled, true);
  assert.equal(find('画中画').props.disabled, true);
  cleanups.forEach(fn => fn?.()); assert.equal(listeners.size, 0); assert.equal(documentListeners.size, 0); assert.equal(stageListeners.size, 0); assert.equal(windowListeners.size, 0); assert.equal(popupDocumentListeners.size, 0); assert.equal(popupWindowListeners.size, 0); assert.equal(timers.size, 0);
  const { mount } = require('./check-player-resume.cjs');
  const controls = ui => ui.find(node => node.props.onRateChange && node.props.videoRef);
  const qualityUi = mount({ local: true, settings: { cache_next_episode: false } });
  await qualityUi.flush(); qualityUi.metadata(); qualityUi.media.currentTime = 41; qualityUi.media.paused = true;
  assert.equal(controls(qualityUi).props.seriesTitle, '测试剧');
  assert.equal(controls(qualityUi).props.episodes.length, 2);
  controls(qualityUi).props.onQualityChange('1080p'); await qualityUi.flush(); qualityUi.metadata();
  assert.equal(qualityUi.prepares.at(-1).quality, '1080p');
  assert.equal(qualityUi.media.currentTime, 41, 'control-bar quality action preserves current time');
  assert.equal(qualityUi.media.paused, true, 'control-bar quality action preserves pause');
  controls(qualityUi).props.onEpisodeChange(2); await qualityUi.flush();
  assert.equal(controls(qualityUi).props.currentIndex, 2);
  assert.equal(qualityUi.prepares.at(-1).quality, '1080p', 'floating episode action keeps selected quality');
  qualityUi.unmount();
  for (const local of [true, false]) {
    let finishNext;
    const ui = mount({ local, props: { setEpisodesOpen() {}, target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, prepare: p => p.vidIndex === 1 ? { success: true, url: 'mock:first' } : new Promise(resolve => { finishNext = resolve; }) });
    await ui.flush(); ui.metadata(); await ui.flush();
    assert.equal(typeof controls(ui).props.onToggleFullscreen, 'function', 'parent supplies the shared fullscreen action');
    assert.equal(controls(ui).props.shortcuts.play, 'space', 'parent supplies effective shortcut preferences');
    assert.equal(controls(ui).props.autoContinue, true, 'parent marks whether an unlocked next episode can follow');
    ui.find(node => node.type === 'video').props.onEnded(); await ui.flush();
    assert.equal(controls(ui).props.continuing, true, `parent retains auto-next intent through source preparation (local=${local})`);
    assert.equal(controls(ui).props.autoContinue, false, 'final episode has no following episode');
    if (!local) { finishNext({ success: true, url: 'mock:second' }); await ui.flush(); }
    assert.equal(controls(ui).props.continuing, true, 'auto-next intent remains until playback actually starts');
    ui.metadata(); await ui.flush();
    assert.equal(controls(ui).props.continuing, false, 'playing clears the transition so later manual pause is visible');
    ui.unmount();
  }
  for (const local of [true, false]) {
    for (const custom of [false, true]) {
      for (const direction of ['previous', 'next']) {
        let finish;
        const bindings = { ...shortcutModule.exports.DEFAULT_SHORTCUTS, ...(custom ? { previous: 'shift+j', next: 'shift+k' } : {}) };
        const storage = new Map([[shortcutModule.exports.SHORTCUT_STORAGE_KEY, JSON.stringify(bindings)]]);
        const ui = mount({ local, storage, episodeCount: 3, settings: { cache_next_episode: false },
          props: { setEpisodesOpen() {}, target: { seriesId: 'A', vidIndex: 2, ts: 1 } },
          prepare: p => p.vidIndex === 2 ? { success: true, url: 'mock:middle' } : new Promise(resolve => { finish = resolve; }) });
        await ui.flush(); ui.metadata(); await ui.flush();
        const key = custom ? (direction === 'previous' ? 'j' : 'k') : (direction === 'previous' ? 'ArrowUp' : 'ArrowDown');
        const init = { key, code: custom ? `Key${key.toUpperCase()}` : key, shiftKey: custom, target: keyTarget };
        // Input/menu events must never be redirected to an episode.
        for (const target of [{ isContentEditable: true }, { closest: query => query.includes('input') ? {} : null }, { closest: query => query.includes('[data-player-menu]') ? {} : null }]) {
          const event = ui.dispatchKey('keydown', { ...init, target });
          assert.equal(event.defaultPrevented, false, 'typing and menu navigation are not hijacked');
          assert.equal(controls(ui).props.continuing, false);
        }
        assert.equal(ui.dispatchKey('keydown', init).defaultPrevented, true);
        await ui.flush();
        assert.equal(controls(ui).props.continuing, true, `${local ? 'local' : 'online'} ${direction} ${custom ? 'custom' : 'default'} shortcut retains transition intent after reset`);
        ui.dispatchKey('keyup', { ...init, shiftKey: false });
        if (!local) { finish({ success: true, url: `mock:${direction}` }); await ui.flush(); }
        assert.equal(controls(ui).props.continuing, true, 'shortcut transition persists until actual playing');
        const play = ui.media.play;
        ui.media.play = async () => { ui.media.paused = false; };
        ui.metadata(); await ui.flush();
        assert.equal(controls(ui).props.continuing, true, 'metadata and an accepted play request do not end the transition before playing');
        ui.media.play = play; await play(); await ui.flush();
        assert.equal(controls(ui).props.continuing, false, 'actual playing releases shortcut transition state');
        assert.equal(ui.find(node => node.type === 'video').props.src, local ? `file:///mock-${direction === 'previous' ? 1 : 3}.mp4` : `mock:${direction}`);
        if (direction === 'previous') {
          ui.find(node => node.type === 'video').props.onEnded(); await ui.flush();
          assert.equal(controls(ui).props.continuing, true, 'automatic next after previous renews transition protection');
          assert.equal(ui.find(node => node.type === 'video').props.src, local ? 'file:///mock-2.mp4' : 'mock:middle');
          ui.metadata(); await ui.flush();
          assert.equal(controls(ui).props.continuing, false, 'second handoff ends only when automatic next plays');
        }
        ui.unmount();
      }
    }
  }
  for (const trigger of ['ended', 'shortcut']) {
    const failed = mount({ props: { setEpisodesOpen() {}, target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, prepare: p => p.vidIndex === 1 ? { success: true, url: 'mock:first' } : { success: false, error: 'test preparation failure' } });
    await failed.flush(); failed.metadata(); await failed.flush();
    if (trigger === 'ended') failed.find(node => node.type === 'video').props.onEnded();
    else failed.dispatchKey('keydown', { key: 'ArrowDown', code: 'ArrowDown', target: keyTarget });
    await failed.flush();
    assert.equal(controls(failed).props.continuing, false, 'failed online preparation must restore ordinary pause behavior');
    failed.unmount();
    const blocked = mount({ local: true, props: { setEpisodesOpen() {} } });
    await blocked.flush(); blocked.metadata(); await blocked.flush();
    if (trigger === 'ended') blocked.find(node => node.type === 'video').props.onEnded();
    else blocked.dispatchKey('keydown', { key: 'ArrowDown', code: 'ArrowDown', target: keyTarget });
    await blocked.flush();
    blocked.media.play = async () => { throw new Error('test autoplay denied'); };
    blocked.metadata(); await blocked.flush();
    assert.equal(controls(blocked).props.continuing, false, 'autoplay rejection must leave the play control accessible');
    blocked.unmount();
  }
  console.log('PASS video controls: controlled custom floating-window toggle, source continuity, callback errors, cross-document listener rebinding; one-second pointer idle and quiet held-key boundaries; previous-to-auto-next continuity with stationary-pointer/video-focus/early-pause events; real movement/click/Tab/focused-control/manual-pause access; persistent-pause recovery; default/custom previous/next keydown/keyup/reset/preparation/source/metadata/playing, local/online shortcut matrix, input/menu boundaries, play/pause, seek, volume, lower-right 4× menu, fullscreen idle/reveal, auto-next pause/preparing/source/metadata/play continuity, local/online parent wiring, failure/end recovery, pause/menu/drag/focus guards, portrait and exit cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
