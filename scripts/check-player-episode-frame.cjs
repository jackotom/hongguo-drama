// Run: node scripts/check-player-episode-frame.cjs
// In-memory frame/event checks only: no media playback, network or user files.
const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');

async function fixture(options = {}) {
  const ui = mount({ local: true, episodeCount: 3, settings: { cache_next_episode: false }, ...options });
  await ui.flush();
  ui.metadata();
  await ui.flush();
  ui.media.readyState = 2;
  ui.media.videoHeight = 360;
  ui.media.muted = true;
  const frames = new Map(), cancelled = [], draws = [];
  let frameId = 0;
  ui.media.requestVideoFrameCallback = callback => { frames.set(++frameId, callback); return frameId; };
  ui.media.cancelVideoFrameCallback = id => { cancelled.push(id); frames.delete(id); };
  const node = () => ui.find(n => n.type === 'canvas' && n.props.className === 'player-transition-frame');
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: video => draws.push(video.src) }) };
  if (node()) node().props.ref.current = canvas;
  return { ui, frames, cancelled, draws, canvas,
    held: () => node()?.props.style?.visibility === 'visible',
    present: async () => {
      const [id, callback] = [...frames].at(-1) || [];
      assert(callback, 'new source must wait for an actual presented video frame');
      frames.delete(id);
      ui.media.readyState = 2;
      callback();
      await ui.flush();
    },
  };
}

(async () => {
  const local = await fixture();
  try {
    const oldSource = local.ui.media.src;
    local.ui.episode(2); await local.ui.flush();
    assert(local.held(), 'switching src must retain the old picture throughout first-frame decoding');
    assert.deepEqual(local.draws, [oldSource], 'capture must happen before src/load clears the decoded frame');
    local.ui.metadata(); await local.ui.flush();
    assert(local.held(), 'metadata/playing alone must not reveal an undecoded source');
    const staleFrame = [...local.frames.values()].at(-1);
    local.ui.episode(3); await local.ui.flush();
    staleFrame(); await local.ui.flush();
    assert(local.held(), 'a superseded episode frame must not clear the retained picture');
    local.ui.metadata(); await local.ui.flush();
    await local.present();
    assert(!local.held(), 'new presented frame must remove the cover');
    assert(local.cancelled.length > 0, 'superseded frame callbacks must be cancelled');

    const sourceBeforeReload = local.ui.media.src;
    const load = local.ui.media.load;
    let reloads = 0;
    local.ui.media.load = () => { reloads++; load(); };
    local.ui.episode(3); await local.ui.flush();
    assert.equal(reloads, 1, 'same-source retry must exercise the forced DOM src/load path');
    assert.equal(local.ui.media.src, sourceBeforeReload);
    assert.equal(local.ui.media.readyState, 0, 'forced load must clear the video decoder');
    assert.equal(local.draws.at(-1), sourceBeforeReload, 'capture must precede the forced reload');
    assert(local.held(), 'forced reload black frame must remain covered');
    local.ui.metadata(); await local.ui.flush();
    local.ui.media.readyState = 2;
    await local.ui.flush();
    assert(local.held(), 'readiness alone must not clear the cover before frame submission');
    await local.present();
    assert(!local.held(), 'forced reload cover must clear on the new submitted frame');
  } finally { local.ui.unmount(); }

  let finishPrepare;
  const online = await fixture({ local: false, props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
    prepare: p => p.vidIndex === 2 ? new Promise(resolve => { finishPrepare = resolve; })
      : { success: true, url: `hongguo-stream://episode-${p.vidIndex}` } });
  try {
    online.ui.episode(2); await online.ui.flush();
    assert(online.held(), 'online preparation must retain the previous episode picture');
    assert(online.ui.find(n => n.props.className?.includes('player-placeholder-over-frame')),
      'the preparation overlay must let the retained picture show through');
    finishPrepare({ success: true, url: 'hongguo-stream://episode-2' }); await online.ui.flush();
    online.ui.metadata(); await online.ui.flush();
    assert(online.held(), 'preparation completion must not remove the frame early');
    await online.present();
    assert(!online.held());
    online.ui.media.readyState = 2;
    online.ui.episode(3); await online.ui.flush();
    online.ui.props.target = { seriesId: 'B', vidIndex: 1, ts: 2 };
    online.ui.render(); await online.ui.flush();
    assert(!online.held(), 'switching dramas must discard the unrelated retained picture');
  } finally { online.ui.unmount(); }

  const ended = await fixture({ settings: { cache_next_episode: false, auto_delete_watched: true },
    apiOverrides: { cleanupWatchedEpisode: async () => ({ success: true, count: 0 }) } });
  try {
    const oldSource = ended.ui.media.src;
    ended.ui.media.currentTime = ended.ui.media.duration;
    ended.ui.find(n => n.type === 'video').props.onEnded(); await ended.ui.flush();
    assert(ended.held(), 'auto-delete must capture the ending frame before releasing the old file');
    assert.deepEqual(ended.draws, [oldSource]);
    ended.ui.metadata(); await ended.ui.flush();
    await ended.present();
    assert(!ended.held());
  } finally { ended.ui.unmount(); }

  const paused = await fixture();
  try {
    delete paused.ui.media.requestVideoFrameCallback;
    delete paused.ui.media.cancelVideoFrameCallback;
    paused.ui.episode(2); await paused.ui.flush();
    paused.ui.metadata(); await paused.ui.flush();
    paused.ui.media.pause();
    paused.ui.mediaEvents.get('loadeddata')(); await paused.ui.flush();
    assert(paused.held(), 'fallback must still wait for decoded image data');
    paused.ui.media.readyState = 2;
    paused.ui.mediaEvents.get('loadeddata')(); await paused.ui.flush();
    assert(!paused.held(), 'a paused decoded frame must also remove the cover');
    paused.ui.episode(3); await paused.ui.flush();
    paused.ui.unmount();
    assert(!paused.ui.mediaEvents.has('loadeddata'), 'unmount must remove first-frame listeners');
  } finally { paused.ui.unmount(); }
  console.log('PASS episode frame handoff: local, forced DOM reload, online preparation, first-frame timing, rapid switching, series isolation, auto-delete and paused fallback');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
