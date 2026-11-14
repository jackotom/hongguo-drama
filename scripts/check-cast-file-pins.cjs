const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../main.js'),'utf8');
const start=source.indexOf("ipcMain.handle('start-casting'");
const end=source.indexOf("ipcMain.handle('control-casting'",start);
let handler,release;
const refs=new Map([['existing.mp4',1]]);
const context={castBusy:false,castFileRefs:refs,mediaAccess:{resolveLocal(source){if(source==='invalid')throw new Error('invalid');return source;},isValid:()=>true},casting:{status:()=>({active:true,name:'Fixture'}),start:async(_id,media)=>{release=media.release;if(media.filePath==='existing.mp4')throw new Error('unavailable device');return {name:'Fixture'};}},ipcMain:{handle:(_channel,callback)=>handler=callback},disposeOnlineDisk:()=>{},URL};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
(async()=>{
 assert.equal((await handler({}, {source:'invalid'})).success,false);assert.equal(refs.get('existing.mp4'),1);
 assert.equal((await handler({}, {source:'existing.mp4'})).success,false);assert.equal(refs.get('existing.mp4'),1);
 assert.equal((await handler({}, {source:'new.mp4'})).success,true);assert.equal(refs.get('new.mp4'),1);
 release();release();assert.equal(refs.has('new.mp4'),false);assert.equal(refs.get('existing.mp4'),1);
 console.log('PASS invalid/replacement casts preserve existing pins; release is owned and idempotent');
})().catch(error=>{console.error(error);process.exitCode=1;});
