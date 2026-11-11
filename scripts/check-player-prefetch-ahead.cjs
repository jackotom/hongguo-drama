const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { mount } = require('./check-player-resume.cjs');

const openEpisode = async (options = {}) => {
  const ui = mount({
    ...options,
    props: { setEpisodesOpen() {}, target: { seriesId: 'A', vidIndex: 1, ts: 1 }, ...(options.props || {}) },
  });
  await ui.flush();
  ui.metadata();
  await ui.flush();
  return ui;
};
const prefetches = ui => ui.prepares.filter(item => item.prefetch === true);
const tick = (ui, time) => {
  ui.media.currentTime = time;
  ui.find(node => node.type === 'video').props.onTimeUpdate?.({ currentTarget: ui.media });
};
const paragraph = (ui, message) => ui.find(node => node.type === 'p'
  && node.children?.join('') === message);
const renderWithoutBuffering = ui => {
  ui.render();
  for (const message of ['正在加载视频…', '正在缓冲在线播放…']) {
    assert.equal(paragraph(ui, message), undefined, `unexpected buffering overlay: ${message}`);
  }
};
const flushWithoutBuffering = async ui => {
  // Observe the synchronous handoff and every microtask render, matching the fixture's flush cadence.
  renderWithoutBuffering(ui);
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
    renderWithoutBuffering(ui);
  }
};

