const assert = require('node:assert/strict');
const { DEFAULT_BOSS_KEY, createBossKeyController, normalizeBossKey } = require('../src/native/boss-key');
const defaultAccelerator = normalizeBossKey(DEFAULT_BOSS_KEY).accelerator;

async function checkRecorder() {
  const slots = [], effects = [], saved = [];
  let cursor = 0, tree;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((d, j) => d !== slots[i][j])) { slots[i] = deps; effects.push(fn); } },
  };
  const module = { exports: {} };
  const source = require('node:fs').readFileSync(`${__dirname}/../src/components/BossKeySettings.jsx`, 'utf8');
  require('node:vm').runInNewContext(require('esbuild').transformSync(source, { loader: 'jsx', format: 'cjs' }).code, {
    module, exports: module.exports, require: name => name === 'react' ? react : {}, navigator: { platform: 'MacIntel' },
    window: { electronAPI: { getBossKeyState: async () => ({ ...DEFAULT_BOSS_KEY }),
      setBossKey: async value => { saved.push(value); return { success: true, ...normalizeBossKey(value) }; } } },
  });
  const render = () => { cursor = 0; tree = module.exports.default({}); effects.splice(0).forEach(fn => fn()); };
  const find = (node, predicate) => node && typeof node === 'object' ? predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) : undefined;
  const recorder = () => find(tree, node => node.props.id === 'boss-key-shortcut');
  const key = (key, code, mods = {}) => { recorder().props.onKeyDown({ key, code, preventDefault() {}, stopPropagation() {}, ...mods }); render(); };
  render(); await Promise.resolve(); render();
  assert.equal(recorder().type, 'button', 'shortcut recording must not be an editable text field');
  recorder().props.onClick(); render();
  key('Control', 'ControlLeft', { ctrlKey: true }); assert.equal(recorder().props['aria-pressed'], true);
  key('j', 'KeyJ', { ctrlKey: true, shiftKey: true });
  assert.equal(recorder().children.join(''), 'Ctrl+Shift+J'); assert.equal(recorder().props['aria-pressed'], false);
  assert.equal(saved.length, 0, 'recording must wait for explicit save');
  await find(tree, node => node.props['aria-label'] === '保存老板键').props.onClick(); render();
  assert.equal(saved[0].accelerator, 'Control+Shift+J');
  recorder().props.onClick(); render(); key('Backspace', 'Backspace');
  assert.equal(recorder().props['aria-pressed'], true, 'delete must neither edit nor accept a shortcut');
  key('Escape', 'Escape'); assert.equal(recorder().children.join(''), 'Ctrl+Shift+J');
  recorder().props.onClick(); render(); key('å', 'KeyA', { altKey: true });
  assert.equal(recorder().children.join(''), 'Alt+A', 'Option/Alt must use the physical letter key');
  recorder().props.onClick(); render(); key('F8', 'F8'); assert.equal(recorder().children.join(''), 'F8');
  recorder().props.onClick(); render(); key(' ', 'Space', { ctrlKey: true });
  const release = { key: ' ', code: 'Space', prevented: false, preventDefault() { this.prevented = true; } };
  recorder().props.onKeyUp(release); assert(release.prevented, 'Space release must not activate the recorder again');
  recorder().props.onClick(); render(); key('Tab', 'Tab'); assert.equal(recorder().props['aria-pressed'], false);
}

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const reserved = new Map(), windows = [], sends = [];
  const dockState = { visible: true, pending: null };
  const dock = { isVisible: () => dockState.visible, hide() { dockState.visible = false; }, show() {
    return (dockState.pending?.promise || Promise.resolve()).then(() => { dockState.visible = true; });
  } };
  let settings = { root: '/keep-downloads' }, failSave = false;
  const shortcut = { register(key, callback) { if (reserved.has(key)) return false; reserved.set(key, callback); return true; }, unregister(key) { reserved.delete(key); } };
  const win = (visible, withContents = true) => {
    const state = { visible, focused: false, destroyed: false, muted: false, pauses: 0, shown: 0 };
    const w = { state, isDestroyed: () => state.destroyed, isVisible: () => state.visible, isMinimized: () => false,
      isFocused: () => state.focused, hide() { state.visible = false; }, show() { state.visible = true; state.shown++; }, focus() { state.focused = true; } };
    if (withContents) w.webContents = { isDestroyed: () => state.destroyed, isAudioMuted: () => state.muted,
      setAudioMuted(value) { state.muted = value; }, send: (name, payload) => sends.push({ name, payload }),
      executeJavaScript() { state.pauses++; return state.pending?.promise || Promise.resolve(true); } };
    windows.push(w); return w;
  };
  const main = win(true), helper = win(false);
  const store = { getSettings: () => settings, saveSettings(next) { if (failSave) throw Error('disk full'); settings = next; } };
  const controller = createBossKeyController({ globalShortcut: shortcut, getWindows: () => windows, getMainWindow: () => main, store, dock });
  return { controller, main, helper, win, sends, reserved, dockState, settings: () => settings, failSave: value => { failSave = value; } };
}

