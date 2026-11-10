const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('../../node_modules/esbuild');
const publicPlayer = require('./public-player-fixture.cjs');

const root = path.resolve(__dirname,'..');
function buildPage(actualPublic=false) { return esbuild.build({entryPoints:[path.join(root,'web/app.js')],bundle:true,format:'cjs',platform:'browser',write:false,logLevel:'silent',
  plugins:[{name:'controlled-page-dependencies',setup(build){
    build.onLoad({filter:/web\/app\.js$/},args=>({contents:fs.readFileSync(args.path,'utf8')+'\nexport {play,stop,state};',resolveDir:path.dirname(args.path)}));
    if (!actualPublic) build.onLoad({filter:/web\/media\.js$/},()=>({contents:'export const prepareMedia=(...args)=>globalThis.prepare(...args);export const prepareTvMedia=(sid,vid,signal,progress)=>globalThis.prepare(vid,\"auto\",signal,progress,true);'}));
    if (!actualPublic) build.onLoad({filter:/web\/public\.js$/},()=>({contents:'export const website=()=>new Promise(()=>{});export const readRouter=()=>({});export const parseDetail=()=>({});'}));
    build.onLoad({filter:/native\/hongguo-app-(catalog|search)\.js$/},()=>({contents:'export const browseList=()=>{};export const searchApp=()=>{};'}));
    if(actualPublic){
      build.onLoad({filter:/native\/app-source\.js$/},()=>({contents:'export async function fetchAppPlayUrl(){throw Object.assign(new Error(\"model timeout\"),{code:\"ETIMEDOUT\"});}'}));
      build.onResolve({filter:/^android-decrypt$/},()=>({path:'decoder',namespace:'unused'}));
      build.onLoad({filter:/.*/,namespace:'unused'},()=>({contents:'export function decryptMp4Buffer(){throw Error(\"unexpected decoder\");}'}));
    }
  }}]}); }
const build=buildPage(); let publicBuild;
const media = id => ({token:`token-${id}`,url:`blob:${id}`,codec:'h264',quality:'1080p',bytes:16});
const detail = {series_id:'123',series_title:'fixture',cover:'',episodes:[{vid:'111'},{vid:'222'}]};

async function page({callbacks=true,history=[],actualPublic=false}={}) {
  const nodes=new Map(),timers=new Map(),events=new Map(),windowEvents=new Map(),preparations=[],videos=[],deleted=[],revoked=[],awake=[],sweeps=[],network=[],cancelled=[];
  const stored=new Map([['history',JSON.stringify(history)]]); let timer=0;
  class Element {
    constructor(){this.dataset={};this.children=[];this.classList={toggle(){}};this.value='1';}
    set innerHTML(value){this.html=value;this.firstElementChild=new Element();this.children=[];}
    get innerHTML(){return this.html;}
    querySelector(selector){if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);}
    querySelectorAll(){return [];}
    setAttribute(){}
    replaceChildren(...children){this.children=children;for(const c of children)c.parentElement=this;}
    append(...children){this.children.push(...children);}
    remove(){this.removed=true;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(c=>c!==this);}
  }
  class Video extends Element {
    constructor(){super();this.paused=true;this.ended=false;this.readyState=0;this.videoWidth=0;this.videoHeight=0;this.currentTime=0;this.duration=100;this.frames=new Map();this.frameId=0;this.playCalls=0;if(!callbacks)this.requestVideoFrameCallback=undefined;}
    emit(name){this['on'+name]?.();}
    play(){this.playCalls++;this.paused=false;this.emit('play');return Promise.resolve();}
    pause(){if(!this.paused){this.paused=true;this.emit('pause');}}
    load(){this.loaded=true;}
    removeAttribute(name){if(name==='src')this.src='';}
    requestVideoFrameCallback(fn){const id=++this.frameId;this.frames.set(id,fn);return id;}
    cancelVideoFrameCallback(id){this.frames.delete(id);}
    frame(valid=true){this.readyState=2;this.videoWidth=valid?720:0;this.videoHeight=valid?1280:0;const entry=this.frames.entries().next().value;assert(entry,'frame callback must be registered');this.frames.delete(entry[0]);entry[1](0,{});}
    metadata(){this.readyState=1;this.emit('loadedmetadata');}
  }
  const content=new Element();nodes.set('#content',content);
  const document={hidden:false,querySelector:s=>content.querySelector(s),querySelectorAll:()=>[],addEventListener:(e,fn)=>events.set(e,fn),createElement(tag){const el=tag==='video'?new Video():new Element();if(tag==='video')videos.push(el);return el;}};
  class MediaURL extends URL {}
  MediaURL.revokeObjectURL=url=>revoked.push(url);let blobId=0;MediaURL.createObjectURL=()=>`blob:actual-${++blobId}`;
  const context={module:{exports:{}},document,URL:MediaURL,Blob,AbortController,Date,console:{info(){}},
    localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},
    setTimeout(fn,ms){const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    prepare(vid,quality,signal,progress,playback){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});preparations.push({vid,quality,signal,progress,playback,resolve,reject});return promise;},
    Native:{awake:value=>awake.push(value),clearMedia(){sweeps.push(preparations.every(p=>p.signal.aborted));},deleteMedia:token=>deleted.push(token),mediaSize:()=>16,readMedia:()=>Buffer.alloc(16).toString('base64'),request(id,raw){network.push({id,...JSON.parse(raw)});},cancel:id=>cancelled.push(id)},
    addEventListener:(e,fn)=>windowEvents.set(e,fn),scrollTo(){},
  };context.window=context;
  vm.runInNewContext((await (actualPublic?(publicBuild ||= buildPage(true)):build)).outputFiles[0].text,context);
  const api=context.module.exports;api.state.detail=detail;
  return {api,context,document,preparations,videos,deleted,revoked,awake,sweeps,timers,network,cancelled,respond:(id,response)=>context.__nativeResponse(id,JSON.stringify(response)),stage:()=>nodes.get('#stage'),
    history:()=>JSON.parse(stored.get('history')),hide(){document.hidden=true;events.get('visibilitychange')();},show(){document.hidden=false;events.get('visibilitychange')();},exit:()=>windowEvents.get('pagehide')(),
    runTimer(ms){const entry=[...timers].find(([,v])=>v.ms===ms);assert(entry,`timer ${ms} must exist`);timers.delete(entry[0]);entry[1].fn();}};
}

