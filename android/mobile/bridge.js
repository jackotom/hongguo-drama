import '../web/globals.js';
import { browseList as appCatalog } from '../../src/native/hongguo-app-catalog.js';
import { browseList as webCatalog } from '../../src/native/catalog.js';
import { searchApp } from '../../src/native/hongguo-app-search.js';
import { fetchPublicDetails } from '../../src/native/public-details.js';
import { fetchEpisodeComments } from '../../src/native/episode-comments.js';
import { createAccountService } from '../../src/native/account-session.js';
import { fetchDanmaku, setDeviceIdentityFile } from '../../src/native/danmaku.js';
import { Buffer } from 'buffer/';
import * as history from '../../src/native/watch-history.js';
import { website, parseDetail } from '../web/public.js';
import { prepareMedia } from './media.js';
import contract from '../build/contract.json';

const events = new Map();
const emit = (name, value) => events.get(name)?.forEach(fn => fn(value));
const listen = name => callback => {
  if (!events.has(name)) events.set(name, new Set());
  events.get(name).add(callback);
  return () => events.get(name)?.delete(callback);
};
const unavailable = () => async () => ({ success: false, code: 'ANDROID_UNAVAILABLE', error: '此功能尚未接入安卓版本' });
const api = Object.fromEntries(contract.map(name => [name, name.startsWith('on') ? listen(name) : unavailable(name)]));
const defaults = { root: '应用私有下载目录', download_quality: 'auto', cache_next_episode: true,
  compat_mode: false, auto_delete_watched: false, show_danmaku_controls: true, max_concurrent: 1,
  picture_in_picture_mode: 'native', export_text: [], download_metadata: false,
  search_app_enabled: false, watch_updates_enabled: true, watch_sequels_enabled: true, app_updates_enabled: false };
let state;
try {
  const raw = Native.readState();
  state = raw ? JSON.parse(raw) : { series: [], tasks: [], playback: {}, settings: {} };
  if (!Array.isArray(state.series) || !Array.isArray(state.tasks) || !state.playback || !state.settings) throw new Error('格式无效');
} catch {
  // Do not replace unreadable state with an empty file.
  throw new Error('安卓本机资料读取失败，已停止写入；请保留应用数据后检查');
}
const clone = value => JSON.parse(JSON.stringify(value));
if (!Array.isArray(state.legacyHistory)) {
  try {
    const old = JSON.parse(localStorage.getItem('history') || '[]');
    state.legacyHistory = Array.isArray(old) ? old.filter(row => /^\d{6,30}$/.test(row?.series_id)
      && Number.isInteger(row.episode) && row.episode >= 0 && Number.isFinite(row.position) && row.position >= 0).slice(0,200)
      .map(row => ({ series_id:row.series_id, series_title:String(row.series_title || ''), cover:String(row.cover || ''),
        vid_index:row.episode+1, currentTime:row.position, updatedAt:Number(row.time) || Date.now(), total:0 })) : [];
  } catch { state.legacyHistory = []; }
}
const save = () => {
  try { Native.writeState(JSON.stringify(state)); }
  catch { emit('onStorageError', { error: '本机保存失败，请检查剩余空间' }); throw new Error('本机保存失败'); }
};
const success = () => ({ success: true });
setDeviceIdentityFile('danmaku.identity');
const account = createAccountService({ filePath:'account.session', safeStorage: {
  isEncryptionAvailable: () => Native.secureStorageAvailable(),
  encryptString: value => Buffer.from(Native.seal(value),'base64'),
  decryptString: value => Native.unseal(Buffer.from(value).toString('base64')),
} });
const validId = value => /^\d{6,30}$/.test(String(value));
const seriesFor = id => state.series.find(row => row.series_id === String(id));
const taskFor = (id, index) => state.tasks.findLast(row => row.hongguoInfo.series_id === String(id) && row.hongguoInfo.vid_index === Number(index));
state.files ||= state.tasks.filter(task => task.status === 'completed' && task.token).map(task => ({
  seriesId: task.hongguoInfo.series_id, index: task.hongguoInfo.vid_index, token: task.token, quality: task.actualQuality,
}));
const fileFor = (id, index) => state.files.find(row => row.seriesId === String(id) && row.index === Number(index) && Native.mediaSize(row.token) > 0);
const controllers = new Map(), online = new Map(), localPlaybackUrls = new Set();
const queue = { running: false, paused: true };
for (const task of state.tasks) {
  task.title ||= task.name || `${task.hongguoInfo?.series_title || seriesFor(task.hongguoInfo?.series_id)?.series_title || '短剧'} 第${task.hongguoInfo?.vid_index || '?'}集`;
  if (['pending', 'downloading'].includes(task.status)) task.status = 'stopped';
  if (task.token && !Native.mediaSize(task.token)) { delete task.token; task.status = 'failed'; task.error = '下载文件缺失，请重试'; }
}

