const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../main.js'),'utf8');
const start=source.indexOf('async function clearSeriesPlaybackCache(');
const end=source.indexOf("ipcMain.handle('clear-series-playback-cache'",start);
assert.ok(start>0 && end>start);
(async()=>{
 const own={seriesId:'1'}, other={seriesId:'2'}, released=[], removed=[], deleted=[];
 const sessions=new Map([['own',own],['other',other]]), cache=new Map([['own',own],['other',other]]);
 let cancelled=false, finished=false;
 const job={cancelled:false,controller:{abort(){cancelled=true;}},promise:Promise.resolve().then(()=>finished=true)};
 const ctx={onlineSessions:sessions,onlineCache:cache,releaseOnlineSession:id=>{released.push(id);sessions.delete(id);},deleteOnlineCacheEntry:key=>{removed.push(key);cache.delete(key);},seriesRegistry:[{series_id:'1',episodes:[{vid_index:1}]}],compatPreparing:new Map([['1:1:auto',job]]),compatPathFor:(...args)=>args.join(':'),isFileInUse:file=>file.endsWith('720p'),fsp:{unlink:async file=>{assert.ok(finished);deleted.push(file);}}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 await ctx.clearSeriesPlaybackCache('1');
 assert.deepEqual(released,['own']);assert.deepEqual(removed,['own']);assert.equal(sessions.get('other'),other);assert.equal(cache.get('other'),other);assert.equal(cancelled,true);assert.equal(job.cancelled,true);assert.deepEqual(deleted,['1:1:auto','1:1:1080p']);
 console.log('PASS per-series cleanup cancels and awaits own work, keeps other series and in-use files');
})().catch(error=>{console.error(error);process.exitCode=1;});
