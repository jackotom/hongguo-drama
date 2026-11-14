const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const slice=(from,to)=>{const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>0&&end>start);return source.slice(start,end);};
const naming=[
 slice('function sanitizeFolderName(', '// 按命名模板渲染文件名'),
 slice('function playbackQuality(', 'function onlineCacheKey('),
 slice('function compatSeriesStem(', 'function compatFileName('),
 slice('function compatFileName(', 'function compatCacheStatus('),
].join('\n');
const clearBody=slice('async function clearSeriesPlaybackCache(', "ipcMain.handle('clear-series-playback-cache'");
const forgetBody=slice("ipcMain.handle('forget-series'", "ipcMain.handle('purge-empty-series'");
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hg-series-cache-'));
 const downloadDir=path.join(root,'downloads'),cacheDir=path.join(root,'compat');
 fs.mkdirSync(downloadDir);fs.mkdirSync(cacheDir);
 let handler;
 const sessions=new Map([['own',{seriesId:'1'}],['other',{seriesId:'2'}]]),cache=new Map([['own',{seriesId:'1'}],['other',{seriesId:'2'}]]);
 const jobs=new Map();
 const ctx={require,fs,fsp:fs.promises,path,console,createHash:require('node:crypto').createHash,onlineSessions:sessions,onlineCache:cache,seriesRegistry:[{series_id:'1',episodes:[{vid_index:5}]},{series_id:'2',episodes:[{vid_index:1}]}],compatPreparing:jobs,getCompatDir:()=>cacheDir,releaseOnlineSession:id=>sessions.delete(id),deleteOnlineCacheEntry:key=>cache.delete(key),isFileInUse:file=>path.basename(file).startsWith('1_003'),store:{saveSeries(value){ctx.seriesRegistry=value;}},ipcMain:{handle:(_channel,fn)=>handler=fn}};
 vm.createContext(ctx);vm.runInContext(`${naming}\n${clearBody}\n${forgetBody}`,ctx);
 for(const index of [2,3])fs.writeFileSync(ctx.compatPathFor('1',index,index===3?'1080p':'auto'),'old');
 fs.writeFileSync(ctx.compatPathFor('1',2,'auto')+'.part','partial');
 fs.writeFileSync(ctx.compatPathFor('2',1,'auto'),'other');
 const outside=path.join(downloadDir,'1_001.mp4');fs.writeFileSync(outside,'download');
 for(const name of ['1_000.mp4','1_001_480p.mp4'])fs.writeFileSync(path.join(cacheDir,name),'invalid');
 const directory=path.join(cacheDir,'1_999.mp4');fs.mkdirSync(directory);
 const activeOutput=ctx.compatPathFor('1',6,'1080p'),activePart=activeOutput+'.part';
 fs.writeFileSync(activePart,'active');let aborted=false,finished=false,resolve;
 const activePromise=new Promise(r=>{resolve=r;});
 jobs.set(activeOutput,{cancelled:false,controller:{abort(){aborted=true;jobs.delete(activeOutput);setImmediate(()=>{finished=true;fs.writeFileSync(activeOutput,'finished');fs.unlinkSync(activePart);resolve();});}},promise:activePromise});
 const symlink=path.join(cacheDir,'1_998.mp4');
 let symlinkCreated=false;try{fs.symlinkSync(outside,symlink);symlinkCreated=true;}catch{}
 await ctx.clearSeriesPlaybackCache('1');
 assert.equal(aborted,true);assert.equal(finished,true);assert.equal(fs.existsSync(activeOutput),false);
 assert.equal(fs.existsSync(ctx.compatPathFor('1',2,'auto')),false);
 assert.equal(fs.existsSync(ctx.compatPathFor('1',2,'auto')+'.part'),false);
 assert.equal(fs.existsSync(ctx.compatPathFor('1',3,'1080p')),true,'in-use file must remain');
 assert.equal(fs.existsSync(ctx.compatPathFor('2',1,'auto')),true,'other series must remain');
 assert.equal(fs.existsSync(outside),true,'download directory must remain');
 assert.equal(fs.existsSync(path.join(cacheDir,'1_000.mp4')),true);
 assert.equal(fs.existsSync(path.join(cacheDir,'1_001_480p.mp4')),true);
 assert.equal(fs.statSync(directory).isDirectory(),true);
 if(symlinkCreated){assert.equal(fs.lstatSync(symlink).isSymbolicLink(),true);assert.equal(fs.existsSync(outside),true);}
 assert.ok(sessions.has('other')&&cache.has('other'));
 const colliding=ctx.compatPathFor('a:b',1,'auto');fs.writeFileSync(colliding,'ambiguous');
 ctx.seriesRegistry.push({series_id:'a:b',episodes:[]},{series_id:'ab',episodes:[]});
 assert.notEqual(ctx.compatPathFor('a:b',1,'auto'),ctx.compatPathFor('ab',1,'auto'),'sanitized series IDs must not collide');
 await ctx.clearSeriesPlaybackCache('a:b');
 assert.equal(fs.existsSync(colliding),false,'hashed cache name must be deleted only for its own series');

 let releaseClear;const entered=new Promise(r=>{ctx.clearSeriesPlaybackCache=async()=>{r();await new Promise(done=>{releaseClear=done;});};});
 const first=handler({},'1',{clearCache:true});await entered;
 ctx.seriesRegistry=ctx.seriesRegistry.map(item=>item.series_id==='2'?{...item,dismissed:true,forgotten:true}:item);
 releaseClear();await first;
 assert.equal(ctx.seriesRegistry.find(item=>item.series_id==='2').forgotten,true,'concurrent series update must survive');
 fs.rmSync(root,{recursive:true,force:true});
 console.log('PASS per-series cleanup uses canonical cache names, waits for own transcode, preserves other files, and keeps concurrent registry updates');
})().catch(error=>{console.error(error);process.exitCode=1;});
