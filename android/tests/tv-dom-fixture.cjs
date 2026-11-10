// DOM/network fixture only; it does not render CSS, decode media or emulate Android IME.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('../../node_modules/esbuild');
const {DOMParser} = require('@xmldom/xmldom');
const root = path.resolve(__dirname,'..');
const html = text => text.replace(/\s(defer|disabled|hidden)(?=[\s>])/g,' $1="$1"').replace(/<(input|img|meta|link|br)(\s[^>]*?)?>/g,'<$1$2/>');

async function mount() {
  const document = new DOMParser().parseFromString(html(fs.readFileSync(path.join(root,'web/index.html'),'utf8')),'text/html');
  const proto = Object.getPrototypeOf(document.createElement('div'));
  const events = new WeakMap(), observers = new Set(), frames = new Map(), timers = new Map();
  let sequence = 0, pauses = 0;
  const window = {document,scrollX:0,scrollY:0};
  class Event {
    constructor(type, options={}) { Object.assign(this,{type,bubbles:false,defaultPrevented:false},options); }
    preventDefault(){ this.defaultPrevented=true; }
    stopPropagation(){ this.stopped=true; }
    stopImmediatePropagation(){ this.stopped=this.immediate=true; }
  }
  function eventTarget(target) {
    target.addEventListener = (name,fn,options) => {
      if(!events.has(target))events.set(target,new Map());
      const map=events.get(target); if(!map.has(name))map.set(name,[]);
      map.get(name).push({fn,capture:options===true||options?.capture,once:options?.once});
    };
    target.removeEventListener = (name,fn) => {
      const map=events.get(target);if(map)map.set(name,(map.get(name)||[]).filter(item=>item.fn!==fn));
    };
    target.dispatchEvent = event => {
      event.target ||= target;
      const chain=[target];let parent=target.parentNode;
      while(parent){chain.push(parent);parent=parent.parentNode;}
      if(chain.includes(document))chain.push(window);
      const fire=(node,capture)=>{
        for(const item of [...(events.get(node)?.get(event.type)||[])]){
          if(Boolean(item.capture)!==capture)continue;
          event.currentTarget=node;item.fn(event);if(item.once)node.removeEventListener(event.type,item.fn);
          if(event.immediate)break;
        }
        if(!capture&&!event.immediate)node['on'+event.type]?.(event);
      };
      for(const node of [...chain].reverse()){fire(node,true);if(event.stopped)return !event.defaultPrevented;}
      for(const node of event.bubbles?chain:[target]){fire(node,false);if(event.stopped)break;}
      return !event.defaultPrevented;
    };
  }
  function matches(el, selector) {
    return selector.split(',').some(part=>{
      part=part.trim();
      if(part.includes(' ')){
        const pieces=part.split(/\s+/),last=pieces.pop();
        return matches(el,last)&&Boolean(el.parentElement?.closest(pieces.join(' ')));
      }
      if(part===':disabled')return el.disabled||Boolean(el.parentElement?.closest('fieldset[disabled]'));
      part=part.replace(/:last-of-type/g,'');
      const attrs=[...part.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
      if(attrs.some(([,key,value])=>!el.hasAttribute(key)||(value!==undefined&&el.getAttribute(key)!==value)))return false;
      part=part.replace(/\[[^\]]+\]/g,'');
      const id=part.match(/#([\w-]+)/);if(id&&el.id!==id[1])return false;
      if([...part.matchAll(/\.([\w-]+)/g)].some(([,name])=>!el.classList.contains(name)))return false;
      const tag=part.match(/^[\w-]+/);return !tag||el.tagName.toLowerCase()===tag[0].toLowerCase();
    });
  }
  function query(node, selector) {
    const result=[];
    for(const child of Array.from(node.childNodes||[])){
      if(child.nodeType===1&&matches(child,selector))result.push(child);
      result.push(...query(child,selector));
    }
    return result;
  }
  const originalCreate = document.createElement.bind(document);
  function setup(el) {
    eventTarget(el);
    if(el.tagName.toLowerCase()==='video'){
      Object.assign(el,{paused:true,ended:false,currentTime:0,duration:100,readyState:0,videoWidth:0,videoHeight:0,muted:true,volume:0,playbackRate:1,playCalls:0});
      el.play=()=>{el.playCalls++;el.paused=false;el.dispatchEvent(new Event('play'));return Promise.resolve();};
      el.pause=()=>{if(!el.paused){el.paused=true;el.dispatchEvent(new Event('pause'));}};
      el.load=()=>{};
    }
    return el;
  }
  document.createElement = tag => setup(originalCreate(tag));
  Object.defineProperties(proto,{
    parentElement:{get(){return this.parentNode?.nodeType===1?this.parentNode:null;},configurable:true},
    isConnected:{get(){let p=this;while(p.parentNode)p=p.parentNode;return p===document;},configurable:true},
    children:{get(){return Array.from(this.childNodes).filter(n=>n.nodeType===1);},configurable:true},
    firstElementChild:{get(){return this.children[0]||null;},configurable:true},
    dataset:{get(){return new Proxy({}, {get:(_,key)=>this.getAttribute('data-'+String(key).replace(/[A-Z]/g,s=>'-'+s.toLowerCase()))||undefined,
      set:(_,key,value)=>{this.setAttribute('data-'+String(key).replace(/[A-Z]/g,s=>'-'+s.toLowerCase()),String(value));return true;}});},configurable:true},
    classList:{get(){const values=()=>this.className.split(/\s+/).filter(Boolean);return {
      contains:name=>values().includes(name),toggle:(name,force)=>{const yes=force===undefined?!values().includes(name):force;this.className=[...new Set([...values().filter(v=>v!==name),...(yes?[name]:[])])].join(' ');return yes;},
      add:(...names)=>{this.className=[...new Set([...values(),...names])].join(' ');},remove:(...names)=>{this.className=values().filter(v=>!names.includes(v)).join(' ');}};},configurable:true},
    innerHTML:{get(){return Array.from(this.childNodes).map(n=>n.toString()).join('');},set(value){
      this.replaceChildren();const parsed=new DOMParser().parseFromString(`<div xmlns="http://www.w3.org/1999/xhtml">${html(value)}</div>`,'text/html');
      for(const node of Array.from(parsed.documentElement.childNodes)){const child=document.importNode(node,true);this.appendChild(child);walk(child,setup);}
    },configurable:true},
  });
  for(const [prop,attr] of Object.entries({id:'id',className:'class',value:'value',tabIndex:'tabindex'}))
    Object.defineProperty(proto,prop,{get(){return this.getAttribute(attr)|| (prop==='value'&&this.tagName==='select'?this.querySelector('option')?.value:'')||'';},set(v){this.setAttribute(attr,String(v));},configurable:true});
  for(const prop of ['disabled','hidden','open'])Object.defineProperty(proto,prop,{get(){return this.hasAttribute(prop);},set(v){if(v)this.setAttribute(prop,'');else this.removeAttribute(prop);},configurable:true});
  proto.matches=function(s){return matches(this,s);};
  proto.closest=function(s){let p=this;while(p){if(p.nodeType===1&&matches(p,s))return p;p=p.parentNode;}return null;};
  proto.querySelectorAll=function(s){return query(this,s);};proto.querySelector=function(s){return query(this,s)[0]||null;};
  proto.append=function(...nodes){for(const n of nodes)this.appendChild(typeof n==='string'?document.createTextNode(n):n);};
  proto.replaceChildren=function(...nodes){while(this.firstChild)this.removeChild(this.firstChild);this.append(...nodes);};
  proto.remove=function(){this.parentNode?.removeChild(this);if(this===document.activeElement)document.activeElement=document.body;};
  proto.after=function(...nodes){for(const n of nodes)this.parentNode.insertBefore(n,this.nextSibling);};
  proto.before=function(...nodes){for(const n of nodes)this.parentNode.insertBefore(n,this);};
  proto.replaceWith=function(node){this.parentNode.replaceChild(node,this);};
  proto.contains=function(node){while(node){if(node===this)return true;node=node.parentNode;}return false;};
  proto.getClientRects=function(){return this.isConnected&&!this.closest('[hidden],[inert],[aria-hidden="true"]')&&(!this.closest('dialog')||this.closest('dialog').open)?[this.getBoundingClientRect()]:[];};
  proto.getBoundingClientRect=function(){return this.rect||{left:20,top:20,right:120,bottom:80,width:100,height:60};};
  proto.focus=function(){document.activeElement=this;this.dispatchEvent(new Event('focusin',{bubbles:true}));};
  proto.scrollIntoView=function(){this.scrolled=true;};
  proto.click=function(){if(!this.disabled)this.dispatchEvent(new Event('click',{bubbles:true}));};
  proto.showModal=function(){this.open=true;this.querySelector('button')?.focus();};
  proto.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
  function walk(node,fn){if(node.nodeType===1)fn(node);for(const n of Array.from(node.childNodes||[]))walk(n,fn);}
  walk(document.documentElement,setup);eventTarget(document);eventTarget(window);
  document.querySelectorAll=s=>query(document,s);document.querySelector=s=>query(document,s)[0]||null;
  document.body=document.querySelector('body');document.activeElement=document.body;document.hidden=false;
  window.scrollTo=(x,y)=>{window.scrollX=x;window.scrollY=y;window.dispatchEvent(new Event('scroll'));};
  const stored=new Map(),preparations=[],responses=[];let hold=false;
  const context={window,document,Event,CustomEvent:Event,URL,AbortController,AbortSignal,console,queueMicrotask,Map,Set,WeakMap,WeakSet,
    localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},
    getComputedStyle:el=>({visibility:el.closest('[data-invisible]')?'hidden':'visible'}),
    requestAnimationFrame:fn=>{const id=++sequence;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
    setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    MutationObserver:class {constructor(fn){this.fn=fn;observers.add(this);}observe(){}disconnect(){observers.delete(this);}},
    __prepareUiMedia:(...args)=>new Promise((resolve,reject)=>preparations.push({args,resolve,reject})),
    Native:{awake(){},clearMedia(){},deleteMedia(){},cancel(){},request(id,raw){
      const url=new URL(JSON.parse(raw).url),page=Number(url.searchParams.get('page'))||1;
      const rows=Array.from({length:24},(_,i)=>({series_id:String(page*1000000+i+1),series_name:`fixture ${i+1}`,series_cover:'',episode_cnt:3}));
      let data;
      if(url.pathname.startsWith('/category/'))data=`<script>_ROUTER_DATA = ${JSON.stringify({loaderData:{category:{categoryRoute:{contentType:'real-drama'},recommendList:rows,pagination:{pageNum:page,totalPages:3}}}})}</script>`;
      else if(url.pathname.startsWith('/api/search'))data=JSON.stringify({searchList:rows,hasMore:true});
      else {const id=url.pathname.split('/')[2];data=`<script>_ROUTER_DATA = ${JSON.stringify({loaderData:{'player_(series_id)/page':{isSuccess:true,series_id:id,seriesDetail:{series_id:id,series_name:'fixture detail',vid_list:[id+'01',id+'02',id+'03']}}}})}</script>`;}
      const reply=()=>context.__nativeResponse(id,JSON.stringify({status:200,data,headers:{}}));
      if(hold)responses.push(reply);else queueMicrotask(reply);
    }},
  };
  Object.assign(window,{requestAnimationFrame:context.requestAnimationFrame,cancelAnimationFrame:context.cancelAnimationFrame});
  const built=await esbuild.build({entryPoints:[path.join(root,'web/tv.js')],bundle:true,platform:'browser',format:'cjs',write:false,logLevel:'silent',
    plugins:[{name:'tv-ui-boundaries',setup(build){
      build.onLoad({filter:/web\/media\.js$/},()=>({contents:'export const prepareTvMedia=(...args)=>globalThis.__prepareUiMedia(...args);'}));
      build.onLoad({filter:/native\/hongguo-app-(catalog|search)\.js$/},()=>({contents:'export const browseList=async()=>({success:false});export const searchApp=async()=>({results:[]});'}));
    }}]});
  context.module={exports:{}};vm.createContext(context);vm.runInContext(built.outputFiles[0].text,context);
  async function flush(){for(let turn=0;turn<4;turn++){await new Promise(resolve=>setImmediate(resolve));for(const o of [...observers])o.fn();let limit=20;while(frames.size&&limit--){const queue=[...frames];frames.clear();for(const [,fn]of queue)fn(0);}}}
  await flush();
  return {document,window,context,stored,preparations,flush,Event,
    holdRequests(){hold=true;},deliver(){hold=false;for(const reply of responses.splice(0))reply();},
    key(key,options={}){const event=new Event('keydown',{key,bubbles:true,repeat:false,...options});document.activeElement.dispatchEvent(event);return event;},
    up(key){document.activeElement.dispatchEvent(new Event('keyup',{key,bubbles:true}));},
    timer(ms){for(const [id,item]of [...timers])if(item.ms===ms){timers.delete(id);item.fn();}},
    listenerCount(node,name){return events.get(node)?.get(name)?.length||0;},
  };
}
module.exports={mount};
