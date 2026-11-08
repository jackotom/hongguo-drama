// Actual OfficialDanmaku effects + model in memory; no browser, network or playback.
const test = require('node:test');
const i18nStub = { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {}, getLanguage: () => 'zh-CN' };
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const root = path.join(__dirname, '../src/components');

function mount(kind = 'official') {
  const slots = [], effects = [], cleanups = [], frames = new Map();
  let cursor = 0, dirty = false, nextFrame = 0, tree, resize;
  const changed = (old, deps) => !old || deps.some((v, i) => !Object.is(v, old[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const media = Object.assign(new EventTarget(), { currentTime: 0, paused: false, ended: false, seeking: false, readyState: 4, playbackRate: 1 });
  const layer = { clientWidth: 800, clientHeight: 600, parentElement: { querySelector: name => { assert.equal(name, '.player-controls-bar'); return { clientHeight: 68 }; } } };
  const document = { hidden: false };
  const window = { matchMedia: () => Object.assign(new EventTarget(), { matches: false }) };
  const modules = new Map();
  function load(file) {
    if (!path.extname(file)) file += '.jsx';
    if (file.endsWith('.css')) return {};
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const source = transformSync(fs.readFileSync(file, 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs' }).code;
    vm.runInNewContext(source, { module, exports: module.exports,
      require: name => name === '../i18n' ? i18nStub : name === 'react' ? react : load(path.resolve(path.dirname(file), name)), window, document,
      requestAnimationFrame: fn => { const id = ++nextFrame; frames.set(id, fn); return id; },
      cancelAnimationFrame: id => frames.delete(id),
      ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} disconnect() {} },
    });
    return module.exports;
  }
  const model = load(path.join(root, 'danmakuOfficial.mjs'));
  const { DEFAULT_DANMAKU_SETTINGS, createCommentFeed } = load(path.join(root, 'danmakuModel.mjs'));
  const feed = kind === 'official' ? model.createOfficialFeed('1234567', '2345678') : createCommentFeed('1234567', '2345678');
  if (kind === 'official') feed.danmaku.push({ time: 0, text: '全屏切换时保留这条弹幕', color: '#FFFFFF' });
  else feed.comments.push({ content: 'Keep this visible comment rolling' });
  feed.loaded = true;
  const props = { videoRef: { current: media }, source: 'current-video', available: true,
    danmaku: { running: true, enabled: true, active: true, supported: true, settings: DEFAULT_DANMAKU_SETTINGS, feed, comments: feed.comments, status: '', error: '', loading: false } };
  const Component = load(path.join(root, kind === 'official' ? 'OfficialDanmaku.jsx' : 'CommentDanmaku.jsx')).default;
  const attach = node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.props.ref === 'function') node.props.ref({ style: {} });
    else if (node.props.ref) node.props.ref.current = layer;
    node.children.forEach(attach);
  };
  const detach = node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.props.ref === 'function') node.props.ref(null);
    else if (node.props.ref) node.props.ref.current = null;
    node.children.forEach(detach);
  };
  const render = () => { let turns = 0; do { dirty = false; cursor = 0; const next = Component(props); if (!next && tree) detach(tree); tree = next; attach(tree); effects.splice(0).forEach(fn => fn()); assert.ok(++turns < 10, 'effect update loop'); } while (dirty); };
  const tick = (time, now) => { media.currentTime = time; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); render(); };
  const event = name => { media.dispatchEvent(new Event(name)); render(); };
  const resized = (width, height) => { layer.clientWidth = width; layer.clientHeight = height; resize(); render(); };
  render(); tick(0, 100); tick(0.2, 300);
  assert.equal(feed.animation.items.length, 1);
  return { feed, media, props, document, render, tick, event, resized, layer, get tree() { return tree; }, unmount: () => cleanups.forEach(fn => fn?.()) };
}
const ids = ui => Array.from(ui.feed.animation.items, item => item.id);

