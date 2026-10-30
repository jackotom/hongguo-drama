import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import useFloatingPlayer from './useFloatingPlayer';
import useDialogKeyboard from './useDialogKeyboard';
import PlayerControls from './PlayerControls';
import CommentDanmaku, { useCommentDanmaku } from './CommentDanmaku';
import OfficialDanmaku, { useOfficialDanmaku } from './OfficialDanmaku';
import { useDanmakuSource, writeDanmakuSource } from './danmakuSource.mjs';
import { SHORTCUT_ACTIONS, formatShortcut, ignoresPlaybackShortcut, readShortcuts, shortcutKey, subscribeShortcuts } from '../shortcuts';
import CommunityPanel from './CommunityPanel';
import SequelFinder from './SequelFinder';
import VideoEnhancement, { useVideoEnhancement } from './VideoEnhancement';
import './Player.css';
import { Play, Film, Download, Check, RefreshCw, Layers, X, Trash2, ChevronDown, Zap } from './icons';

const localMediaKey = (seriesId, episode) => JSON.stringify([seriesId, episode?.vid, episode?.fileUrl, episode?.fileSize, episode?.taskId]);
// 预取失败后短暂退避，避免 timeupdate 4Hz 反复撞同一个坏节点。
const PREFETCH_RETRY_MS = 15 * 1000;
// 播放期间最多预取后续两集；跳到更远时再按新位置补齐。
const PREFETCH_AHEAD = 2;
const AUTO_ONLINE_QUALITIES = ['1080p', '720p', 'auto'];

const prefetchKey = (seriesId, vid, quality) => JSON.stringify([String(seriesId || ''), String(vid || ''), quality || 'auto']);

/**
 * Player —— 内置播放器
 *
 * 设计要点：
 *  - 直接播本地 file:// 文件（实测支持 seek），无需流服务器
 *  - 「边下边看」：下一集若还在下载，显示等待态并轮询，下完自动接上
 *  - 断点续播：按 series_id 记住看到第几集、第几秒
 */
