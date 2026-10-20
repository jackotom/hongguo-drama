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

const transformed = new Map();
function compile(file) {
  if (transformed.has(file)) return transformed.get(file);
  const ext = path.extname(file);
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: ext === '.mjs' || ext === '.js' ? 'js' : 'jsx', format: 'cjs', jsx: 'transform' }).code;
  transformed.set(file, code);
  return code;
}
async function mount(file, api, props = {}) {
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
  const memory = new Map();
  const localStorage = { getItem: key => memory.has(key) ? memory.get(key) : null, setItem: (key, value) => memory.set(String(key), String(value)), removeItem: key => memory.delete(key) };
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
  const shared = { window, document, localStorage, navigator: window.navigator, console, crypto: require('node:crypto').webcrypto, Event, CustomEvent, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, queueMicrotask, structuredClone, ResizeObserver, setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval() {}, requestAnimationFrame: fn => { const id = ++timerId; timers.set(id, { fn, delay: 16 }); return id; } };
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
  return { render, flush, find, nodes, button, advanceTimers, setProps: next => { props = { ...props, ...next }; render(); }, text: () => text(tree), unmount: () => cleanups.forEach(fn => fn?.()) };
}

(async () => {
  let failures = 0;
  const test = async (name, fn) => { if (process.argv[2] && !new RegExp(process.argv[2]).test(name)) return; try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.stack}`); } };
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
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [{ slug: 'real-drama', label: '真人剧' }, { slug: 'comic', label: '漫画' }], browseList: async p => p.category === 'comic' ? pendingComic.promise : p.category === 'comic-drama' ? list('动态漫剧') : (realCalls++, list('真人缓存')) });
    await ui.flush(); ui.button('漫画').props.onClick(); await ui.flush();
    ui.button('真人剧').props.onClick();
    pendingComic.resolve({ success: true, results: [], unsupported: true, emptyMessage: '这里是图文漫画，暂不支持视频下载；看动态漫画请切换“漫剧”。' }); await Promise.resolve(); await Promise.resolve(); await ui.flush();
    assert.ok(realCalls >= 1, 'switching back must not queue another request behind comic');
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
  await test('browse categories: cancel is immediate and cached cards survive refresh errors', async () => {
    const pending = deferred(); let calls = 0; let hang = false;
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: () => { calls++; return hang ? pending.promise : Promise.resolve({ success: true, results: [{ series_id: 'saved', series_title: '已加载片单' }] }); } });
    await ui.flush(); const refresh = ui.button('刷新片单'); assert.ok(refresh, 'cached results need an explicit refresh'); hang = true; refresh.props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('已加载片单'));
    const cancel = ui.button('取消加载'); assert.ok(cancel, 'loading must remain cancellable'); cancel.props.onClick(); ui.render();
    assert.ok(ui.text().includes('已取消')); assert.ok(ui.text().includes('已加载片单'));
    pending.resolve({ success: false, error: '来源不可用' }); await ui.flush();
    assert.ok(!ui.text().includes('来源不可用'), 'cancelled request must not overwrite cancellation');
    ui.button('重新加载').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('来源不可用')); assert.ok(ui.text().includes('已加载片单')); ui.unmount();
  });

  await test('xifan browse source switch rejects late lists and opens the current source URL', async () => {
    const old = deferred(), opened = [], pages = []; let calls = 0;
    const ui = await mount('Browse', { getSeriesList: async () => [], browseCategories: async () => [], browseList: p => p.source === 'xifan' ? (pages.push(p.page), Promise.resolve({ success: true, results: [{ series_id: 'X', series_title: '西饭片单' }], genres: [{ slug: '68', label: '都市' }], total: 0, totalPages: 0, hasMore: p.page === 1 })) : ++calls === 1 ? Promise.resolve({ success: true, results: [{ series_id: 'H', series_title: '红果片单' }], sourceUrl: 'https://www.hongguoduanju.com/category/real-drama' }) : old.promise, searchWindowShow: async (...args) => opened.push(args) });
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
  await test('settings failed save reports the reason and retains the draft', async () => {
    const ui = await mount('Settings', { getSettings: async () => ({ root: '/old' }), saveSettings: async () => ({ success: false, error: '磁盘空间不足' }) });
    await ui.flush(); ui.find(n => n.props['aria-label'] === '下载目录').props.onChange({ target: { value: '/new' } }); ui.render();
    await ui.button('保存设置').props.onClick(); ui.render();
    assert.ok(ui.text().includes('磁盘空间不足')); assert.equal(ui.find(n => n.props['aria-label'] === '下载目录').props.value, '/new');
    assert.ok(!ui.text().includes('已保存')); ui.unmount();
  });
  process.exitCode = failures ? 1 : 0;
})();
