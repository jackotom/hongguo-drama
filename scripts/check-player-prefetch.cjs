const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');

const prepareOk = async payload => ({ success: true, url: `hongguo-stream://${payload.vidIndex}` });


(async () => {
  let failures = 0;
  const test = async (name, fn) => {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + (error.stack || error.message)); }
  };

  await test('prefetch starts from timeupdate even when the played flag was not recorded', async () => {
    const ui = mount({
      settings: { cache_next_episode: false },
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      episodeCount: 3,
      prepare: prepareOk,
    });
    await ui.flush(); ui.metadata();
    // 模拟历史记录被移除后 media.played 被清空，但当前视频实际还在播放。
    ui.historyUpdated({ removedSeriesId: 'A' });
    ui.media.paused = false;
    const toggle = ui.button('缓存后续 2 集');
    assert(toggle, 'cache-next toggle must exist');
    toggle.props.onClick();
    await ui.flush();
    ui.media.currentTime = 1;
    ui.find(node => node.type === 'video').props.onTimeUpdate({ currentTarget: ui.media });
    await ui.flush();
    assert.ok(ui.prepares.some(item => item.prefetch === true && item.vidIndex === 2),
      'next episode must be prefetched even when played was cleared: ' + JSON.stringify(ui.prepares));
    ui.unmount();
  });

  await test('a failed prefetch is cleared and retried after the cooldown', async () => {
    let failed = 0, clock = Date.now();
    const ui = mount({
      now: () => clock,
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      episodeCount: 3,
      prepare: async payload => {
        if (payload.prefetch && payload.vidIndex === 2) { failed++; return { success: false, error: 'network' }; }
        return prepareOk(payload);
      },
    });
    try {
      await ui.flush(); ui.metadata(); ui.media.paused = false; ui.media.currentTime = 1;
      ui.find(node => node.type === 'video').props.onTimeUpdate({ currentTarget: ui.media });
      await ui.flush();
      assert.equal(failed, 3, 'first automatic prefetch must exhaust three qualities');
      clock += 16000;
      ui.find(node => node.type === 'video').props.onTimeUpdate({ currentTarget: ui.media });
      await ui.flush();
      assert.equal(failed, 6, 'failed automatic prefetch must retry three qualities after the retry window');
      ui.episode(2);
      await ui.flush(); ui.metadata(); ui.media.paused = false; ui.media.currentTime = 1;
      ui.find(node => node.type === 'video').props.onTimeUpdate({ currentTarget: ui.media });
      await ui.flush();
      assert.ok(ui.prepares.some(item => item.prefetch === true && item.vidIndex === 3),
        'switching episodes must still prefetch the following episode: ' + JSON.stringify(ui.prepares));
    } finally {
      ui.unmount();
    }
  });

  await test('switching away releases an in-flight prefetch request', async () => {
    let pendingResolve;
    const ui = mount({
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      episodeCount: 3,
      prepare: payload => payload.prefetch
        ? new Promise(resolve => { pendingResolve = resolve; })
        : Promise.resolve(prepareOk(payload)),
    });
    await ui.flush(); ui.metadata(); ui.media.paused = false; ui.media.currentTime = 1;
    ui.find(node => node.type === 'video').props.onTimeUpdate({ currentTarget: ui.media });
    await ui.flush();
    const prefetch = ui.prepares.find(item => item.prefetch === true && item.vidIndex === 2);
    assert(prefetch, 'prefetch must start before switching');
    // 跳到第 3 集（跳过预取目标第 2 集），旧预取必须释放而不是一直占着。
    ui.episode(3);
    await ui.flush();
    assert.ok(ui.releases.some(item => item.requestId === prefetch.requestId),
      'switching episodes must release the stale prefetch request');
    pendingResolve?.({ success: false, error: 'cancelled' });
    await ui.flush();
    ui.unmount();
  });

  await test('cache-next disabled never prefetches', async () => {
    const ui = mount({
      settings: { cache_next_episode: false },
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      episodeCount: 3,
      prepare: prepareOk,
    });
    await ui.flush(); ui.metadata(); ui.media.paused = false; ui.media.currentTime = 1;
    ui.find(node => node.type === 'video').props.onTimeUpdate({ currentTarget: ui.media });
    await ui.flush();
    assert.equal(ui.prepares.some(item => item.prefetch === true), false);
    ui.unmount();
  });

  if (failures) process.exitCode = 1;
})();