function Player({ target, onNavigate, onSeriesSelected, onFloatingChange, active = true, portrait = false, actionsHidden = false, episodesOpen = false, setEpisodesOpen }) {
  const enhancement = useVideoEnhancement();
  const [shortcuts, setShortcuts] = useState(readShortcuts);
  const [showDanmakuControls, setShowDanmakuControls] = useState(false);
  useEffect(() => subscribeShortcuts(setShortcuts), []);
  const [playbackSettingSaving, setPlaybackSettingSaving] = useState(false);
  const playbackSettingPending = useRef(false);
  const [windowFill, setWindowFill] = useState(false);
  useEffect(() => { if (!portrait || !active) setWindowFill(false); }, [portrait, active]);
  const [seriesList, setSeriesList] = useState([]);
  const [activeSeriesId, setActiveSeriesId] = useState('');
  const [pictureChoice, setPictureChoice] = useState(null);
  const savedPictureMode = useMemo(() => {
    try { return window.localStorage.getItem(`hongguo:picture-mode:${activeSeriesId}`) === 'width' ? 'width' : 'fit'; }
    catch { return 'fit'; }
  }, [activeSeriesId]);
  const pictureMode = pictureChoice?.seriesId === activeSeriesId ? pictureChoice.mode : savedPictureMode;
  const changePictureMode = mode => {
    if (!activeSeriesId || !['fit', 'width'].includes(mode)) return;
    setPictureChoice({ seriesId: activeSeriesId, mode });
    try { window.localStorage.setItem(`hongguo:picture-mode:${activeSeriesId}`, mode); }
    catch { showToast('画面模式已切换，但未能保存；下次打开可能恢复默认'); }
  };
  const [detail, setDetail] = useState(null); // { series_title, episodes: [...], total, completedCount }
  const [detailError, setDetailError] = useState('');
  const [currentIndex, setCurrentIndex] = useState(1);
  const [nativePictureInPicture, setNativePictureInPicture] = useState(false);
  const floatingPlayer = useFloatingPlayer(`${detail?.series_title || '红果短剧'} · 第 ${currentIndex} 集`, onFloatingChange, snapshot => {
    pendingSeekRef.current = snapshot.currentTime;
    pendingAutoplayRef.current = !snapshot.paused;
  });
  const playbackActive = active || floatingPlayer.floating || nativePictureInPicture;
  const [autoNext, setAutoNext] = useState(true);
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [cacheNext, setCacheNext] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [downloadQuality, setDownloadQuality] = useState('auto');
  const [onlineQualityChoice, setOnlineQualityChoice] = useState(() => {
    try { const value = window.localStorage.getItem('hongguo:online-quality'); return ['720p', '1080p'].includes(value) ? value : 'auto'; }
    catch { return 'auto'; }
  });
  const supportsOnlineQuality = !/^(xifan|hema|custom):/.test(activeSeriesId);
  const onlineQuality = supportsOnlineQuality ? onlineQualityChoice : 'auto';
  const [qualityLoading, setQualityLoading] = useState(true);
  const [waitingFor, setWaitingFor] = useState(null); // 正在等待下载的集号
  const [toast, setToast] = useState(null);
  const [rateNotice, setRateNotice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);   // 剧集选择面板
  const [pickerQuery, setPickerQuery] = useState('');

  // 在线播放（按需流式或临时准备后缓存）
  const [onlineVid, setOnlineVid] = useState(null);
  const [onlineUrl, setOnlineUrl] = useState('');
  const [mediaBuffering, setMediaBuffering] = useState(false);
  const [onlineProgress, setOnlineProgress] = useState(null); // {percent, phase}
  const [cacheInfo, setCacheInfo] = useState({ count: 0, bytes: 0 });
  const [downloadedRevision, setDownloadedRevision] = useState(0);
  const [downloadedMap, setDownloadedMap] = useState({}); // series_id -> {completed,total}
  const [storageMap, setStorageMap] = useState({});       // series_id -> {files,bytes}
  const [storageTotal, setStorageTotal] = useState({ files: 0, bytes: 0 });
  const [autoDelete, setAutoDelete] = useState(false);    // 看完自动删本地文件
  const [confirmAsk, setConfirmAsk] = useState(null);     // {title, message, danger, onOk}

  // 兼容模式：本机解不了 HEVC 时转码为 H.264
  const [autoCompat, setAutoCompat] = useState(true);
  const [compatMap, setCompatMap] = useState({});         // vidIndex -> 转码后 url
  const [compatProgress, setCompatProgress] = useState(null); // {vidIndex, percent}
  const [compatError, setCompatError] = useState('');
  const [decodeFailed, setDecodeFailed] = useState(false);    // 当前集解不出画面
  const [playbackError, setPlaybackError] = useState('');
  const [playbackVersion, setPlaybackVersion] = useState(0);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const [compatCache, setCompatCache] = useState({ files: 0, bytes: 0 });
  const [mergeAsk, setMergeAsk] = useState(false);            // 合并格式选择
  const [mergeError, setMergeError] = useState('');

  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const downloadToolsRef = useRef(null);
  const fullscreenScrollRef = useRef(null);
  const playbackRateRef = useRef(1);
  const toastTimer = useRef(null);
  const rateNoticeTimer = useRef(null);
  const mergeRequestRef = useRef(false);
  const mergeDialogGenerationRef = useRef(0);
  const pendingSeekRef = useRef(0); // 切集后要跳转的秒数
  const pendingAutoplayRef = useRef(false);
  const activeRef = useRef(playbackActive);
  activeRef.current = playbackActive;
  const navigationVersion = useRef(0);
  const storageDirtyRef = useRef(true);
  const lastActiveRef = useRef(active);
  const lastSavedRef = useRef(0);
  const stateRef = useRef({ currentIndex, autoNext, activeSeriesId });
  stateRef.current = { currentIndex, autoNext, activeSeriesId, waitingFor, downloadQuality, onlineQuality, qualityLoading, detail };
  const selectedSeriesRef = useRef('');
  const selectionVersion = useRef(0);
  const onlineRequestRef = useRef(null);
  const prefetchRef = useRef([]);
  const prefetchFailureRef = useRef(new Map());
  const mediaVersion = useRef(0);
  const compatRequestRef = useRef(null);
  const decodeTimer = useRef(null);
  const pendingTargetRef = useRef(null);
  const loadedMediaRef = useRef(null);
  const autoCompatAttemptRef = useRef(null);
  const reconnectAttemptRef = useRef(null);
  const onlineSourceRef = useRef(null);
  const lastVideoSrcRef = useRef('');
  const lastLoadRef = useRef(null);
  const fallbackRef = useRef(null);
  const fallbackAttemptRef = useRef(null);
  const rejectedLocalRef = useRef(null);

  // 只有收到当前片源的 metadata 后才保存，避免旧元素的 pause 覆盖新集断点。
  const persistPosition = useCallback((force = false, ended = false) => {
    const media = loadedMediaRef.current;
    if (!media?.played || media.version !== mediaVersion.current) return;
    const seconds = media.element.currentTime;
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (!force && Math.abs(seconds - lastSavedRef.current) < 3) return;
    lastSavedRef.current = seconds;
    window.electronAPI.savePlaybackPosition(media.seriesId, media.vidIndex, seconds,
      { duration: media.element.duration, ended: ended || media.element.ended === true }).catch(() => {});
  }, []);

  useEffect(() => window.electronAPI.onWatchHistoryUpdated?.(payload => {
    const media = loadedMediaRef.current;
    // A retained hidden player must not recreate a record removed on the history page.
    if (media && String(media.seriesId) === payload?.removedSeriesId) media.played = false;
  }), []);

  const currentPosition = useCallback(() => {
    const media = loadedMediaRef.current;
    return media?.version === mediaVersion.current && Number.isFinite(media.element.currentTime)
      ? media.element.currentTime : pendingSeekRef.current;
  }, []);

  const releaseOnline = useCallback(() => {
    const request = onlineRequestRef.current;
    onlineRequestRef.current = null;
    if (request) return window.electronAPI.releaseOnlinePlay({ requestId: request.requestId, streamId: request.streamId }).catch(() => {});
  }, []);

  const releasePrefetchRequest = useCallback((request) => {
    if (request == null) return;
    window.electronAPI.releaseOnlinePlay({ requestId: request.requestId, streamId: request.streamId }).catch(() => {});
  }, []);

  const releasePrefetch = useCallback(() => {
    const requests = prefetchRef.current;
    prefetchRef.current = [];
    prefetchFailureRef.current.clear();
    for (const request of requests) releasePrefetchRequest(request);
  }, [releasePrefetchRequest]);

  const prunePrefetchAfter = useCallback((seriesId, vidIndex, quality, consumed = null) => {
    const kept = [];
    for (const request of prefetchRef.current) {
      if (request === consumed) continue;
      if (request.seriesId !== seriesId || request.quality !== quality
        || Number(request.vidIndex) <= Number(vidIndex)) {
        releasePrefetchRequest(request);
      } else {
        kept.push(request);
      }
    }
    prefetchRef.current = kept;
  }, [releasePrefetchRequest]);

  const cancelCompat = useCallback(() => {
    const request = compatRequestRef.current;
    compatRequestRef.current = null;
    if (request && window.electronAPI.cancelTranscodeForPlayback) {
      window.electronAPI.cancelTranscodeForPlayback({ ...request }).catch(() => {});
    }
  }, []);

  const resetPlayback = useCallback((autoplay = true, preservePrefetch = false) => {
    fallbackRef.current = null;
    setPlaybackRequested(true);
    pendingAutoplayRef.current = autoplay && activeRef.current;
    setAutoAdvancing(false);
    persistPosition(true);
    const previous = loadedMediaRef.current;
    loadedMediaRef.current = null;
    previous?.element.pause();
    mediaVersion.current++;
    setPlaybackVersion(mediaVersion.current);
    autoCompatAttemptRef.current = null;
    clearTimeout(decodeTimer.current);
    cancelCompat();
    releaseOnline();
    if (preservePrefetch === false) releasePrefetch();
    setOnlineVid(null);
    setOnlineUrl('');
    setOnlineProgress(null);
    setMediaBuffering(false);
    setCompatProgress(null);
    setDecodeFailed(false);
    setCompatError('');
    setPlaybackError('');
    lastSavedRef.current = 0;
  }, [persistPosition, releaseOnline, cancelCompat, releasePrefetch]);

  const stopPlayback = (message = '播放已停止，可重试本集继续观看') => {
    const seekTo = currentPosition();
    resetPlayback();
    pendingSeekRef.current = seekTo;
    setWaitingFor(null);
    setPlaybackError(message);
  };

  useEffect(() => () => {
    persistPosition(true);
    selectionVersion.current++;
    mediaVersion.current++;
    selectedSeriesRef.current = '';
    cancelCompat();
    releaseOnline();
    releasePrefetch();
    clearTimeout(decodeTimer.current);
    clearTimeout(toastTimer.current);
    clearTimeout(rateNoticeTimer.current);
  }, [persistPosition, releaseOnline, cancelCompat, releasePrefetch]);

  const showToast = useCallback((text) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const changePlaybackRate = useCallback((value, notify = true) => {
    const rate = Number(value);
    if (!Number.isFinite(rate)) return;
    const next = Math.max(0.25, Math.min(4, rate));
    playbackRateRef.current = next;
    setPlaybackRate(next);
    const v = videoRef.current;
    if (v) {
      v.defaultPlaybackRate = next;
      v.playbackRate = next;
    }
    if (notify) {
      setRateNotice(next);
      clearTimeout(rateNoticeTimer.current);
      rateNoticeTimer.current = setTimeout(() => setRateNotice(null), 1800);
    }
  }, []);

  // 载入已登记的剧集列表
  const loadSeriesList = useCallback(async () => {
    const list = (await window.electronAPI.getSeriesList()) || [];
    setSeriesList(list);
    return list;
  }, []);

  // 载入某剧的分集状态
  const loadDetail = useCallback(async (seriesId) => {
    if (!seriesId) return null;
    const version = selectionVersion.current;
    const res = await window.electronAPI.getSeriesEpisodes(seriesId)
      .catch(error => ({ success: false, error: error.message }));
    if (version !== selectionVersion.current || String(seriesId) !== selectedSeriesRef.current) return null;
    if (!res?.success) {
      setDetailError(res?.error || '无法获取分集信息，请重试');
      return null;
    }
    setDetailError('');
    setDetail(res.data);
    return res.data;
  }, []);

  const usableLocal = useCallback((ep, seriesId) => ep && !ep.locked && ep.status === 'completed' && ep.fileUrl
    && localMediaKey(seriesId, ep) !== rejectedLocalRef.current
    && (stateRef.current.onlineQuality === 'auto' || /^(xifan|hema|custom):/.test(seriesId)
      || Number.parseInt(ep.actualQuality, 10) >= Number.parseInt(stateRef.current.onlineQuality, 10)), []);

  const resumeLocal = useCallback((ep, seekTo, autoplay = true) => {
    resetPlayback(autoplay);
    onlineSourceRef.current = null;
    setCompatMap(prev => { const next = { ...prev }; delete next[ep.vid_index]; return next; });
    pendingSeekRef.current = seekTo;
    setCurrentIndex(ep.vid_index);
    setWaitingFor(null);
  }, [resetPlayback]);

  const isCurrentFallback = useCallback(intent => fallbackRef.current === intent
    && intent.selection === selectionVersion.current && intent.media === mediaVersion.current
    && intent.seriesId === selectedSeriesRef.current && intent.vidIndex === stateRef.current.currentIndex, []);

  const recoverOnlineFailure = useCallback(async (ep, message) => {
    const seekTo = currentPosition();
    const autoplay = loadedMediaRef.current ? !loadedMediaRef.current.element.paused : pendingAutoplayRef.current;
    resetPlayback(autoplay);
    pendingSeekRef.current = seekTo;
    const intent = { seriesId: selectedSeriesRef.current, vidIndex: ep.vid_index, vid: ep.vid,
      selection: selectionVersion.current, media: mediaVersion.current, seekTo, autoplay, submitting: true };
    fallbackRef.current = intent;
    setPlaybackError(message);
    try {
      const data = await loadDetail(intent.seriesId);
      if (!isCurrentFallback(intent)) return;
      const latest = data?.episodes.find(item => item.vid_index === intent.vidIndex && item.vid === intent.vid);
      if (!latest || latest.locked) throw new Error(latest?.locked ? '该集已锁定，请在来源平台确认' : '无法刷新本集状态，请重试');
      if (usableLocal(latest, intent.seriesId)) { resumeLocal(latest, intent.seekTo, intent.autoplay); return; }
      const key = `${intent.selection}:${intent.seriesId}:${intent.vid}`;
      if (latest.taskId && ['pending', 'downloading'].includes(latest.status)) {
        intent.submitting = false;
        setPlaybackError(''); setWaitingFor(intent.vidIndex);
        return;
      }
      if (fallbackAttemptRef.current === key) throw new Error(latest.taskId
        ? '本集已有下载任务，请在下载管理检查或手动重试下载'
        : '本集未能加入下载，请点击“重试本集”或“下载本集”重新尝试');
      const settings = stateRef.current.qualityLoading ? await window.electronAPI.getSettings() : null;
      if (!isCurrentFallback(intent)) return;
      let quality = stateRef.current.onlineQuality !== 'auto' ? stateRef.current.onlineQuality : stateRef.current.qualityLoading
        ? (['1080p', '720p'].includes(settings?.download_quality) ? settings.download_quality : 'auto') : stateRef.current.downloadQuality;
      if (quality === 'auto' && !/^(xifan|hema|custom):/.test(intent.seriesId)) quality = '1080p';
      fallbackAttemptRef.current = key;
      setPlaybackError(''); setWaitingFor(intent.vidIndex);
      // Enqueue validates quality and reuses an existing task; cancelling playback never stops that shared download.
      const result = await window.electronAPI.downloadSingleEpisode(intent.seriesId, intent.vidIndex, quality);
      if (!isCurrentFallback(intent)) return;
      if (!result?.success) throw new Error(result?.error || '下载加入失败');
      intent.submitting = false;
    } catch (error) {
      if (!isCurrentFallback(intent)) return;
      intent.submitting = false;
      fallbackRef.current = null;
      setWaitingFor(null); setPlaybackError(`${message}；${error.message}`);
    }
  }, [currentPosition, resetPlayback, loadDetail, isCurrentFallback, usableLocal, resumeLocal]);

  const refreshOnlineCacheInfo = useCallback(async () => {
    try {
      const res = await window.electronAPI.onlineCacheStatus();
      if (res && res.success) setCacheInfo({ count: res.count, bytes: res.bytes });
    } catch (_) {}
  }, []);

  const refreshCacheInfo = useCallback(async () => {
    storageDirtyRef.current = false;
    await refreshOnlineCacheInfo();
    try {
      const st = await window.electronAPI.getStorageUsage();
      if (st && st.success) {
        const map = {};
        for (const s of st.series) map[String(s.series_id)] = { files: s.files, bytes: s.bytes, merged: s.merged };
        setStorageMap(map);
        setStorageTotal({ files: st.totalFiles, bytes: st.totalBytes });
      } else storageDirtyRef.current = true;
    } catch (_) { storageDirtyRef.current = true; }
  }, [refreshOnlineCacheInfo]);

  useEffect(() => {
    const off = ['onDownloadCompleted', 'onDownloadQueueChanged', 'onMergeCompleted', 'onWatchHistoryUpdated']
      .map(name => window.electronAPI[name]?.(() => { storageDirtyRef.current = true; }));
    return () => off.forEach(unsubscribe => unsubscribe?.());
  }, []);

  useEffect(() => {
    if (!active) { storageDirtyRef.current = true; return; }
    if (pickerOpen && storageDirtyRef.current) refreshCacheInfo();
  }, [active, pickerOpen, refreshCacheInfo]);

  const fmtSize = (b) => {
    if (!b || b <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  };

  const deleteDownloadedFiles = async (remove) => {
    try {
      const result = await remove();
      let message;
      if (result?.success) message = `已删除 ${result.count} 个文件，释放 ${fmtSize(result.freed)}`;
      else if (Number.isFinite(result?.count) && Number.isFinite(result?.failed)) {
        message = `已删除 ${result.count} 个文件，${result.failed} 个删除失败${result.error ? `：${result.error}` : ''}`;
      } else message = result?.error || '删除失败';
      showToast(message + (result?.warning ? `；${result.warning}` : ''));
    } catch (error) {
      showToast(error.message || '删除失败，请重试');
    } finally {
      setDownloadedRevision(revision => revision + 1);
      await Promise.all([loadDetail(activeSeriesId), refreshCacheInfo()]);
    }
  };

  useEffect(() => {
    refreshCacheInfo();
    window.electronAPI.getSettings().then((s) => {
      if (s) {
        setAutoDelete(s.auto_delete_watched === true);
        setCacheNext(s.cache_next_episode !== false);
        setAutoCompat(s.compat_mode !== false); // 默认开启
      }
    });
    window.electronAPI.compatCacheStatus().then((r) => {
      if (r && r.success) setCompatCache({ files: r.files, bytes: r.bytes });
    });
  }, [refreshCacheInfo]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setQualityLoading(true);
    window.electronAPI.getSettings().then((settings) => {
      if (!cancelled) {
        setDownloadQuality(['1080p', '720p'].includes(settings?.download_quality) ? settings.download_quality : 'auto');
        setShowDanmakuControls(settings?.show_danmaku_controls !== false);
        setAutoDelete(settings?.auto_delete_watched === true);
        setCacheNext(settings?.cache_next_episode !== false);
        setAutoCompat(settings?.compat_mode !== false);
      }
    }).catch(() => {
      if (!cancelled) showToast('默认下载清晰度读取失败，请确认清晰度后再下载');
    }).finally(() => { if (!cancelled) setQualityLoading(false); });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    if (!cacheNext) releasePrefetch();
  }, [cacheNext, releasePrefetch]);

  useEffect(() => {
    if (!window.electronAPI.onTranscodeProgress) return undefined;
    return window.electronAPI.onTranscodeProgress((d) => {
      const request = compatRequestRef.current;
      if (!request || d.requestId !== request.requestId || request.version !== mediaVersion.current || String(d.seriesId) !== request.seriesId || d.vidIndex !== request.vidIndex || d.done) return;
      setCompatProgress({ vidIndex: d.vidIndex, percent: d.percent || 0 });
    });
  }, []);

  const savePlaybackSetting = async (key, value, setValue) => {
    if (playbackSettingPending.current) return;
    playbackSettingPending.current = true;
    setPlaybackSettingSaving(true);
    try {
      const result = await window.electronAPI.saveSettings({ [key]: value });
      if (!result?.success) throw new Error(result?.error || '设置保存失败');
      setValue(value);
    } catch (error) {
      showToast(`设置未更改：${error.message}`);
    } finally {
      playbackSettingPending.current = false;
      setPlaybackSettingSaving(false);
    }
  };

  // 打开剧集面板或删除文件后，补全各剧的下载进度。
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    (async () => {
      const map = {};
      for (const s of seriesList) {
        try {
          const res = await window.electronAPI.getSeriesEpisodes(s.series_id);
          if (res && res.success) map[String(s.series_id)] = { completed: res.data.completedCount, total: res.data.total };
        } catch (_) {}
        if (cancelled) return;
      }
      if (!cancelled) setDownloadedMap(map);
    })();
    return () => { cancelled = true; };
  }, [pickerOpen, seriesList, downloadedRevision]);

  useEffect(() => {
    if (!window.electronAPI.onOnlinePlayProgress) return undefined;
    return window.electronAPI.onOnlinePlayProgress((d) => {
      const request = onlineRequestRef.current;
      if (!request || d.requestId !== request.requestId) return;
      if (d.code === 'MEDIA_TOO_LARGE') { showToast(d.error); return; }
      if (request.prepared) return;
      setOnlineProgress({
        vid: d.vid,
        percent: d.percent || 0,
        phase: d.phase || 'downloading',
        received: d.received,
        total: d.total,
      });
    });
  }, []);

  // 事件合并后才核对文件；等待下载本身不触发磁盘扫描。
  useEffect(() => {
    if (!activeSeriesId || !playbackActive) return;
    let busy = false, dirty = true;
    const unsubscribe = ['onDownloadTaskAdded', 'onDownloadCompleted', 'onDownloadFailed', 'onDownloadStopped', 'onDownloadQueueChanged', 'onWatchHistoryUpdated']
      .map(name => window.electronAPI[name]?.(() => { dirty = true; }));
    unsubscribe.push(window.electronAPI.onDownloadProgress?.(data => {
      setDetail(previous => {
        if (!previous?.episodes.some(ep => ep.taskId === data?.id)) return previous;
        return { ...previous, episodes: previous.episodes.map(ep => ep.taskId === data.id
          ? { ...ep, status: 'downloading', progress: data.progress, retryAt: null } : ep) };
      });
    }));
    const timer = setInterval(async () => {
      if (busy || !dirty) return;
      dirty = false;
      busy = true;
      const version = mediaVersion.current;
      const submitting = fallbackRef.current?.submitting;
      let d;
      try { d = await loadDetail(activeSeriesId); } catch (_) {} finally { busy = false; }
      if (!d) dirty = true;
      if (!d || !activeRef.current || version !== mediaVersion.current) return;
      const intent = fallbackRef.current;
      const recovery = intent && isCurrentFallback(intent) ? intent : null;
      const wf = stateRef.current.waitingFor ?? recovery?.vidIndex;
      if (wf != null) {
        const ep = d.episodes.find((e) => e.vid_index === wf);
        if (usableLocal(ep, String(activeSeriesId)) && (!recovery || ep.vid === recovery.vid)) {
          // 等待中的下一集下好了 -> 自动切过去
          setWaitingFor(null);
          const sameEpisode = wf === stateRef.current.currentIndex;
          const seekTo = recovery ? recovery.seekTo : sameEpisode ? currentPosition() : 0;
          resumeLocal(ep, seekTo, recovery ? recovery.autoplay : !sameEpisode || !loadedMediaRef.current?.element.paused);
        } else if (stateRef.current.waitingFor != null && !submitting && !recovery?.submitting
          && (!ep || ep.locked || (ep.status === 'failed' && !ep.retryAt) || ['stopped', 'cancelled', 'missing', 'completed'].includes(ep.status))) {
          setWaitingFor(null);
          fallbackRef.current = null;
          setPlaybackError(ep?.error || (ep?.status === 'stopped' || ep?.status === 'cancelled' ? '本集下载已停止，可在下载管理重试'
            : ep?.status === 'completed' ? '已有本地文件无法播放，请在下载管理检查文件' : '本集下载失败或任务已移除，请在下载管理检查后重试'));
        }
      }
    }, 2000);
    return () => { clearInterval(timer); unsubscribe.forEach(off => off?.()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackActive, activeSeriesId, waitingFor, loadDetail, currentPosition, isCurrentFallback, usableLocal, resumeLocal]);

  const episodes = detail ? detail.episodes : [];
  const current = useMemo(
    () => episodes.find((e) => e.vid_index === currentIndex) || null,
    [episodes, currentIndex]
  );

  const compatUrl = current ? compatMap[current.vid_index] : null;
  const isOnlinePlaying = onlineVid && current && current.vid === onlineVid && onlineUrl;
  const canPlay = !!(playbackRequested && !playbackError && !onlineProgress && current && !current.locked && (compatUrl || usableLocal(current, String(activeSeriesId)) || isOnlinePlaying));
  const playableSource = compatUrl || (isOnlinePlaying ? onlineUrl : current?.fileUrl) || '';
  // 原生全屏依附于 video 节点。准备下一集时保留结束帧，换源不换节点。
  if (canPlay) lastVideoSrcRef.current = playableSource;
  const videoSrc = !playbackRequested || compatProgress ? '' : lastVideoSrcRef.current;
  const danmakuSource = useDanmakuSource();
  const visualActive = canPlay && (active || floatingPlayer.floating);
  const danmakuActive = visualActive && showDanmakuControls;
  const commentDanmaku = useCommentDanmaku({ seriesId: activeSeriesId, episodeId: current?.vid, active: danmakuActive && danmakuSource === 'comments' });
  const officialDanmaku = useOfficialDanmaku({ seriesId: activeSeriesId, vid: current?.vid, active: danmakuActive && danmakuSource === 'official', preferences: commentDanmaku });
  const danmaku = { ...(danmakuSource === 'official' ? officialDanmaku : commentDanmaku), sourceKind: danmakuSource, setSource: writeDanmakuSource };

  useEffect(() => {
    const v = videoRef.current;
    if (loading || !canPlay || !v) return;
    const previous = lastLoadRef.current;
    lastLoadRef.current = { source: videoSrc, version: playbackVersion };
    v.defaultPlaybackRate = playbackRateRef.current;
    // 相同地址的显式重试不会触发 src 变更，用原生 load 重置媒体即可。
    if (previous?.source === videoSrc && previous.version !== playbackVersion) { v.src = videoSrc; v.load(); }
    v.playbackRate = playbackRateRef.current;
  }, [loading, canPlay, videoSrc, playbackVersion]);

  const playableCount = episodes.filter((e) => e.status === 'completed').length;

  /** 转码当前集为 H.264 后播放（解决本机无法解码 HEVC 的黑屏问题） */
  const startCompatPlay = useCallback(
    async (vidIndex, force = false) => {
      const ep = episodes.find((e) => e.vid_index === vidIndex);
      if (!ep || ep.locked) return;
      const request = { requestId: crypto.randomUUID(), seriesId: String(activeSeriesId), vidIndex,
        quality: onlineRequestRef.current?.playbackQuality || onlineQuality, version: mediaVersion.current };
      if (compatRequestRef.current?.version === request.version && compatRequestRef.current?.vidIndex === vidIndex) return;
      autoCompatAttemptRef.current = { version: request.version, force };
      pendingSeekRef.current = currentPosition();
      if (loadedMediaRef.current) pendingAutoplayRef.current = !loadedMediaRef.current.element.paused;
      fallbackRef.current = null;
      setWaitingFor(null);
      setPlaybackError('');
      persistPosition(true);
      videoRef.current?.pause();
      loadedMediaRef.current = null;
      // Windows must release the failed cache before FFmpeg replaces it. Keep the fullscreen node.
      videoRef.current?.removeAttribute('src');
      videoRef.current?.load();
      compatRequestRef.current = request;
      setCompatError('');
      setCompatProgress({ vidIndex, percent: 0 });
      try {
        const res = await window.electronAPI.transcodeForPlayback({
          requestId: request.requestId,
          seriesId: activeSeriesId,
          vidIndex,
          vid: ep.vid,
          quality: request.quality,
          filePath: onlineSourceRef.current === `${activeSeriesId}:${vidIndex}` ? null : ep.savePath || null,
          force,
        });
        if (compatRequestRef.current !== request || request.version !== mediaVersion.current) return;
        compatRequestRef.current = null;
        if (res && res.success) {
          loadedMediaRef.current = null;
          // A fast same-URL result can be batched with the loading state; restore the DOM source explicitly.
          if (videoRef.current) { videoRef.current.src = res.url; videoRef.current.load(); }
          setCompatMap((prev) => ({ ...prev, [vidIndex]: res.url }));
          setDecodeFailed(false);
          setCompatProgress(null);
          showToast(res.cached ? '已切换为兼容格式播放' : `已转码为兼容格式（用时 ${res.elapsed}s），开始播放`);
          window.electronAPI.compatCacheStatus().then((r) => {
            if (r && r.success) setCompatCache({ files: r.files, bytes: r.bytes });
          });
        } else {
          setCompatProgress(null);
          if (res?.code === 'MEDIA_TOO_LARGE') showToast(res.error);
          if (autoCompat && !res?.cancelled && reconnectOnce()) return;
          const message = (res && res.error) || '转码失败';
          if (!res?.cancelled && onlineSourceRef.current === `${activeSeriesId}:${vidIndex}`) {
            await recoverOnlineFailure(ep, message);
            return;
          }
          setDecodeFailed(true);
          setCompatError(message);
          showToast(message);
        }
      } catch (e) {
        if (compatRequestRef.current !== request || request.version !== mediaVersion.current) return;
        compatRequestRef.current = null;
        setCompatProgress(null);
        if (autoCompat && reconnectOnce()) return;
        if (onlineSourceRef.current === `${activeSeriesId}:${vidIndex}`) {
          await recoverOnlineFailure(ep, '转码异常: ' + e.message);
          return;
        }
        setDecodeFailed(true);
        setCompatError('转码异常: ' + e.message);
        showToast('转码异常: ' + e.message);
      }
    },
    [episodes, activeSeriesId, onlineQuality, autoCompat, reconnectOnce, showToast, currentPosition, persistPosition, recoverOnlineFailure]
  );

  const tryAutoCompat = useCallback((vidIndex) => {
    if (!autoCompat) return;
    const force = !!compatMap[vidIndex];
    const attempt = autoCompatAttemptRef.current;
    if (attempt?.version === mediaVersion.current && (!force || attempt.force)) {
      if (stateRef.current.onlineQuality === 'auto') reconnectOnce();
      return;
    }
    startCompatPlay(vidIndex, force);
  }, [autoCompat, compatMap, startCompatPlay, reconnectOnce]);

  const clearCompatCache = async () => {
    const affected = !!compatMap[currentIndex] || !!compatRequestRef.current;
    if (affected) stopPlayback('兼容播放已停止，可重试本集继续观看');
    try {
      const r = await window.electronAPI.clearCompatCache();
      if (!r?.success) { showToast(r?.error || '清理转码缓存失败'); return; }
      setCompatMap({});
      setCompatCache({ files: 0, bytes: 0 });
      showToast(r.count > 0 ? `已清理转码缓存，释放 ${fmtSize(r.freed)}` : '转码缓存已是空的');
    } catch (e) { showToast('清理转码缓存失败: ' + e.message); }
  };

  // 播放中若始终解不出画面（videoWidth 一直为 0），判定为解码不兼容。
  // 必须定义在早返回之前 —— hooks 不能出现在条件分支之后。
  const handlePlaying = useCallback((event) => {
    const media = loadedMediaRef.current;
    const element = event.currentTarget;
    if (!activeRef.current || element.paused || media?.version !== mediaVersion.current || media.element !== element) return;
    // 先记录“这一集真的播起来了”，不要因为 canPlay/playbackVersion 的 React 状态晚一拍
    // 就永久跳过预取和断点保存；下面的解码判定仍要求状态已经对齐。
    if (!media.played) {
      media.played = true;
      persistPosition(true);
    }
    if (playbackVersion !== mediaVersion.current || !canPlay) return;
    if (element.currentSrc && videoSrc && element.currentSrc !== videoSrc) return;
    setAutoAdvancing(false);
    setDecodeFailed(false);
    setMediaBuffering(false);
    const idx = currentIndex;
    const version = mediaVersion.current;
    clearTimeout(decodeTimer.current);
    decodeTimer.current = setTimeout(() => {
      if (version !== mediaVersion.current) return;
      const v = videoRef.current;
      if (!v) return;
      if (v.videoWidth === 0 && !v.paused && v.currentTime > 0.3) {
        setDecodeFailed(true);
        tryAutoCompat(idx);
      }
    }, 2600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, tryAutoCompat, playbackVersion, canPlay, videoSrc, persistPosition]);

  /**
   * 在线播放：明文片源按需加载，加密片源准备后返回播放地址。
   * 不占用下载目录；加密片源的准备文件会自动清理。
   */
  const startOnlinePlay = useCallback(
    async (vidIndex, resumeAt, force = false, autoplay = true, qualityIndex = 0) => {
      const ep = episodes.find((e) => e.vid_index === vidIndex);
      if (ep?.locked) { showToast('这一集需在来源平台解锁'); return; }
      if (!ep || !ep.vid) {
        showToast('这一集暂时无法播放，请重新获取剧集后重试');
        return;
      }
      const quality = stateRef.current.onlineQuality;
      const qualities = quality === 'auto' && !/^(xifan|hema|custom):/.test(activeSeriesId)
        ? AUTO_ONLINE_QUALITIES : [quality];
      onlineSourceRef.current = `${activeSeriesId}:${vidIndex}`;
      const seekTo = resumeAt ?? (vidIndex === stateRef.current.currentIndex ? currentPosition() : 0);
      const prefetched = force === false
        ? prefetchRef.current.find(item => item.vid === ep.vid && item.seriesId === activeSeriesId && item.quality === quality) || null
        : null;
      if (prefetched) prefetchFailureRef.current.delete(prefetchKey(activeSeriesId, prefetched.vid, prefetched.quality));
      if (force) {
        releasePrefetch();
      } else {
        // 跳到更远的集数时，目标集之前或不同清晰度的旧预取立即释放；
        // 目标集之后且同剧同清晰度的预取继续保留，切过去后可直接复用。
        prunePrefetchAfter(activeSeriesId, vidIndex, quality, prefetched);
      }
      resetPlayback(autoplay, force === false);
      setCompatMap(prev => { const next = { ...prev }; delete next[vidIndex]; return next; });
      const request = prefetched || { requestId: crypto.randomUUID(), vid: ep.vid };
      request.qualityIndex = qualityIndex;
      request.playbackQuality = qualities[qualityIndex];
      onlineRequestRef.current = request;
      pendingSeekRef.current = seekTo;
      setCurrentIndex(vidIndex);
      setWaitingFor(null);
      const prefetchedReady = prefetched?.ready === true;
      let usedPrefetch = !!prefetched;
      setOnlineProgress(prefetchedReady ? null : { vid: ep.vid, percent: 0, phase: 'preparing' });
      setOnlineVid(ep.vid);
      setOnlineUrl('');
      try {
        let res = prefetched ? await prefetched.promise : null;
        if (onlineRequestRef.current !== request) return;
        for (let index = qualityIndex; !res?.success && index < qualities.length; index++) {
          usedPrefetch = false;
          request.qualityIndex = index;
          request.playbackQuality = qualities[index];
          setOnlineProgress({ vid: ep.vid, percent: 0, phase: 'preparing' });
          try {
            res = await window.electronAPI.prepareOnlinePlay({
              requestId: request.requestId, vid: ep.vid, seriesId: activeSeriesId, vidIndex,
              quality: qualities[index], force,
            });
          } catch (error) { res = { success: false, error: error.message }; }
          if (onlineRequestRef.current !== request) break;
          if (!res?.success && index + 1 < qualities.length) {
            showToast(`${qualities[index].toUpperCase()} 暂不可用，正在尝试${qualities[index + 1] === 'auto' ? '兼容片源' : qualities[index + 1].toUpperCase()}`);
          }
        }
        if (onlineRequestRef.current !== request) {
          window.electronAPI.releaseOnlinePlay({ requestId: request.requestId, streamId: res?.streamId }).catch(() => {});
          return;
        }
        if (!res || !res.success) {
          if (res?.code === 'MEDIA_TOO_LARGE') showToast(res.error);
          await recoverOnlineFailure(ep, (res && res.error) || '在线播放准备失败');
          return;
        }
        request.streamId = res.streamId;
        request.prepared = true;
        if (!usedPrefetch && !res.cached) setMediaBuffering(true);
        setOnlineUrl(res.url);
        setOnlineProgress(null);
        // Playback cache changes do not need a synchronous scan of all download directories.
        refreshOnlineCacheInfo();
      } catch (e) {
        if (onlineRequestRef.current !== request) return;
        await recoverOnlineFailure(ep, '在线播放失败: ' + e.message);
      }
    },
    [episodes, activeSeriesId, showToast, refreshOnlineCacheInfo, resetPlayback, releaseOnline, currentPosition, recoverOnlineFailure, prunePrefetchAfter]
  );

  function reconnectOnce() {
    const key = `${activeSeriesId}:${currentIndex}`;
    if (stateRef.current.onlineQuality === 'auto' && !/^(xifan|hema|custom):/.test(activeSeriesId)
      && onlineSourceRef.current === key) {
      const next = (onlineRequestRef.current?.qualityIndex ?? 0) + 1;
      if (!current?.vid || current.locked || next >= AUTO_ONLINE_QUALITIES.length) return false;
      showToast(`正在自动切换到${AUTO_ONLINE_QUALITIES[next] === 'auto' ? '兼容片源' : AUTO_ONLINE_QUALITIES[next].toUpperCase()}…`);
      startOnlinePlay(currentIndex, currentPosition(), true,
        loadedMediaRef.current ? !loadedMediaRef.current.element.paused : pendingAutoplayRef.current, next);
      return true;
    }
    if (!current?.vid || current.locked || reconnectAttemptRef.current === key) return false;
    reconnectAttemptRef.current = key;
    if (onlineSourceRef.current !== key && current.status === 'completed') rejectedLocalRef.current = localMediaKey(String(activeSeriesId), current);
    showToast('正在重新获取本集片源…');
    startOnlinePlay(currentIndex, currentPosition(), true, loadedMediaRef.current ? !loadedMediaRef.current.element.paused : pendingAutoplayRef.current);
    return true;
  }

  // 切集
  const goToEpisode = useCallback(
    (vidIndex, resumeAt) => {
      const ep = episodes.find((e) => e.vid_index === vidIndex);
      if (!ep || ep.locked) return;
      fallbackAttemptRef.current = null;
      reconnectAttemptRef.current = null;
      if (!usableLocal(ep, String(activeSeriesId))) {
        startOnlinePlay(vidIndex, resumeAt);
        return;
      }
      onlineSourceRef.current = null;
      const seekTo = resumeAt ?? (vidIndex === stateRef.current.currentIndex ? currentPosition() : 0);
      resetPlayback(true, true);
      prunePrefetchAfter(activeSeriesId, vidIndex, onlineQuality);
      setCurrentIndex(vidIndex);
      setWaitingFor(null);
      pendingSeekRef.current = seekTo;
    },
    [episodes, activeSeriesId, resetPlayback, startOnlinePlay, currentPosition, usableLocal, prunePrefetchAfter, onlineQuality]
  );

  const retryPlayback = async () => {
    const version = mediaVersion.current, selection = selectionVersion.current, navigation = navigationVersion.current;
    let data;
    try { data = await loadDetail(activeSeriesId); } catch (_) {}
    if (!activeRef.current || navigation !== navigationVersion.current || version !== mediaVersion.current || selection !== selectionVersion.current) return;
    const latest = data?.episodes.find(ep => ep.vid_index === currentIndex && ep.vid === current?.vid);
    if (usableLocal(latest, String(activeSeriesId))) { resumeLocal(latest, currentPosition()); return; }
    setCompatMap(prev => { const next = { ...prev }; delete next[currentIndex]; return next; });
    if (onlineSourceRef.current === `${activeSeriesId}:${currentIndex}` || current?.status !== 'completed') {
      fallbackAttemptRef.current = null;
      reconnectAttemptRef.current = null;
      startOnlinePlay(currentIndex, currentPosition(), true);
    } else goToEpisode(currentIndex, currentPosition());
  };

  const changeOnlineQuality = (quality) => {
    if (!['auto', '720p', '1080p'].includes(quality) || !supportsOnlineQuality) return;
    const seekTo = currentPosition();
    const autoplay = loadedMediaRef.current ? !loadedMediaRef.current.element.paused : pendingAutoplayRef.current;
    setOnlineQualityChoice(quality);
    stateRef.current.onlineQuality = quality;
    try { window.localStorage.setItem('hongguo:online-quality', quality); } catch { showToast('本次清晰度已切换，但未能保存'); }
    fallbackAttemptRef.current = null;
    reconnectAttemptRef.current = null;
    setCompatMap({});
    if (playbackRequested && current && !current.locked) startOnlinePlay(currentIndex, seekTo, true, autoplay);
  };

  // 找下一集（按集号顺序）
  const findNext = useCallback(
    (fromIndex) => {
      const idx = episodes.findIndex((e) => e.vid_index === fromIndex);
      if (idx === -1 || idx + 1 >= episodes.length) return null;
      return episodes.slice(idx + 1).find((ep) => !ep.locked) || null;
    },
    [episodes]
  );
  const findPrev = useCallback(
    (fromIndex) => {
      const idx = episodes.findIndex((e) => e.vid_index === fromIndex);
      if (idx <= 0) return null;
      return episodes.slice(0, idx).reverse().find((ep) => !ep.locked) || null;
    },
    [episodes]
  );

  // 只预取后续可在线播放、尚未锁定且没有本地文件的分集，最多两集。
  const prefetchCandidates = useCallback((fromIndex, count = PREFETCH_AHEAD) => {
    const start = episodes.findIndex((episode) => episode.vid_index === fromIndex);
    if (start === -1) return [];
    const result = [];
    for (let index = start + 1; index < episodes.length && result.length < count; index += 1) {
      const episode = episodes[index];
      if (episode?.locked || String(episode?.vid || '') === '' || usableLocal(episode, String(activeSeriesId))) continue;
      result.push(episode);
    }
    return result;
  }, [episodes, activeSeriesId, usableLocal]);

  const prepareNextEpisode = (event) => {
    const video = event.currentTarget;
    const media = loadedMediaRef.current;
    // 这里只依赖当前元素和版本；media.played 可能因 playing 事件的 React 状态晚一拍而
    // 还没置位，不能让它永久挡住后续分集预取。
    if (cacheNext === false || canPlay === false || video.paused || media?.version !== mediaVersion.current || media.element !== video) return;
    const targets = prefetchCandidates(currentIndex);
    const desired = new Set(targets.map(episode => prefetchKey(activeSeriesId, episode.vid, onlineQuality)));
    const kept = [];
    for (const request of prefetchRef.current) {
      if (desired.has(prefetchKey(request.seriesId, request.vid, request.quality))) kept.push(request);
      else releasePrefetchRequest(request);
    }
    prefetchRef.current = kept;
    for (const episode of targets) {
      const key = prefetchKey(activeSeriesId, episode.vid, onlineQuality);
      if (kept.some(request => prefetchKey(request.seriesId, request.vid, request.quality) === key)) continue;
      const failedAt = prefetchFailureRef.current.get(key);
      if (failedAt && Date.now() - failedAt < PREFETCH_RETRY_MS) continue;
      const request = { requestId: crypto.randomUUID(), vid: episode.vid, seriesId: activeSeriesId,
        vidIndex: episode.vid_index, quality: onlineQuality, ready: false };
      prefetchRef.current = [...prefetchRef.current, request];
      request.promise = window.electronAPI.prepareOnlinePlay({ ...request,
        quality: onlineQuality === 'auto' && supportsOnlineQuality ? '1080p' : onlineQuality, prefetch: true })
        .catch(error => ({ success: false, error: error?.message || String(error) }))
        .then(result => {
          request.ready = result?.success === true;
          if (prefetchRef.current.includes(request)) {
            if (result?.success) {
              prefetchFailureRef.current.delete(key);
              refreshOnlineCacheInfo();
            } else {
              const index = prefetchRef.current.indexOf(request);
              if (index >= 0) prefetchRef.current.splice(index, 1);
              prefetchFailureRef.current.set(key, Date.now());
              if (result?.streamId) request.streamId = result.streamId;
              releasePrefetchRequest(request);
            }
          } else if (onlineRequestRef.current === request) {
            // 已被切集流程接管，当前播放会话负责后续释放。
          } else {
            if (result?.streamId) request.streamId = result.streamId;
            releasePrefetchRequest(request);
          }
          return result;
        });
    }
  };

  // 先交接下一集或释放当前媒体，再清理刚看完的文件和缓存。
  const handleEnded = useCallback(async () => {
    const { currentIndex: ci, autoNext: an, activeSeriesId: sid } = stateRef.current;
    const next = an ? findNext(ci) : null;
    persistPosition(true, true);
    const released = autoDelete && sid ? releaseOnline() : null;
    if (autoDelete && sid) {
      loadedMediaRef.current = null;
      videoRef.current?.pause();
      videoRef.current?.removeAttribute('src');
      videoRef.current?.load();
      lastVideoSrcRef.current = '';
      setCompatMap(previous => { const result = { ...previous }; delete result[ci]; return result; });
    }
    if (next) {
      goToEpisode(next.vid_index, 0);
      setAutoAdvancing(true);
    } else {
      if (autoDelete && sid) {
        resetPlayback(false);
        setPlaybackRequested(false);
        pendingSeekRef.current = 0;
      }
      if (an) showToast(episodes.some(ep => ep.locked) ? '已播完可播放集数，其余集数需在来源平台解锁' : '已经是最后一集');
    }
    if (autoDelete && sid) {
      await released;
      window.electronAPI.cleanupWatchedEpisode(sid, ci).then(async result => {
        if (!result?.success) throw new Error(result?.error || '清理失败，请在剧库中重试');
        if (result.count > 0) showToast(`第 ${ci} 集已看完，清理文件和缓存（释放 ${fmtSize(result.freed)}）`);
        refreshCacheInfo();
        loadDetail(sid);
        const cache = await window.electronAPI.compatCacheStatus();
        if (cache?.success) setCompatCache({ files: cache.files, bytes: cache.bytes });
      }).catch(error => showToast(`第 ${ci} 集自动清理失败：${error.message}`));
    }
  }, [findNext, goToEpisode, showToast, autoDelete, episodes, refreshCacheInfo, loadDetail, persistPosition, resetPlayback, releaseOnline]);

  // 离开页面、暂停和关闭窗口强制保存最后一秒。
  useEffect(() => {
    const timer = setInterval(persistPosition, 5000);
    const save = () => persistPosition(true);
    window.addEventListener('beforeunload', save);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', save);
      save();
    };
  }, [persistPosition]);

  useEffect(() => {
    const video = videoRef.current;
    const sync = () => {
      const native = !!video && document.pictureInPictureElement === video;
      setNativePictureInPicture(native);
      onFloatingChange?.(native || floatingPlayer.floating);
    };
    sync();
    if (!video) return;
    video.addEventListener('enterpictureinpicture', sync);
    video.addEventListener('leavepictureinpicture', sync);
    return () => {
      video.removeEventListener('enterpictureinpicture', sync);
      video.removeEventListener('leavepictureinpicture', sync);
    };
  }, [loading, videoSrc, floatingPlayer.floating, onFloatingChange]);

  useEffect(() => {
    if (playbackActive) return;
    navigationVersion.current++;
    persistPosition(true);
    pendingAutoplayRef.current = false;
    pendingTargetRef.current = null;
    fallbackRef.current = null;
    setWaitingFor(null);
    setAutoAdvancing(false);
    const video = videoRef.current;
    video?.pause();
  }, [playbackActive, persistPosition]);

  const handleMetadata = (event) => {
    const v = event.currentTarget;
    if (!canPlay || playbackVersion !== mediaVersion.current || v !== videoRef.current || !current || current.locked) return;
    if (v.currentSrc && v.currentSrc !== videoSrc) return;
    loadedMediaRef.current = { element: v, seriesId: activeSeriesId, vidIndex: currentIndex, version: mediaVersion.current, played: false };
    v.defaultPlaybackRate = playbackRateRef.current;
    v.playbackRate = playbackRateRef.current;
    const seekTo = Math.max(0, Number(pendingSeekRef.current) || 0);
    if (seekTo > 0 && (!Number.isFinite(v.duration) || seekTo < v.duration - 3)) {
      v.currentTime = seekTo;
      showToast(`从 ${Math.floor(seekTo / 60)}:${String(Math.floor(seekTo % 60)).padStart(2, '0')} 继续播放`);
    }
    pendingSeekRef.current = 0;
    if (compatMap[currentIndex]) releaseOnline();
    if (activeRef.current && pendingAutoplayRef.current) v.play().catch(() => { if (playbackVersion === mediaVersion.current) setAutoAdvancing(false); });
  };

  const restoreFullscreenScroll = useCallback(() => {
    const saved = fullscreenScrollRef.current;
    if (!saved || document.fullscreenElement) return;
    saved.element.scrollTop = saved.top;
    fullscreenScrollRef.current = null;
  }, []);

  useEffect(() => {
    let frame = 0;
    const restore = () => {
      if (!document.fullscreenElement) frame = requestAnimationFrame(restoreFullscreenScroll);
    };
    document.addEventListener('fullscreenchange', restore);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('fullscreenchange', restore); };
  }, [restoreFullscreenScroll]);

  const toggleFullscreen = useCallback(async () => {
    if (document.querySelector('.stealth-mode')) { showToast('请先退出小窗模式'); return; }
    try {
      const stageDocument = stageRef.current?.ownerDocument || document;
      if (portrait && !floatingPlayer.floating) { setWindowFill(fill => !fill); return; }
      if (stageDocument.fullscreenElement === stageRef.current) await stageDocument.exitFullscreen();
      else {
        const element = stageRef.current?.closest('.main-content');
        // Fullscreen takes the player out of flow and can clamp the page's scrollTop to zero.
        if (element && !fullscreenScrollRef.current) fullscreenScrollRef.current = { element, top: element.scrollTop };
        await stageRef.current?.requestFullscreen();
      }
    } catch { restoreFullscreenScroll(); showToast('无法进入或退出全屏，请重试'); }
  }, [portrait, floatingPlayer.floating, showToast, restoreFullscreenScroll]);

  // Capture handled keys before media controls; cancel keyup too so focused buttons cannot toggle twice.
  useEffect(() => {
    if ((!active && !floatingPlayer.floating) || confirmAsk || mergeAsk || pickerOpen) return;
    const keyboardWindow = stageRef.current?.ownerDocument?.defaultView || window;
    const held = new Set();
    const onKey = (event) => {
      const video = videoRef.current;
      if (!video || event.defaultPrevented || ignoresPlaybackShortcut(event.target, event.key)) return;
      const key = shortcutKey(event);
      const action = SHORTCUT_ACTIONS.find(item => shortcuts[item.id] === key);
      if (!action) return;
      event.preventDefault(); event.stopPropagation?.();
      held.add(event.code || event.key);
      if (event.repeat && !action.repeat) return;
      const { currentIndex: index, autoNext: nextEnabled } = stateRef.current;
      if (action.id === 'play') {
        if (video.paused) video.play().catch(() => showToast('暂时无法播放，请重试本集'));
        else video.pause();
      } else if (action.id === 'forward' || action.id === 'backward') {
        const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
        try { video.currentTime = Math.max(0, Math.min(limit, video.currentTime + (action.id === 'forward' ? 5 : -5))); }
        catch { showToast('暂时无法跳转，请稍后重试'); }
      } else if (action.id === 'previous' || action.id === 'next') {
        const episode = action.id === 'previous' ? findPrev(index) : findNext(index);
        if (episode) { goToEpisode(episode.vid_index); setAutoAdvancing(true); }
        else showToast(action.id === 'previous' ? '已经是第一集' : '已经是最后一集');
      } else if (action.id === 'autoNext') setAutoNext(!nextEnabled);
      else if (action.id === 'fullscreen') toggleFullscreen();
      else changePlaybackRate(playbackRateRef.current + (action.id === 'slower' ? -0.25 : 0.25));
    };
    const onKeyUp = event => {
      if (!held.delete(event.code || event.key)) return;
      event.preventDefault(); event.stopPropagation?.();
    };
    const onBlur = () => held.clear();
    keyboardWindow.addEventListener('keydown', onKey, true);
    keyboardWindow.addEventListener('keyup', onKeyUp, true);
    keyboardWindow.addEventListener('blur', onBlur);
    return () => {
      keyboardWindow.removeEventListener('keydown', onKey, true);
      keyboardWindow.removeEventListener('keyup', onKeyUp, true);
      keyboardWindow.removeEventListener('blur', onBlur);
    };
  }, [active, floatingPlayer.floating, confirmAsk, mergeAsk, pickerOpen, findNext, findPrev, goToEpisode, changePlaybackRate, showToast, shortcuts, toggleFullscreen]);

  const switchSeries = useCallback(async (sid, requestedIndex = 0, resume = false, autoplay = true) => {
    persistPosition(true);
    const version = ++selectionVersion.current;
    selectedSeriesRef.current = String(sid);
    fallbackAttemptRef.current = null;
    rejectedLocalRef.current = null;
    onSeriesSelected?.(String(sid));
    pendingTargetRef.current = null;
    reconnectAttemptRef.current = null;
    onlineSourceRef.current = null;
    resetPlayback(autoplay);
    setPlaybackRequested(autoplay);
    setCompatMap({});
    mergeDialogGenerationRef.current += 1;
    setMergeAsk(false);
    setMergeError('');
    setActiveSeriesId(String(sid));
    setDetail(null);
    setDetailError('');
    setWaitingFor(null);
    setLoading(true);
    try {
      const d = await loadDetail(sid);
      if (!d || version !== selectionVersion.current) return;
      const saved = requestedIndex && !resume ? null : await window.electronAPI.getPlaybackPosition(sid);
      if (version !== selectionVersion.current) return;
      const wantedIndex = requestedIndex || saved?.vid_index;
      const selected = d.episodes.find(e => e.vid_index === wantedIndex && !e.locked) || d.episodes.find(e => !e.locked);
      setCurrentIndex(selected?.vid_index || 1);
      pendingSeekRef.current = selected?.vid_index === saved?.vid_index ? saved.currentTime || 0 : 0;
      if (autoplay && selected && !usableLocal(selected, String(sid))) {
        pendingTargetRef.current = { seriesId: String(sid), vidIndex: selected.vid_index, seekTo: pendingSeekRef.current, autoplay: pendingAutoplayRef.current };
      }
    } catch (e) {
      if (version === selectionVersion.current) showToast('加载剧集失败: ' + e.message);
    } finally {
      if (version === selectionVersion.current) setLoading(false);
    }
  }, [persistPosition, resetPlayback, loadDetail, showToast, onSeriesSelected, usableLocal]);

  // 初次进入与浏览点播共用一次载入，避免两个初始化请求互相覆盖。
  useEffect(() => {
    let cancelled = false;
    const navigation = navigationVersion.current;
    setLoading(true);
    (async () => {
      try {
        const list = await loadSeriesList();
        if (cancelled) return;
        const wanted = target?.seriesId && list.find(s => String(s.series_id) === String(target.seriesId));
        const selected = wanted || [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        if (selected) await switchSeries(selected.series_id, wanted ? target.vidIndex : 0, !!(wanted && target.resume), !!wanted && target.autoplay !== false && navigation === navigationVersion.current);
        else setLoading(false);
      } catch (e) {
        if (!cancelled) { setLoading(false); showToast('加载剧库失败: ' + e.message); }
      }
    })();
    return () => { cancelled = true; };
  }, [target?.ts, loadSeriesList, switchSeries, showToast]);

  useEffect(() => {
    const returned = active && !lastActiveRef.current;
    lastActiveRef.current = active;
    if (!active || (!returned && !pickerOpen)) return;
    let cancelled = false;
    loadSeriesList().then(list => {
      if (!cancelled && !selectedSeriesRef.current && list[0]) switchSeries(list[0].series_id, 0, true, false);
    }).catch(() => { if (!cancelled) showToast('刷新剧库失败，请重新打开剧集面板'); });
    return () => { cancelled = true; };
  }, [active, pickerOpen, loadSeriesList, switchSeries, showToast]);

  useEffect(() => {
    const pending = pendingTargetRef.current;
    if (loading || !pending || pending.seriesId !== String(activeSeriesId) || String(detail?.series_id) !== pending.seriesId) return;
    pendingTargetRef.current = null;
    startOnlinePlay(pending.vidIndex, pending.seekTo, false, pending.autoplay);
  }, [loading, detail, activeSeriesId, startOnlinePlay]);

  // 从列表移除一部短剧（只取消登记，不删本地文件）
  const removeSeries = async (sid, title) => {
    const res = await window.electronAPI.forgetSeries(sid).catch(error => ({ success: false, error: error.message }));
    if (!res || !res.success) {
      showToast((res && res.error) || '移除失败');
      return;
    }
    showToast(`已永久移除《${title}》的剧库记录（本地文件保留）`);
    const list = await loadSeriesList();
    refreshCacheInfo();
    if (String(sid) === String(activeSeriesId)) {
      const next = list[0];
      if (next) await switchSeries(next.series_id, 0, true, false);
      else {
        selectionVersion.current++;
        selectedSeriesRef.current = '';
        resetPlayback();
        setActiveSeriesId('');
        setDetail(null);
      }
    }
  };

  const clearCache = async () => {
    releasePrefetch();
    if (onlineRequestRef.current && !compatMap[currentIndex]) {
      stopPlayback('在线播放已停止，可重试本集继续观看');
    }
    try {
      const r = await window.electronAPI.clearOnlineCache();
      if (!r?.success) { showToast(r?.error || '清理播放缓存失败'); return; }
      refreshCacheInfo();
      showToast('已清空在线播放缓存');
    } catch (e) { showToast('清理播放缓存失败: ' + e.message); }
  };

  const downloadEpisode = async (vidIndex) => {
    if (qualityLoading || !episodes.some((ep) => ep.vid_index === vidIndex && !ep.locked)) return;
    const selection = selectionVersion.current;
    const media = mediaVersion.current;
    const navigation = navigationVersion.current;
    try {
      const res = await window.electronAPI.downloadSingleEpisode(activeSeriesId, vidIndex, downloadQuality);
      if (res && res.success) {
        showToast(res.count > 0 ? `第 ${vidIndex} 集已加入下载队列` : `第 ${vidIndex} 集已在队列中`);
        if (activeRef.current && navigation === navigationVersion.current && selection === selectionVersion.current && media === mediaVersion.current
          && String(activeSeriesId) === selectedSeriesRef.current && stateRef.current.currentIndex === vidIndex) setWaitingFor(vidIndex);
      } else {
        showToast((res && res.error) || '加入下载失败');
      }
    } catch (error) { showToast(error.message || '加入下载失败，请重试'); }
  };

  const downloadMissing = async (nextCount = null) => {
    if (qualityLoading || (nextCount !== null && !current)) return;
    const missing = episodes.filter((e) => !e.locked && e.status !== 'completed'
      && (nextCount === null || (e.vid_index > current.vid_index && e.vid_index <= current.vid_index + nextCount)));
    if (!missing.length) {
      showToast(nextCount === null ? '可下载的集数已全部下载' : '所选范围内没有需要下载的集数');
      return;
    }
    let ok = 0;
    let firstError = '';
    for (const ep of missing) {
      try {
        const r = await window.electronAPI.downloadSingleEpisode(activeSeriesId, ep.vid_index, downloadQuality);
        if (r?.success) ok++;
        else if (!firstError) firstError = r?.error || '加入下载失败';
      } catch (error) { if (!firstError) firstError = error.message || '加入下载失败'; }
    }
    showToast(firstError ? `${ok} 集提交成功，${missing.length - ok} 集失败：${firstError}` : `已把 ${ok} 集加入下载队列`);
  };

  // 一键合并当前这部剧（弹出格式选择）
  const openMergeDialog = () => {
    mergeDialogGenerationRef.current += 1;
    setMergeError('');
    setMergeAsk(true);
  };

  const closeMergeDialog = () => {
    mergeDialogGenerationRef.current += 1;
    setMergeError('');
    setMergeAsk(false);
  };

  const mergeThisSeries = async (compatible, require1080 = false) => {
    if (mergeRequestRef.current) return;
    mergeRequestRef.current = true;
    const dialogGeneration = mergeDialogGenerationRef.current;
    setMerging(true);
    setMergeError('');
    try {
      const options = require1080 ? { compatible: false, require1080: true } : { compatible };
      const res = await window.electronAPI.mergeSeries(activeSeriesId, '', options);
      if (dialogGeneration !== mergeDialogGenerationRef.current) return;
      if (!res || !res.success) {
        setMergeError((res && res.error) || '合并失败');
        return;
      }
      closeMergeDialog();
      const tip = compatible
        ? `开始兼容格式合并 ${res.count} 集（H.264，耗时较长）`
        : require1080
        ? `开始高质量分辨率合并 ${res.count} 集`
        : `开始合并 ${res.count} 集，约 ${(res.totalBytes / 1073741824).toFixed(2)} GB`;
      showToast(`${tip}，可在「下载管理」查看进度`);
      if (res.codecWarning) showToast(res.codecWarning);
    } catch (e) {
      if (dialogGeneration === mergeDialogGenerationRef.current) setMergeError('合并异常: ' + e.message);
    } finally {
      mergeRequestRef.current = false;
      setMerging(false);
    }
  };

  useDialogKeyboard(active && !!(confirmAsk || mergeAsk), () => { setConfirmAsk(null); closeMergeDialog(); }, '.player-confirm');

  useEffect(() => {
    if (actionsHidden || !active || !portrait) {
      setEpisodesOpen(false);
    }
    if (actionsHidden || !active) setPickerOpen(false);
  }, [actionsHidden, active, portrait]);

  useEffect(() => {
    window.electronAPI.setEpisodePanelOpen?.(active && portrait && episodesOpen && !loading).catch(() => {
      setEpisodesOpen(false);
      showToast('选集无法展开，请重试');
    });
  }, [active, portrait, episodesOpen, loading, showToast]);
  useEffect(() => () => { window.electronAPI.setEpisodePanelOpen?.(false).catch(() => {}); }, []);

  // ===== 渲染 =====
  if (loading) {
    return <div className="player-container"><div className="player-empty">加载中…</div></div>;
  }

  if (!detail && detailError) {
    return (
      <div className="player-container">
        <div className="player-empty" role="alert">
          <p>加载剧集失败：{detailError}</p>
          <button className="btn btn-primary" onClick={() => switchSeries(activeSeriesId,
            String(target?.seriesId) === activeSeriesId ? target.vidIndex : 0,
            String(target?.seriesId) === activeSeriesId && !!target.resume)}>
            <RefreshCw size={16} /> 重试加载
          </button>
        </div>
      </div>
    );
  }

  if (!seriesList.length) {
    return (
      <div className="player-container">
        <div className="player-header">
          <div className="player-title"><Play size={22} /><h2>我的剧库</h2></div>
        </div>
        <div className="player-empty">
          <Film size={40} />
          <p>还没有可播放的短剧</p>
          <p className="player-empty-sub">先发现或搜索一部短剧，在这里选择集数、观看和管理。</p>
          <div className="player-empty-actions">
            {onNavigate && (
              <button className="btn btn-primary" onClick={() => onNavigate('browse')}>
                发现短剧
              </button>
            )}
            {onNavigate && (
              <button className="btn btn-outline" onClick={() => onNavigate('download')}>
                搜索剧集
              </button>
            )}
          </div>

        </div>
      </div>
    );
  }

  return (
    <div className={`player-container ${episodesOpen ? '' : 'episodes-collapsed'}`}>
      {/* 剧集选择：当前剧 + 下拉管理面板（替代原来会越堆越长的横条） */}
      <div className="player-series-row" hidden={actionsHidden}>
        <div className="player-series-current">
          <span className="player-series-name" title={detail ? detail.series_title : ''}>
            {detail ? detail.series_title : '—'}
          </span>
          <span className="player-stat">已下载 {playableCount} / {episodes.length || 0} 集</span>
        </div>
      </div>

      <div className="player-online-quality-row" hidden={actionsHidden}>
          <label className="player-download-quality">
            <span>在线播放清晰度</span>
            <select className="input-field" aria-label="在线播放清晰度" value={onlineQuality}
              disabled={!supportsOnlineQuality} title="自动优先1080P，失败后尝试720P和兼容片源；手动指定画质保持固定。"
              onChange={event => changeOnlineQuality(event.target.value)}>
              <option value="auto">{supportsOnlineQuality ? '自动（1080P优先）' : '由片源决定'}</option>
              <option value="720p">720P</option>
              <option value="1080p">1080P</option>
            </select>
          </label>
      </div>

      <div className="player-header" hidden={actionsHidden}>
        <div className="player-header-right">
          <button aria-pressed={cacheNext} className={`btn btn-outline ${cacheNext ? 'btn-autonext-on' : ''}`}
            disabled={qualityLoading || playbackSettingSaving}
            onClick={() => savePlaybackSetting('cache_next_episode', !cacheNext, setCacheNext)}
            style={{ whiteSpace: 'nowrap' }}
            title="开始播放后最多预缓存后续两集，减少连续切集等待；会使用网络流量">
            <Download size={15} />缓存后续 2 集 {cacheNext ? '开' : '关'}
          </button>
          <button
            aria-pressed={autoNext}
            className={`btn btn-outline ${autoNext ? 'btn-autonext-on' : ''}`}
            onClick={() => setAutoNext(!autoNext)}
            title={`播完自动播放下一集（${formatShortcut(shortcuts.autoNext)}）`}
          >
            <Layers size={15} />
            连播 {autoNext ? '开' : '关'}
          </button>
          <button aria-pressed={autoCompat} className={`btn btn-outline ${autoCompat ? 'btn-autonext-on' : ''}`}
            disabled={qualityLoading || playbackSettingSaving}
            onClick={() => savePlaybackSetting('compat_mode', !autoCompat, setAutoCompat)}
            title="无法解码时自动转码为 H.264 播放">
            <Zap size={15} />兼容模式 {autoCompat ? '开' : '关'}
          </button>
          <button aria-pressed={autoDelete} className={`btn btn-outline ${autoDelete ? 'btn-autonext-on' : ''}`}
            disabled={qualityLoading || playbackSettingSaving}
            title="看完一集后删除该集的下载文件与播放缓存；开启前需确认"
            onClick={() => autoDelete ? savePlaybackSetting('auto_delete_watched', false, setAutoDelete) : setConfirmAsk({
              title: '开启看完自动删除',
              message: '看完一集后，将永久删除该集已下载的视频、在线播放缓存和转码缓存。需要时可重新下载。',
              okText: '开启自动删除', danger: true,
              onOk: () => savePlaybackSetting('auto_delete_watched', true, setAutoDelete),
            })}>
            <Trash2 size={15} />看完自动删 {autoDelete ? '开' : '关'}
          </button>
        <div className="player-series-actions">
        <button
          aria-expanded={pickerOpen}
          className={`btn btn-outline series-picker-btn ${pickerOpen ? 'open' : ''}`}
          onClick={() => setPickerOpen((v) => !v)}
        >
          切换剧集
          <span className="series-count">{seriesList.length}</span>
          <ChevronDown size={15} />
        </button>
          <button className="btn btn-outline player-download-jump" aria-controls="player-management"
            onClick={() => {
              if (portrait) setEpisodesOpen(true);
              requestAnimationFrame(() => downloadToolsRef.current?.scrollIntoView({
                behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'instant' : 'smooth', block: 'center',
              }));
            }}><Download size={15} />下载管理</button>
        </div>
        </div>
      </div>

      {pickerOpen && !actionsHidden && (
        <div className="series-picker">
          <div className="series-picker-head">
            <input
              type="text"
              className="input-field"
              aria-label="在我的剧库搜索"
              placeholder="搜索剧名…"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
            />
            <button className="icon-btn" title="关闭" onClick={() => setPickerOpen(false)}>
              <X size={16} />
            </button>
          </div>

          <div className="series-picker-list">
            {seriesList.length === 0 && <div className="series-picker-empty">还没有剧集</div>}
            {seriesList
              .filter((s) => !pickerQuery.trim() || (s.series_title || '').includes(pickerQuery.trim()))
              .map((s) => {
                const isActive = String(s.series_id) === String(activeSeriesId);
                const dl = downloadedMap[String(s.series_id)];
                return (
                  <div
                    key={s.series_id}
                    role="button"
                    tabIndex={0}
                    aria-label={`选择剧集 ${s.series_title}`}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || !['Enter', ' '].includes(e.key)) return;
                      e.preventDefault();
                      if (!isActive) switchSeries(s.series_id);
                      setPickerOpen(false);
                    }}
                    className={`series-row ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      if (!isActive) switchSeries(s.series_id);
                      setPickerOpen(false);
                    }}
                  >
                    <div className="series-row-cover">
                      {s.cover ? <img src={s.cover} alt="" loading="lazy" /> : <Film size={14} />}
                    </div>
                    <div className="series-row-body">
                      <div className="series-row-title">{s.series_title}</div>
                      <div className="series-row-sub">
                        {dl && dl.completed > 0 ? `已下载 ${dl.completed}/${dl.total} 集` : `共 ${(s.episodes || []).length} 集 · 未下载`}
                      </div>
                    </div>
                    {isActive && <span className="series-row-cur">当前</span>}
                    {(() => {
                      const st = storageMap[String(s.series_id)];
                      const hasFiles = st && st.files > 0;
                      return (
                        <>
                          {hasFiles && (
                            <button
                              className="icon-btn icon-btn-danger series-row-del"
                              title={`删除本地文件（${st.files} 个 · ${fmtSize(st.bytes)}）`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmAsk({
                                  title: '删除本地文件',
                                  message: `将删除《${s.series_title}》已下载的 ${st.files} 个文件，释放 ${fmtSize(st.bytes)}。\n剧集仍保留在列表中，之后可以随时在线播放或重新下载。`,
                                  okText: '删除文件',
                                  danger: true,
                                  onOk: async () => {
                                    if (String(s.series_id) === selectedSeriesRef.current && !onlineUrl && !compatMap[currentIndex]) stopPlayback('本地播放已停止，可重新连接片源观看');
                                    await deleteDownloadedFiles(() => window.electronAPI.deleteSeriesFiles(s.series_id));
                                  },
                                });
                              }}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                          <button
                            className="icon-btn series-row-del"
                            title="永久移除剧库记录（不删除本地文件）"
                            aria-label={`永久移除 ${s.series_title} 的剧库记录`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmAsk({ title: '永久移除剧库记录', message: `将永久移除《${s.series_title}》的剧库记录，不能通过恢复列表找回。本地视频文件不会删除；以后可重新搜索添加。`, okText: '永久移除', danger: true, onOk: () => removeSeries(s.series_id, s.series_title) });
                            }}
                          >
                            <X size={15} />
                          </button>
                        </>
                      );
                    })()}
                  </div>
                );
              })}
          </div>

          <div className="series-picker-foot">
            {storageTotal.files > 0 && (
              <span className="series-picker-usage">
                本地已占用 <b>{fmtSize(storageTotal.bytes)}</b> / {storageTotal.files} 个文件
              </span>
            )}
            {storageTotal.files > 0 && (
              <button
                className="btn btn-outline btn-sm btn-danger-text"
                title="删除所有已下载的本地文件"
                onClick={() => {
                  setConfirmAsk({
                    title: '删除全部本地文件',
                    message: `将删除所有已下载的剧集文件（包括已从剧库移除但保留的视频），共 ${storageTotal.files} 个文件、${fmtSize(storageTotal.bytes)}。\n剧集列表与分集信息会保留，之后仍可在线播放或重新下载。`,
                    okText: '全部删除',
                    danger: true,
                    onOk: async () => {
                      if (current?.fileUrl && !onlineUrl && !compatMap[currentIndex]) stopPlayback('本地播放已停止，可重新连接片源观看');
                      await deleteDownloadedFiles(() => window.electronAPI.deleteAllDownloaded());
                    },
                  });
                }}
              >
                删除全部已下载
              </button>
            )}
            <button className="btn btn-outline btn-sm" onClick={clearCache} title="释放在线播放占用的内存">
              <Zap size={14} />
              清空播放缓存{cacheInfo.count > 0 ? ` (${cacheInfo.count})` : ''}
            </button>
            {compatCache.files > 0 && (
              <button className="btn btn-outline btn-sm" onClick={clearCompatCache} title="删除转码产生的兼容格式文件">
                <Trash2 size={14} />
                清空转码缓存 ({fmtSize(compatCache.bytes)})
              </button>
            )}
          </div>
        </div>
      )}

      <div className="player-viewing-layout">
      {/* 播放区 */}
      <div className="player-floating-slot" ref={floatingPlayer.attachSlot}>
        {floatingPlayer.floating && <div className="player-floating-placeholder" role="status">
          <p>正在悬浮窗播放《{detail?.series_title}》</p>
          <button className="btn btn-outline" onClick={floatingPlayer.toggle}>返回主窗口</button>
        </div>}
      </div>
      {createPortal(
      <div className={`player-stage ${windowFill ? 'player-window-fill' : ''}`} data-picture-mode={pictureMode} ref={stageRef}>
          {rateNotice !== null && <div className="player-rate-notice" role="status" aria-live="polite">{rateNotice}×</div>}
          <video
            ref={videoRef}
            crossOrigin="anonymous"
            src={videoSrc || undefined}
            className="player-video"
            aria-busy={!canPlay || mediaBuffering}
            tabIndex={0}
            aria-label={`视频画面，${formatShortcut(shortcuts.play)}播放或暂停`}
            onClick={() => {
              const video = videoRef.current;
              if (!canPlay || !video) return;
              video.focus({ preventScroll: true });
              if (video.paused) video.play().catch(() => showToast('暂时无法播放，请重试本集'));
              else video.pause();
            }}
            onLoadedMetadata={handleMetadata}
            onTimeUpdate={prepareNextEpisode}
            onPlay={(event) => {
              const media = loadedMediaRef.current;
              if (!activeRef.current || !canPlay || playbackVersion !== mediaVersion.current || !media || media.version !== mediaVersion.current || media.element !== event.currentTarget) {
                event.currentTarget.pause();
                return;
              }
            }}
            onRateChange={(event) => {
              const v = event.currentTarget;
              if (!canPlay || v !== videoRef.current || v.readyState === 0 || loadedMediaRef.current?.version !== mediaVersion.current) return;
              if (v.currentSrc && v.currentSrc !== videoSrc) return;
              if (v.playbackRate !== playbackRateRef.current) changePlaybackRate(v.playbackRate);
            }}
            onEnded={() => { if (activeRef.current && canPlay && playbackVersion === mediaVersion.current && (!videoRef.current || loadedMediaRef.current?.version === mediaVersion.current)) handleEnded(); }}
            onPause={() => persistPosition(true)}
            onPlaying={(event) => { handlePlaying(event); prepareNextEpisode(event); }}
            onWaiting={() => { if (canPlay && playbackVersion === mediaVersion.current) setMediaBuffering(true); }}
            onCanPlay={() => { if (canPlay && playbackVersion === mediaVersion.current) setMediaBuffering(false); }}
            onError={(event) => {
              if (!canPlay || compatRequestRef.current || playbackVersion !== mediaVersion.current) return;
              if (videoRef.current && event.currentTarget !== videoRef.current) return;
              if (event.currentTarget.currentSrc && event.currentTarget.currentSrc !== videoSrc) return;
              const errorCode = event.currentTarget.error?.code;
              // Chromium also reports an unavailable HTTP stream as unsupported source (4).
              const unavailableOnline = errorCode === 4 && videoSrc === onlineUrl;
              if (unavailableOnline && reconnectOnce()) return;
              const failedDecode = [3, 4].includes(errorCode);
              if (isOnlinePlaying && failedDecode && onlineQuality === 'auto' && !autoCompat && reconnectOnce()) return;
              if (!failedDecode && errorCode === 2 && reconnectOnce()) return;
              if (isOnlinePlaying && (errorCode === 2 || unavailableOnline)) {
                recoverOnlineFailure(current, '在线播放失败，正在尝试本地文件或下载');
                return;
              }
              if (!failedDecode) {
                const seekTo = currentPosition(); resetPlayback(); pendingSeekRef.current = seekTo;
                setPlaybackError('视频加载失败，请重试本集或检查网络');
              }
              setMediaBuffering(false);
              setDecodeFailed(failedDecode);
              showToast(failedDecode ? '片源暂时无法播放，请先重新连接片源' : '视频加载失败，请重试本集或检查网络');
              if (failedDecode && !unavailableOnline) tryAutoCompat(currentIndex);
            }}
          />
        <VideoEnhancement videoRef={videoRef} source={videoSrc} available={visualActive} enhancement={enhancement} />
        {danmakuSource === 'official'
          ? <OfficialDanmaku videoRef={videoRef} source={videoSrc} available={visualActive} danmaku={danmaku} />
          : <CommentDanmaku videoRef={videoRef} source={videoSrc} available={visualActive} danmaku={danmaku} />}
      <PlayerControls floating={floatingPlayer.floating || nativePictureInPicture} onToggleFloating={async () => {
          if (document.querySelector('.stealth-mode')) throw new Error('请先退出小窗模式');
          const video = videoRef.current;
          if (floatingPlayer.floating) { floatingPlayer.toggle(); return; }
          if (document.pictureInPictureElement === video) { await document.exitPictureInPicture(); return; }
          const settings = await window.electronAPI.getSettings();
          if (settings?.picture_in_picture_mode === 'native') {
            if (!document.pictureInPictureEnabled || !video?.requestPictureInPicture) throw new Error('当前系统不支持原生画中画');
            await video.requestPictureInPicture();
            return;
          }
          const owner = stageRef.current?.ownerDocument || document;
          if (owner.fullscreenElement) await owner.exitFullscreen();
          floatingPlayer.toggle();
        }} onOpenSettings={onNavigate ? () => onNavigate('settings') : undefined} danmaku={showDanmakuControls ? danmaku : null} enhancement={enhancement} continuing={autoAdvancing && !playbackError && !decodeFailed} autoContinue={autoNext && !!findNext(currentIndex)} shortcuts={shortcuts} onToggleFullscreen={toggleFullscreen} portrait={portrait} windowFill={windowFill} onWindowFill={setWindowFill} videoRef={videoRef} stageRef={stageRef} source={videoSrc} available={canPlay}
          seriesTitle={detail?.series_title} episodes={episodes} currentIndex={currentIndex} onEpisodeChange={goToEpisode}
          onlineQuality={onlineQuality} supportsOnlineQuality={supportsOnlineQuality} onQualityChange={changeOnlineQuality}
          pictureMode={pictureMode} onPictureModeChange={changePictureMode} rate={playbackRate} onRateChange={changePlaybackRate} onError={showToast} />
        {!canPlay && (
          <div className="player-placeholder" style={{ position: 'absolute', inset: 0 }}>
            {playbackError ? (
              <><Film size={34} /><p role="alert">{playbackError}</p><div className="player-placeholder-actions">
                <button className="btn btn-primary" onClick={retryPlayback}>{current?.status === 'completed' ? '重试本集' : '重试本集（在线播放）'}</button>
                {current?.vid && <button className="btn btn-outline" onClick={() => startOnlinePlay(currentIndex, undefined, true)}>重新连接片源</button>}
                {current?.vid && !current.locked && !fallbackRef.current?.submitting && <button className="btn btn-outline" onClick={() => startCompatPlay(currentIndex, true)}>转码后播放</button>}
              </div></>
            ) : onlineProgress && onlineProgress.vid && (!current || current.vid === onlineProgress.vid) ? (
              <>
                <RefreshCw size={30} className="spin" />
                <p>{onlineProgress.phase === 'preparing' ? '正在连接片源…' : onlineProgress.phase === 'decrypting' ? '正在准备播放…' : '正在缓冲在线播放…'}</p>
                {onlineProgress.phase !== 'preparing' && <div className="player-wait-bar">
                  <div className="player-wait-fill" style={{ width: `${onlineProgress.percent || 0}%` }} />
                </div>}
                <span className="player-placeholder-sub">
                  {onlineProgress.phase === 'preparing' ? '获取可播放地址' : `${onlineProgress.percent || 0}%`}
                  {onlineProgress.total ? ` · ${(onlineProgress.received / 1048576).toFixed(1)} / ${(onlineProgress.total / 1048576).toFixed(1)} MB` : ''}
                  {' · 不写入下载目录'}
                </span>
                <button className="btn btn-outline" onClick={() => stopPlayback()}>取消播放</button>
              </>
            ) : waitingFor != null ? (
              <>
                <RefreshCw size={30} className="spin" />
                <p>第 {waitingFor} 集正在下载，完成后自动播放…</p>
                {(() => {
                  const ep = episodes.find((e) => e.vid_index === waitingFor);
                  return ep && ep.status === 'downloading' ? (
                    <div className="player-wait-bar">
                      <div className="player-wait-fill" style={{ width: `${ep.progress || 0}%` }} />
                    </div>
                  ) : null;
                })()}
                <span className="player-placeholder-sub">下载完成后继续本集；取消等待不会停止下载</span>
                <button className="btn btn-outline" onClick={() => stopPlayback('已取消等待，下载会继续；可在下载管理查看')}>取消等待</button>
              </>
            ) : current?.locked || (episodes.length > 0 && episodes.every((ep) => ep.locked)) ? (
              <><Film size={34} /><p>需在来源平台解锁后观看</p><span className="player-placeholder-sub">本应用不提供解锁</span></>
            ) : !playbackRequested && current ? (
              <><Film size={34} /><p>第 {current.vid_index} 集 · 等待播放</p>
                <button className="btn btn-primary" onClick={() => goToEpisode(current.vid_index, pendingSeekRef.current)}>
                  <Play size={15} />播放本集
                </button>
                <span className="player-placeholder-sub">点击后继续观看，也可选择其他集数</span>
              </>
            ) : current ? (
              <>
                <Film size={34} />
                <p>
                  第 {current.vid_index} 集
                  {current.status === 'downloading' ? '正在下载' : current.status === 'pending' ? '排队中' : '尚未下载'}
                </p>
                {current.status === 'downloading' && (
                  <div className="player-wait-bar">
                    <div className="player-wait-fill" style={{ width: `${current.progress || 0}%` }} />
                  </div>
                )}
                <div className="player-placeholder-actions">
                  <button className="btn btn-primary" onClick={() => startOnlinePlay(current.vid_index)}>
                    <Play size={15} />
                    在线播放（不下载）
                  </button>
                  <button className="btn btn-outline" disabled={qualityLoading} onClick={() => downloadEpisode(current.vid_index)}>
                    <Download size={15} />
                    下载本集
                  </button>
                </div>
                <span className="player-placeholder-sub">在线播放不保存到下载目录，准备产生的临时文件会自动清理</span>
              </>
            ) : (
              <>
                <Film size={34} />
                <p>请选择一集开始播放</p>
              </>
            )}
          </div>
        )}

        {canPlay && mediaBuffering && !compatProgress && (
          <div className="compat-overlay" role="status">
            <RefreshCw size={26} className="spin" /><p>正在加载视频…</p>
            <button className="btn btn-outline" onClick={() => stopPlayback()}>取消播放</button>
          </div>
        )}

        {/* 兼容模式浮层：解码失败提示 / 转码进度 */}
        {compatProgress && compatProgress.vidIndex === currentIndex && (
          <div className="compat-overlay">
            <RefreshCw size={26} className="spin" />
            <p>正在转码为兼容格式（H.264）…</p>
            <div className="player-wait-bar">
              <div className="player-wait-fill" style={{ width: `${compatProgress.percent || 0}%` }} />
            </div>
            <span className="compat-overlay-sub">
              {compatProgress.percent || 0}% · 正在处理当前视频，完成后切换到兼容片源
            </span>
            <button className="btn btn-outline" onClick={() => stopPlayback('转码已取消，可重试本集继续观看')}>取消转码</button>
          </div>
        )}

        {!compatProgress && decodeFailed && canPlay && (
          <div className="compat-overlay">
            <Film size={30} />
            <p>当前片源暂时无法播放</p>
            <span className="compat-overlay-sub" role={compatError ? 'alert' : undefined}>
              {compatError || '请先重新连接片源；若仍有画面或格式问题，可尝试转码为 H.264 兼容格式。'}
            </span>
            <div className="player-placeholder-actions">
              <button className="btn btn-primary" onClick={retryPlayback}>重试本集</button>
              <button className="btn btn-outline" onClick={() => startOnlinePlay(currentIndex, undefined, true)}>重新连接片源</button>
              <button className="btn btn-outline" onClick={() => startCompatPlay(currentIndex, true)}>
                <Zap size={15} />
                重新转码后播放
              </button>
              <button className="btn btn-outline" onClick={() => onNavigate?.('settings')}>
                播放设置
              </button>
            </div>
          </div>
        )}
      </div>, floatingPlayer.host)}

      <section className="player-episode-panel" id="player-episode-panel" aria-label="选集">
      <h3 className="portrait-episode-heading">选集</h3>
      {/* 播放中的集信息 */}
      {current && (
        <div className="player-now">
          <span className="player-now-title">
            《{detail ? detail.series_title : ''}》第 {current.vid_index} 集
          </span>
          {current.title && <span className="player-now-sub">{current.title}</span>}
          <span className={`player-now-status status-${current.status}`}>
            {current.locked ? '锁定' : current.status === 'completed' ? '可播放' : current.status === 'downloading' ? `下载中 ${current.progress || 0}%` : current.status === 'pending' ? '排队中' : '未下载'}
          </span>
        </div>
      )}

      {detail?.web_accessible_episodes != null && detail.web_accessible_episodes < detail.total && (
        <p className="player-tips">网页标记前 {detail.web_accessible_episodes} 集可访问；仅有预览或无完整片源时，自动尝试 App 片源。</p>
      )}

      {episodes.some((ep) => ep.locked) && <p className="player-tips">锁定集需在来源平台解锁，本应用不提供解锁；连播会跳过锁定集。</p>}

      {/* 分集列表 */}
      <div className="player-episodes">
        {episodes.map((ep) => {
          const isCurrent = ep.vid_index === currentIndex;
          return (
            <button
              key={ep.vid_index}
              disabled={ep.locked === true}
              aria-label={`第 ${ep.vid_index} 集`}
              aria-pressed={isCurrent}
              className={`ep-chip ep-${ep.status} ${isCurrent ? 'ep-current' : ''}`}
              onClick={() => goToEpisode(ep.vid_index)}
              title={
                ep.locked ? '需在来源平台解锁' : ep.status === 'completed'
                  ? '点击播放（本地）'
                  : ep.status === 'downloading' || ep.status === 'pending'
                  ? '下载继续，点击在线播放'
                  : '点击在线播放（不下载）· 双击加入下载'
              }
              onDoubleClick={() => ep.status !== 'completed' && downloadEpisode(ep.vid_index)}
            >
              <span className="ep-num">{ep.vid_index}</span>{ep.locked && <span className="ep-lock-label">锁定</span>}
              {ep.status === 'completed' && <Check size={11} className="ep-badge" />}
              {ep.status === 'downloading' && (
                <span className="ep-progress" style={{ width: `${ep.progress || 0}%` }} />
              )}
              {onlineVid === ep.vid && <span className="ep-online-dot" />}
            </button>
          );
        })}
      </div>

      <div className="player-tips">
        快捷键：{SHORTCUT_ACTIONS.map(action => `${formatShortcut(shortcuts[action.id])} ${action.label}`).join(' · ')}。可在设置中更改。
        <br />
        <b>未锁定的灰色分集点一下即可在线播放</b>（不保存到下载目录）；双击才加入下载队列。
        连播时遇到未下载的集会自动转在线播放。
      </div>

      <div className="player-management" id="player-management" ref={downloadToolsRef} hidden={actionsHidden}>
        <h3 id="player-download-heading">下载清晰度</h3>
        <div className="player-management-actions">
            <select className="input-field" aria-labelledby="player-download-heading" value={downloadQuality} disabled={qualityLoading}
              title="手动下载及自动画质的下载回退使用此项。红果片源所选清晰度不可用或下载失败时，自动尝试更低清晰度，并在下载管理中提示；已有文件保留。"
              onChange={(event) => setDownloadQuality(event.target.value)}>
              <option value="auto">自动（兼容优先）</option>
              <option value="1080p">1080P</option>
              <option value="720p">720P</option>
            </select>
          <button className="btn btn-outline" onClick={() => downloadMissing()} disabled={qualityLoading}>
            <Download size={15} />
            下载未完成集
          </button>
          <button
            className="btn btn-primary"
            onClick={openMergeDialog}
            disabled={merging || playableCount === 0}
            title="把已下载的分集合并成单个 mp4，方便一次性看完"
          >
            <Layers size={15} />
            {merging ? '提交中...' : '合并导出全集'}
          </button>
          <button className="btn btn-outline" onClick={() => downloadEpisode(current.vid_index)}
            disabled={qualityLoading || !current || current.locked || current.status === 'completed'}>
            <Download size={15} />下载本集
          </button>
          {[5, 10].map(count => (
            <button key={count} className="btn btn-outline" onClick={() => downloadMissing(count)}
              disabled={qualityLoading || !current || !episodes.some(ep => ep.vid_index > current.vid_index)}
              title={`从当前集的下一集开始，最多下载 ${count} 集；跳过已完成和锁定集数`}>
              <Download size={15} />下载后{count}集
            </button>
          ))}
        </div>
      </div>

      </section>
      </div>

      <div className="player-footer" hidden={actionsHidden}>
        {/^[0-9]{6,30}$/.test(String(activeSeriesId)) ? (
          <CommunityPanel seriesId={activeSeriesId} episodeId={current?.vid} title={detail?.series_title || ''} cover={detail?.cover || ''}>
            <SequelFinder seriesId={activeSeriesId} active={active && !actionsHidden} />
          </CommunityPanel>
        ) : <SequelFinder seriesId={activeSeriesId} active={active && !actionsHidden} />}
      </div>
      {toast && <div className="dm-toast dm-toast-success" onClick={() => setToast(null)}>{toast}</div>}

      {/* 合并格式选择 */}
      {mergeAsk && (
        <div className="player-confirm-mask" onClick={closeMergeDialog}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={confirmAsk ? confirmAsk.title : '合并导出'} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title" style={{ color: 'var(--accent)' }}>
              <Layers size={17} />
              合并导出全集
            </div>
            <div className="player-confirm-msg">
              <p>把《{detail ? detail.series_title : ''}》已下载的 {playableCount} 集合并为一个 mp4。未下载的分集不会自动补齐。</p>
              <p><b>高质量分辨率合并</b>：逐集检查实际文件，全部达到1080P才能开始；有低清分集请选快速或兼容合并。</p>
              <p><b>快速合并</b>：优先无损拼接，保留每段原分辨率，部分设备可能不兼容。</p>
              <p><b>兼容合并</b>：必要时转为H.264/AAC，仍保留每段原分辨率，处理较慢。</p>
              <p>三种方式都保留原文件，只合并已下载分集，不自动补齐，也不会把低清变成真高清。</p>
              {mergeError && <p className="alert-error" role="alert">{mergeError}</p>}
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => mergeThisSeries(false, true)} disabled={merging}>
                高质量分辨率合并
              </button>
              <button className="btn btn-outline" onClick={closeMergeDialog}>取消</button>
              <button className="btn btn-outline" onClick={() => mergeThisSeries(true)} disabled={merging}>
                兼容合并（H.264）
              </button>
              <button className="btn btn-primary" onClick={() => mergeThisSeries(false)} disabled={merging}>
                快速合并
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {confirmAsk && (        <div className="player-confirm-mask" onClick={() => setConfirmAsk(null)}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={confirmAsk ? confirmAsk.title : '合并导出'} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title">
              <Trash2 size={17} />
              {confirmAsk.title}
            </div>
            <div className="player-confirm-msg">
              {String(confirmAsk.message).split('\n').map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => setConfirmAsk(null)}>取消</button>
              <button
                className={`btn ${confirmAsk.danger ? 'btn-danger-solid' : 'btn-primary'}`}
                onClick={async () => {
                  const fn = confirmAsk.onOk;
                  setConfirmAsk(null);
                  await fn();
                }}
              >
                {confirmAsk.okText || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Player;
