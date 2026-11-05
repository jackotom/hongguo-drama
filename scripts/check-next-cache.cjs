const assert = require('node:assert/strict');
const { mount: mountPlayer } = require('./check-player-resume.cjs');
const mount = options => mountPlayer({ ...options, props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 }, setEpisodesOpen() {} } });
const tick = (ui, time) => {
  ui.media.currentTime = time;
  ui.find(n => n.type === 'video').props.onTimeUpdate?.({ currentTarget: ui.media });
};
(async () => {
  let finish;
  const ui = mount({ prepare: p => p.prefetch ? new Promise(r => { finish = r; }) : { success: true, url: 'hongguo-stream://one' } });
  await ui.flush(); ui.metadata();
  assert.equal(ui.button('缓存后续 2 集').props['aria-pressed'], true, 'restored playback shortcut reflects the cache preference');
  assert.equal(ui.button('缓存后续 2 集').props.style.whiteSpace, 'nowrap', 'two-ahead cache label must stay on one line');
  assert.equal(ui.media.currentTime, 0);
  assert.equal(ui.prepares.length, 2, 'opening episode one must immediately prefetch episode two');
  tick(ui, 1); tick(ui, 2); await ui.flush();
  assert.equal(ui.prepares.length, 2, 'repeated playback events must not duplicate prefetch');
  assert.equal(ui.prepares[1].prefetch, true);
  ui.find(n => n.type === 'video').props.onEnded(); await ui.flush();
  assert.equal(ui.prepares.length, 2, 'auto-next adopts the running preparation');
  assert.ok(!ui.releases.some(r => r.requestId === ui.prepares[1].requestId));
  finish({ success: true, url: 'hongguo-stream://next', streamId: 'next' }); await ui.flush();
  assert.equal(ui.find(n => n.type === 'video').props.src, 'hongguo-stream://next'); ui.unmount();
  for (const options of [{ local: true }, { settings: { cache_next_episode: false } }, { lockedIndexes: [2] }]) {
    const disabled = mount(options); await disabled.flush(); disabled.metadata();
    tick(disabled, 90); await disabled.flush();
    assert.ok(!disabled.prepares.some(p => p.prefetch)); disabled.unmount();
  }
  const changedSettings = { cache_next_episode: true };
  const cancel = mount({ apiOverrides: { getSettings: async () => changedSettings }, prepare: p => p.prefetch ? new Promise(() => {}) : { success: true, url: 'hongguo-stream://one' } });
  await cancel.flush(); cancel.metadata(); tick(cancel, 90); await cancel.flush();
  cancel.props.active = false; await cancel.flush();
  changedSettings.cache_next_episode = false; cancel.props.active = true; await cancel.flush();
  assert.ok(cancel.releases.some(r => r.requestId === cancel.prepares[1].requestId)); cancel.unmount();
  let now = Date.now();
  const failed = mount({ now: () => now, prepare: p => p.prefetch ? { success: false, error: 'offline' } : { success: true, url: 'hongguo-stream://normal' } });
  await failed.flush(); failed.metadata(); await failed.flush();
  const attempts = failed.prepares.filter(p => p.prefetch);
  assert.deepEqual(attempts.map(p => p.quality), ['1080p', '720p', 'auto'], 'failed automatic prefetch must try exactly three qualities');
  assert.equal(new Set(attempts.map(p => p.requestId)).size, 1, 'all quality attempts must belong to the same cancellable request');
  tick(failed, 90); tick(failed, 91); await failed.flush();
  now += 14000; tick(failed, 92); await failed.flush();
  assert.equal(failed.prepares.length, 4, 'failed prefetch must not loop within the cooldown');
  failed.episode(2); await failed.flush();
  assert.equal(failed.prepares.length, 5, 'manual playback must submit only one fresh request after prefetch failure');
  assert.equal(failed.prepares.at(-1).vidIndex, 2);
  assert.equal(failed.prepares.at(-1).quality, '1080p');
  assert.equal(failed.prepares.at(-1).prefetch, undefined, 'manual playback must leave the failed background request behind');
  failed.metadata(); await failed.flush();
  assert.equal(failed.find(n => n.type === 'video').props.src, 'hongguo-stream://normal');
  assert.equal(failed.media.paused, false, 'manual playback must resume normally'); failed.unmount();
  const chain = mount({ episodeCount: 3 });
  await chain.flush(); chain.metadata(); await chain.flush();
  assert.deepEqual(chain.prepares.filter(p => p.prefetch).map(p => p.vidIndex), [2, 3],
    'opening one episode must prefetch both following playable episodes');
  chain.episode(2); await chain.flush(); chain.metadata(); await chain.flush();
  assert.deepEqual(chain.prepares.filter(p => p.prefetch && p.vidIndex === 3).length, 1,
    'switching to episode two must reuse episode three preparation without duplicating it');
  chain.unmount();
  console.log('PASS next-cache: immediate trigger, reuse, skip, settings refresh, cancellation, failure fallback, next-episode chain');
})().catch(error => { console.error(error); process.exitCode = 1; });
