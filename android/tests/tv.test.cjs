const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../web/tv-navigation.js'), 'utf8');
  const module = {exports:{}};
  vm.runInNewContext(source, {module});
  return module.exports;
}
const box = (x,y,w=100,h=60) => ({left:x,top:y,right:x+w,bottom:y+h,width:w,height:h});
const {mount} = require('./tv-dom-fixture.cjs');

test('TV方向键优先同行／同列，不绕到反方向，动态移除后仍可恢复焦点', () => {
  const {nextFocus} = load();
  const cells = [box(0,0),box(120,0),box(240,0),box(0,100),box(120,100)];
  assert.equal(nextFocus(cells,0,'ArrowRight'),1);
  assert.equal(nextFocus(cells,1,'ArrowDown'),4);
  assert.equal(nextFocus(cells,4,'ArrowUp'),1);
  assert.equal(nextFocus(cells,2,'ArrowRight'),2);
  assert.equal(nextFocus(cells,-1,'ArrowDown'),0);
  assert.equal(nextFocus([],0,'ArrowDown'),-1);
});

test('TV播放键暂停与恢复，快进不越界，确认键不在长按时重复执行', () => {
  const {handleMediaKey} = load();
  const video = {paused:true,currentTime:8,duration:12,play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;}};
  assert.equal(handleMediaKey(video,'MediaPlayPause',false),true);
  assert.equal(video.paused,false);
  handleMediaKey(video,'MediaPlayPause',true);
  assert.equal(video.paused,false);
  handleMediaKey(video,'MediaPlayPause',false);
  assert.equal(video.paused,true);
  handleMediaKey(video,'MediaFastForward',false);
  assert.equal(video.currentTime,12);
  handleMediaKey(video,'MediaRewind',false);
  assert.equal(video.currentTime,2);
  assert.equal(handleMediaKey(video,'ArrowDown',false),false);
  assert.equal(handleMediaKey(null,'MediaPlayPause',false),false);
});

test('业务身份不依赖DOM节点或选集数组下标，移除后选择相邻业务项', () => {
  const {focusIdentity,restoreFocusIndex} = load();
  assert.equal(typeof focusIdentity,'function','TV需要稳定业务焦点身份');
  const el = (dataset={},id='') => ({dataset,id});
  assert.equal(focusIdentity(el({series:'123'}),'999'),'series:123');
  assert.equal(focusIdentity(el({episode:'2',vid:'789'}),'123'),'episode:123:789');
  assert.equal(focusIdentity(el({episode:'99',vid:'789'}),'123'),'episode:123:789');
  assert.equal(focusIdentity(el({},'retry'),'123'),'id:retry');
  assert.equal(restoreFocusIndex(['series:2','series:3'],'series:1',['series:1','series:2','series:3']),0);
  assert.equal(restoreFocusIndex(['series:2','series:3'],'series:3',[]),1);
  assert.equal(restoreFocusIndex([],'gone',[]),-1);
});

test('文本左右、select和组合输入保留原生行为，普通按钮四向仍可遥控', () => {
  const {keepsInputKey} = load();
  assert.equal(typeof keepsInputKey,'function','输入法必须先于遥控路由让行');
  const input={tagName:'INPUT'},select={tagName:'SELECT'},button={tagName:'BUTTON'};
  assert.equal(keepsInputKey(input,'ArrowLeft',false,0),true);
  assert.equal(keepsInputKey(input,'ArrowDown',false,0),false);
  assert.equal(keepsInputKey(select,'ArrowDown',false,0),true);
  assert.equal(keepsInputKey(button,'Enter',true,0),true);
  assert.equal(keepsInputKey(input,'Enter',false,229),true);
  assert.equal(keepsInputKey(button,'ArrowDown',false,0),false);
});

test('当前媒体按playbackId和vid双匹配，旧节点、错误及空闲身份无效', () => {
  const {currentVideo} = load();
  assert.equal(typeof currentVideo,'function','媒体动作不得闭包持有旧video');
  const video={isConnected:true,dataset:{playbackId:'opaque-a',vid:'123',frameReady:'false'}};
  const stage={isConnected:true,dataset:{playbackId:'opaque-a',vid:'123',playbackState:'decoding'},querySelector:()=>video};
  assert.equal(currentVideo(stage),video,'元数据阶段仍可明确播放出帧');
  stage.dataset.playbackId='opaque-b';assert.equal(currentVideo(stage),null,'同vid重试也必须换绑');
  video.dataset.playbackId='opaque-b';assert.equal(currentVideo(stage),video);
  for(const state of ['error','idle']){stage.dataset.playbackState=state;assert.equal(currentVideo(stage),null);}
  stage.dataset.playbackState='playing';video.isConnected=false;assert.equal(currentVideo(stage),null);
});

