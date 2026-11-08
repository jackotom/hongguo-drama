import { t, useLanguage } from '../i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Film, Play, RefreshCw } from './icons';
import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { loadRandomPool, pickRandomDrama, playRecommendedDrama } from './randomDramaModel.mjs';
import './RandomDrama.css';

export function DramaPoster({ item, className = '' }) {
  useLanguage();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item?.cover]);
  return <div className={`drama-poster ${className}`}>
    {item?.cover && !failed ? <img key={`${item.series_id}:${item.cover}`} src={item.cover} alt={t(`${item.series_title}海报`)} onError={() => setFailed(true)} />
      : <div className="drama-poster-fallback"><Film size={36} /><span>{t("暂无海报")}</span></div>}
  </div>;
}

function StoryTickets({ shaking }) {
  useLanguage();
  return <svg className={`story-tickets ${shaking ? 'is-shaking' : ''}`} viewBox="0 0 240 270" aria-hidden="true">
    <g className="story-tickets-sticks" fill="var(--bg-elevated)" stroke="var(--accent)" strokeWidth="2.5">
      <rect x="67" y="42" width="25" height="155" rx="5" transform="rotate(-15 80 180)" />
      <rect x="105" y="28" width="25" height="169" rx="5" transform="rotate(-3 117 180)" />
      <rect x="139" y="45" width="25" height="152" rx="5" transform="rotate(14 151 180)" />
      <path d="m73 67 11-3m28-14 11-1m37 23 10 3" strokeLinecap="round" />
    </g>
    <path d="M52 116h136l-13 121c-1 10-109 10-110 0Z" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2.5" />
    <path d="M53 116q67 17 134 0M72 222q48 12 96 0" fill="none" stroke="var(--accent)" strokeWidth="2" />
    <rect x="98" y="151" width="44" height="52" rx="8" fill="var(--primary)" />
    <path d="m115 164 15 12-15 12Z" fill="white" />
    <path className="story-ticket-motion" d="m24 127-7 9 7 9m192-18 7 9-7 9" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export default function RandomDrama({ active, refreshKey = 0, onNavigate }) {
  useLanguage();
  const [source, setSource] = useState('all');
  const { sources: mediaSources, revision: sourceRevision, loading: sourcesLoading, error: sourcesError } = useMediaSources();
  const [pool, setPool] = useState([]);
  const [unavailable, setUnavailable] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const [playError, setPlayError] = useState('');
  const listController = useRef(null);
  const playController = useRef(null);
  const drawTimer = useRef(null);
  const previous = useRef(null);

  const load = useCallback(async (forceRefresh = false) => {
    listController.current?.abort();
    playController.current?.abort();
    clearTimeout(drawTimer.current);
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true); setShaking(false); setResolving(false); setSelected(null);
    setError(''); setPlayError(''); setPool([]); setUnavailable([]);
    try {
      const result = await loadRandomPool(options => window.electronAPI.browseList(options), { source, forceRefresh, signal: controller.signal, sources: mediaSources });
      if (controller.signal.aborted) return;
      setPool(result.items); setUnavailable(result.unavailable);
      if (!result.items.length) setError('这个来源暂时没有可抽的短剧。重新加载，或换个来源试试。');
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message || '片单加载失败，请重试');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [source, mediaSources]);

  useEffect(() => {
    if (sourcesLoading) { setPool([]); setSelected(null); setResolving(false); setShaking(false); }
    if (source !== 'all' && !mediaSources.some(item => item.id === source)) { setSource('all'); return; }
    if (active && !sourcesLoading) load(refreshKey > 0);
    return () => {
      listController.current?.abort(); playController.current?.abort(); clearTimeout(drawTimer.current);
    };
  }, [active, load, refreshKey, sourceRevision, sourcesLoading]);

  const draw = () => {
    if (!active || loading || sourcesLoading || shaking || resolving) return;
    const next = pickRandomDrama(pool, previous.current);
    if (!next) { setError('这份片单里暂时没有另一部。刷新片单，或换个来源再抽。'); return; }
    setError(''); setPlayError(''); setShaking(true);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    drawTimer.current = setTimeout(() => {
      previous.current = next; setSelected(next); setShaking(false);
    }, reduced ? 0 : 620);
  };

  const play = async () => {
    if (!active || !selected || resolving || sourcesLoading) return;
    playController.current?.abort();
    const controller = new AbortController();
    playController.current = controller;
    setResolving(true); setPlayError('');
    try { await playRecommendedDrama(window.electronAPI, selected, { signal: controller.signal }); }
    catch (cause) { if (!controller.signal.aborted) setPlayError(cause.message || '打开失败，请重试'); }
    finally { if (!controller.signal.aborted) setResolving(false); }
  };

  const sourceLabel = id => mediaSourceLabel(id, mediaSources);
  return <div className="random-drama">
    <div className="random-drama-toolbar">
      <p>{t("不想挑？把下一部交给短剧签筒。")}</p>
      <label>{t("抽取范围")}<select value={source} onChange={event => setSource(event.target.value)}>
        <option value="all">{t("全部来源")}</option>{mediaSources.map(({ id, label }) => <option key={id} value={id}>{id.startsWith('custom:') ? label : t(label)}</option>)}
      </select></label>
    </div>
    <div className={`random-drama-stage ${selected ? 'has-result' : ''}`}>
      <div className="random-drama-ritual">
        <button className="story-ticket-button" onClick={draw} disabled={loading || sourcesLoading || shaking || resolving || !pool.length}
          aria-label={t(selected ? '摇动短剧签筒，再抽一部' : '摇动短剧签筒，抽一部短剧')}>
          <StoryTickets shaking={shaking} />
          <span>{t(shaking ? '好故事，马上揭晓' : selected ? '点击签筒，再遇见一部' : '点一下，摇出下一部')}</span>
        </button>
        {!selected && <div className="random-drama-opening"><h3>{t("今晚，看点意料之外的")}</h3><p>{t("一签一部真实短剧，喜欢就开看。")}</p></div>}
      </div>
      {selected && <div className="random-drama-result" aria-live="polite">
        <DramaPoster item={selected} />
        <div className="random-drama-result-copy"><p className="drama-source-label">{sourceLabel(selected.source)}{t(" · 随机抽取")}</p>
          <h3>{selected.series_title}</h3>
          {selected.episode_count > 0 && <p>{t("共 ")}{t(selected.episode_count)}{t(" 集")}</p>}
          {selected.tags?.length > 0 && <p className="random-drama-tags">{selected.tags.join(' · ')}</p>}
          <div className="random-drama-actions">
            <button className="btn btn-primary" disabled={resolving || shaking} onClick={play}><Play size={16} />{t(resolving ? '正在打开…' : '在剧库播放')}</button>
            <button className="btn btn-outline" disabled={resolving || shaking} onClick={draw}><RefreshCw size={15} />{t("再抽一次")}</button>
          </div>
          {resolving && <button className="drama-text-button" onClick={() => { playController.current?.abort(); setResolving(false); setPlayError('已取消加载，可以重试或再抽一部。'); }}>{t("取消加载")}</button>}
          {playError && <p className="drama-inline-error" role="alert">{t(playError)}</p>}
        </div>
      </div>}
    </div>
    <div className="random-drama-status" aria-live="polite">
      {loading || sourcesLoading ? <><p><RefreshCw size={14} className="spin" />{t("正在把真实短剧装进签筒…")}</p><button className="drama-text-button" onClick={() => {
        listController.current?.abort(); setLoading(false); setError('已取消加载。可以重新加载，或换个来源。');
      }}>{t("取消加载")}</button></> : <>
        {error ? <p role="alert">{t(error)}</p> : <p>{t("签筒已装好 ")}{t(pool.length)}{t(" 部 · 不会连续抽到同一部")}</p>}
        {unavailable.length > 0 && pool.length > 0 && <p>{unavailable.map(sourceLabel).join('、')}{t("暂未取到片单，本次从其余来源抽取。")}</p>}
        {(error || unavailable.length > 0) && <button className="drama-text-button" onClick={() => load(true)}>{t("重新加载片单")}</button>}
        {!pool.length && onNavigate && <button className="drama-text-button" onClick={() => onNavigate('download')}>{t("按剧名搜索")}</button>}
      </>}
    </div>
    {sourcesError && <p className="random-drama-note" role="status">{t("来源列表更新失败，暂用上次列表；可在设置重新保存来源后重试。")}</p>}
    <p className="random-drama-note">{t("从所选来源当前目录随机抽取，不代表热播排名。播放以来源实际可用的免费分集为准。")}</p>
  </div>;
}
