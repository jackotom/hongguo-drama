const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { listHistory, recordPlayback, applyEpisodeUpdate, acknowledge } = require('../src/native/watch-history');

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
  const acknowledgedSnapshots = [];
  let delayedRemove = false, pendingRemove, removeError = '';
  let playError = '', failedAcknowledgement = '';
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
    playSeries: async payload => { plays.push({ ...payload }); return playError ? { success: false, error: playError } : { success: true }; },
    acknowledgeWatchUpdates: async (id, snapshot) => {
      acknowledgements.push(id); acknowledgedSnapshots.push({ id, snapshot });
      return id === failedAcknowledgement ? { success: false, error: 'fixture acknowledgement failure' } : { success: true };
    },
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
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: name => name === '../i18n' ? { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {}, getLanguage: () => 'zh-CN' } : name === './historyGroups.mjs' ? require('../src/components/historyGroups.mjs') : name === 'react' ? react : name === './icons' ? { Play: Icon, RefreshCw: Icon, Clock: Icon } : {},
    localStorage,
    window: { electronAPI: api, localStorage },
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
    failPlay: error => { playError = error; },
    failAcknowledgement: id => { failedAcknowledgement = id; },
    resolveRemove: result => { pendingRemove(result); pendingRemove = null; },
    pendingLoad: index => pendingLoads[index],
    triggerUpdated: () => onUpdated(),
    checkedRequests,
    removals,
    plays, acknowledgements, acknowledgedSnapshots,
    loadCount: () => loadCount,
  };
}

const text = node => {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children?.map(text).join('') || '';
};
const button = (ui, label) => ui.find(node => node.type === 'button' && text(node) === label);
const findIn = (node, predicate) => predicate(node) ? node : node?.children?.map(child => findIn(child, predicate)).find(Boolean);