(async () => {
  let failures = 0;
  const test = async (name, fn) => {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + (error.stack || error.message)); }
  };

  await test('foreground thrown cancellation and rejection stop the quality ladder', async () => {
    for (const code of ['ERR_CANCELED', 'DEVICE_REGISTRATION_FAILED', 'BUSINESS_REJECTED', 'SECURITY_BLOCKED']) {
      const ui = mount({ settings: { cache_next_episode: false },
        props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
        prepare: async () => { throw Object.assign(new Error('preparation stopped'), { code }); } });
      try {
        await ui.flush();
        assert.deepEqual(ui.prepares.map(item => item.quality), ['1080p'], code);
        assert.ok(!ui.text().includes('正在尝试'), 'stopped fallback must not announce another quality attempt');
      } finally { ui.unmount(); }
    }
  });

  await test('empty App models stop foreground quality retries and allow an explicit retry', async () => {
    for (const failure of [{ code: 'EMPTY_RESPONSE' },
      { code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code: 'EMPTY_RESPONSE' }] }]) {
      let available = false;
      const ui = mount({ settings: { cache_next_episode: false },
        props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
        prepare: async () => available ? { success: true, url: 'hongguo-stream://recovered' }
          : { success: false, error: 'empty model', ...failure } });
      try {
        await ui.flush();
        assert.deepEqual(ui.prepares.map(item => item.quality), ['1080p'], 'changing quality cannot repair an empty model');
        assert.ok(!ui.text().includes('正在尝试'), 'an empty model must not announce a lower quality');
        available = true;
        assert(ui.button('重试本集'), 'retain the explicit online retry');
        await ui.button('重试本集').props.onClick(); await ui.flush();
        assert.deepEqual(ui.prepares.map(item => item.quality), ['1080p', '1080p']);
        assert.equal(ui.find(node => node.type === 'video').props.src, 'hongguo-stream://recovered');
      } finally { ui.unmount(); }
    }
  });

  await test('empty App prefetch models use one attempt per cooldown and remain recoverable', async () => {
    let now = Date.now(), available = false;
    const ui = await openEpisode({ now: () => now, prepare: async payload => !payload.prefetch || available
      ? { success: true, url: `hongguo-stream://${payload.vidIndex}` }
      : { success: false, code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code: 'EMPTY_RESPONSE' }] } });
    try {
      assert.deepEqual(prefetches(ui).map(item => item.quality), ['1080p']);
      now += 14999; tick(ui, 1); await ui.flush();
      assert.equal(prefetches(ui).length, 1, 'timeupdate must respect the existing cooldown');
      available = true;
      now += 1; tick(ui, 1); await ui.flush();
      assert.deepEqual(prefetches(ui).map(item => item.quality), ['1080p', '1080p']);
      ui.episode(2); await ui.flush();
      assert.equal(ui.find(node => node.type === 'video').props.src, 'hongguo-stream://2');
      assert.equal(ui.prepares.filter(item => item.vidIndex === 2).length, 2, 'reuse the recovered prefetch');
    } finally { ui.unmount(); }
  });

  await test('a website-only empty result does not stop an independent App quality attempt', async () => {
    const ui = mount({ settings: { cache_next_episode: false },
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: async payload => payload.quality === '1080p'
        ? { success: false, code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'web', code: 'EMPTY_RESPONSE' }] }
        : { success: true, url: 'hongguo-stream://720p' } });
    try {
      await ui.flush();
      assert.deepEqual(ui.prepares.map(item => item.quality), ['1080p', '720p']);
      assert.equal(ui.find(node => node.type === 'video').props.src, 'hongguo-stream://720p');
    } finally { ui.unmount(); }
  });

  await test('every prefetch quality attempt carries only cloneable IPC fields', async () => {
    const payloads = [], cloneErrors = [];
    const ui = await openEpisode({ apiOverrides: { prepareOnlinePlay: async payload => {
      let copy;
      try { copy = structuredClone(payload); }
      catch (error) { cloneErrors.push(error.name); throw error; }
      payloads.push(copy);
      return !copy.prefetch || copy.quality === '720p' ? { success: true, url: `hongguo-stream://${copy.vidIndex}-${copy.quality}` }
        : { success: false, error: '1080 unavailable' };
    } } });
    try {
      assert.deepEqual(cloneErrors, [], 'fallback IPC must never carry the request Promise');
      const queued = payloads.filter(item => item.prefetch);
      assert.deepEqual(queued.map(item => item.quality), ['1080p', '720p']);
      for (const item of queued) assert.deepEqual(Object.keys(item).sort(),
        ['requestId', 'vid', 'seriesId', 'vidIndex', 'quality', 'prefetch'].sort());
    } finally { ui.unmount(); }
  });

  await test('App rejection stays blocked past cooldown and automatic reconnect, until manual retry', async () => {
    const failures = [
      ...['DEVICE_REGISTRATION_FAILED', 'BUSINESS_REJECTED', 'SECURITY_BLOCKED'].map(code => ({ code })),
      ...['DEVICE_REGISTRATION_FAILED', 'HTTP_403', 'HTTP_429', 'BUSINESS_REJECTED', 'SECURITY_BLOCKED']
        .map(code => ({ code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code }] })),
    ];
    for (const failure of failures) {
      let now = Date.now();
      const ui = await openEpisode({ now: () => now,
        prepare: async payload => payload.prefetch ? { success: false, ...failure }
          : { success: true, url: `hongguo-stream://${payload.vidIndex}-${payload.quality}` } });
      try {
        assert.equal(prefetches(ui).length, 1, JSON.stringify(failure));
        for (const elapsed of [16000, 60000]) {
          now += elapsed; tick(ui, 1); await ui.flush();
          assert.equal(prefetches(ui).length, 1, 'explicit rejection must not restart after the cooldown');
        }
        ui.error(2); await ui.flush(); ui.metadata(); await ui.flush();
        assert.equal(prefetches(ui).length, 1, 'automatic source recovery must not unlock rejected prefetch');
        ui.episode(1); await ui.flush(); ui.metadata(); await ui.flush();
        assert.equal(prefetches(ui).length, 2, 'manual episode retry must allow one new prefetch attempt');
        assert.equal(prefetches(ui).at(-1).quality, '1080p');
        // A second immediate manual retry must also work, without waiting 15 seconds.
        ui.episode(1); await ui.flush(); ui.metadata(); await ui.flush();
        assert.equal(prefetches(ui).length, 3, 'a new explicit retry must not inherit a rejection cooldown');
      } finally { ui.unmount(); }
    }
  });

  await test('one App refusal blocks lower-quality work on both queued targets until the episode changes', async () => {
    let now = Date.now();
    const ui = await openEpisode({ episodeCount: 3, now: () => now, prepare: async payload => !payload.prefetch
      ? { success: true, url: `hongguo-stream://${payload.vidIndex}` }
      : payload.vidIndex === 2 ? { success: false, code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code: 'HTTP_429' }] }
        : { success: false, error: 'network' } });
    try {
      assert.deepEqual(prefetches(ui).map(item => [item.vidIndex, item.quality]), [[2, '1080p'], [3, '1080p']]);
      now += 60000; tick(ui, 1); await ui.flush();
      assert.equal(prefetches(ui).length, 2, 'all targets must remain paused for the current playback source');
      ui.episode(2); await ui.flush(); ui.metadata(); await ui.flush();
      assert.deepEqual(prefetches(ui).filter(item => item.vidIndex === 3).map(item => item.quality),
        ['1080p', '1080p', '720p', 'auto'], 'episode change must restore the bounded ladder for following episodes');
    } finally { ui.unmount(); }
  });

  await test('a released old episode refusal cannot block the newly selected episode prefetch', async () => {
    let rejectOld;
    const ui = await openEpisode({ episodeCount: 4, prepare: payload => payload.prefetch && payload.vidIndex === 2
      ? new Promise(resolve => { rejectOld = resolve; })
      : { success: true, url: `hongguo-stream://${payload.vidIndex}` } });
    try {
      ui.episode(3); await ui.flush();
      rejectOld({ success: false, code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code: 'HTTP_403' }] });
      await ui.flush(); ui.metadata(); await ui.flush();
      assert(prefetches(ui).some(item => item.vidIndex === 4), 'a stale refusal must not poison the new playback source');
    } finally { ui.unmount(); }
  });

  for (const available of ['720p', 'auto']) await test(`automatic prefetch falls back to ${available} and hands off its actual quality`, async () => {
    const ui = await openEpisode({ episodeCount: 2, prepare: async payload => !payload.prefetch || payload.quality === available
      ? { success: true, url: `hongguo-stream://${payload.vidIndex}-${payload.quality}` }
      : { success: false, code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code: 'QUALITY_UNAVAILABLE' }] } });
    try {
      const expected = available === '720p' ? ['1080p', '720p'] : ['1080p', '720p', 'auto'];
      assert.deepEqual(prefetches(ui).map(item => item.quality), expected);
      assert.equal(new Set(prefetches(ui).map(item => item.requestId)).size, 1, 'fallback must keep one cancellable request');
      ui.episode(2); await flushWithoutBuffering(ui);
      assert.equal(ui.find(node => node.type === 'video').props.src, `hongguo-stream://2-${available}`);
      assert.equal(ui.prepares.filter(item => item.vidIndex === 2).length, expected.length, 'handoff must reuse the lower-quality prefetch');
      ui.metadata(); await ui.flush();
      ui.error(2); await ui.flush();
      const foreground = ui.prepares.filter(item => item.vidIndex === 2 && !item.prefetch);
      assert.deepEqual(foreground.map(item => item.quality), available === '720p' ? ['auto'] : [],
        'runtime recovery must continue after the actual prefetched quality, never restart at 1080');
    } finally { ui.unmount(); }
  });

  await test('fixed quality, compatible mode and other sources never use the automatic prefetch ladder', async () => {
    for (const [seriesId, choice, expected] of [['A', '1080p', '1080p'], ['A', '720p', '720p'], ['A', 'compat', 'auto'],
      ['xifan:A', 'auto', 'auto'], ['hema:A', 'auto', 'auto'], ['custom:A', 'auto', 'auto']]) {
      const ui = await openEpisode({ seriesId, storage: new Map([['hongguo:online-quality', choice]]),
        props: { target: { seriesId, vidIndex: 1, ts: 1 } },
        prepare: async payload => payload.prefetch ? { success: false, error: 'unavailable' }
          : { success: true, url: 'hongguo-stream://first' } });
      try { assert.deepEqual(prefetches(ui).map(item => item.quality), [expected]); }
      finally { ui.unmount(); }
    }
  });

  await test('explicit App rejection and cancellation stop automatic prefetch quality retries', async () => {
    for (const failure of [{ cancelled: true }, { code: 'ERR_CANCELED' }, ...[
      'DEVICE_REGISTRATION_FAILED', 'HTTP_403', 'HTTP_429', 'BUSINESS_REJECTED', 'SECURITY_BLOCKED',
    ].map(code => ({ code: 'SOURCE_UNAVAILABLE', sources: [{ source: 'app', code }] }))]) {
      const ui = await openEpisode({ prepare: async payload => payload.prefetch ? { success: false, ...failure }
        : { success: true, url: 'hongguo-stream://first' } });
      try { assert.deepEqual(prefetches(ui).map(item => item.quality), ['1080p'], JSON.stringify(failure)); }
      finally { ui.unmount(); }
    }
  });

  await test('disabling prefetch during a quality attempt prevents lower-quality work after cancellation', async () => {
    let fail;
    const ui = await openEpisode({ prepare: payload => payload.prefetch ? new Promise(resolve => { fail = resolve; })
      : { success: true, url: 'hongguo-stream://first' } });
    try {
      ui.button('缓存后续 2 集').props.onClick(); await ui.flush();
      fail({ success: false, error: 'late failure' }); await ui.flush();
      assert.deepEqual(prefetches(ui).map(item => item.quality), ['1080p']);
      assert(ui.releases.some(item => item.requestId === prefetches(ui)[0].requestId));
    } finally { ui.unmount(); }
  });

  await test('switching into an in-flight prefetch retains its bounded fallback and excludes stale episodes', async () => {
    const pending = [], promotions = [];
    const ui = await openEpisode({ episodeCount: 4,
      apiOverrides: { promoteOnlinePlay: async payload => { structuredClone(payload); promotions.push(payload); } },
      prepare: payload => payload.prefetch && payload.quality === '1080p'
      ? new Promise(resolve => { pending.push({ ...payload, resolve }); })
      : { success: true, url: `hongguo-stream://${payload.vidIndex}-${payload.quality}` } });
    try {
      assert.deepEqual(prefetches(ui).map(item => item.vidIndex), [2, 3], 'at most two episodes may prepare concurrently');
      ui.episode(3); await ui.flush();
      assert.deepEqual(promotions.map(p => p.requestId), [pending.find(p => p.vidIndex === 3).requestId],
        'taking over pending prefetch must promote the existing conversion');
      for (const item of pending) item.resolve({ success: false, error: '1080 unavailable' });
      await ui.flush();
      assert.deepEqual(prefetches(ui).filter(item => item.vidIndex === 2).map(item => item.quality), ['1080p']);
      assert.deepEqual(ui.prepares.filter(item => item.vidIndex === 3).map(item => [item.quality, item.prefetch]),
        [['1080p', true], ['720p', false]], 'fallback after takeover must retain foreground priority');
      assert.equal(ui.find(node => node.type === 'video').props.src, 'hongguo-stream://3-720p');
    } finally { ui.unmount(); }
  });

  await test('playback prefetches at most the next two online episodes', async () => {
    const ui = await openEpisode({ episodeCount: 6 });
    try {
      assert.deepEqual(prefetches(ui).map(item => item.vidIndex), [2, 3]);
      tick(ui, 1); tick(ui, 2); await ui.flush();
      assert.deepEqual(prefetches(ui).map(item => item.vidIndex), [2, 3], 'timeupdate must not enqueue a third episode');
    } finally { ui.unmount(); }
  });

  await test('locked and local episodes are skipped without shrinking the two-ahead window', async () => {
    const ui = await openEpisode({ episodeCount: 5, lockedIndexes: [2, 4] });
    try {
      assert.deepEqual(prefetches(ui).map(item => item.vidIndex), [3, 5]);
    } finally { ui.unmount(); }
  });

  await test('switching to the next episode consumes its preparation and keeps the following one', async () => {
    const ui = await openEpisode({ episodeCount: 4 });
    try {
      const following = prefetches(ui).find(item => item.vidIndex === 3);
      assert.ok(following, 'episode three must already be preparing');
      ui.episode(2);
      await ui.flush();
      ui.metadata();
      await ui.flush();
      assert.equal(ui.releases.some(item => item.requestId === following.requestId), false,
        'the next-next prefetch must survive the handoff');
      assert.equal(prefetches(ui).filter(item => item.vidIndex === 3).length, 1,
        'the retained episode three preparation must not be duplicated');
      assert.ok(prefetches(ui).some(item => item.vidIndex === 4),
        'after switching, the queue must refill with the new next-next episode');
    } finally { ui.unmount(); }
  });

  await test('switching to a completed prefetch has no buffering overlay in any observed render', async () => {
    let finishPrefetch;
    const ui = await openEpisode({
      episodeCount: 2,
      prepare: payload => payload.prefetch === true
        ? new Promise(resolve => { finishPrefetch = resolve; })
        : { success: true, url: 'hongguo-stream://first' },
    });
    try {
      assert.equal(typeof finishPrefetch, 'function', 'the next episode must start prefetching before the switch');
      finishPrefetch({ success: true, url: 'hongguo-stream://prefetched-second' });
      await ui.flush();
      ui.episode(2);
      await flushWithoutBuffering(ui);
      assert.equal(ui.find(node => node.type === 'video').props.src, 'hongguo-stream://prefetched-second');
      assert.equal(paragraph(ui, '正在连接片源…'), undefined);
      assert.equal(ui.prepares.filter(item => item.vidIndex === 2).length, 1, 'switching must reuse the completed prefetch');
      ui.metadata();
      await flushWithoutBuffering(ui);
      assert.equal(ui.media.paused, false, 'the prefetched episode must start playing after metadata');
    } finally { ui.unmount(); }
  });

  await test('switching to a still-preparing prefetch keeps the preparation state visible', async () => {
    const pending = [];
    const ui = await openEpisode({
      episodeCount: 3,
      prepare: payload => payload.prefetch === true
        ? new Promise(resolve => { pending.push({ vidIndex: payload.vidIndex, resolve }); })
        : { success: true, url: 'hongguo-stream://first' },
    });
    try {
      ui.episode(2);
      renderWithoutBuffering(ui);
      assert.ok(paragraph(ui, '正在连接片源…'), 'the pending prefetch must show preparation immediately');
      await flushWithoutBuffering(ui);
      assert.ok(paragraph(ui, '正在连接片源…'), 'a pending prefetch must keep its preparation state visible');
      const next = pending.find(item => item.vidIndex === 2);
      assert.ok(next, 'the next episode must already be prefetching');
      next.resolve({ success: true, url: 'hongguo-stream://prefetched-second' });
      await flushWithoutBuffering(ui);
      assert.equal(paragraph(ui, '正在连接片源…'), undefined);
      assert.equal(ui.find(node => node.type === 'video').props.src, 'hongguo-stream://prefetched-second');
      ui.metadata();
      await flushWithoutBuffering(ui);
      assert.equal(ui.media.paused, false);
    } finally { ui.unmount(); }
  });

  await test('switching to a downloaded episode preserves prefetches after it', async () => {
    const ui = await openEpisode({
      episodeCount: 4,
      localIndexes: [2],
      prepare: payload => payload.prefetch === true ? new Promise(() => {}) : { success: true, url: 'hongguo-stream://first' },
    });
    try {
      const queued = prefetches(ui).filter(item => item.vidIndex === 3 || item.vidIndex === 4);
      assert.deepEqual(queued.map(item => item.vidIndex), [3, 4]);
      ui.episode(2);
      await ui.flush();
      assert.equal(ui.releases.some(item => queued.some(request => request.requestId === item.requestId)), false,
        'switching to a local episode must not release later prefetches');
      ui.metadata();
      ui.find(node => node.type === 'video').props.onPlaying?.({ currentTarget: ui.media });
      await ui.flush();
      assert.equal(prefetches(ui).filter(item => item.vidIndex === 3).length, 1);
      assert.equal(prefetches(ui).filter(item => item.vidIndex === 4).length, 1);
    } finally { ui.unmount(); }
  });

  await test('one failed target retries after cooldown without duplicating the other target', async () => {
    let now = Date.now();
    let targetTwoAttempts = 0;
    const ui = await openEpisode({
      episodeCount: 4,
      now: () => now,
      prepare: async payload => {
        if (payload.prefetch === true && payload.vidIndex === 2) {
          targetTwoAttempts += 1;
          return { success: false, error: 'network' };
        }
        return { success: true, url: `hongguo-stream://${payload.vidIndex}` };
      },
    });
    try {
      assert.equal(targetTwoAttempts, 3, 'automatic prefetch exhausts the bounded quality ladder');
      assert.equal(prefetches(ui).filter(item => item.vidIndex === 3).length, 1);
      tick(ui, 1); await ui.flush();
      assert.equal(targetTwoAttempts, 3, 'retry must wait for the cooldown');
      now += 16000;
      tick(ui, 2); await ui.flush();
      assert.equal(targetTwoAttempts, 6, 'failed target must retry the bounded ladder after the cooldown');
      assert.equal(prefetches(ui).filter(item => item.vidIndex === 3).length, 1,
        'successful next-next target must not be retried');
    } finally { ui.unmount(); }
  });

  await test('disabling cache releases every queued prefetch request', async () => {
    const ui = mount({
      props: { setEpisodesOpen() {}, target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      episodeCount: 4,
      prepare: async payload => payload.prefetch === true
        ? new Promise(() => {})
        : { success: true, url: 'hongguo-stream://first' },
    });
    try {
      await ui.flush(); ui.metadata(); await ui.flush();
      const toggle = ui.button('缓存后续 2 集');
      toggle.props.onClick();
      await ui.flush();
      await ui.flush();
      const queued = prefetches(ui).filter(item => item.vidIndex === 2 || item.vidIndex === 3);
      assert.equal(queued.length, 2);
      for (const request of queued) {
        assert.ok(ui.releases.some(item => item.requestId === request.requestId),
          'queued request ' + request.vidIndex + ' must be released when cache is disabled');
      }
    } finally { ui.unmount(); }
  });

  await test('prefetch IPC preserves only safe source codes for quality and explicit rejection decisions', async () => {
    const prefix = fs.readFileSync(path.join(__dirname, 'check-download-quality-integration.cjs'), 'utf8').split('const checks = [')[0];
    const module = { exports: {} };
    vm.runInNewContext(prefix + '\nmodule.exports={fixture,dirs};',
      { module, require, __dirname, console, process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
    const { fixture, dirs } = module.exports;
    try {
      for (const code of ['QUALITY_UNAVAILABLE', 'HTTP_403']) {
        const h = fixture();
        h.context.failureCode = code;
        h.run("hongguo.fetchPlayUrlSingle = async () => ({url:null,error:'取源失败',code:'SOURCE_UNAVAILABLE',sources:[{source:'app',code:failureCode,message:'private diagnostics'}]});");
        const result = await h.handlers['prepare-online-play']({}, { vid: '11', seriesId: '1', vidIndex: 1, quality: '1080p', prefetch: true });
        assert.equal(result.success, false);
        assert(Array.isArray(result.sources), 'prefetch IPC must retain structured source failure codes');
        assert.deepEqual(JSON.parse(JSON.stringify(result.sources)), [{ source: 'app', code }]);
        assert.doesNotMatch(JSON.stringify(result), /private diagnostics/);
        assert.equal(h.run('onlineSessions.size'), 0, 'failed preparations must release their sessions');
      }
      const h = fixture();
      h.run("onlineSessions.set('selected', {requestId:'chosen',prefetch:true,vid:'11',seriesId:'1',vidIndex:1,job:{progress:{phase:'queued',received:0,total:100,percent:0}}}); onlineSessions.set('later', {requestId:'later',prefetch:true});");
      await h.handlers['promote-online-play']({}, { requestId: 'chosen' });
      assert.equal(h.run("onlineSessions.get('selected').prefetch"), false);
      assert(h.events.some(event => event.channel === 'online-play-progress'
        && event.data.requestId === 'chosen' && event.data.phase === 'queued'),
        'taking over a queued prefetch must immediately replay its queue state');
      assert.equal(h.run("onlineSessions.get('later').prefetch"), true);
      await h.handlers['promote-online-play']({}, {});
      assert.equal(h.run("onlineSessions.get('later').prefetch"), true, 'empty promotion cannot elevate unrelated requests');
    } finally { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); }
  });

  if (failures) process.exitCode = 1;
})();
