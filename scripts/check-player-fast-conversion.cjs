// In-memory Player UI only; no real media, network or device claims.
const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');
const decoder = ui => ui.find(node => node.type === 'select' && node.props['aria-label'] === '解码方式');
const choose = (ui, value) => decoder(ui).props.onChange({ target: { value } });
const video = ui => ui.find(node => node.type === 'video');
const ready = async options => {
  const ui = mount({ local: true, ...options });
  await ui.flush(); ui.metadata(); await ui.flush();
  return ui;
};

(async () => {
  let failures = 0;
  const test = async (name, run) => {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.stack); }
  };
  await test('desktop menu explains GPU conversion and Android keeps its two modes', async () => {
    const ui = await ready();
    try {
      assert.equal(decoder(ui).props.value, 'auto');
      assert.ok(ui.find(node => node.type === 'option' && node.props.value === 'hardware'));
      assert.match(ui.text(), /高性能显卡快速解码（老电脑请勿使用）/);
      assert.match(ui.text(), /ByteVC2仍由CPU解码/);
      assert.match(ui.text(), /不支持时提示并回退/);
      assert.ok(decoder(ui).props['aria-describedby']);
      const english = require('../src/i18n/en.json');
      for (const message of ['高性能显卡快速解码（老电脑请勿使用）',
        '优先使用显卡加速格式转换，ByteVC2仍由CPU解码；不支持时提示并回退。',
        '正在使用显卡加速转换', '显卡加速不可用，已回退CPU转换', '显卡加速失败，已回退CPU转换',
        '硬件编码检测已取消', '硬件编码检测无法读取当前视频，请重新获取片源后重试', '不支持的硬件编码器',
        '视频输入或存储不可用，转换已停止，原视频已保留']) assert.ok(english[message]);
    } finally { ui.unmount(); }
    let mobileSaves = 0;
    const mobile = await ready({ apiOverrides: { platform: 'android', saveSettings: async () => {
      mobileSaves++; return { success: false, error: '此设置尚未接入安卓，未保存' };
    } } });
    try {
      assert.equal(mobile.find(node => node.type === 'option' && node.props.value === 'hardware'), undefined);
      assert.equal(decoder(mobile).props.value, 'auto');
      await choose(mobile, 'software'); await mobile.flush(); mobile.metadata();
      assert.equal(decoder(mobile).props.value, 'software', 'Android keeps its existing local decoder preference');
      assert.equal(mobileSaves, 0, 'desktop GPU preference must not reach the Android settings whitelist');
    } finally { mobile.unmount(); }
  });
  await test('auto and GPU conversion save only the backend preference without interrupting playback', async () => {
    const storage = new Map();
    const ui = await ready({ storage });
    try {
      ui.media.currentTime = 37; ui.media.volume = 0.3; ui.media.muted = true;
      const element = ui.media, src = video(ui).props.src, calls = { ...ui.mediaCalls };
      await choose(ui, 'hardware'); await ui.flush();
      assert.equal(decoder(ui).props.value, 'hardware');
      assert.equal(ui.settingsSaved.length, 1);
      assert.equal(ui.settingsSaved[0].fast_conversion, true);
      assert.deepEqual(Object.keys(ui.settingsSaved[0]), ['fast_conversion']);
      assert.equal(ui.media, element); assert.equal(video(ui).props.src, src);
      assert.deepEqual(ui.mediaCalls, calls);
      assert.equal(ui.media.currentTime, 37); assert.equal(ui.media.volume, 0.3); assert.equal(ui.media.muted, true);
      await choose(ui, 'auto'); await ui.flush();
      assert.equal(decoder(ui).props.value, 'auto');
      assert.equal(ui.settingsSaved.at(-1).fast_conversion, false);
      assert.deepEqual(ui.mediaCalls, calls);
      assert.equal([...storage.keys()].some(key => /fast|hardware/.test(key)), false, 'fast preference has no duplicate localStorage');
    } finally { ui.unmount(); }
  });
  await test('failed backend save keeps decoder, media state and local preference untouched', async () => {
    for (const rejects of [false, true]) {
      const storage = new Map([['hongguo:software-decode', 'true']]);
      const ui = await ready({ storage, apiOverrides: { saveSettings: async () => {
        if (rejects) throw Error('disk unavailable');
        return { success: false, error: 'disk unavailable' };
      } } });
      try {
        ui.media.currentTime = 42; ui.media.paused = true;
        const src = video(ui).props.src, calls = { ...ui.mediaCalls };
        await choose(ui, 'hardware'); await ui.flush();
        assert.equal(decoder(ui).props.value, 'software');
        assert.equal(video(ui).props.src, src); assert.deepEqual(ui.mediaCalls, calls);
        assert.equal(ui.media.currentTime, 42); assert.equal(ui.media.paused, true);
        assert.equal(storage.get('hongguo:software-decode'), 'true');
        assert.match(ui.text(), /设置未更改：disk unavailable/);
      } finally { ui.unmount(); }
    }
  });
  await test('backend fast preference survives remount and overrides legacy software preference', async () => {
    const storage = new Map([['hongguo:software-decode', 'true']]);
    const settings = { fast_conversion: false };
    const apiOverrides = {
      getSettings: async () => ({ compat_mode: true, ...settings }),
      saveSettings: async value => { Object.assign(settings, value); return { success: true }; },
    };
    const first = await ready({ storage, apiOverrides });
    try { await choose(first, 'hardware'); await first.flush(); }
    finally { first.unmount(); }
    const second = await ready({ storage, apiOverrides });
    try { assert.equal(decoder(second).props.value, 'hardware'); assert.equal(video(second).props.videoRef, undefined); }
    finally { second.unmount(); }
    storage.set('hongguo:software-decode', 'true');
    const legacy = await ready({ storage, apiOverrides });
    try { assert.equal(decoder(legacy).props.value, 'hardware'); assert.equal(video(legacy).props.videoRef, undefined); }
    finally { legacy.unmount(); }
  });
  await test('software and native decoder transitions preserve pause, seek and volume', async () => {
    for (const paused of [false, true]) {
      const ui = await ready();
      try {
        ui.media.currentTime = 29; ui.media.paused = paused; ui.media.volume = 0.23; ui.media.muted = true;
        for (const mode of ['software', 'hardware', 'software', 'auto']) {
          await choose(ui, mode); await ui.flush(); ui.metadata(); await ui.flush();
          assert.equal(decoder(ui).props.value, mode);
          assert.equal(ui.media.currentTime, 29); assert.equal(ui.media.paused, paused);
          assert.equal(ui.media.volume, 0.23); assert.equal(ui.media.muted, true);
          assert.equal(ui.settingsSaved.at(-1).fast_conversion, mode === 'hardware');
        }
      } finally { ui.unmount(); }
    }
  });
  await test('rapid decoder changes and other playback settings share the existing save lock', async () => {
    let finish;
    const calls = [];
    const ui = await ready({ apiOverrides: { saveSettings: value => {
      calls.push(value); return new Promise(resolve => { finish = resolve; });
    } } });
    try {
      const pending = choose(ui, 'hardware');
      choose(ui, 'software');
      ui.button('缓存后续 2 集').props.onClick();
      await ui.flush();
      assert.equal(calls.length, 1); assert.equal(decoder(ui).props.disabled, true);
      assert.equal(ui.button('兼容模式').props.disabled, true);
      assert.equal(decoder(ui).props.value, 'auto', 'selection changes only after save succeeds');
      finish({ success: true }); await pending; await ui.flush();
      assert.equal(decoder(ui).props.value, 'hardware'); assert.equal(decoder(ui).props.disabled, false);
    } finally { ui.unmount(); }
  });
  await test('an older settings refresh cannot overwrite a decoder preference saved afterward', async () => {
    let delayRead = false;
    const reads = [], settings = { fast_conversion: false };
    const ui = await ready({ apiOverrides: {
      getSettings: () => delayRead ? new Promise(resolve => { reads.push(resolve); }) : Promise.resolve({ ...settings }),
      saveSettings: async value => { Object.assign(settings, value); return { success: true }; },
    } });
    try {
      const change = decoder(ui).props.onChange;
      ui.props.active = false; ui.render(); await ui.flush();
      delayRead = true; ui.props.active = true; ui.render();
      assert.ok(reads.length);
      // A queued input event still holds the control callback from before the refresh.
      await change({ target: { value: 'hardware' } }); await ui.flush();
      assert.equal(decoder(ui).props.value, 'hardware');
      for (const resolve of reads) resolve({ fast_conversion: false });
      await ui.flush();
      assert.equal(decoder(ui).props.value, 'hardware', 'late old settings must not undo the saved selection');
    } finally { ui.unmount(); }
  });
  await test('only current online and compatibility requests may show GPU fallback notices', async () => {
    let complete;
    const online = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: () => new Promise(resolve => { complete = resolve; }) });
    await online.flush();
    try {
      online.onlineProgress({ requestId: 'obsolete', notice: 'stale GPU notice' }); await online.flush();
      assert.ok(!online.text().includes('stale GPU notice'));
      online.onlineProgress({ ...online.prepares[0], vid: 'v1', phase: 'transcoding', notice: 'GPU unavailable; using CPU' }); await online.flush();
      assert.match(online.text(), /GPU unavailable; using CPU/);
      const timers = [...online.timers.keys()];
      online.onlineProgress({ ...online.prepares[0], vid: 'v1', phase: 'transcoding', percent: 10, notice: 'GPU unavailable; using CPU' }); await online.flush();
      assert.deepEqual([...online.timers.keys()], timers, 'repeated notice must not restart its toast timer');
      complete({ success: true, url: 'hongguo-stream://ready' }); await online.flush();
    } finally { online.unmount(); }
    let finish;
    const compat = await ready({ transcode: () => new Promise(resolve => { finish = resolve; }) });
    try {
      compat.error(3); await compat.flush();
      compat.transcodeProgress({ ...compat.transcodes[0], notice: 'GPU conversion failed; using CPU', done: true }); await compat.flush();
      assert.match(compat.text(), /GPU conversion failed; using CPU/);
      const timers = [...compat.timers.keys()];
      compat.transcodeProgress({ ...compat.transcodes[0], notice: 'GPU conversion failed; using CPU', done: true }); await compat.flush();
      assert.deepEqual([...compat.timers.keys()], timers, 'compatibility progress must deduplicate the same notice');
      finish({ success: true, url: 'file:///converted.mp4' }); await compat.flush();
    } finally { compat.unmount(); }
  });
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