test('准备无video的暂停确实走T2暂停意图，长按只消费，不新建准备或误恢复', () => {
  const {routeMediaKey} = load();
  assert.equal(typeof routeMediaKey,'function','准备期媒体暂停必须有真实路由');
  let pauses=0;
  const stage={isConnected:true,dataset:{playbackId:'s1',vid:'123',playbackState:'preparing'},querySelector:()=>null};
  assert.equal(routeMediaKey(stage,'MediaPause',false,()=>pauses++),true);
  assert.equal(routeMediaKey(stage,'MediaPlayPause',false,()=>pauses++),true);
  assert.equal(routeMediaKey(stage,'MediaPlayPause',true,()=>pauses++),true);
  assert.equal(routeMediaKey(stage,'MediaPlay',false,()=>pauses++),true);
  assert.equal(pauses,2);
  assert.equal(routeMediaKey(null,'MediaPause',false,()=>pauses++),false);
  stage.dataset.playbackState='error';assert.equal(routeMediaKey(stage,'MediaPlay',false,()=>pauses++),false);
});

test('四个方向均不在边界反跳，跨行选择保持同列', () => {
  const {nextFocus}=load();
  const cells=[box(0,0),box(120,0),box(0,100),box(120,100)];
  assert.equal(nextFocus(cells,0,'ArrowLeft'),0);
  assert.equal(nextFocus(cells,0,'ArrowUp'),0);
  assert.equal(nextFocus(cells,3,'ArrowRight'),3);
  assert.equal(nextFocus(cells,3,'ArrowDown'),3);
  assert.equal(nextFocus(cells,3,'ArrowLeft'),2);
  assert.equal(nextFocus(cells,2,'ArrowUp'),0);
});

test('实际页面返回原列表业务卡与滚动，重绘后仍是新节点', async () => {
  const h=await mount();const d=h.document;
  const card=d.querySelectorAll('[data-series]')[12];assert(card);
  card.focus();h.window.scrollTo(0,480);const id=card.dataset.series;
  card.click();await h.flush();assert(d.querySelector('#stage'));
  d.querySelector('#back').click();await h.flush();
  assert.notEqual(d.activeElement,card);
  assert.equal(d.activeElement.dataset.series,id);
  assert.equal(h.window.scrollY,480);
});

test('弹层限制焦点，按钮关闭及返回都归位；组合输入不抢键', async () => {
  const h=await mount(),d=h.document;
  const input=d.querySelector('input');input.focus();
  assert.equal(h.key('ArrowLeft').defaultPrevented,false);
  assert.equal(h.key('ArrowDown',{isComposing:true}).defaultPrevented,false);
  const about=d.querySelector('#about');about.focus();about.click();await h.flush();
  assert(d.activeElement.closest('dialog[open]'));
  d.querySelector('[data-tab="history"]').focus();await h.flush();
  assert(d.activeElement.closest('dialog[open]'),'背景控件不能夺走模态焦点');
  d.querySelector('#close-info').click();await h.flush();assert.equal(d.activeElement.id,'about');
  about.click();await h.flush();assert.equal(h.window.appBack(),true);await h.flush();assert.equal(d.activeElement.id,'about');
});

