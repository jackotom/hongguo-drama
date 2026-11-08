// Component behavior via the existing in-memory hook/media harness; no app, network or user data.
const i18nStub = { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {}, getLanguage: () => 'zh-CN' };
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { mount } = require('./check-player-resume.cjs');

function fixture() {
  let finishDownload, changed;
  const completed = new Set();
  const saved = new Map();
  return {
    completed, saved, changed: () => changed?.(), finish: () => finishDownload({ success: true, count: 1 }),
    apiOverrides: {
      onDownloadQueueChanged: fn => { changed = fn; return () => {}; },
      getSeriesList: async () => [{ series_id: 'A', updatedAt: 2 }, { series_id: 'B', updatedAt: 1 }],
      getSeriesEpisodes: async seriesId => ({ success: true, data: {
        series_id: seriesId, series_title: seriesId, total: 2,
        episodes: [1, 2].map(vid_index => ({ vid_index, vid: `${seriesId}-${vid_index}`,
          status: completed.has(`${seriesId}-${vid_index}`) ? 'completed' : 'missing',
          fileUrl: completed.has(`${seriesId}-${vid_index}`) ? `file:///${seriesId}-${vid_index}.mp4` : undefined })),
      } }),
      downloadSingleEpisode: () => new Promise(resolve => { finishDownload = resolve; }),
      savePlaybackPosition: async (seriesId, vid_index, currentTime) => saved.set(seriesId, { vid_index, currentTime }),
      getPlaybackPosition: async seriesId => saved.get(seriesId),
    },
  };
}
const start = async (f, props = {}) => {
  const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 }, ...props }, apiOverrides: f.apiOverrides });
  ui.changed = f.changed; await ui.flush(); ui.metadata(); return ui;
};
const download = (ui, index = 1) => ui.find(n => n.props['aria-label'] === `第 ${index} 集`).props.onDoubleClick();
const poll = async ui => { ui.changed(); await [...ui.timers.values()].find(t => t.delay === 2000).fn(); await ui.flush(); };
const source = ui => ui.find(n => n.type === 'video').props.src;

// App executes its own state/effects; child Player instances use the shared media harness.
function mountApp() {
  const slots = [], pending = [];
  let cursor = 0, tree, navigateEvent;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((d, n) => d !== slots[i].deps[n])) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((d, n) => d !== slots[i][n])) { slots[i] = deps; pending.push(fn); } },
    useLayoutEffect() {},
  };
  const api = new Proxy({ onNavigate(fn) { navigateEvent = fn; } }, { get: (o, k) => o[k] || (() => Promise.resolve({})) });
  const context = { module: { exports: {} }, window: { electronAPI: api }, navigator: { platform: 'Mac' }, require: name => {
    if (name === 'react') return react;
    if (name === './i18n') return i18nStub;
    if (name.endsWith('useStealthWindow')) return () => ({ stealthMode: false });
    return name;
  } };
  context.exports = context.module.exports;
  vm.runInNewContext(transformSync(fs.readFileSync(require.resolve('../src/App.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, context);
  const nodes = () => { const out = []; const walk = n => { if (!n || typeof n !== 'object') return; out.push(n); n.children?.forEach(walk); }; walk(tree); return out; };
  const render = () => { cursor = 0; tree = context.module.exports.default({}); pending.splice(0).forEach(fn => fn()); };
  render();
  return { render, request(payload) { navigateEvent({ page: 'player', payload }); render(); },
    navigate(id) { nodes().find(n => n.type === 'button' && n.props.key === id).props.onClick(); render(); },
    player: () => nodes().find(n => n.type === './components/Player') };
}

(async () => {
  let failures = 0;
  const test = async (name, fn) => { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); } };
  for (const change of ['episode', 'series', 'away-and-back']) await test(`late download reply cannot hijack ${change} selection`, async () => {
    const f = fixture(), ui = await start(f);
    const pending = download(ui);
    if (change === 'series') { ui.props.target = { seriesId: 'B', vidIndex: 1, ts: 2 }; await ui.flush(); }
    else { ui.episode(2); await ui.flush(); if (change === 'away-and-back') { ui.episode(1); await ui.flush(); } }
    ui.metadata(); const before = source(ui), plays = ui.mediaCalls.play;
    f.finish(); await pending; await ui.flush();
    f.completed.add('A-1'); f.completed.add('B-1'); await poll(ui);
    assert.equal(source(ui), before, 'late reply must not replace the selected stream');
    assert.equal(ui.mediaCalls.play, plays); ui.unmount();
  });
  for (const paused of [true, false]) await test(`download source swap retains ${paused ? 'pause' : 'play'} and second`, async () => {
    const f = fixture(), ui = await start(f); ui.media.currentTime = 37;
    if (paused) ui.media.pause();
    const pending = download(ui); f.finish(); await pending; await ui.flush();
    f.completed.add('A-1'); await poll(ui); assert.equal(source(ui), 'file:///A-1.mp4');
    ui.metadata(); assert.equal(ui.media.currentTime, 37); assert.equal(ui.media.paused, paused);
    ui.episode(2); await ui.flush(); ui.metadata(); assert.equal(ui.media.paused, false, 'active episode selection still autoplays');
    ui.find(n => n.type === 'video').props.onEnded(); await ui.flush(); ui.unmount();
  });
  await test('feed roundtrip consumes point-play once and restores the latest series/episode/second', async () => {
    const f = fixture(), app = mountApp(); app.request({ seriesId: 'A', vidIndex: 1 });
    let ui = await start(f, app.player().props);
    const initialPrepares = ui.prepares.length;
    app.render(); Object.assign(ui.props, app.player().props); await ui.flush();
    assert.equal(ui.prepares.length, initialPrepares, 'consuming the command must not restart the mounted player');
    ui.episode(2); await ui.flush(); ui.metadata(); ui.media.currentTime = 28;
    app.render(); app.navigate('feed'); assert.equal(app.player(), undefined); ui.unmount();
    app.navigate('player'); ui = await start(f, app.player().props);
    assert.equal(ui.prepares.length, 0, 'returning to library waits for explicit playback');
    ui.button('播放本集').props.onClick(); await ui.flush(); ui.metadata();
    assert.equal(ui.prepares.at(-1).vidIndex, 2, 'consumed initial episode must not replay');
    assert.equal(ui.media.currentTime, 28);
    ui.find(n => n.props.className?.includes('series-picker-btn')).props.onClick(); await ui.flush();
    ui.find(n => n.props.className?.includes('series-row') && n.props.key === 'B').props.onClick();
    await ui.flush(); ui.episode(2); await ui.flush(); ui.metadata(); ui.media.currentTime = 41;
    app.render(); app.navigate('feed'); ui.unmount(); app.navigate('player');
    ui = await start(f, app.player().props);
    assert.equal(ui.prepares.length, 0);
    ui.button('播放本集').props.onClick(); await ui.flush(); ui.metadata();
    assert.equal(ui.prepares.at(-1).seriesId, 'B', 'return must retain the manually selected series');
    assert.equal(ui.prepares.at(-1).vidIndex, 2); assert.equal(ui.media.currentTime, 41); ui.unmount();
  });
  process.exitCode = failures ? 1 : 0;
})();
