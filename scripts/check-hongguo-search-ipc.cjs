// Offline wiring check: Hongguo search uses the website API first, keeps page
// sniffing only for format changes, and does not wait for a page after timeouts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);

function load(searchHongguo, searchApp = async () => { throw Object.assign(new Error('fixture App search unavailable'), { code: 'APP_EMPTY' }); }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-search-ipc-'));
  const handlers = {}, app = new EventEmitter();
  Object.assign(app, {
    getVersion: () => 'test',
    getPath: () => dir,
    commandLine: { appendSwitch() {}, hasSwitch: () => false },
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then() {} }),
  });
  const electron = { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, protocol: { registerSchemesAsPrivileged() {} } };
  const overrides = {
    electron,
    './src/store': { getSettings: () => ({}) },
    './src/native/hongguo-search': { searchHongguo },
    './src/native/hongguo-app-search': { searchApp },
    './src/native/hongguo-app-new': { searchNewReleasesDetailed: async () => ({ results: [], partial: false }) },
    './src/native/hongguo': { fetchEpisodeList: async () => ({ episodes: [] }) },
  };
  const context = vm.createContext({
    require: name => overrides[name] || req(name),
    __dirname: path.dirname(source),
    process,
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  return { handlers, context, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function failure(message, kind, fallback) {
  const error = new Error(message);
  error.name = 'HongguoSearchError';
  error.kind = kind;
  error.fallback = fallback;
  return error;
}

(async () => {
  let harness = load(async keyword => ({
    results: [{ series_id: '1234567', series_title: `${keyword}`, cover: '', episode_count: 10, tags: [] }],
    total: 1, page: 1, totalPages: 1, hasMore: false,
  }));
  let result = await harness.handlers['search-series']({}, '测试剧', { source: 'hongguo' });
  assert.equal(result.success, true);
  assert.equal(result.via, 'api');
  assert.equal(result.results[0].series_title, '测试剧');
  harness.cleanup();

  harness = load(async () => { throw failure('红果搜索接口已变化（HTTP 404）', 'format', true); });
  let sniffed = 0, fallbackOptions = null;
  harness.context.runSearchSniff = async (keyword, options) => {
    sniffed++;
    fallbackOptions = options;
    return { success: true, results: [{ series_id: '7654321', series_title: '页面兜底剧' }], pageTitle: '', meta: {} };
  };
  result = await harness.handlers['search-series']({}, '测试剧', { source: 'hongguo' });
  assert.equal(sniffed, 1, 'format changes fall back to the page once');
  assert.ok(fallbackOptions?.deadline > Date.now(), 'page fallback must receive the remaining total budget');
  assert.equal(result.via, 'dom');
  assert.match(result.apiError, /接口已变化/);
  assert.equal(result.results[0].series_title, '页面兜底剧');
  harness.cleanup();

  harness = load(async () => { throw failure('红果搜索超时，请稍后重试', 'timeout', false); });
  let pageWaits = 0;
  harness.context.runSearchSniff = async () => { pageWaits++; return { success: true, results: [] }; };
  result = await harness.handlers['search-series']({}, '测试剧', { source: 'hongguo' });
  assert.equal(result.success, false);
  assert.match(result.error, /超时/);
  assert.equal(pageWaits, 0, 'a timeout must not add another page wait');
  harness.cleanup();

  const fuzzyCalls = [];
  harness = load(async keyword => {
    fuzzyCalls.push(keyword);
    const unrelated = keyword.includes('，');
    return {
      results: [{ series_id: unrelated ? '1111111' : '2222222', series_title: unrelated ? '完全无关的剧' : '测试剧别名' }],
      total: 1, page: 1, totalPages: 1, hasMore: false,
    };
  });
  result = await harness.handlers['search-series']({}, '测试剧，别名', { source: 'hongguo' });
  assert.deepEqual(fuzzyCalls, ['测试剧，别名', '测试剧别名'], 'one punctuation-relaxed search replaces a missing title match');
  assert.equal(result.success, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.meta.relaxed, true);
  assert.equal(result.meta.relaxedQuery, '测试剧别名');
  harness.cleanup();

  const clauseCalls = [];
  harness = load(async keyword => {
    clauseCalls.push(keyword);
    const title = keyword === '测试剧' ? '测试剧' : keyword === '测试剧特别篇别名' ? '另一部剧' : '完全无关的剧';
    return { results: [{ series_id: String(clauseCalls.length), series_title: title }], total: 1, page: 1, totalPages: 1, hasMore: false };
  });
  result = await harness.handlers['search-series']({}, '测试剧，特别篇 别名', { source: 'hongguo' });
  assert.deepEqual(clauseCalls, ['测试剧，特别篇 别名', '测试剧特别篇别名', '测试剧'], 'two bounded relaxed searches: stripped title then first clause');
  assert.equal(result.meta.relaxed, true);
  assert.equal(result.meta.relaxedQuery, '测试剧特别篇别名、测试剧');
  assert.equal(result.results.length, 3);
  harness.cleanup();

  const exactCalls = [];
  harness = load(async keyword => {
    exactCalls.push(keyword);
    return { results: [{ series_id: '3333333', series_title: '测试剧第三季' }], total: 1, page: 1, totalPages: 1, hasMore: false };
  });
  await harness.handlers['search-series']({}, '测试剧第三季', { source: 'hongguo' });
  assert.deepEqual(exactCalls, ['测试剧第三季'], 'a title match must not trigger an extra search');
  harness.cleanup();

  const appSupplementCalls = [];
  harness = load(async () => ({
    results: [{ series_id: '5555555', series_title: '同题材无关剧' }], total: 1, page: 1, totalPages: 1, hasMore: false,
  }), async keyword => {
    appSupplementCalls.push(keyword);
    return {
      results: [{ series_id: '6666666', series_title: '最后生还的猫第二季', cover: '', episode_count: 20 }],
      hasMore: false,
    };
  });
  result = await harness.handlers['search-series']({}, '最后生还的猫', { source: 'hongguo' });
  assert.deepEqual(appSupplementCalls, ['最后生还的猫'], 'a missing exact website match must try App search even when App-first is off');
  assert.deepEqual(new Set(result.results.map(item => item.series_id)), new Set(['5555555', '6666666']));
  assert.equal(result.meta.appSupplement, 1);
  harness.cleanup();

  const budgetAppCalls = [];
  harness = load(async () => ({
    results: [{ series_id: '7777777', series_title: '同题材无关剧' }], total: 1, page: 1, totalPages: 1, hasMore: false,
  }), async (keyword, options = {}) => {
    if (options.deadline <= Date.now()) throw Object.assign(new Error('App 搜索超时'), { code: 'APP_TIMEOUT' });
    budgetAppCalls.push(keyword);
    return {
      results: [{ series_id: '8888888', series_title: '预算恢复后命中的剧', cover: '', episode_count: 0 }],
      hasMore: false,
    };
  });
  await harness.context.searchAtSourcePage('预算恢复后命中的剧', {
    source: 'hongguo', page: 1, fuzzy: true, deadline: Date.now() - 1,
  });
  assert.deepEqual(budgetAppCalls, [], 'an expired budget must not start or cool down App search');
  await harness.context.searchAtSourcePage('预算恢复后命中的剧', {
    source: 'hongguo', page: 1, fuzzy: true, deadline: Date.now() + 8000,
  });
  assert.deepEqual(budgetAppCalls, ['预算恢复后命中的剧'], 'a later search must still reach App fallback');
  harness.cleanup();

  harness = load(async keyword => {
    if (keyword === '无结果，补搜失败') return { results: [], total: 0, page: 1, totalPages: 0, hasMore: false };
    throw new Error('HTTP 502');
  });
  result = await harness.handlers['search-series']({}, '无结果，补搜失败', { source: 'hongguo' });
  assert.equal(result.success, false, 'failed relaxed searches must not look like a successful empty result');
  assert.match(result.error, /HTTP 502/);
  harness.cleanup();

  harness = load(async keyword => {
    if (keyword === '原词，失败') return { results: [{ series_id: '4444444', series_title: '无关结果' }], total: 1, page: 1, totalPages: 1, hasMore: false };
    throw new Error('HTTP 502');
  });
  result = await harness.handlers['search-series']({}, '原词，失败', { source: 'hongguo' });
  assert.equal(result.success, true);
  assert.equal(result.partial, true);
  assert.match(result.error, /补充搜索未完成/);
  assert.equal(result.results.length, 1);
  harness.cleanup();

  console.log('PASS hongguo search IPC: API first, format fallback, no page wait after timeout and bounded relaxed retries');
})().catch(error => { console.error('FAIL hongguo search IPC: ' + error.message); process.exitCode = 1; });