test('准备暂停、全屏控制单次唤醒、选集与返回层级不修改T2媒体职责', async () => {
  const h=await mount(),d=h.document;d.querySelector('[data-series]').click();await h.flush();
  assert(d.querySelector('#tv-controls'),'尚无video也应有重试和选集控制');
  d.querySelector('[data-episode]').click();await h.flush();
  let pauses=0;const original=h.window.pausePlayback;h.window.pausePlayback=()=>{pauses++;original();};
  assert.equal(h.window.tvKey('MediaPause'),true);assert.equal(pauses,1);
  d.querySelector('#tv-fullscreen').click();await h.flush();
  assert(d.body.classList.contains('tv-playing'));
  assert.equal(h.window.appBack(),true);await h.flush();assert(d.querySelector('#tv-controls').hidden);
  const wake=h.key('Enter');assert(wake.defaultPrevented);assert(!d.querySelector('#tv-controls').hidden);
  assert(h.key('Enter',{repeat:true}).defaultPrevented);h.up('Enter');
  d.querySelector('#tv-episodes').click();await h.flush();assert(d.querySelector('#tv-episode-dialog').open);
  h.window.appBack();await h.flush();assert.equal(d.activeElement.id,'tv-episodes');
  h.window.appBack();await h.flush();assert(d.querySelector('#tv-controls').hidden);
  h.window.appBack();await h.flush();assert(!d.body.classList.contains('tv-playing'));assert(d.querySelector('#stage'));
  h.window.appBack();await h.flush();assert(d.querySelector('#stage') === null,'退出全屏后下一次返回应离开详情，不再重复收起内联控件');
});

test('T4仅连接偏好接口，未接入不可假装弹幕可用，回调失败也不动视频', async () => {
  const h=await mount(),d=h.document;d.querySelector('[data-series]').click();await h.flush();
  const toggle=d.querySelector('#tv-danmaku');assert(toggle);
  assert.equal(toggle.disabled,true);
  const changes=[];const disconnect=h.window.tvDanmaku.connect(value=>changes.push(value));
  assert.equal(toggle.disabled,false);toggle.click();
  assert.equal(changes.length,2);assert.equal(changes[1].enabled,!changes[0].enabled);
  const density=d.querySelector('#tv-danmaku-density');density.value='normal';density.dispatchEvent(new h.Event('change'));
  assert.equal(changes.at(-1).density,'normal');disconnect();assert.equal(toggle.disabled,true);
  assert.equal(h.preparations.length,0,'偏好连接或切换不能启动媒体准备');
  h.window.tvDanmaku.connect(()=>{throw new Error('fixture');});assert.equal(toggle.disabled,true);
});

test('返回第二页与搜索结果均保留作用域，不串到第一页；迟到列表不抢输入焦点', async () => {
  const h=await mount(),d=h.document;
  d.querySelector('#next-page').click();await h.flush();
  const card=d.querySelectorAll('[data-series]')[10],id=card.dataset.series;
  card.focus();h.window.scrollTo(0,600);card.click();await h.flush();
  d.querySelector('#back').click();await h.flush();
  assert.equal(d.activeElement.dataset.series,id);assert.equal(h.window.scrollY,600);
  assert.equal(JSON.parse(d.querySelector('#content').dataset.tvPage)[3],2);
  d.querySelector('#search-input').value='fixture query';d.querySelector('form').onsubmit({preventDefault(){}});await h.flush();
  assert.equal(JSON.parse(d.querySelector('#content').dataset.tvPage)[2],'fixture query');
  const searchCard=d.querySelectorAll('[data-series]')[5];searchCard.focus();searchCard.click();await h.flush();
  h.holdRequests();d.querySelector('#back').click();await h.flush();
  d.querySelector('#search-input').focus();h.key('ArrowLeft');
  h.deliver();await h.flush();assert.equal(d.activeElement.id,'search-input','用户已编辑时迟到结果不得抢焦点');
});

test('收藏同步重绘返回仍保留滚动，已移除卡片按业务邻项回退', async () => {
  const h=await mount(),d=h.document;
  const rows=Array.from({length:24},(_,i)=>({series_id:String(4000000+i),series_title:'fixture',cover:''}));
  h.stored.set('favorites',JSON.stringify(rows));d.querySelector('[data-tab="favorites"]').click();await h.flush();
  const card=d.querySelectorAll('[data-series]')[10];card.focus();h.window.scrollTo(0,520);card.click();await h.flush();
  d.querySelector('#favorite').click();d.querySelector('#back').click();await h.flush();
  assert.equal(h.window.scrollY,520);
  assert.equal(d.activeElement.dataset.series,rows[11].series_id,'已删除业务卡应落到原邻卡');
});

