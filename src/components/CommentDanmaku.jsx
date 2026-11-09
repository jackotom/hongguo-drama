import { t, useLanguage } from '../i18n';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_DANMAKU_SETTINGS, normalizeDanmakuSettings, createCommentFeed, appendCommentPage, commentIsBlocked, advanceDanmaku, resizeDanmaku } from './danmakuModel.mjs';
import './CommentDanmaku.css';

const STORAGE_KEY = 'hongguo:comment-danmaku:v1';
const EMPTY = [];
const readPreferences = () => {
  try { const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY)); return { enabled: value?.enabled === true, ...normalizeDanmakuSettings(value) }; }
  catch { return { enabled: false, ...DEFAULT_DANMAKU_SETTINGS }; }
};

export function useCommentDanmaku({ seriesId, episodeId, active }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [saveError, setSaveError] = useState('');
  const [visible, setVisible] = useState(() => !document.hidden);
  const [, refresh] = useState(0);
  const feed = useMemo(() => createCommentFeed(seriesId, episodeId), [seriesId, episodeId]);
  const currentFeed = useRef(feed);
  currentFeed.current = feed;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const supported = /^\d{6,30}$/.test(String(seriesId || '')) && /^\d{6,30}$/.test(String(episodeId || ''));
  const enabled = preferences.enabled && supported;
  const running = enabled && active && visible;

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (!running) return;
    const fetchNext = async () => {
      if (document.hidden || feed.loading || !feed.hasMore || feed.error || (feed.groupedComments || feed.comments).length - feed.animation.cursor >= 10 || Date.now() - feed.lastRequest < 1500) return;
      feed.loading = true;
      feed.lastRequest = Date.now();
      refresh(value => value + 1);
      try {
        const data = await window.electronAPI?.getEpisodeComments?.({ seriesId: feed.seriesId, episodeId: feed.episodeId, cursor: feed.cursor, limit: 30 });
        if (currentFeed.current !== feed) return;
        appendCommentPage(feed, data, preferencesRef.current);
      } catch {
        if (currentFeed.current === feed) feed.error = '本集评论加载失败，可重试继续加载';
      } finally {
        feed.loading = false;
        if (currentFeed.current === feed) refresh(value => value + 1);
      }
    };
    fetchNext();
    const timer = window.setInterval(fetchNext, 1500);
    return () => window.clearInterval(timer);
  }, [running, feed]);

  const update = patch => {
    const next = { enabled: preferences.enabled, ...preferences, ...patch };
    const validated = { enabled: next.enabled === true, ...normalizeDanmakuSettings(next) };
    setPreferences(validated);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(validated)); setSaveError(''); }
    catch { setSaveError('设置已生效，但本机保存失败'); }
  };
  const settings = useMemo(() => normalizeDanmakuSettings(preferences), [preferences]);
  const status = !supported ? '仅红果来源的当前集支持评论弹幕' : !enabled ? '开启后展示本集公开评论' : !active ? '播放本集后显示评论弹幕'
    : !visible ? '' : feed.error || (feed.loading ? '正在加载本集后续评论…' : feed.notice) || (!feed.loaded ? '正在加载本集评论…'
      : feed.comments.length ? `已读取本集 ${feed.comments.length} 条评论${feed.hasMore ? '，播放时继续加载' : '，当前可用评论已读取'}` : '本集暂无可显示的公开评论');
  return { enabled, supported, running, settings, feed, comments: feed.groupedComments || feed.comments, status, saveError, error: feed.error,
    loading: running && feed.loading, toggle: () => update({ enabled: !preferences.enabled }), update,
    reset: () => update(DEFAULT_DANMAKU_SETTINGS), retry: () => { feed.error = ''; feed.emptyPages = 0; refresh(value => value + 1); } };
}

