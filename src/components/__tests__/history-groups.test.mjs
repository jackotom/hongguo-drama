import {test} from 'node:test';import assert from 'node:assert/strict';import {groupHistory, historyGroupSuggestions} from '../historyGroups.mjs';
test('highest known season leads a family; explicit manual exclusions survive regrouping',()=>{
 const rows=[{series_id:'1',family:'a',season:1,updatedAt:2},{series_id:'2',family:'a',season:2,updatedAt:1},{series_id:'3',family:'b',season:1,updatedAt:3}];
 assert.deepEqual(groupHistory(rows).map(g=>g.map(r=>r.series_id)),[['2','1'],['3']]);
 assert.equal(groupHistory(rows,{'1':null}).length,3);
 assert.equal(groupHistory(rows,{'3':'2'}).length,1);
 assert.equal(groupHistory(rows,{'3':'missing'}).length,2);
});
test('missing manual targets fall back to exact families; stored decisions cannot combine sources',()=>{
 const rows=[{series_id:'1',family:'a',season:1,updatedAt:2},{series_id:'2',family:'a',season:2,updatedAt:1},{series_id:'hema:3',family:'hema:b',season:1,updatedAt:3}];
 assert.deepEqual(groupHistory(rows,{'1':'removed'}).map(g=>g.map(r=>r.series_id)),[['2','1'],['hema:3']]);
 assert.equal(groupHistory(rows,{'hema:3':'2'}).length,2);
});
test('automatic and manual groups stay within each provider',()=>{
 for (const kind of ['xifan','custom']) {
  const rows=[{series_id:`${kind}:a:1`,family:'same',season:1},{series_id:`${kind}:b:2`,family:'same',season:2}];
  assert.equal(groupHistory(rows).length,2);
  assert.equal(groupHistory(rows,{[rows[0].series_id]:rows[1].series_id}).length,2);
 }
});

test('group suggestions omit members and deduplicate external titles without losing their origin', () => {
 const first = { series_id: '1', sequels: [{ series_id: '2' }, { series_id: '3', series_title: '新季' }], unreadSequelIds: ['2', '3'] };
 const second = { series_id: '2', sequels: [{ series_id: '3', series_title: '新季旧名' }], unreadSequelIds: ['3'], similarSeries: [{ series_id: '1' }, { series_id: '3' }, { series_id: '4', series_title: '相近剧' }] };
 const state = historyGroupSuggestions([first, second]);
 assert.deepEqual(state.sequels.map(item => item.series_id), ['3']);
 assert.equal(state.sequels[0].origin, first);
 assert.deepEqual(state.similarSeries.map(item => item.series_id), ['4']);
 assert.equal(state.similarSeries[0].origin, second);
 assert.equal(state.hasUnreadSequels, true);
});

test('only unread external sequels create a group sequel dot; fuzzy and internal matches never do', () => {
 const first = { series_id: '1', sequels: [{ series_id: '2' }, { series_id: '3' }], unreadSequelIds: ['2'], hasUpdates: true };
 const second = { series_id: '2', similarSeries: [{ series_id: '4' }], unreadEpisodes: 1, hasUpdates: true };
 assert.equal(historyGroupSuggestions([first, second]).hasUnreadSequels, false);
 assert.equal(historyGroupSuggestions([first]).hasUnreadSequels, true, 'independent display restores external relationships');
 assert.equal(first.hasUpdates, true, 'group display must not modify stored update state');
 assert.equal(second.unreadEpisodes, 1, 'real episode updates remain on their own row');
});