test('禁用、隐藏祖先与visibility控件不参与方向导航，模态取消归位', async () => {
  const h=await mount(),d=h.document;
  const buttons=d.querySelectorAll('[data-category]');
  buttons[0].rect=box(0,0);buttons[1].rect=box(120,0);buttons[2].rect=box(240,0);
  buttons[0].focus();buttons[1].disabled=true;h.key('ArrowRight');assert.notEqual(d.activeElement,buttons[1]);
  buttons[1].disabled=false;buttons[1].setAttribute('data-invisible','true');buttons[0].focus();h.key('ArrowRight');assert.notEqual(d.activeElement,buttons[1]);
  d.querySelector('.categories').hidden=true;buttons[1].focus();h.key('ArrowDown');assert(!d.activeElement.closest('[hidden]'));
  const about=d.querySelector('#about');about.focus();about.click();await h.flush();
  const dialog=d.querySelector('#info');const cancel=new h.Event('cancel',{cancelable:true});dialog.dispatchEvent(cancel);if(!cancel.defaultPrevented)dialog.close();
  await h.flush();assert.equal(d.activeElement.id,'about');
});

test('选集原节点复用且无重复绑定，同vid重试撤销旧监听并只操作新video', async () => {
  const h=await mount(),d=h.document;d.querySelector('[data-series]').click();await h.flush();
  const episode=d.querySelector('[data-episode]');episode.click();await h.flush();
  h.preparations[0].resolve({token:'fixture-one',url:'blob:fixture-one'});await h.flush();
  const first=d.querySelector('video'),saved={play:first.onplay,pause:first.onpause,ended:first.onended,error:first.onerror};
  first.readyState=2;first.videoWidth=720;first.videoHeight=1280;
  first.dispatchEvent(new h.Event('loadedmetadata'));first.dispatchEvent(new h.Event('loadeddata'));await h.flush();
  assert.equal(first.onplay,saved.play);assert.equal(first.onpause,saved.pause);assert.equal(first.onended,saved.ended);assert.equal(first.onerror,saved.error);
  d.querySelector('#tv-forward').click();assert.equal(first.currentTime,10);
  d.querySelector('#tv-rewind').click();assert.equal(first.currentTime,0);
  const speed=d.querySelector('#speed');speed.value='1.5';speed.dispatchEvent(new h.Event('change'));assert.equal(first.playbackRate,1.5);
  const oldId=first.dataset.playbackId,oldCalls=first.playCalls;
  d.querySelector('#retry').click();await h.flush();
  assert.notEqual(d.querySelector('#stage').dataset.playbackId,oldId);assert.equal(h.listenerCount(first,'pause'),0);
  h.window.tvKey('MediaPlay');assert.equal(first.playCalls,oldCalls);
  h.preparations[1].resolve({token:'fixture-two',url:'blob:fixture-two'});await h.flush();
  const second=d.querySelector('video');assert.notEqual(second,first);assert.equal(second.controls,false);
  second.readyState=2;second.videoWidth=720;second.videoHeight=1280;second.dispatchEvent(new h.Event('loadedmetadata'));second.dispatchEvent(new h.Event('loadeddata'));await h.flush();
  d.querySelector('#tv-forward').click();assert.equal(second.currentTime,10);assert.equal(first.currentTime,0);
  d.querySelector('#tv-episodes').focus();d.querySelector('#tv-episodes').click();await h.flush();
  assert.equal(d.querySelectorAll('[data-episode]')[0],episode);
  h.window.appBack();await h.flush();assert.equal(d.querySelectorAll('[data-episode]')[0],episode);
  d.querySelector('#next').click();await h.flush();assert.equal(h.preparations.length,3);
});

test('真实T2暂停意图跨准备保留，自动隐藏首键不执行动作，pagehide撤销自身监听', async () => {
  const h=await mount(),d=h.document;d.querySelector('[data-series]').click();await h.flush();
  d.querySelector('[data-episode]').click();await h.flush();h.window.tvKey('MediaPause');
  h.preparations[0].resolve({token:'fixture',url:'blob:fixture'});await h.flush();
  const video=d.querySelector('video');video.readyState=2;video.videoWidth=720;video.videoHeight=1280;
  video.dispatchEvent(new h.Event('loadedmetadata'));video.dispatchEvent(new h.Event('loadeddata'));await h.flush();
  assert.equal(video.playCalls,0,'准备期暂停不能被metadata恢复');
  h.window.tvKey('MediaPlay');await h.flush();assert.equal(video.playCalls,1);
  d.querySelector('#tv-fullscreen').click();await h.flush();h.timer(4000);await h.flush();
  assert(d.querySelector('#tv-controls').hidden);const calls=video.playCalls;
  h.key('Enter');h.key('Enter',{repeat:true});h.up('Enter');assert.equal(video.playCalls,calls);
  d.hidden=true;d.dispatchEvent(new h.Event('visibilitychange'));await h.flush();d.hidden=false;d.dispatchEvent(new h.Event('visibilitychange'));await h.flush();
  assert.equal(video.paused,true);assert.equal(video.playCalls,calls);
  h.window.dispatchEvent(new h.Event('pagehide'));await h.flush();assert.equal(h.listenerCount(video,'pause'),0);
});

