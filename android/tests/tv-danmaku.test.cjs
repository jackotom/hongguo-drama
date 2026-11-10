const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const esbuild = require('../../node_modules/esbuild');
const { mount } = require('./tv-dom-fixture.cjs');
const root = path.resolve(__dirname, '..');
const built = esbuild.build({ stdin: { contents: `
  export { connectTvDanmaku } from './web/tv-danmaku.js';
  export { default as axios } from './web/axios.cjs';
  export * from '../src/components/danmakuOfficial.mjs';
  export * from '../src/components/danmakuModel.mjs';
`, resolveDir: root }, bundle: true, format: 'iife', globalName: '__t4Test', platform: 'browser', target: 'chrome100', write: false, logLevel: 'silent',
  inject: [path.join(root, 'web/globals.js')], alias: {
    'axios': path.join(root, 'web/axios.cjs'), 'node:fs': path.join(root, 'mobile/fs.cjs'),
    'node:path': path.join(root, 'mobile/path.cjs'), 'node:crypto': path.join(root, 'web/crypto.js'),
  } });
const plain = value => JSON.parse(JSON.stringify(value));
const rawPage = (vid, entries = [], more = false) => ({ code: 0, data: {
  data_list: entries.map(([time, text]) => ({ comment: { common: { group_id: vid, status: 1, content: { text } }, expand: { offset_time: time * 1000 } } })),
  common_list_info: { has_more: more, ...(more ? { cursor: { end_offset_time: 9000 } } : {}) },
} });

async function fixture() {
  const h = await mount(), { document: d, context, window } = h;
  d.querySelector('[data-series]').click(); await h.flush();
  d.querySelector('#retry').click(); h.preparations[0].resolve({ url: 'blob:controlled', token: 'fake', codec: 'h264' }); await h.flush();
  const stage = d.querySelector('#stage'), video = stage.querySelector('video');
  stage.rect = { left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540 };
  d.querySelector('#tv-controls').rect = { left: 0, top: 548, right: 960, bottom: 660, width: 960, height: 112 };
  const proto = Object.getPrototypeOf(d.createElement('div'));
  Object.defineProperty(proto, 'style', { configurable: true, get() { return this.testStyle ||= {}; } });
  const resizeObservers = new Set();
  context.ResizeObserver = class { constructor(fn) { this.fn = fn; resizeObservers.add(this); } observe() {} disconnect() { resizeObservers.delete(this); } };
  const motionListeners = new Set();
  const motion = { matches: false, addEventListener: (_, fn) => motionListeners.add(fn), removeEventListener: (_, fn) => motionListeners.delete(fn) };
  window.matchMedia = () => motion;
  const requests = [], cancelled = [], writes = [], reads = [];
  const files = new Map([['danmaku.identity', Buffer.from(JSON.stringify({deviceId:'1000000000000000001',installId:'1000000000000000002'})).toString('base64')]]);
  context.Native = {
    ...context.Native,
    request(id, raw) { requests.push({ id, ...JSON.parse(raw) }); }, cancel(id) { cancelled.push(id); },
    readPrivate(name) { reads.push(name); return files.get(name) || ''; },
    writePrivate(name, value) { writes.push(name); files.set(name, value); },
    random: size => Buffer.alloc(size, 1).toString('base64'),
    digest: (algorithm, data) => crypto.createHash(algorithm).update(Buffer.from(data, 'base64')).digest('base64'),
    crypt(decrypt, algorithm, key, iv, padding, data) {
      const cipher = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)(algorithm, Buffer.from(key, 'base64'), iv ? Buffer.from(iv, 'base64') : null);
      cipher.setAutoPadding(padding); return Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('base64');
    },
  };
  vm.runInContext((await built).outputFiles[0].text, context);
  const api = context.__t4Test, originalPauseListeners = h.listenerCount(video, 'pause');
  const dispose = api.connectTvDanmaku(); await h.flush();
  const emit = (v, name) => v.dispatchEvent(new h.Event(name));
  const official = () => requests.filter(r => new URL(r.url).pathname.startsWith('/novel/commentapi/'));
  const respond = (request, payload, status = 200) => context.__nativeResponse(request.id, JSON.stringify({ status, headers: {}, data: typeof payload === 'string' ? payload : JSON.stringify(payload) }));
  const ready = async () => {
    video.readyState = 1; emit(video, 'loadedmetadata');
    video.readyState = 2; video.videoWidth = 720; video.videoHeight = 1280; emit(video, 'loadeddata'); await h.flush();
  };
  return { ...h, api, stage, video, requests, cancelled, files, reads, writes, official, respond, emit, ready, dispose, resizeObservers, motionListeners, originalPauseListeners,
    async move(time) { video.currentTime = time; emit(video, 'timeupdate'); await h.flush(); },
    items: () => [...d.querySelectorAll('.tv-danmaku-item')],
    notice: () => d.querySelector('.tv-danmaku-status'),
  };
}

