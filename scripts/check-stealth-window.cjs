const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStealthController } = require('../src/native/stealth-window');
let tick, cursor = { x: 600, y: 200 };
const interval = global.setInterval, clear = global.clearInterval;
global.setInterval = callback => { tick = callback; return { unref() {} }; };
global.clearInterval = () => { tick = null; };
try {
  const original = { x: 100, y: 100, width: 1100, height: 750 };
  let bounds = { ...original }, minimum = [900, 620], opacity = 1, top = false, visibleOnAllWorkspaces = false, dockVisible = true;
  const messages = [];
  const win = {
    isDestroyed: () => false, isMaximized: () => false, isMinimized: () => false,
    getNormalBounds: () => ({ ...bounds }), getBounds: () => bounds,
    getMinimumSize: () => [...minimum], isAlwaysOnTop: () => top,
    isVisibleOnAllWorkspaces: () => visibleOnAllWorkspaces,
    setVisibleOnAllWorkspaces: (value, options) => {
      visibleOnAllWorkspaces = value;
      // Electron 44 hides the whole app's Dock icon for this fullscreen transformation.
      if (!options?.skipTransformProcessType) dockVisible = !options?.visibleOnFullScreen;
    },
    setMinimumSize: (...next) => { minimum = next; }, setBounds: next => { bounds = next; },
    setAlwaysOnTop: value => { top = value; }, setOpacity: value => { opacity = value; },
    setFullScreenable() {}, webContents: { send: (name, state) => messages.push({ name, ...state }), focus() {} },
  };
  const screen = {
    getCursorScreenPoint: () => cursor,
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  };
  const controller = createStealthController({ platform: 'win32', getWindow: () => win, screen });
  controller.setEnabled(true);
  assert(controller.enabled && top);
  assert.equal(visibleOnAllWorkspaces, true);
  assert.equal(dockVisible, true, 'entering stealth must preserve the Dock icon');
  assert.equal(bounds.width, 400);
  tick(); assert.equal(opacity, 1);
  cursor = { x: 0, y: 0 }; tick();
  assert.equal(opacity, 0); assert.equal(messages.at(-1).concealed, true);
  const count = messages.length; tick(); assert.equal(messages.length, count);
  cursor = { x: bounds.x + 100, y: bounds.y + 100 }; tick();
  assert.equal(opacity, 1); assert.equal(messages.at(-1).concealed, false);
  controller.setEnabled(false);
  assert.deepEqual(bounds, original); assert.deepEqual(minimum, [900, 620]);
  assert.equal(top, false); assert.equal(visibleOnAllWorkspaces, false); assert.equal(tick, null); assert.equal(controller.enabled, false);
  assert.equal(dockVisible, true, 'leaving stealth must preserve the Dock icon');
  controller.setEnabled(true); controller.dispose(); assert.equal(tick, null);

  class View {}
  const panels = [];
  class Panel extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = {}; this.destroyed = false; panels.push(this);
    }
    setContentView(view) { this.contentView = view; }
    setMinimumSize() {}
    setBounds(value) { this.bounds = value; }
    getBounds() { return this.bounds; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(value, options) { assert(options.skipTransformProcessType); }
    setFullScreenable() {}
    setOpacity(value) { this.opacity = value; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    show() { this.visible = true; }
    focus() {}
    close() { this.emit('close'); this.destroy(); }
    destroy() { this.destroyed = true; this.visible = false; }
  }
  bounds = { ...original };
  const playingView = new View();
  const main = { ...win, contentView: playingView, visible: true, getTitle: () => 'player',
    setContentView(view) { this.contentView = view; }, hide() { this.visible = false; },
    show() { this.visible = true; }, focus() {} };
  const mac = createStealthController({ platform: 'darwin', BaseWindow: Panel, View, getWindow: () => main, screen });
  mac.setEnabled(true);
  assert.equal(panels.length, 1, 'macOS stealth requires a native panel');
  assert.equal(panels[0].options.type, 'panel');
  assert.equal(panels[0].contentView, playingView, 'move the same live renderer without restarting media');
  assert.equal(main.visible, false);
  assert.deepEqual(bounds, original, 'the normal main window keeps its bounds');
  cursor = { x: -10, y: -10 }; tick(); assert.equal(panels[0].opacity, 0);
  assert.equal(messages.at(-1).concealed, true, 'panel state must reach the original renderer');
  mac.setEnabled(false);
  assert.equal(main.contentView, playingView); assert(main.visible); assert(panels[0].destroyed);
  assert.equal(tick, null);
  mac.setEnabled(true); panels.at(-1).close();
  assert.equal(mac.enabled, false, 'native close restores the main window');
  assert.equal(main.contentView, playingView); assert(main.visible);
  mac.setEnabled(true); const activePanel = panels.at(-1); mac.dispose();
  assert(activePanel.destroyed, 'disposing the main window cannot leave an orphan panel');
  assert.equal(tick, null);

  class FailingPanel extends Panel { setContentView() { throw Error('panel transfer failed'); } }
  const failing = createStealthController({ platform: 'darwin', BaseWindow: FailingPanel, View, getWindow: () => main, screen });
  assert.throws(() => failing.setEnabled(true), /panel transfer failed/);
  assert.equal(main.contentView, playingView, 'failed transfer restores the renderer');
  assert.equal(failing.enabled, false); assert(panels.at(-1).destroyed);
  console.log('PASS stealth window: conceal/reveal, restore, native panel, live renderer transfer, native close and cleanup');
} finally { global.setInterval = interval; global.clearInterval = clear; }
