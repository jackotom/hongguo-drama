import { t, useLanguage } from '../i18n';
// Adapted from dawei233/hongguo-drama, commit c884fab6c6e36ad38173e251738b9b35f958383f (GPL-3.0).
// https://github.com/dawei233/hongguo-drama
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { commentIsBlocked, resizeDanmaku } from './danmakuModel.mjs';
import { createOfficialFeed, appendOfficialPage, advanceTimedDanmaku, resolveDanmakuStatus } from './danmakuOfficial.mjs';
import './CommentDanmaku.css';

/**
 * 官方弹幕叠层：按视频时间投放。
 *
 * 与 `CommentDanmaku.jsx`（本集评论滚动条）是两个独立组件，不是同一个组件的
 * 分支。这样上游那套评论逻辑与其夹具测试完全不受影响，将来合并上游也不用解冲突。
 *
 * 视觉设置沿用同一个存储键，换源不会清掉用户调好的字号与屏蔽词。
 */

export function useOfficialDanmaku({ seriesId, vid, active, preferences }) {
  const { enabled, settings, saveError, toggle, update, reset } = preferences;
  const [visible, setVisible] = useState(() => !document.hidden);
  const [, refresh] = useState(0);
  const [requestVersion, retryRequest] = useState(0);
  const feed = useMemo(() => createOfficialFeed(seriesId, vid), [seriesId, vid]);
  const currentFeed = useRef(feed);
  currentFeed.current = feed;

  const supported = /^\d{6,30}$/.test(String(seriesId || '')) && /^\d{6,30}$/.test(String(vid || ''));
  const running = enabled && supported && active && visible;

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  // 正常只读取一次；失败或部分结果由用户手动重试，主进程复用短期缓存。
  useEffect(() => {
    if (!running || feed.loaded || feed.loading) return undefined;
    let cancelled = false;
    feed.loading = true;
    refresh(value => value + 1);
    const finish = () => {
      feed.loading = false;
      feed.fresh = false;
      if (currentFeed.current === feed) refresh(value => value + 1);
    };
    (async () => {
      try {
        const data = await window.electronAPI?.getEpisodeDanmaku?.({
          seriesId: feed.seriesId,
          vid: feed.vid,
          fresh: feed.fresh === true,
        });
        if (cancelled || currentFeed.current !== feed) return;
        if (!data || typeof data !== 'object') {
          feed.loaded = true;
          feed.error = '弹幕接口不可用，可稍后重试';
          return;
        }
        appendOfficialPage(feed, data);
      } catch {
        if (!cancelled && currentFeed.current === feed) {
          feed.loaded = true;
          feed.error = '弹幕加载失败，可稍后重试';
        }
      } finally {
        if (!cancelled && currentFeed.current === feed) finish();
      }
    })();
    return () => { cancelled = true; feed.loading = false; };
  }, [running, feed, requestVersion]);

  // 状态文案只有这一个出口：失败、部分成功、加载中、空集都必须经由它，
  // 否则某条路径会把"源坏了"显示成"本集没有弹幕"。
  const status = resolveDanmakuStatus({
    source: 'official',
    supported,
    enabled,
    active,
    visible,
    error: feed.error,
    loading: running && feed.loading,
    notice: feed.notice,
    loaded: feed.loaded,
    count: feed.danmaku.length,
  });

  return {
    sourceKind: 'official',
    active,
    enabled,
    supported,
    running,
    settings,
    feed,
    comments: feed.danmaku,
    status,
    saveError,
    error: feed.error || (feed.partial ? feed.notice : ''),
    loading: running && feed.loading,
    toggle,
    update,
    reset,
    retry: () => {
      feed.error = '';
      feed.notice = '';
      feed.loaded = false;
      feed.fresh = true; // 绕过主进程的失败缓存，否则重试只会拿到同一条失败
      retryRequest(value => value + 1);
    },
  };
}

