const assert = require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),{EventEmitter}=require('node:events'),{createRequire}=require('node:module');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hongguo-issue43-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'../main.js'),req=createRequire(source),handlers={},app=new EventEmitter();
 Object.assign(app,{getVersion:()=> 'test',getPath:()=>root,commandLine:{appendSwitch(){}},requestSingleInstanceLock:()=>true,whenReady:()=>({then(){}})});
 const store=req('./src/store');store.init(path.join(root,'data.json'));store.saveSettings({root,watch_sequels_enabled:false,auto_delete_watched:true});
 const native={fetchPlayUrlSingle:async()=>({url:'https://fixture.invalid/media'})};
 const context=vm.createContext({require:n=>n==='electron'?{app,ipcMain:{handle:(n,fn)=>handlers[n]=fn},protocol:{registerSchemesAsPrivileged(){}}}:n==='./src/native/hongguo'?native:req(n),__dirname:path.dirname(source),process,Buffer,URL,Response,Request,Headers,AbortController,setTimeout,clearTimeout,console:{log(){},warn(){},error(){}}});
 vm.runInContext(fs.readFileSync(source,'utf8'),context,{filename:source});req('./scripts/fixtures/trusted-ipc.cjs')(context,handlers);
 const run=code=>vm.runInContext(code,context);run(`seriesRegistry=[{series_id:'1',series_title:'One',total:2,episodes:[{vid:'11',vid_index:1},{vid:'12',vid_index:2}]}];saveSeriesRegistry()`);
 store.savePlayback({'1':{vid_index:1,currentTime:10,updatedAt:1,watched:true}});
 return {root,store,native,context,handlers,run};
}
test('removing history survives a pending update without deleting series or files',async t=>{
 const h=fixture(t);let release;h.native.fetchEpisodeList=()=>new Promise(r=>release=r);
 const pending=h.context.refreshWatchHistory(true);await Promise.resolve();
 assert.equal((await h.handlers['remove-watch-history']({},'1')).success,true);
 release({series_id:'1',series_title:'One',episodes:[{vid:'11',vid_index:1},{vid:'12',vid_index:2}]});await pending;
 assert.equal(h.store.getPlayback()['1'],undefined);assert.equal(h.run('seriesRegistry.length'),1);
});
test('permanent list removal stays out of restore but history can deliberately resume',async t=>{
 const h=fixture(t);assert.equal((await h.handlers['forget-series']({},'1')).success,true);
 assert.equal(await h.handlers['dismissed-count']({}),0);assert.equal((await h.handlers['restore-dismissed-series']({})).count,0);
 assert.equal((await h.handlers['get-series-list']({})).length,0);assert.ok(h.store.getPlayback()['1']);
 assert.equal((await h.handlers['play-series']({},{seriesId:'1',resume:true})).success,true);
 assert.equal((await h.handlers['get-series-list']({})).length,1);
 await h.handlers['remove-series']({},'1');assert.equal(await h.handlers['dismissed-count']({}),1);assert.equal((await h.handlers['restore-dismissed-series']({})).count,1);
});
test('watched cleanup removes only the exact episode across local, memory and compatible caches',async t=>{
 const h=fixture(t),local=path.join(h.root,'watched.mp4');fs.writeFileSync(local,'watched');h.context.localFixture=local;
 h.run(`downloadTasks=[{id:'watched',status:'completed',savePath:localFixture,endTime:Date.now(),fileIdentity:readFileIdentity(localFixture),hongguoInfo:{series_id:'1',vid_index:1}}];onlineCache.set('11',{seriesId:'1',vidIndex:1,buffer:Buffer.from('cached'),size:6});onlineCache.set('12',{seriesId:'1',vidIndex:2,buffer:Buffer.from('next'),size:4})`);
 const watched=h.run("compatPathFor('1',1)"),next=h.run("compatPathFor('1',2)");fs.writeFileSync(watched,'converted');fs.writeFileSync(next,'next');
 const result=await h.handlers['cleanup-watched-episode']({},'1',1);assert.equal(result.success,true,result.error);
 assert.equal(fs.existsSync(local),false);assert.equal(fs.existsSync(watched),false);assert.equal(fs.existsSync(next),true);
 assert.equal(h.run("onlineCache.has('11')"),false);assert.equal(h.run("onlineCache.has('12')"),true);
 assert.equal(h.run('downloadTasks.length'),0);assert.ok(h.store.getPlayback()['1']);
});
test('watched cleanup rejects invalid indexes and active work without deleting files',async t=>{
 const h=fixture(t),local=path.join(h.root,'active.mp4');fs.writeFileSync(local,'active');h.context.localFixture=local;
 h.run(`downloadTasks=[{id:'active',status:'downloading',savePath:localFixture,hongguoInfo:{series_id:'1',vid_index:1}}]`);
 for(const index of [0,NaN,1]){const result=await h.handlers['cleanup-watched-episode']({},'1',index);assert.equal(result.success,false);assert.equal(fs.existsSync(local),true);}
});

test('permanent removal survives a pending history refresh',async t=>{
 const h=fixture(t);let release;h.native.fetchEpisodeList=()=>new Promise(r=>release=r);
 const pending=h.context.refreshWatchHistory(true);await Promise.resolve();await h.handlers['forget-series']({},'1');
 release({series_id:'1',series_title:'One',episodes:[{vid:'11',vid_index:1},{vid:'12',vid_index:2}]});await pending;
 assert.equal((await h.handlers['get-series-list']({})).length,0);assert.equal(await h.handlers['dismissed-count']({}),0);
});
test('failed disk cache deletion retains its index for a real retry',async t=>{
 const h=fixture(t),dir=path.join(h.root,'cache');fs.mkdirSync(dir);const file=path.join(dir,'video.mp4');fs.writeFileSync(file,'cached');
 h.context.diskFixture={seriesId:'1',vidIndex:1,filePath:file,disk:{directory:dir,readers:1},size:6};h.run("onlineCache.set('11',diskFixture)");
 assert.equal((await h.handlers['cleanup-watched-episode']({},'1',1)).success,false);assert.equal(h.run("onlineCache.has('11')"),true);
 h.context.diskFixture.disk.readers=0;assert.equal((await h.handlers['cleanup-watched-episode']({},'1',1)).success,true);assert.equal(fs.existsSync(file),false);
});
test('a pending online session protects its episode before entry is available',async t=>{
 const h=fixture(t);h.run("onlineSessions.set('pending',{seriesId:'1',vidIndex:1,entry:null})");
 assert.equal((await h.handlers['cleanup-watched-episode']({},'1',1)).success,false);
});
