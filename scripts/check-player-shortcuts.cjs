// In-memory DOM propagation + real Player handlers. Native browser behavior also needs UI acceptance.
const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');

function target(tagName, { role = '', editable = false, menu = false, closedMenuTrigger = false, insidePlayer = true, playerControl = false } = {}) {
  return { tagName: tagName.toUpperCase(), isContentEditable: editable,
    closest(selectors) {
      return selectors.split(',').some(raw => {
        const selector = raw.trim();
        if (selector === 'button[aria-haspopup][aria-expanded="false"]' && closedMenuTrigger) return true;
        if (selector === tagName) return true;
        if (selector === '.player-container' && insidePlayer) return true;
        if (selector === '[data-player-control]' && playerControl) return true;
        if (selector === '[data-player-menu]' && menu) return true;
        if (selector.includes('[contenteditable') && editable) return true;
        const wantedRole = selector.match(/\[role=["']?([^\]"']+)["']?\]/)?.[1];
        return wantedRole === role || (menu && !closedMenuTrigger && wantedRole === 'menu');
      }) ? this : null;
    },
  };
}

function press(ui, key, focused, extra = {}, targetAction) {
  ui.document.activeElement = focused;
  const init = { key, code: key === ' ' ? 'Space' : key, target: focused, ...extra };
  const down = ui.dispatchKey('keydown', init, targetAction);
  const up = ui.dispatchKey('keyup', init, targetAction);
  return { down, up };
}

async function ready() {
  const ui = mount({ local: true, episodeCount: 3 });
  await ui.flush(); ui.metadata(); ui.render();
  return ui;
}