async function resolveSeries(input) {
  let id = String(input || '').trim();
  if (!validId(id)) {
    let url;
    try { url = new URL(id); } catch { throw new Error('请输入剧集编号或红果官网链接'); }
    if (url.origin !== 'https://hongguoduanju.com' || url.username || url.password) throw new Error('仅支持红果官网链接');
    id = url.searchParams.get('series_id') || url.pathname.match(/^\/player\/(\d+)/)?.[1] || '';
  }
  if (!validId(id)) throw new Error('剧集编号无效');
  const detail = parseDetail(await website(`/player/${id}`), id);
  const data = { ...detail, total: detail.episodes.length,
    episodes: detail.episodes.map((row, index) => ({ vid: row.vid, vid_index: index + 1, title: `第${index + 1}集`, locked: false })) };
  const old = seriesFor(id);
  state.series = [data, ...state.series.filter(row => row.series_id !== id)];
  if (state.playback[id]) state.playback[id] = history.applyEpisodeUpdate(state.playback[id], old, data);
  save();
  return { success: true, data: clone(data) };
}
const guarded = fn => async (...args) => {
  try { return await fn(...args); }
  catch (error) { return { success: false, error: error.message, code: error.code, cancelled: error.code === 'ERR_CANCELED' }; }
};

async function episodes(id) {
  const series = seriesFor(id);
  if (!series) return { success: false, code: 'SERIES_NOT_FOUND', error: '请先打开剧集详情' };
  const rows = series.episodes.map(row => {
    const task = taskFor(id, row.vid_index), file = fileFor(id, row.vid_index), complete = !!file;
    return { ...row, status: complete ? 'completed' : task?.status === 'completed' ? 'missing' : task?.status || 'missing',
      progress: task?.progress || 0, taskId: task?.id || null, error: task?.error || '',
      fileUrl: complete ? `https://app.local/media/${file.token}` : null, fileSize: complete ? Number(Native.mediaSize(file.token)) : 0,
      actualQuality: file?.quality || task?.actualQuality, savePath: complete ? file.token : null };
  });
  return { success: true, data: { ...clone(series), episodes: rows, completedCount: rows.filter(row => row.status === 'completed').length } };
}

async function pump() {
  if (queue.running || queue.paused) return;
  queue.running = true;
  try {
    let task;
    while (!queue.paused && (task = state.tasks.find(row => row.status === 'pending'))) {
      const controller = new AbortController(); controllers.set(task.id, controller);
      task.status = 'downloading'; task.progress = 0; task.error = ''; save(); emit('onDownloadQueueChanged');
      try {
        const media = await prepareMedia(task.hongguoInfo.vid, task.quality, controller.signal, (phase,stats={}) => {
          task.progress = phase === 'decrypting' ? 100 : stats.total > 0 ? Math.min(100,Math.round(stats.received/stats.total*100)) : 0;
          Object.assign(task, { receivedBytes: stats.received || 0, totalBytes: stats.total || 0, speed: stats.bytesPerSecond || 0 });
          emit('onDownloadProgress', { id: task.id, progress: task.progress, phase, ...stats, receivedBytes: task.receivedBytes, totalBytes: task.totalBytes, speed: task.speed });
        });
        if (controller.signal.aborted) { Native.deleteMedia(media.token); continue; }
        Native.persistMedia(media.token);
        state.files.push({ seriesId: task.hongguoInfo.series_id, index: task.hongguoInfo.vid_index, token: media.token, quality: media.quality });
        Object.assign(task, { token: media.token, status: 'completed', progress: 100, size: media.bytes,
          fileSize: media.bytes, actualQuality: media.quality, savePath: media.token, endTime: Date.now() });
        save(); emit('onDownloadCompleted', clone(task));
      } catch (error) {
        if (controller.signal.aborted) task.status = 'stopped';
        else { task.status = 'failed'; task.error = error.message; }
        if (/^(BUSINESS_REJECTED|DEVICE_REGISTRATION_FAILED|SECURITY_BLOCKED)$/.test(error.code || '')) {
          queue.paused = true;
          for (const pending of state.tasks) if (pending.status === 'pending') pending.status = 'stopped';
        }
        save(); emit(task.status === 'stopped' ? 'onDownloadStopped' : 'onDownloadFailed', clone(task));
      } finally { controllers.delete(task.id); emit('onDownloadQueueChanged'); }
    }
  } finally { queue.running = false; }
}

