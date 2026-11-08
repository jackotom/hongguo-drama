import { t, useLanguage, getLanguage } from '../i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Film, Play, RefreshCw } from './icons';
import RandomDrama, { DramaPoster } from './RandomDrama';
import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { feedCacheKey, readFeedCache, writeFeedCache } from './feedCache.mjs';
import { loadRandomPool, playRecommendedDrama, waitForRequest } from './randomDramaModel.mjs';
import './DramaFeed.css';

const CATALOG_CHANNEL_KEY = 'hongguo.feed.catalog.channel.v1';
const RANKINGS = [
  ['hot-drama', '热播总榜'], ['hot-real-drama', '真人短剧'],
  ['hot-comic-drama', '漫剧'], ['hot-ai-drama', 'AI 短剧'],
];

function clockOf(timestamp) {
  if (!timestamp) return '';
  const time = new Date(timestamp);
  return Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit', hour12: false });
}

// 先显示会话内上次片单，再后台更新；更新失败保留旧内容。只有“刷新片单”强制取最新。
function DramaFeed({ active = true, onNavigate }) {
  useLanguage();
  const [source, setSource] = useState('hongguo');
  const [catalogChannel, setCatalogChannel] = useState(() => {
    try { return localStorage.getItem(CATALOG_CHANNEL_KEY) === 'web' ? 'web' : 'app'; }
    catch (_) { return 'app'; }
  });
  const { sources: mediaSources, revision, loading: sourcesLoading, error: sourcesError } = useMediaSources();
  const [category, setCategory] = useState('hot-drama');
  const [items, setItems] = useState(() => readFeedCache(feedCacheKey(revision, source, category, catalogChannel))?.items || []);
  const [updatedAt, setUpdatedAt] = useState(() => readFeedCache(feedCacheKey(revision, source, category, catalogChannel))?.savedAt || 0);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [playError, setPlayError] = useState('');
  const [randomRefresh, setRandomRefresh] = useState(0);
  const listController = useRef(null);
  const playController = useRef(null);
  const selectedIdRef = useRef('');
  const itemsRef = useRef([]);
  const revisionRef = useRef(revision);
  const selected = items[index];
  const random = category === 'random';
  const ranking = source === 'hongguo';
  const sourceLabel = mediaSourceLabel(source, mediaSources);
  itemsRef.current = items;
  selectedIdRef.current = selected ? String(selected.series_id) : '';

  const seedFeed = useCallback((nextSource, nextCategory, nextChannel = catalogChannel) => {
    const cached = nextCategory === 'random' ? null : readFeedCache(feedCacheKey(revision, nextSource, nextCategory, nextChannel));
    setItems(cached?.items || []);
    setUpdatedAt(cached?.savedAt || 0);
    setIndex(0);
  }, [revision, catalogChannel]);

  const stopRequests = useCallback(() => {
    listController.current?.abort();
    playController.current?.abort();
    setResolving(false);
    setPlayError('');
  }, []);

  const switchFeed = (nextSource, nextCategory) => {
    if (source === nextSource && category === nextCategory) return;
    stopRequests();
    setError(''); setNotice('');
    setLoading(nextCategory !== 'random');
    seedFeed(nextSource, nextCategory);
    setSource(nextSource); setCategory(nextCategory);
  };

  const switchCatalogChannel = next => {
    if (!['app', 'web'].includes(next) || next === catalogChannel) return;
    stopRequests();
    setError(''); setNotice(''); setLoading(true);
    seedFeed(source, category, next);
    setCatalogChannel(next);
    try { localStorage.setItem(CATALOG_CHANNEL_KEY, next); } catch (_) { /* selection still works for this launch */ }
  };

  const cancelLoad = () => {
    listController.current?.abort();
    setLoading(false);
    if (itemsRef.current.length) setNotice('已取消更新，仍显示上次片单。');
    else setError('已取消加载，可以重试或切换来源。');
  };

  const loadList = useCallback(async (forceRefresh = false) => {
    if (!active || random || sourcesLoading || !source) return;
    if (!mediaSources.some(item => item.id === source)) return;
    const key = feedCacheKey(revision, source, category, catalogChannel);
    const cached = readFeedCache(key);
    if (!itemsRef.current.length && cached?.items?.length) {
      setItems(cached.items); setUpdatedAt(cached.savedAt); setIndex(0);
    }
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true); setError(''); setNotice('');
    try {
      let nextItems;
      if (ranking) {
        const result = await waitForRequest(window.electronAPI.browseList({
          source, category, page: 1, forceRefresh, catalogChannel,
        }), { signal: controller.signal, message: '热播榜加载超时，请重试' });
        if (controller.signal.aborted) return;
        if (!result?.success) throw new Error(result?.error || '热播榜暂时不可用');
        const seen = new Set();
        nextItems = (Array.isArray(result.results) ? result.results : []).filter(item => {
          const id = String(item?.series_id || '');
          if (!/^\d{6,30}$/.test(id) || typeof item.series_title !== 'string' || !item.series_title.trim() || seen.has(id)) return false;
          seen.add(id); return true;
        });
      } else {
        const result = await loadRandomPool(options => window.electronAPI.browseList(options), {
          source, sources: mediaSources, forceRefresh, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        nextItems = result.items;
      }
      if (!nextItems.length) {
        setError(itemsRef.current.length ? '来源这次没有返回片单，请稍后重试。' : '这个来源暂未返回可用片单，可重试或切换来源。');
        return;
      }
      const savedAt = Date.now();
      writeFeedCache(key, nextItems, savedAt);
      const keepId = selectedIdRef.current;
      setItems(nextItems);
      setUpdatedAt(savedAt);
      setIndex(() => {
        const found = keepId ? nextItems.findIndex(item => String(item.series_id) === keepId) : -1;
        return found >= 0 ? found : 0;
      });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message || '片单加载失败，请重试或切换来源');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [active, random, sourcesLoading, source, category, catalogChannel, revision, ranking, mediaSources]);

  // 来源配置被编辑后（revision 变化）旧片单不再可信，清空后按新 revision 重新取。
  useEffect(() => {
    if (revisionRef.current === revision) return;
    revisionRef.current = revision;
    stopRequests();
    setItems([]); setUpdatedAt(0); setIndex(0);
    setError(''); setNotice(''); setLoading(false);
  }, [revision, stopRequests]);

  useEffect(() => {
    if (sourcesLoading) return;
    if (!mediaSources.some(item => item.id === source)) {
      const next = mediaSources[0]?.id || '';
      if (next) {
        seedFeed(next, 'hot-drama');
        setLoading(true);
        setSource(next); setCategory('hot-drama');
      } else {
        setItems([]); setUpdatedAt(0); setIndex(0); setLoading(false); setError(''); setNotice('');
      }
      return;
    }
    if (active && !random) loadList();
  }, [active, random, loadList, seedFeed, sourcesLoading, mediaSources, source]);

  useEffect(() => () => { listController.current?.abort(); playController.current?.abort(); }, []);

  const startItem = async () => {
    if (!active || !selected || resolving || sourcesLoading) return;
    playController.current?.abort();
    const controller = new AbortController();
    playController.current = controller;
    setPlayError(''); setResolving(true);
    try { await playRecommendedDrama(window.electronAPI, selected, { signal: controller.signal }); }
    catch (cause) { if (!controller.signal.aborted) setPlayError(cause.message || '加载失败，请重试本剧'); }
    finally { if (!controller.signal.aborted) setResolving(false); }
  };

  const selectItem = next => {
    if (resolving || next < 0 || next >= items.length) return;
    setPlayError(''); setIndex(next);
  };

  const introduction = selected?.intro || selected?.series_intro || selected?.description;
  const upcoming = items.slice(index + 1, index + 5);
  return <section className="drama-feed" aria-label={t("热播推荐")}>
    <header className="drama-feed-header">
      <div><h2>{t("热播推荐")}</h2><p className="page-description">{t("从热播榜和来源片单，遇见下一部故事。")}</p></div>
      <div className="drama-feed-actions">
        {!random && <label className="source-control">{t("来源")}<select className="input-field" aria-label={t("推荐来源")} value={source} onChange={event => switchFeed(event.target.value, 'hot-drama')}>
          {mediaSources.map(({ id, label }) => <option key={id} value={id}>{id.startsWith('custom:') ? label : t(label)}</option>)}
        </select></label>}
        {ranking && !random && <label className="source-control">{t("目录线路")}<select className="input-field" aria-label={t("推荐目录线路")} value={catalogChannel} onChange={event => switchCatalogChannel(event.target.value)}><option value="app">{t("App（快速 · 部分片单）")}</option><option value="web">{t("官网（完整目录）")}</option></select></label>}
        <button className="btn btn-outline" disabled={!random && (sourcesLoading || !source || (loading && !items.length))} onClick={() => random ? setRandomRefresh(value => value + 1) : loadList(true)}><RefreshCw size={15} />{t("刷新片单")}</button>
      </div>
    </header>
    <div className="drama-feed-categories" role="group" aria-label={t("选择推荐方式")}>
      {ranking ? RANKINGS.map(([value, label]) => <button key={value} className={`browse-cat ${category === value ? 'active' : ''}`}
        aria-pressed={category === value} onClick={() => switchFeed(source, value)}>{t(label)}</button>)
        : <button className={`browse-cat ${!random ? 'active' : ''}`} aria-pressed={!random} onClick={() => switchFeed(source, 'hot-drama')}>{t("来源片单")}</button>}
      <button className={`browse-cat drama-random-tab ${random ? 'active' : ''}`} aria-pressed={random} onClick={() => switchFeed(source, 'random')}>{t("摇一摇")}</button>
    </div>
    {random ? <RandomDrama active={active} refreshKey={randomRefresh} onNavigate={onNavigate} /> : <>
      {sourcesError && <p className="drama-feed-hint" role="status">{t("来源列表更新失败，暂用上次列表；可在设置重新保存来源后重试。")}</p>}
      <div className="drama-feed-list-meta"><p>{t(ranking ? catalogChannel === 'app' ? '红果 App 热播榜' : '红果官网热播榜' : `${sourceLabel} · 来源片单`)}{t(items.length > 0 ? ` · 本次 ${items.length} 部` : '')}</p><span>{t(ranking ? '按来源榜单顺序' : '按来源目录顺序，不代表热播排名')}</span></div>
      {ranking && catalogChannel === 'app' && <p className="drama-feed-hint" role="status">{t("快速线路只显示部分片单；需要更完整的榜单时，可在“目录线路”切换到官网。")}</p>}
      {(loading || sourcesLoading) && items.length === 0 && <div className="drama-feed-state" role="status"><RefreshCw size={24} className="spin" /><p>{t(sourcesLoading ? '正在加载来源列表…' : '正在加载真实片单…')}</p>
        {loading && !sourcesLoading && <button className="btn btn-outline" onClick={cancelLoad}>{t("取消加载")}</button>}
      </div>}
      {loading && items.length > 0 && <div className="drama-feed-updating" role="status"><RefreshCw size={16} className="spin" /><span>{t("正在更新片单，仍可浏览上次结果…")}</span>
        <button className="btn btn-outline btn-sm" onClick={cancelLoad}>{t("取消加载")}</button>
      </div>}
      {notice && items.length > 0 && <p className="drama-feed-notice" role="status">{t(notice)}</p>}
      {error && items.length > 0 && <div className="drama-feed-update-error" role="alert">
        <span>{t("片单未更新：")}{t(error)}{t(updatedAt ? `（仍显示 ${clockOf(updatedAt)} 的片单）` : '')}</span>
        <button className="btn btn-outline btn-sm" disabled={loading} onClick={() => loadList(true)}>{t("重试")}</button>
      </div>}
      {!loading && !sourcesLoading && !selected && <div className="drama-feed-state" role={error ? 'alert' : 'status'}>
        <Film size={32} /><h3>{t(error ? '暂时没能加载片单' : !source ? '暂无启用的来源，请在设置中添加' : '这个来源暂未返回剧集')}</h3>
        {error && <p>{t(error)}</p>}
        <p>{t(ranking ? '可在上方切换目录线路或来源，继续发现短剧。' : '可在上方切换来源，继续发现短剧。')}</p>
        <div className="drama-feed-actions"><button className="btn btn-primary" disabled={!source} onClick={() => loadList(true)}>{t("重新加载")}</button>
          {onNavigate && <button className="btn btn-outline" onClick={() => onNavigate('download')}>{t("按剧名搜索")}</button>}</div>
      </div>}
      {selected && <>
        <div className="drama-feed-feature">
          <DramaPoster item={selected} />
          <div className="drama-feed-copy">
            <p className="drama-feed-rank">{t(ranking && selected.rank > 0 ? `榜单第 ${selected.rank} 名` : `本次片单第 ${index + 1} 部`)}{t(ranking && selected.heat ? ` · ${selected.heat}` : '')}</p>
            <h3>{selected.series_title}</h3>
            <p className="drama-feed-tags">{[selected.episode_count > 0 && t('{0} 集', [selected.episode_count]), ...(selected.tags || [])].filter(Boolean).join(' · ') || t('来自{0}片单', [sourceLabel])}</p>
            {typeof introduction === 'string' && introduction.trim() && <p className="drama-feed-intro">{introduction}</p>}
            <p className="drama-feed-play-note">{t("在「我的剧库」选集、播放，接着上次继续看。")}</p>
            <div className="drama-feed-actions"><button className="btn btn-primary" disabled={resolving} onClick={startItem}><Play size={16} />{t(resolving ? '正在打开剧库…' : '在剧库播放')}</button>
              {resolving && <button className="btn btn-outline" onClick={() => { playController.current?.abort(); setResolving(false); setPlayError('已取消加载，可重试本剧。'); }}>{t("取消加载")}</button>}</div>
            {playError && <p className="drama-inline-error" role="alert">{t(playError)}</p>}
          </div>
        </div>
        <div className="drama-feed-navigation">
          <span aria-live="polite">{t("第 {0} / {1} 部", [index + 1, items.length])}</span>
          <div className="drama-feed-actions" role="group" aria-label={t("切换推荐短剧")}>
            <button className="btn btn-outline" disabled={index === 0 || resolving} onClick={() => selectItem(index - 1)}>{t("上一部")}</button>
            <button className="btn btn-outline" disabled={index === items.length - 1 || resolving} onClick={() => selectItem(index + 1)}>{t("下一部")}</button>
          </div>
        </div>
        {upcoming.length > 0 ? <div className="drama-feed-upcoming"><h4>{t("接下来看看")}</h4><div className="drama-feed-upcoming-list">
          {upcoming.map((item, offset) => <button key={item.series_id} className="drama-feed-next" disabled={resolving} onClick={() => selectItem(index + offset + 1)}>
            <DramaPoster item={item} /><span><strong>{item.series_title}</strong><small>{t(ranking && item.rank > 0 ? `榜单第 ${item.rank} 名` : `片单第 ${index + offset + 2} 部`)}</small></span>
          </button>)}
        </div></div> : <p className="drama-feed-hint">{t("已到本次片单末尾，换个来源，或摇一摇发现新故事。")}</p>}
        <p className="drama-feed-source">{t(ranking ? `榜单来自${catalogChannel === 'app' ? '红果 App 目录' : '红果官网公开页面'}，不是账号个性化推荐。` : `片单来自${sourceLabel}当前目录，不代表热播排名；播放以来源实际可用分集为准。`)}</p>
      </>}
    </>}
  </section>;
}

export default DramaFeed;