test('playing fullscreen transition frame gap retains current overlay', () => {
  const ui = mount();
  try {
    const before = ids(ui);
    ui.resized(1987, 1248);
    ui.tick(1.8, 1900); // macOS fullscreen transition stalls RAF, while media time advances.
    assert.deepEqual(ids(ui), before, 'a frame gap must not be treated as seeking');
    ui.resized(800, 600); ui.tick(3.4, 3500);
    assert.deepEqual(ids(ui), before, 'exiting fullscreen must also retain current overlay');
  } finally { ui.unmount(); }
});

test('paused fullscreen visibility transition restores existing overlay immediately', () => {
  const ui = mount();
  try {
    ui.media.paused = true; ui.event('pause');
    const before = ids(ui);
    for (const [width, height] of [[1987, 1248], [800, 600]]) {
      ui.document.hidden = true; ui.props.danmaku.running = false; ui.render();
      ui.document.hidden = false; ui.props.danmaku.running = true; ui.render();
      ui.resized(width, height);
      assert.deepEqual(ids(ui), before, 'paused overlay must survive visibility change without another media frame');
      assert.equal(ui.media.currentTime, 0.2);
    }
  } finally { ui.unmount(); }
});

test('waiting and playing around fullscreen keep existing overlay', () => {
  const ui = mount();
  try {
    const before = ids(ui);
    ui.event('waiting'); ui.resized(1987, 1248);
    ui.media.currentTime = 1.8; ui.event('playing'); ui.tick(1.8, 1900);
    assert.deepEqual(ids(ui), before);
  } finally { ui.unmount(); }
});

test('forward and backward seeks preserve and animate visible comments without emitting skipped comments', () => {
  for (const time of [0.05, 30]) {
    const ui = mount();
    try {
      const before = ids(ui), x = ui.feed.animation.items[0].x;
      ui.feed.danmaku.push({time: 5, text: 'skipped'}, {time: 30, text: 'new position'});
      ui.media.seeking = true; ui.media.readyState = 1; ui.event('seeking');
      assert.deepEqual(ids(ui), before, 'seeking must not clear visible comments');
      ui.tick(time, 500);
      assert.ok(ui.feed.animation.items[0].x < x, 'visible comments keep rolling while media seeks');
      assert.deepEqual(ids(ui), before, 'no comments are emitted during unstable seek time');
      ui.media.seeking = false; ui.media.readyState = 4; ui.event('seeked'); ui.tick(time, 600);
      assert.ok(before.every(id => ids(ui).includes(id)), 'seek completion preserves original visible comments');
      assert.ok(!ui.feed.animation.items.some(item => item.text === 'skipped'));
      if (time === 30) assert.ok(ui.feed.animation.items.some(item => item.text === 'new position'));
      ui.media.paused = true; ui.event('pause'); const pausedX = ui.feed.animation.items[0].x;
      ui.tick(time, 900); assert.equal(ui.feed.animation.items[0].x, pausedX, 'explicit pause still freezes comments');
    } finally { ui.unmount(); }
  }
  const ui = mount();
  try { ui.props.source = 'another-video'; ui.render(); assert.equal(ui.feed.animation.items.length, 0); }
  finally { ui.unmount(); }
});

test('brief buffering keeps comments moving and emptied clears the old source', () => {
  const ui = mount();
  try {
    const before = ids(ui), x = ui.feed.animation.items[0].x;
    ui.media.readyState = 1; ui.event('waiting'); ui.tick(0.2, 500);
    assert.deepEqual(ids(ui), before); assert.ok(ui.feed.animation.items[0].x < x);
    ui.event('emptied'); assert.equal(ui.feed.animation.items.length, 0);
  } finally { ui.unmount(); }
});


