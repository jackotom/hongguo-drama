// No network or user data; exercise the real store across window recreation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const store = require('../src/store');
const { restoreMainWindowBounds, rememberMainWindowBounds } = require('../src/native/window-layout');
assert.equal(typeof restoreMainWindowBounds, 'function', 'main-window bounds must be restored at startup');
assert.equal(typeof rememberMainWindowBounds, 'function', 'normal main-window bounds must be remembered');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-window-state-'));
const file = path.join(root, 'data.json');
const primary = { id: 1, workArea: { x: 0, y: 25, width: 1920, height: 1055 } };
const secondary = { id: 2, workArea: { x: -1920, y: 25, width: 1920, height: 1055 } };
let displays = [primary, secondary];
const screen = { getAllDisplays: () => displays, getDisplayMatching: bounds => bounds.x < 0 ? secondary : primary };
const normal = { x: -1700, y: 100, width: 1200, height: 800 };
class Window extends EventEmitter {
  bounds = { ...normal };
  isDestroyed() { return false; }
  isMaximized() { return !!this.maximized; }
  isFullScreen() { return !!this.fullscreen; }
  isMinimized() { return !!this.minimized; }
  isVisible() { return !this.hidden; }
  getBounds() { return { ...this.bounds }; }
}
let checks = 0;
function check(name, fn) { fn(); checks++; }
function setup() {
  store.init(file);
  store.saveSettings({ ui_zoom: 1.2 });
  displays = [primary, secondary];
  const win = new Window();
  let eligible = true;
  rememberMainWindowBounds(win, { store, screen, isNormal: () => eligible });
  return { win, exclude: () => { eligible = false; } };
}
try {
  check('first launch keeps default creation options', () => {
    setup(); assert.deepEqual(restoreMainWindowBounds(store, screen), {});
  });
  check('normal close persists bounds and display across a fresh store load', () => {
    const { win } = setup(); win.emit('close'); store.init(file);
    assert.deepEqual(restoreMainWindowBounds(store, screen), normal);
    assert.equal(store.getSettings().ui_zoom, 1.2);
  });
  for (const mode of ['maximized', 'fullscreen', 'minimized', 'hidden']) {
    check(`${mode} never overwrites the previous normal bounds`, () => {
      const { win } = setup();
      win[mode] = true; win.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
      win.emit('resize'); win.emit('move'); win.emit('close');
      assert.deepEqual(restoreMainWindowBounds(store, screen), normal);
    });
  }
  check('full-screen animation is ignored before isFullScreen becomes true', () => {
    const { win } = setup(); win.emit('will-enter-full-screen');
    win.bounds = { x: 0, y: 0, width: 1920, height: 1080 }; win.emit('resize'); win.emit('close');
    assert.deepEqual(restoreMainWindowBounds(store, screen), normal);
  });
  check('macOS maximize animation cannot replace the pre-animation normal bounds', () => {
    const { win } = setup();
    win.bounds = { x: 2, y: 34, width: 1458, height: 830 }; win.emit('resize');
    win.maximized = true;
    win.getNormalBounds = () => ({ ...normal });
    win.emit('maximize'); win.emit('close');
    assert.deepEqual(restoreMainWindowBounds(store, screen), normal);
  });
  check('portrait, stealth and layout transitions do not replace normal bounds', () => {
    const { win, exclude } = setup(); exclude();
    win.bounds = { x: 40, y: 40, width: 400, height: 600 }; win.emit('resize'); win.emit('close');
    assert.deepEqual(restoreMainWindowBounds(store, screen), normal);
  });
  check('normal resize immediately followed by close is retained', () => {
    const { win } = setup(); const next = { ...normal, width: 1300, x: -1800 };
    win.bounds = next; win.emit('resize'); win.emit('close');
    assert.deepEqual(restoreMainWindowBounds(store, screen), next);
  });
  check('missing display uses defaults even if another display covers those coordinates', () => {
    const { win } = setup(); win.emit('close'); displays = [{ ...secondary, id: 3 }];
    assert.deepEqual(restoreMainWindowBounds(store, screen), {});
  });
  check('smaller work area clamps the complete restored window', () => {
    const { win } = setup(); win.emit('close');
    displays = [{ id: 2, workArea: { x: 0, y: 25, width: 800, height: 575 } }];
    assert.deepEqual(restoreMainWindowBounds(store, screen), { x: 0, y: 25, width: 800, height: 575, minWidth: 800, minHeight: 575 });
  });
  check('invalid or incompatible saved values safely use defaults', () => {
    setup();
    for (const value of [null, [], {}, { displayId: 2, bounds: { ...normal, x: '0' } },
      { displayId: 2, bounds: { ...normal, width: -1 } }, { displayId: 2, bounds: { ...normal, height: 1e30 } }]) {
      store.saveSettings({ main_window_state: value });
      assert.deepEqual(restoreMainWindowBounds(store, screen), {});
    }
  });
  check('storage write failure leaves existing data intact and does not cancel close', () => {
    const { win } = setup();
    const before = fs.readFileSync(file, 'utf8');
    fs.mkdirSync(file + '.tmp');
    assert.doesNotThrow(() => win.emit('close'));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    fs.rmdirSync(file + '.tmp');
  });
  console.log(`PASS ${checks} main-window state checks`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
