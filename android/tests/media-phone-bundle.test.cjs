const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const esbuild=require('../../node_modules/esbuild');
const bundles=require('./media-bundle-fixture.cjs');

test('both production bundle entries resolve one explicit decoder; phone keeps the shared exports',async()=>{
  const b=bundles();
  assert.equal(b.tv.alias['android-decrypt'],path.join(b.root,'build/decrypt.js'));
  assert.equal(b.phone.alias['android-decrypt'],path.join(b.root,'build/mobile-decrypt.js'));
  for(const [base,entry,expected,forbidden] of [
    [b.tv,'web/tv.js','build/decrypt.js','build/mobile-decrypt.js'],
    [b.phone,'mobile/media.js','build/mobile-decrypt.js','build/decrypt.js'],
  ]){
    const result=await esbuild.build(b.options(base,{entryPoints:[path.join(b.root,entry)]}));
    const inputs=Object.keys(result.metafile.inputs);
    assert(inputs.some(p=>p.endsWith(expected)),'expected decoder must be in the actual dependency graph');
    assert(!inputs.some(p=>p.endsWith(forbidden)),'other decoder must not leak into this bundle');
    assert(inputs.some(p=>p.endsWith('web/media.js')),'both apps consume the shared preparation module');
    assert(inputs.some(p=>p.endsWith('web/timers.cjs')),'browser bundles must preserve cancellable source pacing');
  }
  for(const [base,name] of [[b.tv,'decrypt.js'],[b.phone,'mobile-decrypt.js']]){
    const compiled=await esbuild.build(b.options(base,{entryPoints:[path.join(b.root,'build',name)],format:'cjs'}));
    const context={module:{exports:{}},Native:{crypt(decrypt,algorithm,key,iv,padding,data){
      const cipher=(decrypt?crypto.createDecipheriv:crypto.createCipheriv)(algorithm,Buffer.from(key,'base64'),iv?Buffer.from(iv,'base64'):null);
      cipher.setAutoPadding(padding);return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('base64');
    }}};
    vm.runInNewContext(compiled.outputFiles[0].text,context);
    const key=crypto.randomBytes(16),nonce=crypto.randomBytes(8),plain=Buffer.from('fixture CTR vector');
    const cipher=crypto.createCipheriv('aes-128-ctr',key,Buffer.concat([nonce,Buffer.alloc(8)]));
    const encoded=Buffer.concat([cipher.update(plain),cipher.final()]);
    assert.deepEqual(Buffer.from(context.module.exports.decryptSample(key,nonce,encoded)),plain);
    assert.throws(()=>context.module.exports.decryptMp4Buffer(Buffer.alloc(4),key),/大小/);
  }
});

test('phone bridge still uses shared preparation for online play/release and a persisted download',{timeout:5000},async()=>{
  const b=bundles(),deleted=[],revoked=[],persisted=[],sent=[],progress=[];
  const tokens=['12345678-1234-1234-1234-123456789abc.mp4','22345678-1234-1234-1234-123456789abc.mp4'];
  const initial={series:[{series_id:'123',series_title:'fixture',episodes:[{vid:'111',vid_index:1}],total:1}],tasks:[],settings:{},playback:{}};
  let saved=JSON.stringify(initial),url=0;
  class MediaURL extends URL {}
  MediaURL.createObjectURL=()=>`blob:phone-${++url}`;MediaURL.revokeObjectURL=value=>revoked.push(value);
  const context={module:{exports:{}},URL:MediaURL,Blob,crypto:crypto.webcrypto,AbortController,AbortSignal,setTimeout,clearTimeout,console:{info(){}},
    document:{addEventListener(){},querySelectorAll:()=>[]},localStorage:{getItem:()=>null,setItem(){}},
    Native:{readState:()=>saved,writeState:v=>{saved=v;},mediaSize:()=>16,readMedia:()=>Buffer.alloc(16).toString('base64'),
      deleteMedia:token=>deleted.push(token),persistMedia:token=>persisted.push(token),awake(){},
      random:n=>crypto.randomBytes(n).toString('base64'),cancel(){},
      request(id,raw){sent.push(JSON.parse(raw));queueMicrotask(()=>context.__nativeResponse(id,JSON.stringify({status:200,token:tokens[sent.length-1],bytes:16})));}},
  };context.window=context;
  const result=await esbuild.build(b.options(b.phone,{entryPoints:[path.join(b.root,'mobile/bridge.js')],format:'cjs',plugins:[{name:'controlled-app-source',setup(build){
    build.onLoad({filter:/native\/app-source\.js$/},()=>({contents:'export async function fetchAppPlayUrl(vid,options){if(options.signal.aborted)throw Error("cancelled");return {url:"https://fixture.qznovelvod.com/episode",codec:"h264",quality:"1080p",source:"app"};} export function signedSearchRequest(){} export function signedMetadataRequest(){} export function signedAccountRequest(){} export function parseSearchInteger(v){return Number(v);} export function preserveLargeJsonIntegers(v){return v;} export function requestJson(){} export const SEARCH_API="",SEARCH_UA="";'}));
  }}]}));
  vm.runInNewContext(result.outputFiles[0].text,context);
  const api=context.module.exports.api;
  api.onOnlinePlayProgress(value=>progress.push(value));
  const online=await api.prepareOnlinePlay({seriesId:'123',vid:'111',vidIndex:1,quality:'1080p',requestId:'one'});
  assert.equal(online.success,true);assert.equal(online.url,'blob:phone-1');assert.equal(online.token,tokens[0]);
  assert(progress.some(p=>p.phase==='downloading'&&p.requestId==='one'));
  await api.releaseOnlinePlay({requestId:'one'});assert.deepEqual(deleted,[tokens[0]]);assert.deepEqual(revoked,['blob:phone-1']);
  let completed;const done=new Promise(resolve=>{completed=resolve;});api.onDownloadCompleted(completed);
  const enqueued=await api.downloadSingleEpisode('123',1,'1080p');assert.equal(enqueued.success,true,enqueued.error);await done;
  assert.deepEqual(persisted,[tokens[1]]);assert.equal(JSON.parse(saved).tasks[0].status,'completed');
  assert.equal(sent.length,2);assert(sent.every(request=>request.headers.Referer===undefined));
});
