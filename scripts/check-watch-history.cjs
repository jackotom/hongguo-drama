const assert = require('node:assert/strict');
const fs = require('node:fs');
const modulePath = require('node:path').join(__dirname, '../src/native/watch-history.js');
assert.ok(fs.existsSync(modulePath), '观看记录模块尚未实现');
const { listHistory, recordPlayback, applyEpisodeUpdate, findSequels, acknowledge } = require(modulePath);
const series = [
 { series_id:'1000001', series_title:'春日来信', total:12, episodes:Array.from({length:12},(_,i)=>({vid_index:i+1})) },
 { series_id:'1000002', series_title:'春日来信第二季', total:8, episodes:[] },
 { series_id:'1000003', series_title:'仅打开', total:10, episodes:[] },
];
const map = { '1000002': {vid_index:3,currentTime:12,updatedAt:100}, '1000003': {vid_index:1,currentTime:0,updatedAt:500} };
assert.deepEqual(listHistory(series,map).map(s=>s.series_id),['1000002']);
map['1000001']=recordPlayback(null,series[0],2,0,200);
assert.deepEqual(listHistory(series,map).map(s=>s.series_id),['1000001','1000002']);
assert.equal(listHistory(series,map)[0].vid_index,2);
assert.throws(()=>recordPlayback(null,series[0],2,Infinity),/进度/);
assert.throws(()=>recordPlayback(null,series[0],0,12),/进度/);
let updated=applyEpisodeUpdate(map['1000001'],series[0],{...series[0],total:14,episodes:Array.from({length:14},(_,i)=>({vid_index:i+1}))},300);
assert.equal(updated.unreadEpisodes,2);
updated=recordPlayback(updated, {...series[0],total:14},2,34,400);
assert.equal(updated.unreadEpisodes,2,'日常保存不能自动吞掉红点');
assert.equal(updated.knownTotal,14);
assert.equal(applyEpisodeUpdate(updated,series[0],{total:11,episodes:Array(11).fill({})},500).knownTotal,14);
const candidates=[{series_id:'1000002',series_title:'春日来信第二季'},{series_id:'1000004',series_title:'春日来信第三季'},{series_id:'1000005',series_title:'春日来信番外'},{series_id:'1000006',series_title:'春日来信之另一个故事'},{series_id:'xifan:1:7',series_title:'春日来信第二季'},{series_id:'javascript:alert(1)',series_title:'春日来信第二季'}];
assert.deepEqual(findSequels(series[0],candidates).map(s=>s.series_id),['1000002','1000004']);
assert.deepEqual(findSequels(series[1],candidates).map(s=>s.series_id),['1000004']);
assert.deepEqual(findSequels({...series[0],series_title:'春日来信第十二季'},[{series_id:'1000007',series_title:'春日来信第十三季'}]).map(s=>s.series_id),['1000007']);
updated.sequels=findSequels(series[0],candidates);
updated.seenSequelIds=[];
assert.equal(listHistory(series,{...map,'1000001':updated})[0].hasUpdates,true);
const read=acknowledge(updated);
assert.equal(read.unreadEpisodes,0);
assert.equal(read.acknowledgedTotal,14);
assert.deepEqual(read.seenSequelIds,['1000002','1000004']);
assert.equal(listHistory(series,{'1000001':read})[0].hasUpdates,false);
assert.equal(applyEpisodeUpdate(read,series[0],{total:14,episodes:Array(14).fill({})},600).unreadEpisodes,0);
assert.equal(applyEpisodeUpdate(read,series[0],{total:15,episodes:Array(15).fill({})},700).unreadEpisodes,1);
console.log('PASS watch history: watched-only, resume metadata, ordering, update baseline, sequel matching, acknowledgement');

const finalSeries = { series_id: 'last', total: 3, episodes: [] };
const complete = recordPlayback(null, finalSeries, 3, 100, 1000, { duration: 100, ended: true });
assert.equal(listHistory([finalSeries], { last: complete })[0].completed, true, '片尾事件应保存完成状态');
const replay = recordPlayback(complete, finalSeries, 1, 5, 1100, { duration: 100, ended: false });
assert.equal(listHistory([finalSeries], { last: replay })[0].completed, true, '重看不能丢失已看完状态');
assert.equal(listHistory([{ ...finalSeries, total: 4 }], { last: complete })[0].completed, false, '新增集应重新归入未看完');
const fourth = recordPlayback(complete, { ...finalSeries, total: 4 }, 4, 100, 1150, { duration: 100, ended: true });
const shorterReplay = recordPlayback(fourth, finalSeries, 3, 100, 1175, { duration: 100, ended: true });
assert.equal(listHistory([{ ...finalSeries, total: 4 }], { last: shorterReplay })[0].completed, true, '目录暂时缩短后重看片尾不能降低历史完成上限');
for (const metadata of [undefined, { duration: Infinity, ended: true }, { duration: 100, ended: false }, { duration: '100', ended: true }]) {
 const record = recordPlayback(null, finalSeries, 3, 100, 1200, metadata);
 assert.equal(listHistory([finalSeries], { last: record })[0].completed, false, '旧记录或无效片尾证据不能假定完成');
}
const early = recordPlayback(null, finalSeries, 3, 5, 1300, { duration: 100, ended: true });
assert.equal(listHistory([finalSeries], { last: early })[0].completed, false, '不在片尾不能标记完成');
console.log('PASS completion evidence: final episode end, replay persistence, new episodes, legacy and invalid metadata');

