const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');
const key = 'hongguo:playback-preferences';
const video = ui => ui.find(node => node.type === 'video');
const rate = (ui, value) => ui.find(node => node.props.rate !== undefined && typeof node.props.onRateChange === 'function').props.onRateChange(value);
const volume = (ui, value, muted = false) => {
  Object.assign(ui.media, { volume: value, muted });
  video(ui).props.onVolumeChange({ currentTarget: ui.media });
};
const ready = async (storage, extra = {}) => {
  const ui = mount({ local: true, storage, ...extra });
  await ui.flush(); ui.metadata(); ui.render();
  return ui;
};
(async () => {
  const storage = new Map();
  const idle = mount({ local: true, storage, props: { target: null } });
  await idle.flush();
  assert.equal(idle.media.volume, 0.5, 'volume is restored before the first play command');
  idle.unmount();
  const first = await ready(storage);
  assert.equal(first.media.volume, 0.5, 'new profiles start with moderate volume');
  rate(first, 1.75); volume(first, 0.3); first.render();
  first.episode(2); await first.flush(); first.metadata();
  assert.equal(first.media.playbackRate, 1.75); assert.equal(first.media.volume, 0.3);
  first.unmount();
  const second = await ready(storage, { seriesId: 'B' });
  assert.equal(second.media.playbackRate, 1.75, 'another series and fresh player restore the shared rate');
  assert.equal(second.media.volume, 0.3);
  const focused = { tagName: 'VIDEO', closest: () => null };
  second.dispatchKey('keydown', { key: 'ArrowRight', code: 'ArrowRight', target: focused });
  const hold = [...second.timers].find(([, timer]) => timer.delay === 300);
  assert.ok(hold); second.timers.delete(hold[0]); hold[1].fn(); second.render();
  assert.equal(second.media.playbackRate, 2);
  volume(second, 0.2, true);
  assert.equal(JSON.parse(storage.get(key)).rate, 1.75, 'volume changes during temporary speed must retain the preferred rate');
  second.events.get('blur')(); second.render();
  assert.equal(second.media.playbackRate, 1.75);
  second.unmount();
  const third = await ready(storage);
  assert.equal(third.media.playbackRate, 1.75); assert.equal(third.media.volume, 0.2); assert.equal(third.media.muted, true);
  third.unmount();
  for (const stored of ['broken', 'null', '{"rate":0,"volume":2}', '{"rate":"2","volume":"0.1"}']) {
    const ui = await ready(new Map([[key, stored]]));
    assert.equal(ui.media.playbackRate, 1); assert.equal(ui.media.volume, 0.5); ui.unmount();
  }
  const blocked = await ready({ get() { throw new Error('blocked'); }, set() { throw new Error('blocked'); } });
  rate(blocked, 1.5); volume(blocked, 0.4); blocked.render();
  assert.equal(blocked.media.playbackRate, 1.5); assert.equal(blocked.media.volume, 0.4);
  assert.match(blocked.text(), /未能保存/); blocked.unmount();
  console.log('PASS player preferences: volume/mute/rate across episodes, series and restart; temporary 2x and blocked/corrupt storage');
})().catch(error => { console.error(error); process.exitCode = 1; });
