// Offline App catalogue fixtures; no upstream requests, account or device files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nativeDir = path.join(__dirname, '../src/native');
const file = path.join(nativeDir, 'hongguo-app-catalog.js');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const video = (id = '7697209269287914521') => ({ series_id: id, title: '<b>测试</b> &amp; 剧', cover: 'https://img.example/cover.jpg',
  episode_cnt: 100, video_desc: '完整简介', content_type: 1004, sub_title_list: [{ content: '脑洞' }] });
const categoryPayload = (id, next = 37, more = true, contentType = 1) => ({ code: 0, data: { video_data: [{ ...video(id), content_type: contentType }], has_more: more,
  next_offset: next, session_id: 'fixture-session', selector_rows: [
    { type: 'category_dim_theme', items: [{ selector_item_id: 'cate_165', show_name: '悬疑' }, { selector_item_id: 'cate_1219', show_name: '恐怖' }] },
    { type: 'category_dim_role', items: [{ selector_item_id: 'cate_36', show_name: '重生' }] },
  ] } });
const ranks = { 'hot-drama': ['all', 'ranklist_hot_play_sc'], 'hot-real-drama': ['human', 'human_hot_play'],
  'hot-comic-drama': ['comic_series_rank', 'comic_series_hot_play'], 'hot-ai-drama': ['ai_playlet', 'ai_playlet_hot_play'] };
const rankPayload = (category, more = true) => ({ code: 0, data: { has_more: more, next_offset: 29, session_id: 'rank-session',
  cell_view: { cell_data: [{ video_data: { ...video(), content_type: category === 'hot-real-drama' ? 1 : 1004 } }], cell_selector: { outer_row: { items: [{ selector_item_id: ranks[category][0], is_selected: true,
    sub_cell_selector: { outer_row: { items: [{ selector_item_id: ranks[category][1], is_selected: true }] } } }] } } } } });

