// Pure in-memory hook checks; no browser, real playback or upstream requests.
const i18nStub = { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {}, getLanguage: () => 'zh-CN' };
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const root = path.join(__dirname, '../src/components');
const player = fs.readFileSync(path.join(root, 'Player.jsx'), 'utf8');
function extractWiring(source) {
  const normalized = source.replace(/\r\n/g, '\n');
  const start = normalized.indexOf('  const danmakuSource =');
  const end = normalized.indexOf('\n\n  useEffect', start);
  assert(start >= 0 && end > start, 'Player danmaku hook boundaries must be present');
  return normalized.slice(start, end);
}
const wiring = extractWiring(player);
assert.equal(extractWiring(player.replace(/\r?\n/g, '\r\n')), wiring, 'Windows CRLF must select the same hook code');

function mount({ response, enabled = true } = {}) {
  const slots = [], effects = [], cleanups = [], requests = [], intervals = new Map();
  const storage = new Map([['hongguo:comment-danmaku:v1', JSON.stringify({ enabled, fontSize: 26, opacity: 65, blockedWords: '屏蔽' })]]);
  let cursor = 0, tree;
  const props = { activeSeriesId: '7503745441910017049', current: { vid: '7503780574541122622' }, active: true, canPlay: true, showDanmakuControls: true };
  const changed = (old, deps) => !old || deps.some((v, i) => !Object.is(v, old[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const window = Object.assign(new EventTarget(), {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setInterval: fn => { const id = Symbol(); intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    electronAPI: {
      getEpisodeDanmaku: async args => {
        requests.push({ source: 'official', ...args });
        return response ? response(args, requests.length) : { success: true, series_id: args.seriesId, episode_id: args.vid, items: [{ time: 10, text: '十秒弹幕' }] };
      },
      getEpisodeComments: async args => { requests.push({ source: 'comments', ...args }); return { success: true, series_id: args.seriesId, episode_id: args.episodeId, items: [{ id: 'comment', content: '本集评论' }], has_more: false }; },
    },
  });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const modules = new Map();
  function load(file) {
    if (!path.extname(file)) file += '.jsx';
    if (file.endsWith('.css')) return {};
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const source = transformSync(fs.readFileSync(file, 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs' }).code;
    vm.runInNewContext(source, { module, exports: module.exports, require: name => name === '../i18n' ? i18nStub : name === 'react' ? react : load(path.resolve(path.dirname(file), name)), window, document, CustomEvent, console });
    return module.exports;
  }
  const source = load(path.join(root, 'danmakuSource.mjs'));
  const context = vm.createContext({ ...source, ...load(path.join(root, 'CommentDanmaku.jsx')), ...load(path.join(root, 'OfficialDanmaku.jsx')), props });
  vm.runInContext(`function renderWiring() { const {activeSeriesId,current,active,canPlay,showDanmakuControls} = props; ${wiring}\nreturn {danmaku,commentDanmaku,officialDanmaku}; }`, context);
  const render = () => { cursor = 0; tree = context.renderWiring(); effects.splice(0).forEach(fn => fn()); return tree; };
  const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } return tree; };
  render();
  return { props, requests, storage, intervals, render, flush, source, get tree() { return tree; }, unmount() { cleanups.forEach(fn => fn?.()); } };
}

(async () => {
  const ui = mount();
  await ui.flush();
  assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].source, 'official');
  assert.equal(ui.tree.danmaku.settings.fontSize, 26); assert.equal(ui.tree.danmaku.settings.opacity, 65);
  ui.tree.danmaku.update({ fontSize: 30 }); await ui.flush();
  ui.source.writeDanmakuSource('comments'); await ui.flush();
  assert.equal(ui.requests.length, 2); assert.equal(ui.requests[1].source, 'comments');
  assert.equal(ui.tree.danmaku.settings.fontSize, 30); assert.equal(ui.tree.danmaku.settings.blockedWords, '屏蔽');
  ui.source.writeDanmakuSource('official'); await ui.flush();
  assert.equal(ui.requests.length, 2, 'loaded source must reuse its current feed');
  assert.equal(ui.intervals.size, 0, 'unselected comments source must stop its request timer');
  ui.props.activeSeriesId = 'custom:example'; await ui.flush();
  assert.equal(ui.requests.length, 2); assert.match(ui.tree.danmaku.status, /仅红果来源/); ui.unmount();

  const off = mount({ enabled: false }); await off.flush(); assert.equal(off.requests.length, 0); off.unmount();
  const hidden = mount({ enabled: false }); hidden.props.showDanmakuControls = false;
  hidden.tree.danmaku.toggle(); await hidden.flush(); assert.equal(hidden.requests.length, 0); hidden.unmount();

  const retry = mount({ response: (args, count) => count === 1
    ? { success: false, series_id: args.seriesId, episode_id: args.vid, items: [], error: '模拟接口异常' }
    : { success: true, series_id: args.seriesId, episode_id: args.vid, items: [{ time: 5, text: '恢复' }] } });
  await retry.flush(); assert.equal(retry.tree.danmaku.status, '模拟接口异常');
  retry.tree.danmaku.retry(); await retry.flush();
  assert.equal(retry.requests.length, 2); assert.equal(retry.requests[1].fresh, true);
  assert.equal(retry.tree.danmaku.comments.length, 1); assert.equal(retry.tree.danmaku.error, ''); retry.unmount();

  let settleOld;
  const pending = mount({ response: (args, count) => count === 1 ? new Promise(resolve => { settleOld = resolve; })
    : { success: true, series_id: args.seriesId, episode_id: args.vid, items: [{ time: 8, text: '当前请求' }] } });
  pending.source.writeDanmakuSource('comments'); await pending.flush();
  pending.source.writeDanmakuSource('official'); await pending.flush();
  assert.equal(pending.requests.filter(r => r.source === 'official').length, 2, 'switching back during pending request must not stay loading');
  settleOld({ success: false, series_id: pending.props.activeSeriesId, episode_id: pending.props.current.vid, items: [], error: '迟到的旧请求' });
  await pending.flush(); assert.equal(pending.tree.danmaku.error, ''); assert.equal(pending.tree.danmaku.comments[0].text, '当前请求');
  pending.props.current = { vid: '7503780574541122623' }; await pending.flush();
  assert.equal(pending.requests.at(-1).vid, pending.props.current.vid); pending.unmount();

  const overlay = fs.readFileSync(path.join(root, 'OfficialDanmaku.jsx'), 'utf8');
  assert.match(overlay, /querySelector\('\.player-controls-bar'\)/);
  assert.doesNotMatch(overlay, /querySelector\('\.player-controls'\)/);
  assert.match(overlay, /advanceTimedDanmaku\(state, list, video.currentTime/);
  const settings = fs.readFileSync(path.join(root, 'Settings.jsx'), 'utf8');
  assert.match(settings, /openExternalUrl\('https:\/\/github.com\/dawei233\/hongguo-drama'\)/);
  // check-player-controls.cjs verifies the 2.9 one-second pointer idle deadline,
  // including playback keys and fullscreen/source changes that must not renew it.
  console.log('PASS frontend source wiring: default/selective fetch/shared preferences/retry/stale response/episode switch/control-bar bounds/source attribution');
})().catch(error => { console.error(error); process.exitCode = 1; });
