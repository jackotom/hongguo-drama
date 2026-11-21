import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { formatMessage } from '../../i18n/translator.mjs';
const i18n = { t: formatMessage, useLanguage: () => 'zh-CN:zh-CN', getLanguage: () => 'zh-CN' };
import {transformSync} from 'esbuild';

const code=transformSync(fs.readFileSync(new URL('../DownloadManager.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code;
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function harness(api,{tasks=[],mergeTasks=[],active=false}={}){
 let cursor=0, tree;const slots=[],effects=[],timers=[];
 const react={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),useState(initial){const at=cursor++;if(!(at in slots))slots[at]=initial;return[slots[at],value=>slots[at]=value];},useRef(initial){const at=cursor++;return slots[at]||=( {current:initial} );},useEffect(effect,deps){const at=cursor++,previous=slots[at];if(!previous||deps.some((value,index)=>value!==previous.deps[index])){previous?.cleanup?.();slots[at]={deps};effects.push(()=>slots[at].cleanup=effect());}},useCallback:fn=>fn,useMemo:fn=>fn()};
 const icon=props=>({type:'icon',props:props||{},children:[]});
 const module={exports:{}};
 const require=id=>id==='../i18n'?i18n:id==='react'?react:id==='./useDialogKeyboard'?()=>{}:id==='./DownloadManager.css'?{}:id==='./icons'?new Proxy({},{get:()=>icon}):undefined;
 const tracked=(fn,delay,interval=false)=>{const id=(interval?setInterval:setTimeout)(fn,delay);timers.push({id,fn,delay,interval});return id;};
 const untrack=id=>{timers.splice(timers.findIndex(timer=>timer.id===id)>>>0,1);clearTimeout(id);clearInterval(id);};
 vm.runInNewContext(code,{module,exports:module.exports,require,window:{electronAPI:api,addEventListener(){},removeEventListener(){}},document:{addEventListener(){},removeEventListener(){}},setTimeout:(fn,delay)=>tracked(fn,delay),clearTimeout:untrack,setInterval:(fn,delay)=>tracked(fn,delay,true),clearInterval:untrack});
 slots[0]=tasks;slots[8]=mergeTasks;
 const render=()=>{cursor=0;tree=module.exports.default({active});while(effects.length)effects.shift()();};
 const find=(predicate,root=tree)=>{let match;const visit=node=>{if(!node||typeof node!=='object'||match)return;if(predicate(node))match=node;node.children?.forEach(visit);};visit(root);return match;};
 const findButton=label=>find(node=>node.type==='button'&&node.children.includes(label));
 const findTitled=(title,scopeClass)=>find(node=>node.props?.className?.includes?.(scopeClass)&&node.type==='button'&&node.props.title===title)||(()=>{
  const scope=find(node=>node.props?.className?.includes?.(scopeClass));
  return scope&&find(node=>node.type==='button'&&node.props.title===title,scope);
 })();
 const toast=()=>find(node=>node.props?.className?.startsWith?.('dm-toast '));
 return{render,findButton,findTitled,toast,slots,timers,unmount:()=>timers.splice(0).forEach(timer=>{clearTimeout(timer.id);clearInterval(timer.id);})};
}

test('folder actions surface backend failures and rejected IPC calls',async()=>{
 const calls=[];
 const api={
  showInFolder:async path=>{calls.push(['merge',path]);return{success:false,error:'合并目录不可用'};},
  openFolder:async id=>{calls.push(['task',id]);return{success:false,error:'任务目录不可用'};},
 };
 const ui=harness(api,{tasks:[{id:'task-1',title:'Fixture',status:'completed'}],mergeTasks:[{id:'merge-1',status:'completed',seriesTitle:'Fixture',output:'/tmp/merged.mp4',total:1}]});
 ui.render();
 await ui.findTitled('打开所在文件夹','merge-actions').props.onClick();await tick();ui.render();
 assert.deepEqual(calls.at(-1),['merge','/tmp/merged.mp4']);
 assert.ok(ui.toast().children.includes('合并目录不可用'));
 await ui.findTitled('打开文件夹','dm-task-actions').props.onClick();await tick();ui.render();
 assert.deepEqual(calls.at(-1),['task','task-1']);
 assert.ok(ui.toast().children.includes('任务目录不可用'));
 api.showInFolder=async()=>{throw new Error('合并 IPC 失败');};
 await ui.findTitled('打开所在文件夹','merge-actions').props.onClick();await tick();ui.render();
 assert.ok(ui.toast().children.includes('合并 IPC 失败'));
 api.openFolder=async()=>{throw new Error('任务 IPC 失败');};
 await ui.findTitled('打开文件夹','dm-task-actions').props.onClick();await tick();ui.render();
 assert.ok(ui.toast().children.includes('任务 IPC 失败'));
});

test('bulk pause and resume catch rejected IPC calls and show their errors',async()=>{
 const api={
  getDownloadTasks:async()=>[],
  getQueueStatus:async()=>({active:0,queued:0,maxConcurrent:3}),
  pauseAll:async()=>{throw new Error('暂停 IPC 失败');},
  resumeAll:async()=>{throw new Error('启动 IPC 失败');},
 };
 const ui=harness(api,{tasks:[{id:'task-1',title:'Fixture',status:'stopped'}]});
 ui.render();
 await assert.doesNotReject(()=>ui.findButton('全部暂停').props.onClick());await tick();ui.render();
 assert.ok(ui.toast().children.includes('暂停 IPC 失败'));
 await assert.doesNotReject(()=>ui.findButton('全部开始').props.onClick());await tick();ui.render();
 assert.ok(ui.toast().children.includes('启动 IPC 失败'));
});

test('periodic refresh does not stack slow task scans',async()=>{
 let calls=0,finish;
 const api={
  getDownloadTasks:async()=>{calls++;if(calls===1)return[];return new Promise(resolve=>{finish=resolve;});},
  getQueueStatus:async()=>({active:0,queued:0,maxConcurrent:3}),
 };
 for(const name of ['onDownloadProgress','onDownloadTaskAdded','onDownloadCompleted','onDownloadFailed','onDownloadStopped','onDownloadQueueChanged','onMergeTaskAdded','onMergeProgress','onMergeCompleted','onMergeFailed'])api[name]=()=>()=>{};
 const ui=harness(api,{active:true});
 ui.render();
 await tick();
 const interval=ui.timers.find(timer=>timer.interval);
 assert.ok(interval);
 interval.fn();await tick();interval.fn();
 assert.equal(calls,2);
 finish?.([]);await tick();
 ui.unmount();
});