(async () => {
  let failures = 0;
  const test = async (name, run) => {
    const ui = await ready();
    try { await run(ui); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
    finally { ui.unmount(); }
  };

  await test('Space on focused video toggles once before control listeners, keyup and repeat', async ui => {
    const focused = target('video');
    const before = { ...ui.mediaCalls };
    let controlCalls = 0;
    const videoControlListener = event => {
      if (event.type !== 'keydown' || event.code !== 'Space' || event.defaultPrevented) return;
      controlCalls++;
      ui.media.paused ? ui.media.play() : ui.media.pause();
    };
    const { down } = press(ui, ' ', focused, {}, videoControlListener);
    assert.equal(ui.media.paused, true, 'one Space must leave a playing video paused');
    assert.equal(ui.mediaCalls.pause - before.pause, 1);
    assert.equal(ui.mediaCalls.play - before.play, 0, 'keyup must not restart video');
    assert.equal(controlCalls, 0, 'handled key must not reach another control handler');
    assert.equal(down.defaultPrevented, true);
    press(ui, ' ', focused, { repeat: true }, videoControlListener);
    assert.equal(ui.mediaCalls.pause - before.pause, 1);
    assert.equal(ui.mediaCalls.play - before.play, 0, 'holding Space must not repeatedly toggle');
    press(ui, ' ', focused, {}, videoControlListener);
    assert.equal(ui.media.paused, false, 'a second independent press resumes');
    assert.equal(ui.mediaCalls.play - before.play, 1);
  });

  await test('holding Space plays at temporary 2x, restores the preferred speed and never toggles on release', async ui => {
    const focused = target('video');
    const key = (type, extra = {}) => ui.dispatchKey(type, { key: ' ', code: 'Space', target: focused, ...extra });
    const controls = () => ui.find(node => node.props.videoRef && node.props.onRateChange);
    const hold = () => {
      const entry = [...ui.timers].find(([, timer]) => timer.delay === 300);
      assert.ok(entry, 'the shared Space key must wait to distinguish tap from hold');
      ui.timers.delete(entry[0]); entry[1].fn(); ui.render();
    };
    controls().props.onRateChange(1.75); ui.render();
    const position = ui.media.currentTime;
    const before = { ...ui.mediaCalls };
    key('keydown');
    assert.equal(ui.media.paused, false, 'keydown must not pause before a hold can be recognised');
    hold(); key('keydown', { repeat: true });
    assert.equal(ui.media.playbackRate, 2);
    assert.equal(ui.mediaCalls.pause, before.pause);
    ui.media.volume = 0.2;
    ui.find(node => node.type === 'video').props.onVolumeChange({ currentTarget: ui.media });
    key('keyup'); ui.render();
    assert.equal(ui.media.playbackRate, 1.75);
    assert.equal(ui.media.paused, false);
    assert.equal(ui.media.currentTime, position, 'holding Space must not seek');
    key('keydown'); hold(); ui.events.get('blur')(); ui.render(); key('keyup');
    assert.equal(ui.media.playbackRate, 1.75, 'losing focus must restore the preferred speed');
    assert.equal(ui.media.paused, false, 'late keyup after blur must not pause');
    key('keydown'); ui.events.get('blur')(); key('keyup');
    assert.equal(ui.media.paused, false, 'losing focus before the threshold must cancel the tap');
    ui.media.pause(); key('keydown'); hold();
    assert.equal(ui.media.paused, false, 'holding the speed key must start a paused video');
    key('keyup'); ui.render();
    assert.equal(ui.media.playbackRate, 1.75);
    ui.episode(2); await ui.flush(); ui.metadata(); ui.render();
    assert.equal(ui.media.playbackRate, 1.75, 'temporary speed must not overwrite the shared preference');
  });

  await test('independently configured play, hold-speed and fullscreen keys take effect and persist', async () => {
    const storageKey = 'hongguo:preview:playback-shortcuts:v1';
    const bindings = { play: 'j', holdSpeed: 'shift+k', fullscreen: 'g', backward: 'arrowleft', forward: 'arrowright',
      previous: 'arrowup', next: 'arrowdown', autoNext: 'a', slower: 's', faster: 'd' };
    const storage = new Map([[storageKey, JSON.stringify(bindings)]]);
    for (let instance = 0; instance < 2; instance++) {
      const custom = mount({ local: true, storage });
      try {
        await custom.flush(); custom.metadata(); custom.render();
        const focused = target('video');
        press(custom, 'j', focused); assert.equal(custom.media.paused, true);
        press(custom, 'j', focused); assert.equal(custom.media.paused, false);
        custom.dispatchKey('keydown', { key: 'K', code: 'KeyK', shiftKey: true, target: focused });
        const [id, timer] = [...custom.timers].find(([, timer]) => timer.delay === 300) || [];
        assert.ok(timer, 'the configured hold key must arm temporary speed');
        custom.timers.delete(id); timer.fn(); custom.render();
        assert.equal(custom.media.playbackRate, 2);
        custom.dispatchKey('keyup', { key: 'k', code: 'KeyK', shiftKey: false, target: focused }); custom.render();
        assert.equal(custom.media.playbackRate, 1, 'releasing Shift first must still restore speed');
        press(custom, 'g', focused); assert.equal(custom.document.fullscreenElement, custom.stage);
        press(custom, 'g', focused); assert.equal(custom.document.fullscreenElement, null);
        press(custom, ' ', focused); assert.equal(custom.media.paused, false, 'the old Space binding must no longer act');
      } finally { custom.unmount(); }
    }
  });

  await test('episode-button focus keeps Space and episode arrows usable without button activation', async ui => {
    ui.episode(2); await ui.flush(); ui.metadata(); ui.render();
    const focused = target('button');
    let clicks = 0;
    const { down, up } = press(ui, ' ', focused);
    // A button's default Space activation on keyup is cancelled by a cancelled keydown.
    if (!down.defaultPrevented && !up.defaultPrevented) { clicks++; ui.episode(2); }
    assert.equal(ui.media.paused, true, 'Space after clicking an episode must pause');
    assert.equal(clicks, 0, 'Space must not reactivate the focused episode button');
    const next = press(ui, 'ArrowDown', focused).down;
    assert.equal(next.defaultPrevented, true, 'episode change must prevent page scroll');
    await ui.flush(); assert.equal(ui.media.src, 'file:///mock-3.mp4');
    ui.metadata(); ui.render();
    press(ui, 'ArrowUp', focused); await ui.flush();
    assert.equal(ui.media.src, 'file:///mock-2.mp4');
    ui.metadata(); ui.render();
    press(ui, 'ArrowUp', focused, { repeat: true }); await ui.flush();
    assert.equal(ui.media.src, 'file:///mock-2.mp4', 'holding episode arrow must not skip another episode');
  });

  await test('left/right seek exactly five seconds and prevent scrolling, including unknown duration', async ui => {
    const focused = target('video');
    ui.media.currentTime = 40;
    assert.equal(press(ui, 'ArrowRight', focused).down.defaultPrevented, true);
    assert.equal(ui.media.currentTime, 45);
    assert.equal(press(ui, 'ArrowLeft', focused).down.defaultPrevented, true);
    assert.equal(ui.media.currentTime, 40);
    ui.media.duration = NaN;
    press(ui, 'ArrowRight', focused);
    assert.equal(ui.media.currentTime, 45, 'unknown duration must not reset playback to zero');
    ui.media.currentTime = 2;
    press(ui, 'ArrowLeft', focused); assert.equal(ui.media.currentTime, 0);
    ui.media.duration = 100; ui.media.currentTime = 98;
    press(ui, 'ArrowRight', focused); assert.equal(ui.media.currentTime, 100);
  });

  await test('inputs, editable content, menus and modified keys keep their own actions', async ui => {
    for (const focused of [target('input'), target('textarea'), target('select'),
      target('span', { editable: true }), target('button', { role: 'menuitem', menu: true }),
      target('button', { role: 'menuitemradio', menu: true }), target('div', { menu: true }),
      target('div', { role: 'listbox' }), target('button', { insidePlayer: false }),
      target('a', { insidePlayer: false })]) {
      for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 's', 'd']) {
        const before = { time: ui.media.currentTime, ...ui.mediaCalls };
        const { down } = press(ui, key, focused);
        assert.equal(down.defaultPrevented, false, `${focused.tagName}/${key} must retain default action`);
        assert.equal(down.propagationStopped, false);
        assert.equal(ui.media.currentTime, before.time);
        assert.equal(ui.mediaCalls.play, before.play);
        assert.equal(ui.mediaCalls.pause, before.pause);
      }
    }
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing']) {
      const before = { ...ui.mediaCalls };
      const { down } = press(ui, ' ', target('video'), { [modifier]: true });
      assert.equal(down.defaultPrevented, false, modifier);
      assert.deepEqual(ui.mediaCalls, before, modifier);
    }
  });
  await test('closed menu trigger focus releases playback keys and retains native Space/Enter', async ui => {
    const focused = target('button', { menu: true, closedMenuTrigger: true });
    ui.media.currentTime = 40;
    assert.equal(press(ui, 'ArrowRight', focused).down.defaultPrevented, true, 'closed menu trigger must not swallow seek');
    assert.equal(ui.media.currentTime, 45);
    assert.equal(press(ui, 'd', focused).down.defaultPrevented, true, 'closed menu trigger must not swallow speed');
    const before = { ...ui.mediaCalls };
    for (const key of [' ', 'Enter']) {
      const { down, up } = press(ui, key, focused);
      assert.equal(down.defaultPrevented, false, 'activation key still opens the menu');
      assert.equal(up.defaultPrevented, false);
    }
    assert.deepEqual(ui.mediaCalls, before, 'menu activation must not pause playback');
  });
  await test('sidebar Space retains default button activation without toggling playback', async ui => {
    const before = { ...ui.mediaCalls };
    let navigations = 0;
    const { down, up } = press(ui, ' ', target('button', { insidePlayer: false }));
    if (!down.defaultPrevented && !up.defaultPrevented) navigations++;
    assert.equal(navigations, 1, 'Space must activate the focused sidebar button');
    assert.deepEqual(ui.mediaCalls, before, 'sidebar navigation must not toggle playback');
  });
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
