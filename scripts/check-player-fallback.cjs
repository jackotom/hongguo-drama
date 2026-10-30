// In-memory Player behavior only; no real media, network, or user files.
const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const source = ui => ui.find(n => n.type === 'video').props.src;
const alert = ui => ui.find(n => n.props.role === 'alert');
const poll = async ui => { ui.changed(); await [...ui.timers.values()].find(t => t.delay === 2000).fn(); await ui.flush(); };
function fixture({ prepare, transcode, enqueue, quality = '720p', initial = 'missing' } = {}) {
  const states = new Map([['A:1', initial]]), downloads = [], stops = [];
  let changed;
  const props = { target: { seriesId: 'A', vidIndex: 1, ts: 1 } };
  const ui = mount({ props, transcode, prepare: prepare || (async () => ({ success: false, error: '本集取源失败' })),
    settings: { download_quality: quality, cache_next_episode: false },
    apiOverrides: {
      onDownloadQueueChanged: fn => { changed = fn; return () => {}; },
      getSeriesList: async () => [{ series_id: 'A' }, { series_id: 'B' }],
      getSeriesEpisodes: async sid => ({ success: true, data: { series_id: sid, total: 2,
        episodes: [1, 2].map(index => { const status = states.get(`${sid}:${index}`) || 'missing'; return {
          vid: `${sid}-${index}`, vid_index: index, status, taskId: status === 'missing' ? null : `task-${sid}-${index}`,
          ...(status === 'completed' ? { fileUrl: `file:///${sid}-${index}.mp4`, savePath: `/${sid}-${index}.mp4` } : {}),
        }; }),
      } }),
      downloadSingleEpisode: async (sid, index, quality) => {
        downloads.push({ sid, index, quality });
        if (enqueue) return enqueue(sid, index, quality);
        const existed = ['pending', 'downloading'].includes(states.get(`${sid}:${index}`));
        states.set(`${sid}:${index}`, 'pending'); return { success: true, count: existed ? 0 : 1 };
      },
      stopDownload: async id => { stops.push(id); return { success: true }; },
    },
  });
  ui.changed = () => changed?.();
  return { ui, states, downloads, stops };
}

