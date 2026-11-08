import { t, useLanguage } from '../i18n';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import './Browse.css';
import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { Film, RefreshCw, ExternalLink, Download, Play, Check, X, Search } from './icons';
import { isSubmitKey, parseEpisodeRange } from './episodeRange';
import { rememberCatalogTitles } from '../searchHistory';

const PAGE_CACHE_TTL_MS = 60_000;
const LIST_TIMEOUT_MS = 25_000;
const PAGE_CACHE_KEY = 'hongguo.catalog.page.v1';
const CATALOG_CHANNEL_KEY = 'hongguo.catalog.channel.v1';
const PAGE_CACHE_MAX = 8;
const PAGE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readPageCacheFile() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const parsed = JSON.parse(localStorage.getItem(PAGE_CACHE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - PAGE_CACHE_MAX_AGE_MS;
    return parsed.filter(entry => entry && typeof entry.key === 'string' && Array.isArray(entry.results)
      && Number(entry.savedAt) >= cutoff).slice(0, PAGE_CACHE_MAX);
  } catch (_) { return []; }
}

function readPersistedPage(key) {
  return readPageCacheFile().find(entry => entry.key === key) || null;
}

function writePersistedPage(key, page) {
  try {
    if (typeof localStorage === 'undefined') return;
    const entries = readPageCacheFile().filter(entry => entry.key !== key);
    entries.unshift({ key, ...page });
    localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(entries.slice(0, PAGE_CACHE_MAX)));
  } catch (_) { /* quota or disabled storage: memory cache still works */ }
}

/**
 * Browse —— 分类淘剧
 *
 * 数据链路：
 *   独立来源目录 -> 卡片(series_id/剧名/封面/集数/标签)
 *   点卡片 -> 复用 search-resolve 拉全集并写入短剧档案
 *         -> 复用 get-series-episodes 拿到每集「已下载/下载中/未下载」状态
 *         -> 跳播放器 或 走既有批量下载
 */
