// Focused 3.7 checks: family grouping, detection scopes, single-row refresh and split errors.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const baseTitle = '聚宝仙盆之杂灵根才是真BOSS';

function fixture({ failId = '', now = Date.now(), remoteSeries = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-history-37-'));
  const handlers = {}, queries = [], fetches = [];
  const seriesList = [1, 2, 3].map(season => ({
    series_id: `100000${season}`,
    series_title: `${baseTitle}${season === 1 ? '' : `第${['', '一', '二', '三'][season]}季`}`,
    total: 10,
    episodes: Array.from({ length: 10 }, (_, index) => ({ vid_index: index + 1, vid: `${season}-${index + 1}` })),
  }));
  const playback = Object.fromEntries(seriesList.map((item, index) => [item.series_id, {
    watched: true, vid_index: 1, currentTime: 5, updatedAt: now - index,
    knownTotal: 10, acknowledgedTotal: 10, completedEpisode: index === 0 ? 10 : 0,
    lastCheckedAt: now - 7 * 60 * 60 * 1000, lastSequelCheckAt: 1,
  }]));
  const app = new EventEmitter();
  Object.assign(app, { getVersion: () => '3.7.0', getPath: () => dir, commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    protocol: { registerSchemesAsPrivileged() {} } };
  const store = {
    getSettings: () => ({ watch_updates_enabled: true, watch_sequels_enabled: true }),
    getPlayback: () => structuredClone(playback),
    savePlayback: next => { Object.keys(playback).forEach(key => delete playback[key]); Object.assign(playback, structuredClone(next)); },
    saveSeries() {},
  };
  const hongguo = {
    fetchEpisodeList: async id => {
      fetches.push(String(id));
      if (String(id) === failId) throw new Error('分集接口超时');
      return structuredClone(seriesList.find(item => item.series_id === String(id)));
    },
  };
  const hongguoSearch = {
    searchHongguo: async keyword => {
      queries.push(String(keyword));
      const results = String(keyword).toLowerCase() === baseTitle.toLowerCase() ? [...seriesList, ...remoteSeries] : [];
      return { results, total: results.length, page: 1, totalPages: 1, hasMore: false };
    },
  };
  const overrides = {
    electron, './src/store': store, './src/native/hongguo': hongguo,
    './src/native/hongguo-search': hongguoSearch,
    './src/native/xifan': { search: async () => ({ success: true, results: [] }) },
    './src/native/hema': { search: async () => ({ success: true, results: [] }) },
  };
  const context = vm.createContext({
    require: name => overrides[name] || req(name), __dirname: path.dirname(source), process,
    console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers,
    AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  context.fixture = seriesList;
  vm.runInContext('seriesRegistry = fixture', context);
  return {
    playback, queries, fetches, handlers,
    refresh: options => handlers['refresh-watch-history']({}, options),
    autoRefresh: () => vm.runInContext('refreshWatchHistory()', context),
    checkOne: id => handlers['check-watch-history-item']({}, id),
    clearSequelCache: () => vm.runInContext('historySequelCache.clear()', context),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('3.7 batch checks every season but searches the family sequel once', async () => {
  const h = fixture();
  try {
    const result = await h.refresh({ scope: 'all' });
    assert.equal(result.checked, 3);
    assert.deepEqual(h.fetches.sort(), ['1000001', '1000002', '1000003']);
    assert.equal(h.queries.filter(keyword => keyword.toLowerCase() === baseTitle.toLowerCase()).length, 1,
      'the same family must not repeat the base search for every season');
    assert.equal(h.playback['1000001'].sequels.length, 2, 'low seasons receive matching higher seasons');
    assert.equal(h.playback['1000002'].sequels.length, 1);
    assert.equal(h.playback['1000003'].sequels.length, 0);
  } finally { h.cleanup(); }
});

test('3.7 latest scope and single-row check touch only the requested row', async () => {
  const latest = fixture();
  try {
    assert.equal((await latest.refresh({ scope: 'latest' })).checked, 1);
    assert.deepEqual(latest.fetches, ['1000003']);
  } finally { latest.cleanup(); }

  const single = fixture();
  try {
    const result = await single.checkOne('1000001');
    assert.equal(result.success, true);
    assert.deepEqual(single.fetches, ['1000001']);
    assert.equal(single.queries.filter(keyword => keyword.toLowerCase() === baseTitle.toLowerCase()).length, 1,
      'single-row check still uses the latest family season for the shared sequel search');
    assert.equal(single.playback['1000001'].sequels.length, 2);
  } finally { single.cleanup(); }
});

test('3.7 completed low seasons skip automatic 6-hour checks but remain manually checkable', async () => {
  const h = fixture();
  try {
    assert.equal((await h.autoRefresh()).checked, 2);
    assert.deepEqual(h.fetches.sort(), ['1000002', '1000003']);
    assert.equal((await h.checkOne('1000001')).success, true);
    assert.ok(h.fetches.includes('1000001'));
  } finally { h.cleanup(); }
});

test('3.7 episode failures remain separate from sequel results', async () => {
  const h = fixture({ failId: '1000002' });
  try {
    const result = await h.refresh({ scope: 'all' });
    assert.equal(result.checked, 2);
    assert.equal(result.failed, 1);
    assert.match(h.playback['1000002'].lastEpisodeCheckError, /超时/);
    assert.equal(h.playback['1000002'].lastSequelCheckError, '');
    assert.equal(h.playback['1000001'].lastEpisodeCheckError, '');
  } finally { h.cleanup(); }
});

test('explicit season variants group safely; bare and changed titles only suggest a relation', () => {
  const { listHistory, findSequels, findSimilarSeries, familyKey } = require('../src/native/watch-history');
  const original = { series_id: '1000011', series_title: '游戏入侵：普攻加血一箭亿万伤屠戮神明' };
  const variants = ['游戏入侵：普攻加血一箭亿万伤屠戮神明二', '游戏入侵：普攻加血一箭亿万伤屠戮神明2',
    '游戏入侵：普攻加血一箭亿万伤屠戮神明归来第二季', '游戏入侵：普攻回血一箭亿万伤屠戮神明第二季'];
  const candidates = variants.map((series_title, i) => ({ series_id: String(1000020 + i), series_title }));
  assert.deepEqual(findSimilarSeries(original, candidates).map(item => item.series_id), candidates.map(item => item.series_id));
  assert.deepEqual(findSequels(original, candidates), [], 'fuzzy matches must never enter confirmed sequel handling');
  for (const suffix of ['第2季', '第二季', '2季', '二部', '（第二季）', '(2部)', 'season 2']) {
    const next = { series_id: '1000030', series_title: original.series_title + suffix };
    assert.equal(familyKey(next), familyKey(original), suffix);
    assert.equal(findSequels(original, [next]).length, 1, suffix);
  }
  const embedded = [{ series_id: '1000040', series_title: 'AAA1BBB' }, { series_id: '1000041', series_title: 'AAA2BBB' }];
  assert.equal(findSimilarSeries(embedded[0], [embedded[1], embedded[1]]).length, 1);
  assert.equal(findSimilarSeries({ ...embedded[0], series_title: 'AAA9BBB' }, [
    { ...embedded[1], series_title: 'AAA10BBB' }, { series_id: '1000042', series_title: 'AAA十二BBB' },
  ]).length, 2, 'embedded season numbers may grow or switch between Arabic and Chinese');
  const rows = [original, ...candidates, ...embedded].map(item => ({ ...item, total: 1 }));
  const playback = Object.fromEntries(rows.map(item => [item.series_id, { watched: true, vid_index: 1, currentTime: 1, updatedAt: 100 }]));
  assert.ok(listHistory(rows, playback).every(row => !row.hasHigherSeason && !row.hasUpdates), 'suggestions must neither hide rows nor create update dots');
  assert.ok(listHistory(rows, playback, false).every(row => row.similarSeries.length === 0), 'disabling sequel detection also hides suggestions');
  assert.deepEqual(findSimilarSeries(original, [
    { ...candidates[0], series_id: 'hema:2' }, { ...candidates[0], series_id: 'unknown:1' },
    { series_id: '1000050', series_title: '完全无关的另一部短剧第二季' },
  ]), [], 'unrelated titles and other sources must not be suggested');
  assert.deepEqual(findSimilarSeries({ ...original, series_title: '甲乙' }, [{ series_id: '1000051', series_title: '甲丙' }]), [], 'short generic titles are too ambiguous');
  assert.notEqual(familyKey({ ...original, series_title: '年轮（2024）' }), familyKey({ ...original, series_title: '年轮（2025）' }));
  for (const suffix of ['（2024）', '(0)', '(100)', '(二〇二四)', '(二零二四)', '(一百)', '第0季']) {
    assert.deepEqual(findSequels(original, [{ series_id: '1000052', series_title: original.series_title + suffix }]), [], suffix);
  }
});

test('remote fuzzy candidates survive refresh as hints without becoming updates or hidden seasons', async () => {
  const candidate = { series_id: '1000099', series_title: baseTitle + '二' };
  const h = fixture({ remoteSeries: [candidate] });
  try {
    assert.equal((await h.checkOne('1000003')).success, true);
    assert.deepEqual(h.playback['1000003'].similarSeries, [candidate]);
    assert.deepEqual(h.playback['1000003'].sequels, []);
    const result = await h.handlers['get-watch-history']({});
    const row = result.results.find(item => item.series_id === '1000003');
    assert.deepEqual(row.similarSeries, [candidate]);
    assert.equal(row.hasUpdates, false);
    assert.equal(row.hasHigherSeason, false);
  } finally { h.cleanup(); }
});

test('a renamed candidate replaces its old fuzzy title and becomes a confirmed sequel', async () => {
  const candidate = { series_id: '1000099', series_title: baseTitle + '二' };
  const h = fixture({ remoteSeries: [candidate] });
  try {
    await h.checkOne('1000003');
    assert.equal(h.playback['1000003'].similarSeries.length, 1);
    candidate.series_title = baseTitle + '第四季';
    h.clearSequelCache();
    await h.checkOne('1000003');
    assert.deepEqual(h.playback['1000003'].similarSeries, [], 'a fresh explicit title must replace the old fuzzy entry with the same ID');
    assert.deepEqual(h.playback['1000003'].sequels, [candidate]);
  } finally { h.cleanup(); }
});
