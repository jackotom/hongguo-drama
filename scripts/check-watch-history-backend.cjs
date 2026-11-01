// Offline background refresh regression checks: no app data or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);

function load(sid, { partial = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-history-'));
  const handlers = {}, app = new EventEmitter(), queries = [];
  const current = { series_id: sid, series_title: '春日来信第二季', total: 1, episodes: [{ vid_index: 1, vid: 'one' }] };
  const id = season => sid.startsWith('xifan:') ? `xifan:1:${season}` : sid.startsWith('hema:') ? `hema:${season}` : `100000${season}`;
  const fourth = { series_id: id(4), series_title: '春日来信第四季', total: 1, episodes: [{ vid_index: 1 }] };
  let playback = { [sid]: { watched: true, vid_index: 1, currentTime: 3, updatedAt: 1, lastSequelCheckAt: 1 } };
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} } };
  const search = origin => async keyword => {
    queries.push([origin, keyword]);
    if (partial && keyword.includes('第三季')) return { success: false, error: 'fixture offline' };
    return { success: true, results: keyword.includes('第三季') ? [{ series_id: id(3), series_title: '春日来信第三季' }] : [] };
  };
  const store = { getSettings: () => ({}), getPlayback: () => structuredClone(playback), savePlayback: next => { playback = structuredClone(next); }, saveSeries() {} };
  const hongguoSearch = { searchHongguo: async keyword => {
    const result = await search('hongguo')(keyword);
    if (!result.success) throw new Error(result.error || 'fixture offline');
    return { results: result.results || [], total: (result.results || []).length, page: 1, totalPages: 1, hasMore: false };
  } };
  const overrides = { electron, './src/store': store, './src/native/hongguo': { fetchEpisodeList: async () => current }, './src/native/hongguo-search': hongguoSearch,
    './src/native/hongguo-app-search': { searchApp: async () => { throw new Error('fixture App search unavailable'); } },
    './src/native/hongguo-app-new': { searchNewReleasesDetailed: async () => ({ results: [], partial: false }) },
    './src/native/xifan': { search: search('xifan') }, './src/native/hema': { search: search('hema') } };
  const context = vm.createContext({ require: name => overrides[name] || req(name), __dirname: path.dirname(source), process, console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  context.fixture = [current, fourth]; vm.runInContext('seriesRegistry = fixture', context);
  return { queries, run: () => handlers['refresh-watch-history']({}), record: () => playback[sid], cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

for (const [sourceName, sid] of [['hongguo', '1000002'], ['xifan', 'xifan:1:2'], ['hema', 'hema:2']]) test(`background ${sourceName} refresh fills next missing season with bounded same-source searches`, async () => {
  const h = load(sid);
  try {
    const result = await h.run();
    assert.equal(result.checked, 1); assert.equal(result.failed, 0);
    assert.equal(h.queries.length, 3, 'base plus at most two supplemental queries');
    assert.ok(h.queries.every(([source]) => source === sourceName));
    assert.ok(h.queries.some(([, keyword]) => keyword === '春日来信第三季'));
    assert.deepEqual(h.record().sequels.map(row => row.series_title), ['春日来信第三季', '春日来信第四季']);
  } finally { h.cleanup(); }
});

for (const sid of ['custom:fixture:2', 'unknown:2']) test(`background refresh skips unsupported sequel sources: ${sid}`, async () => {
  const h = load(sid);
  try { const result = await h.run(); assert.equal(result.checked, 1); assert.deepEqual(h.queries, []); assert.equal(h.record().lastCheckError, ''); }
  finally { h.cleanup(); }
});

test('partial background sequel lookup keeps local candidates and exposes incomplete check', async () => {
  const h = load('1000002', { partial: true });
  try {
    const result = await h.run(); assert.equal(result.checked, 1); assert.equal(result.failed, 1);
    assert.match(h.record().lastCheckError, /续作检查.*未完成/);
    assert.equal(h.record().lastSequelCheckAt, 1, 'partial result must not become a successful 24-hour checkpoint');
    assert.deepEqual(h.record().sequels.map(row => row.series_title), ['春日来信第四季']);
  } finally { h.cleanup(); }
});
