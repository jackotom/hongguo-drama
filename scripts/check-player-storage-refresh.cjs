// Component-only playback bookkeeping; no decoding, real media, network or user data.
const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');

(async () => {
  let storageReads = 0;
  let cacheReads = 0;
  const ui = mount({
    episodeCount: 4,
    props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
    apiOverrides: {
      getStorageUsage: async () => {
        storageReads++;
        return { success: true, series: [], totalFiles: 0, totalBytes: 0 };
      },
      onlineCacheStatus: async () => ({ success: true, count: ++cacheReads, bytes: cacheReads * 1024 }),
    },
  });
  try {
    await ui.flush();
    for (let episode = 1; episode <= 4; episode++) {
      ui.metadata();
      await ui.flush();
      assert.equal(ui.prepares.find(request => request.vidIndex === episode)?.vid, `v${episode}`);
      if (episode < 4) {
        ui.find(node => node.type === 'video').props.onEnded();
        await ui.flush();
      }
    }
    assert.ok(cacheReads >= 8, 'initial state, four plays and three prefetches must still refresh online cache');
    assert.equal(storageReads, 1, `four-episode playback scanned download storage ${storageReads} times; only initial management data needs a scan`);
    console.log(`PASS four-episode playback: ${cacheReads} online cache refreshes, ${storageReads} download storage scan`);
  } finally {
    ui.unmount();
  }
  for (const paused of [true, false]) {
    let fileUrl = 'file:///before-nas.mp4';
    const moved = mount({local:true,apiOverrides:{getSeriesEpisodes:async()=>({success:true,data:{series_id:'A',series_title:'Fixture',total:1,
      episodes:[{vid:'v1',vid_index:1,status:'completed',fileUrl,savePath:fileUrl.slice(7)}]}})}});
    try {
      await moved.flush(); moved.metadata();
      moved.media.currentTime = 34;
      moved.media.paused = paused;
      fileUrl = 'file:///after-nas.mp4';
      moved.historyUpdated({});
      for (const timer of [...moved.timers.values()]) if(timer.delay===2000)await timer.fn();
      await moved.flush(); moved.metadata();
      assert.equal(moved.media.currentTime,34,'NAS relocation must retain playback position');
      assert.equal(moved.media.paused,paused,'NAS relocation must retain pause state');
    } finally { moved.unmount(); }
  }
  console.log('PASS NAS relocation preserves the current episode position and pause/play intent');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
