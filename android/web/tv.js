import './app.js';
import {nextFocus, handleMediaKey} from './tv-navigation.js';

const content = document.querySelector('#content');
const candidates = () => [...(document.querySelector('dialog[open]') || (document.body.classList.contains('tv-playing') ? document.querySelector('#tv-controls') : null) || document).querySelectorAll('button,input,select,summary')]
  .filter(el => !el.disabled && !el.hidden && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
const focus = el => { el?.focus({preventScroll:true}); el?.scrollIntoView({block:'nearest',inline:'nearest'}); };
let scheduled = false;
const refresh = () => {
  scheduled = false;
  const video = content.querySelector('video');
  if (video && !document.querySelector('#tv-controls')) {
    video.controls = false;
    const controls = document.createElement('div'); controls.id = 'tv-controls'; controls.className = 'row';
    for (const [label,key] of [['后退10秒','MediaRewind'],['播放／暂停','MediaPlayPause'],['前进10秒','MediaFastForward']]) {
      const button = document.createElement('button'); button.textContent = label;
      button.onclick = () => handleMediaKey(video,key,false); controls.append(button);
    }
    const full = document.createElement('button'); full.textContent = '全屏／退出';
    full.onclick = () => document.body.classList.toggle('tv-playing'); controls.append(full);
    video.parentElement.after(controls);
  } else if (!video) {
    document.querySelector('#tv-controls')?.remove(); document.body.classList.remove('tv-playing');
  }
  if (!candidates().includes(document.activeElement)) focus(candidates().find(el => el.matches('#back,.card')) || candidates()[0]);
};
new MutationObserver(() => {
  if (!scheduled) { scheduled = true; requestAnimationFrame(refresh); }
}).observe(content,{childList:true,subtree:true});

window.tvKey = (key, repeat = false) => {
  if (document.querySelector('dialog[open]')) return false;
  return handleMediaKey(content.querySelector('video'),key,repeat);
};
document.addEventListener('keydown', event => {
  if (window.tvKey(event.key,event.repeat)) { event.preventDefault(); return; }
  const active = document.activeElement;
  if (event.key === 'Enter' && event.repeat) { event.preventDefault(); return; }
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  // Text editing and the platform's speed picker retain their own arrow keys.
  if (active?.matches('select') || (active?.matches('input') && ['ArrowLeft','ArrowRight'].includes(event.key))) return;
  const items = candidates();
  focus(items[nextFocus(items.map(el => el.getBoundingClientRect()),items.indexOf(active),event.key)]);
  event.preventDefault();
});
const back = window.appBack;
window.appBack = () => {
  const dialog = document.querySelector('dialog[open]');
  if (dialog) { dialog.close(); focus(document.querySelector('#about')); return true; }
  if (document.body.classList.contains('tv-playing')) {
    document.body.classList.remove('tv-playing'); focus(document.querySelector('#tv-controls button')); return true;
  }
  return back();
};
document.querySelector('header small').textContent = '方向键选择 · 确认键打开 · 返回键退出当前页面';
document.querySelector('#info p:last-of-type').textContent = '基于项目源码移植，保留GPL及第三方授权。电视真机播放与遥控器兼容性待验收。';
refresh();
