const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');

(async () => {
  const ui = mount({ local: true, episodeCount: 3 });
  try {
    await ui.flush(); ui.metadata(); ui.render();
    const video = () => ui.find(node => node.type === 'video');
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
    const paused = ui.media.paused;
    video().props.onClick({ detail: 1 });
    video().props.onClick({ detail: 2 });
    assert.equal(typeof video().props.onDoubleClick, 'function');
    await video().props.onDoubleClick(); tick(300);
    assert.equal(ui.document.fullscreenElement, ui.stage);
    assert.equal(ui.media.paused, paused, 'double click changes fullscreen without toggling playback');
    await video().props.onDoubleClick();
    assert.equal(ui.document.fullscreenElement, null);
    console.log('PASS hold/release/blur speed, short-press seek and double-click fullscreen');
  } finally { ui.unmount(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
