const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');

(async () => {
  const ui = mount({ local: true, episodeCount: 3 });
  try {
    await ui.flush(); ui.metadata(); ui.render();
    const video = () => ui.find(node => node.type === 'video');
    const stage = () => ui.find(node => node.props.className?.split(' ').includes('player-stage'));
    const doubleClick = target => stage().props.onDoubleClick({ target });
    const controls = () => ui.find(node => node.props.videoRef && node.props.onRateChange);
    const key = type => ui.dispatchKey(type, { key: 'ArrowRight', code: 'ArrowRight', target: { closest: () => null } });
    const tick = delay => { for (const [id, timer] of [...ui.timers]) if (timer.delay === delay) { ui.timers.delete(id); timer.fn(); } };
    controls().props.onRateChange(1.5); ui.render();
    const position = ui.media.currentTime;
    key('keydown'); tick(300); ui.render();
    assert.equal(ui.media.playbackRate, 2, 'holding forward temporarily doubles playback');
    key('keyup'); ui.render();
    assert.equal(ui.media.playbackRate, 1.5, 'release restores the selected speed');
    assert.equal(ui.media.currentTime, position, 'holding forward does not also seek');
    key('keydown'); key('keyup');
    assert.equal(ui.media.currentTime, position + 5, 'a short press keeps the five-second seek');
    key('keydown'); tick(300); ui.events.get('blur')(); ui.render();
    assert.equal(ui.media.playbackRate, 1.5, 'losing focus restores speed');
    assert.equal(typeof stage().props.onDoubleClick, 'function', 'the entire playback area must handle double click');
    assert.equal(video().props.onDoubleClick, undefined, 'video events must bubble to one handler, not toggle fullscreen twice');
    for (const pictureMode of ['fit', 'width']) {
      controls().props.onPictureModeChange(pictureMode); ui.render();
      for (const paused of [false, true]) {
        ui.media.paused = paused;
        video().props.onClick({ detail: 1 });
        video().props.onClick({ detail: 2 });
        await doubleClick({ closest: () => null }); tick(300);
        assert.equal(ui.document.fullscreenElement, ui.stage, 'video double click must enter fullscreen');
        assert.equal(ui.media.paused, paused, 'double click must preserve playing or paused state');
        await doubleClick(ui.stage);
        assert.equal(ui.document.fullscreenElement, null, 'double clicking the stage border must exit fullscreen');
      }
    }
    const excluded = ['.player-controls', 'button', 'input', 'select', 'textarea', 'a', '[role="dialog"]'];
    for (const selector of excluded) {
      await doubleClick({ closest: query => query.split(',').map(value => value.trim()).includes(selector) ? {} : null });
      assert.equal(ui.document.fullscreenElement, null, `${selector} must keep its own double-click behavior`);
    }
    console.log('PASS hold/release/blur speed, short-press seek; full playback area double click, both picture modes, pause state and control/menu boundaries');
  } finally { ui.unmount(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
