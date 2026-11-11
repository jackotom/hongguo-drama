// Offline renderer and main IPC regressions; no user data or external media.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { mount } = require('./check-player-resume.cjs');
const localFiles = require('../src/native/media-access').createMediaAccess();
const poll = async ui => { await [...ui.timers.values()].find(t => t.delay === 2000).fn(); await ui.flush(); };
const select = ui => ui.find(n => n.type === 'select' && n.props['aria-label'] === '在线播放清晰度');
const alert = ui => ui.find(n => n.props.role === 'alert');
const text = n => typeof n === 'string' ? n : n?.children?.map(text).join('') || '';
function localChoiceFixture({ waited = false, actualQuality = '720p', prepare } = {}) {
  let finished, refresh;
  const downloads = [], storage = new Map([['hongguo:online-quality', '1080p']]);
  const episode = { vid: 'v1', vid_index: 1, locked: false, taskId: 't1', fileSize: 200000,
    status: waited ? 'pending' : 'completed', fileUrl: localFiles.localUrl('/mock/downloaded-1.mp4'), actualQuality };
  const detail = sid => ({ success: true, data: { series_id: sid, episodes: [
    { ...episode }, { vid: 'v2', vid_index: 2, status: 'missing' },
  ] } });
  const ui = mount({ storage, settings: { cache_next_episode: false },
    props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
    prepare: prepare || (async () => ({ success: false, error: '取源失败' })),
    apiOverrides: {
      getSeriesEpisodes: sid => refresh ? refresh(sid) : Promise.resolve(detail(sid)),
      onDownloadCompleted: fn => { finished = fn; return () => {}; },
      downloadSingleEpisode: async (...args) => { downloads.push(args); return { success: false, error: '不得重复下载完整文件' }; },
    } });
  return { ui, episode, downloads, storage, detail,
    refreshWith: fn => { refresh = fn; },
    finish: async () => { episode.status = 'completed'; finished?.({ id: 't1' }); await poll(ui); } };
}
let failures = 0;
async function check(name, fn) {
  if (process.argv[2] && process.argv[2] !== 'main' && !name.includes(process.argv[2])) return;
  try { await fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
}
(async () => {
if (process.argv[2] !== 'main') {
  await check('old computer choice persists and prefetch uses compatible source selection', async () => {
    const storage = new Map();
    const ui = mount({ storage, props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } } });
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 24; ui.media.paused = true;
      select(ui).props.onChange({ target: { value: 'compat' } }); await ui.flush();
      assert.equal(select(ui).props.value, 'compat');
      assert.equal(storage.get('hongguo:online-quality'), 'compat');
      assert.equal(ui.prepares.at(-1).quality, 'auto', 'do not request HEVC-only 1080 tier');
      ui.metadata(); await ui.flush();
      assert.equal(ui.media.currentTime, 24); assert.equal(ui.media.paused, true);
      await ui.media.play(); await ui.flush();
      assert.equal(ui.prepares.filter(p => p.prefetch).at(-1).quality, 'auto');
      ui.episode(2); await ui.flush();
      assert.equal(select(ui).props.value, 'compat'); assert.equal(ui.transcodes.length, 0);
    } finally { ui.unmount(); }
    const reopened = mount({ storage, props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } } });
    try { await reopened.flush(); assert.equal(select(reopened).props.value, 'compat'); assert.equal(reopened.prepares[0].quality, 'auto'); }
    finally { reopened.unmount(); }
  });
  await check('old computer mode converts known HEVC before exposing the original video', async () => {
    const storage = new Map([['hongguo:online-quality', 'compat']]);
    let finish;
    const ui = mount({ storage, props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: async () => ({ success: true, url: 'hongguo-stream://hevc', codec: 'bytevc1' }),
      transcode: () => new Promise(resolve => { finish = resolve; }) });
    try {
      await ui.flush();
      assert.equal(ui.transcodes.length, 1, 'convert without waiting for a black frame or media error');
      assert.equal(ui.transcodes[0].quality, 'auto'); assert.equal(ui.transcodes[0].filePath, null);
      assert.notEqual(ui.find(n => n.type === 'video')?.props.src, 'hongguo-stream://hevc');
      finish({ success: true, url: 'file:///compatible.mp4' }); await ui.flush();
      assert.equal(ui.find(n => n.type === 'video').props.src, 'file:///compatible.mp4');
      ui.metadata(); await ui.flush(); ui.episode(2); await ui.flush();
      assert.equal(ui.transcodes.length, 2, 'next episode uses the same proactive path');
    } finally { ui.unmount(); }
  });
  await check('old computer mode respects disabled automatic conversion and retains downloaded originals', async () => {
    const storage = new Map([['hongguo:online-quality', 'compat']]);
    const local = mount({ local: true, storage });
    try { await local.flush(); assert.equal(local.prepares.length, 0); assert.equal(local.find(n => n.type === 'video').props.src, 'file:///mock-1.mp4'); }
    finally { local.unmount(); }
    const disabled = mount({ storage, settings: { compat_mode: false }, props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: async () => ({ success: true, url: 'hongguo-stream://hevc', codec: 'hevc' }) });
    try { await disabled.flush(); assert.equal(disabled.transcodes.length, 0); assert.equal(disabled.find(n => n.type === 'video').props.src, 'hongguo-stream://hevc'); }
    finally { disabled.unmount(); }
  });
  await check('old computer proactive conversion cancels cleanly and ignores a late previous episode', async () => {
    let finish;
    const ui = mount({ storage: new Map([['hongguo:online-quality', 'compat']]),
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: async p => ({ success: true, url: `hongguo-stream://episode-${p.vidIndex}`, codec: p.vidIndex === 1 ? 'hevc' : 'h264' }),
      transcode: () => new Promise(resolve => { finish = resolve; }) });
    try {
      await ui.flush(); assert.equal(ui.transcodes.length, 1);
      ui.episode(2); await ui.flush();
      assert.equal(ui.cancelled[0].requestId, ui.transcodes[0].requestId);
      finish({ success: true, url: 'file:///stale-compat.mp4' }); await ui.flush();
      assert.equal(ui.find(n => n.type === 'video').props.src, 'hongguo-stream://episode-2');
      assert.equal(ui.transcodes.length, 1, 'H.264 must play directly');
    } finally { ui.unmount(); }
  });
  await check('old computer conversion failure is bounded and downloads with compatible quality', async () => {
    const downloads = [];
    const ui = mount({ storage: new Map([['hongguo:online-quality', 'compat']]),
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: async () => ({ success: true, url: 'hongguo-stream://hevc', codec: 'hevc' }),
      transcode: async () => ({ success: false, error: 'conversion failed' }),
      apiOverrides: { downloadSingleEpisode: async (...args) => { downloads.push(args); return { success: false, error: 'download failed' }; } } });
    try {
      await ui.flush(); await ui.flush();
      assert.equal(ui.transcodes.length, 2, 'one original and one refreshed source, then stop');
      assert.equal(ui.prepares.length, 2); assert.deepEqual(downloads, [['A', 1, 'auto']]);
      assert.ok(alert(ui));
    } finally { ui.unmount(); }
  });
  await check('automatic playback requests 1080 first and prepares the next episode at 1080', async () => {
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } } });
    try {
      await ui.flush(); assert.equal(ui.prepares[0].quality, '1080p');
      assert.match(text(select(ui)), /1080[Pp]/);
      ui.metadata(); await ui.flush();
      assert(ui.prepares.some(p => p.prefetch && p.quality === '1080p'));
    } finally { ui.unmount(); }
  });
  for (const failure of ['response', 'throw']) await check(`${failure} 1080 preparation failure automatically selects 720 without downloading`, async () => {
    const downloads = [];
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: async p => {
        if (p.quality === '1080p') {
          if (failure === 'throw') throw Error('1080 unavailable');
          return { success: false, error: '1080 unavailable' };
        }
        return { success: true, url: 'hongguo-stream://720' };
      }, apiOverrides: { downloadSingleEpisode: async (...args) => { downloads.push(args); return { success: true }; } } });
    try {
      await ui.flush(); assert.deepEqual(ui.prepares.map(p => p.quality), ['1080p', '720p']);
      assert.equal(downloads.length, 0); assert.equal(ui.find(n => n.type === 'video').props.src, 'hongguo-stream://720');
      assert.equal(select(ui).props.value, 'auto', 'fallback must not overwrite the saved automatic choice');
    } finally { ui.unmount(); }
  });
  for (const code of [2, 3, 4]) await check(`automatic runtime media error ${code} advances quality and preserves paused position`, async () => {
    const downloads = [];
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, settings: { cache_next_episode: false },
      transcode: async () => ({ success: false, error: 'decoder cannot recover this quality' }),
      apiOverrides: { downloadSingleEpisode: async (...args) => { downloads.push(args); return { success: false, error: 'No source' }; } } });
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 31; ui.media.pause();
      ui.error(code); await ui.flush(); assert.equal(ui.prepares.at(-1).quality, '720p');
      ui.metadata(); assert.equal(ui.media.currentTime, 31); assert.equal(ui.media.paused, true);
      ui.error(code); await ui.flush(); assert.equal(ui.prepares.at(-1).quality, 'auto');
      ui.metadata(); assert.equal(ui.media.currentTime, 31); assert.equal(ui.media.paused, true);
      assert.deepEqual(ui.prepares.map(p => p.quality), ['1080p', '720p', 'auto']);
      if (code !== 3) { ui.error(code); await ui.flush(); assert.equal(downloads.length, 1); }
      assert.equal(ui.prepares.length, 3, 'exhaustion must not restart the 1080 ladder');
    } finally { ui.unmount(); }
  });
  await check('late automatic quality failure cannot affect a newly selected episode', async () => {
    let failFirst;
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: p => p.vidIndex === 1 ? new Promise(resolve => { failFirst = resolve; })
        : Promise.resolve({ success: true, url: 'hongguo-stream://second' }) });
    try {
      await ui.flush(); ui.episode(2); await ui.flush();
      failFirst({ success: false, error: 'late failure' }); await ui.flush();
      assert.equal(ui.find(n => n.type === 'video').props.src, 'hongguo-stream://second');
      assert.equal(ui.prepares.filter(p => p.vidIndex === 1).length, 1);
      assert.equal(ui.prepares.at(-1).quality, '1080p');
    } finally { ui.unmount(); }
  });
  await check('automatic exhaustion submits one 1080-priority download and explicit retry restarts at 1080', async () => {
    const downloads = [];
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: async () => ({ success: false, error: 'No source' }),
      apiOverrides: { downloadSingleEpisode: async (...args) => { downloads.push(args); return { success: false, error: 'No download' }; } } });
    try {
      await ui.flush(); assert.deepEqual(ui.prepares.map(p => p.quality), ['1080p', '720p', 'auto']);
      assert.equal(downloads.length, 1); assert.equal(downloads[0][2], '1080p');
      await ui.button('重试本集').props.onClick(); await ui.flush();
      assert.deepEqual(ui.prepares.slice(3).map(p => p.quality), ['1080p', '720p', 'auto']);
      assert.equal(downloads.length, 2);
    } finally { ui.unmount(); }
  });
  await check('automatic quality handoff retains autoplay and restarting an episode prefers 1080 again', async () => {
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, settings: { cache_next_episode: false } });
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 19;
      ui.error(2); await ui.flush(); ui.metadata();
      assert.equal(ui.media.currentTime, 19); assert.equal(ui.media.paused, false);
      ui.episode(2); await ui.flush(); assert.equal(ui.prepares.at(-1).quality, '1080p');
    } finally { ui.unmount(); }
  });
  await check('late automatic failure cannot downgrade a new manual quality choice', async () => {
    let failAutomatic;
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: p => p.quality === '1080p' ? new Promise(resolve => { failAutomatic = resolve; })
        : Promise.resolve({ success: true, url: 'hongguo-stream://manual-720' }) });
    try {
      await ui.flush(); select(ui).props.onChange({ target: { value: '720p' } }); await ui.flush();
      failAutomatic({ success: false, error: 'late 1080 failure' }); await ui.flush();
      assert.equal(select(ui).props.value, '720p');
      assert.equal(ui.find(n => n.type === 'video').props.src, 'hongguo-stream://manual-720');
      assert.deepEqual(ui.prepares.map(p => p.quality), ['1080p', '720p']);
    } finally { ui.unmount(); }
  });
  await check('decoder exhaustion reaches one download after all automatic quality steps', async () => {
    let downloads = 0;
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, settings: { cache_next_episode: false },
      transcode: async () => ({ success: false, error: 'decoder unavailable' }),
      apiOverrides: { downloadSingleEpisode: async () => { downloads++; return { success: false, error: 'download failed' }; } } });
    try {
      await ui.flush();
      for (let i = 0; i < 3; i++) { ui.metadata(); ui.error(3); await ui.flush(); }
      assert.deepEqual(ui.prepares.map(p => p.quality), ['1080p', '720p', 'auto']);
      assert.equal(downloads, 1); assert(alert(ui));
    } finally { ui.unmount(); }
  });
  await check('automatic 1080 decoding can retain quality through compatibility before downgrading', async () => {
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, settings: { cache_next_episode: false } });
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 21; ui.error(3); await ui.flush();
      assert.equal(ui.transcodes.length, 1); assert.equal(ui.transcodes[0].quality, '1080p');
      assert.deepEqual(ui.prepares.map(p => p.quality), ['1080p']);
      ui.metadata(); assert.equal(ui.media.currentTime, 21);
      ui.error(3); await ui.flush(); ui.metadata(); ui.error(3); await ui.flush();
      assert.equal(ui.transcodes.length, 2, 'one compatibility rebuild is retained');
      assert.equal(ui.prepares.at(-1).quality, '720p', 'exhausted compatibility must still advance quality');
    } finally { ui.unmount(); }
  });
  await check('automatic decoder failure changes quality when compatibility is disabled', async () => {
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      settings: { cache_next_episode: false, compat_mode: false } });
    try {
      await ui.flush(); ui.metadata(); ui.error(3); await ui.flush();
      assert.equal(ui.prepares.at(-1).quality, '720p'); assert.equal(ui.transcodes.length, 0);
    } finally { ui.unmount(); }
  });
  for (const local of [false, true]) await check(`compatible media keeps its quality step and exhausts recovery once (${local ? 'local first' : 'online'})`, async () => {
    let downloads = 0;
    const ui = mount({ local, props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, settings: { cache_next_episode: false },
      apiOverrides: { downloadSingleEpisode: async () => { downloads++; return { success: false, error: 'download unavailable' }; } } });
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 21; ui.media.pause();
      for (let attempt = 0; attempt < 18; attempt++) {
        ui.error(3); await ui.flush(); ui.metadata();
      }
      assert.deepEqual(ui.prepares.map(p => p.quality), ['1080p', '720p', 'auto'], 'decoder recovery must reach the final tier without repeating 720P');
      assert.deepEqual(ui.transcodes.map(p => p.quality), [...(local ? ['auto', 'auto'] : []), '1080p', '1080p', '720p', '720p', 'auto', 'auto'], 'a forced compatibility rebuild must retain the selected tier');
      assert.equal(downloads, 0, 'a persistent decoder failure must stop for explicit recovery');
      assert(ui.button('重试本集'));
      assert.equal(ui.media.paused, true);
      assert.equal(ui.media.currentTime, 21);
    } finally { ui.unmount(); }
  });
  await check('third-party online playback never requests unsupported 1080 or 720 tiers', async () => {
    const ui = mount({ props: { target: { seriesId: 'xifan:A', vidIndex: 1, ts: 1 } }, seriesId: 'xifan:A' });
    try { await ui.flush(); assert.deepEqual(ui.prepares.map(p => p.quality), ['auto']); }
    finally { ui.unmount(); }
  });
  await check('scheduled source retry stays waiting and terminal error remains visible', async () => {
    let status = 'missing', retryAt = null, error = '';
    let failed;
    const ui = mount({ props: {target:{seriesId:'A',vidIndex:1,ts:1}}, prepare: async()=>({success:false,error:'取源失败'}),
      apiOverrides: { onDownloadFailed: fn => { failed = fn; return () => {}; },
        getSeriesEpisodes: async()=>({success:true,data:{series_id:'A',episodes:[{vid:'v1',vid_index:1,status,retryAt,error}]}}),
        downloadSingleEpisode: async()=>{status='pending';return {success:true};} } });
    await ui.flush(); status='failed'; retryAt=Date.now()+5000; error='官网限流，等待自动重试'; failed?.({id:'t1'}); await poll(ui);
    assert(ui.button('取消等待'), 'scheduled retry must retain playback intent');
    retryAt=null; error='当前片源没有 1080P，未自动降级'; failed?.({id:'t1'}); await poll(ui);
    assert.equal(ui.button('取消等待'),undefined); assert.match(text(alert(ui)),/当前片源没有 1080P/); ui.unmount();
  });
  for (const waited of [false, true]) for (const actualQuality of ['720p', '']) {
    await check(`local choice requires consent for ${waited ? 'waited' : 'existing'} ${actualQuality || 'unknown'} file`, async () => {
      const f = localChoiceFixture({ waited, actualQuality }), { ui } = f;
      try {
        await ui.flush();
        assert.equal(ui.prepares[0].quality, '1080p', 'normal fixed quality still tries online first');
        if (waited) { assert(ui.button('取消等待')); await f.finish(); }
        assert(alert(ui));
        assert.match(text(alert(ui)), actualQuality ? /720P.*1080P/ : /尚未确认.*1080P/);
        assert.notEqual(ui.find(n => n.type === 'video')?.props.src, f.episode.fileUrl, 'never downgrade automatically');
        assert.equal(f.downloads.length, 0, 'existing or pending tasks must not be resubmitted');
        const choose = ui.button('播放已有本地文件');
        assert(choose, 'offer explicit local playback after fixed-quality failure');
        await choose.props.onClick(); await ui.flush(); ui.metadata();
        assert.equal(ui.find(n => n.type === 'video')?.props.src, f.episode.fileUrl);
        assert.equal(alert(ui), undefined);
        assert.equal(select(ui).props.value, '1080p');
        assert.equal(f.storage.get('hongguo:online-quality'), '1080p');
        assert.equal(f.downloads.length, 0);
        assert.equal(ui.prepares.length, 1, 'choosing local must not reconnect online');
      } finally { ui.unmount(); }
    });
  }
  await check('local choice restores paused position after an online runtime failure', async () => {
    let attempts = 0;
    const f = localChoiceFixture({ prepare: async () => ++attempts === 1
      ? { success: true, url: 'hongguo-stream://first' } : { success: false, error: '取源失败' } });
    const { ui } = f;
    try {
      await ui.flush(); ui.metadata(); ui.media.currentTime = 27; ui.media.pause();
      ui.error(2); await ui.flush();
      assert(ui.button('播放已有本地文件'));
      await ui.button('播放已有本地文件').props.onClick(); await ui.flush(); ui.metadata();
      assert.equal(ui.media.currentTime, 27); assert.equal(ui.media.paused, true);
      assert.equal(f.downloads.length, 0);
    } finally { ui.unmount(); }
  });
  await check('local choice revalidates episode, registration and complete file before granting playback', async () => {
    for (const change of [
      { locked: true }, { status: 'downloading' }, { status: 'missing' }, { fileUrl: '' },
      { fileUrl: 'https://media.example/other.mp4' }, { fileUrl: localFiles.localUrl('/mock/replacement.mp4') },
      { vid: 'other' }, { vid_index: 2 }, { taskId: 'other' }, { fileSize: 300000 },
    ]) {
      const f = localChoiceFixture(), { ui } = f;
      try {
        await ui.flush(); const choose = ui.button('播放已有本地文件'); assert(choose);
        Object.assign(f.episode, change);
        await choose.props.onClick(); await ui.flush();
        assert(alert(ui), JSON.stringify(change));
        assert.match(ui.text(), /本地文件状态已变化/);
        assert(!ui.find(n => n.props.available === true), 'changed or incomplete file must not be played');
        assert.equal(f.downloads.length, 0);
      } finally { ui.unmount(); }
    }
    const f = localChoiceFixture();
    try {
      await f.ui.flush();
      f.refreshWith(async () => f.detail('other-series'));
      await f.ui.button('播放已有本地文件').props.onClick(); await f.ui.flush();
      assert(alert(f.ui)); assert(!f.ui.find(n => n.props.available === true));
    } finally { f.ui.unmount(); }
  });
  await check('local choice is hidden for locked, incomplete and non-file registrations', async () => {
    for (const change of [{ locked: true }, { status: 'pending' }, { fileUrl: '' },
      { fileUrl: 'hongguo-stream://unregistered' }, { fileUrl: 'file:///unregistered.mp4' }]) {
      const f = localChoiceFixture(); Object.assign(f.episode, change);
      try { await f.ui.flush(); assert.equal(f.ui.button('播放已有本地文件'), undefined, JSON.stringify(change)); }
      finally { f.ui.unmount(); }
    }
  });
  await check('late local choice cannot override an episode, series, quality or navigation change', async () => {
    for (const action of ['episode', 'series', 'quality', 'hide']) {
      const f = localChoiceFixture(), { ui } = f;
      try {
        await ui.flush(); let finish;
        f.refreshWith(() => new Promise(resolve => { finish = resolve; }));
        const choosing = ui.button('播放已有本地文件').props.onClick();
        const complete = finish;
        f.refreshWith(async sid => f.detail(sid));
        if (action === 'episode') ui.episode(2);
        if (action === 'series') { ui.props.target = { seriesId: 'B', vidIndex: 1, ts: 2 }; ui.render(); }
        if (action === 'quality') select(ui).props.onChange({ target: { value: '720p' } });
        if (action === 'hide') { ui.props.active = false; ui.render(); }
        await ui.flush(); const prepares = ui.prepares.length;
        complete(f.detail('A')); await choosing; await ui.flush();
        assert.equal(ui.prepares.length, prepares);
        assert(!ui.text().includes('已选择播放本集已有本地文件'), action);
        if (action === 'quality') assert.equal(select(ui).props.value, '720p');
        else assert(!ui.find(n => n.props.available === true), action);
      } finally { ui.unmount(); }
    }
  });
  await check('local choice grant expires on quality, episode and series changes', async () => {
    for (const action of ['quality', 'episode', 'series']) {
      const f = localChoiceFixture(), { ui } = f;
      try {
        await ui.flush(); await ui.button('播放已有本地文件').props.onClick(); await ui.flush(); ui.metadata();
        assert(ui.find(n => n.props.available === true));
        const before = ui.prepares.length;
        if (action === 'quality') {
          select(ui).props.onChange({ target: { value: '720p' } }); await ui.flush();
          select(ui).props.onChange({ target: { value: '1080p' } });
        }
        if (action === 'episode') { ui.episode(2); await ui.flush(); ui.episode(1); }
        if (action === 'series') {
          ui.props.target = { seriesId: 'B', vidIndex: 1, ts: 2 }; ui.render(); await ui.flush();
          ui.props.target = { seriesId: 'A', vidIndex: 1, ts: 3 }; ui.render();
        }
        await ui.flush(); assert(ui.prepares.length > before, action);
        assert.equal(ui.prepares.at(-1).quality, '1080p'); assert(alert(ui));
        assert(!ui.find(n => n.props.available === true));
        assert(!f.downloads.some(args => args[1] === 1), 'never redownload the completed episode');
      } finally { ui.unmount(); }
    }
  });
  await check('local choice grant expires on file changes, stopping and quality changes while locked', async () => {
    for (const action of ['file', 'stop', 'locked-quality']) {
      const f = localChoiceFixture(), { ui } = f;
      try {
        await ui.flush(); await ui.button('播放已有本地文件').props.onClick(); await ui.flush(); ui.metadata();
        if (action === 'file') { f.episode.fileUrl = localFiles.localUrl('/mock/replacement.mp4'); await f.finish(); }
        else if (action === 'locked-quality') {
          f.episode.locked = true; await f.finish();
          select(ui).props.onChange({ target: { value: '1080p' } }); await ui.flush();
          f.episode.locked = false; await f.finish();
        } else {
          ui.find(n => n.type === 'video').props.onWaiting(); await ui.flush();
          ui.button('取消播放').props.onClick(); await ui.flush();
          await ui.button('重试本集').props.onClick(); await ui.flush();
        }
        assert(!ui.find(n => n.props.available === true), action);
        assert.equal(f.downloads.length, 0);
        assert.equal(select(ui).props.value, '1080p');
      } finally { ui.unmount(); }
    }
  });
  await check('local choice never reopens a rejected file or requeues it automatically', async () => {
    const f = localChoiceFixture(), { ui } = f;
    try {
      await ui.flush(); await ui.button('播放已有本地文件').props.onClick(); await ui.flush(); ui.metadata();
      ui.error(2); await ui.flush(); await poll(ui);
      assert(alert(ui)); assert.equal(ui.button('播放已有本地文件'), undefined);
      const prepares = ui.prepares.length;
      await poll(ui); await poll(ui);
      assert.equal(ui.prepares.length, prepares); assert.equal(f.downloads.length, 0);
    } finally { ui.unmount(); }
  });
  for (const qualities of [['720p'], ['720p', '1080p']]) {
    await check(`local choice intent is revoked while locked (${qualities.join(' then ')})`, async () => {
      const f = localChoiceFixture({ actualQuality: '' }), { ui } = f;
      try {
        await ui.flush(); const stale = f.detail('A'); let complete;
        f.refreshWith(() => new Promise(resolve => { complete = resolve; }));
        const choosing = ui.button('播放已有本地文件').props.onClick();
        f.refreshWith(async sid => f.detail(sid));
        f.episode.locked = true; await f.finish();
        assert.equal(ui.button('播放已有本地文件'), undefined, 'concurrent refresh must observe the lock');
        const before = ui.prepares.length;
        for (const quality of qualities) { select(ui).props.onChange({ target: { value: quality } }); await ui.flush(); }
        assert.equal(ui.prepares.length, before, 'locked quality changes must not start online playback');
        complete(stale); await choosing; await ui.flush();
        assert.equal(select(ui).props.value, qualities.at(-1));
        assert.equal(ui.prepares.length, before); assert.equal(f.downloads.length, 0);
        assert(!ui.find(n => n.props.available === true), 'revoked pending consent must not grant playback');
        assert.notEqual(ui.find(n => n.type === 'video')?.props.src, f.episode.fileUrl);
        assert(!ui.text().includes('已选择播放本集已有本地文件'), 'revoked consent must not show success');
      } finally { ui.unmount(); }
    });
  }
  await check('local choice intent still accepts an unchanged selection', async () => {
    const f = localChoiceFixture({ actualQuality: '' }), { ui } = f;
    try {
      await ui.flush(); const snapshot = f.detail('A'); let complete;
      f.refreshWith(() => new Promise(resolve => { complete = resolve; }));
      const choosing = ui.button('播放已有本地文件').props.onClick();
      complete(snapshot); await choosing; await ui.flush();
      assert(ui.find(n => n.props.available === true));
      assert.equal(ui.find(n => n.type === 'video')?.props.src, f.episode.fileUrl);
      assert(ui.text().includes('已选择播放本集已有本地文件'));
      assert.equal(select(ui).props.value, '1080p');
      assert.equal(f.downloads.length, 0); assert.equal(ui.prepares.length, 1);
    } finally { ui.unmount(); }
  });
  await check('local choice messages use the existing English translator', async () => {
    const english = require('../src/i18n/translator.mjs').createTranslator(
      require('../src/i18n/en.json'), require('../src/i18n/templates.json'));
    for (const message of ['播放已有本地文件', '本地文件状态已变化，请重新选择', '已选择播放本集已有本地文件，在线播放清晰度设置不变']) {
      assert.doesNotMatch(english(message), /[\u4e00-\u9fff]/);
    }
  });
  await check('online selection preserves time through prefetch, reconnect, transcode and episode switch', async()=>{
    const ui=mount({local:true}); await ui.flush(); ui.metadata(); ui.media.currentTime=24;
    assert(select(ui),'independent online quality selector required');
    select(ui).props.onChange({target:{value:'1080p'}}); await ui.flush();
    assert.equal(ui.prepares.at(-1).quality,'1080p'); ui.metadata(); assert.equal(ui.media.currentTime,24);
    ui.find(n=>n.type==='video').props.onTimeUpdate({currentTarget:ui.media}); await ui.flush();
    assert(ui.prepares.some(p=>p.prefetch && p.quality==='1080p'));
    ui.error(2); await ui.flush(); assert.equal(ui.prepares.at(-1).quality,'1080p');
    ui.metadata(); ui.error(3); await ui.flush(); assert.equal(ui.transcodes.at(-1).quality,'1080p'); assert.equal(ui.transcodes.at(-1).filePath,null);
    ui.episode(2); await ui.flush(); assert.equal(ui.prepares.at(-1).quality,'1080p'); ui.unmount();
  });
  await check('online fallback keeps explicit quality independent of download selection',async()=>{
    const downloads=[];
    const ui=mount({props:{target:{seriesId:'A',vidIndex:1,ts:1}},prepare:async()=>({success:false,error:'取源失败'}),settings:{download_quality:'720p'},
      apiOverrides:{downloadSingleEpisode:async(...p)=>{downloads.push(p);return {success:false,error:'片源不足1080P'};}}});
    await ui.flush(); assert.equal(downloads.at(-1)?.[2],'720p', 'automatic playback fallback uses the download default');
    assert(select(ui)); select(ui).props.onChange({target:{value:'1080p'}}); await ui.flush();
    assert.equal(ui.prepares.at(-1)?.quality,'1080p');
    assert.equal(downloads.at(-1)[2],'1080p'); assert.match(text(alert(ui)),/片源不足1080P/); ui.unmount();
  });
  await check('quality switching preserves files until the ended episode is cleaned',async()=>{
    const cleaned=[];
    const ui=mount({local:true,settings:{auto_delete_watched:true},apiOverrides:{cleanupWatchedEpisode:async(...p)=>{cleaned.push(p);return {success:true,count:1,freed:20};}}});
    try {
      await ui.flush(); select(ui).props.onChange({target:{value:'1080p'}}); await ui.flush(); ui.metadata();
      assert.equal(cleaned.length,0,'changing quality must not delete files before playback ends');
      ui.find(n=>n.type==='video').props.onEnded(); await ui.flush();
      assert.deepEqual(cleaned,[['A',1]],'cleanup must target the ended episode, never the next one');
      assert.equal(ui.prepares.at(-1).vidIndex,2); assert.equal(ui.prepares.at(-1).quality,'1080p');
    } finally { ui.unmount(); }
  });
  await check('remembered explicit quality skips unverified files and third-party keeps automatic playback',async()=>{
    const storage=new Map([['hongguo:online-quality','1080p']]);
    const ui=mount({local:true,storage}); await ui.flush();
    assert.equal(ui.prepares.at(-1)?.quality,'1080p'); ui.unmount();
    const third=mount({local:true,storage,seriesId:'xifan:A'}); await third.flush();
    assert(select(third).props.disabled); assert.equal(select(third).props.value,'auto');
    assert.equal(third.find(n=>n.type==='video').props.src,'file:///mock-1.mp4'); third.unmount();
  });
} else {
  const prefix=fs.readFileSync(path.join(__dirname,'check-download-quality-integration.cjs'),'utf8').split('const checks = [')[0];
  const module={exports:{}};
  vm.runInNewContext(prefix+'\nmodule.exports={fixture,dirs};',{module,require,__dirname,console,process,Buffer,URL,Response,Request,Headers,AbortController,setTimeout,clearTimeout});
  const {fixture,dirs}=module.exports;
  try {
    await check('online IPC retains codec through direct, prefetched and cached preparation without media URLs', async () => {
      const h = fixture();
      h.run("hongguo.fetchPlayUrlSingle = async () => ({ url: 'https://media.example/private-source.mp4', codec: 'hevc' });");
      for (const prefetch of [false, true, true]) {
        const result = await h.handlers['prepare-online-play']({}, { vid: '11', seriesId: '1', vidIndex: 1, quality: 'auto', prefetch });
        assert.equal(result.success, true); assert.equal(result.codec, 'hevc');
        assert.ok(!JSON.stringify(result).includes('media.example'));
      }
      h.context.clearOnlineCache();
    });
    await check('episode IPC exposes retry diagnostics and verified quality',async()=>{
      const h=fixture(); h.run("downloadTasks=[{id:'t',hongguoInfo:{series_id:'1',vid:'11',vid_index:1},savePath:'/absent',status:'failed',error:'真实错误',retryAt:123,actualQuality:'1080p'}]; collectSeriesEpisodeFiles=()=>({ordered:[]});");
      const ep=(await h.handlers['get-series-episodes']({},'1')).data.episodes[0];
      assert.equal(ep.retryAt,123); assert.equal(ep.error,'真实错误'); assert.equal(ep.actualQuality,'1080p');
    });
    await check('an existing verified download exposes quality to playback fallback',async()=>{
      const h=fixture(); const file=path.join(h.root,'existing.mp4'); fs.writeFileSync(file,Buffer.alloc(200000));
      h.context.existingFile=file;
      h.run("downloadTasks=[{id:'t',hongguoInfo:{series_id:'1',vid:'11',vid_index:1},savePath:existingFile,status:'completed',downloadQuality:'auto'}];");
      assert.equal((await h.handlers['download-single-episode']({},'1',1,'1080p')).success,true);
      assert.equal(h.run('downloadTasks[0].actualQuality'),'1080p');
    });
    await check('online IPC isolates quality cache and jobs while preserving automatic requests',async()=>{
      const h=fixture();
      const results=await Promise.all(['auto','720p','1080p'].map(quality=>h.handlers['prepare-online-play']({}, {vid:'11',seriesId:'1',vidIndex:1,quality,prefetch:true})));
      assert(results.every(r=>r.success));
      assert.deepEqual(Array.from(h.calls,c=>c[2].quality),['auto','720p','1080p']); assert.equal(h.run('onlineCache.size'),3);
      assert.equal((await h.handlers['prepare-online-play']({}, {vid:'11',quality:'bogus'})).success,false);
      assert.equal((await h.handlers['prepare-online-play']({}, {vid:'xifan:11',quality:'1080p'})).success,false);
      h.context.clearOnlineCache();
    });
    await check('explicit-quality complete cache survives upstream failure during download fallback',async()=>{
      const h=fixture();
      const prepared=await h.handlers['prepare-online-play']({}, {vid:'11',seriesId:'1',vidIndex:1,quality:'1080p',prefetch:true});
      assert.equal(prepared.success,true); assert.equal(h.run("onlineCache.get('11:1080p')?.complete"),true);
      h.run("unexpectedSources=0; hongguo.fetchPlayUrlSingle=async()=>{unexpectedSources++;throw new Error('上游不可用');};");
      assert.equal((await h.handlers['download-single-episode']({},'1',1,'1080p')).success,true);
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status,'completed'); assert.equal(h.saved()[0].actualQuality,'1080p');
      assert.equal(fs.statSync(h.saved()[0].savePath).size,200000); assert.equal(h.run('unexpectedSources'),0);
      h.context.clearOnlineCache();
    });
    await check('stream recovery preserves explicit quality before media begins',async()=>{
      const h=fixture(); h.context.streamHandlers={};
      h.run("mediaWithCors=handler=>handler;protocol.handle=(scheme,fn)=>streamHandlers[scheme]=fn;registerStreamProtocol();let attempts=0;requestMedia=async()=>{if(!attempts++)throw mediaTransferError('network');return {status:200,headers:{'content-length':'200000'},data:testReadStream()};};");
      const prepared=await h.handlers['prepare-online-play']({}, {vid:'11',seriesId:'1',vidIndex:1,quality:'1080p'});
      const response=await Object.values(h.context.streamHandlers)[0](new Request(prepared.url));
      assert.equal(response.status,200); await response.arrayBuffer();
      assert.equal(h.calls.length,2); assert(h.calls.every(c=>c[2].quality==='1080p')); h.context.clearOnlineCache();
    });
    await check('compatibility paths isolate quality and recovery passes it to the provider',async()=>{
      const h=fixture();
      assert.notEqual(h.context.compatPathFor('1',1,'1080p'),h.context.compatPathFor('1',1,'720p'));
      assert.equal(path.basename(h.context.compatPathFor('1',1)),'1_001.mp4');
      await h.context.fetchDecryptedEpisode('11',()=>{},'1',null,undefined,Infinity,false,'1080p');
      assert.equal(h.calls[0][2].quality,'1080p');
    });
  } finally {for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
}
process.exitCode=failures?1:0;
})();