test('TV waits for a valid frame, saves the old episode and carries manual pause across selection',async()=>{
  const h=await page({history:[{series_id:'123',episode:0,position:35}]});
  const first=h.api.play(0);h.preparations[0].resolve(media('one'));await first;
  const v=h.videos[0];assert.equal(h.stage().dataset.playbackState,'decoding');v.metadata();
  assert.equal(v.currentTime,35);assert.equal(h.awake.includes(true),false);
  v.frame(false);assert.equal(h.stage().dataset.playbackState,'decoding');
  v.frame();assert.equal(h.stage().dataset.playbackState,'playing');assert.equal(v.dataset.vid,'111');
  v.currentTime=42;v.pause();assert.equal(h.history()[0].position,42);
  const next=h.api.play(1);assert(h.preparations[0].signal.aborted);assert.equal(v.onpause,null);assert.equal(v.src,'');assert(v.removed);
  assert.deepEqual(h.deleted,['token-one']);assert.deepEqual(h.revoked,['blob:one']);assert.equal(h.history()[0].episode,0);
  h.preparations[1].resolve(media('two'));await next;const v2=h.videos[1];v2.metadata();assert.equal(v2.playCalls,0);
  v2.frame();assert.equal(h.stage().dataset.playbackState,'paused');v2.play();assert.equal(h.stage().dataset.playbackState,'playing');
  h.exit();assert.equal(v2.onended,null);assert.equal(h.timers.size,0);assert(h.sweeps.every(Boolean),'abort must precede the native cache sweep');
});

test('TV discards late preparation, old events and frame callbacks without touching the new episode',async()=>{
  const h=await page();const old=h.api.play(0),current=h.api.play(1);
  h.preparations[0].progress('downloading',{received:50,total:100});assert(!h.stage().firstElementChild.textContent?.includes('50%'));
  h.preparations[0].resolve(media('stale'));await old;assert.equal(h.videos.length,0);
  assert.deepEqual(h.deleted,['token-stale']);assert.deepEqual(h.revoked,['blob:stale']);
  h.preparations[1].resolve(media('current'));await current;const v=h.videos[0],oldError=v.onerror,oldFrame=[...v.frames.values()][0];
  const newer=h.api.play(0);assert.equal(v.frames.size,0);oldError();oldFrame();
  h.preparations[2].resolve(media('newer'));await newer;
  assert.equal(h.stage().dataset.vid,'111');assert.equal(h.stage().dataset.playbackState,'decoding');
  assert.equal(h.videos[1].src,'blob:newer');h.exit();
});

test('TV background/native pause during preparation does not autoplay after foregrounding',async()=>{
  const h=await page();const pending=h.api.play(0);h.context.pausePlayback();h.hide();
  h.preparations[0].resolve(media('hidden'));await pending;const v=h.videos[0];v.metadata();h.show();
  assert.equal(v.playCalls,0);v.frame();assert.equal(h.stage().dataset.playbackState,'paused');
  v.play();assert.equal(h.stage().dataset.playbackState,'playing');h.hide();h.show();
  assert.equal(v.paused,true);assert.equal(v.playCalls,1);assert.equal(h.awake.at(-1),false);h.exit();
});

