// In-memory component behavior only: no user files, network, or playback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { transformSync } = require('esbuild');

function mount(overrides = {}, propOverrides = {}) {
  const file = path.join(__dirname, '../src/components/SequelFinder.jsx');
  assert.ok(fs.existsSync(file), 'SequelFinder must provide the manual next-season entry');
  const source = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const slots = [], effects = [], cleanups = [], calls = [];
  let cursor = 0, tree;
  const props = { seriesId: 'A', active: true, ...propOverrides };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((value, j) => !Object.is(value, slots[i][j]))) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const api = {
    findSeriesSequels: async (id, options) => { calls.push(['find', id, options ? JSON.parse(JSON.stringify(options)) : null]); return { success: true, results: [{ series_id: 'B', series_title: '春日来信第二季' }] }; },
    playSeries: async payload => { calls.push(['play', JSON.parse(JSON.stringify(payload))]); return { success: true }; },
    searchResolve: async id => { calls.push(['resolve', id]); return { success: true, data: { episodes: [{ vid_index: 1, locked: true }, { vid_index: 2 }] } }; },
    ...overrides,
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === '../i18n' ? { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {} } : name === 'react' ? react : {}, window: { electronAPI: api }, setTimeout, clearTimeout });
  const render = () => { cursor = 0; tree = module.exports.default(props); effects.splice(0).forEach(fn => fn()); };
  const find = predicate => { const visit = node => { if (!node || typeof node !== 'object') return; if (predicate(node)) return node; return node.children?.map(visit).find(Boolean); }; return visit(tree); };
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(text).join('') || '';
  const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } };
  render();
  return { api, calls, props, render, flush, find, text: () => text(tree), button: label => find(node => node.type === 'button' && text(node) === label),
    result: () => find(node => node.type === 'button' && text(node).includes('春日来信第二季')),
    query: async () => { await flush(); await find(node => node.type === 'button' && text(node) === '查找下一季').props.onClick(); await flush(); },
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
  };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('next-season discovery is manual, labeled cautiously, and collapsible', async () => {
  const ui = mount(); await ui.flush();
  assert.deepEqual(ui.calls, []); assert.ok(ui.button('查找下一季'));
  await ui.query();
  assert.deepEqual(ui.calls, [['find', 'A', { localOnly: true }], ['find', 'A', null]]);
  assert.match(ui.text(), /可能的续作，请核对剧名/); assert.ok(ui.result());
  await ui.button('收起').props.onClick(); await ui.flush();
  assert.equal(ui.result(), undefined); assert.ok(ui.button('查找下一季'));
});

test('local result opens directly from episode one without resolving online', async () => {
  const ui = mount(); await ui.query();
  await ui.result().props.onClick(); await ui.flush();
  assert.deepEqual(ui.calls, [['find', 'A', { localOnly: true }], ['find', 'A', null], ['play', { seriesId: 'B', vidIndex: 1 }]]);
});

test('only a missing archive resolves and retries the first unlocked episode', async () => {
  const ui = mount(); let played = 0;
  ui.api.playSeries = async payload => { ui.calls.push(['play', JSON.parse(JSON.stringify(payload))]); return ++played === 1 ? { success: false, code: 'SERIES_NOT_FOUND', error: '档案缺失' } : { success: true }; };
  await ui.query(); await ui.result().props.onClick(); await ui.flush();
  assert.deepEqual(ui.calls, [['find', 'A', { localOnly: true }], ['find', 'A', null], ['play', { seriesId: 'B', vidIndex: 1 }], ['resolve', 'B'], ['play', { seriesId: 'B', vidIndex: 2 }]]);
});

test('other play failures remain visible and never resolve online', async () => {
  const ui = mount({ playSeries: async () => ({ success: false, error: '存储不可用' }) });
  await ui.query(); await ui.result().props.onClick(); await ui.flush();
  assert.deepEqual(ui.calls, [['find', 'A', { localOnly: true }], ['find', 'A', null]]); assert.match(ui.text(), /存储不可用/); assert.ok(ui.result());
});

test('failed query can retry and an empty partial result does not claim no sequel exists', async () => {
  const ui = mount({ findSeriesSequels: async () => { throw new Error('网络断开'); } });
  await ui.query(); assert.match(ui.text(), /网络断开/); assert.ok(ui.button('重试'));
  assert.match(ui.text(), /查询未完成/); assert.doesNotMatch(ui.text(), /暂未找到/);
  ui.api.findSeriesSequels = async () => ({ success: true, results: [], partial: true });
  await ui.button('重试').props.onClick(); await ui.flush();
  assert.doesNotMatch(ui.text(), /暂未找到/); assert.match(ui.text(), /查询未完成/); assert.doesNotMatch(ui.text(), /没有续作/);
});

test('local candidates remain playable while remote discovery is pending or fails', async () => {
  const pending = deferred();
  const ui = mount({ findSeriesSequels: async (id, options) => options?.localOnly
    ? { success: true, results: [{ series_id: 'B', series_title: '春日来信第二季' }] } : pending.promise });
  await ui.flush(); const querying = ui.button('查找下一季').props.onClick(); await ui.flush();
  assert.ok(ui.result()); assert.equal(ui.result().props.disabled, false);
  pending.resolve({ success: false, error: '离线' }); await querying; await ui.flush();
  assert.ok(ui.result()); assert.match(ui.text(), /离线/);
  await ui.result().props.onClick(); await ui.flush();
  assert.deepEqual(ui.calls, [['play', { seriesId: 'B', vidIndex: 1 }]]);
});