test('直接复用冻结模型：5秒组首窗口、不同文、重复页和原始数据不变', async () => {
  const h = await fixture();
  try {
    const { createOfficialFeed, appendOfficialPage, groupDanmaku, advanceTimedDanmaku, normalizeDanmakuSettings } = h.api;
    const entries = [[0,'同文'],[4.9,'同文'],[5,'同文'],[5.1,'同文'],[5.1,'不同文']].map(([time,text]) => ({time,text,color:'#FFFFFF',mode:'scroll'}));
    const before = JSON.stringify(entries), feed = createOfficialFeed('1000001','100000101');
    const page = {success:true,series_id:'1000001',episode_id:'100000101',items:entries};
    appendOfficialPage(feed,page); appendOfficialPage(feed,page);
    assert.equal(JSON.stringify(entries),before); assert.equal(feed.danmaku.length,5);
    assert.deepEqual(plain(feed.groupedDanmaku.map(v=>[v.time,v.text,v.count])),[[0,'同文',3],[5.1,'同文',1],[5.1,'不同文',1]]);
    assert.deepEqual(plain(groupDanmaku(entries)),plain(feed.groupedDanmaku));
    const densityCount = density => {
      const state = createOfficialFeed('1','2').animation, settings = normalizeDanmakuSettings({density});
      const rows = Array.from({length:12},(_,i)=>({time:i/100,text:`弹幕${i}`}));
      for(let i=0;i<6;i++) advanceTimedDanmaku(state,rows,i/10,i?0.1:0,{width:960,height:540,settings,reducedMotion:false,bottomInset:0});
      return state.items.length;
    };
    assert(densityCount('sparse') < densityCount('normal'));
  } finally { h.dispose(); }
});

test('真实TV模块经原axios.post／Native桥发POST，元数据不能越过有效帧，T2 on*保留', async () => {
  const h = await fixture();
  try {
    const before = ['onplay','onpause','onended','onerror','onseeking','onseeked'].map(k=>h.video[k]);
    assert.equal(h.official().length,0); assert.equal(h.reads.length,0);
    h.video.readyState=1;h.emit(h.video,'loadedmetadata');await h.flush();
    assert.equal(h.official().length,0); assert.equal(h.document.querySelector('.tv-danmaku').hidden,true);
    assert.equal(h.window.tvDanmaku.getState().available,true); await h.ready();
    const request=h.official()[0];assert(request);assert.equal(request.method,'POST');assert.equal(request.media,false);
    const body=JSON.parse(Buffer.from(request.body,'base64').toString());
    assert.equal(body.group_id,h.stage.dataset.vid);assert.equal(body.business_param.book_id,h.document.querySelector('#content').dataset.seriesId);
    assert.deepEqual(h.reads,['danmaku.identity']);assert.deepEqual(h.writes,[]);
    h.respond(request,rawPage(h.stage.dataset.vid,[[0,'<img src=x onerror=alert(1)>'],[4.9,'同文'],[5,'同文'],[5.1,'同文']]));await h.flush();
    assert(h.items().some(n=>n.textContent==='<img src=x onerror=alert(1)>'));assert.equal(Boolean(h.document.querySelector('.tv-danmaku img')),false);
    assert.deepEqual(['onplay','onpause','onended','onerror','onseeking','onseeked'].map(k=>h.video[k]),before);
    assert.equal(h.preparations.length,1);assert.equal(h.document.querySelector('.tv-danmaku').hidden,false);
  } finally { h.dispose(); }
});