(async () => {
  let failures = 0;
  const test = async (name, fn) => { if (process.argv[2] && !name.includes(process.argv[2])) return;
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.stack}`); } };
  await test('failed prepare refreshes and chooses an already completed local file', async () => {
    const pending = defer(), f = fixture({ prepare: () => pending.promise }); await f.ui.flush();
    f.states.set('A:1', 'completed'); pending.resolve({ success: false, error: '本集取源失败' }); await f.ui.flush();
    assert.equal(source(f.ui), 'file:///A-1.mp4'); assert.equal(f.downloads.length, 0); assert.equal(alert(f.ui), undefined);
    f.ui.metadata(); assert.equal(f.ui.media.paused, false); f.ui.unmount();
  });
  await test('online failure queues selected quality once and plays the completed download', async () => {
    const f = fixture(); await f.ui.flush();
    assert.deepEqual(f.downloads, [{ sid: 'A', index: 1, quality: '720p' }]); assert(f.ui.button('取消等待'));
    f.states.set('A:1', 'completed'); await poll(f.ui); f.ui.metadata();
    assert.equal(source(f.ui), 'file:///A-1.mp4'); assert.equal(f.ui.media.paused, false); assert.equal(alert(f.ui), undefined);
    f.ui.unmount();
  });
  await test('enqueue failure revokes autoplay until an explicit retry', async () => {
    const f = fixture({ enqueue: async () => ({ success: false, error: '下载加入失败' }) }); await f.ui.flush();
    assert(alert(f.ui)); f.states.set('A:1', 'completed'); await poll(f.ui);
    assert.notEqual(source(f.ui), 'file:///A-1.mp4'); assert(alert(f.ui));
    await f.ui.button('重试本集').props.onClick(); await f.ui.flush();
    assert.equal(source(f.ui), 'file:///A-1.mp4'); assert.equal(alert(f.ui), undefined); f.ui.unmount();
  });
  for (const failure of ['response', 'throw']) await test(`${failure} enqueue failure permits a fresh explicit retry without a phantom task`, async () => {
    let attempts = 0;
    const f = fixture({ enqueue: async () => {
      if (++attempts === 1) {
        if (failure === 'throw') throw new Error('任务提交失败');
        return { success: false, error: '任务提交失败' };
      }
      f.states.set('A:1', 'pending');
      return { success: true, count: 1 };
    } });
    await f.ui.flush();
    assert.equal(f.states.get('A:1'), 'missing');
    assert(f.ui.text().includes('任务提交失败'));
    await f.ui.button('重试本集').props.onClick(); await f.ui.flush();
    assert.equal(f.downloads.length, 2, 'explicit retry must reach the download API after an unsuccessful submission');
    assert(f.ui.button('取消等待'));
    assert(!f.ui.text().includes('已尝试下载'));
    f.ui.unmount();
  });
  await test('a removed download does not leave a phantom attempt blocking a later explicit retry', async () => {
    const f = fixture(); await f.ui.flush(); assert.equal(f.downloads.length, 1);
    f.states.delete('A:1'); await poll(f.ui);
    await f.ui.button('重试本集').props.onClick(); await f.ui.flush();
    assert.equal(f.downloads.length, 2, 'absence of a real task must allow a new submission');
    assert(f.ui.button('取消等待')); f.ui.unmount();
  });
  await test('retry waits for an existing pending download without submitting again', async () => {
    const f = fixture(); await f.ui.flush(); assert.equal(f.downloads.length, 1);
    f.ui.button('取消等待').props.onClick(); await f.ui.flush();
    await f.ui.button('重试本集').props.onClick(); await f.ui.flush();
    assert.equal(f.downloads.length, 1);
    assert(f.ui.button('取消等待'), 'an accepted pending task must remain a usable fallback');
    assert.equal(alert(f.ui), undefined); f.ui.unmount();
  });
  await test('retry uses refreshed local instead of a stale online choice', async () => {
    const f = fixture({ enqueue: async () => ({ success: false, error: '加入失败' }) }); await f.ui.flush();
    const attempts = f.ui.prepares.length;
    f.states.set('A:1', 'completed'); await f.ui.button('重试本集').props.onClick(); await f.ui.flush();
    assert.equal(source(f.ui), 'file:///A-1.mp4'); assert.equal(f.ui.prepares.length, attempts); f.ui.unmount();
  });
  for (const status of ['failed', 'stopped', 'missing']) await test(`${status} download ends waiting without repeated automatic enqueue`, async () => {
    const f = fixture(); await f.ui.flush(); assert.equal(f.downloads.length, 1);
    f.states.set('A:1', status); await poll(f.ui);
    assert(alert(f.ui)); assert.equal(f.ui.button('取消等待'), undefined);
    f.states.set('A:1', 'completed'); await poll(f.ui);
    assert.notEqual(source(f.ui), 'file:///A-1.mp4', 'terminal failure must revoke its playback intent');
    await f.ui.button('重试本集').props.onClick(); await f.ui.flush(); await poll(f.ui);
    assert.equal(f.downloads.length, 1, 'retry must not continuously requeue failed downloads'); f.ui.unmount();
  });
  await test('cancel only revokes playback intent and leaves shared downloads alone', async () => {
    const f = fixture({ initial: 'downloading' }); await f.ui.flush();
    assert(f.ui.button('取消等待')); f.ui.button('取消等待').props.onClick(); await f.ui.flush();
    f.states.set('A:1', 'completed'); await poll(f.ui);
    assert.notEqual(source(f.ui), 'file:///A-1.mp4'); assert.equal(f.stops.length, 0); assert(alert(f.ui)); f.ui.unmount();
  });
  for (const action of ['cancel', 'episode', 'series']) await test(`late enqueue reply cannot override ${action}`, async () => {
    const pending = defer(), f = fixture({ enqueue: () => pending.promise,
      prepare: async p => p.vid === 'A-1' ? { success: false, error: '本集取源失败' } : { success: true, url: `hongguo-stream://${p.vid}` } });
    await f.ui.flush(); assert(f.ui.button('取消等待'));
    if (action === 'cancel') f.ui.button('取消等待').props.onClick();
    else if (action === 'episode') f.ui.episode(2);
    else f.ui.props.target = { seriesId: 'B', vidIndex: 1, ts: 2 };
    await f.ui.flush(); const before = source(f.ui);
    f.states.set('A:1', 'completed'); pending.resolve({ success: true, count: 1 }); await f.ui.flush(); await poll(f.ui);
    assert.equal(source(f.ui), before); f.ui.unmount();
  });
  await test('automatic recovery retains paused intent and playback second', async () => {
    let calls = 0;
    const f = fixture({ prepare: async () => ++calls === 1 ? { success: true, url: 'hongguo-stream://first' } : { success: false, error: '断线取源失败' } });
    await f.ui.flush(); f.ui.metadata(); f.ui.media.currentTime = 32; f.ui.media.pause(); f.ui.error(2); await f.ui.flush();
    assert.equal(f.downloads.length, 1); f.states.set('A:1', 'completed'); await poll(f.ui); f.ui.metadata();
    assert.equal(f.ui.media.currentTime, 32); assert.equal(f.ui.media.paused, true); f.ui.unmount();
  });
  await test('failed online decode conversion also reaches one download fallback', async () => {
    const f = fixture({ prepare: async () => ({ success: true, url: 'hongguo-stream://bad-codec' }),
      transcode: async () => ({ success: false, error: '无法转换片源' }) });
    await f.ui.flush(); f.ui.metadata(); f.ui.media.currentTime = 16; f.ui.media.pause();
    for (let attempt = 0; attempt < 3; attempt++) { f.ui.error(3); await f.ui.flush(); f.ui.metadata(); }
    assert.equal(f.downloads.length, 1); f.states.set('A:1', 'completed'); await poll(f.ui); f.ui.metadata();
    assert.equal(source(f.ui), 'file:///A-1.mp4'); assert.equal(f.ui.media.currentTime, 16);
    assert.equal(f.ui.media.paused, true); f.ui.unmount();
  });
  for (const code of [2, 4]) await test(`exhausted online media error ${code} downloads once and retains paused position`, async () => {
    const f = fixture({ prepare: async () => ({ success: true, url: 'hongguo-stream://unavailable' }) });
    await f.ui.flush(); f.ui.metadata(); f.ui.media.currentTime = 29; f.ui.media.pause();
    for (let attempt = 0; attempt < 3; attempt++) { f.ui.error(code); await f.ui.flush(); f.ui.metadata(); }
    assert.equal(f.downloads.length, 1); assert(f.ui.button('取消等待'));
    f.states.set('A:1', 'completed'); await poll(f.ui); f.ui.metadata();
    assert.equal(source(f.ui), 'file:///A-1.mp4'); assert.equal(f.ui.media.currentTime, 29);
    assert.equal(f.ui.media.paused, true); f.ui.unmount();
  });
  await test('known bad local media is not selected again after online fallback fails', async () => {
    const f = fixture({ initial: 'completed', enqueue: async () => ({ success: false, error: '已有文件保留' }) });
    await f.ui.flush(); f.ui.metadata(); f.ui.media.currentTime = 18; f.ui.error(2); await f.ui.flush();
    await poll(f.ui); assert(alert(f.ui)); assert.equal(f.ui.media.paused, true);
    const before = f.ui.prepares.length; await f.ui.button('重试本集').props.onClick(); await f.ui.flush();
    assert.deepEqual(f.ui.prepares.slice(before).map(p => p.quality), ['1080p', '720p', 'auto']);
    assert.equal(f.downloads.length, 2, 'an explicit retry can resubmit a previously rejected download');
    const selectedAt = f.ui.prepares.length; f.ui.episode(1); await f.ui.flush();
    assert.deepEqual(f.ui.prepares.slice(selectedAt).map(p => p.quality), ['1080p', '720p', 'auto'],
      'explicit selection must not strand playback on a rejected local file'); f.ui.unmount();
  });
  process.exitCode = failures ? 1 : 0;
})();
