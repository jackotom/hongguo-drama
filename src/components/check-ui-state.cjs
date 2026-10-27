// Run: node src/components/check-ui-state.cjs. No browser, network or media playback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const episode = (n) => ({ vid: `vid${n}`, vid_index: n, status: 'missing' });
const detail = (id) => ({ series_id: id, series_title: id, total: 2, episodes: [episode(1), episode(2)] });
const ok = data => ({ success: true, data });
const memoryStorage = (entries = {}) => ({ memory: new Map(Object.entries(entries)), getItem(key) { return this.memory.get(key) ?? null; }, setItem(key, value) { this.memory.set(String(key), String(value)); }, removeItem(key) { this.memory.delete(key); } });

const transformed = new Map();
function compile(file) {
  if (transformed.has(file)) return transformed.get(file);
  const ext = path.extname(file);
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: ext === '.mjs' || ext === '.js' ? 'js' : 'jsx', format: 'cjs', jsx: 'transform' }).code;
  transformed.set(file, code);
  return code;
}
async function mount(file, api, props = {}, storage = null) {
  const slots = [], effects = [], cleanups = [], cache = new Map();
  const timers = new Map();
  let timerId = 0;
  let cursor = 0, tree, Component, queued = false;
  const changed = (old, deps) => !old || deps.some((d, i) => !Object.is(d, old[i]));
  const requestRender = () => { queued = true; };
  const scheduleEffect = (fn, deps) => { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    Fragment: 'fragment',
    useState: initial => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => {
        const next = typeof value === 'function' ? value(slots[i]) : value;
        if (Object.is(next, slots[i])) return;
        slots[i] = next;
        requestRender();
      }];
    },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback: (fn, deps) => react.useMemo(() => fn, deps),
    useEffect: scheduleEffect,
    useLayoutEffect: scheduleEffect,
    useId: () => { const i = cursor++; if (!(i in slots)) slots[i] = `r${i}`; return slots[i]; },
    useSyncExternalStore: (subscribe, getSnapshot) => {
      const i = cursor++;
      if (!slots[i]) slots[i] = true;
      if (!cleanups[i]) effects.push(() => { cleanups[i] = subscribe(() => requestRender()); });
      return getSnapshot();
    },
  };
  const localStorage = storage || memoryStorage();
  const fallback = () => Promise.resolve({});
  const window = new EventTarget();
  const document = { documentElement: { dataset: {} }, hidden: false, fullscreenElement: null, activeElement: null, body: {}, exitFullscreen: async () => {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) };
  Object.assign(window, {
    document, localStorage, navigator: { platform: 'Linux', userAgent: 'test' },
    electronAPI: new Proxy(api, { get: (obj, key) => (key in obj ? obj[key] : key === 'getMediaSources' ? undefined : typeof key === 'string' && key.startsWith('on') ? () => () => {} : fallback) }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'http://localhost/' },
  });
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const shared = { window, document, localStorage, navigator: window.navigator, console, crypto: require('node:crypto').webcrypto, Event, CustomEvent, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, queueMicrotask, structuredClone, ResizeObserver, setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval() {}, requestAnimationFrame: fn => { const id = ++timerId; timers.set(id, { fn, delay: 16 }); return id; }, cancelAnimationFrame: id => timers.delete(id) };
  const loadModule = (resolved) => {
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const localRequire = (spec) => {
      if (spec === 'react' || spec === 'react/jsx-runtime' || spec === 'react/jsx-dev-runtime') return react;
      if (spec.endsWith('.css')) return {};
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(resolved), spec);
        const hit = [base, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (!hit) throw new Error(`Cannot resolve ${spec} from ${resolved}`);
        return loadModule(hit);
      }
      return require(spec);
    };
    const sandbox = vm.createContext({ ...shared, module, exports: module.exports, require: localRequire, __dirname: path.dirname(resolved), __filename: resolved });
    vm.runInContext(compile(resolved), sandbox, { filename: resolved });
    return module.exports;
  };
  const Loaded = loadModule(path.resolve(__dirname, `${file}.jsx`)).default;
  Component = (next) => Loaded(file === 'Player' ? { setEpisodesOpen() {}, ...next } : next);
  const render = () => {
    let guard = 0;
    do {
      queued = false;
      cursor = 0;
      tree = Component(props);
      effects.splice(0).forEach((fn) => fn());
      guard += 1;
    } while (queued && guard < 25);
    if (guard > 1) {
      cursor = 0;
      tree = Component(props);
      effects.splice(0).forEach((fn) => fn());
    }
    return tree;
  };
  const nodes = () => { const out = []; const walk = n => { if (!n || typeof n !== 'object') return; out.push(n); n.children?.forEach(walk); }; walk(tree); return out; };
  const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(text).join('') || '';
  const find = predicate => nodes().find(predicate);
  const button = label => find(n => n.type === 'button' && text(n).includes(label));
  const flush = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); render(); } };
  render();
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await Promise.resolve();
    if (!queued) break;
    render();
  }
  const advanceTimers = (ms) => { for (const [id, timer] of [...timers]) if (timer.delay <= ms) { timers.delete(id); timer.fn(); } };
  return { render, flush, find, nodes, button, advanceTimers, dispatchEvent: event => window.dispatchEvent(event), localStorage, setProps: next => { props = { ...props, ...next }; render(); }, text: () => text(tree), unmount: () => cleanups.forEach(fn => fn?.()) };
}