async function enqueue(payload) {
  const series = seriesFor(payload.seriesId);
  if (!series) throw new Error('未找到剧集，请先打开详情');
  if (!Array.isArray(payload.episodes) || !payload.episodes.length) throw new Error('请选择下载集数');
  if (payload.export?.length) throw new Error('安卓文字导出尚未接入，请取消文字导出后下载');
  if (payload.quality && !['auto','720p','1080p'].includes(payload.quality)) throw new Error('下载画质无效');
  const selectedEpisodes = payload.episodes.map(selected => {
    const ep = series.episodes.find(row => row.vid === selected?.vid && row.vid_index === selected?.vid_index && !row.locked);
    if (!ep) throw new Error('分集与当前剧集不匹配');
    return ep;
  });
  let added = 0;
  for (const ep of selectedEpisodes) {
    const previous = taskFor(series.series_id, ep.vid_index);
    if (fileFor(series.series_id, ep.vid_index) || previous && ['pending','downloading'].includes(previous.status)) continue;
    const task = { id: crypto.randomUUID(), title: `${series.series_title} 第${ep.vid_index}集`,
      status: 'pending', progress: 0, startTime: Date.now(), quality: payload.quality || 'auto',
      hongguoInfo: { series_id: series.series_id, series_title: series.series_title, vid: ep.vid, vid_index: ep.vid_index, ep_title: ep.title } };
    state.tasks.push(task); added++; emit('onDownloadTaskAdded', clone(task));
  }
  save(); queue.paused = false; void pump(); emit('onDownloadQueueChanged');
  return { success: true, added, count: added };
}