function fixture(respond = () => categoryPayload()) {
  let now = 1000;
  const calls = [], timers = new Map(); let nextTimer = 0;
  const context = { module: { exports: {} }, Buffer, URL, AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === './app-source') return {
        parseSearchInteger: require(path.join(nativeDir, 'app-source')).parseSearchInteger,
        signedMetadataRequest(apiPath, values, body) { return { url: 'https://api5-normal-sinfonlineb.fqnovel.com' + apiPath,
          headers: {}, body: body == null ? null : Buffer.from(JSON.stringify(body)), values }; },
        requestJson(url, options, deadline, signal) {
          const call = { url, options, deadline, signal, body: options.data ? JSON.parse(options.data.toString()) : null };
          // Capture the business query without generating cryptographic signatures in every fixture.
          call.values = signedValues.shift(); calls.push(call);
          return Promise.resolve(respond(call, calls.length));
        },
      };
      if (name === './hongguo-app-search') return require(path.join(nativeDir, 'hongguo-app-search'));
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  const signedValues = [];
  const originalRequire = context.require;
  context.require = name => {
    const dependency = originalRequire(name);
    if (name === './app-source') {
      const sign = dependency.signedMetadataRequest;
      dependency.signedMetadataRequest = (api, values, body) => { signedValues.push(clone(values)); return sign(api, values, body); };
    }
    return dependency;
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { browse: context.module.exports.browseList, calls, advance(ms) { now += ms; for (const [id, timer] of [...timers]) {
    if (timer.at <= now) { timers.delete(id); timer.fn(); }
  } }, timers };
}

const checks = [
  ['catalog consumer scopes isolate cursor refresh and reject unbounded scope keys', async () => {
    const h = fixture(call => categoryPayload('7000001', call.body.offset + 15));
    await h.browse({ catalogScope: 'browse' });
    await h.browse({ catalogScope: 'browse', page: 2 });
    await h.browse({ forceRefresh: true });
    assert.equal((await h.browse({ catalogScope: 'browse', page: 3 })).success, true,
      'recommendation refresh must preserve Browse cursors');
    const beforeInvalid = h.calls.length;
    for (const catalogScope of ['arbitrary', {}, 123]) {
      assert.equal((await h.browse({ catalogScope })).code, 'APP_INPUT');
    }
    assert.equal(h.calls.length, beforeInvalid, 'unknown scopes must not create sessions or requests');
  }],
  ['catalog covers use only the verified public JPEG object variant', async () => {
    const cases = [
      ['https://p3-reading-sign.fqnovelpic.com/novel-pic/object123~tplv-example:400:0.heic?x-signature=fixture', 'https://p3-novel.byteimg.com/novel-pic/object123~tplv-shrink:640:0.image'],
      ['https://user:password@p3-novel.byteimg.com/novel-pic/object456~original.HEIC?token=fixture#image', 'https://p3-novel.byteimg.com/novel-pic/object456~tplv-shrink:640:0.image'],
      ['https://fqnovelpic.com/novel-pic/object789~original.heic', 'https://p3-novel.byteimg.com/novel-pic/object789~tplv-shrink:640:0.image'],
      ['https://unknown.example/novel-pic/object~original.heic', ''],
      ['https://notfqnovelpic.com/novel-pic/object~original.heic', ''],
      ['https://fqnovelpic.com.evil.example/novel-pic/object~original.heic', ''],
      ['https://p3-novel.byteimg.com/other/object~original.heic', ''],
      ['https://p3-novel.byteimg.com/novel-pic/object.heic', ''],
      ['ftp://p3-novel.byteimg.com/novel-pic/object~original.heic', ''],
      ['https://img.example/ordinary.jpg?signature=fixture', 'https://img.example/ordinary.jpg?signature=fixture'],
    ];
    for (const [cover, expected] of cases) {
      const h = fixture(() => { const p = categoryPayload(); p.data.video_data[0].cover = cover; return p; });
      const result = await h.browse({});
      assert.equal(result.success, true, result.error);
      assert.equal(result.results[0].cover, expected, cover);
    }
  }],
  ['three categories use dynamic theme IDs and retain honest metadata', async () => {
    for (const [category, scene, genre] of [['real-drama', 'default', 'short_play'], ['comic-drama', 'comic_series', 'comic_series'], ['ai-drama', 'ai_series', 'ai_series']]) {
      const h = fixture(() => categoryPayload(undefined, 37, true, category === 'real-drama' ? 1 : 1004));
      const result = await h.browse({ category });
      assert.equal(result.success, true, result.error);
      assert.equal(h.calls[0].body.req_scene, scene);
      assert.deepEqual(h.calls[0].body.select_items.genre, [genre]);
      assert.equal(h.calls[0].body.need_selector_panel, true);
      assert.deepEqual(clone(result.genres), [{ slug: 'cate_165', label: '悬疑' }, { slug: 'cate_1219', label: '恐怖' }]);
      assert.equal(result.results[0].series_id, '7697209269287914521');
      assert.equal(result.results[0].series_title, '测试 & 剧');
      assert.equal(result.results[0].description, '完整简介');
      assert.equal(result.results[0].completion_status, 'unknown');
      assert.equal(result.total, 0); assert.equal(result.totalPages, 0);
      assert.equal('session_id' in result, false); assert.equal('cursor' in result, false);
      await h.browse({ category, genre: 'cate_1219' });
      assert.deepEqual(h.calls[1].body.select_items.category_dim_theme, ['cate_1219']);
      assert.deepEqual(h.calls[1].body.select_items.category_dim_role, []);
    }
  }],
  ['four rankings select their explicit hot-play lists and reject wrong types', async () => {
    for (const category of Object.keys(ranks)) {
      const h = fixture(() => rankPayload(category));
      assert.equal((await h.browse({ category })).success, true);
      assert.equal(h.calls[0].values.selected_items, ranks[category][0]);
      assert.equal(h.calls[0].values.sub_selected_items, ranks[category][1]);
      assert.equal(h.calls[0].values.tab_type, '26');
      assert.match(h.calls[0].url, /bookmall\/cell\/change\/v$/);
    }
    const wrongRank = fixture(() => rankPayload('hot-real-drama'));
    assert.equal((await wrongRank.browse({ category: 'hot-ai-drama' })).success, false);
    for (const cell of [{ ugc_user_data: [{ user_info: { base_info: { actor_id: '1234567' } } }] }, { video_data: { ...video(), content_type: 2 } }]) {
      const h = fixture(() => { const p = rankPayload('hot-drama'); p.data.cell_view.cell_data = [cell]; return p; });
      assert.equal((await h.browse({ category: 'hot-drama' })).success, false);
    }
  }],
  ['content types follow the category and combined ranking retains live-action dramas', async () => {
    const h = fixture(() => {
      const p = rankPayload('hot-drama');
      p.data.cell_view.cell_data = [{ video_data: [{ ...video('7000001'), content_type: 1 }, video('7000002')] }];
      return p;
    });
    const mixed = await h.browse({ category: 'hot-drama' });
    assert.equal(mixed.success, true, mixed.error);
    assert.deepEqual(mixed.results.map(item => item.series_id).join(','), '7000001,7000002');
    for (const [category, type] of [['real-drama', 1004], ['comic-drama', 1], ['ai-drama', 1],
      ['hot-real-drama', 1004], ['hot-comic-drama', 1], ['hot-ai-drama', 1], ['hot-drama', 99], ['hot-drama', undefined]]) {
      const wrong = fixture(() => {
        const p = ranks[category] ? rankPayload(category) : categoryPayload();
        const v = ranks[category] ? p.data.cell_view.cell_data[0].video_data : p.data.video_data[0];
        v.content_type = type; return p;
      });
      assert.equal((await wrong.browse({ category })).success, false, `${category} must reject content type ${type}`);
    }
  }],
  ['pagination uses server cursor and keeps previous pages in memory', async () => {
    const h = fixture((_call, count) => { const p = categoryPayload(String(7000000 + count), count === 1 ? 37 : 83);
      if (count > 1) p.data.selector_rows = []; return p; });
    assert.equal((await h.browse({ page: 2 })).success, false);
    assert.equal(h.calls.length, 0);
    const first = await h.browse({ page: 1 });
    const second = await h.browse({ page: 2 });
    assert.equal(second.success, true, second.error);
    assert.equal(h.calls[1].body.offset, 37); assert.equal(h.calls[1].body.session_id, 'fixture-session');
    assert.equal(h.calls[1].body.need_selector_panel, false);
    assert.equal(second.genres.length, 2, 'only_content must retain previously received themes');
    assert.deepEqual(clone(await h.browse({ page: 1 })), clone(first));
    assert.equal(h.calls.length, 2);
    const rank = fixture((_call, n) => { const p = rankPayload('hot-drama'); p.data.next_offset = n * 29; return p; });
    await rank.browse({ category: 'hot-drama' });
    assert.equal((await rank.browse({ category: 'hot-drama', page: 2 })).success, true);
    assert.equal(rank.calls[1].values.offset, '29'); assert.equal(rank.calls[1].values.tab_type, '18');
    assert.equal(rank.calls[1].values.session_id, 'rank-session');
  }],
  ['refresh before dispatch cancels safely and refreshing an old page discards later cursors', async () => {
    const h = fixture((_call, n) => categoryPayload(String(7000000 + n), n * 37));
    const first = h.browse({}), refresh = h.browse({ forceRefresh: true });
    const [old, current] = await Promise.all([first, refresh]);
    assert.equal(old.success, false); assert.equal(current.success, true); assert.equal(h.calls.length, 1);
    await h.browse({ page: 2 }); await h.browse({ page: 3 });
    await h.browse({ page: 2, forceRefresh: true });
    assert.equal((await h.browse({ page: 4 })).success, false, 'old page-3 cursor cannot survive reloading page 2');
  }],
  ['cache is bounded while the first page remains usable for back navigation', async () => {
    const h = fixture(call => {
      const p = categoryPayload(undefined, call.body.offset + 37);
      if (call.body.select_items.category_dim_theme.length) p.data.selector_rows[0].items.push({ selector_item_id: call.body.select_items.category_dim_theme[0], show_name: '动态主题' });
      return p;
    });
    for (let page = 1; page <= 10; page++) assert.equal((await h.browse({ page })).success, true);
    await h.browse({ page: 1 });
    assert.equal(h.calls.length, 10, 'keeping page 1 avoids silently creating a new server session');
    for (let i = 0; i < 33; i++) await h.browse({ genre: 'cate_' + (2000 + i) });
    assert.equal((await h.browse({ page: 2 })).success, false, 'evicted sessions have no guessed cursor');
  }],
  ['pending work is deduplicated and a first-page refresh invalidates old cursors', async () => {
    const slow = deferred();
    const h = fixture((_call, n) => n === 1 ? slow.promise : categoryPayload('7000009', 61));
    const first = h.browse({}), duplicate = h.browse({});
    await Promise.resolve();
    assert.equal(h.calls.length, 1);
    const refreshed = await h.browse({ forceRefresh: true });
    assert.equal(refreshed.success, true);
    assert.equal(h.calls[0].signal.aborted, true);
    slow.resolve(categoryPayload('7000001', 37));
    await Promise.all([first, duplicate]);
    const cached = await h.browse({});
    assert.equal(cached.results[0].series_id, '7000009');
    await h.browse({ page: 2 });
    assert.equal(h.calls.at(-1).body.offset, 61);
    await h.browse({ forceRefresh: true });
    assert.equal((await h.browse({ page: 3 })).success, false);
  }],
  ['TTL, input and response errors cannot create guessed pages or retry loops', async () => {
    const h = fixture();
    await h.browse({}); h.advance(120001);
    assert.equal((await h.browse({ page: 2 })).success, false);
    await h.browse({}); assert.equal(h.calls.length, 2);
    for (const options of [{ category: 'actor' }, { genre: 'comeback' }, { genre: '../outside' }, { page: 0 }, { page: 51 }, { page: 1.5 }, { category: 'hot-drama', genre: 'cate_165' }]) {
      assert.equal((await h.browse(options)).success, false);
    }
    assert.equal(h.calls.length, 2);
    const comic = await h.browse({ category: 'comic' });
    assert.equal(comic.unsupported, true); assert.equal(h.calls.length, 2);
    for (const payload of [null, {}, { code: 1 }, { code: 0, data: {} }, { code: 0, data: { video_data: [{ ...video(), content_type: 1, series_id: 7697209269287914521 }] } }]) {
      const bad = fixture(() => payload);
      const result = await bad.browse({});
      assert.equal(result.success, false); assert.match(result.error, /官网/); assert.equal(bad.calls.length, 1);
    }
  }],
  ['four-second deadline cancels transport without fallback or a second budget', async () => {
    const h = fixture(() => new Promise(() => {}));
    const pending = h.browse({}); await Promise.resolve();
    assert.equal(h.calls[0].deadline, 5000);
    h.advance(4000);
    const result = await pending;
    assert.equal(result.success, false); assert.match(result.error, /超时.*官网/);
    assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  }],
  ['metadata signing has stable in-process identity and a narrow endpoint allowlist', async () => {
    const app = require(path.join(nativeDir, 'app-source'));
    assert.equal(typeof app.signedMetadataRequest, 'function');
    const category = app.signedMetadataRequest('/reading/distribution/category/landpage/v/', {}, { limit: 15 });
    const rank = app.signedMetadataRequest('/reading/bookapi/bookmall/cell/change/v', { offset: '0' });
    const album = app.signedMetadataRequest('/novel/player/album_detail/v1/', {}, { album_id: '7676321126145854488' });
    const a = new URL(category.url), b = new URL(rank.url);
    assert.equal(a.origin, 'https://api5-normal-sinfonlineb.fqnovel.com');
    for (const key of ['iid', 'device_id']) { assert.match(a.searchParams.get(key), /^\d+$/); assert.equal(a.searchParams.get(key), b.searchParams.get(key)); }
    assert.equal(a.searchParams.get('version_code'), '73532'); assert.equal(a.searchParams.get('version_name'), '7.3.5.32');
    assert.equal(category.headers['Accept-Encoding'], 'identity'); assert.ok(category.headers['x-ss-stub']);
    assert.equal(rank.body, null); assert.ok(rank.headers['x-medusa']); assert.ok(rank.headers['x-gorgon']);
    assert.equal(new URL(album.url).origin, a.origin); assert.ok(album.headers['x-ss-stub']);
    assert.notEqual(new URL(album.url).searchParams.get('device_id'), a.searchParams.get('device_id'),
      'album directory uses a fresh one-shot metadata identity');
    assert.throws(() => app.signedMetadataRequest('/unrelated', {}));
  }],
];
module.exports = { fixture, categoryPayload, rankPayload };
if (require.main === module) (async () => { let failures = 0; for (const [name, check] of checks) {
  try { await check(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
} console.log(`${checks.length - failures}/${checks.length} App catalogue checks passed`); process.exitCode = failures ? 1 : 0; })();