(async () => {
  let failures = 0;
  const test = async (name, fn) => { if (process.argv[2] && !new RegExp(process.argv[2]).test(name)) return; try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.stack}`); } };
  await test('catalog integration page failure keeps actual page and retries without skipping', async () => {
    const { fixture, categoryPayload } = require('../../scripts/check-app-catalog.cjs');
    let failSecond = true;
    const h = fixture(call => {
      if (call.body.offset === 15 && failSecond) { failSecond = false; throw Object.assign(new Error('fixture'), { code: 'ECONNRESET' }); }
      const p = categoryPayload('7000001', call.body.offset + 15);
      p.data.video_data[0].title = `游标${call.body.offset}片单`; return p;
    });
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: h.browse }); await ui.flush();
    ui.button('下一页').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('加载失败'), ui.text().slice(-500));
    assert.ok(ui.text().includes('第 1 页'), 'failed page must not relabel the old cards');
    assert.ok(ui.text().includes('游标0片单'));
    ui.button('下一页').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第 2 页')); assert.ok(ui.text().includes('游标15片单'));
    assert.equal(h.calls.at(-1).body.offset, 15, 'retry must use the failed cursor, not skip to page 3'); ui.unmount();
  });
  await test('catalog integration expired cursor keeps actual page and offers bounded first-page recovery', async () => {
    const { fixture, categoryPayload } = require('../../scripts/check-app-catalog.cjs');
    const h = fixture(call => categoryPayload('7000001', call.body.offset + 15));
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: h.browse }); await ui.flush();
    ui.button('下一页').props.onClick(); await ui.flush(); h.advance(120001);
    ui.button('下一页').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第 2 页')); assert.ok(ui.text().includes('刷新片单'));
    assert.equal(ui.button('下一页').props.disabled, true); assert.equal(ui.button('上一页').props.disabled, true);
    const requests = h.calls.length;
    ui.button('刷新片单').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第 1 页')); assert.ok(!ui.text().includes('加载失败'));
    assert.equal(h.calls.length, requests + 1, 'recovery must fetch only page 1');
    ui.button('下一页').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第 2 页')); ui.unmount();
  });
  await test('catalog integration cancelled or timed-out next page stays retryable and ignores late cards', async () => {
    for (const stop of ['cancel', 'timeout']) {
      const late = deferred(), pages = []; let pending = true;
      const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: request => {
        pages.push(request.page);
        if (request.page === 2 && pending) { pending = false; return late.promise; }
        return Promise.resolve({ success: true, results: [{ series_id: '7000001', series_title: `有效片单${request.page}` }], hasMore: true });
      } }); await ui.flush(); pages.length = 0;
      ui.button('下一页').props.onClick(); await ui.flush();
      if (stop === 'cancel') ui.button('取消加载').props.onClick(); else ui.advanceTimers(25000);
      await ui.flush(); assert.ok(ui.text().includes('第 1 页')); assert.ok(ui.text().includes(stop === 'cancel' ? '已取消' : '加载超时'));
      ui.button('下一页').props.onClick(); await ui.flush();
      assert.deepEqual(pages, [2, 2]); assert.ok(ui.text().includes('第 2 页')); assert.ok(ui.text().includes('有效片单2'));
      late.resolve({ success: true, results: [{ series_id: '7000002', series_title: '过期响应' }], hasMore: true }); await ui.flush();
      assert.ok(!ui.text().includes('过期响应')); ui.unmount();
    }
  });
  await test('catalog integration feed refresh preserves inactive Browse third page', async () => {
    const { fixture, categoryPayload, rankPayload } = require('../../scripts/check-app-catalog.cjs');
    const h = fixture(call => {
      if (call.body) return categoryPayload();
      const offset = Number(call.values.offset || 0), p = rankPayload('hot-drama'); p.data.next_offset = offset + 20;
      p.data.cell_view.cell_data[0].video_data.title = `游标${offset}榜单`; return p;
    });
    const browse = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [{ slug: 'real-drama', label: '真人剧' }, { slug: 'hot-drama', label: '热播总榜' }], browseList: h.browse }); await browse.flush();
    browse.button('热播总榜').props.onClick(); await browse.flush();
    for (let i = 0; i < 2; i++) { browse.button('下一页').props.onClick(); await browse.flush(); }
    browse.setProps({ active: false }); await browse.flush();
    const feed = await mount('DramaFeed', { browseList: h.browse }); await feed.flush();
    await feed.button('刷新片单').props.onClick(); await feed.flush();
    browse.setProps({ active: true }); await browse.flush();
    assert.ok(!browse.text().includes('加载失败'), 'another consumer must not invalidate Browse pagination');
    assert.ok(browse.text().includes('第 3 页')); assert.ok(browse.text().includes('游标40榜单'));
    browse.button('下一页').props.onClick(); await browse.flush();
    assert.ok(browse.text().includes('第 4 页')); assert.ok(browse.text().includes('游标60榜单')); browse.unmount(); feed.unmount();
  });
  await test('catalog integration failed forced refresh blocks stale cursor navigation until retry', async () => {
    const { fixture, categoryPayload } = require('../../scripts/check-app-catalog.cjs');
    let failRefresh = false;
    const h = fixture(call => {
      if (failRefresh) { failRefresh = false; throw Object.assign(new Error('fixture'), { code: 'ECONNRESET' }); }
      return categoryPayload('7000001', call.body.offset + 15);
    });
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: h.browse }); await ui.flush();
    ui.button('下一页').props.onClick(); await ui.flush(); failRefresh = true;
    ui.button('刷新片单').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第 2 页'), 'failed refresh must retain the old cards actual page');
    assert.equal(ui.button('下一页').props.disabled, true, 'the old session was discarded before transport failed');
    assert.equal(ui.button('上一页').props.disabled, true);
    ui.button('刷新片单').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第 1 页')); assert.ok(!ui.button('下一页').props.disabled);
    ui.button('下一页').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('第 2 页')); ui.unmount();
  });
  for (const scenario of ['new-genre', 'expired-back']) await test(`catalog integration first-page failure isolates old pagination: ${scenario}`, async () => {
    const { fixture, categoryPayload } = require('../../scripts/check-app-catalog.cjs');
    const requests = []; let failNext = false;
    const h = fixture(call => {
      if (failNext) { failNext = false; throw Object.assign(new Error('fixture'), { code: 'ECONNRESET' }); }
      const p = categoryPayload('7000001', call.body.offset + 15);
      p.data.video_data[0].title = `${call.body.select_items.category_dim_theme[0] || '全部'}游标${call.body.offset}`; return p;
    });
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: options => {
      requests.push(options); return h.browse(options);
    } }); await ui.flush();
    const oldPage = scenario === 'new-genre' ? 3 : 2;
    for (let i = 1; i < oldPage; i++) { ui.button('下一页').props.onClick(); await ui.flush(); }
    failNext = true;
    if (scenario === 'new-genre') ui.button('悬疑').props.onClick();
    else { h.advance(120001); ui.button('上一页').props.onClick(); }
    await ui.flush();
    assert.equal(requests.at(-1).page, 1); assert.ok(/加载失败|刷新失败/.test(ui.text()), ui.text().slice(-600));
    assert.ok(ui.text().includes(`第 ${oldPage} 页`));
    assert.equal(ui.button('下一页').props.disabled, true, 'failed first page cannot use the retained cards cursor chain');
    assert.equal(ui.button('上一页').props.disabled, true);
    const beforeRetry = requests.length;
    ui.button('下一页').props.onClick(); await ui.flush();
    assert.equal(requests.length, beforeRetry, 'stale pager must not dispatch another query');
    ui.button('重试').props.onClick(); await ui.flush();
    assert.equal(requests.at(-1).page, 1); assert.equal(requests.length, beforeRetry + 1);
    assert.equal(requests.at(-1).genre, scenario === 'new-genre' ? 'cate_165' : '');
    assert.ok(ui.text().includes('第 1 页')); assert.ok(!ui.text().includes('加载失败'));
    ui.button('下一页').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('第 2 页')); ui.unmount();
  });
  await test('catalog integration web genre failure blocks old numbered pages and retries the new first page', async () => {
    const requests = []; let failNext = false;
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: async request => {
      requests.push(request);
      if (failNext) { failNext = false; return { success: false, error: 'fixture network failure' }; }
      return { success: true, results: [{ series_id: '7000001', series_title: `${request.genre || '全部'}第${request.page}页` }], totalPages: 5, genres: [{ slug: 'suspense', label: '悬疑' }] };
    } }, {}, memoryStorage({ 'hongguo.catalog.channel.v1': 'web' })); await ui.flush();
    const next = () => ui.find(n => n.props['aria-label'] === '下一页');
    for (let i = 0; i < 2; i++) { next().props.onClick(); await ui.flush(); }
    failNext = true; ui.button('悬疑').props.onClick(); await ui.flush();
    assert.equal(next().props.disabled, true, 'old numbered pages belong to the previous genre');
    assert.ok(ui.nodes().filter(n => n.type === 'button' && n.props.className?.startsWith('pager-item')).every(n => n.props.disabled));
    ui.button('重试').props.onClick(); await ui.flush();
    assert.equal(requests.at(-1).genre, 'suspense'); assert.equal(requests.at(-1).page, 1);
    next().props.onClick(); await ui.flush(); assert.equal(requests.at(-1).page, 2); ui.unmount();
  });
  await test('catalog integration feed renders App description', async () => {
    const { fixture, rankPayload } = require('../../scripts/check-app-catalog.cjs');
    const h = fixture(() => rankPayload('hot-drama'));
    const ui = await mount('DramaFeed', { browseList: h.browse }); await ui.flush();
    assert.ok(ui.text().includes('完整简介')); ui.unmount();
  });
  await test('catalog integration hema and xifan keep hasMore pagination without totalPages', async () => {
    for (const source of ['hema', 'xifan']) {
      const calls = [];
      const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: async request => {
        calls.push(request);
        return { success: true, results: [{ series_id: '7000001', series_title: `${request.source}第${request.page}页` }], hasMore: request.page === 1, totalPages: 0 };
      } }); await ui.flush();
      ui.find(n => n.props['aria-label'] === '短剧来源').props.onChange({ target: { value: source } }); await ui.flush();
      ui.button('下一页').props.onClick(); await ui.flush();
      assert.equal(calls.at(-1).page, 2); assert.equal(calls.at(-1).source, source);
      assert.ok(ui.text().includes('第 2 页')); assert.equal(ui.button('下一页').props.disabled, true);
      ui.button('上一页').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('第 1 页')); ui.unmount();
    }
  });
  await test('feed source switching recovers from failure and cancels stale lists and playback', async () => {
    const custom = 'custom:550e8400-e29b-41d4-a716-446655440000';
    const registry = deferred(), lateList = deferred(), latePlay = deferred(), requests = [], resolved = [], played = [];
    let delayHongguo = false;
    const ui = await mount('DramaFeed', {
      getMediaSources: () => registry.promise,
      browseList: request => {
        requests.push(request);
        if (request.source === 'hongguo') return delayHongguo
          ? lateList.promise : Promise.resolve({ success: false, error: '红果连接失败' });
        return Promise.resolve({ success: true, results: [
          { series_id: request.source === 'xifan' ? 'xifan:drama:7' : `${custom}:8`, series_title: request.source === 'xifan' ? '西饭真实短剧' : '自定义真实短剧', rank: 1 },
          { series_id: '123456', series_title: '混入的红果剧集' },
        ] });
      },
      searchResolve: id => {
        resolved.push(id);
        if (id === 'xifan:drama:7') return latePlay.promise;
        const data = detail(id); data.episodes[0].locked = true;
        return Promise.resolve(ok(data));
      },
      playSeries: async request => { played.push(request); return { success: true }; },
    });
    await ui.flush();
    assert.equal(ui.button('取消加载'), undefined, 'source registry loading must not expose an ineffective list cancellation');
    registry.resolve({ success: true, sources: [
      { id: 'hongguo', label: '红果短剧' }, { id: 'xifan', label: '西饭短剧' },
      { id: 'hema', label: '河马短剧', enabled: false }, { id: custom, label: '测试片库' },
    ] });
    await ui.flush();
    assert.ok(ui.text().includes('红果连接失败'));
    const source = () => ui.find(n => n.props['aria-label'] === '推荐来源');
    assert.ok(source(), 'failed feed must still expose source switching');
    assert.equal(ui.find(n => n.type === 'option' && n.props.value === 'hema'), undefined, 'disabled sources stay hidden');
    delayHongguo = true;
    ui.button('重新加载').props.onClick(); await ui.flush();
    source().props.onChange({ target: { value: 'xifan' } }); await ui.flush();
    assert.ok(ui.text().includes('西饭真实短剧'));
    assert.ok(ui.text().includes('西饭短剧'));
    assert.ok(!ui.text().includes('榜单第 1 名'), 'directory order must not be presented as rankings');
    assert.ok(!ui.text().includes('混入的红果剧集'));
    assert.equal(requests.at(-1).source, 'xifan'); assert.equal(requests.at(-1).category, 'real-drama');
    lateList.resolve({ success: true, results: [{ series_id: '654321', series_title: '过期的红果榜单', rank: 2 }] }); await ui.flush();
    assert.ok(!ui.text().includes('过期的红果榜单'));
    ui.button('在剧库播放').props.onClick(); await ui.flush();
    source().props.onChange({ target: { value: custom } }); await ui.flush();
    latePlay.resolve(ok(detail('xifan:drama:7'))); await ui.flush();
    assert.equal(played.length, 0, 'switching sources must prevent a pending resolve opening the old player');
    assert.ok(ui.text().includes('自定义真实短剧'));
    assert.equal(ui.button('在剧库播放').props.disabled, false, 'switching source resets playback loading');
    assert.equal(requests.at(-1).source, custom);
    await ui.button('在剧库播放').props.onClick(); await ui.flush();
    assert.equal(resolved.at(-1), `${custom}:8`, 'the new source ID must reach episode resolution');
    assert.equal(played.length, 1);
    assert.equal(played[0].seriesId, `${custom}:8`);
    assert.equal(played[0].vidIndex, 2, 'the new source must open its first unlocked episode');
    assert.equal(ui.button('在剧库播放').props.disabled, false);
    assert.equal(ui.find(n => n.props.role === 'alert'), undefined, 'successful playback must not leave an error');
    source().props.onChange({ target: { value: 'hongguo' } }); await ui.flush();
    assert.ok(ui.text().includes('榜单第 2 名'), 'returning to Hongguo preserves real ranking metadata');
    ui.button('漫剧').props.onClick(); await ui.flush();
    assert.equal(requests.at(-1).category, 'hot-comic-drama');
    ui.button('摇一摇').props.onClick(); await ui.flush();
    assert.ok(ui.find(n => n.type?.name === 'RandomDrama'), 'random discovery remains available');
    ui.unmount();
  });
  await test('feed channel defaults to App and remembers its own route without changing discovery', async () => {
    const calls = [], storage = memoryStorage({ 'hongguo.catalog.channel.v1': 'web' });
    const api = { browseList: async request => {
      calls.push(request);
      return { success: true, results: [{ series_id: request.source === 'xifan' ? 'xifan:drama:7' : '7000001', series_title: '测试片单' }] };
    } };
    const ui = await mount('DramaFeed', api, {}, storage); await ui.flush();
    const route = () => ui.find(n => n.props['aria-label'] === '推荐目录线路');
    assert.ok(route(), 'Hongguo feed must expose a route selector'); assert.equal(route().props.value, 'app');
    assert.ok(calls.every(request => request.catalogChannel === 'app'));
    assert.ok(ui.text().includes('红果 App 热播榜')); assert.ok(!ui.text().includes('榜单来自红果公开页面'));
    route().props.onChange({ target: { value: 'web' } }); await ui.flush();
    assert.equal(calls.at(-1).catalogChannel, 'web'); assert.ok(ui.text().includes('红果官网热播榜'));
    assert.equal(storage.getItem('hongguo.feed.catalog.channel.v1'), 'web');
    assert.equal(storage.getItem('hongguo.catalog.channel.v1'), 'web');
    ui.button('真人短剧').props.onClick(); await ui.flush(); assert.equal(calls.at(-1).catalogChannel, 'web');
    ui.find(n => n.props['aria-label'] === '推荐来源').props.onChange({ target: { value: 'xifan' } }); await ui.flush();
    assert.equal(route(), undefined); assert.equal(calls.at(-1).catalogChannel, undefined);
    ui.find(n => n.props['aria-label'] === '推荐来源').props.onChange({ target: { value: 'hongguo' } }); await ui.flush();
    assert.equal(route().props.value, 'web');
    ui.button('摇一摇').props.onClick(); await ui.flush(); assert.equal(route(), undefined); ui.unmount();
    calls.length = 0;
    const next = await mount('DramaFeed', api, {}, storage); await next.flush();
    assert.equal(next.find(n => n.props['aria-label'] === '推荐目录线路').props.value, 'web');
    assert.ok(calls.length && calls.every(request => request.catalogChannel === 'web'));
    next.find(n => n.props['aria-label'] === '推荐目录线路').props.onChange({ target: { value: 'app' } }); await next.flush();
    assert.equal(storage.getItem('hongguo.catalog.channel.v1'), 'web', 'feed preference must not change discovery preference'); next.unmount();
  });
  await test('feed channel stays switchable after App timeout without automatic fallback', async () => {
    const calls = [];
    const ui = await mount('DramaFeed', { browseList: async request => {
      calls.push(request);
      return request.catalogChannel === 'web' ? { success: true, results: [{ series_id: '7000001', series_title: '官网可用片单' }] }
        : { success: false, error: 'App 目录加载超时，可重试或切换官网', code: 'APP_TIMEOUT' };
    } }); await ui.flush();
    assert.ok(ui.text().includes('App 目录加载超时'));
    const route = ui.find(n => n.props['aria-label'] === '推荐目录线路'); assert.ok(route); assert.ok(!route.props.disabled);
    assert.ok(calls.every(request => request.catalogChannel === 'app'), 'failure must not silently fetch the website');
    const before = calls.length; route.props.onChange({ target: { value: 'web' } }); await ui.flush();
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).catalogChannel, 'web');
    assert.ok(ui.text().includes('官网可用片单')); assert.ok(!ui.text().includes('App 目录加载超时')); ui.unmount();
  });
  await test('feed channel isolates cached playlists and cancels stale list and playback callbacks', async () => {
    const list = (id, title) => ({ success: true, results: [{ series_id: id, series_title: title }] });
    const webFirst = deferred(), appRefresh = deferred(), webRefresh = deferred(), oldPlay = deferred(), played = [];
    const responses = { app: Promise.resolve(list('7000001', 'App缓存片单')), web: webFirst.promise };
    const ui = await mount('DramaFeed', {
      browseList: request => responses[request.catalogChannel], searchResolve: () => oldPlay.promise,
      playSeries: async request => { played.push(request); return { success: true }; },
    }); await ui.flush();
    const route = () => ui.find(n => n.props['aria-label'] === '推荐目录线路'); assert.ok(route());
    assert.ok(ui.text().includes('App缓存片单'));
    route().props.onChange({ target: { value: 'web' } }); await ui.flush();
    assert.ok(!ui.text().includes('App缓存片单'), 'a route without cache must clear the previous route immediately');
    webFirst.resolve(list('7000002', '官网缓存片单')); await ui.flush(); assert.ok(ui.text().includes('官网缓存片单'));
    responses.app = appRefresh.promise; route().props.onChange({ target: { value: 'app' } }); await ui.flush();
    assert.ok(ui.text().includes('App缓存片单')); assert.ok(!ui.text().includes('官网缓存片单'));
    const opening = ui.button('在剧库播放').props.onClick(); await ui.flush();
    responses.web = webRefresh.promise; route().props.onChange({ target: { value: 'web' } }); await ui.flush();
    assert.ok(ui.text().includes('官网缓存片单')); assert.ok(!ui.text().includes('App缓存片单'));
    appRefresh.resolve(list('7000003', '过期App结果')); oldPlay.resolve(ok(detail('7000001'))); await opening; await ui.flush();
    assert.equal(played.length, 0); assert.ok(!ui.text().includes('过期App结果'));
    webRefresh.resolve({ success: false, error: '官网本次失败' }); await ui.flush();
    assert.ok(ui.text().includes('官网缓存片单')); assert.ok(ui.text().includes('官网本次失败'));
    responses.app = Promise.resolve({ success: false, error: 'App本次失败' });
    route().props.onChange({ target: { value: 'app' } }); await ui.flush();
    assert.ok(ui.text().includes('App缓存片单')); assert.ok(!ui.text().includes('过期App结果'));
    assert.ok(!ui.text().includes('官网缓存片单')); assert.ok(!ui.text().includes('官网本次失败')); ui.unmount();
  });
  await test('feed channel repeated App refresh reuses the existing in-flight transport', async () => {
    const { fixture, rankPayload } = require('../../scripts/check-app-catalog.cjs');
    const pending = deferred();
    const h = fixture((_call, count) => count === 1 ? rankPayload('hot-drama') : pending.promise);
    const ui = await mount('DramaFeed', { browseList: h.browse }); await ui.flush();
    assert.equal(h.calls.length, 1);
    ui.button('刷新片单').props.onClick(); await ui.flush();
    ui.button('刷新片单').props.onClick(); await ui.flush();
    assert.equal(h.calls.length, 2, 'two overlapping refresh clicks must issue only one new transport request');
    pending.resolve(rankPayload('hot-drama')); await ui.flush();
    assert.ok(ui.text().includes('测试 & 剧')); assert.ok(!ui.text().includes('正在更新片单')); ui.unmount();
  });
  await test('feed keeps the current playlist during background refresh and after failures', async () => {
    const gates = new Map();
    const requests = [];
    const lists = {
      'hot-drama': [
        { series_id: '1000001', series_title: '热播旧片单', rank: 1 },
        { series_id: '1000002', series_title: '热播第二部', rank: 2 },
      ],
      'hot-real-drama': [{ series_id: '2000001', series_title: '真人新片单', rank: 1 }],
    };
    const ui = await mount('DramaFeed', {
      getMediaSources: async () => ({ success: true, sources: [{ id: 'hongguo', label: '红果短剧' }] }),
      browseList: request => {
        requests.push(request);
        const gate = gates.get(request.category);
        return gate ? gate.promise : Promise.resolve({ success: true, results: lists[request.category] || [] });
      },
    });
    await ui.flush();
    assert.ok(ui.text().includes('热播旧片单'), 'first load must render the ranking');
    ui.button('下一部').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第 2 / 2 部'));

    const failed = deferred(); gates.set('hot-drama', failed);
    ui.button('刷新片单').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('热播第二部'), 'manual refresh must keep the current playlist while it loads');
    assert.ok(ui.text().includes('正在更新片单'), 'background refresh needs a visible status');
    assert.equal(requests.at(-1).forceRefresh, true, 'manual refresh must bypass caches');
    failed.resolve({ success: false, error: '目录加载超时，请重试' }); await ui.flush();
    assert.ok(ui.text().includes('热播第二部'), 'failed refresh must keep the old playlist');
    assert.ok(ui.text().includes('目录加载超时'));
    assert.ok(ui.text().includes('第 2 / 2 部'), 'failed refresh must keep the current selection');

    const reordered = deferred(); gates.set('hot-drama', reordered);
    ui.button('刷新片单').props.onClick(); await ui.flush();
    reordered.resolve({ success: true, results: [
      { series_id: '1000002', series_title: '热播第二部', rank: 1 },
      { series_id: '1000001', series_title: '热播旧片单', rank: 2 },
    ] }); await ui.flush();
    assert.ok(ui.text().includes('第 1 / 2 部'), 'successful refresh must keep the selected drama instead of jumping to the first entry');
    assert.ok(ui.find(n => n.type === 'h3')?.children?.includes('热播第二部'), 'selected drama must follow its series id');

    const real = deferred(); gates.set('hot-real-drama', real);
    ui.button('真人短剧').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('正在加载真实片单'), 'a category without cache still shows its first-load state');
    assert.ok(!ui.text().includes('热播第二部'), 'another category must not show the previous list');
    real.resolve({ success: true, results: lists['hot-real-drama'] }); await ui.flush();
    assert.ok(ui.text().includes('真人新片单'));

    const back = deferred(); gates.set('hot-drama', back);
    ui.button('热播总榜').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('热播第二部'), 'returning to a category must paint its cached list first');
    assert.ok(ui.text().includes('正在更新片单'));
    assert.ok(!requests.at(-1).forceRefresh, 'background revalidation must not force a bypass');
    back.resolve({ success: true, results: [] }); await ui.flush();
    assert.ok(ui.text().includes('热播第二部'), 'an empty response must not wipe the last good playlist');
    assert.ok(ui.text().includes('没有返回片单'));

    const cancelled = deferred(); gates.set('hot-drama', cancelled);
    ui.button('刷新片单').props.onClick(); await ui.flush();
    ui.button('取消加载').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('已取消更新'), 'cancelling a background refresh needs feedback');
    assert.ok(ui.text().includes('热播第二部'));
    cancelled.resolve({ success: true, results: [] }); await ui.flush();
    assert.ok(ui.text().includes('热播第二部'), 'a cancelled request must not replace the visible list');
    ui.unmount();
  });
  await test('feed preserves selection made while a cached category revalidates', async () => {
    let pending;
    const results = [
      { series_id: '1000001', series_title: '第一部', rank: 1 },
      { series_id: '1000002', series_title: '第二部', rank: 2 },
    ];
    const ui = await mount('DramaFeed', {
      getMediaSources: async () => ({ success: true, sources: [{ id: 'hongguo', label: '红果' }] }),
      browseList: request => request.category === 'hot-drama' && pending ? pending.promise : Promise.resolve({ success: true, results }),
    });
    try {
      await ui.flush();
      ui.button('真人短剧').props.onClick(); await ui.flush();
      pending = deferred();
      ui.button('热播总榜').props.onClick(); await ui.flush();
      ui.button('下一部').props.onClick(); await ui.flush();
      assert.ok(ui.find(n => n.type === 'h3').children.includes('第二部'));
      pending.resolve({ success: true, results }); await ui.flush();
      assert.ok(ui.find(n => n.type === 'h3').children.includes('第二部'), 'background completion must retain the selection made while browsing cached items');
    } finally { ui.unmount(); }
  });
  await test('feed cancels pending playback when source configuration changes', async () => {
    const pending = deferred(), played = [];
    let slow = true, registryLoads = 0;
    const ui = await mount('DramaFeed', {
      getMediaSources: async () => { registryLoads++; return { success: true, sources: [{ id: 'hongguo', label: '红果' }] }; },
      browseList: async () => ({ success: true, results: [{ series_id: '1000001', series_title: '第一部', rank: 1 }] }),
      searchResolve: id => slow ? pending.promise : Promise.resolve(ok(detail(id))),
      playSeries: async request => { played.push(request); return { success: true }; },
    });
    try {
      await ui.flush();
      const opening = ui.button('在剧库播放').props.onClick(); await ui.flush();
      ui.dispatchEvent(new Event('custom-sources-changed')); await ui.flush();
      assert.equal(registryLoads, 2, 'source event must reach the real registry store');
      pending.resolve(ok(detail('1000001'))); await opening; await ui.flush();
      assert.equal(played.length, 0, 'a resolve from before the source revision must not open the player');
      slow = false;
      assert.equal(ui.button('在剧库播放').props.disabled, false);
      await ui.button('在剧库播放').props.onClick(); await ui.flush();
      assert.equal(played.length, 1, 'playback must work again with the new source revision');
    } finally { ui.unmount(); }
  });
  await test('browse categories: empty refresh preserves cached cards and pagination', async () => {
    let empty = false, realCalls = 0;
    const ui = await mount('Browse', {
      getSeriesList: async () => [],
      browseCategories: async () => [{ slug: 'real-drama', label: '真人剧' }, { slug: 'comic', label: '漫画' }],
      browseList: async request => {
        if (request.category === 'comic') return { success: true, results: [], unsupported: true, emptyMessage: '这里是图文漫画' };
        realCalls++;
        return empty ? { success: true, results: [] } : { success: true,
          results: [{ series_id: '1000001', series_title: '已加载片单' }], total: 48, totalPages: 2,
          genres: [{ slug: 'romance', label: '爱情' }] };
      },
    }, {}, memoryStorage({ 'hongguo.catalog.channel.v1': 'web' }));
    const cards = () => ui.nodes().filter(n => n.props.className === 'browse-card');
    try {
      await ui.flush();
      assert.equal(cards().length, 1);
      empty = true;
      await ui.button('刷新片单').props.onClick(); await ui.flush();
      assert.equal(cards().length, 1, 'empty refresh must not erase the last good discovery list');
      assert.ok(ui.text().includes('仍显示上次片单'));
      assert.equal(ui.find(n => n.props.className === 'browse-error-state'), undefined, 'cached cards must not be pushed below a full empty-state error');
      assert.ok(ui.text().includes('共 48 部'), 'total must remain from the cached list');
      assert.ok(ui.button('爱情'), 'genres must remain from the cached list');
      assert.ok(ui.nodes().some(n => n.type === 'button' && n.children.includes(2)), 'pagination must remain available');
      const callsAfterRefresh = realCalls;
      ui.button('漫画').props.onClick(); await ui.flush();
      assert.equal(cards().length, 0, 'unsupported categories must not borrow another category cache');
      assert.ok(ui.text().includes('这里是图文漫画'));
      ui.button('真人剧').props.onClick(); await ui.flush();
      assert.equal(cards().length, 1, 'returning must restore the retained cache');
      assert.equal(realCalls, callsAfterRefresh, 'empty refresh must not delete a still-fresh cache');
    } finally { ui.unmount(); }
  });
  await test('closing a loading detail ignores its late result', async () => {
    const pending = deferred();
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: async () => ({ success: true, results: [{ series_id: 'A', series_title: 'A' }] }), searchResolve: () => pending.promise, getSeriesEpisodes: async () => ok(detail('A')) });
    await ui.flush(); ui.find(n => n.props.className === 'browse-card').props.onClick(); ui.render();
    const close = ui.find(n => n.type === 'button' && n.props.title === '关闭');
    assert.equal(!!close.props.disabled, false, 'loading drawer must remain cancellable');
    close.props.onClick(); pending.resolve(ok(detail('A'))); await ui.flush();
    assert.equal(ui.find(n => n.props.role === 'dialog'), undefined, 'closed drawer reopened');
    ui.unmount();
  });
  await test('browse play starts an undownloaded episode', async () => {
    let payload;
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: async () => ({ success: true, results: [{ series_id: 'A', series_title: 'A' }] }), searchResolve: async () => ok(detail('A')), getSeriesEpisodes: async () => ok(detail('A')), playSeries: async p => { payload = p; return { success: true }; } });
    await ui.flush(); ui.find(n => n.props.className === 'browse-card').props.onClick(); await ui.flush();
    await ui.button('立即播放').props.onClick(); assert.equal(payload?.vidIndex, 1); ui.unmount();
  });
  await test('late old online prepare cannot replace latest episode, and unmount releases it', async () => {
    const first = deferred(), second = deferred(), released = [], requested = [];
    const ui = await mount('Player', { getSeriesList: async () => [{ series_id: 'A' }], getSeriesEpisodes: async () => ok(detail('A')), getPlaybackPosition: async () => null, prepareOnlinePlay: p => { requested.push(p); return requested.length === 1 ? first.promise : second.promise; }, releaseOnlinePlay: async p => released.push(p) });
    await ui.flush(); const firstButton = ui.find(n => n.props['aria-label'] === '第 1 集'); assert.ok(firstButton, ui.text()); firstButton.props.onClick(); ui.render();
    ui.find(n => n.props['aria-label'] === '第 2 集').props.onClick(); ui.render();
    second.resolve({ success: true, url: 'hongguo-stream://new', streamId: 'new' }); await ui.flush();
    first.resolve({ success: true, url: 'hongguo-stream://old', streamId: 'old' }); await ui.flush();
    assert.equal(ui.find(n => n.type === 'video')?.props.src, 'hongguo-stream://new');
    assert.ok(requested.every(p => p.requestId), 'each prepare must be cancellable');
    const prepared = requested.length;
    ui.find(n => n.type === 'video').props.onError({ currentTarget: { error: { code: 2 } } });
    ui.render();
    assert.ok(requested.length > prepared || ui.button('重试') || ui.button('在线播放'), 'network error must retry or offer another attempt');
    assert.ok(!ui.text().includes('当前片源无法正常解码'), 'network error must not claim decoder failure');
    ui.unmount(); assert.ok(released.some(p => p.streamId === 'old')); assert.ok(released.some(p => p.streamId === 'new'));
  });
  await test('browse navigation prepares the requested missing episode without waiting for a download', async () => {
    const requested = [];
    const ui = await mount('Player', { getSeriesList: async () => [{ series_id: 'A' }], getSeriesEpisodes: async () => ok(detail('A')), getPlaybackPosition: async () => null, prepareOnlinePlay: async p => { requested.push(p); return { success: true, url: 'hongguo-stream://target' }; } }, { target: { seriesId: 'A', vidIndex: 2, ts: 123 } });
    await ui.flush(); assert.equal(requested.length, 1); assert.equal(requested[0].vidIndex, 2); ui.unmount();
  });
  await test('download latest parse wins over a late earlier parse', async () => {
    const first = deferred(), second = deferred(); let count = 0;
    const ui = await mount('HongguoDownload', { hongguoResolve: () => ++count === 1 ? first.promise : second.promise });
    ui.button('粘贴链接').props.onClick(); ui.render();
    const input = () => ui.find(n => n.props['aria-label'] === '短剧分享链接或剧集 ID');
    input().props.onChange({ target: { value: 'A' } }); ui.render(); input().props.onKeyDown({ key: 'Enter' }); ui.render();
    input().props.onChange({ target: { value: 'B' } }); ui.render(); input().props.onKeyDown({ key: 'Enter' });
    second.resolve(ok(detail('B'))); await ui.flush(); first.resolve(ok(detail('A'))); await ui.flush();
    assert.ok(ui.text().includes('《B》')); assert.ok(!ui.text().includes('《A》')); ui.unmount();
  });
  await test('download play opens the selected series in the library without downloading', async () => {
    for (const id of ['123', 'xifan:test:123', 'hema:123']) {
      let navigate, downloaded = false, played;
      const app = await mount('../App', { getAppInfo: async () => ({}), onNavigate: fn => { navigate = fn; return () => {}; } });
      const ui = await mount('HongguoDownload', { playSeries: async p => { played = p; navigate({ page: 'player', payload: p }); return { success: true }; }, hongguoDownloadBatch: async () => { downloaded = true; } });
      const data = detail(id); data.episodes[0].locked = true;
      ui.find(n => n.props.onSelectSeries).props.onSelectSeries(data); ui.render();
      const button = ui.button('立即播放'); assert.ok(button, 'selected-series header must expose play');
      await button.props.onClick(); await ui.flush(); app.render();
      assert.equal(played.seriesId, id); assert.equal(played.vidIndex, 2); assert.equal(downloaded, false);
      const player = app.find(n => n.props.target?.seriesId === id); assert.ok(player); assert.equal(player.props.active, true); assert.equal(player.props.target.vidIndex, 2);
      ui.unmount(); app.unmount();
    }
  });
  await test('download play disables fully locked series', async () => {
    let called = false; const data = detail('hema:123'); data.episodes.forEach(ep => { ep.locked = true; });
    const ui = await mount('HongguoDownload', { playSeries: async () => { called = true; } });
    ui.find(n => n.props.onSelectSeries).props.onSelectSeries(data); ui.render();
    const button = ui.button('立即播放'); assert.ok(button); assert.equal(button.props.disabled, true);
    await button.props.onClick(); assert.equal(called, false); ui.unmount();
  });
  await test('download play prevents duplicate requests and exposes failures', async () => {
    const pending = deferred(); let calls = 0;
    const ui = await mount('HongguoDownload', { playSeries: () => { calls++; return pending.promise; } });
    ui.find(n => n.props.onSelectSeries).props.onSelectSeries(detail('123')); ui.render();
    const button = ui.button('立即播放'); assert.ok(button); button.props.onClick(); button.props.onClick(); ui.render();
    assert.equal(calls, 1); assert.ok(ui.find(n => n.type === 'button' && n.props.disabled && n.children.some(c => c?.children?.includes('正在打开…'))));
    pending.resolve({ success: false, error: '打开失败示例' }); await ui.flush();
    assert.ok(ui.text().includes('打开失败示例')); assert.equal(ui.button('立即播放').props.disabled, false); ui.unmount();
  });
  await test('download ignores search selection after leaving its search panel', async () => {
    const ui = await mount('HongguoDownload', { hongguoResolve: async () => ok(detail('B')) });
    const oldSearchResult = ui.find(n => n.props.onSelectSeries).props.onSelectSeries;
    ui.button('粘贴链接').props.onClick(); ui.render();
    ui.find(n => n.props['aria-label'] === '短剧分享链接或剧集 ID').props.onChange({ target: { value: 'B' } }); ui.render();
    ui.button('获取剧集').props.onClick(); await ui.flush(); oldSearchResult(detail('A')); ui.render();
    assert.ok(ui.text().includes('《B》')); assert.ok(!ui.text().includes('《A》')); ui.unmount();
  });
  await test('download includes App fallback episodes by default and bounds enormous ranges', async () => {
    const data = detail('A'); data.web_accessible_episodes = 1; data.episodes[0].web_available = true; data.episodes[1].web_available = false;
    const ui = await mount('HongguoDownload', {});
    ui.find(n => n.props.onSelectSeries).props.onSelectSeries(data); ui.render();
    assert.ok(ui.button('下载选中集数 (2/2)'), 'web-unavailable episodes remain selected for the App fallback');
    assert.ok(ui.text().includes('网页源提供前 1 集，后续集数自动尝试 App 片源'));
    ui.find(n => n.props['aria-label'] === '选择集数范围').props.onChange({ target: { value: '1-999999999' } }); ui.render();
    vm.runInNewContext('apply()', { apply: ui.button('应用').props.onClick }, { timeout: 100 }); ui.render();
    assert.ok(ui.button('下载选中集数 (2/2)'), 'manual selection must keep the API fallback available'); ui.unmount();
  });
  await test('reselecting active search tab preserves pending search selection', async () => {
    const ui = await mount('HongguoDownload', {});
    const searchResult = ui.find(n => n.props.onSelectSeries).props.onSelectSeries;
    ui.button('搜索剧集').props.onClick();
    // React does not rerender when setTab receives the same value.
    searchResult(detail('A')); ui.render();
    assert.ok(ui.text().includes('《A》')); ui.unmount();
  });
  await test('browse categories: comic then real returns cached cards and ignores late comic', async () => {
    const pendingComic = deferred(); let realCalls = 0;
    const list = title => ({ success: true, results: [{ series_id: title, series_title: title }], totalPages: 1 });
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [{ slug: 'real-drama', label: '真人剧' }, { slug: 'comic', label: '漫画' }], browseList: async p => p.category === 'comic' ? pendingComic.promise : p.category === 'comic-drama' ? list('动态漫剧') : (realCalls++, list('真人缓存')) }, {}, memoryStorage({ 'hongguo.catalog.channel.v1': 'web' }));
    await ui.flush(); const callsBeforeSwitch = realCalls;
    ui.button('漫画').props.onClick(); await ui.flush();
    ui.button('真人剧').props.onClick();
    pendingComic.resolve({ success: true, results: [], unsupported: true, emptyMessage: '这里是图文漫画，暂不支持视频下载；看动态漫画请切换“漫剧”。' }); await Promise.resolve(); await Promise.resolve(); await ui.flush();
    assert.equal(realCalls, callsBeforeSwitch, 'switching back must reuse the website cache without another request');
    assert.ok(ui.text().includes('真人缓存')); assert.ok(!ui.text().includes('这里是图文漫画'));
    ui.button('漫画').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('这里是图文漫画，暂不支持视频下载'));
    assert.ok(!ui.text().includes('暂时没能加载剧集'));
    ui.button('查看漫剧').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('动态漫剧')); ui.unmount();
  });
  await test('browse categories: timeout ends skeleton and retry rejects the old response', async () => {
    const pending = deferred(); let calls = 0; let hang = true;
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: () => { calls++; return hang ? pending.promise : Promise.resolve({ success: true, results: [{ series_id: 'retry', series_title: '重试成功' }] }); } });
    await ui.flush(); ui.advanceTimers(30000); await ui.flush();
    assert.ok(ui.text().includes('超时'), 'hanging IPC must become a visible timeout');
    assert.equal(ui.find(n => n.props.className === 'browse-loading-state'), undefined);
    hang = false;
    ui.button('重新加载').props.onClick(); await ui.flush();
    pending.resolve({ success: true, results: [{ series_id: 'old', series_title: '旧片单' }] }); await ui.flush();
    assert.ok(ui.text().includes('重试成功')); assert.ok(!ui.text().includes('旧片单')); ui.unmount();
  });
  await test('browse keeps the current cards while a genre refresh is pending', async () => {
    const pending = deferred();
    const ui = await mount('Browse', {
      getSeriesList: async () => [], browseCategories: async () => [],
      browseList: ({ genre }) => genre
        ? pending.promise
        : Promise.resolve({ success: true, results: [{ series_id: 'all', series_title: '全部片单' }], genres: [{ slug: 'romance', label: '爱情' }], total: 1, totalPages: 1 }),
    });
    await ui.flush();
    assert.ok(ui.text().includes('全部片单'));
    ui.button('爱情').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('全部片单'), 'old cards must stay while the genre request is pending');
    assert.ok(ui.text().includes('正在更新片单'));
    assert.equal(ui.find(n => n.props.className === 'browse-loading-state'), undefined);
    pending.resolve({ success: true, results: [{ series_id: 'romance', series_title: '爱情片单' }], total: 1, totalPages: 1 });
    await ui.flush();
    assert.ok(ui.text().includes('爱情片单'));
    ui.unmount();
  });
  await test('browse shows the last persisted page immediately on the next launch', async () => {
    const first = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: async () => ({ success: true, results: [{ series_id: 'cached', series_title: '上次片单' }], total: 1, totalPages: 1, sourceUrl: 'https://hongguoduanju.com/category/real-drama' }) }, {}, memoryStorage({ 'hongguo.catalog.channel.v1': 'web' }));
    await first.flush();
    assert.ok(first.text().includes('上次片单'));
    first.unmount();
    const pending = deferred();
    const second = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: () => pending.promise }, {}, first.localStorage);
    await second.flush();
    assert.ok(second.text().includes('上次片单'), 'persisted catalog must render before the network finishes');
    second.button('刷新片单').props.onClick(); await second.flush();
    assert.ok(second.text().includes('正在更新片单'), 'a forced refresh must keep cached cards visible');
    pending.resolve({ success: true, results: [{ series_id: 'fresh', series_title: '新片单' }], total: 1, totalPages: 1 });
    await second.flush();
    assert.ok(second.text().includes('新片单'));
    second.unmount();
  });
  await test('browse only requests a genre after it is selected', async () => {
    const calls = [];
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: async request => {
      calls.push(request);
      return { success: true, results: [{ series_id: request.genre || 'all', series_title: '片单' }], genres: [{ slug: 'romance', label: '爱情' }, { slug: 'city', label: '都市' }] };
    } });
    await ui.flush();
    const initial = calls.length;
    for (const label of ['爱情', '都市']) {
      ui.button(label).props.onMouseEnter?.();
      ui.button(label).props.onFocus?.();
    }
    await ui.flush();
    assert.equal(calls.length, initial, 'hover and focus must not start background catalog requests');
    ui.button('爱情').props.onClick(); await ui.flush();
    assert.equal(calls.length, initial + 1, 'selecting a genre must request it once');
    assert.equal(calls.at(-1).genre, 'romance');
    ui.unmount();
  });
  await test('browse App route defaults to dynamic genres and cursor paging with a first-page preview', async () => {
    const calls = [];
    const ui = await mount('Browse', {
      getSeriesList: async () => [],
      browseCategories: async () => [{ slug: 'real-drama', label: '真人剧' }, ...['hot-drama', 'hot-real-drama', 'hot-comic-drama', 'hot-ai-drama'].map(slug => ({ slug, label: slug }))],
      browseList: async request => {
        calls.push(request);
        return { success: true, results: [{ series_id: String(request.page), series_title: 'App片单' + request.page }], total: 0, totalPages: 0, hasMore: request.page < 3, genres: [{ slug: 'cate_42', label: '都市' }] };
      },
    });
    await ui.flush();
    assert.ok(calls.every(call => call.catalogChannel === 'app'), 'the initial Hongguo catalog must use the App route');
    assert.equal(ui.find(n => n.props['aria-label'] === '红果目录线路').props.value, 'app');
    assert.equal(ui.nodes().filter(n => n.props.className?.startsWith('browse-cat ') && n.children[0]?.startsWith?.('hot-')).length, 4);
    assert.ok(!ui.text().includes('共 800 部'));
    const persisted = JSON.parse(ui.localStorage.getItem('hongguo.catalog.page.v1') || '[]');
    assert.ok(persisted.some(entry => entry.key.includes('"app"') && entry.key.includes('real-drama')), 'App first page may be persisted as a stale preview');
    assert.ok(!persisted.some(entry => entry.key.includes('"app"') && entry.key.includes(',2]')), 'App page 2 must not be persisted');
    ui.button('都市').props.onClick(); await ui.flush();
    assert.equal(calls.at(-1).genre, 'cate_42');
    ui.button('下一页').props.onClick(); await ui.flush();
    assert.equal(calls.at(-1).page, 2);
    ui.button('上一页').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第 1 页'));
    ui.button('下一页').props.onClick(); await ui.flush();
    const beforeRefresh = calls.length;
    await ui.button('刷新片单').props.onClick(); await ui.flush();
    assert.equal(calls.length, beforeRefresh + 1, 'refresh must request exactly one new first page');
    assert.equal(calls.at(-1).page, 1);
    assert.equal(calls.at(-1).forceRefresh, true);
    assert.ok(ui.text().includes('第 1 页'));
    ui.button('下一页').props.onClick(); await ui.flush();
    assert.equal(calls.length, beforeRefresh + 2, 'a new App session must not reuse old later-page cards');
    ui.button('hot-comic-drama').props.onClick(); await ui.flush();
    assert.equal(calls.at(-1).category, 'hot-comic-drama');
    assert.equal(calls.at(-1).genre, '');
    assert.equal(calls.at(-1).page, 1);
    ui.find(n => n.props['aria-label'] === '短剧来源').props.onChange({ target: { value: 'xifan' } }); await ui.flush();
    assert.equal(ui.find(n => n.props['aria-label'] === '红果目录线路'), undefined);
    assert.equal(calls.at(-1).catalogChannel, undefined, 'other providers must not receive the Hongguo route');
    ui.unmount();
  });
  await test('browse catalog route switching isolates late replies and remembers the web preference', async () => {
    const oldApp = deferred(), calls = [];
    let waiting = true;
    const ui = await mount('Browse', {
      getSeriesList: async () => [], browseCategories: async () => [],
      browseList: request => {
        calls.push(request);
        return request.catalogChannel === 'app' && waiting ? oldApp.promise
          : Promise.resolve({ success: true, results: [{ series_id: request.catalogChannel, series_title: request.catalogChannel === 'web' ? '官网片单' : 'App当前片单' }], genres: [] });
      },
    });
    await ui.flush();
    const route = () => ui.find(n => n.props['aria-label'] === '红果目录线路');
    assert.ok(route(), 'Hongguo needs a manual catalog route selector');
    route().props.onChange({ target: { value: 'web' } }); await ui.flush();
    assert.ok(ui.text().includes('官网片单'));
    waiting = false;
    oldApp.resolve({ success: true, results: [{ series_id: 'old', series_title: '过期App片单' }] }); await ui.flush();
    assert.ok(!ui.text().includes('过期App片单'));
    route().props.onChange({ target: { value: 'app' } }); await ui.flush();
    assert.ok(ui.text().includes('App当前片单'), 'App must not reuse the website page cache');
    const beforeReturn = calls.length;
    route().props.onChange({ target: { value: 'web' } }); await ui.flush();
    assert.ok(ui.text().includes('官网片单'));
    assert.equal(calls.length, beforeReturn, 'returning to web may reuse only its own memory cache');
    assert.equal(ui.localStorage.getItem('hongguo.catalog.channel.v1'), 'web');
    const storage = ui.localStorage;
    ui.unmount();
    const next = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: () => new Promise(() => {}) }, {}, storage);
    await next.flush();
    assert.equal(next.find(n => n.props['aria-label'] === '红果目录线路').props.value, 'web');
    assert.ok(next.text().includes('官网片单'), 'existing web page cache keys must remain readable');
    next.unmount();
  });
  await test('browse App revisiting the second page always asks the backend for its current session', async () => {
    const calls = [];
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: async request => {
      calls.push(request);
      return { success: true, results: [{ series_id: String(request.page), series_title: 'App第' + request.page + '页' }], total: 0, totalPages: 0, hasMore: true, genres: [] };
    } });
    await ui.flush();
    ui.button('下一页').props.onClick(); await ui.flush();
    ui.button('上一页').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第 1 页'));
    const beforeSecondVisit = calls.length;
    ui.button('下一页').props.onClick(); await ui.flush();
    assert.equal(calls.length, beforeSecondVisit + 1, 'App must not reuse a frontend page from an older backend session');
    assert.equal(calls.at(-1).page, 2);
    assert.equal(calls.at(-1).catalogChannel, 'app');
    ui.unmount();
  });
  await test('browse App route failure waits for an explicit switch to web', async () => {
    const calls = [];
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: async request => {
      calls.push(request);
      return request.catalogChannel === 'web' ? { success: true, results: [{ series_id: 'web', series_title: '官网可用片单' }] } : { success: false, error: 'App暂不可用' };
    } });
    await ui.flush();
    assert.ok(ui.text().includes('App暂不可用'));
    assert.ok(calls.every(call => call.catalogChannel === 'app'), 'App failure must not silently mix website results');
    ui.find(n => n.props['aria-label'] === '红果目录线路').props.onChange({ target: { value: 'web' } }); await ui.flush();
    assert.ok(ui.text().includes('官网可用片单'));
    assert.ok(!ui.text().includes('App暂不可用'));
    ui.unmount();
  });
  await test('browse custom sources ignore persisted pages and refresh after configuration changes', async () => {
    const custom = 'custom:550e8400-e29b-41d4-a716-446655440000';
    const key = 'hongguo.catalog.page.v1';
    const legacy = JSON.stringify([{ key: JSON.stringify([custom, 'real-drama', '', 1]), results: [{ series_id: custom + ':1', series_title: '旧站片单' }], meta: { total: 1, totalPages: 1, genres: [] }, savedAt: Date.now() }]);
    const storage = { value: legacy, getItem(k) { return k === key ? this.value : null; }, setItem(k, value) { if (k === key) this.value = value; } };
    let calls = 0;
    const ui = await mount('Browse', {
      getMediaSources: async () => ({ success: true, sources: [{ id: 'hongguo', label: '红果' }, { id: custom, label: '自定义源' }] }),
      getSeriesList: async () => [], browseCategories: async () => [],
      browseList: async request => request.source === custom
        ? { success: true, results: [{ series_id: custom + ':1', series_title: ++calls === 1 ? '当前站片单' : '改址后片单' }] }
        : { success: true, results: [] },
    }, {}, storage);
    await ui.flush();
    ui.find(n => n.props['aria-label'] === '短剧来源').props.onChange({ target: { value: custom } }); await ui.flush();
    assert.ok(ui.text().includes('当前站片单'), 'a custom source must fetch current data instead of trusting old persisted cards');
    assert.ok(!ui.text().includes('旧站片单'));
    assert.equal(storage.value, legacy, 'custom catalog results must not be persisted');
    ui.dispatchEvent(new Event('custom-sources-changed')); await ui.flush();
    assert.ok(ui.text().includes('改址后片单'), 'configuration changes must invalidate the custom source memory cache');
    assert.equal(calls, 2);
    assert.equal(storage.value, legacy);
    ui.unmount();
  });
  await test('browse invalidation without a replacement request still clears the skeleton', async () => {
    const pending = deferred();
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: () => pending.promise });
    await ui.flush();
    assert.ok(ui.find(n => n.props.className === 'browse-loading-state'));
    ui.setProps({ active: false }); ui.render();
    ui.advanceTimers(30000); await ui.flush();
    assert.equal(ui.find(n => n.props.className === 'browse-loading-state'), undefined, 'an invalidated request must not leave an endless skeleton');
    ui.unmount();
  });
  await test('browse categories: cancel is immediate and cached cards survive refresh errors', async () => {
    const pending = deferred(); let calls = 0; let hang = false;
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: () => { calls++; return hang ? pending.promise : Promise.resolve({ success: true, results: [{ series_id: 'saved', series_title: '已加载片单' }] }); } }, {}, memoryStorage({ 'hongguo.catalog.channel.v1': 'web' }));
    await ui.flush(); const refresh = ui.button('刷新片单'); assert.ok(refresh, 'cached results need an explicit refresh'); hang = true; refresh.props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('已加载片单'));
    const cancel = ui.button('取消加载'); assert.ok(cancel, 'loading must remain cancellable'); cancel.props.onClick(); ui.render();
    assert.ok(ui.text().includes('已取消')); assert.ok(ui.text().includes('已加载片单'));
    pending.resolve({ success: false, error: '来源不可用' }); await ui.flush();
    assert.ok(!ui.text().includes('来源不可用'), 'cancelled request must not overwrite cancellation');
    ui.button('重试').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('来源不可用')); assert.ok(ui.text().includes('已加载片单')); ui.unmount();
  });

  await test('xifan browse source switch rejects late lists and opens the current source URL', async () => {
    const old = deferred(), opened = [], pages = []; let calls = 0;
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: p => p.source === 'xifan' ? (pages.push(p.page), Promise.resolve({ success: true, results: [{ series_id: 'X', series_title: '西饭片单' }], genres: [{ slug: '68', label: '都市' }], total: 0, totalPages: 0, hasMore: p.page === 1 })) : ++calls === 1 ? Promise.resolve({ success: true, results: [{ series_id: 'H', series_title: '红果片单' }], sourceUrl: 'https://www.hongguoduanju.com/category/real-drama' }) : old.promise, searchWindowShow: async (...args) => opened.push(args) }, {}, memoryStorage({ 'hongguo.catalog.channel.v1': 'web' }));
    await ui.flush(); await ui.button('打开来源页面').props.onClick();
    assert.equal(opened[0][1], 'https://hongguoduanju.com/category/real-drama');
    ui.button('刷新片单').props.onClick(); ui.render();
    const source = ui.find(n => n.props['aria-label'] === '短剧来源'); assert.ok(source, 'source selector missing');
    source.props.onChange({ target: { value: 'xifan' } }); await ui.flush();
    old.resolve({ success: true, results: [{ series_id: 'late', series_title: '旧红果片单' }] }); await ui.flush();
    assert.ok(ui.text().includes('西饭片单')); assert.ok(!ui.text().includes('旧红果片单'));
    assert.equal(ui.button('打开来源页面'), undefined); assert.ok(ui.button('都市'));
    ui.button('下一页').props.onClick(); await ui.flush(); assert.equal(pages.at(-1), 2); assert.equal(ui.button('下一页').props.disabled, true); assert.ok(ui.text().includes('第 2 页'));
    ui.button('上一页').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('第 1 页')); ui.unmount();
  });
  await test('all-source search merges both sources and resolves the original source ID', async () => {
    const first = deferred(), second = deferred(), calls = [], resolved = [], picked = [];
    const ui = await mount('SearchPanel', { searchSeries: (kw, options) => { calls.push([kw, options.source]); return options.source === 'hongguo' ? first.promise : options.source === 'xifan' ? second.promise : Promise.resolve({ success: true, results: [] }); }, searchResolve: async id => { resolved.push(id); return ok(detail(id)); } }, { onSelectSeries: d => picked.push(d) });
    assert.equal(ui.find(n => n.props['aria-label'] === '短剧来源').props.value, 'all');
    assert.ok(ui.find(n => n.type === 'option' && n.props.value === 'all'));
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '同名剧' } }); ui.render(); ui.button('搜索').props.onClick();
    assert.deepEqual(calls, [['同名剧', 'hongguo'], ['同名剧', 'xifan'], ['同名剧', 'hema']], 'all searches start without waiting for each other');
    second.resolve({ success: true, results: [{ series_id: 'xifan:test:123', series_title: '同名剧' }] });
    first.resolve({ success: true, results: [{ series_id: '123', series_title: '同名剧' }] }); await ui.flush();
    const cards = ui.nodes().filter(n => n.props.className?.startsWith('search-card '));
    assert.equal(cards.length, 2, 'same title across sources must remain separately selectable');
    assert.ok(ui.nodes().some(n => n.props.className === 'badge' && n.children.includes('红果短剧')));
    assert.ok(ui.nodes().some(n => n.props.className === 'badge' && n.children.includes('西饭短剧')));
    cards[1].props.onClick(); await ui.flush(); assert.equal(resolved[0], 'xifan:test:123'); assert.equal(picked[0].series_id, 'xifan:test:123'); ui.unmount();
  });
  await test('season search ranks matching titles and exposes supplemental failures without hiding results', async () => {
    const exact = { series_id: '123', series_title: '双子房客' }, next = { series_id: '124', series_title: '双子房客第三季' };
    const ui = await mount('SearchPanel', { searchSeries: async (_kw, { source }) => source === 'hongguo'
      ? { success: true, results: [{ series_id: '125', series_title: '其他短剧' }, next, exact, exact], partial: true, error: '补充搜索未完成：连接超时' }
      : { success: true, results: [] } });
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '双子房客' } }); ui.render(); ui.button('搜索').props.onClick(); await ui.flush();
    const cards = ui.nodes().filter(n => n.props.className?.startsWith('search-card '));
    assert.deepEqual(cards.map(card => card.props.title), ['点击查看并下载：双子房客', '点击查看并下载：双子房客第三季', '点击查看并下载：其他短剧']);
    assert.ok(ui.text().includes('找到 2 部标题匹配短剧')); assert.ok(ui.text().includes('其他结果（排在后面）'));
    assert.ok(ui.text().includes('补充搜索未完成：连接超时')); assert.ok(ui.find(n => n.props.role === 'status'));
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '新的剧名' } }); ui.render();
    assert.ok(!ui.text().includes('补充搜索未完成')); ui.unmount();
  });
  await test('all-source search keeps successful results when the other source fails', async () => {
    for (const failure of [{ success: false, error: '来源暂不可用' }, new Error('连接超时')]) {
      const ui = await mount('SearchPanel', { searchSeries: async (kw, { source }) => { if (source === 'hongguo') return { success: true, results: [{ series_id: '123', series_title: '仍可查看' }] }; if (failure instanceof Error) throw failure; return failure; } });
      ui.find(n => n.type === 'input').props.onChange({ target: { value: '剧名' } }); ui.render(); ui.button('搜索').props.onClick(); await ui.flush();
      assert.ok(ui.text().includes('仍可查看')); assert.ok(ui.find(n => n.props.role === 'alert'), 'failed source must not be silently omitted');
      assert.ok(ui.text().includes(failure.message || failure.error)); assert.ok(!ui.text().includes('没有找到相关短剧')); ui.unmount();
    }
  });
  await test('all-source search failures are not shown as an empty successful search', async () => {
    const ui = await mount('SearchPanel', { searchSeries: async () => ({ success: false, error: '网络断开' }) });
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '剧名' } }); ui.render(); ui.button('搜索').props.onClick(); await ui.flush();
    assert.ok(ui.find(n => n.props.role === 'alert')); assert.ok(!ui.text().includes('没有找到相关短剧')); ui.unmount();
  });
  await test('load more locks duplicate clicks before a render', async () => {
    const pending = deferred(); let calls = 0;
    const ui = await mount('SearchPanel', {
      searchSeries: async (_kw, { source }) => ({ success: true, results: source === 'hongguo' ? [{ series_id: '1000001', series_title: '首屏' }] : [], channel: 'web', page: 1, hasMore: source === 'hongguo' }),
      searchSeriesMore: () => { calls++; return pending.promise; },
    });
    ui.find(n => n.props['aria-label'] === '搜索短剧名称').props.onChange({ target: { value: '剧名' } }); ui.render();
    await ui.button('搜索').props.onClick(); await ui.flush();
    const click = ui.button('加载更多').props.onClick;
    const first = click(), duplicate = click();
    assert.equal(calls, 1, 'a duplicate click must not issue another request for the same page');
    pending.resolve({ success: true, results: [], page: 2, hasMore: false });
    await Promise.all([first, duplicate]); await ui.flush(); ui.unmount();
  });
  for (const transition of ['keyword', 'source', 'search', 'active']) await test(`load more stale completion preserves the new lock after ${transition}`, async () => {
    const old = deferred(), current = deferred(); let calls = 0;
    const ui = await mount('SearchPanel', {
      searchSeries: async (_kw, { source }) => ({ success: true, results: [{ series_id: `${source}:1`, series_title: '当前首屏' }], channel: 'web', page: 1, hasMore: true }),
      searchSeriesMore: () => { calls++; return calls === 1 ? old.promise : current.promise; },
    });
    const source = () => ui.find(n => n.props['aria-label'] === '短剧来源');
    const input = () => ui.find(n => n.props['aria-label'] === '搜索短剧名称');
    source().props.onChange({ target: { value: 'hongguo' } }); ui.render();
    input().props.onChange({ target: { value: '旧词' } }); ui.render();
    await ui.button('搜索').props.onClick(); await ui.flush();
    const oldTask = ui.button('加载更多').props.onClick(); await ui.flush();
    if (transition === 'keyword') { input().props.onChange({ target: { value: '新词' } }); ui.render(); }
    if (transition === 'source') { source().props.onChange({ target: { value: 'hema' } }); ui.render(); }
    if (transition === 'active') { ui.setProps({ active: false }); ui.setProps({ active: true }); await ui.flush(); }
    else { await ui.button('搜索').props.onClick(); await ui.flush(); }
    const more = ui.button('加载更多');
    assert.ok(more && !more.props.disabled, 'returning to the page must allow a fresh paging request');
    const currentTask = more.props.onClick(); await ui.flush();
    old.resolve({ success: true, results: [{ series_id: '9999999', series_title: '过期第二页' }], channel: 'web', page: 2, hasMore: false });
    await oldTask; await ui.flush();
    assert.ok(ui.button('加载中…')?.props.disabled, 'an obsolete completion cannot unlock the current request');
    assert.ok(!ui.text().includes('过期第二页'), 'cancelled paging must not append its results');
    current.resolve({ success: true, results: [{ series_id: '8888888', series_title: '当前第二页' }], channel: 'web', page: 2, hasMore: false });
    await currentTask; await ui.flush();
    assert.ok(ui.text().includes('当前第二页')); ui.unmount();
  });
  await test('load more deadline keeps completed sources and retries only the unfinished page', async () => {
    const old = deferred(), retry = deferred(), calls = [];
    const ui = await mount('SearchPanel', {
      searchSeries: async (_kw, { source }) => ({ success: true, results: source === 'xifan' ? [] : [{ series_id: `${source}:1`, series_title: `${source}首屏` }], channel: 'web', page: 1, cursor: { page: 1 }, hasMore: source !== 'xifan' }),
      searchSeriesMore: (_kw, options) => {
        calls.push(options);
        if (options.source === 'hongguo') return Promise.resolve({ success: true, results: [{ series_id: '1000002', series_title: '已完成第二页' }], channel: 'web', page: 2, hasMore: false });
        return calls.filter(call => call.source === 'hema').length === 1 ? old.promise : retry.promise;
      },
    });
    ui.find(n => n.props['aria-label'] === '搜索短剧名称').props.onChange({ target: { value: '剧名' } }); ui.render();
    await ui.button('搜索').props.onClick(); await ui.flush();
    const firstTask = ui.button('加载更多').props.onClick(); await ui.flush();
    ui.advanceTimers(25000); await ui.flush();
    assert.ok(ui.text().includes('已完成第二页'), 'one hanging source must not discard a completed page');
    assert.ok(ui.text().includes('河马短剧') && ui.text().includes('超时'));
    assert.ok(!ui.button('加载更多').props.disabled, 'the deadline must release its own request lock');
    const nextTask = ui.button('加载更多').props.onClick(); await ui.flush();
    assert.equal(calls.length, 3, 'a completed source must not be requested again');
    assert.equal(calls[2].source, 'hema'); assert.equal(calls[2].page, 2); assert.equal(calls[2].cursor.page, 1);
    old.resolve({ success: true, results: [{ series_id: 'hema:8', series_title: '超时迟到页' }], channel: 'web', page: 2, hasMore: false });
    await firstTask; await ui.flush();
    assert.ok(ui.button('加载中…')?.props.disabled); assert.ok(!ui.text().includes('超时迟到页'));
    retry.resolve({ success: true, results: [{ series_id: 'hema:2', series_title: '重试第二页' }], channel: 'web', page: 2, hasMore: false });
    await nextTask; await ui.flush();
    assert.ok(ui.text().includes('已完成第二页') && ui.text().includes('重试第二页'));
    assert.equal(ui.button('加载更多'), undefined); ui.unmount();
  });
  await test('load more follows the first-page channel and merges results', async () => {
    const calls = [];
    const ui = await mount('SearchPanel', {
      searchSeries: async (_kw, { source }) => source === 'hongguo'
        ? { success: true, results: [{ series_id: '1000001', series_title: '第一部' }], channel: 'web', page: 1, hasMore: true, cursor: { page: 1, nextPage: 2 } }
        : { success: true, results: [] },
      searchSeriesMore: async (_kw, options) => {
        calls.push(options);
        return { success: true, results: [{ series_id: '1000002', series_title: '第二部' }], channel: 'web', page: 2, hasMore: false, cursor: { page: 2, nextPage: null } };
      },
    });
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '连载剧' } }); ui.render();
    ui.button('搜索').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('第一部'));
    await ui.button('加载更多').props.onClick(); await ui.flush();
    assert.equal(calls[0].source, 'hongguo');
    assert.equal(calls[0].channel, 'web');
    assert.equal(calls[0].page, 2);
    assert.equal(calls[0].cursor.page, 1);
    assert.equal(calls[0].cursor.nextPage, 2);
    assert.ok(ui.text().includes('第二部'), 'the second page must be merged into the list');
    assert.equal(ui.button('加载更多'), undefined, 'the button must disappear when no source has more');
    ui.unmount();
  });
  await test('empty hongguo results open the source page for the searched keyword', async () => {
    const opened = [];
    const ui = await mount('SearchPanel', {
      searchSeries: async () => ({ success: true, results: [] }),
      searchWindowShow: async (...args) => { opened.push(args); return { success: true }; },
    });
    ui.find(n => n.props['aria-label'] === '短剧来源').props.onChange({ target: { value: 'hongguo' } }); ui.render();
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '谁说 纨绔' } }); ui.render();
    ui.button('搜索').props.onClick(); await ui.flush();
    await ui.button('打开来源页面').props.onClick(); await ui.flush();
    assert.deepEqual(opened[0], [true, `https://hongguoduanju.com/search/${encodeURIComponent('谁说 纨绔')}`]);
    ui.unmount();
  });
  await test('a search timeout still keeps results from sources that already finished', async () => {
    const pending = deferred();
    const ui = await mount('SearchPanel', { searchSeries: (kw, options) => options.source === 'hongguo'
      ? pending.promise
      : Promise.resolve({ success: true, results: [{ series_id: 'X', series_title: '先返回的剧' }] }) });
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '剧名' } }); ui.render();
    ui.button('搜索').props.onClick(); await ui.flush(); await ui.flush();
    assert.ok(ui.text().includes('先返回的剧'), 'a fast source must render before a slow source finishes');
    ui.advanceTimers(26000); await ui.flush();
    assert.ok(ui.text().includes('先返回的剧'), 'completed sources must stay visible after another source times out');
    assert.ok(ui.text().includes('未返回结果'), 'the unfinished source must be named');
    assert.ok(ui.find(n => n.props.role === 'alert'), 'the timeout must be announced');
    pending.resolve({ success: true, results: [] }); await ui.flush(); ui.unmount();
  });
  await test('a failed progressive search pick stops loading and permits the same search again', async () => {
    const slow = deferred(); let calls = 0;
    const ui = await mount('SearchPanel', {
      searchSeries: (_kw, options) => ++calls === 1 && options.source === 'hongguo'
        ? slow.promise
        : Promise.resolve({ success: true, results: [{ series_id: options.source + ':1', series_title: '先返回的剧' }] }),
      searchResolve: async () => ({ success: false, error: '详情解析失败示例' }),
    });
    await ui.flush();
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '剧名' } }); ui.render();
    ui.button('搜索').props.onClick(); await ui.flush();
    const card = ui.find(n => n.props.className?.startsWith('search-card '));
    assert.ok(card, 'completed sources must be selectable while another source is pending');
    await card.props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('详情解析失败示例'));
    assert.equal(ui.button('搜索').props.disabled, false, 'a failed detail pick must leave search enabled');
    ui.advanceTimers(26000); await ui.flush();
    assert.ok(!ui.text().includes('正在寻找相关短剧'));
    ui.button('搜索').props.onClick(); await ui.flush();
    assert.equal(calls, 6, 'the same keyword must start a new search even while an old source is pending');
    slow.resolve({ success: true, results: [{ series_id: 'old', series_title: '过期结果' }] }); await ui.flush();
    assert.ok(!ui.text().includes('过期结果'));
    assert.equal(ui.button('搜索').props.disabled, false);
    ui.unmount();
  });

  await test('a stuck all-source search stops spinning after the safety timeout', async () => {
    const pending = deferred();
    const ui = await mount('SearchPanel', { searchSeries: () => pending.promise });
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '剧名' } }); ui.render();
    ui.button('搜索').props.onClick(); await ui.flush();
    ui.advanceTimers(26000); await ui.flush();
    assert.ok(ui.text().includes('搜索超时'), 'a stuck search must surface a timeout');
    assert.ok(!ui.text().includes('正在寻找相关短剧'), 'loading copy must stop after the timeout');
    pending.resolve({ success: true, results: [] }); await ui.flush(); ui.unmount();
  });

  await test('xifan search source change ignores late searches and detail picks', async () => {
    const old = deferred(), pick = deferred(), picked = []; const calls = [];
    const ui = await mount('SearchPanel', { searchSeries: (kw, options) => { calls.push(options); return options?.source === 'xifan' ? Promise.resolve({ success: true, results: [{ series_id: 'X', series_title: '西饭搜索' }] }) : old.promise; }, searchResolve: () => pick.promise }, { onSelectSeries: d => picked.push(d) });
    ui.find(n => n.type === 'input').props.onChange({ target: { value: '剧名' } }); ui.render(); ui.button('搜索').props.onClick(); ui.render();
    const source = ui.find(n => n.props['aria-label'] === '短剧来源'); assert.ok(source, 'source selector missing');
    source.props.onChange({ target: { value: 'xifan' } }); ui.render(); ui.button('搜索').props.onClick(); await ui.flush();
    old.resolve({ success: true, results: [{ series_id: 'H', series_title: '旧搜索' }] }); await ui.flush();
    assert.ok(ui.text().includes('西饭搜索')); assert.ok(!ui.text().includes('旧搜索'));
    ui.find(n => n.props.className?.startsWith('search-card ')).props.onClick(); ui.render();
    ui.find(n => n.props['aria-label'] === '短剧来源').props.onChange({ target: { value: 'hongguo' } }); ui.render();
    pick.resolve(ok(detail('X'))); await ui.flush(); assert.equal(picked.length, 0); assert.equal(calls[0].source, 'hongguo'); ui.unmount();
  });
  await test('xifan locked episodes are excluded from every download selection', async () => {
    const data = detail('xifan:test:A'); data.episodes[0].locked = true; let submitted;
    const ui = await mount('HongguoDownload', { hongguoDownloadBatch: async p => { submitted = p; return { success: true, count: p.episodes.length }; } });
    ui.find(n => n.props.onSelectSeries).props.onSelectSeries(data); ui.render();
    assert.ok(ui.button('下载选中集数 (1/2)'), 'default must exclude locked');
    for (const label of ['全选', '前 10 集', '前 30 集', '后 30 集']) { ui.button(label).props.onClick(); ui.render(); assert.ok(ui.button('下载选中集数 (1/2)'), label); }
    ui.button('反选').props.onClick(); ui.render(); assert.ok(ui.button('下载选中集数 (0/2)'));
    ui.find(n => n.props['aria-label'] === '选择集数范围').props.onChange({ target: { value: '1-2' } }); ui.render(); ui.button('应用').props.onClick(); ui.render();
    assert.ok(ui.button('下载选中集数 (1/2)')); assert.ok(ui.find(n => n.props.className?.startsWith('episode-card') && n.props.disabled));
    await ui.button('下载选中集数').props.onClick(); assert.equal(submitted.episodes.length, 1); assert.equal(submitted.episodes[0].vid_index, 2); ui.unmount();
  });
  await test('HongguoDownload 勾选导出立即下载并订阅后台 text-export-done 回报', async () => {
    let submitted, exportCb;
    const data = detail('7503745441910017049');
    const ui = await mount('HongguoDownload', {
      getSettings: async () => ({ export_text: { danmaku: false, comments: false, reviews: false } }),
      // 下载响应立即返回，不再带 export 结果（导出转后台）
      hongguoDownloadBatch: async (p) => { submitted = p; return { success: true, count: 2, exportRequested: true }; },
      onTextExportDone: (cb) => { exportCb = cb; return () => {}; },
      saveSettings: async () => ({ success: true }),
    });
    await ui.flush();
    ui.find(n => n.props.onSelectSeries).props.onSelectSeries(data); ui.render();
    for (const label of ['弹幕', '评论', '剧评']) {
      const box = ui.find(n => n.props.type === 'checkbox' && n.props['aria-label'] === label);
      assert.ok(box, `缺少「${label}」导出勾选`);
      box.props.onChange({ target: { checked: true } }); ui.render();
    }
    await ui.button('下载选中集数').props.onClick(); await ui.flush();
    assert.equal(submitted.export.danmaku, true); assert.equal(submitted.export.comments, true); assert.equal(submitted.export.reviews, true);
    assert.ok(ui.text().includes('提交'), '提交后立刻反馈，不等文字导出');
    assert.ok(typeof exportCb === 'function', '必须订阅 text-export-done 以接收后台结果');
    exportCb({ seriesId: '7503745441910017049', danmaku: { ok: 2, fail: 0, skipped: 0 }, comments: { ok: 1, fail: 0, skipped: 0 }, reviews: { ok: 1, fail: 0, skipped: 0 } });
    ui.render();
    assert.ok(ui.text().includes('弹幕 2'), '后台事件回报各类型条数');
    assert.ok(ui.text().includes('评论 1'));
    ui.unmount();
  });
  await test('HongguoDownload 只勾选评论时事件不把未勾选类型报成"0 条"', async () => {
    let exportCb;
    const data = detail('7503745441910017049');
    const ui = await mount('HongguoDownload', {
      getSettings: async () => ({ export_text: {} }),
      hongguoDownloadBatch: async () => ({ success: true, count: 2, exportRequested: true }),
      onTextExportDone: (cb) => { exportCb = cb; return () => {}; },
      saveSettings: async () => ({ success: true }),
    });
    await ui.flush();
    ui.find(n => n.props.onSelectSeries).props.onSelectSeries(data); ui.render();
    ui.find(n => n.props.type === 'checkbox' && n.props['aria-label'] === '评论').props.onChange({ target: { checked: true } }); ui.render();
    await ui.button('下载选中集数').props.onClick(); await ui.flush();
    exportCb({ seriesId: '7503745441910017049', danmaku: { ok: 0, fail: 0, skipped: 0 }, comments: { ok: 2, fail: 0, skipped: 0 }, reviews: { ok: 0, fail: 0, skipped: 0 } });
    ui.render();
    assert.ok(ui.text().includes('评论 2'), '只播报勾选的评论');
    assert.ok(!ui.text().includes('弹幕 0'), '未勾选的弹幕不应报"弹幕 0"');
    assert.ok(!ui.text().includes('剧评 0'), '未勾选的剧评不应报"剧评 0"');
    ui.unmount();
  });
  await test('HongguoDownload 非红果来源隐藏导出勾选且提交不带导出', async () => {
    let submitted;
    const data = detail('xifan:test:A');
    const ui = await mount('HongguoDownload', {
      // 模拟上次在红果剧记得的勾选：切到非红果来源也不应出现/生效
      getSettings: async () => ({ export_text: { danmaku: true, comments: true, reviews: true } }),
      hongguoDownloadBatch: async (p) => { submitted = p; return { success: true, count: 2 }; },
    });
    await ui.flush();
    ui.find(n => n.props.onSelectSeries).props.onSelectSeries(data); ui.render();
    assert.ok(!ui.find(n => n.props.type === 'checkbox' && n.props['aria-label'] === '弹幕'), '非红果来源应隐藏弹幕勾选');
    assert.ok(!ui.find(n => n.props.type === 'checkbox' && n.props['aria-label'] === '剧评'), '非红果来源应隐藏剧评勾选');
    await ui.button('下载选中集数').props.onClick(); await ui.flush();
    assert.equal(submitted.export.danmaku, false);
    assert.equal(submitted.export.comments, false);
    assert.equal(submitted.export.reviews, false);
    ui.unmount();
  });
  await test('xifan browse locks selection and starts the first unlocked episode', async () => {
    const data = detail('X'); data.episodes[0].locked = true; let played, submitted;
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: async () => ({ success: true, results: [{ series_id: 'X', series_title: 'X' }] }), searchResolve: async () => ok(data), getSeriesEpisodes: async () => ok(data), playSeries: async p => { played = p; return { success: false }; }, hongguoDownloadBatch: async p => { submitted = p; return { success: false }; } });
    await ui.flush(); ui.find(n => n.props.className === 'browse-card').props.onClick(); await ui.flush();
    assert.ok(ui.button('下载选中 (1)')); ui.button('全选').props.onClick(); ui.render(); assert.ok(ui.button('下载选中 (1)'));
    ui.find(n => n.props['aria-label'] === '选择集数范围').props.onChange({ target: { value: '1-2' } }); ui.render(); ui.button('应用').props.onClick(); ui.render(); assert.ok(ui.button('下载选中 (1)'));
    await ui.button('立即播放').props.onClick(); assert.equal(played.vidIndex, 2);
    await ui.button('下载选中').props.onClick(); assert.equal(submitted.episodes.length, 1); assert.equal(submitted.episodes[0].vid_index, 2); ui.unmount();
  });
  await test('xifan player skips locked episodes in auto next and download missing', async () => {
    const data = detail('X'); data.total = 3; data.episodes.push(episode(3)); data.episodes[1].locked = true;
    const requested = [], downloaded = [];
    const ui = await mount('Player', { getSeriesList: async () => [{ series_id: 'X' }], getSeriesEpisodes: async () => ok(data), getPlaybackPosition: async () => null, prepareOnlinePlay: async p => { requested.push(p); return { success: true, url: `hongguo-stream://${p.vidIndex}` }; }, downloadSingleEpisode: async (sid, n) => { downloaded.push(n); return { success: true, count: 1 }; } }, { target: { seriesId: 'X', vidIndex: 1, ts: 1 } });
    await ui.flush(); const locked = ui.find(n => n.props['aria-label'] === '第 2 集'); assert.equal(locked.props.disabled, true);
    locked.props.onClick(); await ui.flush(); assert.equal(requested.length, 1, 'handler must also guard locked');
    ui.find(n => n.type === 'video').props.onEnded(); await ui.flush(); assert.equal(requested.at(-1).vidIndex, 3);
    await ui.button('下载未完成集').props.onClick(); assert.deepEqual(downloaded, [1, 3]); ui.unmount();
  });
  await test('xifan merge progress retains completed episode count', async () => {
    let update;
    const ui = await mount('DownloadManager', { getDownloadTasks: async () => [], getSeriesList: async () => [], getMergeTasks: async () => [{ id: 'm', seriesTitle: '合并', total: 72, done: 0, progress: 0, status: 'running' }], onMergeProgress: fn => { update = fn; return () => {}; } });
    await ui.flush(); update({ id: 'm', progress: 35, done: 24 }); ui.render(); assert.ok(ui.text().includes('24/72 集')); ui.unmount();
  });
  await test('app navigation keeps visited pages and marks background pages inactive', async () => {
    const ui = await mount('../App', { getAppInfo: async () => ({ platform: 'darwin' }) });
    await ui.flush(); ui.button('设置').props.onClick(); ui.render();
    assert.ok(ui.find(n => n.props['data-page'] === 'browse')?.props.hidden, 'browse must remain mounted but hidden');
    assert.equal(ui.find(n => n.props['data-page'] === 'settings')?.props.hidden, false);
    ui.button('我的剧库').props.onClick(); ui.render(); ui.button('发现短剧').props.onClick(); ui.render();
    const player = ui.find(n => n.props['data-page'] === 'player');
    assert.ok(player?.props.hidden, 'visited player must be retained');
    assert.equal(player.children[0]?.props.active, false, 'hidden player must receive inactive state');
    assert.equal(ui.nodes().filter(n => n.props['data-page'] === 'browse').length, 1);
    ui.unmount();
  });
  await test('app ordinary navigation preserves the last playback target', async () => {
    let navigate;
    const ui = await mount('../App', { getAppInfo: async () => ({ platform: 'darwin' }), onNavigate: fn => { navigate = fn; return () => {}; } });
    await ui.flush(); navigate({ page: 'player', payload: { seriesId: 'A', vidIndex: 2 } }); ui.render();
    const player = () => ui.find(n => n.props['data-page'] === 'player').children[0];
    const target = player().props.target;
    assert.equal(target.seriesId, 'A'); assert.equal(target.vidIndex, 2);
    ui.button('下载管理').props.onClick(); ui.render();
    assert.equal(player().props.target, target, 'background navigation must not reset playback initialization');
    ui.button('我的剧库').props.onClick(); ui.render();
    assert.equal(player().props.target, target, 'returning must keep the same playback target');
    ui.unmount();
  });
  await test('download keeps its search panel mounted while selecting episodes', async () => {
    const ui = await mount('HongguoDownload', {});
    ui.find(n => n.props.onSelectSeries).props.onSelectSeries(detail('A')); ui.render();
    assert.ok(ui.find(n => n.props.onSelectSeries), 'search results must survive selecting a series');
    ui.button('搜索剧集').props.onClick(); ui.render();
    assert.ok(ui.button('下载选中集数 (2/2)'), 'episode selection must survive returning to search');
    ui.unmount();
  });
  await test('search keyboard ignores IME confirmation and duplicate Enter', async () => {
    const pending = deferred(); let calls = 0;
    const ui = await mount('SearchPanel', { searchSeries: () => { calls++; return pending.promise; } });
    const input = () => ui.find(n => n.props['aria-label'] === '搜索短剧名称');
    input().props.onChange({ target: { value: '短剧' } }); ui.render();
    input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() {} });
    assert.equal(calls, 0, 'confirming an IME candidate must not search');
    input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    input().props.onKeyDown({ key: 'Enter', preventDefault() {} }); ui.render();
    input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    assert.equal(calls, 3, 'same pending all-source search must call each source only once');
    pending.resolve({ success: true, results: [] }); await ui.flush(); ui.unmount();
  });
  await test('resolve keyboard ignores IME confirmation and duplicate Enter', async () => {
    const pending = deferred(); let calls = 0;
    const ui = await mount('HongguoDownload', { hongguoResolve: () => { calls++; return pending.promise; } });
    ui.button('粘贴链接').props.onClick(); ui.render();
    const input = () => ui.find(n => n.props['aria-label'] === '短剧分享链接或剧集 ID');
    input().props.onChange({ target: { value: 'A' } }); ui.render();
    input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() {} });
    assert.equal(calls, 0);
    input().props.onKeyDown({ key: 'Enter', preventDefault() {} }); input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    assert.equal(calls, 1); pending.resolve(ok(detail('A'))); await ui.flush(); ui.unmount();
  });
  for (const file of ['HongguoDownload', 'Browse']) await test(`${file} range accepts Chinese separators and rejects partial numbers without changing selection`, async () => {
    const data = detail('range'); data.total = 3; data.episodes.push(episode(3));
    const ui = await mount(file, { getSeriesList: async () => [], browseCategories: async () => [], browseList: async () => ({ success: true, results: [{ series_id: 'range', series_title: 'range' }] }), searchResolve: async () => ok(data), getSeriesEpisodes: async () => ok(data) });
    if (file === 'Browse') { await ui.flush(); ui.find(n => n.props.className === 'browse-card').props.onClick(); await ui.flush(); }
    else { ui.find(n => n.props.onSelectSeries).props.onSelectSeries(data); ui.render(); }
    const input = () => ui.find(n => n.props['aria-label'] === '选择集数范围');
    input().props.onChange({ target: { value: '1，3' } }); ui.render(); ui.button('应用').props.onClick(); ui.render();
    const selected = () => ui.nodes().filter(n => n.props['aria-pressed'] === true && /episode-card|ep-chip/.test(n.props.className || '')).length;
    assert.equal(selected(), 2, 'Chinese commas must select both episodes');
    input().props.onChange({ target: { value: '2oops' } }); ui.render(); ui.button('应用').props.onClick(); ui.render();
    assert.equal(selected(), 2, 'invalid input must preserve selection');
    assert.ok(ui.find(n => n.props.role === 'alert'), 'invalid range needs visible feedback'); ui.unmount();
  });
  await test('proxy test ignores results after the draft changes or closes', async () => {
    const pending = deferred();
    const ui = await mount('Settings', { getSettings: async () => ({ proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 7890 }), testProxy: () => pending.promise });
    await ui.flush(); ui.button('配置代理').props.onClick(); ui.render(); ui.button('测试连接').props.onClick(); ui.render();
    ui.find(n => n.props['aria-label'] === '代理端口').props.onChange({ target: { value: '7891' } }); ui.render();
    pending.resolve({ success: true, message: 'OLD_CONFIG_OK' }); await ui.flush();
    assert.ok(!ui.text().includes('OLD_CONFIG_OK'), 'old test result must not describe the edited draft'); ui.unmount();
  });
  await test('proxy password save and clear refresh the UI without replaying credentials', async () => {
    let stored = { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 7890, proxy_username: 'test-user', proxy_password: '' };
    const submitted = [];
    const ui = await mount('Settings', {
      getSettings: async () => {
        const { proxy_password, clear_proxy_password, ...visible } = stored;
        return { ...visible, proxy_password_set: !!proxy_password };
      },
      saveSettings: async next => {
        submitted.push({ ...next });
        stored = { ...stored, ...next, proxy_password: next.clear_proxy_password ? '' : next.proxy_password || stored.proxy_password };
        return { success: true };
      },
    });
    await ui.flush();
    ui.button('配置代理').props.onClick(); ui.render();
    const password = () => ui.find(n => n.props['aria-label'] === '代理密码');
    password().props.onChange({ target: { value: 'fixture-password' } }); ui.render();
    await ui.button('保存并生效').props.onClick(); await ui.flush();
    assert.equal(stored.proxy_password, 'fixture-password');
    assert.equal(ui.find(n => n.props.role === 'dialog'), undefined);
    ui.button('配置代理').props.onClick(); ui.render();
    assert.equal(password().props.value, '');
    assert.equal(password().props.placeholder, '已保存，留空表示不修改');
    assert.ok(ui.button('清除已保存密码'), 'first password save must immediately enable clearing');
    ui.button('取消').props.onClick(); ui.render();
    ui.find(n => n.props['aria-label'] === '下载目录').props.onChange({ target: { value: '/fixture-downloads' } }); ui.render();
    await ui.button('保存设置').props.onClick(); await ui.flush();
    assert.equal(Object.hasOwn(submitted.at(-1), 'proxy_password'), false, 'ordinary save must not replay the password');
    ui.button('配置代理').props.onClick(); ui.render();
    ui.button('清除已保存密码').props.onClick(); ui.render();
    await ui.button('保存并生效').props.onClick(); await ui.flush();
    assert.equal(stored.proxy_password, '');
    ui.button('配置代理').props.onClick(); ui.render();
    assert.equal(password().props.placeholder, '密码');
    assert.equal(ui.button('清除已保存密码'), undefined, 'cleared password must not appear saved');
    ui.button('取消').props.onClick(); ui.render();
    ui.find(n => n.props['aria-label'] === '下载目录').props.onChange({ target: { value: '/fixture-downloads-next' } }); ui.render();
    await ui.button('保存设置').props.onClick(); await ui.flush();
    assert.equal(Object.hasOwn(submitted.at(-1), 'proxy_password'), false);
    assert.equal(Object.hasOwn(submitted.at(-1), 'clear_proxy_password'), false);
    assert.equal(stored.proxy_password, '');
    ui.unmount();
  });
  await test('settings failed save reports the reason and retains the draft', async () => {
    const ui = await mount('Settings', { getSettings: async () => ({ root: '/old' }), saveSettings: async () => ({ success: false, error: '磁盘空间不足' }) });
    await ui.flush(); ui.find(n => n.props['aria-label'] === '下载目录').props.onChange({ target: { value: '/new' } }); ui.render();
    await ui.button('保存设置').props.onClick(); ui.render();
    assert.ok(ui.text().includes('磁盘空间不足')); assert.equal(ui.find(n => n.props['aria-label'] === '下载目录').props.value, '/new');
    assert.ok(!ui.text().includes('已保存')); ui.unmount();
  });
  await test('settings reactivation reflects playback switches while keeping the draft', async () => {
    let stored = { root: '/old', auto_delete_watched: false, cache_next_episode: false, compat_mode: false };
    const ui = await mount('Settings', { getSettings: async () => ({ ...stored }) });
    await ui.flush();
    ui.find(n => n.props['aria-label'] === '下载目录').props.onChange({ target: { value: '/new' } }); ui.render();
    ui.setProps({ active: false });
    stored = { ...stored, auto_delete_watched: true, cache_next_episode: true, compat_mode: true };
    ui.setProps({ active: true }); await ui.flush();
    const label = text => ui.find(n => n.type === 'label' && n.children.some(child => child?.props?.className === 'proxy-switch-text' && child.children[0] === text));
    for (const [text, key] of [['看完自动删除', 'auto_delete_watched'], ['缓存后续 2 集', 'cache_next_episode'], ['自动兼容模式', 'compat_mode']]) {
      const control = label(text);
      assert.ok(control, text);
      assert.equal(control.children.find(n => n?.type === 'input').props.checked, stored[key], `${text} must reflect the latest playback setting`);
    }
    assert.equal(ui.find(n => n.props['aria-label'] === '下载目录').props.value, '/new', 'refreshing must keep the unsaved draft');
    ui.unmount();
  });
  await test('settings retained drafts preserve newer playback options and retry explicit edits', async () => {
    let stored = { root: '/old', auto_delete_watched: true, cache_next_episode: true, compat_mode: true };
    let fail = true;
    const submitted = [];
    const ui = await mount('Settings', {
      getSettings: async () => ({ ...stored }),
      saveSettings: async next => {
        submitted.push({ ...next });
        if (fail) return { success: false, error: '磁盘空间不足' };
        stored = { ...stored, ...next };
        return { success: true };
      },
    });
    await ui.flush();
    ui.find(n => n.props['aria-label'] === '下载目录').props.onChange({ target: { value: '/new' } }); ui.render();
    ui.setProps({ active: false });
    stored = { ...stored, auto_delete_watched: false, cache_next_episode: false, compat_mode: false };
    ui.setProps({ active: true }); await ui.flush();
    await ui.button('保存设置').props.onClick(); await ui.flush();
    assert.equal(Object.hasOwn(submitted.at(-1), 'auto_delete_watched'), false, 'unrelated save must not resubmit stale auto-delete');
    assert.equal(ui.find(n => n.props['aria-label'] === '下载目录').props.value, '/new', 'failed save retains draft');
    fail = false;
    await ui.button('保存设置').props.onClick(); await ui.flush();
    assert.equal(stored.root, '/new');
    for (const key of ['auto_delete_watched', 'cache_next_episode', 'compat_mode']) assert.equal(stored[key], false, `preserve latest ${key}`);
    const autoDelete = ui.find(n => n.type === 'label' && n.children.some(child => child?.props?.className === 'proxy-switch-text' && child.children[0] === '看完自动删除'));
    autoDelete.children.find(n => n?.type === 'input').props.onChange({ target: { checked: true } }); ui.render();
    await ui.button('保存设置').props.onClick(); await ui.flush();
    assert.equal(stored.auto_delete_watched, true, 'explicit user edit must still apply');
    stored.auto_delete_watched = false;
    ui.find(n => n.props['aria-label'] === '下载目录').props.onChange({ target: { value: '/next' } }); ui.render();
    await ui.button('保存设置').props.onClick(); await ui.flush();
    assert.equal(stored.auto_delete_watched, false, 'successful save clears the earlier edit intent');
    ui.unmount();
  });
  process.exitCode = failures ? 1 : 0;
})();