Object.assign(api, {
  platform: 'android',
  getAppInfo: async () => ({ version: '1.1.0', appName: '红果·自用', platform: 'android', brand: '红果短剧', mobile: true }),
  getWindowLayout: async () => 'portrait', getAlwaysOnTop: async () => false,
  getSettings: async () => ({ ...defaults, ...clone(state.settings) }),
  saveSettings: guarded(async patch => {
    const allowed = ['download_quality','cache_next_episode','auto_delete_watched','show_danmaku_controls','watch_updates_enabled','watch_sequels_enabled','search_app_enabled'];
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('此设置尚未接入安卓，未保存');
    for (const [key,value] of Object.entries(patch)) {
      if (key === 'download_quality' ? !['auto','720p','1080p'].includes(value) : typeof value !== 'boolean') throw new Error('设置值无效，未保存');
    }
    state.settings = { ...state.settings, ...patch }; save(); return success();
  }),
  getMediaSources: async () => ({ success: true, sources: [{ id: 'hongguo', label: '红果短剧' }] }),
  browseCategories: async () => [ ['real-drama','真人剧'], ['comic-drama','漫剧'], ['ai-drama','AI剧'],
    ['hot-drama','热播总榜'], ['hot-real-drama','真人热播'], ['hot-comic-drama','漫剧热播'], ['hot-ai-drama','AI热播'] ].map(([slug,label]) => ({ slug,label })),
  browseList: guarded(async options => {
    if (options.source && options.source !== 'hongguo') throw new Error('安卓目前仅接入红果来源');
    return options.catalogChannel === 'app' ? appCatalog(options) : webCatalog(options);
  }),
  searchSeries: async (keyword, options) => {
    if (!keyword?.trim() || keyword.length > 80) throw new Error('搜索词无效');
    if (options?.source && !['all','hongguo'].includes(options.source)) throw new Error('此来源尚未接入安卓');
    if (state.settings.search_app_enabled) return { ...await searchApp(keyword, options), channel: 'app' };
    try {
      const raw = JSON.parse(await website(`/api/search/result?aid=8662&query=${encodeURIComponent(keyword)}&page=${options?.page || 1}`));
      if (!Array.isArray(raw.searchList)) throw new Error('官网搜索返回异常');
      const results = raw.searchList.flatMap(item => {
        const row = item.video_data && Object.keys(item.video_data).length ? item.video_data : item;
        const id = String(row.series_id || item.keyword || ''), title = row.series_name || row.series_title || item.name;
        return validId(id) && title ? [{ series_id: id, series_title: String(title), cover: row.series_cover || row.cover || '', episode_count: Number(row.episode_cnt) || 0 }] : [];
      });
      return { success:true, results, channel: 'web', page: options?.page || 1, hasMore: raw.hasMore === true };
    } catch { return { ...await searchApp(keyword, options), channel: 'app' }; }
  },
  searchSeriesMore: async (keyword, options) => options?.channel === 'app' ? { ...await searchApp(keyword, options), channel: 'app' } : api.searchSeries(keyword, options),
  searchResolve: guarded(resolveSeries), hongguoResolve: guarded(resolveSeries),
  getSeriesList: async options => clone(state.series.filter(row => !options?.downloadedOnly || state.files.some(file => file.seriesId === row.series_id && Native.mediaSize(file.token) > 0))),
  getSeriesEpisodes: guarded(episodes),
  playSeries: guarded(async payload => {
    const legacy = state.legacyHistory.find(row => row.series_id === payload.seriesId);
    if (!seriesFor(payload.seriesId) && legacy) {
      await resolveSeries(payload.seriesId);
      if (!state.playback[payload.seriesId]) {
        state.playback[payload.seriesId] = history.recordPlayback(null,seriesFor(payload.seriesId),legacy.vid_index,legacy.currentTime,legacy.updatedAt);
        save();
      }
    }
    if (!seriesFor(payload.seriesId)) return { success: false, code: 'SERIES_NOT_FOUND', error: '请先打开剧集详情' };
    emit('onNavigate', { page: 'player', payload: clone(payload) }); return success();
  }),
  getPublicDetails: fetchPublicDetails, getEpisodeComments: fetchEpisodeComments, getEpisodeDanmaku: fetchDanmaku,
  getAccountStatus: guarded(() => account.status()),
  openAccountWebLogin: guarded(async () => { Native.openAccountLogin(); return success(); }),
  startAccountLogin: guarded(() => account.startLogin()),
  pollAccountLogin: guarded(async id => { const result = await account.pollLogin(id); if (result.status === 'signed-in') emit('onAccountUpdated',result); return result; }),
  cancelAccountLogin: async id => account.cancelLogin(id),
  logoutAccount: guarded(async () => { const result = await account.logout(); emit('onAccountUpdated',result); return result; }),
  getAccountHistory: guarded(options => account.history(options)),
  playAccountHistory: guarded(async id => {
    const row = account.row(String(id)); if (!row) throw new Error('账号观看记录不存在，请刷新');
    if (!seriesFor(id)) await resolveSeries(id);
    const ep = seriesFor(id).episodes.find(ep => ep.vid === row.episode_id);
    if (!ep) throw new Error('来源分集与账号记录不匹配');
    await api.savePlaybackPosition(id,ep.vid_index,row.currentTime,{duration:row.duration});
    return api.playSeries({seriesId:String(id),vidIndex:ep.vid_index,resume:true});
  }),
  findSeriesSequels: guarded(async id => {
    const series = seriesFor(id); if (!series) throw new Error('剧集未登记');
    const result = await api.searchSeries(history.sequelKeyword(series));
    return { success:true, results:history.findSequels(series,result.results || []) };
  }),
  getPlaybackPosition: async id => clone(state.playback[id] || null),
  savePlaybackPosition: guarded(async (id, index, seconds, metadata) => {
    const series = seriesFor(id); if (!series) throw new Error('剧集未登记');
    state.playback[id] = history.recordPlayback(state.playback[id], series, Number(index), Number(seconds), Date.now(), metadata);
    save(); emit('onWatchHistoryUpdated'); return success();
  }),
  getWatchHistory: async () => {
    const rows = history.listHistory(state.series, state.playback), seen = new Set(rows.map(row => row.series_id));
    return { success:true, results:[...rows,...clone(state.legacyHistory).filter(row => !seen.has(row.series_id))].sort((a,b) => b.updatedAt-a.updatedAt) };
  },
  removeWatchHistory: guarded(async id => { delete state.playback[id]; state.legacyHistory = state.legacyHistory.filter(row => row.series_id !== id); save(); emit('onWatchHistoryUpdated', { removedSeriesId: id }); return success(); }),
  acknowledgeWatchUpdates: guarded(async (id, snapshot) => { if (state.playback[id]) { state.playback[id] = history.acknowledge(state.playback[id], snapshot); save(); } return success(); }),
  checkWatchHistoryItem: guarded(async id => { await resolveSeries(id); emit('onWatchHistoryUpdated'); return success(); }),
  refreshWatchHistory: guarded(async () => {
    const rows = history.listHistory(state.series, state.playback).slice(0, 10); let failed = 0;
    for (let index = 0; index < rows.length; index++) {
      try { await resolveSeries(rows[index].series_id); } catch { failed++; }
      emit('onWatchHistoryProgress', { checked: index + 1, total: rows.length });
    }
    emit('onWatchHistoryUpdated'); return { success: true, checked: rows.length, failed };
  }),
  openLocalPlayback: guarded(fileUrl => {
    const token = String(fileUrl || '').match(/^https:\/\/app\.local\/media\/([0-9a-f-]{36}\.mp4)$/)?.[1];
    if (!token || !state.files.some(file => file.token === token) || Native.mediaSize(token) <= 0) throw new Error('本机视频未登记或已失效');
    const bytes = Buffer.from(Native.readMedia(token), 'base64');
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('视频文件无效或过大');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    localPlaybackUrls.add(url); return { success: true, url };
  }),
  releaseLocalPlayback: async url => {
    if (localPlaybackUrls.delete(url)) URL.revokeObjectURL(url);
    return success();
  },
  prepareOnlinePlay: guarded(async payload => {
    const series = seriesFor(payload.seriesId);
    if (!series?.episodes.some(ep => ep.vid === payload.vid && ep.vid_index === payload.vidIndex && !ep.locked)) throw new Error('播放分集与剧集不匹配');
    const old = online.get(payload.requestId); old?.controller.abort();
    if (old?.media) { URL.revokeObjectURL(old.media.url); Native.deleteMedia(old.media.token); }
    const entry = { controller: new AbortController(), prefetch: !!payload.prefetch }; online.set(payload.requestId, entry);
    try {
      entry.media = await prepareMedia(payload.vid, payload.quality || 'auto', entry.controller.signal, (phase,stats={}) => {
        const percent = phase === 'decrypting' ? 100 : stats.total > 0 ? Math.min(100,Math.round(stats.received/stats.total*100)) : 0;
        emit('onOnlinePlayProgress', { requestId: payload.requestId, vid: payload.vid, phase, percent, ...stats });
      }, true);
      if (entry.controller.signal.aborted || online.get(payload.requestId) !== entry) {
        URL.revokeObjectURL(entry.media.url); Native.deleteMedia(entry.media.token);
        throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' });
      }
      return { success: true, ...entry.media, streamId: entry.media.token, cached: false, streaming: false };
    } catch (error) { if (online.get(payload.requestId) === entry) online.delete(payload.requestId); throw error; }
  }),
  releaseOnlinePlay: async payload => {
    const entry = online.get(payload.requestId);
    if (entry) { entry.controller.abort(); if (entry.media) { URL.revokeObjectURL(entry.media.url); Native.deleteMedia(entry.media.token); } online.delete(payload.requestId); }
    return success();
  },
  promoteOnlinePlay: async payload => { const entry = online.get(payload.requestId); if (!entry) return { success: false, error: '准备任务已结束' }; entry.prefetch = false; return success(); },
  onlineCacheStatus: async () => ({ success: true, count: [...online.values()].filter(row => row.media).length,
    bytes: [...online.values()].reduce((n,row) => n + (row.media?.bytes || 0), 0) }),
  clearOnlineCache: async () => { for (const id of [...online.keys()]) await api.releaseOnlinePlay({ requestId: id }); return success(); },
  hongguoDownloadBatch: guarded(enqueue),
  downloadSingleEpisode: guarded(async (id, index, quality) => {
    const ep = seriesFor(id)?.episodes.find(row => row.vid_index === Number(index));
    if (!ep) throw new Error('分集不存在');
    return enqueue({ seriesId: id, episodes: [ep], quality });
  }),
  getDownloadTasks: async () => clone(state.tasks), getMergeTasks: async () => [],
  getQueueStatus: async () => ({ active: controllers.size, queued: state.tasks.filter(task => task.status === 'pending').length,
    paused: queue.paused, maxConcurrent: 1 }),
  stopDownload: guarded(async id => {
    const task = state.tasks.find(row => row.id === id); if (!task) throw new Error('任务不存在');
    if (task.status === 'completed') return success();
    task.status = 'stopped'; save(); controllers.get(id)?.abort(); emit('onDownloadStopped', clone(task)); return success();
  }),
  pauseAll: guarded(async () => {
    queue.paused = true;
    for (const task of state.tasks) if (['pending','downloading'].includes(task.status)) task.status = 'stopped';
    save(); for (const controller of controllers.values()) controller.abort(); emit('onDownloadQueueChanged'); return success();
  }),
  resumeAll: guarded(async () => {
    for (const task of state.tasks) if (task.status === 'stopped') task.status = 'pending';
    save(); queue.paused = false; void pump(); emit('onDownloadQueueChanged'); return success();
  }),
  retryTask: guarded(async id => {
    const task = state.tasks.find(row => row.id === id); if (!task) throw new Error('任务不存在');
    if (controllers.has(id)) throw new Error('任务正在停止，请稍后重试');
    if (!['failed','stopped'].includes(task.status)) return success();
    task.status = 'pending'; task.error = ''; save(); queue.paused = false; void pump(); emit('onDownloadQueueChanged'); return success();
  }),
  retryTasks: guarded(async ids => { for (const id of ids) await api.retryTask(id); return success(); }),
  getStorageUsage: async () => {
    const series = state.series.map(row => {
      const files = state.files.filter(file => file.seriesId === row.series_id && Native.mediaSize(file.token) > 0);
      return { series_id: row.series_id, files: files.length, bytes: files.reduce((n,file) => n + Number(Native.mediaSize(file.token)),0), merged: 0 };
    });
    return { success: true, series, totalFiles: series.reduce((n,s) => n+s.files,0), totalBytes: series.reduce((n,s) => n+s.bytes,0) };
  },
  deleteEpisodeFile: guarded(async (id, index) => {
    if (state.tasks.some(row => row.hongguoInfo.series_id === String(id) && row.hongguoInfo.vid_index === Number(index) && controllers.has(row.id))) throw new Error('请先停止下载');
    for (const file of state.files.filter(row => row.seriesId === String(id) && row.index === Number(index))) Native.deleteMedia(file.token);
    state.files = state.files.filter(row => row.seriesId !== String(id) || row.index !== Number(index));
    for (const task of state.tasks.filter(row => row.hongguoInfo.series_id === String(id) && row.hongguoInfo.vid_index === Number(index))) {
      if (controllers.has(task.id)) throw new Error('请先停止下载');
      if (task.token) Native.deleteMedia(task.token); delete task.token; task.status = 'stopped'; task.progress = 0;
    }
    save(); emit('onDownloadQueueChanged'); return success();
  }),
  cleanupWatchedEpisode: guarded(async (id, index) => {
    const result = await api.deleteEpisodeFile(id, index); if (!result.success) return result;
    return { success: true, deleted: true };
  }),
  forgetSeries: guarded(async id => {
    if (state.tasks.some(task => task.hongguoInfo.series_id === id && ['pending','downloading'].includes(task.status))) throw new Error('请先停止该剧下载');
    state.series = state.series.filter(row => row.series_id !== id); save(); return success();
  }),
  getFfmpegStatus: async () => ({ available: false, error: '安卓兼容转换尚未接入' }),
  setEpisodePanelOpen: async () => success(),
});

