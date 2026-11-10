import './app.js';
import {nextFocus, focusIdentity, restoreFocusIndex, keepsInputKey, currentVideo, routeMediaKey} from './tv-navigation.js';

const content = document.querySelector('#content');
const snapshots = new Map(), dialogs = new WeakMap();
let controls, binding, hideTimer, scheduled = 0, disposed = false, composing = false;
let restoring = false, lastPage = '', interactedPage = '', pendingRestore, lastControl = 'id:tv-play', wakeKey = '';
let manualHidden = false, lastFocus = '', danmakuConsumer;
const preferences = {enabled:true,density:'sparse'};
const page = () => content.dataset.tvPage || '';
const identity = el => focusIdentity(el,content.dataset.seriesId);
const stage = () => content.querySelector('#stage');
const modal = () => [...document.querySelectorAll('dialog[open]')].at(-1);
const fullscreen = () => document.body.classList.contains('tv-playing');
const toggleClass = (name,value) => {
  if (document.body.classList.contains(name) !== value) document.body.classList.toggle(name,value);
};
const text = (el,value) => { if (el && el.textContent !== value) el.textContent = value; };
const disable = (el,value) => { if (el && el.disabled !== value) el.disabled = value; };
const eligible = el => !el.matches(':disabled') && !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
  el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
