// No network, browser, media or real timers. Run: node scripts/check-download-manager.cjs [name].
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function mount(api = {}, props = {}) {
  const slots = [], effects = [], cleanups = [], events = new Map(), timers = new Map(), domEvents = new Map();
  let cursor = 0, tree, timerId = 0, writes = 0, dialogOpen;
  const changed = (old, deps) => !old || deps.some((d, i) => !Object.is(d, old[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { writes++; slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback: (fn, deps) => react.useMemo(() => fn, deps),
    useEffect: (fn, deps) => { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const defaults = { getDownloadTasks: async () => [], getSeriesList: async () => [], getMergeTasks: async () => [], getQueueStatus: async () => ({ active: 0, queued: 0, maxConcurrent: 3 }) };
  const domTarget = scope => ({ addEventListener: (name, fn) => domEvents.set(`${scope}:${name}`, fn), removeEventListener: name => domEvents.delete(`${scope}:${name}`) });
  const moreActions = { open: false, contains: target => target?.insideMenu === true, querySelector: () => ({ focus() { moreActions.focused = true; } }) };
  const window = { ...domTarget('window'), electronAPI: new Proxy({ ...defaults, ...api }, { get: (obj, key) => obj[key] || (key.startsWith('on') ? fn => { events.set(key, fn); return () => events.delete(key); } : async () => ({ success: true })) }) };
  const setTimer = (fn, delay, interval = false) => { const id = ++timerId; timers.set(id, { fn, delay, interval }); return id; };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/components/DownloadManager.jsx`, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
    module, exports: module.exports, require: name => name === '../i18n' ? { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {}, getLanguage: () => 'zh-CN' } : name === 'react' ? react : name === './useDialogKeyboard' ? open => { dialogOpen = open; } : {}, window,
    document: { ...domTarget('document'), querySelector: () => null }, console, setTimeout: (fn, delay) => setTimer(fn, delay), clearTimeout: id => timers.delete(id), setInterval: (fn, delay) => setTimer(fn, delay, true), clearInterval: id => timers.delete(id),
  });
  const render = () => { cursor = 0; tree = module.exports.default(props); const visit = node => { if (!node || typeof node !== 'object') return; if (node.props?.className === 'dm-more-actions' && node.props.ref) node.props.ref.current = moreActions; node.children?.forEach(visit); }; visit(tree); effects.splice(0).forEach(fn => fn()); };
  const nodes = () => { const out = []; const walk = n => { if (!n || typeof n !== 'object') return; out.push(n); n.children?.forEach(walk); }; walk(tree); return out; };
  const textOf = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(textOf).join('') || '';
  const find = predicate => nodes().find(predicate);
  render();
  return {
    render, find, nodes, moreActions, dispatch: (scope, name, event = {}) => domEvents.get(`${scope}:${name}`)?.(event), domListeners: () => domEvents.size, text: () => textOf(tree), button: label => find(n => n.type === 'button' && textOf(n).includes(label)),
    flush: async () => { for (let i = 0; i < 25; i++) { await Promise.resolve(); render(); } },
    advance: ms => { for (const [id, timer] of [...timers]) if (timer.delay <= ms && timers.has(id)) { if (!timer.interval) timers.delete(id); timer.fn(); } },
    emit: (name, data) => events.get(name)?.(data), setProps: next => { props = { ...props, ...next }; render(); },
    writes: () => writes, dialogOpen: () => dialogOpen, intervals: () => [...timers.values()].filter(t => t.interval).length,
    unmount: () => cleanups.forEach(fn => fn?.()),
  };
}
const task = (i, status = 'downloading') => ({ id: `t${i}`, title: `第${i}集`, status, progress: 0, startTime: i, hongguoInfo: { series_id: 'A', vid_index: i } });
const rows = ui => ui.nodes().filter(n => /^dm-task(?: selected)?$/.test((n.props.className || '').trim()));
const runningMerge = () => ({ id: 'm', status: 'running', total: 2, done: 0, progress: 0, seriesTitle: 'A', startTime: Date.now() });

(async () => {
  let failures = 0, passed = 0;
  const test = async (name, fn) => { if (process.argv[2] && !new RegExp(process.argv[2]).test(name)) return; try { await fn(); passed++; } catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); } };
  await test('more menu dismisses outside, focus exit, Escape, window blur, actions and page exit', async () => {
    const ui = mount(); await ui.flush();
    for (const [scope, name] of [['document', 'pointerdown'], ['document', 'focusin'], ['window', 'blur']]) {
      ui.moreActions.open = true;
      if (scope === 'document') {
        ui.dispatch(scope, name, { target: { insideMenu: true } });
        assert.equal(ui.moreActions.open, true, 'interacting inside must keep the menu open');
      }
      ui.dispatch(scope, name, { target: {} });
      assert.equal(ui.moreActions.open, false, `${name} outside must close the menu`);
    }
    ui.moreActions.open = true;
    ui.dispatch('document', 'keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(ui.moreActions.open, false, 'Escape must close the menu');
    assert.equal(ui.moreActions.focused, true, 'Escape returns focus to the summary');
    ui.moreActions.open = true;
    ui.find(n => n.props.className === 'dm-more-menu').props.onClick({ target: { closest: () => ({ disabled: false }) } });
    assert.equal(ui.moreActions.open, false, 'choosing an action closes the menu');
    ui.moreActions.open = true; ui.setProps({ active: false });
    assert.equal(ui.moreActions.open, false, 'leaving the download page closes the menu');
    ui.unmount(); assert.equal(ui.domListeners(), 0);
  });
  await test('automatic retry is visible, stoppable and separate from terminal failures', async () => {
    let stopped, retried;
    const ui = mount({getDownloadTasks: async () => [task(1)],
      stopDownload: async id => { stopped = id; return {success:true}; },
      retryTask: async id => { retried = id; return {success:true}; }});
    await ui.flush();
    ui.emit('onDownloadFailed', {id:'t1', error:'网络断开', retryAt:Date.now()+30000, sourceRetries:1});
    ui.advance(250); await ui.flush();
    assert.ok(ui.text().includes('等待重试 1'));
    assert.ok(ui.text().includes('失败/停止 0'));
    assert.equal(ui.button('重试失败').props.disabled, true);
    assert.ok(ui.text().includes('自动重试 1/3'));
    const retry = ui.find(n => n.type === 'button' && n.props.title === '立即重试');
    assert.ok(retry); await retry.props.onClick(); assert.equal(retried, 't1');
    const stop = ui.find(n => n.type === 'button' && n.props.title === '停止自动重试');
    assert.ok(stop); await stop.props.onClick(); assert.equal(stopped, 't1');
    ui.emit('onDownloadFailed', {id:'t1',error:'重试耗尽',retryAt:null,sourceRetries:3});
    ui.advance(250); await ui.flush();
    assert.ok(!ui.text().includes('等待重试 1'));
    assert.ok(ui.text().includes('失败/停止 1'));
    ui.unmount();
  });
  await test('merge selector requests downloaded files and refreshes after completion and deletion', async () => {
    let list = [], options;
    const ui = mount({ getSeriesList: async value => { options = value; return list; }, getDownloadTasks: async () => [task(1, 'completed')], deleteTasksWithFiles: async () => { list = []; return { success: true, count: 1, freed: 120000 }; } });
    await ui.flush(); assert.equal(options?.downloadedOnly, true, 'merge selector must request real local episodes');
    assert.equal(ui.button('合并整部剧'), undefined);
    list = [{ series_id: 'A', series_title: 'Downloaded' }];
    ui.emit('onDownloadCompleted', { id: 't1' }); ui.advance(250); await ui.flush();
    assert.ok(ui.button('合并整部剧'), 'completed downloads must appear immediately');
    rows(ui)[0].props.onClick(); ui.render(); ui.button('删除已选').props.onClick(); ui.render();
    ui.find(n => n.props.className === 'dm-confirm-check').children.find(n => n.type === 'input').props.onChange({ target: { checked: true } }); ui.render();
    await ui.button('删除任务和文件').props.onClick(); await ui.flush();
    assert.equal(ui.button('合并整部剧'), undefined, 'last deleted episode must remove its merge option');
    ui.unmount();
  });
  await test('periodic and task events avoid disk scans; focusing merge revalidates files', async () => {
    let list = [{ series_id: 'A', series_title: 'A' }, { series_id: 'B', series_title: 'B' }];
    let scans = 0;
    const ui = mount({ getSeriesList: async options => { if (options?.downloadedOnly) scans++; return list; } }); await ui.flush();
    ui.button('合并整部剧').props.onClick(); ui.render(); assert.ok(ui.button('智能快速合并'));
    ui.advance(15000); await ui.flush();
    ui.emit('onDownloadTaskAdded', {}); ui.emit('onDownloadQueueChanged', {}); ui.emit('onDownloadCompleted', { id: 'new' }); ui.advance(250); await ui.flush();
    assert.equal(scans, 1, 'background status changes must not scan the whole library');
    list = [list[1]];
    await ui.find(n => n.type === 'select' && n.props.className?.includes('merge-select')).props.onFocus(); await ui.flush();
    assert.equal(ui.button('智能快速合并'), undefined, 'changed target must close the existing confirmation');
    const select = ui.find(n => n.type === 'select' && n.props.className?.includes('merge-select'));
    assert.equal(select.props.value, 'B'); ui.unmount();
  });
  await test('one initial snapshot and no polling or focus trap while hidden', async () => {
    let calls = 0;
    const ui = mount({ getDownloadTasks: async () => { calls++; return [task(1)]; } });
    await ui.flush(); assert.equal(calls, 1, 'initial effects must not request duplicate snapshots');
    ui.find(n => n.props.title?.startsWith('删除任务')).props.onClick(); ui.render(); assert.equal(ui.dialogOpen(), true);
    ui.setProps({ active: false }); const before = calls; ui.advance(20000); await ui.flush();
    assert.equal(ui.intervals(), 0); assert.equal(calls, before); assert.equal(ui.dialogOpen(), false);
    const writes = ui.writes(); ui.emit('onDownloadProgress', { id: 't1', progress: 98 }); ui.advance(250); await ui.flush();
    assert.equal(ui.writes(), writes, 'hidden page must ignore high frequency task events'); ui.unmount();
  });
  await test('reactivation refreshes newly registered series and removes stale selection', async () => {
    let list = [{ series_id: 'A', series_title: 'Old' }];
    const ui = mount({ getSeriesList: async () => list }); await ui.flush();
    ui.setProps({ active: false }); list = [{ series_id: 'B', series_title: 'New' }]; ui.setProps({ active: true }); await ui.flush();
    const select = ui.find(n => n.type === 'select' && n.props.className?.includes('merge-select'));
    assert.equal(select.props.value, 'B'); assert.ok(ui.text().includes('New')); assert.ok(!ui.text().includes('Old')); ui.unmount();
  });
  await test('progress events coalesce into one task update and keep the latest value', async () => {
    const ui = mount({ getDownloadTasks: async () => [task(1)] }); await ui.flush(); const before = ui.writes();
    for (let progress = 1; progress <= 80; progress++) ui.emit('onDownloadProgress', { id: 't1', progress });
    assert.equal(ui.writes(), before, 'progress must wait for one short batch'); ui.advance(250); await ui.flush();
    assert.equal(ui.writes() - before, 1); assert.ok(ui.text().includes('80%')); ui.unmount();
  });
  await test('select-all covers every page and clears every selection', async () => {
    const ui = mount({ getDownloadTasks: async () => Array.from({ length: 205 }, (_, i) => task(i + 1, 'completed')) }); await ui.flush();
    const all = ui.button('全选'); assert.ok(all, 'select-all must be visible beside task counts'); all.props.onClick(); ui.render();
    assert.ok(ui.text().includes('已选 205 项')); assert.ok(rows(ui).every(r => r.props.className.includes('selected')));
    ui.button('下一页').props.onClick(); ui.render(); ui.button('下一页').props.onClick(); ui.render();
    assert.equal(rows(ui).length, 5); assert.ok(rows(ui).every(r => r.props.className.includes('selected')));
    ui.button('取消全选').props.onClick(); ui.render(); assert.ok(rows(ui).every(r => !r.props.className.includes('selected'))); assert.equal(ui.button('删除已选').props.disabled, true);
    rows(ui)[0].props.onClick(); ui.render(); ui.button('全选').props.onClick(); ui.render(); assert.ok(ui.text().includes('已选 205 项')); ui.unmount();
  });
  await test('whole-series merge needs no checked tasks and identifies its series', async () => {
    let sent;
    const ui = mount({ getDownloadTasks: async () => [task(1, 'completed'), task(2, 'completed')], getSeriesList: async () => [{ series_id: 'A', series_title: '整部示例剧' }], mergeSeries: async (...args) => { sent = args; return { success: true, count: 2, totalBytes: 1000 }; } }); await ui.flush();
    assert.ok(ui.text().includes('无需勾选任务')); const merge = ui.button('合并整部剧'); assert.ok(merge); assert.equal(!!merge.props.disabled, false);
    merge.props.onClick(); ui.render(); assert.ok(ui.text().includes('《整部示例剧》')); assert.ok(ui.text().includes('全部已下载分集'));
    await ui.button('智能快速合并').props.onClick(); await ui.flush(); assert.equal(sent[0], 'A'); assert.equal(sent[2].compatible, false); ui.unmount();
  });
  await test('whole-series 1080P merge keeps the dialog and supports fallback modes', async () => {
    let resolveHigh;
    const calls = [];
    const ui = mount({
      getSeriesList: async () => [{ series_id: 'A', series_title: '混清晰度示例剧' }],
      getDownloadTasks: async () => [task(1, 'completed'), task(2, 'completed')],
      mergeSeries: (...args) => {
        calls.push(args);
        if (args[2].require1080) return new Promise(resolve => { resolveHigh = resolve; });
        return Promise.resolve({ success: true, count: 2, totalBytes: 1000 });
      },
    });
    await ui.flush();
    ui.button('合并整部剧').props.onClick(); ui.render();
    assert.match(ui.text(), /逐集检查实际文件，全部达到1080P才能开始/);
    assert.match(ui.text(), /优先无损拼接，保留每段原分辨率/);
    assert.match(ui.text(), /必要时转为H\.264\/AAC，仍保留每段原分辨率/);
    assert.match(ui.text(), /三种方式都保留原文件，只合并已下载分集/);
    assert.match(ui.text(), /未下载的分集不会自动补齐/);
    assert.match(ui.text(), /保留原文件/);
    const high = ui.button('高质量分辨率合并');
    const quick = ui.button('智能快速合并');
    assert.ok(high);
    high.props.onClick();
    quick.props.onClick();
    ui.render();
    assert.equal(calls.length, 1, 'rapid mode clicks must submit once');
    assert.equal(calls[0][0], 'A');
    assert.equal(calls[0][1], '');
    assert.equal(calls[0][2].compatible, false);
    assert.equal(calls[0][2].require1080, true);
    assert.deepEqual(Object.keys(calls[0][2]).sort(), ['compatible', 'require1080']);
    assert.equal(ui.button('高质量分辨率合并').props.disabled, true);
    assert.equal(ui.button('兼容合并（H.264）').props.disabled, true);
    assert.equal(ui.button('智能快速合并').props.disabled, true);
    resolveHigh({
      success: false,
      code: 'MERGE_1080_UNAVAILABLE',
      error: '第2集实际为720P，请选择快速合并或兼容合并',
    });
    await ui.flush();
    assert.ok(ui.button('高质量分辨率合并'), '1080P failure must keep the merge dialog open');
    const alert = ui.find(node => node.props.role === 'alert' && ui.text().includes('第2集实际为720P'));
    assert.ok(alert, '1080P failure must be shown inline');
    assert.match(ui.text(), /未下载的分集不会自动补齐/);
    assert.match(ui.text(), /保留原文件/);
    await ui.button('智能快速合并').props.onClick();
    await ui.flush();
    assert.equal(ui.button('高质量分辨率合并'), undefined, 'successful merge must close the dialog');
    assert.equal(calls[1][2].compatible, false);
    assert.deepEqual(Object.keys(calls[1][2]), ['compatible']);
    ui.button('合并整部剧').props.onClick(); ui.render();
    assert.ok(!ui.text().includes('第2集实际为720P'), 'reopening must clear the old error');
    await ui.button('兼容合并（H.264）').props.onClick();
    await ui.flush();
    assert.equal(calls[2][2].compatible, true);
    assert.deepEqual(Object.keys(calls[2][2]), ['compatible']);
    assert.equal(ui.button('高质量分辨率合并'), undefined);

    ui.button('合并整部剧').props.onClick(); ui.render();
    ui.button('高质量分辨率合并').props.onClick(); ui.render();
    ui.button('取消').props.onClick(); ui.render();
    ui.button('合并中...').props.onClick(); ui.render();
    resolveHigh({
      success: false,
      code: 'MERGE_1080_UNAVAILABLE',
      error: '旧剧第2集实际为720P',
    });
    await ui.flush();
    assert.ok(ui.button('高质量分辨率合并'), 'late failure from a closed dialog must not close the new dialog');
    assert.ok(!ui.text().includes('旧剧第2集实际为720P'), 'late failure from a closed dialog must not leak into the new dialog');

    ui.button('高质量分辨率合并').props.onClick(); ui.render();
    ui.button('取消').props.onClick(); ui.render();
    ui.button('合并中...').props.onClick(); ui.render();
    resolveHigh({ success: true, count: 2, totalBytes: 1000 });
    await ui.flush();
    assert.ok(ui.button('高质量分辨率合并'), 'late success from a closed dialog must not close the new dialog');
    ui.unmount();
  });
  await test('task list pages at 100 while global totals and cross-page selections persist', async () => {
    const ui = mount({ getDownloadTasks: async () => Array.from({ length: 205 }, (_, i) => task(i + 1, 'completed')) }); await ui.flush();
    assert.equal(rows(ui).length, 100); assert.ok(ui.text().includes('已完成 205'));
    rows(ui)[0].props.onClick(); ui.render(); ui.button('下一页').props.onClick(); ui.render(); assert.equal(rows(ui).length, 100);
    rows(ui)[0].props.onClick(); ui.render(); ui.button('删除已选').props.onClick(); ui.render(); assert.ok(ui.text().includes('共 2 个任务'));
    ui.button('取消').props.onClick(); ui.render(); ui.button('下一页').props.onClick(); ui.render(); assert.equal(rows(ui).length, 5); ui.unmount();
  });
  for (const rejected of [false, true]) await test(`delete ${rejected ? 'rejection' : 'failure response'} is visible and preserves selection`, async () => {
    const ui = mount({ getDownloadTasks: async () => [task(1, 'completed')], deleteTasksWithFiles: async () => { if (rejected) throw new Error('删除失败示例'); return { success: false, error: '删除失败示例' }; } });
    await ui.flush(); rows(ui)[0].props.onClick(); ui.render(); ui.button('删除已选').props.onClick(); ui.render();
    await assert.doesNotReject(() => ui.button('仅删除记录').props.onClick(), 'delete rejection must become visible feedback'); await ui.flush();
    assert.ok(ui.text().includes('删除失败示例')); assert.ok(rows(ui)[0].props.className.includes('selected')); ui.unmount();
  });
  for (const deleteFiles of [false, true]) await test(`delete persistence failure shows actual released bytes and retained records: files=${deleteFiles}`, async () => {
    const ui = mount({ getDownloadTasks: async () => [task(1, 'completed')], deleteTasksWithFiles: async () => ({ success: false, count: 0, freed: deleteFiles ? 1024 : 0, failed: 0, error: '任务记录保存失败，原记录已保留' }) });
    try {
      await ui.flush(); rows(ui)[0].props.onClick(); ui.render(); ui.button('删除已选').props.onClick(); ui.render();
      if (deleteFiles) { ui.find(n => n.props.className === 'dm-confirm-check').children.find(n => n.type === 'input').props.onChange({ target: { checked: true } }); ui.render(); }
      await ui.button(deleteFiles ? '删除任务和文件' : '仅删除记录').props.onClick(); await ui.flush();
      assert.match(ui.text(), /已移除 0 个任务记录/);
      assert.ok(ui.text().includes(deleteFiles ? '已释放 1.0 KB' : '已释放 0 B'));
      assert.match(ui.text(), /任务记录保存失败，原记录已保留/);
      assert.ok(rows(ui)[0].props.className.includes('selected'));
    } finally { ui.unmount(); }
  });
  await test('merge cancellation only acknowledges the request and exposes failure', async () => {
    let fail = false;
    const ui = mount({ getMergeTasks: async () => [runningMerge()], cancelMerge: async () => fail ? { success: false, error: '取消请求失败' } : { success: true } }); await ui.flush();
    await ui.find(n => n.props.title === '取消合并').props.onClick(); await ui.flush();
    assert.ok(!ui.text().includes('已取消合并')); assert.ok(ui.text().includes('取消请求'));
    fail = true; await ui.find(n => n.props.title === '取消合并').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('取消请求失败')); ui.unmount();
  });
  await test('unknown merge duration does not claim zero minutes', async () => {
    const ui = mount({ getSeriesList: async () => [{ series_id: 'A', series_title: 'A' }], mergeSeries: async () => ({ success: true, count: 2, totalBytes: 100000, totalDuration: 0 }) }); await ui.flush();
    ui.button('合并整部剧').props.onClick(); ui.render(); await ui.button('智能快速合并').props.onClick(); await ui.flush();
    assert.ok(!ui.text().includes('0 分钟')); assert.ok(ui.text().includes('开始合并 2 集')); ui.unmount();
  });
  console.log(`Download manager: ${passed} passed, ${failures} failed`); process.exitCode = failures ? 1 : 0;
})();