api.deleteTasksWithFiles = guarded(async (ids, deleteFiles) => {
  if (!Array.isArray(ids)) throw new Error('任务编号无效');
  for (const id of ids) await api.stopDownload(id);
  for (const task of state.tasks.filter(row => ids.includes(row.id))) if (deleteFiles && task.token) {
    Native.deleteMedia(task.token); state.files = state.files.filter(file => file.token !== task.token);
  }
  state.tasks = state.tasks.filter(row => !ids.includes(row.id)); save(); emit('onDownloadQueueChanged'); return success();
});
api.deleteTaskWithFiles = (id, files) => api.deleteTasksWithFiles([id], files);
api.deleteTask = id => api.deleteTasksWithFiles([id], false);
api.deleteTasks = ids => api.deleteTasksWithFiles(ids, false);
api.deleteSeriesFiles = guarded(async id => {
  for (const file of state.files.filter(row => row.seriesId === String(id))) {
    const result = await api.deleteEpisodeFile(id, file.index); if (!result.success) return result;
  }
  return success();
});
api.deleteAllDownloaded = guarded(async () => {
  for (const id of [...new Set(state.files.map(file => file.seriesId))]) { const result = await api.deleteSeriesFiles(id); if (!result.success) return result; }
  return success();
});

window.electronAPI = api;
window.__nativePip = enabled => {
  api.nativePictureInPicture = enabled;
  document.documentElement.classList.toggle('android-pip',enabled);
  emit('onNativePictureInPicture',enabled);
};
api.onNativePictureInPicture = listen('onNativePictureInPicture');
api.enterNativePictureInPicture = async (width,height) => Native.enterPip(width,height)
  ? success() : {success:false,error:'系统未能开启画中画，请检查此应用的画中画权限'};
