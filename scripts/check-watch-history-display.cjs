const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { listHistory } = require('../src/native/watch-history');

const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/components/WatchHistory.jsx'), 'utf8'), {
  loader: 'jsx',
  format: 'cjs',
}).code;

function historyRows(removedId = '') {
  const fixtures = [
    { series_id: '1000001', series_title: '春日来信', completed: true },
    { series_id: '1000002', series_title: '春日来信第二季', completed: false },
    { series_id: 'xifan:fixture:7', series_title: '春日来信第三季', completed: true },
    { series_id: 'hema:9', series_title: '只有一季', completed: false },
    { series_id: '1000005', series_title: '无季号记录', completed: true },
    { series_id: '1000006', series_title: '年轮（2024）', completed: false },
    { series_id: 'unsupported:1', series_title: '未知来源第二季', completed: false },
    { series_id: '1000008', series_title: '无法归族第零季', completed: false },
  ].filter(item => item.series_id !== removedId);
  const series = fixtures.map(({ completed, ...item }) => ({ ...item, total: 20, episodes: [] }));
  const playback = Object.fromEntries(series.map((item, index) => [item.series_id, {
    watched: true, vid_index: 1, currentTime: 12, updatedAt: 10_000 - index,
    completedEpisode: fixtures[index].completed ? 20 : 0,
  }]));
  return listHistory(series, playback);
}

function mount(rows, storage = new Map()) {
  let cursor = 0, tree, loadCount = 0, onUpdated, checkedRequests = [], removals = [], plays = [], acknowledgements = [];
  let delayedRemove = false, pendingRemove, removeError = '';
  const slots = [], effects = [], pendingLoads = [];
  let delayedLoads = false;
  const Icon = props => ({ type: 'icon', props, children: [] });
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef: initial => {
      const index = cursor++;
      return slots[index] ||= { current: initial };
    },
    useEffect: (effect, dependencies) => {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, dependencyIndex) => !Object.is(value, previous[dependencyIndex]))) {
        slots[index] = dependencies;
        effects.push(effect);
      }
    },
  };
  react.useLayoutEffect = react.useEffect;
  const api = {
    getWatchHistory: () => {
      loadCount++;
      if (!delayedLoads) return Promise.resolve({ success: true, results: rows() });
      return new Promise(resolve => pendingLoads.push(resolve));
    },
    refreshWatchHistory: async options => {
      checkedRequests.push({ ...options });
      return { success: true, checked: 1, failed: 0, remaining: 0 };
    },
    checkWatchHistoryItem: async () => ({ success: true, checked: 0 }),
    playSeries: async payload => { plays.push({ ...payload }); return { success: true }; },
    acknowledgeWatchUpdates: async id => { acknowledgements.push(id); return { success: true }; },
    removeWatchHistory: id => {
      removals.push(id);
      const result = removeError ? { success: false, error: removeError } : { success: true };
      if (!delayedRemove) return Promise.resolve(result);
      return new Promise(resolve => { pendingRemove = resolve; });
    },
    onWatchHistoryUpdated: listener => { onUpdated = listener; return () => {}; },
    onWatchHistoryProgress: () => () => {},
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: name => name === 'react' ? react : name === './icons' ? { Play: Icon, RefreshCw: Icon, Clock: Icon } : {},
    window: { electronAPI: api, localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    } },
  });
  const render = () => {
    cursor = 0;
    tree = module.exports.default({ active: true });
    effects.splice(0).forEach(effect => effect());
  };
  const nodes = () => {
    const result = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      result.push(node);
      node.children?.forEach(visit);
    };
    visit(tree);
    return result;
  };
  const find = predicate => nodes().find(predicate);
  const flush = async () => {
    for (let index = 0; index < 20; index++) {
      await Promise.resolve();
      render();
    }
  };
  render();
  return {
    find, flush,
    enableDelayedLoads: () => { delayedLoads = true; },
    enableDelayedRemove: () => { delayedRemove = true; },
    failRemove: error => { removeError = error; },
    resolveRemove: result => { pendingRemove(result); pendingRemove = null; },
    pendingLoad: index => pendingLoads[index],
    triggerUpdated: () => onUpdated(),
    checkedRequests,
    removals,
    plays, acknowledgements,
    loadCount: () => loadCount,
  };
}