test('详情加载失败的重试具有稳定身份，组合输入不能提交或返回页面', async () => {
  const h=await mount(),d=h.document;
  const form=d.querySelector('form');d.querySelector('input').focus();
  d.dispatchEvent(new h.Event('compositionstart'));
  const submit=new h.Event('submit',{bubbles:true});form.dispatchEvent(submit);
  assert(submit.defaultPrevented);assert(h.window.appBack());assert(!d.querySelector('#back'));
  d.dispatchEvent(new h.Event('compositionend'));
  const request=h.context.Native.request;
  h.context.Native.request=id=>queueMicrotask(()=>h.context.__nativeResponse(id,JSON.stringify({status:503,data:'',headers:{}})));
  d.querySelector('[data-series]').click();await h.flush();
  const retry=d.querySelector('#detail-retry');assert(retry,'失败重试必须可按身份恢复');
  assert.equal(d.querySelector('#content').dataset.tvReady,'true');
  h.context.Native.request=request;retry.focus();retry.click();await h.flush();assert(d.querySelector('#stage'));
});

test('T2自动下一集后焦点有效，末集禁用按钮不再留下焦点', async () => {
  const h=await mount(),d=h.document;d.querySelector('[data-series]').click();await h.flush();
  d.querySelectorAll('[data-episode]')[1].click();await h.flush();
  h.preparations[0].resolve({token:'fixture',url:'blob:fixture'});await h.flush();
  const v=d.querySelector('video');v.readyState=2;v.videoWidth=720;v.videoHeight=1280;
  v.dispatchEvent(new h.Event('loadedmetadata'));v.dispatchEvent(new h.Event('loadeddata'));await h.flush();
  d.querySelector('#next').focus();v.ended=true;v.dispatchEvent(new h.Event('ended'));await h.flush();
  assert.equal(h.preparations.length,2);assert.equal(d.querySelector('#next').disabled,true);
  assert(d.activeElement.isConnected);assert.equal(d.activeElement.disabled,false);
  assert(d.querySelector('#tv-controls').contains(d.activeElement),'连播焦点留在有效播放器控件');
});

test('隐藏控制时解码失败仍回到可操作重试，不保留失效stage焦点', async () => {
  const h=await mount(),d=h.document;d.querySelector('[data-series]').click();await h.flush();
  d.querySelector('[data-episode]').click();await h.flush();h.preparations[0].resolve({token:'fixture',url:'blob:fixture'});await h.flush();
  const v=d.querySelector('video');d.querySelector('#tv-fullscreen').click();await h.flush();h.window.appBack();await h.flush();
  v.dispatchEvent(new h.Event('error'));await h.flush();
  assert.equal(d.querySelector('#stage').dataset.playbackState,'error');
  assert.equal(d.activeElement.id,'retry');assert.equal(d.querySelector('#tv-controls').hidden,false);
  d.activeElement.click();await h.flush();assert.equal(h.preparations.length,2);
});

test('倍速和密度从遥控按钮进入原生select弹层，返回归位而非困在select方向键', async () => {
  const h=await mount(),d=h.document;d.querySelector('[data-series]').click();await h.flush();
  const speedButton=d.querySelector('#tv-speed');assert(speedButton,'倍速select需要可离开的遥控入口');
  const select=d.querySelector('#speed'),handler=select.onchange;
  speedButton.focus();speedButton.click();await h.flush();assert(d.querySelector('#tv-speed-dialog').open);
  assert.equal(d.activeElement,select);assert.equal(h.key('ArrowDown').defaultPrevented,false);assert.equal(select.onchange,handler);
  h.window.appBack();await h.flush();assert.equal(d.activeElement.id,'tv-speed');
  h.window.tvDanmaku.connect(()=>{});const density=d.querySelector('#tv-density');assert.equal(density.disabled,false);
  density.focus();density.click();await h.flush();assert(d.querySelector('#tv-density-dialog').open);
  h.window.appBack();await h.flush();assert.equal(d.activeElement.id,'tv-density');
});

