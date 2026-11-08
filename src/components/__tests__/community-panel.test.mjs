import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { formatMessage } from '../../i18n/translator.mjs';
const i18n = { t: formatMessage, useLanguage: () => 'zh-CN:zh-CN', getLanguage: () => 'zh-CN' };
import {transformSync} from 'esbuild';

const code=transformSync(fs.readFileSync(new URL('../CommunityPanel.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code;
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function harness(props,getPublicDetails,initialLibrary={items:[]}){
 let cursor=0,tree;const slots=[],effects=[];
 const react={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),useId:()=> 'community-fixture',useState(initial){const at=cursor++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;return[slots[at],value=>{slots[at]=typeof value==='function'?value(slots[at]):value;}];},useEffect(effect,deps){const at=cursor++,previous=slots[at];if(!previous||deps.some((value,index)=>value!==previous.deps[index])){previous?.cleanup?.();slots[at]={deps};effects.push(()=>slots[at].cleanup=effect());}}};
 const library={...initialLibrary,items:[...initialLibrary.items]};
 const module={exports:{}};
 const saveLocalSeries=patch=>{
  const previous=library.items.find(item=>item.id===patch.id);
  const next={id:String(patch.id),title:String(patch.title || previous?.title || ''),published_at:patch.published_at ?? previous?.published_at ?? null,
   favorite:typeof patch.favorite==='boolean'?patch.favorite:previous?.favorite??false,cover:patch.cover??previous?.cover??'',
   liked_episode_ids:Array.isArray(patch.liked_episode_ids)?[...new Set(patch.liked_episode_ids.map(String).filter(Boolean))]:previous?.liked_episode_ids||[]};
  library.items=[...library.items.filter(item=>item.id!==next.id),next];library.error='';
  return{...library,items:[...library.items]};
 };
 const require=id=>id==='../i18n'?i18n:id==='react'?react:id==='./CommunityPanel.css'?{}:id==='../localLibrary'?{readLocalLibrary:()=>library,saveLocalSeries,subscribeLocalLibrary:()=>()=>{},publicDateKey:value=>value||''}:undefined;
 vm.runInNewContext(code,{module,exports:module.exports,require,window:{electronAPI:{getPublicDetails}},navigator:{clipboard:{writeText:async()=>{}}}});
 const render=p=>{if(p)props=p;cursor=0;tree=module.exports.default(props);while(effects.length)effects.shift()();};
 const walk=(node,visit)=>{if(!node||typeof node!=='object')return;visit(node);node.children?.forEach(child=>walk(child,visit));};
 const findButton=label=>{let match;walk(tree,node=>{if(!match&&node.type==='button'&&node.children.includes(label))match=node;});return match;};
 const findButtons=label=>{const matches=[];walk(tree,node=>{if(node.type==='button'&&node.children.includes(label))matches.push(node);});return matches;};
 const texts=()=>{const values=[];walk(tree,node=>{for(const child of node.children||[])if(typeof child==='string'||typeof child==='number')values.push(String(child));});return values;};
 render();
 return{render,findButton,findButtons,texts,library,get props(){return props;}};
}

const details=(episodeContent,episodeReviews={total:156,items:[{author:'fixture',content:episodeContent,created_at:1762041600000}]})=>({success:true,published_at:1762041600,rating:8.6,rating_count:120,like_count:30,favorite_count:20,reviews:{total:2,items:[{author:'series',content:'整剧评论',created_at:1762041600000}]},episode_reviews:episodeReviews});

test('current episode comments open directly and stale episode results stay out of the new episode',async()=>{
 const requests=[];
 const ui=harness({seriesId:'12345678',episodeId:'7500000000000000011',title:'Fixture',cover:'',trailingAction:{type:'span',props:{className:'fixture-trailing'},children:['NAS trailing']}},
  (seriesId,episodeId)=>new Promise(resolve=>requests.push({seriesId,episodeId,resolve})));
 assert.ok(ui.findButton('查看公开剧评'));assert.ok(ui.findButton('收藏到本机'));assert.ok(ui.findButton('复制分享链接'));assert.ok(ui.texts().includes('NAS trailing'));
 ui.findButton('当前集评论').props.onClick();ui.render();await tick();
 assert.equal(requests.length,1);assert.equal(requests[0].seriesId,'12345678');assert.equal(requests[0].episodeId,'7500000000000000011');
 ui.render({...ui.props,episodeId:'7500000000000000022'});await tick();
 assert.equal(requests.length,2);assert.equal(requests[1].episodeId,'7500000000000000022');
 requests[1].resolve(details('第二十二集评论'));await tick();ui.render();
 assert.ok(ui.texts().includes('第二十二集评论'));assert.ok(ui.findButtons('当前集评论').some(button=>button.props['aria-pressed']));
 requests[0].resolve(details('第十一集旧评论'));await tick();ui.render();
 assert.equal(ui.texts().includes('第十一集旧评论'),false);
 ui.findButton('查看公开剧评').props.onClick();ui.render();
 assert.ok(ui.texts().includes('整剧评论'));assert.ok(ui.findButtons('整剧剧评').some(button=>button.props['aria-pressed']));
});

test('empty and partial episode comments are identified without inventing a complete list',async()=>{
 let resolveDetails;
 const ui=harness({seriesId:'12345678',episodeId:'7500000000000000033',title:'Fixture',cover:''},
  ()=>new Promise(resolve=>{resolveDetails=resolve;}));
 ui.findButton('当前集评论').props.onClick();ui.render();await tick();resolveDetails(details('唯一公开评论'));await tick();ui.render();
 assert.ok(ui.texts().some(text=>text.includes('本次展示 1 条公开评论')));assert.ok(ui.texts().some(text=>text.includes('公开总数 156')));
 assert.ok(ui.texts().some(text=>text.includes('更多评论可在红果 App 查看')));assert.equal(ui.texts().some(text=>text.includes('不提供完整翻页')),false);
 resolveDetails=null;
 const empty=harness({seriesId:'12345678',episodeId:'7500000000000000044',title:'Fixture',cover:''},
  ()=>new Promise(resolve=>{resolveDetails=resolve;}));
 empty.findButton('当前集评论').props.onClick();empty.render();await tick();resolveDetails(details('',null));await tick();empty.render();
 assert.ok(empty.texts().some(text=>text.includes('当前来源暂未提供单集评论')));assert.equal(empty.texts().some(text=>text.includes('未生成替代内容')),false);
 const noResults=harness({seriesId:'12345678',episodeId:'7500000000000000055',title:'Fixture',cover:''},
  ()=>new Promise(resolve=>{resolveDetails=resolve;}));
 noResults.findButton('当前集评论').props.onClick();noResults.render();await tick();resolveDetails(details('',{total:0,items:[]}));await tick();noResults.render();
 assert.ok(noResults.texts().some(text=>text.includes('本次未返回公开评论')));
});

test('episode hearts stay local per episode while comments and the whole-series favorite keep working',async()=>{
 const episode11='7500000000000000011',episode22='7500000000000000022';
 let resolveDetails;
 const ui=harness({seriesId:'12345678',episodeId:episode11,title:'Fixture',cover:''},
  ()=>new Promise(resolve=>{resolveDetails=resolve;}),{items:[{id:'12345678',title:'Fixture',published_at:null,favorite:true,cover:'',liked_episode_ids:[episode11]}]});
 assert.ok(ui.findButton('已点小红心（本机）').props['aria-pressed']);
 assert.ok(ui.findButton('已点小红心（本机）').children.some(child=>child?.props?.['aria-hidden']==='true'&&child.children.includes('♥')));
 ui.findButton('已点小红心（本机）').props.onClick();ui.render();
 assert.equal(ui.findButton('本集小红心（本机）').props['aria-pressed'],false);
 assert.ok(ui.findButton('本集小红心（本机）').children.some(child=>child?.props?.['aria-hidden']==='true'&&child.children.includes('♡')));
 assert.deepEqual(ui.library.items[0].liked_episode_ids,[]);assert.equal(ui.library.items[0].favorite,true);
 ui.findButton('本集小红心（本机）').props.onClick();ui.render();
 assert.ok(ui.findButton('已点小红心（本机）').props['aria-pressed']);
 ui.findButton('当前集评论').props.onClick();ui.render();await tick();resolveDetails(details('评论刷新'));await tick();ui.render();
 assert.deepEqual(ui.library.items[0].liked_episode_ids,[episode11]);assert.equal(ui.library.items[0].favorite,true);
 ui.findButton('已收藏到本机').props.onClick();ui.render();
 assert.equal(ui.library.items[0].favorite,false);assert.deepEqual(ui.library.items[0].liked_episode_ids,[episode11]);
 ui.render({...ui.props,episodeId:episode22});
 assert.ok(ui.findButton('本集小红心（本机）'));ui.findButton('本集小红心（本机）').props.onClick();ui.render();
 assert.deepEqual(new Set(ui.library.items[0].liked_episode_ids),new Set([episode11,episode22]));assert.ok(ui.findButton('收藏到本机'));
});

test('episode heart is disabled and unpressed without an episode id',()=>{
 const ui=harness({seriesId:'12345678',title:'Fixture',cover:''},async()=>details('unused'));
 const button=ui.findButton('本集小红心（本机）');
 assert.equal(button.props.disabled,true);assert.equal(button.props['aria-pressed'],false);
});