const text = node => {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children?.map(text).join('') || '';
};
const button = (ui, label) => ui.find(node => node.type === 'button' && text(node) === label);

(async () => {
  let currentRows = historyRows();
  const ui = mount(() => currentRows);
  await ui.flush();

  const names = () => {
    const result = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (node.props?.className === 'history-name') result.push(text(node));
      node.children?.forEach(visit);
    };
    visit(ui.find(node => node.props?.className === 'history-list'));
    return result;
  };

  assert.equal(names().length, 8, 'all seasons must be visible by default');
  assert.equal(currentRows.find(row => row.series_id === '1000001').hasHigherSeason, true);
  assert.equal(currentRows.find(row => row.series_id === '1000002').hasHigherSeason, false);
  assert.equal(currentRows.find(row => row.series_id === 'unsupported:1').hasHigherSeason, false);
  assert.equal(currentRows.find(row => row.series_id === '1000008').hasHigherSeason, false);
  assert.ok(button(ui, '全部 8'));
  assert.ok(button(ui, '未看完 5'));
  assert.ok(button(ui, '已看完 3'));

  const scope = ui.find(node => node.type === 'select');
  scope.props.onChange({ target: { value: 'skip-completed-low' } });
  await ui.flush();
  const display = ui.find(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.ok(display, 'list display needs a native keyboard-operable checkbox');
  assert.notEqual(display.props.tabIndex, -1);
  assert.ok(ui.find(node => node.type === 'label' && text(node).includes('隐藏同剧低季')));
  display.props.onChange({ target: { checked: true } });
  await ui.flush();

  assert.deepEqual(names(), [
    '春日来信第二季',
    '春日来信第三季',
    '只有一季',
    '无季号记录',
    '年轮（2024）',
    '未知来源第二季',
    '无法归族第零季',
  ], 'hide only lower seasons in the same source family; keep singletons and unfamilied rows');
  assert.ok(button(ui, '全部 7'));
  assert.ok(button(ui, '未看完 5'));
  assert.ok(button(ui, '已看完 2'));
  assert.deepEqual(ui.checkedRequests, [], 'changing the view must not run update checks');
  assert.deepEqual(ui.removals, [], 'changing the view must not remove records');

  const preferencesKey = 'hongguo:watch-history-preferences';
  const storage = new Map();
  const savedUi = mount(() => historyRows(), storage);
  await savedUi.flush();
  savedUi.find(node => node.type === 'select').props.onChange({ target: { value: 'latest' } });
  await savedUi.flush();
  savedUi.find(node => node.type === 'input').props.onChange({ target: { checked: true } });
  await savedUi.flush();
  const restartedUi = mount(() => historyRows(), storage);
  await restartedUi.flush();
  assert.equal(restartedUi.find(node => node.type === 'select').props.value, 'latest', 'detection scope must survive a fresh page instance');
  assert.equal(restartedUi.find(node => node.type === 'input').props.checked, true, 'hide-low-seasons must survive a fresh page instance');
  button(restartedUi, '检查更新').props.onClick();
  await restartedUi.flush();
  assert.deepEqual(restartedUi.checkedRequests, [{ scope: 'latest' }], 'the restored scope must reach the update request');
  restartedUi.find(node => node.type === 'input').props.onChange({ target: { checked: false } });
  await restartedUi.flush();
  const shownUi = mount(() => historyRows(), storage);
  await shownUi.flush();
  assert.equal(shownUi.find(node => node.type === 'input').props.checked, false, 'unchecking must also persist');
  for (const stored of ['broken json', 'null', JSON.stringify({ scope: 'unknown', hideLowSeasons: 'true' })]) {
    const invalidUi = mount(() => historyRows(), new Map([[preferencesKey, stored]]));
    await invalidUi.flush();
    assert.equal(invalidUi.find(node => node.type === 'select').props.value, 'all');
    assert.equal(invalidUi.find(node => node.type === 'input').props.checked, false);
  }
  const blockedUi = mount(() => historyRows(), {
    get() { throw new Error('storage unavailable'); },
    set() { throw new Error('storage unavailable'); },
  });
  await blockedUi.flush();
  blockedUi.find(node => node.type === 'input').props.onChange({ target: { checked: true } });
  await blockedUi.flush();
  assert.equal(blockedUi.find(node => node.type === 'input').props.checked, true, 'storage failures must not block the current selection');
  assert.match(text(blockedUi.find(node => node.props.role === 'status')), /未能保存/);

  const similarSeries = [
    { series_id: '1000091', series_title: 'AAA1BBB', total: 1 },
    { series_id: '1000092', series_title: 'AAA2BBB', total: 1 },
  ];
  const similarRows = listHistory(similarSeries, Object.fromEntries(similarSeries.map(item => [item.series_id, {
    watched: true, vid_index: 1, currentTime: 1, updatedAt: 100,
  }])));
  const similarUi = mount(() => similarRows);
  await similarUi.flush();
  similarUi.find(node => node.type === 'input').props.onChange({ target: { checked: true } });
  await similarUi.flush();
  assert.ok(button(similarUi, '全部 2'), 'fuzzy matches must remain visible when low seasons are hidden');
  assert.ok(similarUi.find(node => node.type === 'span' && text(node) === '疑似同剧（仅提示）'));
  assert.ok(similarUi.find(node => node.type === 'button' && text(node) === 'AAA2BBB'), 'the suspected title must be available for inspection');
  await button(similarUi, 'AAA2BBB').props.onClick();
  await similarUi.flush();
  assert.deepEqual(similarUi.plays, [{ seriesId: '1000092', vidIndex: 1 }]);
  assert.deepEqual(similarUi.acknowledgements, [], 'opening an unconfirmed match must not acknowledge the original series');

  const promoted = { series_id: '1000093', series_title: 'AAA1BBB第二季' };
  const promotedRows = listHistory([similarSeries[0]], { '1000091': {
    watched: true, vid_index: 1, currentTime: 1, updatedAt: 100,
    sequels: [promoted], similarSeries: [{ ...promoted, series_title: 'AAA1BBB二' }],
  } });
  assert.deepEqual(promotedRows[0].similarSeries, [], 'previously confirmed IDs must not retain stale fuzzy labels');
  const promotedUi = mount(() => promotedRows);
  await promotedUi.flush();
  await button(promotedUi, promoted.series_title).props.onClick();
  await promotedUi.flush();
  assert.deepEqual(promotedUi.acknowledgements, ['1000091'], 'opening the promoted confirmed sequel must acknowledge its original series');

  button(ui, '未看完 5').props.onClick();
  await ui.flush();
  assert.equal(names().length, 5, 'progress filter must combine with the season display option');

  ui.enableDelayedLoads();
  currentRows = historyRows().map(row => ({ ...row, completed: true }));
  ui.triggerUpdated();
  button(ui, '检查更新').props.onClick();
  await ui.flush();
  assert.equal(ui.loadCount(), 3, 'refresh and live update should each issue a list load');
  assert.deepEqual(ui.checkedRequests, [{ scope: 'skip-completed-low' }], 'the detection scope must stay independent of display mode');

  ui.pendingLoad(1)({ success: true, results: currentRows });
  await ui.flush();
  ui.pendingLoad(0)({ success: true, results: historyRows() });
  await ui.flush();

  assert.ok(ui.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked));
  assert.ok(ui.find(node => node.type === 'h2' && text(node) === '最高季里没有未看完的短剧'),
    'combined filters need a specific empty state');
  button(ui, '查看全部').props.onClick();
  await ui.flush();
  assert.equal(names().length, 7, 'the latest list must replace a stale late response');
  assert.ok(ui.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked),
    'late loading and empty-state recovery must preserve the display choice');

  const afterRemovalRows = historyRows('1000002');
  assert.equal(afterRemovalRows.find(row => row.series_id === '1000002'), undefined);
  assert.equal(afterRemovalRows.find(row => row.series_id === '1000001').hasHigherSeason, false,
    'native recomputation must promote the remaining low season');
  const staleAfterRemovalRows = [...afterRemovalRows, historyRows().find(row => row.series_id === '1000002')];
  currentRows = afterRemovalRows;
  ui.enableDelayedRemove();
  const removeLatest = ui.find(node => node.props['aria-label'] === '移除观看记录《春日来信第二季》');
  assert.ok(removeLatest);
  removeLatest.props.onClick();
  ui.triggerUpdated();
  await ui.flush();
  assert.equal(ui.loadCount(), 4, 'the pre-removal update event starts a load');
  assert.equal(ui.pendingLoad(2) instanceof Function, true);

  ui.resolveRemove({ success: true });
  await ui.flush();
  assert.equal(ui.loadCount(), 5, 'successful removal must start a fresh authoritative load');
  ui.pendingLoad(3)({ success: true, results: afterRemovalRows });
  await ui.flush();
  ui.pendingLoad(2)({ success: true, results: staleAfterRemovalRows });
  await ui.flush();

  assert.deepEqual(names().slice(0, 3), ['春日来信', '春日来信第三季', '只有一季'],
    'the promoted low season must reappear and the removed highest season must stay gone');
  assert.ok(!names().includes('春日来信第二季'));
  assert.ok(button(ui, '全部 7'));
  assert.ok(ui.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked));
  assert.deepEqual(ui.checkedRequests, [{ scope: 'skip-completed-low' }],
    'removal reloads must not alter the bulk-check scope');

  const failedRows = historyRows();
  const failedUi = mount(() => failedRows);
  await failedUi.flush();
  failedUi.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  await failedUi.flush();
  failedUi.failRemove('fixture remove failure');
  failedUi.find(node => node.props['aria-label'] === '移除观看记录《春日来信第二季》').props.onClick();
  await failedUi.flush();
  assert.ok(failedUi.find(node => node.props['aria-label'] === '移除观看记录《春日来信第二季》'),
    'a failed removal must retain the target row');
  assert.match(text(failedUi.find(node => node.props.role === 'alert')), /fixture remove failure/);
  assert.equal(failedUi.loadCount(), 1, 'a failed removal must not invalidate the visible list');

  const reloadFailedRows = historyRows();
  const reloadFailedUi = mount(() => reloadFailedRows);
  await reloadFailedUi.flush();
  reloadFailedUi.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  await reloadFailedUi.flush();
  reloadFailedUi.enableDelayedLoads();
  reloadFailedUi.enableDelayedRemove();
  reloadFailedUi.find(node => node.props['aria-label'] === '移除观看记录《春日来信第二季》').props.onClick();
  reloadFailedUi.resolveRemove({ success: true });
  await reloadFailedUi.flush();
  assert.equal(reloadFailedUi.loadCount(), 2, 'successful removal always requests a fresh list');
  reloadFailedUi.pendingLoad(0)({ success: false, error: 'fixture reload failure' });
  await reloadFailedUi.flush();
  assert.match(text(reloadFailedUi.find(node => node.props.role === 'alert')), /fixture reload failure/);
  assert.ok(!reloadFailedUi.find(node => node.props['aria-label'] === '移除观看记录《春日来信第二季》'),
    'a reload error must not resurrect the removed row');

  console.log('PASS watch history display: low-season hiding, combined filters, accessibility, scope isolation, counts, empty state, removal recomputation, and stale-load handling');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
