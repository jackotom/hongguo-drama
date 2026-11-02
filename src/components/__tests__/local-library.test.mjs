import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readLocalLibrary,saveLocalSeries} from '../../localLibrary.js';

const STORAGE_KEY='hongguo:public-library:v1';
const installStorage=(value,failWrites=false)=>{
 const values=new Map(value==null?[]:[[STORAGE_KEY,JSON.stringify(value)]]);
 const localStorage={getItem:key=>values.get(key)??null,setItem:(key,next)=>{if(failWrites)throw new Error('quota');values.set(key,next);}};
 globalThis.window={localStorage,dispatchEvent(){}};
 return{localStorage,values};
};

test('old series entries gain an empty episode heart list without losing existing series data',()=>{
 const old={id:'12345678',title:'Fixture',published_at:null,favorite:true,cover:'https://example.com/cover.jpg'};
 installStorage([old]);
 assert.deepEqual(readLocalLibrary(),{items:[{...old,liked_episode_ids:[]}],error:''});
 const saved=saveLocalSeries({id:'12345678',title:'Fixture',published_at:1762041600,liked_episode_ids:['7500000000000000011']});
 assert.equal(saved.error,'');assert.equal(saved.items[0].favorite,true);assert.equal(saved.items[0].cover,old.cover);
 assert.deepEqual(saved.items[0].liked_episode_ids,['7500000000000000011']);
 const refreshed=saveLocalSeries({id:'12345678',title:'Fixture',cover:'',favorite:undefined,liked_episode_ids:undefined});
 assert.equal(refreshed.items[0].favorite,true);assert.deepEqual(refreshed.items[0].liked_episode_ids,['7500000000000000011']);
 const unliked=saveLocalSeries({id:'12345678',title:'Fixture',liked_episode_ids:[]});
 assert.deepEqual(unliked.items[0].liked_episode_ids,[]);
});

test('storage failure keeps the previous episode heart state and reports the error',()=>{
 const original={id:'12345678',title:'Fixture',published_at:null,favorite:false,cover:'',liked_episode_ids:['7500000000000000011']};
 const {values}=installStorage([original],true);
 const before=values.get(STORAGE_KEY);
 const result=saveLocalSeries({id:'12345678',title:'Fixture',liked_episode_ids:[]});
 assert.match(result.error,/未能保存到本机/);assert.deepEqual(result.items[0].liked_episode_ids,original.liked_episode_ids);
 assert.equal(values.get(STORAGE_KEY),before);
});
