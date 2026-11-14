const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
const source = path.resolve(__dirname,'../main.js'), req = createRequire(source), root=fs.mkdtempSync(path.join(os.tmpdir(),'hongguo-custom-main-'));
const id='a066a170-46e7-47aa-9c87-6364d8483e87', sid=`custom:${id}:1`, vid=`${sid}:0:0`;
const settings={root,custom_sources:[{id,name:'Fixture',url:'https://fixture.example/api',enabled:true}]};
let failSave=false, remuxes=0, cancelled=0;
const handlers={},protocols={}, app=new EventEmitter();
Object.assign(app,{getVersion:()=> 'test',getPath:()=>root,requestSingleInstanceLock:()=>true,commandLine:{appendSwitch(){}},whenReady:()=>({then(){}})});
const custom={validateSource:d=>({...d}),assertEnabled:()=>{if(!settings.custom_sources.some(s=>s.id===id&&s.enabled))throw new Error('播放源已禁用');},cancelRequests:()=>cancelled++,testCustomSource:async()=>({success:true,count:1}),fetchCatalog:async()=>({success:true,results:[]}),searchSeries:async()=>({success:true,results:[]})};
const native={fetchPlayUrlSingle:async()=>{custom.assertEnabled();return{url:'https://fixture.example/media.m3u8',source:'custom',format:'hls',vid};}};
const context=vm.createContext({require:n=>n==='electron'?{app,ipcMain:{handle:(n,f)=>handlers[n]=f},protocol:{registerSchemesAsPrivileged(){},handle:(n,f)=>protocols[n]=f}}:n==='./src/store'?{getSettings:()=>settings,saveTasks(){},saveSettings:next=>{if(failSave)throw new Error('disk full');Object.assign(settings,next);}}:n==='./src/native/custom-source'?custom:n==='./src/native/hongguo'?native:n==='./src/native/hls-media'?{remuxHls:async({url,output,checkAccess,onProgress})=>{checkAccess();if(url.includes('/bad'))throw new Error('bad HLS candidate');remuxes++;onProgress?.(200000);fs.writeFileSync(output,Buffer.alloc(200000,7));}}:req(n),__dirname:path.dirname(source),process,Buffer,URL,Response,Request,Headers,AbortController,setTimeout,clearTimeout,console:{log(){},warn(){},error(){}}});
vm.runInContext(fs.readFileSync(source,'utf8'),context);const run=s=>vm.runInContext(s,context); const realRequestMedia=context.requestMedia;
require('./fixtures/trusted-ipc.cjs')(context, handlers);
(async()=>{
  assert.equal(typeof handlers['get-custom-sources'],'function','custom source IPC must exist');
  assert.equal((await handlers['get-media-sources']()).sources.at(-1).id,`custom:${id}`);
  failSave=true; assert.equal((await handlers['save-custom-source']({}, {...settings.custom_sources[0],enabled:false})).success,false); assert.equal(settings.custom_sources[0].enabled,true); assert.equal(cancelled,0); failSave=false;
  // Synthetic HLS bytes; real decoding is covered by check-download-quality-integration.cjs.
  run("resolveFfmpeg=()=>'/fixture/ffmpeg'; probeVideoInfo=async()=>({w:1080,h:1920,duration:2}); verifyDownloadDecode=async()=>{};");
  context.events=[];context.sendToRenderer=(name,payload)=>context.events.push({name,payload});
  context.registerStreamProtocol();
  const result=await handlers['prepare-online-play']({}, {vid,seriesId:sid,prefetch:false});
  assert.equal(result.success,true,result.error); assert.equal(remuxes,1);assert.ok(context.events.some(e=>e.name==='online-play-progress'&&e.payload.received===200000));
  const entry=run(`onlineCache.get('${vid}')`); assert.equal(entry.buffer,undefined); assert.ok(fs.existsSync(entry.filePath));
  const response=await protocols['hongguo-stream'](new Request(result.url,{headers:{Range:'bytes=2-5'}})); assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,4);
  context.testTask={id:'download',type:'hongguo',filename:'saved.mp4',customDir:root,hongguoInfo:{vid,series_id:sid}};
  run('downloadTasks=[testTask]');
  await context.executeHongguoDownload(context.testTask); assert.equal(context.testTask.status,'completed',context.testTask.error);assert.equal(remuxes,1,'download reuses verified HLS disk cache');
  const local=context.testTask.savePath;
  let candidatesTried=[];
  const candidateResult=await context.withMediaRecovery(vid,sid,{playInfo:{url:'https://fixture.example/bad.m3u8',candidates:[{url:'https://fixture.example/good.m3u8'}]}},async candidate=>{candidatesTried.push(candidate.url);if(candidate.url.includes('/bad'))throw Object.assign(new Error('bad candidate'),{mediaRetryable:true});return 'fallback';});
  assert.equal(candidateResult,'fallback');assert.equal(candidatesTried.length,2);

  await handlers['clear-online-cache'](); assert.equal(fs.existsSync(entry.filePath),false);
  native.fetchPlayUrlSingle=async()=>{custom.assertEnabled();return{url:'https://fixture.example/bad.m3u8',source:'custom',format:'hls',vid,candidates:[{url:'https://fixture.example/good.m3u8',source:'custom',format:'hls',vid}]};};
  const fallback=await handlers['prepare-online-play']({}, {vid,seriesId:sid});assert.equal(fallback.success,true,fallback.error);
  for (const prefetch of [false,true]) {
    await handlers['clear-online-cache']();
    native.fetchPlayUrlSingle=async()=>({url:'https://fixture.example/bad.mp4',source:'custom',format:'mp4',vid,candidates:[{url:'https://fixture.example/good.m3u8',source:'custom',format:'hls',vid}]});
    context.requestMedia=async info=>{if(info.format==='hls')throw new Error('must not transfer HLS as MP4');throw Object.assign(new Error('bad MP4 candidate'),{mediaRetryable:true});};
    const mixed=await handlers['prepare-online-play']({}, {vid,seriesId:sid,prefetch});assert.equal(mixed.success,true,mixed.error);
    const range=await protocols['hongguo-stream'](new Request(mixed.url,{headers:{Range:'bytes=2-5'}}));assert.equal(range.status,206,`mixed candidate prefetch=${prefetch}`);assert.equal((await range.arrayBuffer()).byteLength,4);
    assert.equal(run(`onlineSessions.get('${mixed.streamId}').entry.buffer`),undefined,'HLS remains on disk');
  }
  run(`downloadTasks=[{id:'waiting',status:'pending',hongguoInfo:{vid:'${vid}'}}];downloadQueue=[downloadTasks[0]];testAbort=false;compatPreparing.set('active',{sourceVid:'${vid}',controller:{abort(){testAbort=true;}},requests:new Map()});`);
  const disabled=await handlers['save-custom-source']({}, {...settings.custom_sources[0],enabled:false});assert.equal(disabled.success,true);assert.equal(cancelled,1);assert.equal(run('downloadTasks[0].status'),'stopped');assert.equal(run('testAbort'),true);assert.equal(run('onlineCache.size'),0);assert.equal(run('onlineSessions.size'),0);assert.equal(fs.existsSync(entry.filePath),false);
  assert.equal(fs.existsSync(local),true,'disable must preserve downloaded files');
  assert.equal((await handlers['prepare-online-play']({}, {vid,seriesId:sid})).success,false);
  await assert.rejects(realRequestMedia({source:'custom',vid,url:'http://127.0.0.1/private'}),/禁用|公网|安全/);
  console.log('PASS custom IPC persistence rollback, source list, HLS disk Range/cache download, disabled cleanup and local preservation');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{context.clearOnlineCache();fs.rmSync(root,{recursive:true,force:true});});