(async () => {
  let currentRows = historyRows();
  const ui = mount(() => currentRows);
  await ui.flush();

  const names = () => {
    const result = [];
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (node.props?.className === 'history-name') result.push(text(node).replace(/^已看完 · /, ''));
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
  assert.ok(ui.find(node => node.type === 'label' && text(node).includes('折叠同剧低季')));
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

  // #131: watch time wins over scan time, update badges and season numbers.
  let priorityRows = [
    { series_id: '1000200', series_title: '最近无更新', updatedAt: 500, completed: false },
    { series_id: '1000211', series_title: '旧剧第一季', family: 'old', season: 1, updatedAt: 400, completed: false, unreadEpisodes: 1 },
    { series_id: '1000213', series_title: '旧剧第三季', family: 'old', season: 3, updatedAt: 300, completed: true,
      sequels: [{ series_id: '1000214', series_title: '旧剧第四季' }], unreadSequelIds: ['1000214'] },
    { series_id: '1000220', series_title: '更旧的续作提醒', updatedAt: 200, completed: false,
      sequels: [{ series_id: '1000221', series_title: '未来续作' }], unreadSequelIds: ['1000221'] },
    { series_id: '1000230', series_title: '仅相似提示', updatedAt: 100, completed: false,
      similarSeries: [{ series_id: '1000231', series_title: '相近标题' }] },
  ].map(row => ({ total: 1, vid_index: 1, ...row }));
  const priorityUi = mount(() => priorityRows);
  await priorityUi.flush();
  const priorityOrder = () => priorityUi.find(node => node.props.className === 'history-list').children
    .filter(node => node?.type === 'li').map(node => node.props.key);
  const priorityRow = id => priorityUi.find(node => node.type === 'li' && node.props.key === id);
  assert.deepEqual(priorityOrder(), ['1000200', '1000211', '1000213', '1000220', '1000230'],
    'all records follow recent watch time, including a recently rewatched lower season');
  assert.ok(!priorityRow('1000211').props.className.includes('history-child'), 'the most recently watched visible member leads the group');
  assert.ok(priorityRow('1000213').props.className.includes('history-child'));
  assert.ok(text(priorityRow('1000211')).includes('旧剧第四季'), 'the chronological head inherits the higher season\'s sequel hints');
  assert.ok(!text(priorityRow('1000213')).includes('旧剧第四季'), 'group hints are not duplicated on children');
  assert.ok(findIn(priorityRow('1000211'), node => node?.props?.className === 'history-dot'), 'a rewatched low season retains its new-episode dot');
  assert.ok(!findIn(priorityRow('1000213'), node => node?.props?.className === 'history-dot'), 'an external sequel dot moves to the chronological head');
  assert.match(text(priorityUi.find(node => node.props.className === 'history-container')), /最近观看时间/);
  assert.ok(!text(priorityUi.find(node => node.props.className === 'history-container')).includes('有更新的组优先显示'));
  priorityUi.find(node => node.type === 'input').props.onChange({ target: { checked: true } });
  await priorityUi.flush();
  assert.deepEqual(priorityOrder(), ['1000200', '1000213', '1000220', '1000230'],
    'folding still shows the highest season, ordered by its own watch time');
  assert.ok(text(priorityRow('1000213')).includes('旧剧第四季'), 'a folded head retains external sequel hints');
  assert.ok(findIn(priorityRow('1000213'), node => node?.props?.className === 'history-dot'), 'folding keeps the external sequel dot visible');
  button(priorityUi, '展开组').props.onClick();
  await priorityUi.flush();
  assert.deepEqual(priorityOrder(), ['1000200', '1000211', '1000213', '1000220', '1000230'], 'expanding restores chronological order');
  button(priorityUi, '未看完 4').props.onClick();
  await priorityUi.flush();
  assert.deepEqual(priorityOrder(), ['1000200', '1000211', '1000220', '1000230'], 'unfinished records keep chronological order');
  assert.ok(text(priorityRow('1000211')).includes('旧剧第四季'), 'a filtered higher season still contributes group hints');
  button(priorityUi, '已看完 1').props.onClick();
  await priorityUi.flush();
  assert.deepEqual(priorityOrder(), ['1000213']);
  assert.ok(!priorityRow('1000213').props.className.includes('history-child'), 'completed filtering promotes its first visible group member');
  button(priorityUi, '全部 5').props.onClick();
  await priorityUi.flush();
  // Use the actual update reducer: scans may discover episodes but cannot become watches.
  priorityRows = priorityRows.map(row => {
    const series = { total: row.total };
    const record = recordPlayback(null, series, row.vid_index, 12, row.updatedAt);
    const scanned = applyEpisodeUpdate(record, series, { total: row.total + 1 }, 1_000_000);
    assert.equal(scanned.updatedAt, record.updatedAt);
    return { ...row, updatedAt: scanned.updatedAt, lastCheckedAt: scanned.lastCheckedAt, unreadEpisodes: scanned.unreadEpisodes };
  }).reverse();
  priorityUi.triggerUpdated();
  await priorityUi.flush();
  assert.deepEqual(priorityOrder(), ['1000200', '1000211', '1000213', '1000220', '1000230'],
    'an update event with shuffled results and newer scan times must not reorder watching history');
  priorityRows = priorityRows.map(row => ({ ...row, unreadEpisodes: 0, unreadSequelIds: [] }));
  priorityUi.triggerUpdated();
  await priorityUi.flush();
  assert.deepEqual(priorityOrder(), ['1000200', '1000211', '1000213', '1000220', '1000230'], 'clearing update markers also preserves watch order');
  assert.deepEqual(priorityUi.acknowledgements, [], 'sorting must never mark updates as read');
  assert.deepEqual(priorityUi.removals, [], 'sorting and filtering must never remove history');

  priorityRows = priorityRows.map(row => row.series_id === '1000213' ? { ...row, updatedAt: 600, unreadSequelIds: ['1000214'] } : row);
  priorityUi.triggerUpdated();
  await priorityUi.flush();
  assert.deepEqual(priorityOrder(), ['1000213', '1000211', '1000200', '1000220', '1000230'],
    '#137: the most recently watched group leads, with its seasons contiguous instead of indented under an unrelated drama');
  assert.ok(text(priorityRow('1000213')).includes('旧剧第四季'), 'new-season watching transfers group hints to its new chronological head');
  assert.ok(!text(priorityRow('1000211')).includes('旧剧第四季'));

  priorityRows = priorityRows.map(row => row.series_id === '1000211' ? { ...row, updatedAt: 700 } : row);
  priorityUi.triggerUpdated();
  await priorityUi.flush();
  assert.deepEqual(priorityOrder(), ['1000211', '1000213', '1000200', '1000220', '1000230'],
    'rewatching a lower season promotes its group while preserving the seasons together');
  await findIn(priorityRow('1000211'), node => node?.props?.className === 'history-resume').props.onClick();
  await priorityUi.flush();
  assert.deepEqual(priorityUi.acknowledgements, ['1000213', '1000211'], 'continuing a lower chronological head acknowledges the sequel hints it displays');
  assert.equal(priorityUi.acknowledgedSnapshots.find(item => item.id === '1000213').snapshot.total, 0,
    'continuing the lower head does not acknowledge another season\'s episode updates');

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

  button(similarUi, '确认《AAA2BBB》为同剧').props.onClick();
  await similarUi.flush();
  assert.ok(!button(similarUi, '确认《AAA2BBB》为同剧'), 'confirmed group members must not retain confirmation buttons');
  assert.ok(!similarUi.find(node => node.type === 'span' && text(node) === '疑似同剧（仅提示）'), 'confirmed group members must not retain suspected-match labels');
  assert.ok(button(similarUi, '展开组'));
  assert.ok(!similarUi.find(node => node.type === 'button' && /[展开折叠]+ \d+ 季/.test(text(node))));

  const groupStorage = new Map([['hongguo:history-groups', JSON.stringify({ '1': '3', '2': '3' })]]);
  const groupRows = [1, 2, 3].map(id => ({ series_id: String(id), series_title: `手动剧${id}`, family: `family${id}`, season: id, updatedAt: id, total: 1, vid_index: 1, completed: true }));
  groupRows.push({ series_id: '4', series_title: '原本不在手动组内', family: 'family2', season: 1, updatedAt: 4 });
  const groupedUi = mount(() => groupRows, groupStorage);
  await groupedUi.flush();
  const groupHead = groupedUi.find(node => node.type === 'li' && text(node).includes('手动剧3'));
  assert.ok(findIn(groupHead, node => node?.props?.className === 'history-time' && text(node).includes('已看完')), 'completion belongs beside the recent-watch time');
  assert.ok(!findIn(groupHead, node => node?.props?.className === 'history-name' && text(node).includes('已看完')));
  findIn(groupHead, node => node?.type === 'button' && text(node) === '独立显示').props.onClick();
  await groupedUi.flush();
  const { groupHistory } = require('../src/components/historyGroups.mjs');
  const regrouped = groupHistory(groupRows, JSON.parse(groupStorage.get('hongguo:history-groups')));
  assert.deepEqual(regrouped.map(items => items.map(row => row.series_id)), [['2', '1'], ['3'], ['4']], 'remaining manual members stay grouped without pulling in automatic-family outsiders');
  const restartedGroup = mount(() => groupRows, groupStorage);
  await restartedGroup.flush();
  assert.ok(button(restartedGroup, '恢复自动分组'), 'an independent row can restore automatic grouping after restart');
  assert.ok(restartedGroup.find(node => node.type === 'span' && text(node) === '独立显示 · 手动'));

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

  // #97: the origin of an external sequel may have its own unread episodes.
  const originSequel = { series_id: '1000113', series_title: '春日回声第三季' };
  const laterSequel = { series_id: '1000114', series_title: '春日回声第四季' };
  const originSeries = [
    { series_id: '1000111', series_title: '春日回声', total: 11 },
    { series_id: '1000112', series_title: '春日回声第二季', total: 10 },
  ];
  const originPlayback = {
    '1000111': { watched: true, vid_index: 10, currentTime: 1, updatedAt: 99, knownTotal: 11, acknowledgedTotal: 10, unreadEpisodes: 1, sequels: [originSequel, laterSequel] },
    '1000112': { watched: true, vid_index: 1, currentTime: 1, updatedAt: 100, knownTotal: 10, acknowledgedTotal: 10 },
  };
  const originUi = mount(() => listHistory(originSeries, originPlayback));
  await originUi.flush();
  const originRow = () => originUi.find(node => node.type === 'li' && node.props.key === '1000111');
  assert.ok(originRow().props.className.includes('history-child'), 'A is the sequel origin while B leads the group');
  await button(originUi, originSequel.series_title).props.onClick();
  await originUi.flush();
  assert.deepEqual(originUi.plays, [{ seriesId: originSequel.series_id, vidIndex: 1 }], 'only C is played, never its origin A');
  const originSnapshot = originUi.acknowledgedSnapshots.find(item => item.id === '1000111').snapshot;
  assert.equal(originSnapshot.total, 0, 'playing a sequel must not acknowledge its origin\'s episode total');
  assert.deepEqual(Array.from(originSnapshot.sequelIds), [originSequel.series_id], 'only the selected sequel ID is acknowledged');
  const originAfterSequel = acknowledge(originPlayback['1000111'], originSnapshot);
  assert.equal(originAfterSequel.acknowledgedTotal, 10, 'the persisted origin episode baseline must not advance');
  assert.equal(originAfterSequel.unreadEpisodes, 1, 'the origin\'s real new episode must remain unread');
  assert.deepEqual(originAfterSequel.seenSequelIds, [originSequel.series_id]);
  assert.ok(findIn(originRow(), node => node?.props?.className === 'history-dot'), 'the origin retains its episode dot locally');
  assert.ok(findIn(originRow(), node => node?.props?.className === 'history-update' && text(node) === '新增 1 集'));
  await originUi.find(node => node.props['aria-label']?.startsWith('继续观看 春日回声 第')).props.onClick();
  await originUi.flush();
  assert.deepEqual(originUi.plays.at(-1), { seriesId: '1000111', vidIndex: 10, resume: true });
  const resumedOriginSnapshot = originUi.acknowledgedSnapshots.at(-1).snapshot;
  assert.equal(resumedOriginSnapshot.total, 11, 'actually resuming A acknowledges A\'s visible episode total');
  assert.equal(acknowledge(originAfterSequel, resumedOriginSnapshot).unreadEpisodes, 0);
  assert.ok(!findIn(originRow(), node => node?.props?.className === 'history-dot'), 'actually resuming A clears its local episode dot');

  // #97: automatic and manual children can retain external candidates and old sequel-only dots.
  const groupedSeries = [
    { series_id: '1000101', series_title: '春风来信', total: 1 },
    { series_id: '1000102', series_title: '春风来信第二季', total: 1 },
    { series_id: '1000103', series_title: '春风来信第三季', total: 1 },
  ];
  const externalSequel = { series_id: '1000104', series_title: '春风来信第四季' };
  const fuzzy = { series_id: '1000105', series_title: '春风来信二' };
  const groupedPlayback = Object.fromEntries(groupedSeries.map((item, index) => [item.series_id, {
    watched: true, vid_index: 1, currentTime: 1, updatedAt: 100 + index,
    completedEpisode: 1, knownTotal: 1, acknowledgedTotal: 1,
    sequels: [...groupedSeries.slice(index + 1), externalSequel],
    seenSequelIds: [externalSequel.series_id], similarSeries: [fuzzy],
  }]));
  let updateRows = listHistory(groupedSeries, groupedPlayback);
  assert.deepEqual(updateRows.find(row => row.series_id === '1000101').unreadSequelIds, [], 'already watched seasons must not remain unread sequel candidates');
  const updateStorage = new Map([[preferencesKey, JSON.stringify({ scope: 'skip-completed-low', hideLowSeasons: false })]]);
  const updateUi = mount(() => updateRows, updateStorage);
  await updateUi.flush();
  const historyRow = id => updateUi.find(node => node.type === 'li' && node.props.key === id);
  const hasDot = row => !!findIn(row, node => node?.props?.className === 'history-dot');
  const hasHints = row => !!findIn(row, node => node?.props?.className === 'history-sequels');
  assert.equal(hasDot(historyRow('1000101')), false, 'hidden internal sequel candidates must not leave a child dot');
  assert.equal(hasDot(historyRow('1000102')), false);
  assert.equal(hasDot(historyRow('1000103')), false, 'a seen external sequel must not inherit an internal candidate dot');
  assert.equal(hasHints(historyRow('1000101')), false, 'children must not repeat external sequel or fuzzy suggestions');
  assert.equal(hasHints(historyRow('1000102')), false);
  assert.equal(hasHints(historyRow('1000103')), true, 'the group head retains deduplicated external suggestions');
  assert.ok(findIn(historyRow('1000103'), node => node?.type === 'button' && text(node) === fuzzy.series_title));
  assert.match(text(updateUi.find(node => node.props.className === 'history-container')), /批量检测范围.*不.*清除.*红点/);
  assert.deepEqual(updateUi.acknowledgements, [], 'display grouping must never write acknowledgements');

  groupedPlayback['1000101'].seenSequelIds = [];
  groupedPlayback['1000102'].seenSequelIds = [];
  groupedPlayback['1000102'].unreadEpisodes = 1;
  groupedPlayback['1000102'].knownTotal = 2;
  updateRows = listHistory(groupedSeries, groupedPlayback);
  updateUi.triggerUpdated();
  await updateUi.flush();
  assert.equal(hasDot(historyRow('1000101')), false, 'external sequel updates belong to the group head');
  assert.equal(hasDot(historyRow('1000102')), true, 'real new episodes must retain the child dot');
  assert.equal(hasDot(historyRow('1000103')), true, 'an unread external sequel from a child must surface on the head');
  button(updateUi, '未看完 1').props.onClick();
  await updateUi.flush();
  assert.equal(historyRow('1000103'), undefined, 'the progress filter can hide the original group head');
  assert.equal(hasHints(historyRow('1000102')), true, 'the first visible member must keep the aggregated suggestions');
  assert.ok(!historyRow('1000102').props.className.includes('history-child'), 'a filtered group still needs a visible head');
  button(updateUi, '全部 3').props.onClick();
  await updateUi.flush();
  await button(updateUi, fuzzy.series_title).props.onClick();
  await updateUi.flush();
  assert.deepEqual(updateUi.acknowledgements, [], 'opening an aggregated fuzzy suggestion must not acknowledge updates');
  await button(updateUi, externalSequel.series_title).props.onClick();
  await updateUi.flush();
  assert.deepEqual(updateUi.plays.at(-1), { seriesId: externalSequel.series_id, vidIndex: 1 });
  assert.deepEqual([...updateUi.acknowledgements].sort(), ['1000101', '1000102', '1000103'], 'opening a group sequel must clear its duplicate unread state in each member');
  const childSnapshot = updateUi.acknowledgedSnapshots.find(item => item.id === '1000102').snapshot;
  assert.equal(acknowledge(groupedPlayback['1000102'], childSnapshot).unreadEpisodes, 1, 'the real acknowledgement reducer must preserve other members\' episode updates');
  assert.equal(hasDot(historyRow('1000103')), false, 'the group dot must clear after opening the sequel');
  assert.equal(hasDot(historyRow('1000102')), true, 'acknowledging another member\'s sequel must retain its episode update');

  const continuedUi = mount(() => updateRows);
  await continuedUi.flush();
  await continuedUi.find(node => node.props['aria-label']?.startsWith('继续观看 春风来信第三季 ')).props.onClick();
  await continuedUi.flush();
  assert.deepEqual([...continuedUi.acknowledgements].sort(), ['1000101', '1000102', '1000103'], 'continuing the visible head acknowledges the group sequel hints it displays');
  const continuedHead = continuedUi.find(node => node.type === 'li' && node.props.key === '1000103');
  assert.equal(hasDot(continuedHead), false, 'a group dot cannot remain stuck on updates owned by hidden children');
  const continuedChild = continuedUi.acknowledgedSnapshots.find(item => item.id === '1000102').snapshot;
  assert.equal(acknowledge(groupedPlayback['1000102'], continuedChild).unreadEpisodes, 1, 'continuing the head does not mark a different season\'s episodes read');

  const failedGroupUi = mount(() => updateRows);
  await failedGroupUi.flush();
  failedGroupUi.failPlay('fixture group playback failure');
  await button(failedGroupUi, externalSequel.series_title).props.onClick();
  await failedGroupUi.flush();
  assert.deepEqual(failedGroupUi.acknowledgements, [], 'failed group playback must not acknowledge any member');
  assert.equal(hasDot(failedGroupUi.find(node => node.type === 'li' && node.props.key === '1000103')), true);
  failedGroupUi.failPlay('');
  failedGroupUi.failAcknowledgement('1000101');
  await button(failedGroupUi, externalSequel.series_title).props.onClick();
  await failedGroupUi.flush();
  assert.match(text(failedGroupUi.find(node => node.props.role === 'alert')), /fixture acknowledgement failure/);
  assert.equal(hasDot(failedGroupUi.find(node => node.type === 'li' && node.props.key === '1000103')), true, 'a partial acknowledgement failure must retain the unacknowledged group dot');

  const manualStorage = new Map([['hongguo:history-groups', JSON.stringify({ '1000101': '1000103', '1000102': '1000103' })]]);
  const manualUi = mount(() => updateRows.map(row => ({ ...row, family: row.series_id })), manualStorage);
  await manualUi.flush();
  assert.ok(!manualUi.find(node => node.type === 'li' && node.props.className.includes('history-child') && hasHints(node)), 'manual children share the same suggestion policy');
  button(updateUi, '折叠组').props.onClick();
  await updateUi.flush();
  assert.equal(historyRow('1000101'), undefined, 'folding still hides lower seasons');
  button(updateUi, '展开组').props.onClick();
  await updateUi.flush();
  assert.equal(hasHints(historyRow('1000101')), false, 'expanding must not bring duplicate hints back');
  const storedBeforeRestore = JSON.parse(updateStorage.get(preferencesKey));
  assert.equal(storedBeforeRestore.scope, 'skip-completed-low', 'group actions must preserve the detection scope');

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

  console.log('PASS watch history display: #137 contiguous seasons; #131 recent groups, scans and lower-season rewatch; #97 group hints/dots, filtered heads, acknowledgement and failure safety; low-season hiding, filters, preferences, removal and stale loads');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