test('关闭仅Native.cancel弹幕id，独立在途视频仍可完成；迟到页不串入，重开正常', async () => {
  const h = await fixture();
  try {
    await h.ready();const first=h.official()[0];
    const media=h.api.axios({url:'https://hongguoduanju.com/video/controlled.mp4',media:true});
    const videoRequest=h.requests.find(r=>r.media);assert(videoRequest);
    const plays=h.video.playCalls,prepares=h.preparations.length;
    h.document.querySelector('#tv-danmaku').click();await h.flush();
    assert.deepEqual(h.cancelled,[first.id]);assert.equal(h.window.tvDanmaku.getState().enabled,false);
    assert.equal(h.items().length,0);assert.equal(h.video.playCalls,plays);assert.equal(h.preparations.length,prepares);assert.equal(h.video.paused,false);
    h.respond(first,rawPage(h.stage.dataset.vid,[[0,'旧请求不得出现']],true));
    h.respond(videoRequest,{complete:true});assert.equal((await media).status,200);await h.flush();
    h.timer(120);await h.flush();assert.equal(h.official().length,1);
    h.document.querySelector('#tv-danmaku').click();await h.flush();assert.equal(h.official().length,2);
    h.respond(h.official()[1],rawPage(h.stage.dataset.vid,[[0,'新请求']]));await h.flush();
    assert(h.items().some(n=>n.textContent==='新请求'));assert(!h.items().some(n=>n.textContent.includes('旧请求')));
  } finally { h.dispose(); }
});

test('暂停停移动，恢复和倍速只随媒体时钟；前后seek清旧轨迹与回放队列', async () => {
  const h = await fixture();
  try {
    await h.ready();h.respond(h.official()[0],rawPage(h.stage.dataset.vid,[[0,'开头'],[4.9,'同文'],[5,'同文'],[5.1,'同文'],[11,'后段']]));await h.flush();
    await h.move(0.2);const old=h.items()[0],x=old.style.transform;h.video.pause();await h.flush();
    assert.equal(old.style.transform,x);assert.equal(h.listenerCount(h.video,'pause'),h.originalPauseListeners+1);
    h.video.playbackRate=2;await h.video.play();await h.flush();await h.move(0.4);assert.notEqual(old.style.transform,x);
    h.video.currentTime=4.9;h.video.seeking=true;h.emit(h.video,'seeking');assert.equal(h.items().length,0);
    h.video.seeking=false;h.emit(h.video,'seeked');await h.flush();assert(h.items().some(n=>n.textContent==='同文 × 3'));
    assert(!h.items().some(n=>n.textContent==='开头'));
    h.video.currentTime=0;h.emit(h.video,'seeking');assert.equal(h.items().length,0);h.emit(h.video,'seeked');await h.flush();
    assert(h.items().some(n=>n.textContent==='开头'));assert(!h.items().some(n=>n.textContent==='后段'));
  } finally { h.dispose(); }
});