export default function OfficialDanmaku({ videoRef, source, available, danmaku }) {
  useLanguage();
  const layerRef = useRef(null);
  const layoutRef = useRef(null);
  const nodes = useRef(new Map());
  const [items, setItems] = useState([]);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const { running, enabled, active, supported, settings, feed, status, error, loading } = danmaku;
  const list = feed.danmaku;

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    feed.animation.lastTime = undefined;
    feed.animation.items = [];
    feed.animation.replayQueue = [];
    setItems([]);
  }, [source, feed, enabled, active, supported, available, settings.fontSize, settings.area, settings.density, reducedMotion]);

  // 布局改变时重对齐；透明度、速度与屏蔽词调整保留当前轨迹。
  useEffect(() => {
    const state = feed.animation;
    state.items = state.items.filter(item => !commentIsBlocked(item.content, settings));
    setItems([...state.items]);
    const layer = layerRef.current;
    const video = videoRef.current;
    if (!running || !available || !layer || !video) return undefined;
    let frame = 0;
    // Retain geometry across suspended animation effects and layer remounts.
    let { width, height } = layoutRef.current || { width: layer.clientWidth, height: layer.clientHeight };
    layoutRef.current = { width, height };
    const controls = layer.parentElement?.querySelector('.player-controls-bar');
    const options = () => ({ width, height, settings, reducedMotion, bottomInset: Math.max(76, (controls?.clientHeight || 0) + 8) });
    const paint = () => state.items.forEach(item => {
      const node = nodes.current.get(item.id);
      if (node) node.style.transform = `translate(${item.x}px, ${item.y}px)`;
    });
    const canAnimate = () => !video.paused && !video.ended && !document.hidden;
    let lastFrame;
    const tick = now => {
      frame = 0;
      if (!canAnimate()) return;
      // Wall time keeps existing comments smooth while a seek or buffer stalls the media clock.
      const delta = lastFrame === undefined ? 0 : Math.max(0, (now - lastFrame) / 1000) * video.playbackRate;
      lastFrame = now;
      const emitting = !video.seeking && video.readyState >= 2;
      if (advanceTimedDanmaku(state, list, video.currentTime, delta, { ...options(), emitting })) setItems([...state.items]);
      paint();
      if (emitting || state.items.length) frame = requestAnimationFrame(tick);
    };
    const start = () => { if (!frame && canAnimate()) frame = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; lastFrame = undefined; };
    const seek = () => { state.lastTime = undefined; start(); };
    const emptied = () => { stop(); state.lastTime = undefined; state.items = []; state.replayQueue = []; setItems([]); };
    const resize = () => {
      const nextWidth = layer.clientWidth;
      const nextHeight = layer.clientHeight;
      if (nextWidth === width && nextHeight === height) return;
      if (!resizeDanmaku(state, options(), { ...options(), width: nextWidth, height: nextHeight })) return;
      width = nextWidth; height = nextHeight;
      layoutRef.current = { width, height };
      setItems([...state.items]); paint(); start();
    };
    resize();
    start();
    const observer = new ResizeObserver(resize);
    observer.observe(layer);
    const events = { playing: start, play: start, seeked: seek, canplay: start, pause: stop, ended: stop, waiting: start, seeking: seek, emptied };
    Object.entries(events).forEach(([name, handler]) => video.addEventListener(name, handler));
    return () => { stop(); observer.disconnect(); Object.entries(events).forEach(([name, handler]) => video.removeEventListener(name, handler)); };
  }, [running, available, list, settings, reducedMotion, source, videoRef, feed]);

  if (!enabled || !active || !supported || !available) return null;
  return <div ref={layerRef} className={`comment-danmaku ${reducedMotion ? 'comment-danmaku-static' : ''}`}>
    <div aria-hidden="true" style={{ opacity: settings.opacity / 100, fontSize: settings.fontSize }}>
      {((list.length ? items : [])).map(item => <span className="comment-danmaku-item" key={item.id} ref={node => { if (node) nodes.current.set(item.id, node); else nodes.current.delete(item.id); }}
        style={{ transform: `translate(${item.x}px, ${item.y}px)`, color: item.color || '#FFFFFF' }}>{item.text}</span>)}
    </div>
    {((loading && !items.length) || error || !list.length) && <span className="comment-danmaku-status" role="status">{t(status)}</span>}
  </div>;
}