export default function CommentDanmaku({ videoRef, source, available, danmaku }) {
  useLanguage();
  const layerRef = useRef(null);
  const nodes = useRef(new Map());
  const [items, setItems] = useState([]);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const { running, settings, comments, feed } = danmaku;

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const state = feed.animation;
    state.items = state.items.filter(item => !commentIsBlocked(item.content, settings));
    let nextY = 12;
    for (const item of [...state.items].sort((a, b) => a.y - b.y)) {
      item.width = (Array.from(item.text).length + 1) * settings.fontSize;
      item.y = Math.max(item.y, nextY);
      nextY = item.y + settings.fontSize + 12;
    }
    setItems([...state.items]);
    const layer = layerRef.current;
    const video = videoRef.current;
    if (!running || !available || !layer || !video) return;
    let frame = 0;
    let previous = 0;
    let width = layer.clientWidth;
    let height = layer.clientHeight;
    const controls = layer.parentElement?.querySelector('.player-controls-bar');
    const options = () => ({ width, height, settings, reducedMotion, bottomInset: Math.max(76, (controls?.clientHeight || 0) + 8) });
    const reset = () => {
      state.items = [];
      state.replayQueue = [];
      state.cooldown = 0;
      previous = 0;
      setItems([...state.items]);
    };
    const paint = () => state.items.forEach(item => {
      const node = nodes.current.get(item.id);
      if (node) node.style.transform = `translate(${item.x}px, ${item.y}px)`;
    });
    const canAdvance = () => !video.paused && !video.ended && !document.hidden;
    const tick = now => {
      frame = 0;
      if (!canAdvance()) { previous = 0; return; }
      const delta = previous ? Math.min((now - previous) / 1000, 0.1) * video.playbackRate : 0.001;
      previous = now;
      if (advanceDanmaku(state, comments, delta, options())) setItems([...state.items]);
      paint();
      frame = requestAnimationFrame(tick);
    };
    const start = () => { if (!frame && canAdvance()) { previous = 0; frame = requestAnimationFrame(tick); } };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
    const emptied = () => { stop(); reset(); };
    const resize = () => {
      const nextWidth = layer.clientWidth;
      const nextHeight = layer.clientHeight;
      if (nextWidth === width && nextHeight === height) return;
      if (!resizeDanmaku(state, options(), { ...options(), width: nextWidth, height: nextHeight })) return;
      width = nextWidth; height = nextHeight;
      setItems([...state.items]); paint(); start();
    };
    // Settings keep current trajectories and consumption; only new arrivals use the new lanes.
    start();
    const observer = new ResizeObserver(resize);
    observer.observe(layer);
    const events = { playing: start, play: start, seeked: start, canplay: start, pause: stop, ended: stop, waiting: start, seeking: start, emptied };
    Object.entries(events).forEach(([name, handler]) => video.addEventListener(name, handler));
    return () => { stop(); observer.disconnect(); Object.entries(events).forEach(([name, handler]) => video.removeEventListener(name, handler)); };
  }, [running, available, comments, settings, reducedMotion, source, videoRef, feed]);

  if (!running || !available) return null;
  return <div ref={layerRef} className={`comment-danmaku ${reducedMotion ? 'comment-danmaku-static' : ''}`}>
    <div aria-hidden="true" style={{ opacity: settings.opacity / 100, fontSize: settings.fontSize }}>
      {(comments.length ? items : EMPTY).map(item => <span className="comment-danmaku-item" key={item.id} ref={node => { if (node) nodes.current.set(item.id, node); else nodes.current.delete(item.id); }}
        style={{ transform: `translate(${item.x}px, ${item.y}px)` }}>{item.text}</span>)}
    </div>
  </div>;
}

export function DanmakuSettings({ danmaku, onClose, panelRef, maxHeight }) {
  useLanguage();
  const { settings, update } = danmaku;
  return <div className="danmaku-settings" ref={panelRef} role="dialog" aria-label={t("弹幕设置")} data-player-menu style={{ maxHeight }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="danmaku-settings-heading"><strong>{t(danmaku.sourceKind === 'official' ? '时间轴弹幕' : '本集评论')}</strong><button type="button" aria-label={t("关闭弹幕设置")} onClick={onClose}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button></div>
    <label>{t("弹幕来源")}<select aria-label={t("弹幕来源")} value={danmaku.sourceKind || 'comments'} onChange={event => danmaku.setSource?.(event.target.value)}><option value="official">{t("时间轴弹幕")}</option><option value="comments">{t("本集评论（备用）")}</option></select></label>
    <p>{t(danmaku.sourceKind === 'official' ? '按视频时间展示红果剧集弹幕，快进、回退和切集时重新对齐。接口异常时可手动切换本集评论。' : '本集公开评论依次展示，与视频时间无对应。全文可在「剧评与收藏」查看。')}</p>
    <label>{t("不透明度 ")}<output>{t(settings.opacity)}%</output><input autoFocus aria-label={t("弹幕不透明度")} type="range" min="20" max="100" step="5" value={settings.opacity} onChange={event => update({ opacity: Number(event.target.value) })} /></label>
    <label>{t("字号 ")}<output>{t(settings.fontSize)}px</output><input aria-label={t("弹幕字号")} type="range" min="16" max="32" step="2" value={settings.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })} /></label>
    <label>{t("滚动速度 ")}<output>{t(settings.speed)}×</output><input aria-label={t("弹幕滚动速度")} type="range" min="0.5" max="2" step="0.25" value={settings.speed} onChange={event => update({ speed: Number(event.target.value) })} /></label>
    <label>{t("显示区域")}<select aria-label={t("弹幕显示区域")} value={settings.area} onChange={event => update({ area: event.target.value })}><option value="quarter">{t("四分之一屏")}</option><option value="half">{t("半屏")}</option><option value="full">{t("全屏")}</option></select></label>
    <label>{t("弹幕密度")}<select aria-label={t("弹幕密度")} value={settings.density} onChange={event => update({ density: event.target.value })}><option value="sparse">{t("稀疏")}</option><option value="normal">{t("适中")}</option><option value="dense">{t("密集")}</option></select></label>
    <label className="danmaku-filter-toggle">{t("内置敏感词过滤")}<input aria-label={t("内置敏感词过滤")} type="checkbox" checked={settings.sensitiveFilter} onChange={event => update({ sensitiveFilter: event.target.checked })} /></label>
    <label>{t("自定义屏蔽词")}<textarea aria-label={t("自定义屏蔽词")} rows="3" maxLength="10000" value={settings.blockedWords} placeholder={t("每行一个词，也可用逗号分隔")} onChange={event => update({ blockedWords: event.target.value })} /></label>
    <p>{t("内置词含常见涉政及辱骂词；自定义词始终生效。命中后整条隐藏，仅保存在本机。词库无法覆盖所有表达或变体。")}</p>
    <p>{t("默认在上半屏显示。跟随播放暂停与倍速；系统开启减少动态效果时，改为静态轮换。")}</p>
    <p role="status">{t(danmaku.saveError || danmaku.status)}</p>
    <div className="danmaku-settings-actions">{danmaku.error && <button type="button" onClick={danmaku.retry}>{t("重试加载")}</button>}<button type="button" onClick={danmaku.reset}>{t("恢复默认")}</button></div>
  </div>;
}