test('同vid重试换playbackId也取消旧请求、移除监听，旧事件和响应不影响新集', async () => {
  const h = await fixture();
  try {
    await h.ready();const oldRequest=h.official()[0],old=h.video,oldId=h.stage.dataset.playbackId;
    h.document.querySelector('#retry').click();await h.flush();
    assert(h.cancelled.includes(oldRequest.id));assert.equal(h.listenerCount(old,'timeupdate'),0);assert.equal(h.listenerCount(old,'seeked'),0);
    assert.notEqual(h.stage.dataset.playbackId,oldId);assert.equal(Boolean(h.stage.querySelector('video')),false);
    h.respond(oldRequest,rawPage(old.dataset.vid,[[0,'迟到旧集']]));h.emit(old,'timeupdate');await h.flush();assert.equal(h.items().length,0);
    h.preparations[1].resolve({url:'blob:retry',token:'retry',codec:'h264'});await h.flush();
    const next=h.stage.querySelector('video');next.readyState=1;h.emit(next,'loadedmetadata');next.readyState=2;next.videoWidth=720;next.videoHeight=1280;h.emit(next,'loadeddata');await h.flush();
    assert.equal(h.official().length,2,JSON.stringify({state:h.stage.dataset.playbackState,frame:next.dataset.frameReady,oldId,id:next.dataset.playbackId,readCount:h.reads.length,notice:h.notice()?.textContent}));assert.equal(next.dataset.vid,old.dataset.vid);
    h.respond(h.official()[1],rawPage(next.dataset.vid,[[0,'新会话']]));await h.flush();
    assert(h.items().some(n=>n.textContent==='新会话'));assert(!h.items().some(n=>n.textContent==='迟到旧集'));
  } finally { h.dispose(); }
});

test('跨集迟到、所有权不匹配、idle/error残留身份及节点移除均清自己的请求', async () => {
  for(const invalidation of ['next','id','vid','idle','error','remove']) {
    const h=await fixture();
    try {
      await h.ready();const request=h.official()[0],old=h.video;
      if(invalidation==='next')h.document.querySelector('#next').click();
      else if(invalidation==='id')h.stage.dataset.playbackId='new-session';
      else if(invalidation==='vid')h.stage.dataset.vid='99999999';
      else if(invalidation==='remove')old.remove();
      else h.stage.dataset.playbackState=invalidation;
      await h.flush();assert(h.cancelled.includes(request.id),invalidation);assert.equal(h.listenerCount(old,'timeupdate'),0,invalidation);
      h.respond(request,rawPage(old.dataset.vid,[[0,'迟到数据']]));h.emit(old,'timeupdate');await h.flush();
      assert.equal(h.items().length,0,invalidation);assert.equal(Boolean(h.document.querySelector('.tv-danmaku')),false,invalidation);
    } finally { h.dispose(); }
  }
});

test('空数据／HTTP失败／部分失败只影响弹幕状态；偏好开关可重试且不复播', async () => {
  for(const mode of ['empty','http','partial']) {
    const h=await fixture();
    try {
      await h.ready();const request=h.official()[0],plays=h.video.playCalls;
      h.respond(request,rawPage(h.stage.dataset.vid,mode==='partial'?[[0,'已取得']]:[],mode==='partial'),mode==='http'?503:200);await h.flush();
      if(mode==='partial'){h.timer(120);await h.flush();h.respond(h.official()[1],{},503);await h.flush();}
      assert.equal(h.stage.dataset.playbackState,'playing');assert.equal(h.video.paused,false);assert.equal(h.video.playCalls,plays);assert.equal(h.preparations.length,1);
      assert.match(h.notice().textContent,mode==='empty'?/本集暂无弹幕/:mode==='http'?/HTTP 503/:/后续弹幕加载中断/);
      if(mode!=='empty')assert.doesNotMatch(h.notice().textContent,/本集暂无弹幕/);
      if(mode==='http'){
        h.video.pause();const count=h.official().length;
        h.document.querySelector('#tv-danmaku').click();h.document.querySelector('#tv-danmaku').click();await h.flush();
        assert.equal(h.video.paused,true);assert.equal(h.video.playCalls,plays);
        assert.equal(h.official().length,count,'native failure TTL remains authoritative');
      }
    } finally { h.dispose(); }
  }
});

