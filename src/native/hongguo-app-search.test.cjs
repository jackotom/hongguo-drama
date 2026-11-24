const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { signedSearchRequest: signSearch } = require('./app-source');
const identity = Object.freeze({ device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '00000000-0000-4000-8000-000000000003' });
const signedSearchRequest = options => signSearch({ ...options, identity });
function loadSearch(getPlaybackDevice = async () => identity) {
  const file = path.join(__dirname, 'hongguo-app-search.js'), req = createRequire(file), module = { exports: {} };
  const run = vm.runInThisContext(wrap(fs.readFileSync(file, 'utf8')), { filename: file });
  run(module.exports, name => name === './playback-device' ? { getPlaybackDevice } : req(name), module, file, __dirname);
  return module.exports;
}
const { searchApp, parseSearchPayload } = loadSearch();

const payload = {
  code: 0,
  search_tabs: [{
    tab_type: 11, has_more: true, next_offset: 20, search_id: 'sid-1', passback: 'pb-1',
    data: [
      { book_id: '123', search_high_light: { title: { text: '测试短剧' } },
        video_data: [{ series_id: '123', title: 'ignored', cover: 'https://img.example/a.jpg', episode_cnt: 88 }] },
      { video_data: [] },
    ],
  }],
};

test('search and pagination sign with the registered identity instead of new random IDs', async () => {
  let deviceLookups = 0;
  const search = loadSearch(async requestJson => { assert.equal(typeof requestJson, 'function'); deviceLookups++; return identity; }).searchApp;
  for (const page of [1, 2]) await search('测试短剧', { page, cursor: { search_id: 'sid-1', next_offset: (page - 1) * 20 }, request: async signed => {
    const query = new URL(signed.url).searchParams;
    assert.equal(query.get('device_id'), identity.device_id);
    assert.equal(query.get('iid'), identity.iid);
    assert.equal(query.get('cdid'), identity.cdid);
    assert.ok(signed.headers['x-gorgon']); assert.ok(signed.headers['x-medusa']);
    return payload;
  } });
  assert.equal(deviceLookups, 2, 'each search must obtain the process-shared registration');
});

test('registration failure never sends a search with an unregistered fallback identity', async () => {
  const search = loadSearch(async () => { throw Object.assign(new Error('registration unavailable'), { code: 'DEVICE_REGISTRATION_FAILED' }); }).searchApp;
  await assert.rejects(search('测试短剧', { request: async () => { assert.fail('search must not run after registration failure'); } }), error => error.code === 'DEVICE_REGISTRATION_FAILED');
});

test('search signing requires a valid registered identity', () => {
  for (const value of [undefined, {}, { device_id: '0', iid: '0' }, { device_id: 9007199254740992, iid: '1' }]) {
    assert.throws(() => signSearch({ keyword: '测试短剧', identity: value }), error => error.code === 'APP_INPUT');
  }
});

test('App search parses titles, ids, covers and cursors', () => {
  const result = parseSearchPayload(payload);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].series_id, '123');
  assert.equal(result.results[0].series_title, '测试短剧');
  assert.equal(result.results[0].cover, 'https://img.example/a.jpg');
  assert.equal(result.results[0].episode_count, 88);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.cursor, { search_id: 'sid-1', passback: 'pb-1', next_offset: 20 });
});

test('HEIC covers become a placeholder instead of a broken image', () => {
  const result = parseSearchPayload({ ...payload, search_tabs: [{ ...payload.search_tabs[0], data: [
    { search_high_light: { title: { text: 'HEIC 剧' } }, video_data: [{ series_id: '456', cover: 'https://img.example/a.heic?x=1' }] },
  ] }] });
  assert.equal(result.results[0].cover, '');
});

test('creator collections map their album identity and episode count', () => {
  const result = parseSearchPayload({ ...payload, search_tabs: [{ ...payload.search_tabs[0], data: [
    { search_high_light: { title: { text: '创作者合集' } },
      video_data: [{ series_id: '7676321126145854488', title: '创作者合集', content_type: 1003, episode_cnt: 0, duration: 0,
        album_info: { album_id_str: '7676321126145854488', title: '创作者合集', episode_cnt: 20 } }] },
    { search_high_light: { title: { text: '正常短剧' } },
      video_data: [{ series_id: '7670427740574600216', title: '正常短剧', content_type: 1004, episode_cnt: 71 }] },
  ] }] });
  assert.deepEqual(result.results.map(item => [item.series_title, item.series_id, item.content_type, item.episode_count]), [
    ['创作者合集', '7676321126145854488', '1003', 20],
    ['正常短剧', '7670427740574600216', '1004', 71],
  ]);
});