test('TV decode failure/frame deadline retains saved progress and releases all owned resources',async()=>{
  const h=await page({history:[{series_id:'123',episode:0,position:35}]});
  const pending=h.api.play(0);h.preparations[0].resolve(media('broken'));await pending;
  const v=h.videos[0];v.metadata();v.currentTime=0;h.runTimer(12000);
  assert.equal(h.stage().dataset.playbackState,'error');assert.equal(h.history()[0].position,35);
  assert.equal(h.timers.size,0);assert.equal(v.frames.size,0);assert.equal(v.onerror,null);
  assert.deepEqual(h.revoked,['blob:broken']);assert.deepEqual(h.deleted,['token-broken']);
  const retry=h.api.play(0);h.preparations[1].resolve(media('retry'));await retry;h.videos[1].metadata();assert.equal(h.videos[1].currentTime,35);h.exit();
});

test('TV fallback requires current frame data; page exit saves current progress and disposes listeners',async()=>{
  const h=await page({callbacks:false});const pending=h.api.play(0);h.preparations[0].resolve(media('fallback'));await pending;
  const v=h.videos[0];v.metadata();v.emit('loadeddata');assert.equal(h.stage().dataset.playbackState,'decoding');
  v.readyState=2;v.videoWidth=720;v.videoHeight=1280;v.emit('loadeddata');assert.equal(h.stage().dataset.playbackState,'playing');
  v.currentTime=43;h.exit();assert.equal(h.history()[0].position,43);assert.equal(v.onloadedmetadata,null);assert.equal(h.awake.at(-1),false);
  const late=h.api.play(1);h.exit();h.preparations[1].resolve(media('after-exit'));await late;
  assert.equal(h.videos.length,1);assert(h.deleted.includes('token-after-exit'));
});

test('TV bounds src-to-metadata silence on RVFC and fallback without resetting the deadline',async()=>{
  for(const callbacks of [true,false]){
    const h=await page({callbacks,history:[{series_id:'123',episode:0,position:35}]});
    const first=h.api.play(0);h.preparations[0].resolve(media('silent'));await first;
    assert([...h.timers.values()].some(t=>t.ms===12000),'decode deadline must exist before metadata/play/error');
    const oldDeadline=[...h.timers.values()].find(t=>t.ms===12000).fn;
    h.runTimer(12000);assert.equal(h.stage().dataset.playbackState,'error');assert.equal(h.history()[0].position,35);
    assert.deepEqual(h.revoked,['blob:silent']);assert.deepEqual(h.deleted,['token-silent']);assert.equal(h.timers.size,0);
    const next=h.api.play(0);h.preparations[1].resolve(media('retry'));await next;oldDeadline();
    assert.equal(h.stage().dataset.playbackState,'decoding');
    const before=[...h.timers].find(([,t])=>t.ms===12000)[0];h.videos[1].metadata();
    assert.equal([...h.timers].find(([,t])=>t.ms===12000)[0],before,'metadata/play must not renew the original decode deadline');h.exit();
  }
});

test('TV metadata-silent decode wait pauses for background/manual intent and rearms on explicit play',async()=>{
  for(const callbacks of [true,false]){
    const h=await page({callbacks});const pending=h.api.play(0);h.preparations[0].resolve(media('paused'));await pending;
    const cancelledDeadline=[...h.timers.values()].find(t=>t.ms===12000).fn;
    h.context.pausePlayback();h.hide();h.show();cancelledDeadline();
    assert.equal(h.stage().dataset.playbackState,'decoding','a cancelled deadline must not fail a manually paused session');
    assert(![...h.timers.values()].some(t=>t.ms===12000));
    assert.equal(h.videos[0].playCalls,0);h.videos[0].play();
    assert([...h.timers.values()].some(t=>t.ms===12000),'explicit play without metadata must get a new decode deadline');
    h.runTimer(12000);assert.equal(h.stage().dataset.playbackState,'error');assert.equal(h.timers.size,0);
  }
});

test('TV cancels the actual public fallback on selection and ignores its late HTML',async()=>{
  const h=await page({actualPublic:true}),flush=()=>new Promise(resolve=>setImmediate(resolve));
  const old=h.api.play(0);await flush();
  const first=h.network.find(r=>r.url==='https://hongguoduanju.com/player/123/111');assert(first,'old public request must start');
  const current=h.api.play(1);await flush();assert(h.cancelled.includes(first.id));
  const second=h.network.find(r=>r.url==='https://hongguoduanju.com/player/123/222');assert(second);
  h.respond(first.id,{status:200,headers:{},data:publicPlayer()});await flush();assert.equal(h.network.filter(r=>r.media).length,0);
  h.respond(second.id,{status:200,headers:{},data:publicPlayer('222')});await flush();
  const download=h.network.find(r=>r.media);assert(download);assert.equal(download.url,'https://hongguoduanju.com/video/public/222/full.mp4');
  h.respond(download.id,{status:200,token:'12345678-1234-1234-1234-123456789abc.mp4',bytes:16});await current;await old;
  assert.equal(h.videos.length,1);assert.equal(h.stage().dataset.vid,'222');assert.equal(h.videos[0].dataset.vid,'222');h.exit();
});