window.__nativeAccountCookie = async cookie => {
  const result = await guarded(value => account.completeWebLogin(value))(cookie);
  emit('onAccountUpdated',result);
  if (!result.success) emit('onStorageError',{error:result.error});
};
window.pausePlayback = () => { document.querySelectorAll('video').forEach(video => video.pause()); Native.awake(false); };
document.addEventListener('visibilitychange', () => { if (document.hidden) window.pausePlayback(); });
document.addEventListener('play', event => { if (event.target.tagName === 'VIDEO') Native.awake(true); }, true);
const videoTelemetry = new WeakMap();
document.addEventListener('timeupdate', event => {
  const video = event.target;
  if (video.tagName !== 'VIDEO' || video.paused || !video.videoWidth) return;
  if (Date.now() - (videoTelemetry.get(video) || 0) < 15000) return;
  videoTelemetry.set(video,Date.now());
  console.info(`HG:video:time:${Math.floor(video.currentTime)}:${video.videoWidth}x${video.videoHeight}`);
},true);
document.addEventListener('ended', event => { if (event.target.tagName === 'VIDEO') console.info('HG:video:ended'); },true);
document.addEventListener('pause', () => Native.awake(false), true);
// Migrate the previous personal prototype without deleting its original records.
if (!localStorage.getItem('hongguo:public-library:v1')) {
  try {
    const favorites = JSON.parse(localStorage.getItem('favorites') || '[]');
    if (favorites.length) localStorage.setItem('hongguo:public-library:v1', JSON.stringify(favorites.map(row => ({ id: row.series_id, title: row.series_title, cover: row.cover || '', favorite: true, published_at: null, liked_episode_ids: [] }))));
  } catch { emit('onStorageError', { error: '旧收藏未能导入，原记录仍保留' }); }
}
export { api };