function Browse({ onNavigate, active = true }) {
  useLanguage();
  const mobile = window.electronAPI.platform === 'android';
  const FilterContainer = mobile ? 'details' : 'div';
  const [selectingDownloads, setSelectingDownloads] = useState(false);
  const [source, setSource] = useState('hongguo');
  const [catalogChannel, setCatalogChannel] = useState(() => {
    try { return localStorage.getItem(CATALOG_CHANNEL_KEY) === 'web' ? 'web' : 'app'; }
    catch (_) { return 'app'; }
  });
  const appCatalog = source === 'hongguo' && catalogChannel === 'app';
  const { sources: mediaSources, revision: sourceRevision, loading: sourcesLoading, error: sourcesError } = useMediaSources();
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState('real-drama');
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);
  const [completion, setCompletion] = useState('all');

  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 0, genres: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshNotice, setRefreshNotice] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');

  // 详情抽屉
  const [detail, setDetail] = useState(null); // { series_id, series_title, cover, episodes: [...] }
  const [detailLoading, setDetailLoading] = useState(false);
  const [openingId, setOpeningId] = useState('');
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const loadingRequest = useRef(0);
  const pageCache = useRef(new Map()).current;
  const discoveryPages = useRef(new Map()).current;
  const refreshFirstPage = useRef(false);
  const refreshToFirstPage = useRef(false);
  const viewRef = useRef({ source: '', category: '', channel: '', genre: '', page: 0 });
  const resultsRef = useRef(results);
  const listTimer = useRef(null);
  const toastTimer = useRef(null);
  resultsRef.current = results;

  const invalidateList = useCallback(() => {
    if (mobile) { detailRequest.current++; setOpeningId(''); }
    listRequest.current++;
    loadingRequest.current = 0;
    clearTimeout(listTimer.current);
    // A cleanup can invalidate a request without starting a replacement. Clear the
    // skeleton here; a subsequent loadList immediately claims the token and shows it again.
    setLoading(false);
  }, []);

  const cancelList = () => {
    invalidateList();
    loadingRequest.current = 0;
    setLoading(false);
    setError('已取消加载，可重新加载或切换分类。');
  };

  const closeDetail = useCallback(() => {
    detailRequest.current++;
    setDetail(null);
    setDetailLoading(false);
    setOpeningId('');
  }, []);

  useEffect(() => { if (!active) closeDetail(); }, [active, closeDetail]);

  useEffect(() => () => {
    detailRequest.current++;
    invalidateList();
    clearTimeout(toastTimer.current);
  }, [invalidateList]);

  // 已下载统计（按 series_id -> 已下载集数）
  const [downloadedMap, setDownloadedMap] = useState({});
  const [toast, setToast] = useState(null);

  const showToast = useCallback((text, type = 'success') => {
    setToast({ text, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const loadDownloadedMap = useCallback(async () => {
    try {
      const list = (await window.electronAPI.getSeriesList()) || [];
      const map = {};
      for (const s of list) {
        const res = await window.electronAPI.getSeriesEpisodes(s.series_id);
        if (res && res.success) {
          map[String(s.series_id)] = {
            completed: res.data.completedCount,
            total: res.data.total,
          };
        }
      }
      setDownloadedMap(map);
    } catch (_) {}
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const list = await window.electronAPI.browseCategories();
      if (Array.isArray(list) && list.length) {
        setCategories(list);
      }
    } catch (_) {}
  }, []);

  const loadList = useCallback(
    async (cat, gen, pg, forceRefresh = false) => {
      invalidateList();
      const request = listRequest.current;
      const channel = source === 'hongguo' ? catalogChannel : '';
      const key = JSON.stringify([sourceRevision, source, channel, cat, gen, pg]);
      const persistedKey = JSON.stringify([source, channel, cat, gen, pg]);
      const queryKey = JSON.stringify([source, channel, cat, gen]);
      const previousBatch = discoveryPages.get(queryKey);
      // First-page App cards are safe to show as a stale preview; page 2+ depends on a live cursor.
      const canPersist = !source.startsWith('custom:') && (!appCatalog || pg === 1);
      let cached = pageCache.get(key);
      if (!cached && canPersist) {
        cached = readPersistedPage(persistedKey);
        if (cached) pageCache.set(key, cached);
      }
      const sameView = viewRef.current.source === source && viewRef.current.category === cat && viewRef.current.channel === channel;
      const sameQuery = sameView && viewRef.current.genre === gen;
      const samePage = viewRef.current.page === pg;
      const resettingToFirstPage = forceRefresh && refreshToFirstPage.current;
      viewRef.current = { source, category: cat, channel, genre: gen, page: pg };
      // A stale App first page is a useful cold-start preview, but must not replace the
      // page the user is already on when refreshing another page or after an expired back.
      const useCached = cached && (!appCatalog || !sameView || samePage);
      const fallbackUrl = source === 'hongguo' && catalogChannel === 'web'
        ? `https://hongguoduanju.com/${cat.startsWith('hot-') ? 'rank' : 'category'}/${encodeURIComponent(cat)}${gen ? `/${encodeURIComponent(gen)}` : ''}${pg > 1 ? `?page=${pg}` : ''}` : '';
      setUnsupported(false);
      setError('');
      setRefreshNotice('');
      const previousResults = forceRefresh && !resettingToFirstPage && sameQuery && samePage && resultsRef.current.length
        ? resultsRef.current : null;
      // Keep the current grid during a genre/page refresh instead of replacing it with skeletons.
      if (useCached) {
        setResults(cached.results);
        setMeta({ ...cached.meta, page: pg });
        setSourceUrl(cached.sourceUrl || fallbackUrl);
      } else {
        setResults(prev => previousBatch?.results || (sameView ? prev : []));
        setMeta(prev => previousBatch?.meta || (sameView ? prev : { total: 0, totalPages: 0, genres: [] }));
        setSourceUrl(prev => sameView ? prev : fallbackUrl);
      }
      if (!forceRefresh && cached && !appCatalog && Date.now() - cached.savedAt < PAGE_CACHE_TTL_MS) {
        setLoading(false);
        return;
      }
      setLoading(true);
      // A new query or App first-page request may replace the old cursor chain even without forceRefresh.
      if ((!sameQuery && !previousBatch) || (appCatalog && (forceRefresh || pg === 1))) setMeta(prev => ({ ...prev, cursorExpired: true }));
      loadingRequest.current = request;
      listTimer.current = setTimeout(() => {
        // A cleanup can invalidate the request without starting another load (e.g. while
        // source metadata is still loading). Never leave the skeleton spinning forever.
        if (loadingRequest.current !== request) return;
        loadingRequest.current = 0;
        invalidateList();
        setLoading(false);
        setError(cached ? '刷新超时，仍显示上次片单；可重试或切换分类。' : '加载超时，请重试或切换分类。');
      }, LIST_TIMEOUT_MS);
      try {
        const res = await window.electronAPI.browseList({ source, category: cat, genre: gen, page: pg, forceRefresh,
          ...(source === 'hongguo' ? { catalogChannel } : {}), ...(appCatalog ? { catalogScope: 'browse' } : {}) });
        if (request !== listRequest.current) return;
        setSourceUrl(res?.sourceUrl || fallbackUrl);
        if (appCatalog && res?.code === 'APP_CURSOR') {
          setMeta(prev => ({ ...prev, cursorExpired: true }));
          throw new Error('分页记录已失效，请点击“刷新片单”返回第一页。');
        }
        if (!res?.success) throw new Error(res?.error || '来源暂时不可用');
        const next = {
          results: Array.isArray(res.results) ? res.results : [],
          meta: { page: pg, total: res.total || 0, totalPages: res.totalPages || 0, genres: res.genres || [], hasMore: res.hasMore === true },
          sourceUrl: res.sourceUrl || fallbackUrl,
          savedAt: Date.now(),
        };
        if (!next.results.length && (cached || previousBatch) && res.unsupported !== true) {
          throw new Error(res.emptyMessage || '来源这次没有返回片单，请稍后重试。');
        }
        rememberCatalogTitles(next.results);
        setResults(next.results);
        setMeta(next.meta);
        setSourceUrl(next.sourceUrl);
        if (next.results.length) {
          if (!cat.startsWith('hot-')) {
            discoveryPages.delete(queryKey);
            discoveryPages.set(queryKey, next);
            if (discoveryPages.size > 24) discoveryPages.delete(discoveryPages.keys().next().value);
          }
          refreshToFirstPage.current = false;
          if (resettingToFirstPage) {
            setRefreshNotice(`已重新获取 ${next.results.length} 部短剧，已返回第一页。`);
          } else if (forceRefresh && previousResults) {
            const sameOrder = previousResults.length === next.results.length
              && previousResults.every((item, index) => String(item.series_id) === String(next.results[index]?.series_id));
            setRefreshNotice(sameOrder
              ? cat.startsWith('hot-')
                ? `刷新完成：来源榜单顺序未变化（${next.results.length} 部）。`
                : `刷新完成：来源返回的短剧及顺序未变化（${next.results.length} 部）。`
              : `刷新完成：片单已更新（${next.results.length} 部）。`);
          }
          if (!appCatalog || pg === 1) {
            pageCache.delete(key);
            pageCache.set(key, next);
            if (canPersist) writePersistedPage(persistedKey, next);
            if (pageCache.size > 24) pageCache.delete(pageCache.keys().next().value);
          }
        } else {
          if (!appCatalog) pageCache.delete(key);
          setUnsupported(res.unsupported === true);
          setError(res.emptyMessage || '这一页没有取到内容，可重新加载或换分类。');
        }
      } catch (e) {
        if (request !== listRequest.current) return;
        setError(`${sameView && !sameQuery ? '加载失败，仍显示切换前片单' : cached ? '刷新失败，仍显示上次片单' : '加载失败'}：${e.message || '请重试'}`);
      } finally {
        if (loadingRequest.current === request) {
          loadingRequest.current = 0;
          clearTimeout(listTimer.current);
          setLoading(false);
        }
      }
    },
    [invalidateList, source, sourceRevision, catalogChannel, appCatalog, pageCache, discoveryPages]
  );

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => { if (active) loadDownloadedMap(); }, [active, loadDownloadedMap]);

  useEffect(() => {
    invalidateList(); closeDetail(); pageCache.clear(); discoveryPages.clear();
    refreshFirstPage.current = false;
    refreshToFirstPage.current = false;
    setGenre(''); setPage(1); setResults([]); setMeta({ total: 0, totalPages: 0, genres: [] });
    setRefreshNotice('');
    if (!mediaSources.some(item => item.id === source)) { setSource('hongguo'); setCategory('real-drama'); }
  }, [sourceRevision, mediaSources, invalidateList, closeDetail, discoveryPages]);

  useEffect(() => {
    if (active && !sourcesLoading && mediaSources.some(item => item.id === source)) {
      const forceRefresh = refreshFirstPage.current;
      refreshFirstPage.current = false;
      loadList(category, genre, page, forceRefresh);
    }
    return invalidateList;
  }, [active, category, genre, page, loadList, sourcesLoading, mediaSources, invalidateList]);

  const refreshList = () => {
    if (appCatalog && page > 1) {
      invalidateList();
      refreshFirstPage.current = true;
      refreshToFirstPage.current = true;
      setPage(1);
    } else {
      return loadList(category, genre, page, true);
    }
  };

  const retryList = () => meta.cursorExpired
    ? refreshList()
    : loadList(category, genre, page, !appCatalog);

  const switchCatalogChannel = (next) => {
    if (!['app', 'web'].includes(next) || next === catalogChannel) return;
    invalidateList(); closeDetail();
    refreshFirstPage.current = false;
    refreshToFirstPage.current = false;
    setCatalogChannel(next);
    setGenre(''); setPage(1); setCompletion('all');
    setResults([]); setMeta({ total: 0, totalPages: 0, genres: [] });
    setSourceUrl(''); setError(''); setRefreshNotice(''); setUnsupported(false);
    try { localStorage.setItem(CATALOG_CHANNEL_KEY, next); } catch (_) { /* selection still works for this launch */ }
  };

  const switchSource = (next) => {
    if (next === source) return;
    invalidateList();
    closeDetail();
    refreshFirstPage.current = false;
    refreshToFirstPage.current = false;
    setSource(next);
    setCategory('real-drama');
    setGenre('');
    setPage(1);
    setResults([]);
    setMeta({ total: 0, totalPages: 0, genres: [] });
    setSourceUrl('');
    setError('');
    setRefreshNotice('');
  };

  const selectDiscoveryBatch = (cat, gen) => {
    const sameQuery = cat === category && gen === genre;
    if (sameQuery && loading) return;
    const previous = discoveryPages.get(JSON.stringify([source, source === 'hongguo' ? catalogChannel : '', cat, gen]))?.meta;
    const hasMore = previous && (previous.totalPages ? previous.page < previous.totalPages : previous.hasMore);
    const next = sameQuery && meta.cursorExpired ? 1 : hasMore ? previous.page + 1 : 1;
    refreshToFirstPage.current = false;
    if (sameQuery && next === page) return loadList(cat, gen, next, next === 1 || !appCatalog);
    invalidateList();
    refreshFirstPage.current = next === 1;
    setError(''); setRefreshNotice('');
    if (cat !== category) {
      setResults([]); setMeta({ total: 0, totalPages: 0, genres: [] });
    }
    setCategory(cat); setGenre(gen); setPage(next);
  };

  const switchCategory = (slug) => {
    if (!slug.startsWith('hot-') && slug !== 'comic') return selectDiscoveryBatch(slug, '');
    if (slug === category) return;
    invalidateList();
    refreshFirstPage.current = false;
    refreshToFirstPage.current = false;
    setError('');
    setRefreshNotice('');
    setMeta({ total: 0, totalPages: 0, genres: [] });
    setCategory(slug);
    setGenre('');
    setPage(1);
    setResults([]);
  };

  const switchGenre = (slug) => {
    if (!category.startsWith('hot-') && category !== 'comic') return selectDiscoveryBatch(category, slug);
    if (slug === genre) return;
    invalidateList();
    refreshToFirstPage.current = false;
    setError('');
    setRefreshNotice('');
    setGenre(slug);
    setPage(1);
    // loadList keeps the previous grid visible until the new genre arrives.
  };

  const gotoPage = (p) => {
    if (meta.cursorExpired) return;
    const max = meta.totalPages || (meta.page || page) + (meta.hasMore ? 1 : 0);
    const next = Math.min(Math.max(1, p), max);
    if (next === page) {
      if (error) loadList(category, genre, next);
      return;
    }
    invalidateList();
    setError('');
    setRefreshNotice('');
    setPage(next);
    document.querySelector('.main-content:not([hidden])')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ===== 打开某部剧 =====
  const openSeries = async (item, play = mobile) => {
    setSelectingDownloads(false);
    const request = ++detailRequest.current;
    setDetailLoading(!play);
    setOpeningId(play ? item.series_id : '');
    setDetail(null);
    setSelectedIdx(new Set());
    setRangeInput('');
    setRangeError('');
    try {
      const res = await window.electronAPI.searchResolve(item.series_id);
      if (request !== detailRequest.current) return;
      if (!res || !res.success) {
        showToast((res && res.error) || '拉取分集失败', 'error');
        return;
      }
      const data = res.data;
      if (play) {
        const first = data.episodes.find(ep => !ep.locked);
        if (!first) throw new Error('来源尚未开放可播放集数');
        const opened = await window.electronAPI.playSeries({ seriesId: data.series_id, resume: true });
        if (request !== detailRequest.current) return;
        if (!opened?.success) throw new Error(opened?.error || '打开播放器失败，请重试');
        return;
      }
      // 合并下载状态
      const epRes = await window.electronAPI.getSeriesEpisodes(item.series_id);
      if (request !== detailRequest.current) return;
      const statusMap = {};
      if (epRes && epRes.success) {
        for (const e of epRes.data.episodes) statusMap[e.vid_index] = e;
      }
      const episodes = data.episodes.map((ep) => ({
        ...ep,
        status: statusMap[ep.vid_index] ? statusMap[ep.vid_index].status : 'missing',
        progress: statusMap[ep.vid_index] ? statusMap[ep.vid_index].progress : 0,
        fileUrl: statusMap[ep.vid_index] ? statusMap[ep.vid_index].fileUrl : null,
      }));
      setDetail({ ...data, episodes, completedCount: episodes.filter((e) => e.status === 'completed').length });
      // 默认全选未下载的
      setSelectedIdx(new Set(episodes.filter((e) => !e.locked && e.status !== 'completed').map((e) => e.vid_index)));
    } catch (e) {
      if (request === detailRequest.current) showToast('打开失败: ' + e.message, 'error');
    } finally {
      if (request === detailRequest.current) { setDetailLoading(false); setOpeningId(''); }
    }
  };

  const toggleIdx = (idx) => {
    if (!detail?.episodes.some((ep) => ep.vid_index === idx && !ep.locked)) return;
    const next = new Set(selectedIdx);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelectedIdx(next);
  };

  // 区间快选：1-50 / 前10 / 后30 / 全选 / 清空
  const applyRange = (expr) => {
    if (!detail) return;
    try {
      const nums = parseEpisodeRange(expr, detail.episodes.length);
      setSelectedIdx(new Set(detail.episodes.filter((e) => !e.locked && nums.has(e.vid_index)).map((e) => e.vid_index)));
      setRangeError('');
    } catch (error) { setRangeError(error.message); }
  };

  const downloadSelected = async () => {
    if (!detail || selectedIdx.size === 0) return;
    setSubmitting(true);
    try {
      const eps = detail.episodes.filter((e) => !e.locked && selectedIdx.has(e.vid_index));
      const res = await window.electronAPI.hongguoDownloadBatch({
        seriesId: detail.series_id,
        seriesTitle: detail.series_title,
        episodes: eps,
      });
      if (res && res.success) {
        showToast(`已加入下载队列：${res.count} 集`);
        setDetail(null);
        if (onNavigate) onNavigate('manager');
      } else {
        showToast((res && res.error) || '提交下载失败', 'error');
      }
    } catch (e) {
      showToast('提交异常: ' + e.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 从第一集开始；播放器按实际状态选择本地或在线片源。
  const playNow = async (vidIndex) => {
    if (!detail) return;
    const first = detail.episodes.find((e) => !e.locked && (typeof vidIndex !== 'number' || e.vid_index === vidIndex));
    if (!first) return;
    try {
      const res = await window.electronAPI.playSeries({ seriesId: detail.series_id, vidIndex: first.vid_index });
      if (res?.success) closeDetail();
      else showToast(res?.error || '打开播放器失败，请重试', 'error');
    } catch (e) {
      showToast('打开播放器失败: ' + e.message, 'error');
    }
  };

  const showBrowser = async () => {
    if (source !== 'hongguo' || !sourceUrl) return;
    try {
      const res = await window.electronAPI.searchWindowShow(true, sourceUrl);
      if (res?.success === false) throw new Error(res.error || '来源页面打开失败');
      showToast('已打开当前来源页面');
    } catch (e) { showToast(e.message || '来源页面打开失败', 'error'); }
  };

  useDialogKeyboard(active && (!!detail || detailLoading), closeDetail, '.browse-drawer');

  const visibleResults = completion === 'all' ? results : results.filter((item) => item.completion_status === completion);
  // Keep the label and navigation anchored to the cards that actually loaded.
  const displayedPage = meta.page || page;
  const totalPages = meta.totalPages || 0;
  const hasNextBatch = results.length > 0 && (totalPages ? displayedPage < totalPages : meta.hasMore);
  const pageNumbers = useMemo(() => {
    if (!totalPages) return [];
    const out = [];
    const cur = displayedPage;
    const push = (n) => {
      if (n >= 1 && n <= totalPages && !out.includes(n)) out.push(n);
    };
    out.push(1);
    for (let i = cur - 1; i <= cur + 1; i++) push(i);
    push(totalPages);
    return out.sort((a, b) => a - b);
  }, [totalPages, displayedPage]);

  return (
    <div className="browse-container">
      <div className="browse-header">
        <div className="browse-title" hidden={mobile}>
          <div><h2>{t("发现短剧")}</h2><p className="page-description">{t("挑一部喜欢的，让故事继续。")}</p></div>
        </div>
        <div className="browse-header-right">
          {(!mobile || mediaSources.length > 1) && <label className="source-control">{t("来源")}<select className="input-field" aria-label={t("短剧来源")} value={source} onChange={(e) => switchSource(e.target.value)}>{mediaSources.map(({ id, label }) => <option key={id} value={id}>{id.startsWith('custom:') ? label : t(label)}</option>)}</select></label>}
          {source === 'hongguo' && <label className="source-control">{t(mobile ? '' : '目录线路')}<select className="input-field" aria-label={t("红果目录线路")} value={catalogChannel} onChange={(e) => switchCatalogChannel(e.target.value)}><option value="app">{t(mobile ? 'App目录' : 'App（快速 · 部分片单）')}</option><option value="web">{t(mobile ? '官网目录' : '官网（完整目录）')}</option></select></label>}
          {!mobile && <button className="btn btn-primary" onClick={() => onNavigate('download')}><Search size={15} />{t("搜索短剧")}</button>}
          <button className="btn btn-outline" disabled={loading || sourcesLoading || meta.cursorExpired || page !== displayedPage || !hasNextBatch} onClick={() => gotoPage(displayedPage + 1)}><RefreshCw size={15} />{t("换一批")}</button>
          <button className="btn btn-outline" aria-label={t("刷新片单")} disabled={loading || sourcesLoading} onClick={refreshList}><RefreshCw size={15} />{t(!mobile && '刷新片单')}</button>
          {meta.total > 0 && <span className="browse-stat">{t("共 ")}{t(meta.total)}{t(" 部")}</span>}
          {!mobile && source === 'hongguo' && catalogChannel === 'web' && sourceUrl && <button className="btn btn-outline" onClick={showBrowser}>
            <ExternalLink size={15} />{t("打开来源页面")}</button>}
        </div>
      </div>

      {!mobile && <p className="browse-source-note">{t("点击分类或题材即可换一批，再点当前分类也能继续换；四个热播榜按来源热度顺序展示。")}{t(appCatalog && '“刷新片单”重新获取第一页。')}</p>}
      {!mobile && source === 'hongguo' && <p className="browse-source-note">{t("App 与官网的榜单、题材划分可能不同。")}</p>}
      {refreshNotice && <p className="browse-source-note" role="status">{t(refreshNotice)}</p>}

      {/* 分类 tab */}
      {source === 'hongguo' && [false, true].map(ranking => {
        const group = (categories.length ? categories : [{ slug: 'real-drama', label: '真人剧' }])
          .filter(c => c.slug.startsWith('hot-') === ranking);
        return group.length > 0 && <div className="browse-cats" role="group" aria-label={t(ranking ? '热播榜单' : '短剧分类')} key={String(ranking)}>
        <span className="browse-nav-label">{t(ranking ? '热播榜' : '分类')}</span>
        {group.map((c) => (
          <button
            key={c.slug}
            className={`browse-cat ${category === c.slug ? 'active' : ''}`}
            aria-pressed={category === c.slug}
            onClick={() => switchCategory(c.slug)}
          >
            {t(c.label)}
          </button>
        ))}
      </div>;
      })}

      {sourcesError && <p className="browse-source-note" role="status">{t("来源列表更新失败，暂用上次列表。可在设置重新保存来源后重试。")}</p>}
      {source === 'hongguo' && catalogChannel === 'app' && <p className="browse-source-note" role="status">{t("App 快速线路只显示部分片单；需要更完整的目录时请切换到“官网”。")}</p>}
      {source.startsWith('custom:') && <p className="browse-source-note">{t("来自 ")}{mediaSourceLabel(source, mediaSources)}{t(" 的接口目录，按来源顺序显示，不代表热播榜。")}</p>}
      {source === 'xifan' && <p className="browse-source-note">{t("当前提供题材分类，西饭热播榜暂未接入。")}</p>}
      {source === 'reelshort' && <p className="browse-source-note">{t("官网公开片单，按原顺序显示，每类最多 12 部；当前只提供首页快照，无后续分页。受地区限制，付费集请在官方平台确认权限。")}</p>}

      {source === 'reelshort' && <p className="browse-source-note">官网公开片单，按原顺序显示，每类最多 12 部；当前只提供首页快照，无后续分页。受地区限制，付费集请在官方平台确认权限。</p>}

      {/* 题材 chips */}
      <FilterContainer className={mobile ? 'mobile-browse-filters' : undefined}>
      {mobile && <summary>{t("筛选题材与状态")}{genre && <> · {t(meta.genres.find(item => item.slug === genre)?.label || '')}</>}{completion !== 'all' && <> · {t(completion === 'completed' ? '已完结' : '更新中')}</>}</summary>}
      {meta.genres.length > 0 && (
        <div className="browse-genres">
          <button
            className={`genre-chip ${genre === '' ? 'active' : ''}`}
            onClick={() => switchGenre('')}
          >
            {t(source === 'xifan' ? '默认分类' : '全部')}
          </button>
          {meta.genres.map((g) => (
            <button
              key={g.slug}
              className={`genre-chip ${genre === g.slug ? 'active' : ''}`}
              onClick={() => switchGenre(g.slug)}
            >
              {t(g.label)}
            </button>
          ))}
        </div>
      )}

      <div className="browse-completion-filter">
        <label htmlFor="browse-completion">{t("剧集状态")}</label>
        <select id="browse-completion" className="input-field" value={completion} onChange={(event) => setCompletion(event.target.value)} aria-describedby="browse-completion-hint">
          <option value="all">{t("全部")}</option>
          <option value="completed">{t("已完结")}</option>
          <option value="ongoing">{t("更新中")}</option>
        </select>
        <span id="browse-completion-hint">{t("仅筛选当前页；状态未注明的剧集只在“全部”显示。")}</span>
        {completion !== 'all' && <span role="status">{t("本页 ")}{t(visibleResults.length)} / {t(results.length)}{t(" 部")}</span>}
      </div>
      {mobile && <p className="browse-source-note">{t("再点分类或题材可换一批；热播榜保持来源热度顺序。App与官网片单可能不同。")}</p>}
      </FilterContainer>
      {!loading && !error && results.length > 0 && visibleResults.length === 0 && <div className="browse-filter-empty" role="status"><p>{t("本页没有明确标记为")}{t(completion === 'completed' ? '已完结' : '更新中')}{t("的剧集。")}</p><button className="btn btn-outline" onClick={() => setCompletion('all')}>{t("显示本页全部")}</button></div>}

      {error && results.length > 0 && <div className="alert alert-error browse-update-error" role="alert">
        <span>{t(error)}</span><button className="btn btn-outline btn-sm" disabled={loading || sourcesLoading} onClick={retryList}>{t("重试")}</button>
      </div>}
      {error && results.length === 0 && <div className="browse-error-state" role={unsupported ? 'status' : 'alert'}><Film size={36} /><h3>{t(unsupported ? '这里是图文漫画' : '暂时没能加载剧集')}</h3><p>{t(error)}</p><div className="search-empty-actions">{unsupported ? <button className="btn btn-primary" onClick={() => switchCategory('comic-drama')}>{t("查看漫剧")}</button> : <button className="btn btn-primary" onClick={retryList}><RefreshCw size={15} />{t("重新加载")}</button>}<button className="btn btn-outline" onClick={() => onNavigate('download')}>{t("按剧名搜索")}</button></div></div>}

      {loading && results.length > 0 && <div className="browse-loading" role="status"><RefreshCw size={18} className="spin" /><span>{t("正在更新片单，仍可浏览上次结果…")}</span><button className="btn btn-outline btn-sm" onClick={cancelList}>{t("取消加载")}</button></div>}

      {loading && results.length === 0 ? (
        <div className="browse-loading-state" role="status"><div className="browse-loading"><RefreshCw size={18} className="spin" /><span>{t("正在加载")}{t(categories.find((item) => item.slug === category)?.label || '短剧')}…</span><button className="btn btn-outline btn-sm" onClick={cancelList}>{t("取消加载")}</button></div><div className="poster-skeletons" aria-hidden="true">{t(Array.from({ length: 5 }, (_, i) => <div className="poster-skeleton" key={i}><div /><span /><span /></div>))}</div></div>
      ) : (
        <div className="browse-grid">
          {visibleResults.map((item) => {
            const dl = downloadedMap[String(item.series_id)];
            return (
              <div className="browse-card-item" key={item.series_id}>
              <button
                type="button"
                className="browse-card"
                disabled={openingId === item.series_id}
                onClick={() => openSeries(item)}
                title={`${mobile ? t('播放：') : ''}${item.series_title}`}
              >
                <div className="browse-cover">
                  {item.rank > 0 && <span className="browse-rank-badge">{t("榜单第 {0} 名", [item.rank])}</span>}
                  {item.cover ? (
                    <img src={item.cover} alt={item.series_title} loading="lazy" />
                  ) : (
                    <div className="cover-placeholder"><Film size={22} /></div>
                  )}
                  {(item.episode_label || item.episode_count > 0) && (
                    <span className="browse-ep-badge">{t(item.episode_label || `${item.episode_count} 集`)}</span>
                  )}
                  {dl && dl.completed > 0 && (
                    <span className="browse-dl-badge">
                      <Check size={11} /> {t(dl.completed)}/{t(dl.total)}
                    </span>
                  )}
                  <div className="browse-hover">
                    <span className="browse-hover-play">
                      <Play size={16} /> {t(mobile || dl && dl.completed > 0 ? '播放' : '查看')}
                    </span>
                  </div>
                </div>
                <div className="browse-card-title">{item.series_title}</div>
                {item.completion_status === 'completed' && <div className="browse-completion-label">{t("已完结")}</div>}
                {item.completion_status === 'ongoing' && <div className="browse-completion-label">{t("更新中")}</div>}
                {item.heat && <div className="browse-card-heat">{t(item.heat)}</div>}
                {item.tags && item.tags.length > 0 && (
                  <div className="browse-card-tags">
                    {item.tags.slice(0, 2).map((t) => (
                      <span key={t} className="browse-tag">{t}</span>
                    ))}
                  </div>
                )}
              </button>
              {mobile && <button className="mobile-drama-details" aria-label={t(`详情与下载：${item.series_title}`)} onClick={() => openSeries(item, false)}>{t(openingId === item.series_id ? '正在打开…' : '详情与下载')}</button>}
              </div>
            );
          })}
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="browse-pager">
          <button className="pager-item" aria-label={t("上一页")} disabled={displayedPage <= 1 || meta.cursorExpired} onClick={() => gotoPage(displayedPage - 1)}>‹</button>
          {pageNumbers.map((n, i) => (
            <React.Fragment key={n}>
              {i > 0 && n - pageNumbers[i - 1] > 1 && <span className="pager-gap">…</span>}
              <button
                className={`pager-item ${n === displayedPage ? 'active' : ''}`}
                disabled={meta.cursorExpired}
                onClick={() => gotoPage(n)}
              >
                {t(n)}
              </button>
            </React.Fragment>
          ))}
          <button className="pager-item" aria-label={t("下一页")} disabled={displayedPage >= totalPages || meta.cursorExpired} onClick={() => gotoPage(displayedPage + 1)}>›</button>
        </div>
      )}

      {!totalPages && (displayedPage > 1 || meta.hasMore) && <div className="browse-pager"><button className="pager-item" disabled={displayedPage <= 1 || loading || meta.cursorExpired} onClick={() => gotoPage(displayedPage - 1)}>{t("上一页")}</button><span>{t("第 {0} 页", [displayedPage])}</span><button className="pager-item" disabled={!meta.hasMore || loading || meta.cursorExpired} onClick={() => gotoPage(displayedPage + 1)}>{t("下一页")}</button></div>}

      {/* ===== 剧集详情抽屉 ===== */}
      {(detail || detailLoading) && (
        <div className="browse-drawer-mask" onClick={closeDetail}>
          <div className="browse-drawer" role="dialog" aria-modal="true" aria-label={t("剧集详情")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="browse-drawer-head">
              <div className="browse-drawer-title">
                <Film size={18} />
                <span>{detail ? `《${detail.series_title}》` : t("加载中…")}</span>
              </div>
              <button className="icon-btn" onClick={closeDetail} title={t("关闭")}>
                <X size={16} />
              </button>
            </div>

            {detailLoading && (
              <div className="browse-loading">
                <RefreshCw size={18} className="spin" />
                <span>{t("正在拉取全集…")}</span>
              </div>
            )}

            {detail && (
              <>
                <div className="browse-drawer-body">
                  <div className="browse-drawer-info">
                    {detail.cover && <img src={detail.cover} alt="" className="browse-drawer-cover" />}
                    <div className="browse-drawer-meta">
                      <div className="browse-drawer-count">
                        {mediaSourceLabel(detail.series_id, mediaSources)}{t(" · 共 ")}{t(detail.total)}{t(" 集 · 已下载 ")}<b>{t(detail.completedCount)}</b>{t(" 集")}</div>
                      {detail.web_accessible_episodes != null && detail.web_accessible_episodes < detail.total && (
                        <div className="browse-drawer-sub">{t("网页源提供前 ")}{t(detail.web_accessible_episodes)}{t(" 集，后续集数自动尝试 App 片源。")}</div>
                      )}
                      {detail.episodes.some((ep) => ep.locked) && <div className="browse-drawer-sub">{t("标记“锁定”的集数需在来源平台解锁，本应用不提供解锁。")}</div>}
                      {(!mobile || selectingDownloads) && <>
                      <div className="browse-drawer-sub">{t("选中 ")}{t(selectedIdx.size)}{t(" 集待下载")}</div>
                      <div className="browse-range-row">
                        <input
                          type="text"
                          className="input-field"
                          aria-label={t("选择集数范围")}
                          placeholder={t("区间，如 1-50 或 1,3,5")}
                          value={rangeInput}
                          onChange={(e) => { setRangeInput(e.target.value); setRangeError(''); }}
                          onKeyDown={(e) => isSubmitKey(e) && applyRange(rangeInput)}
                        />
                        <button className="btn btn-outline btn-sm" onClick={() => applyRange(rangeInput)}>{t("应用")}</button>
                      </div>
                      {rangeError && <p className="alert alert-error" role="alert">{t(rangeError)}</p>}
                      <div className="preset-row mt8">
                        <button className="btn-chip" onClick={() => applyRange(`1-${Math.min(10, detail.total)}`)}>{t("前10集")}</button>
                        <button className="btn-chip" onClick={() => applyRange(`1-${Math.min(30, detail.total)}`)}>{t("前30集")}</button>
                        <button className="btn-chip" onClick={() => applyRange(`${Math.max(1, detail.total - 29)}-${detail.total}`)}>{t("后30集")}</button>
                        <button className="btn-chip" onClick={() => setSelectedIdx(new Set(detail.episodes.filter((e) => !e.locked).map((e) => e.vid_index)))}>{t("全选")}</button>
                        <button className="btn-chip" onClick={() => setSelectedIdx(new Set())}>{t("清空")}</button>
                      </div>
                      </>}
                    </div>
                  </div>

                  {mobile && detail.description && <details className="mobile-drama-description"><summary>{t("剧情简介")}</summary><p>{detail.description}</p></details>}
                  {mobile && <p className="browse-drawer-sub">{t(selectingDownloads ? '点选需要下载的集数' : '点选集数直接播放，已下载视频优先从本机播放')}</p>}

                  <div className="browse-eps">
                    {detail.episodes.map((ep) => (
                      <button
                        disabled={ep.locked === true}
                        aria-pressed={(!mobile || selectingDownloads) && selectedIdx.has(ep.vid_index)}
                        key={ep.vid_index}
                        className={`ep-chip ep-${ep.status} ${(!mobile || selectingDownloads) && selectedIdx.has(ep.vid_index) ? 'ep-picked' : ''}`}
                        onClick={() => mobile && !selectingDownloads ? playNow(ep.vid_index) : toggleIdx(ep.vid_index)}
                        title={(ep.locked ? t('需在来源平台解锁') : ep.title || t(`第 ${ep.vid_index} 集`))}
                      >
                        <span className="ep-num">{t(ep.vid_index)}</span>{ep.locked && <span className="ep-lock-label">{t("锁定")}</span>}
                        {ep.status === 'completed' && <Check size={11} className="ep-badge" />}
                        {(!mobile || selectingDownloads) && selectedIdx.has(ep.vid_index) && <span className="ep-pick-dot" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="browse-drawer-foot">
                  <button className={`btn ${mobile && !selectingDownloads ? 'btn-primary' : 'btn-outline'}`} disabled={!detail.episodes.some((ep) => !ep.locked)} onClick={mobile && selectingDownloads ? () => setSelectingDownloads(false) : playNow}>
                    <Play size={15} />
                    {t(mobile && selectingDownloads ? '返回播放' : '立即播放')}
                  </button>
                  <div className="browse-foot-right">
                    <button
                      className={`btn ${mobile && !selectingDownloads ? 'btn-outline' : 'btn-primary'}`}
                      disabled={submitting || (!mobile || selectingDownloads) && selectedIdx.size === 0}
                      onClick={mobile && !selectingDownloads ? () => { setSelectedIdx(new Set()); setSelectingDownloads(true); } : downloadSelected}
                    >
                      <Download size={15} />
                      {t(mobile && !selectingDownloads ? '选集下载' : `下载选中 (${selectedIdx.size})`)}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className={`dm-toast dm-toast-${toast.type}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export default Browse;