const { test } = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const historySource = transformSync(fs.readFileSync(require('node:path').join(__dirname, '../src/components/WatchHistory.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;

function mountHistory({ missing = false, playError = '', resolveError = '', locked = false, acknowledgeError = '' } = {}) {
 const slots = [], effects = [], calls = [], acknowledgements = [], refreshCalls = [], itemChecks = [];
 let cursor = 0, tree;
 const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
  useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
  useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((value, j) => !Object.is(value, slots[i][j]))) { slots[i] = deps; effects.push(fn); } },
 };
 react.useLayoutEffect = react.useEffect;
 const row = { series_id: 'A', series_title: '原剧', total: 9, vid_index: 3, hasUpdates: true, unreadEpisodes: 1, sequels: [{ series_id: 'B', series_title: '续作' }] };
 const api = {
  getWatchHistory: async () => ({ success: true, results: [row] }),
  playSeries: async payload => {
   calls.push(['play', JSON.parse(JSON.stringify(payload))]);
   if (playError) return { success: false, error: playError };
   if (missing) return { success: false, code: 'SERIES_NOT_FOUND', error: '档案已移除' };
   return { success: true };
  },
  searchResolve: async id => {
   calls.push(['resolve', id]);
   if (resolveError) return { success: false, error: resolveError };
   missing = false;
   return { success: true, data: { episodes: [{ vid_index: 1, locked: true }, { vid_index: 2, locked }] } };
  },
  acknowledgeWatchUpdates: async (...args) => {
   acknowledgements.push(JSON.parse(JSON.stringify(args)));
   return acknowledgeError ? { success: false, error: acknowledgeError } : { success: true };
  },
  refreshWatchHistory: async options => {
   refreshCalls.push(JSON.parse(JSON.stringify(options || {})));
   return { success: true, checked: 1, failed: 0, remaining: 0 };
  },
  checkWatchHistoryItem: async id => {
   itemChecks.push(id);
   return { success: true, checked: 1, failed: 0, status: 'checked' };
  },
  onWatchHistoryProgress: () => () => {},
 };
 const module = { exports: {} };
 vm.runInNewContext(historySource, { module, exports: module.exports, require: name => name === 'react' ? react : {}, window: { electronAPI: api } });
 const render = () => { cursor = 0; tree = module.exports.default({}); effects.splice(0).forEach(fn => fn()); };
 const find = predicate => { const visit = node => { if (!node || typeof node !== 'object') return; if (predicate(node)) return node; return node.children?.map(visit).find(Boolean); }; return visit(tree); };
 const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } };
 render();
 return { calls, acknowledgements, refreshCalls, itemChecks, find, flush, render,
  open: async () => { await flush(); await find(node => node.type === 'button' && node.children.includes('续作')).props.onClick(); await flush(); },
  error: () => find(node => node.props.role === 'alert')?.children[0]?.children[0] };
}

test('local sequel starts from the first playable episode without network or saved-position resume', async () => {
 const ui = mountHistory({ resolveError: 'offline' }); await ui.open();
 assert.deepEqual(ui.calls, [['play', { seriesId: 'B', vidIndex: 1 }]]);
 assert.deepEqual(ui.acknowledgements, [['A', { total: 9, sequelIds: ['B'] }]]);
 assert.equal(ui.error(), undefined);
 assert.equal(ui.find(node => node.props['aria-label'] === '有更新'), undefined);
});

test('missing sequel archive resolves once and starts the first unlocked episode', async () => {
 const ui = mountHistory({ missing: true }); await ui.open();
 assert.deepEqual(ui.calls, [['play', { seriesId: 'B', vidIndex: 1 }], ['resolve', 'B'], ['play', { seriesId: 'B', vidIndex: 2 }]]);
 assert.equal(ui.acknowledgements.length, 1); assert.equal(ui.error(), undefined);
});

test('sequel playback failure without the missing-archive code never resolves or acknowledges', async () => {
 const ui = mountHistory({ playError: '未找到短剧档案，请重新打开详情' }); await ui.open();
 assert.deepEqual(ui.calls, [['play', { seriesId: 'B', vidIndex: 1 }]]);
 assert.equal(ui.acknowledgements.length, 0); assert.ok(ui.error());
 assert.ok(ui.find(node => node.props['aria-label'] === '有更新'));
});

for (const options of [{ missing: true, resolveError: 'offline' }, { missing: true, locked: true }, { acknowledgeError: '保存失败' }]) test(`sequel failure retains unread updates: ${JSON.stringify(options)}`, async () => {
 const ui = mountHistory(options); await ui.open();
 assert.ok(ui.error()); assert.ok(ui.find(node => node.props['aria-label'] === '有更新'));
 if (!options.acknowledgeError) assert.equal(ui.acknowledgements.length, 0);
});

test('single-row detection calls the dedicated bridge and refreshes the row', async () => {
 const ui = mountHistory(); await ui.flush();
 const button = ui.find(node => node.props['aria-label'] === '检测《原剧》的更新');
 assert.ok(button);
 await button.props.onClick(); await ui.flush();
 assert.deepEqual(ui.itemChecks, ['A']);
 assert.match(ui.find(node => node.props.role === 'status')?.children?.join('') || '', /已检测完成/);
});

test('batch detection forwards the selected scope', async () => {
 const ui = mountHistory(); await ui.flush();
 const select = ui.find(node => node.type === 'select');
 select.props.onChange({ target: { value: 'latest' } }); ui.render();
 const button = ui.find(node => node.type === 'button' && node.children.includes('检查更新'));
 await button.props.onClick(); await ui.flush();
 assert.deepEqual(ui.refreshCalls, [{ scope: 'latest' }]);
});