test('short-drama results remain visible while episode count is not filled yet', () => {
  const result = parseSearchPayload({ ...payload, search_tabs: [{ ...payload.search_tabs[0], data: [
    { search_high_light: { title: { text: '刚上线的新剧' } },
      video_data: [{ series_id: '7670427740574600217', title: '刚上线的新剧', content_type: 1004, episode_cnt: 0 }] },
  ] }] });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].series_id, '7670427740574600217');
  assert.equal(result.results[0].content_type, '1004');
  assert.equal(result.results[0].episode_count, 0);
});

test('the signed request uses branch-0 search headers and carries the keyword', async () => {
  let captured;
  const result = await searchApp('测试短剧', { request: async (signed, deadline) => {
    captured = { signed, deadline };
    return payload;
  } });
  assert.equal(result.page, 1);
  assert.ok(captured.deadline > Date.now());
  assert.match(captured.signed.url, /reading\/bookapi\/search\/tab\/v\?/);
  assert.match(decodeURIComponent(captured.signed.url), /query=测试短剧/);
  assert.ok(captured.signed.headers['x-gorgon']);
  assert.ok(captured.signed.headers['x-medusa']);
  assert.equal(captured.signed.headers['content-type'], undefined);
  const direct = signedSearchRequest({ keyword: '测试短剧', page: 1 });
  assert.ok(direct.headers['x-ss-req-ticket']);
});

test('pagination requires a cursor and business/schema errors are classified', async () => {
  await assert.rejects(searchApp('测试短剧', { page: 2 }), error => error.code === 'APP_CURSOR');
  await assert.rejects(searchApp('测试短剧', { request: async () => ({ code: 7 }) }), error => error.code === 'APP_BUSINESS');
  await assert.rejects(searchApp('测试短剧', { request: async () => ({ search_tabs: [] }) }), error => error.code === 'APP_TAB_MISSING');
  await assert.rejects(searchApp('测试短剧', { request: async () => null }), error => error.code === 'APP_EMPTY');
});

test('invalid next offsets stay absent and signed requests fall back to the page offset', () => {
  for (const next_offset of [null, undefined, '', '  ', false, true, [], {}, -1, 1.5, '1.5', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const result = parseSearchPayload({ ...payload, search_tabs: [{ ...payload.search_tabs[0], next_offset }] });
    assert.equal(result.cursor.next_offset, null, `invalid offset: ${String(next_offset)}`);
    const signed = signedSearchRequest({ keyword: '测试短剧', page: 3, cursor: { search_id: 'sid-1', next_offset } });
    assert.equal(new URL(signed.url).searchParams.get('offset'), '40');
  }
  for (const next_offset of [0, '0', 40, '40']) {
    const result = parseSearchPayload({ ...payload, search_tabs: [{ ...payload.search_tabs[0], next_offset }] });
    assert.equal(result.cursor.next_offset, Number(next_offset));
    const signed = signedSearchRequest({ keyword: '测试短剧', page: 2, cursor: result.cursor });
    assert.equal(new URL(signed.url).searchParams.get('offset'), String(next_offset));
  }
});

test('a search id without an offset still advances to later pages', async () => {
  for (const page of [2, '3']) {
    const result = await searchApp('测试短剧', { page, cursor: { search_id: 'sid-1', next_offset: null }, request: async signed => {
      assert.equal(new URL(signed.url).searchParams.get('offset'), String((Number(page) - 1) * 20));
      return payload;
    } });
    assert.equal(result.page, Number(page));
  }
  await assert.rejects(searchApp('测试短剧', { page: 2, cursor: { next_offset: -1 } }), error => error.code === 'APP_CURSOR');
});

test('invalid pages are rejected before signing or requesting', async () => {
  for (const page of [null, '', ' ', false, true, [], {}, 0, -1, 1.5, '2.5', 51, 100, Infinity, NaN, 'bad']) {
    await assert.rejects(searchApp('测试短剧', { page, cursor: { search_id: 'sid-1' }, request: async () => {
      assert.fail('invalid page must not reach the request');
    } }), error => error.code === 'APP_INPUT', `invalid page: ${String(page)}`);
    assert.throws(() => signedSearchRequest({ keyword: '测试短剧', page }), error => error.code === 'APP_INPUT');
    assert.throws(() => parseSearchPayload(payload, { page }), error => error.code === 'APP_INPUT');
  }
});

test('the final supported page does not advertise another page', async () => {
  const result = await searchApp('测试短剧', { page: 50, cursor: { search_id: 'sid-1' }, request: async signed => {
    assert.equal(new URL(signed.url).searchParams.get('offset'), '980');
    return payload;
  } });
  assert.equal(result.page, 50);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextPage, null);
});
