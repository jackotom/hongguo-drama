import {test} from 'node:test';import assert from 'node:assert/strict';import {groupHistory} from '../historyGroups.mjs';
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