test('remote season order takes priority while local-only candidates remain at the end', async () => {
  const candidate = season => ({ series_id: String(season), series_title: `春日来信第${season}季` });
  const ui = mount({ findSeriesSequels: async (id, options) => ({ success: true, results: (options?.localOnly ? [2, 4, 5] : [2, 3, 4]).map(candidate) }) });
  await ui.query();
  assert.deepEqual([...ui.text().matchAll(/春日来信第(\d)季/g)].map(match => Number(match[1])), [2, 3, 4, 5]);
});

test('playing a local candidate invalidates pending remote results', async () => {
  const pending = deferred();
  const ui = mount({ findSeriesSequels: async (id, options) => options?.localOnly
    ? { success: true, results: [{ series_id: 'B', series_title: '春日来信第二季' }] } : pending.promise });
  await ui.flush(); const querying = ui.button('查找下一季').props.onClick(); await ui.flush();
  await ui.result().props.onClick(); await ui.flush();
  pending.resolve({ success: true, results: [{ series_id: 'C', series_title: '迟到第三季' }] });
  await querying; await ui.flush(); assert.doesNotMatch(ui.text(), /迟到第三季/);
});

for (const change of ['series', 'page', 'close']) test(`pending query cannot repopulate after ${change}`, async () => {
  const pending = deferred();
  const ui = mount({ findSeriesSequels: () => pending.promise }); await ui.flush();
  const querying = ui.button('查找下一季').props.onClick(); await ui.flush();
  assert.ok(ui.button('正在查找…')?.props.disabled);
  if (change === 'series') ui.props.seriesId = 'C';
  else if (change === 'page') ui.props.active = false;
  else ui.button('收起').props.onClick();
  await ui.flush();
  pending.resolve({ success: true, results: [{ series_id: 'B', series_title: '春日来信第二季' }] });
  await querying; await ui.flush(); assert.equal(ui.result(), undefined);
});

test('switching series during missing-archive resolution cancels the playback retry', async () => {
  const pending = deferred();
  const ui = mount({ playSeries: async () => ({ success: false, code: 'SERIES_NOT_FOUND' }), searchResolve: () => pending.promise });
  await ui.query(); const opening = ui.result().props.onClick(); await ui.flush();
  let retried = false; ui.api.playSeries = async () => { retried = true; return { success: true }; };
  ui.props.seriesId = 'C'; await ui.flush();
  pending.resolve({ success: true, data: { episodes: [{ vid_index: 1 }] } });
  await opening; await ui.flush(); assert.equal(retried, false); assert.equal(ui.result(), undefined);
});

test('Player exposes the finder for its current series and passes page activity', () => {
  const player = fs.readFileSync(path.join(__dirname, '../src/components/Player.jsx'), 'utf8');
  assert.ok(/import SequelFinder from ['"]\.\/SequelFinder['"]/.test(player), 'Player must import SequelFinder');
  assert.ok(/<SequelFinder\s+seriesId=\{activeSeriesId\}\s+active=\{active && !actionsHidden\}/.test(player), 'Player must pass the current series and activity');
});

test('successful empty query reports no result without claiming query failure', async () => {
  const ui = mount({ findSeriesSequels: async () => ({ success: true, results: [] }) });
  await ui.query(); assert.match(ui.text(), /暂未找到/); assert.doesNotMatch(ui.text(), /查询未完成/);
});

test('a late first query cannot clear the retry timeout', async () => {
  const firstRemote = deferred(), secondRemote = deferred();
  let remote = 0;
  const ui = mount({
    findSeriesSequels: (id, options) => options?.localOnly
      ? Promise.resolve({ success: true, results: [] })
      : (++remote === 1 ? firstRemote.promise : secondRemote.promise),
  }, { timeoutMs: 15 });
  await ui.flush();
  ui.button('查找下一季').props.onClick();
  await new Promise(resolve => setTimeout(resolve, 40));
  await ui.flush();
  assert.match(ui.text(), /查询超时/);

  ui.button('重试').props.onClick();
  await new Promise(resolve => setTimeout(resolve, 5));
  // 旧请求晚到：只允许它结束自己，不能清掉第二次查询的计时器。
  firstRemote.resolve({ success: true, results: [] });
  await new Promise(resolve => setTimeout(resolve, 40));
  await ui.flush();
  assert.match(ui.text(), /查询超时/, 'retry must keep its own watchdog');
  assert.doesNotMatch(ui.text(), /正在查找下一季/);
  secondRemote.resolve({ success: true, results: [] });
  await ui.flush();
});

test('a hanging query times out with retry instead of spinning forever', async () => {
  const pending = deferred();
  const ui = mount({ findSeriesSequels: () => pending.promise }, { timeoutMs: 15 });
  await ui.flush();
  ui.button('查找下一季').props.onClick();
  await new Promise(resolve => setTimeout(resolve, 40));
  await ui.flush();
  assert.match(ui.text(), /查询超时/);
  assert.ok(ui.button('重试'));
  ui.api.findSeriesSequels = async () => ({ success: true, results: [] });
  await ui.button('重试').props.onClick();
  await ui.flush();
  assert.doesNotMatch(ui.text(), /查询超时/);
});