(async () => {
  await checkRecorder();
  const f = fixture(), c = f.controller;
  assert.equal(c.getState().enabled, false);
  c.set({ ...DEFAULT_BOSS_KEY, enabled: true });
  assert.equal(f.reserved.has(defaultAccelerator), true, 'enabling must register the global shortcut');
  assert.equal(c.getState().registered, true);
  assert.equal(f.settings().root, '/keep-downloads');
  assert.equal(f.settings().boss_key.enabled, true);

  const pip = f.win(true); pip.state.muted = true;
  c.set({ enabled: true, accelerator: 'Shift+CmdOrCtrl+H' });
  assert.equal(c.getState().accelerator, defaultAccelerator, 'equivalent chords cannot conflict with their own registration');
  f.reserved.get(defaultAccelerator)();
  assert(c.hidden); assert(!f.main.state.visible && !pip.state.visible);
  assert.equal(f.dockState.visible, false, 'boss key must also hide the Dock icon');
  assert(f.main.state.muted && pip.state.muted);
  assert.equal(f.helper.state.shown, 0, 'hidden search helpers must stay hidden');
  c.restore(); await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.dockState.visible, true, 'restoring must bring back the Dock icon');
  assert(!c.hidden && f.main.state.visible && pip.state.visible);
  assert.equal(f.main.state.muted, false); assert.equal(pip.state.muted, true, 'keep the original mute state');
  assert(f.main.state.pauses >= 2 && pip.state.pauses >= 2);
  assert.equal(f.helper.state.shown, 0);

  const gate = deferred(); f.main.state.pending = gate;
  c.toggle(); c.restore(); c.toggle(); gate.resolve(true); await Promise.resolve(); await Promise.resolve();
  assert(c.hidden && f.main.state.muted, 'late restore cannot unmute a later hidden generation');
  f.main.state.pending = null; c.restore(); await Promise.resolve();
  assert.equal(f.main.state.muted, false, 'rapid toggles retain the original unmuted preference');

  const dockGate = deferred(); f.dockState.pending = dockGate;
  c.toggle(); c.restore(); c.toggle(); dockGate.resolve();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.dockState.visible, false, 'late Dock show must not reveal a newly hidden app');
  f.dockState.pending = null; c.restore(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.dockState.visible, true);
  f.dockState.visible = false;
  c.toggle(); c.restore(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.dockState.visible, false, 'an originally hidden Dock icon must stay hidden');
  f.dockState.visible = true;

  f.main.state.visible = false; const panel = f.win(true, false);
  c.toggle(); assert(!panel.state.visible && !f.main.state.visible);
  c.restore(); await Promise.resolve(); assert(panel.state.visible && !f.main.state.visible, 'stealth restores its panel only');

  f.reserved.set('Control+Shift+J', () => {});
  assert.throws(() => c.set({ enabled: true, accelerator: 'Ctrl+Shift+J' }), /占用/);
  assert(c.getState().registered && f.reserved.has(defaultAccelerator));
  f.failSave(true);
  assert.throws(() => c.set({ enabled: true, accelerator: 'Ctrl+Shift+K' }), /disk full/);
  assert(!f.reserved.has('Control+Shift+K') && f.reserved.has(defaultAccelerator));
  f.failSave(false);
  c.toggle(); c.set({ ...DEFAULT_BOSS_KEY, enabled: false }); await Promise.resolve();
  assert(!c.hidden && panel.state.visible && !f.reserved.has(defaultAccelerator));
  c.set({ ...DEFAULT_BOSS_KEY, enabled: true }); c.dispose();
  assert(!f.reserved.has(defaultAccelerator)); assert(f.reserved.has('Control+Shift+J'), 'cleanup must not unregister unrelated shortcuts');

  assert.deepEqual(normalizeBossKey({ enabled: true, accelerator: 'ctrl + shift + h' }), { enabled: true, accelerator: 'Control+Shift+H' });
  for (const value of [{ enabled: 1, accelerator: 'Ctrl+H' }, { enabled: true, accelerator: 'H' }, { enabled: true, accelerator: 'Shift+H' }, { enabled: true, accelerator: 'Ctrl+Ctrl+H' }, { enabled: true, accelerator: 'Ctrl+H+J' }]) assert.throws(() => normalizeBossKey(value));
  console.log('PASS boss key: combo recorder, cancel/delete/Alt/Space boundaries, explicit save, registration, persistence, main/PiP/panel hide-restore, pause/mute, rapid toggle, conflict, disk failure and owned cleanup');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