test('全屏和隐藏控制保持网页叠层，几何变化使用原resize，稀疏／normal消费实际connect', async () => {
  const h=await fixture();
  try {
    await h.ready();h.respond(h.official()[0],rawPage(h.stage.dataset.vid,[[0,'几何测试']]));await h.flush();
    const layer=h.document.querySelector('.tv-danmaku'),owner=layer.parentElement;
    h.document.querySelector('#tv-fullscreen').click();await h.flush();assert(h.document.body.classList.contains('tv-playing'));assert.equal(layer.parentElement,owner);
    const select=h.document.querySelector('#tv-danmaku-density');select.value='normal';h.emit(select,'change');await h.flush();assert.equal(h.window.tvDanmaku.getState().density,'normal');
    h.stage.rect={left:0,top:0,right:1920,bottom:900,width:1920,height:900};
    for(const observer of h.resizeObservers)observer.fn();await h.flush();
    assert(h.items().every(node=>node.style.transform.includes('translate(')));
    h.document.querySelector('#tv-controls').hidden=true;await h.flush();assert.equal(layer.isConnected,true);assert.equal(layer.hidden,false);
    assert.equal(h.official().length,1);assert.equal(h.preparations.length,1);
  } finally { h.dispose(); }
});

test('后台取消弹幕且前台不复播；pagehide移除自己监听、观察器、请求和叠层', async () => {
  const h=await fixture();
  try {
    await h.ready();const request=h.official()[0],plays=h.video.playCalls;
    h.document.hidden=true;h.document.dispatchEvent(new h.Event('visibilitychange'));await h.flush();
    assert(h.cancelled.includes(request.id));assert.equal(h.document.querySelector('.tv-danmaku').hidden,true);
    h.document.hidden=false;h.document.dispatchEvent(new h.Event('visibilitychange'));await h.flush();
    assert.equal(h.video.paused,true);assert.equal(h.video.playCalls,plays);const fresh=h.official()[1];assert(fresh);
    h.window.dispatchEvent(new h.Event('pagehide'));await h.flush();
    assert(h.cancelled.includes(fresh.id));assert.equal(Boolean(h.document.querySelector('.tv-danmaku')),false);assert.equal(h.listenerCount(h.video,'timeupdate'),0);
    assert.equal(h.resizeObservers.size,0);assert.equal(h.motionListeners.size,0);assert.equal(h.window.tvDanmaku.getState().available,false);
    h.respond(fresh,rawPage(h.stage.dataset.vid,[[0,'离页后迟到']]));await h.flush();assert.equal(h.items().length,0);
  } finally { h.dispose(); }
});

test('TV入口连真实消费者、仅TV映射fs/path；私有身份损坏不覆盖，缺失只创建白名单文件', async () => {
  const source=fs.readFileSync(path.join(root,'bundle.cjs'),'utf8');
  assert.match(source,/import '\.\/web\/tv\.js'.*connectTvDanmaku\(\)/);
  assert.match(source,/tv \? \{'node:fs':path\.join\(root,'mobile\/fs\.cjs'\), 'node:path':path\.join\(root,'mobile\/path\.cjs'\)\}/);
  for(const broken of [false,true]) {
    const h=await fixture();
    try {
      h.files.delete('danmaku.identity');if(broken)h.files.set('danmaku.identity',Buffer.from('{broken').toString('base64'));
      await h.ready();
      if(broken){assert.equal(h.official().length,0);assert.match(h.notice().textContent,/本机配置/);assert.deepEqual(h.writes,[]);}
      else {assert.equal(h.official().length,1);assert.deepEqual(h.writes,['danmaku.identity']);}
      assert(h.reads.every(name=>name==='danmaku.identity'));assert.equal(h.preparations.length,1);
    } finally { h.dispose(); }
  }
});