test('hidden resize restore immediately keeps an originally visible item inside the new layer', () => {
  const ui = mount();
  try {
    ui.media.paused = true; ui.event('pause');
    ui.resized(1987, 1248);
    const before = ids(ui);
    const visible = () => ui.feed.animation.items.filter(item => item.x < ui.layer.clientWidth && item.x + item.width > 0);
    assert.equal(visible().length, 1);
    for (const [width, height] of [[800, 600], [1987, 1248]]) {
      ui.document.hidden = true; ui.props.danmaku.running = false; ui.render();
      assert.ok(ui.tree, 'hidden overlay stays mounted while its animation effect stops');
      ui.layer.clientWidth = width; ui.layer.clientHeight = height; // Resize occurs while the animation effect and observer are stopped.
      ui.document.hidden = false; ui.props.danmaku.running = true; ui.render();
      assert.ok(ui.tree, 'overlay layer must remain mounted');
      assert.deepEqual(ids(ui), before);
      assert.ok(visible().some(item => before.includes(item.id)), 'restore must reflow immediately without a later resize callback or animation frame');
      assert.equal(ui.media.currentTime, 0.2);
    }
  } finally { ui.unmount(); }
});

test('explicit disable or inactive player restore realigns instead of reviving old time overlays', () => {
  for (const mode of ['enabled', 'available', 'active']) {
    const ui = mount();
    try {
      ui.media.paused = true; ui.event('pause');
      if (mode === 'available') ui.props.available = false;
      else ui.props.danmaku[mode] = false;
      ui.props.danmaku.running = false; ui.render();
      ui.media.currentTime = 20;
      if (mode === 'available') ui.props.available = true;
      else ui.props.danmaku[mode] = true;
      ui.props.danmaku.running = true; ui.render();
      assert.equal(ui.feed.animation.items.length, 0, `${mode}: explicit disable must not revive time-zero overlays`);
      ui.media.paused = false; ui.event('playing'); ui.tick(20, 20000);
      assert.equal(ui.feed.animation.items.length, 0);
      assert.equal(ui.feed.animation.lastTime, 20);
      assert.equal(ui.feed.animation.cursor, 1);
    } finally { ui.unmount(); }
  }
});


test('temporary hidden state keeps overlay mounted and frozen; explicit disable removes it', () => {
  const ui = mount();
  try {
    const before = ids(ui);
    const x = ui.feed.animation.items[0].x;
    ui.document.hidden = true; ui.props.danmaku.running = false; ui.render();
    assert.ok(ui.tree, 'temporary visibility must not unmount the overlay');
    ui.tick(1.8, 1900);
    assert.equal(ui.feed.animation.items[0].x, x, 'hidden overlay must stop animating');
    assert.deepEqual(ids(ui), before);
    ui.document.hidden = false; ui.props.danmaku.running = true; ui.render();
    assert.ok(ui.tree); assert.deepEqual(ids(ui), before);
    ui.tick(1.8, 1950); assert.deepEqual(ids(ui), before);
    for (const mode of ['enabled', 'active', 'supported', 'available']) {
      if (mode === 'available') ui.props.available = false;
      else ui.props.danmaku[mode] = false;
      ui.props.danmaku.running = false; ui.render();
      assert.equal(ui.tree, null, `${mode}: explicit disable must remove the overlay`);
      if (mode === 'available') ui.props.available = true;
      else ui.props.danmaku[mode] = true;
      ui.props.danmaku.running = true; ui.render();
    }
  } finally { ui.unmount(); }
});

test('comment-source overlays also keep moving through forward/backward seek and buffering', () => {
 const ui = mount('comments');
 try {
  const before = ids(ui);
  for (const time of [30, 0.1]) {
   ui.media.seeking = true; ui.media.readyState = 1; ui.event('seeking');
   const x = ui.feed.animation.items[0]?.x; assert.deepEqual(ids(ui), before);
   ui.tick(time, time === 30 ? 500 : 900); assert.ok(ui.feed.animation.items[0].x < x);
   ui.media.seeking = false; ui.media.readyState = 4; ui.event('seeked');
  }
  ui.event('emptied'); assert.equal(ui.feed.animation.items.length, 0);
 } finally { ui.unmount(); }
});
