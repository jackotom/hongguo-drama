import './globals.js';
import { Buffer } from 'buffer/';
import request, { cancelAll } from './transport.js';
import { website, readRouter, parseDetail, parsePublicPlay } from './public.js';
import { fetchAppPlayUrl } from '../../src/native/app-source.js';
import { browseList } from '../../src/native/hongguo-app-catalog.js';
import { searchApp } from '../../src/native/hongguo-app-search.js';
import { decryptMp4Buffer } from '../build/decrypt.js';

const SITE = 'https://hongguoduanju.com';
const content = document.querySelector('#content');
const categories = [['real-drama','真人剧'],['comic-drama','漫剧'],['ai-drama','AI剧']];
const state = {tab:'discover',category:'real-drama',page:1,keyword:'',detail:null,episode:0,generation:0,channel:'web',websiteOnly:false,cursors:new Map()};
let video, playAbort, lastSaved = 0;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const picture = value => {
  try { const u = new URL(value); return u.protocol === 'https:' ? `/image?url=${encodeURIComponent(u.href)}` : ''; } catch { return ''; }
};
const poster = item => `<div class="poster">${picture(item.cover) ? `<img src="${esc(picture(item.cover))}" alt="${esc(item.series_title)}" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>`;
function read(key) { try { const data = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(data) ? data : []; } catch { return []; } }
function write(key, values) { try { localStorage.setItem(key,JSON.stringify(values.slice(0,key === 'favorites' ? 100 : 200))); } catch { message('本机存储已满，记录未保存'); } }
function message(text, error = false) { const el = document.querySelector('#status'); if (el) { el.textContent = text; el.classList.toggle('error',error); } }
const historyFor = id => read('history').find(item => item.series_id === id);
function savePosition() {
  if (!video || !state.detail || !Number.isFinite(video.currentTime)) return;
  const d = state.detail;
  const row = {series_id:d.series_id,series_title:d.series_title,cover:d.cover,episode:state.episode,position:video.currentTime,time:Date.now()};
  write('history',[row,...read('history').filter(item => item.series_id !== d.series_id)]);
}
function stop() {
  savePosition(); playAbort?.abort(); cancelAll();
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); video = null; }
  Native.awake(false); Native.clearMedia();
}
function switchTab(tab) {
  state.generation++; stop(); state.tab = tab; state.detail = null;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active',b.dataset.tab === tab);
  if (tab === 'discover') showDiscover(); else showLocal();
  window.scrollTo(0,0);
}
function bindCards(rows) {
  for (const button of document.querySelectorAll('[data-series]')) button.onclick = () => openDetail(rows.find(item => item.series_id === button.dataset.series));
  for (const img of content.querySelectorAll('img')) img.onerror = () => { img.hidden = true; };
}
function cards(rows) {
  return `<div class="grid">${rows.map(row => `<button class="card" data-series="${esc(row.series_id)}">${poster(row)}<strong>${esc(row.series_title)}</strong><small>${row.episode != null ? `看到第${row.episode + 1}集` : row.episode_count ? `共${Number(row.episode_count)}集` : '查看分集'}</small></button>`).join('')}</div>`;
}
function catalogRows(html, category) {
  const data = Object.values(readRouter(html).loaderData || {}).find(v => v?.categoryRoute?.contentType === category);
  if (!data || data.isSuccess === false || !Array.isArray(data.recommendList)) throw new Error('官网目录暂不可用');
  return {results:data.recommendList.filter(row => /^\d{1,30}$/.test(String(row.series_id)) && row.series_name).map(row => ({series_id:String(row.series_id),series_title:String(row.series_name),cover:row.series_cover,episode_count:row.episode_cnt})),page:Number(data.pagination?.pageNum) || state.page,hasMore:(Number(data.pagination?.pageNum)||1) < (Number(data.pagination?.totalPages)||1)};
}
async function showDiscover() {
  const generation = ++state.generation;
  let websiteFailure = '';
  cancelAll();
  content.innerHTML = `<form class="search"><input aria-label="搜索短剧" maxlength="80" placeholder="搜索剧名，找到想看的故事" value="${esc(state.keyword)}"><button class="primary">搜索</button></form><div class="categories">${categories.map(([id,label]) => `<button data-category="${id}" class="${state.category === id && !state.keyword ? 'active-choice' : ''}">${label}</button>`).join('')}</div><div class="section-line"><h2>${state.keyword ? '搜索结果' : '发现好剧'}</h2><span>无广告 · 本机自用</span></div><div id="status" class="status">正在加载…</div><section id="results"></section>`;
  content.querySelector('form').onsubmit = event => { event.preventDefault(); state.keyword = content.querySelector('input').value.trim(); state.page = 1; state.channel = 'web'; state.cursors.clear(); showDiscover(); };
  for (const b of content.querySelectorAll('[data-category]')) b.onclick = () => {
    const same = state.category === b.dataset.category && !state.keyword;
    state.page = same && state.hasMore ? state.page + 1 : 1;
    state.category = b.dataset.category; state.keyword = ''; if (!same) state.channel = 'web'; showDiscover();
  };
  try {
    let result;
    if (state.keyword) {
      if (state.channel === 'app') result = await searchApp(state.keyword,{page:state.page,cursor:state.cursors.get(state.page)});
      else {
        try {
          const payload = JSON.parse(await website(`/api/search/result?aid=8662&query=${encodeURIComponent(state.keyword)}&page=${state.page}`));
          if (!Array.isArray(payload.searchList)) throw new Error('搜索数据无效');
          result = {results:payload.searchList.flatMap(item => {
            const v = item.video_data && Object.keys(item.video_data).length ? item.video_data : item;
            const id = String(v.series_id || item.keyword || ''), title = v.series_name || v.series_title || item.name;
            return /^\d{1,30}$/.test(id) && title ? [{series_id:id,series_title:String(title),cover:v.series_cover || v.cover,episode_count:Number(v.episode_cnt)||0}] : [];
          }), hasMore:payload.hasMore === true};
        } catch (error) {
          if (generation !== state.generation) return;
          if (state.websiteOnly) throw error;
          websiteFailure = error.message;
          state.page = 1; result = await searchApp(state.keyword); state.channel = 'app';
        }
      }
      if (result.cursor) state.cursors.set(state.page + 1,result.cursor);
    } else {
      try {
        if (state.channel === 'app') {
          result = await browseList({category:state.category,page:state.page});
          if (!result.success) throw new Error(result.error);
        } else result = catalogRows(await website(`/category/${state.category}?page=${state.page}`),state.category);
      }
      catch (error) {
        if (generation !== state.generation) return;
        if (state.channel === 'app' || state.websiteOnly) throw error;
        websiteFailure = error.message;
        if (state.channel !== 'app' && state.page > 1) state.page = 1;
        result = await browseList({category:state.category,page:state.page}); state.channel = 'app';
        if (!result.success) throw new Error(result.error);
      }
    }
    if (generation !== state.generation) return;
    state.hasMore = result.hasMore === true && state.page < 50;
    const rows = [...new Map(result.results.map(row => [row.series_id,row])).values()];
    message(rows.length ? '' : '没有找到短剧，换个关键词试试');
    content.querySelector('#results').innerHTML = cards(rows) + `<div class="pager"><button id="prev-page" ${state.page === 1 ? 'disabled' : ''}>上一页</button><span>第${state.page}页</span><button id="next-page" ${!state.hasMore ? 'disabled' : ''}>下一页</button></div>`;
    content.querySelector('#prev-page').onclick = () => { state.page--; showDiscover(); window.scrollTo(0,0); };
    content.querySelector('#next-page').onclick = () => { state.page++; showDiscover(); window.scrollTo(0,0); };
    bindCards(rows);
  } catch (error) {
    if (generation !== state.generation) return;
    message(websiteFailure ? `官网：${websiteFailure}；App：${error.message}` : error.message,true);
    const retry = document.createElement('button'); retry.textContent = '重试'; retry.onclick = showDiscover; content.querySelector('#results').append(retry);
    const source = document.createElement('button'); source.textContent = state.websiteOnly ? '切换App来源' : '仅用官网';
    source.onclick = () => { state.websiteOnly = !state.websiteOnly; state.channel = state.websiteOnly ? 'web' : 'app'; state.page = 1; state.cursors.clear(); showDiscover(); };
    content.querySelector('#results').append(source);
  }
}
function showLocal() {
  const key = state.tab, rows = read(key);
  content.innerHTML = `<div class="section-line"><h1>${key === 'favorites' ? '我的收藏' : '观看记录'}</h1><span>仅本机</span></div><div id="status" class="status">${rows.length ? '' : key === 'favorites' ? '打开剧集，点收藏，喜欢的故事就留在这里。' : '开始观看后，这里会记住你看到哪一集。'}</div>${cards(rows)}`;
  bindCards(rows);
}
async function openDetail(item) {
  if (!item || !/^\d{1,30}$/.test(item.series_id)) return;
  state.generation++; stop();
  const generation = state.generation;
  state.detail = null;
  content.innerHTML = '<button class="back" id="back">‹ 返回</button><div id="status" class="status">正在加载分集…</div>';
  content.querySelector('#back').onclick = () => switchTab(state.tab);
  try {
    const d = parseDetail(await website(`/player/${item.series_id}`),item.series_id);
    if (generation !== state.generation) return;
    state.detail = d; state.episode = Math.min(historyFor(d.series_id)?.episode || 0,d.episodes.length-1);
    showDetail(); window.scrollTo(0,0);
  } catch (error) { if (generation === state.generation) { message(error.message,true); const retry = document.createElement('button'); retry.textContent = '重试'; retry.onclick = () => openDetail(item); content.append(retry); } }
}
function showDetail() {
  const d = state.detail, history = historyFor(d.series_id);
  content.innerHTML = `<button class="back" id="back">‹ 返回</button><div class="detail-head">${poster(d)}<div><h1>${esc(d.series_title)}</h1><p>共${d.episodes.length}集</p><button id="favorite"></button></div></div><details><summary>剧情简介</summary><p>${esc(d.description || '暂无简介')}</p></details>${history ? `<button class="resume" id="resume">继续观看 · 第${history.episode+1}集</button>` : ''}<div class="video-stage" id="stage"><div class="status">选一集，开始看。</div></div><div id="status" class="status"></div><div class="player-tools"><button id="previous">上一集</button><button id="retry">播放本集</button><button id="next">下一集</button><select id="speed" aria-label="播放速度"><option value="1">1倍速</option><option value="1.25">1.25倍</option><option value="1.5">1.5倍</option><option value="2">2倍速</option></select></div><p class="hint">先准备完整单集，再播放。移动网络会消耗流量。</p><div class="section-line"><h2>选集</h2><span id="episode-label"></span></div><div class="episodes">${d.episodes.map((e,i) => `<button data-episode="${i}" aria-label="播放第${i+1}集">${i+1}</button>`).join('')}</div>`;
  content.querySelector('#back').onclick = () => switchTab(state.tab);
  const favorite = content.querySelector('#favorite');
  const mark = () => { const saved = read('favorites').some(row => row.series_id === d.series_id); favorite.textContent = saved ? '已收藏' : '收藏'; favorite.setAttribute('aria-pressed',String(saved)); };
  favorite.onclick = () => { const rows = read('favorites'), saved = rows.some(row => row.series_id === d.series_id); write('favorites',saved ? rows.filter(row => row.series_id !== d.series_id) : [{series_id:d.series_id,series_title:d.series_title,cover:d.cover},...rows]); mark(); }; mark();
  for (const b of content.querySelectorAll('[data-episode]')) b.onclick = () => play(Number(b.dataset.episode));
  content.querySelector('#previous').onclick = () => play(state.episode-1);
  content.querySelector('#next').onclick = () => play(state.episode+1);
  content.querySelector('#retry').onclick = () => play(state.episode);
  content.querySelector('#speed').onchange = event => { if (video) video.playbackRate = Number(event.target.value); };
  if (history) content.querySelector('#resume').onclick = () => play(state.episode);
  updateEpisode(); bindCards([]);
}
function updateEpisode() {
  const d = state.detail;
  for (const b of content.querySelectorAll('[data-episode]')) { const selected = Number(b.dataset.episode) === state.episode; b.classList.toggle('playing',selected); b.setAttribute('aria-current',String(selected)); }
  content.querySelector('#previous').disabled = state.episode === 0;
  content.querySelector('#next').disabled = state.episode === d.episodes.length-1;
  content.querySelector('#episode-label').textContent = `第${state.episode+1}集 / ${d.episodes.length}集`;
}
async function play(index) {
  const d = state.detail;
  if (!d || index < 0 || index >= d.episodes.length) return;
  state.generation++; stop();
  const generation = state.generation; state.episode = index; updateEpisode();
  const controller = playAbort = new AbortController();
  const stage = content.querySelector('#stage');
  stage.innerHTML = '<div class="status">正在获取本集片源…</div>'; message('');
  content.querySelector('#retry').textContent = '重新准备';
  try {
    let source;
    try { source = await fetchAppPlayUrl(d.episodes[index].vid,{quality:'auto'}); }
    catch (error) {
      console.warn('HG:source-error:' + (error.code || error.name));
      if (generation !== state.generation || ['BUSINESS_REJECTED','DEVICE_REGISTRATION_FAILED'].includes(error.code)) throw error;
      source = parsePublicPlay(await website(`/player/${d.series_id}/${d.episodes[index].vid}`,controller.signal),d.series_id,d.episodes[index].vid);
    }
    if (generation !== state.generation) return;
    console.info('HG:source:' + source.codec + ':' + (source.contentKey ? 'encrypted' : 'clear'));
    if (!['h264','avc','avc1','hevc','h265','hvc1','hev1'].includes(source.codec)) throw new Error('本集编码暂不支持，请换集或使用官方App');
    stage.firstElementChild.textContent = '正在准备完整单集，可返回取消…';
    const timer = setTimeout(() => controller.abort(),90000);
    let response;
    try {
      response = await request({url:source.url,headers:{'User-Agent':source.userAgent || 'Mozilla/5.0',Referer:SITE+'/'},media:true,encrypted:!!source.contentKey,timeout:30000,signal:controller.signal});
    } finally { clearTimeout(timer); }
    if (generation !== state.generation) return;
    let token = response.token;
    if (source.contentKey) {
      stage.firstElementChild.textContent = '正在处理视频…';
      await new Promise(resolve => setTimeout(resolve,30));
      if (generation !== state.generation) return;
      // shortcut: whole-episode processing is capped at 64MB; use a native streaming parser before increasing it.
      const plain = decryptMp4Buffer(Buffer.from(response.data,'base64'),Buffer.from(source.contentKey,'hex'));
      token = Native.writeMedia(plain.toString('base64'));
    }
    if (generation !== state.generation) return;
    video = document.createElement('video'); video.controls = true; video.playsInline = true; video.preload = 'auto';
    video.src = `/media/${token}`;
    video.playbackRate = Number(content.querySelector('#speed').value);
    const saved = historyFor(d.series_id);
    video.onloadedmetadata = () => { if (saved?.episode === index && saved.position > 0 && saved.position < video.duration - 2) video.currentTime = saved.position; video.play().catch(() => message('点播放按钮开始观看')); };
    video.ontimeupdate = () => { if (Date.now()-lastSaved > 4000) { savePosition(); lastSaved = Date.now(); } };
    video.onpause = () => { savePosition(); Native.awake(false); };
    video.onplay = () => Native.awake(true);
    video.onended = () => { savePosition(); if (index+1 < d.episodes.length) play(index+1); else message('本剧已看完'); };
    video.onerror = () => message('系统播放器无法解码本集，可换集或重试。ByteVC2暂不支持。',true);
    stage.replaceChildren(video);
    message(`第${index+1}集已准备${source.quality ? ' · '+source.quality : ''}`);
  } catch (error) {
    if (generation !== state.generation) return;
    stage.innerHTML = '<div class="status">本集暂时无法播放。</div>';
    message(error.message || '片源不可用，请重试',true); Native.awake(false);
  }
}
window.pausePlayback = () => { video?.pause(); savePosition(); };
window.appBack = () => { if (state.detail || content.querySelector('#back')) { switchTab(state.tab); return true; } if (state.tab !== 'discover') { switchTab('discover'); return true; } return false; };
document.addEventListener('visibilitychange',() => { if (document.hidden) window.pausePlayback(); });
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => switchTab(button.dataset.tab));
document.querySelector('#about').onclick = () => document.querySelector('#info').showModal();
document.querySelector('#close-info').onclick = () => document.querySelector('#info').close();
showDiscover();