const scope = () => modal() || (fullscreen() ? (controls?.hidden ? stage() : controls) : document);
const candidates = (root = scope()) => root ? [...root.querySelectorAll('button,input,select,summary')].filter(eligible) : [];
function focus(el,scroll = true) {
  if (!el) return;
  restoring = true;
  try {
    el.focus({preventScroll:true});
    if (!el.closest('dialog')) lastFocus = identity(el) || lastFocus;
    if (controls?.contains(el)) lastControl = identity(el) || lastControl;
    if (scroll) el.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  finally { restoring = false; }
}
function remember() {
  if (restoring || modal() || content.dataset.tvReady !== 'true') return;
  const old = snapshots.get(page());
  const key = eligible(document.activeElement) ? identity(document.activeElement) : old?.key;
  if (key) snapshots.set(page(),{key,keys:candidates(document).map(identity),x:window.scrollX,y:window.scrollY});
}
function schedule() {
  if (!disposed && !scheduled) scheduled = requestAnimationFrame(refresh);
}
function showControls(moveFocus = false) {
  if (!controls?.isConnected) return;
  controls.hidden = false; manualHidden = false;
  toggleClass('tv-controls-hidden',false);
  if (moveFocus) {
    const items = candidates(controls);
    focus(items.find(el => identity(el) === lastControl) || items[0],!fullscreen());
  }
  armHide();
}
function hideControls() {
  if (!controls?.isConnected || modal()) return;
  if (controls.contains(document.activeElement)) lastControl = identity(document.activeElement) || lastControl;
  clearTimeout(hideTimer); controls.hidden = true; manualHidden = true;
  toggleClass('tv-controls-hidden',true); focus(stage(),false);
}
function armHide() {
  clearTimeout(hideTimer);
  const s = stage(), v = currentVideo(s);
  if (!controls?.isConnected || controls.hidden || modal() || document.hidden || composing || document.activeElement?.matches('select') ||
      s?.dataset.playbackState !== 'playing' || v?.dataset.frameReady !== 'true' || v.paused || v.ended) return;
  const owner = binding;
  hideTimer = setTimeout(() => { if (binding === owner && !document.hidden) hideControls(); },4000);
}
function syncDanmaku() {
  const button = content.querySelector('#tv-danmaku'), density = content.querySelector('#tv-danmaku-density');
  disable(button,!danmakuConsumer); disable(density,!danmakuConsumer); disable(content.querySelector('#tv-density'),!danmakuConsumer);
  text(button,danmakuConsumer ? `弹幕：${preferences.enabled ? '开' : '关'}` : '弹幕未接入');
  if (button) button.setAttribute('aria-pressed',String(Boolean(danmakuConsumer && preferences.enabled)));
  if (density && density.value !== preferences.density) density.value = preferences.density;
}
function notifyDanmaku() {
  try { danmakuConsumer?.({...preferences}); }
  catch { danmakuConsumer = undefined; console.info('HG:tv:danmaku_callback_failed'); }
  syncDanmaku();
}
// T4 consumes preferences only; media ownership and official-feed requests stay outside T3.
window.tvDanmaku = {
  getState: () => ({...preferences,available:Boolean(danmakuConsumer)}),
  connect(consumer) {
    if (typeof consumer !== 'function') throw new TypeError('弹幕偏好消费者必须为函数');
    danmakuConsumer = consumer; notifyDanmaku();
    return () => { if (danmakuConsumer === consumer) { danmakuConsumer = undefined; syncDanmaku(); } };
  },
};
function button(parent,id,label,action) {
  const el = document.createElement('button'); el.id = id; el.textContent = label; el.onclick = action;
  parent.append(el); return el;
}
function openDialog(dialog,key = identity(document.activeElement) || lastFocus) {
  dialogs.set(dialog,{key,page:page(),x:window.scrollX,y:window.scrollY});
  dialog.showModal(); schedule();
}
function watchDialog(dialog) {
  if (dialog.dataset.tvWatched) return;
  dialog.dataset.tvWatched = 'true';
  dialog.addEventListener('close',() => {
    const entry = dialogs.get(dialog); dialogs.delete(dialog);
    if (dialog.id === 'tv-episode-dialog') {
      const home = content.querySelector('#tv-episodes-home'), grid = dialog.querySelector('.episodes');
      if (home && grid) home.replaceWith(grid);
    }
    if (entry?.page === page()) {
      if (controls?.hidden && entry.key.startsWith('id:tv-')) showControls();
      const items = candidates(); focus(items.find(el => identity(el) === entry.key) || items[0],false);
      if (!fullscreen()) window.scrollTo(entry.x,entry.y);
    }
    armHide(); schedule();
  });
}
function picker(select,id,title) {
  const dialog = document.createElement('dialog'); dialog.id = `${id}-dialog`; dialog.setAttribute('aria-label',title);
  const heading = document.createElement('h2'); heading.textContent = title; dialog.append(heading);
  const entry = button(select.parentElement,id,title,() => { openDialog(dialog,`id:${id}`); focus(select); });
  select.before(entry); dialog.append(select);
  button(dialog,`${id}-close`,'返回播放控制',() => dialog.close());
  content.append(dialog); watchDialog(dialog);
}
function createControls(s) {
  controls = document.createElement('section'); controls.id = 'tv-controls'; controls.setAttribute('aria-label','播放控制');
  const row = document.createElement('div'); row.className = 'row'; controls.append(row);
  button(row,'tv-rewind','后退10秒',() => window.tvKey('MediaRewind'));
  button(row,'tv-play','播放／暂停',() => window.tvKey('MediaPlayPause'));
  button(row,'tv-forward','前进10秒',() => window.tvKey('MediaFastForward'));
  button(row,'tv-fullscreen','全屏／退出',() => {
    toggleClass('tv-playing',!fullscreen()); showControls(true);
  });
  const tools = content.querySelector('.player-tools'); if (tools) controls.append(tools);
  const speed = tools?.querySelector('#speed'); if (speed) picker(speed,'tv-speed','倍速');
  const dialog = document.createElement('dialog'); dialog.id = 'tv-episode-dialog'; dialog.setAttribute('aria-label','选集');
  const heading = document.createElement('h2'); heading.textContent = '选集'; dialog.append(heading);
  button(dialog,'tv-close-episodes','关闭选集',() => dialog.close());
  dialog.addEventListener('click',event => { if (event.target.closest('[data-episode]')) dialog.close(); });
  content.append(dialog); watchDialog(dialog);
  button(tools || row,'tv-episodes','选集',() => {
    const grid = content.querySelector('.episodes'); if (!grid) return;
    const home = document.createElement('div'); home.id = 'tv-episodes-home'; grid.before(home); dialog.append(grid);
    openDialog(dialog,'id:tv-episodes'); focus(grid.querySelector('[aria-current="true"]') || grid.querySelector('button'));
  });
  button(tools || row,'tv-danmaku','弹幕未接入',() => { preferences.enabled = !preferences.enabled; notifyDanmaku(); });
  const density = document.createElement('select'); density.id = 'tv-danmaku-density'; density.setAttribute('aria-label','弹幕密度');
  for (const [value,label] of [['sparse','稀疏弹幕'],['normal','正常密度']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; density.append(option);
  }
  density.value = preferences.density;
  density.onchange = () => { preferences.density = density.value === 'normal' ? 'normal' : 'sparse'; notifyDanmaku(); };
  (tools || row).append(density); picker(density,'tv-density','弹幕密度'); s.after(controls); s.tabIndex = -1;
  syncDanmaku();
}
function unbind() {
  clearTimeout(hideTimer);
  if (binding?.video) for (const name of ['play','pause','ended','error','loadeddata','seeked']) binding.video.removeEventListener(name,schedule);
  binding = undefined;
}
function syncPlayer() {
  const s = stage(), v = currentVideo(s);
  if (!s) {
    unbind(); controls = undefined; toggleClass('tv-playing',false); toggleClass('tv-controls-hidden',false); return;
  }
  if (!controls?.isConnected) createControls(s);
  const changed = binding?.stage !== s || binding?.id !== s.dataset.playbackId || binding?.vid !== s.dataset.vid;
  const stateChanged = binding?.state !== s.dataset.playbackState;
  if (changed || binding?.video !== v) {
    unbind(); binding = {stage:s,id:s.dataset.playbackId,vid:s.dataset.vid,video:v};
    if (v) {
      v.controls = false;
      for (const name of ['play','pause','ended','error','loadeddata','seeked']) v.addEventListener(name,schedule);
    }
  }
  binding.state = s.dataset.playbackState;
  disable(content.querySelector('#tv-play'),!v && s.dataset.playbackState !== 'preparing');
  disable(content.querySelector('#tv-rewind'),!v || !Number.isFinite(v.duration));
  disable(content.querySelector('#tv-forward'),!v || !Number.isFinite(v.duration));
  if (changed || stateChanged && ['idle','error'].includes(binding.state)) showControls();
  else if (!manualHidden && (!v || v.paused || document.hidden)) showControls();
  if (stateChanged && binding.state === 'error' && !modal() &&
      !candidates().includes(document.activeElement)) focus(content.querySelector('#retry'),!fullscreen());
  armHide();
}
function refresh() {
  scheduled = 0; if (disposed) return;
  syncPlayer();
  const dialog = modal();
  if (dialog) {
    if (!dialogs.has(dialog)) dialogs.set(dialog,{key:lastFocus,page:page(),x:window.scrollX,y:window.scrollY});
    watchDialog(dialog);
  }
  if (page() !== lastPage) { lastPage = page(); pendingRestore = interactedPage === lastPage ? undefined : snapshots.get(lastPage); }
  const items = candidates();
  if (dialog) {
    if (!items.includes(document.activeElement)) focus(items[0] || dialog);
    return;
  }
  if (content.dataset.tvReady === 'true' && pendingRestore) {
    const saved = pendingRestore; pendingRestore = undefined;
    focus(items[restoreFocusIndex(items.map(identity),saved.key,saved.keys)],false);
    window.scrollTo(saved.x,saved.y);
  } else if (!items.includes(document.activeElement) && !(controls?.hidden && document.activeElement === stage())) {
    const saved = snapshots.get(page());
    const target = saved && content.dataset.tvReady === 'true' ? items[restoreFocusIndex(items.map(identity),saved.key,saved.keys)] :
      items.find(el => el.matches('#back,.card')) || items[0];
    focus(target || stage());
  }
}
const observer = new MutationObserver(schedule);
observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:[
  'open','hidden','disabled','inert','aria-hidden','class','data-tv-page','data-tv-ready','data-playback-id','data-vid','data-playback-state','data-frame-ready',
]});
content.addEventListener('tv-before-render',() => {
  remember();
  if (content.dataset.tvReady === 'true') interactedPage = '';
});
window.addEventListener('scroll',() => { if (page() === lastPage && !pendingRestore) remember(); });
document.addEventListener('focusin',() => {
  if (restoring) return;
  const active = document.activeElement;
  if (modal() && !modal().contains(active)) { schedule(); return; }
  interactedPage = page(); pendingRestore = undefined;
  if (!active.closest('dialog')) lastFocus = identity(active) || lastFocus;
  if (controls?.contains(active)) { lastControl = identity(active) || lastControl; armHide(); }
  remember();
});
document.addEventListener('compositionstart',() => { composing = true; clearTimeout(hideTimer); });
document.addEventListener('compositionend',() => { composing = false; armHide(); });
document.addEventListener('input',() => { interactedPage = page(); pendingRestore = undefined; });
document.addEventListener('submit',event => {
  if (composing) { event.preventDefault(); event.stopImmediatePropagation(); }
},true);
window.tvKey = (key,repeat = false) => {
  if (modal()) return false;
  const handled = routeMediaKey(stage(),key,repeat,() => window.pausePlayback());
  if (handled) { showControls(); schedule(); }
  return handled;
};
document.addEventListener('keydown',event => {
  const active = document.activeElement;
  interactedPage = page(); pendingRestore = undefined;
  if (keepsInputKey(active,event.key,composing || event.isComposing,event.keyCode)) return;
  if (wakeKey && event.key === wakeKey) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  if (window.tvKey(event.key,event.repeat)) { event.preventDefault(); return; }
  if (['Enter',' ','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
    pendingRestore = undefined;
    if (controls?.hidden && !modal() && (fullscreen() || active === stage())) {
      wakeKey = event.key; showControls(true); event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    armHide();
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.repeat) { event.preventDefault(); return; }
  if (event.key === 'Escape' && !active?.matches('input,textarea,select')) {
    if (window.appBack()) event.preventDefault(); return;
  }
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  const items = candidates();
  focus(items[nextFocus(items.map(el => el.getBoundingClientRect()),items.indexOf(active),event.key)]);
  remember(); event.preventDefault();
},true);
document.addEventListener('keyup',event => {
  if (event.key === wakeKey) { wakeKey = ''; event.preventDefault(); event.stopImmediatePropagation(); }
},true);
const back = window.appBack;
window.appBack = () => {
  if (composing) return true;
  const dialog = modal();
  if (dialog) { dialog.close(); return true; }
  if (fullscreen() && controls?.isConnected && !controls.hidden) { hideControls(); return true; }
  if (fullscreen()) { toggleClass('tv-playing',false); showControls(true); return true; }
  return back();
};
window.addEventListener('pagehide',() => {
  disposed = true; observer.disconnect(); cancelAnimationFrame(scheduled); scheduled = 0;
  unbind(); danmakuConsumer = undefined;
});
document.querySelector('header small').textContent = '方向键选择 · 确认键打开 · 返回键退出当前层';
document.querySelector('#about').onclick = () => openDialog(document.querySelector('#info'),'id:about');
document.querySelector('#info p:last-of-type').textContent = '基于项目源码移植，保留GPL及第三方授权。电视真机播放与遥控器兼容性待验收。';
refresh();
