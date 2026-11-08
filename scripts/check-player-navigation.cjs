const i18nStub = { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {}, getLanguage: () => 'zh-CN' };
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');
const slots = [];
let cursor = 0;
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
  },
  useRef: value => { const i = cursor++; return slots[i] ||= { current: value }; }, useCallback: fn => fn, useEffect() {}, useLayoutEffect() {},
};
const document = { pictureInPictureElement: null };
const context = { window: { electronAPI: { platform: 'darwin' } }, document, module: { exports: {} }, navigator: { platform: 'Mac' }, require: name => {
  if (name === 'react') return react;
  if (name === './i18n') return i18nStub;
  if (name.endsWith('useStealthWindow')) return () => ({ stealthMode: false, toggleStealth() {} });
  return name;
} };
context.exports = context.module.exports;
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, context);
let tree;
const render = () => { cursor = 0; tree = context.module.exports.default({}); };
const nodes = () => {
  const out = [];
  const visit = node => { if (!node || typeof node !== 'object') return; out.push(node); node.children?.forEach(visit); };
  visit(tree); return out;
};
const navigate = id => {
  const button = nodes().find(node => node.type === 'button' && node.props.key === id);
  assert(button, id); button.props.onClick(); render();
};
const players = () => nodes().filter(node => node.type === './components/Player');
render();
navigate('player'); assert.equal(players().length, 1);
navigate('feed'); assert.equal(players().length, 0);
navigate('settings'); assert.equal(players().length, 0, 'leaving feed must not remount a hidden player');
navigate('player'); assert.equal(players().length, 1, 'returning to library explicitly mounts its player');
navigate('settings'); assert.equal(players().length, 1, 'ordinary navigation preserves the existing retained-player behavior');
assert.equal(players()[0].props.active, false);
console.log('PASS navigation: feed/library exclusivity without hidden playback remount');

(async () => {
  const { mount } = require('./check-player-resume.cjs');
  navigate('player');
  players()[0].props.onFloatingChange(true); render();
  for (const page of ['download', 'manager', 'history', 'settings', 'feed']) {
    navigate(page);
    assert.equal(players().length, 1, `${page} must retain the picture-in-picture player`);
    assert.equal(players()[0].props.active, false, 'background player must not capture page shortcuts');
  }
  players()[0].props.onFloatingChange(false); render();
  navigate('player'); navigate('feed');
  assert.equal(players().length, 0, 'ordinary feed navigation must retain its existing cleanup');

  for (const local of [true, false]) {
    const ui = mount({ local, episodeCount: 2, settings: { cache_next_episode: false },
      props: { active: true, target: { seriesId: 'A', vidIndex: 1, ts: 1 } } });
    try {
      await ui.flush(); ui.metadata(); await ui.media.play();
      ui.enterFloatingPlayer();
      const source = ui.media.src;
      ui.props.active = false; ui.render(); await ui.flush();
      assert.equal(ui.pictureInPictureExits(), 0, 'page navigation must not close native picture-in-picture');
      assert.equal(ui.media.paused, false, 'page navigation must keep picture-in-picture playing');
      assert.equal(ui.media.src, source, 'page navigation must retain the current source');
      assert.equal(ui.events.has('keydown'), false, 'background picture-in-picture must not steal search input');
      ui.media.pause(); await ui.media.play();
      assert.equal(ui.media.paused, false, 'native picture-in-picture play must work while the page is hidden');
      ui.media.currentTime = ui.media.duration;
      ui.find(node => node.type === 'video').props.onEnded(); await ui.flush();
      assert.notEqual(ui.media.src, source, 'picture-in-picture must advance to the next episode in the background');
      ui.metadata(); await ui.flush();
      assert.equal(ui.media.paused, false, 'background next episode must autoplay after metadata');
      assert.equal(ui.isFloating(), true, 'auto-next must retain the owned floating window');
      ui.media.currentTime = 17;
      await ui.exitFloatingPlayer(); await ui.flush();
      assert.equal(ui.media.paused, true, 'closing picture-in-picture while away must stop hidden playback');
      assert.ok(ui.saves.some(args => args[1] === 2 && args[2] === 17), 'closing picture-in-picture must save the exact position');
      ui.props.active = true; ui.render(); await ui.flush();
      await ui.media.play();
      assert.equal(ui.media.paused, false, 'returning to the library must allow playback to resume');
      ui.props.active = false; ui.render(); await ui.flush();
      assert.equal(ui.media.paused, true, 'ordinary navigation without picture-in-picture must still pause');
    } finally { ui.unmount(); }
  }
  console.log('PASS picture-in-picture: navigation, local/online background controls, auto-next, exit saving, and ordinary pause');

  const ui = mount({ local: true, settings: { show_danmaku_controls: true } });
  try {
    await ui.flush(); ui.metadata(); await ui.flush();
    const controls = () => ui.find(node => typeof node.props.onToggleFloating === 'function');
    const enhancement = () => ui.find(node => node.props.videoRef && node.props.enhancement && !node.props.onToggleFloating);
    const danmaku = () => ui.find(node => node.props.videoRef && node.props.danmaku && !node.props.enhancement);
    await controls().props.onToggleFloating(); await ui.flush();
    ui.props.active = false; ui.render(); await ui.flush();
    assert.equal(ui.isFloating(), true);
    assert.equal(enhancement().props.available, true, 'custom floating playback must retain enhancement on other pages');
    assert.equal(danmaku().props.available, true, 'custom floating playback must retain the danmaku layer');
    assert.equal(danmaku().props.danmaku.active, true, 'custom floating playback must keep fetching danmaku');
    await controls().props.onToggleFloating(); await ui.flush();
    assert.equal(enhancement().props.available, false, 'closing a background custom window must stop enhancement');
    assert.equal(danmaku().props.available, false);
    assert.equal(danmaku().props.danmaku.active, false);
    console.log('PASS custom floating overlays: navigation retains enhancement and danmaku; background close disables both');
  } finally { ui.unmount(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