test('R1 有效选集焦点不被延后error夺走，下一确认打开选集而非多准备', async t => {
  const h=await mount(),d=h.document;t.after(()=>h.window.dispatchEvent(new h.Event('pagehide')));
  d.querySelector('[data-series]').click();await h.flush();
  d.querySelector('[data-episode]').click();await h.flush();
  h.preparations[0].reject(new Error('fixture prepare failed'));
  // Let T2 finish the rejected preparation, but keep the TV refresh queued.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(d.querySelector('#stage').dataset.playbackState,'error');
  const target=d.querySelector('#tv-episodes');target.focus();
  assert.equal(target.isConnected,true);assert.equal(target.disabled,false);assert(target.getClientRects().length>0);
  await h.flush();const focused=d.activeElement.id;
  const confirmation=h.key('Enter');
  if(!confirmation.defaultPrevented)d.activeElement.click(); // Node has no browser default Enter click.
  h.up('Enter');await h.flush();
  assert.deepEqual({focused,opened:d.querySelector('#tv-episode-dialog').open,preparations:h.preparations.length},
    {focused:'tv-episodes',opened:true,preparations:1});
});

test('R1 error刷新保留有效重试、倍速和上下集控制焦点', async t => {
  for(const id of ['retry','tv-speed','previous','next']) {
    const h=await mount(),d=h.document;t.after(()=>h.window.dispatchEvent(new h.Event('pagehide')));
    d.querySelector('[data-series]').click();await h.flush();d.querySelectorAll('[data-episode]')[1].click();await h.flush();
    h.preparations[0].reject(new Error('fixture prepare failed'));await new Promise(resolve=>setImmediate(resolve));
    const target=d.querySelector('#'+id);assert.equal(target.disabled,false);target.focus();await h.flush();
    assert.equal(d.activeElement.id,id);assert.equal(h.preparations.length,1);
    if(id==='retry'){d.activeElement.click();await h.flush();assert.equal(h.preparations.length,2,'明确选择重试仍可重新准备');}
  }
});

test('R1 error时实际禁用、隐藏或丢失焦点仍归位可操作重试', async t => {
  for(const kind of ['disabled','hidden','removed','body']) {
    const h=await mount(),d=h.document;t.after(()=>h.window.dispatchEvent(new h.Event('pagehide')));
    d.querySelector('[data-series]').click();await h.flush();d.querySelector('[data-episode]').click();await h.flush();
    const target=d.querySelector(kind==='disabled'?'#tv-play':'#tv-speed');target.focus();
    if(kind==='hidden')target.hidden=true;
    if(kind==='removed')target.remove();
    if(kind==='body')d.body.focus();
    h.preparations[0].reject(new Error('fixture prepare failed'));await new Promise(resolve=>setImmediate(resolve));
    await h.flush();assert.equal(d.activeElement.id,'retry',kind);assert.equal(d.activeElement.disabled,false);
    assert.equal(h.preparations.length,1);
  }
});

test('R1 error更新不越过有效选集模态，关闭仍回原入口', async t => {
  const h=await mount(),d=h.document;t.after(()=>h.window.dispatchEvent(new h.Event('pagehide')));
  d.querySelector('[data-series]').click();await h.flush();d.querySelector('[data-episode]').click();await h.flush();
  const entry=d.querySelector('#tv-episodes');entry.focus();entry.click();await h.flush();
  const vid=d.activeElement.dataset.vid;
  h.preparations[0].reject(new Error('fixture prepare failed'));await new Promise(resolve=>setImmediate(resolve));await h.flush();
  assert.equal(d.querySelector('#tv-episode-dialog').open,true);assert.equal(d.activeElement.dataset.vid,vid);
  assert(d.activeElement.closest('dialog[open]'));h.window.appBack();await h.flush();
  assert.equal(d.activeElement.id,'tv-episodes');assert.equal(h.preparations.length,1);
});
