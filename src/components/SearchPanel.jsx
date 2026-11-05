import React, { useState, useRef, useEffect } from 'react';
import './HongguoDownload.css';
import { Search, Film, RefreshCw, ExternalLink } from './icons';
import { isSubmitKey } from './episodeRange';
import { readSearchHistory, saveSearchTerm, removeSearchTerm, clearSearchHistory, rememberCatalogTitles, getSearchSuggestions } from '../searchHistory';

import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { rankSearchResults } from './searchRanking.mjs';

const SEARCH_SAFETY_TIMEOUT_MS = 25000;

/**
 * SearchPanel —— 按所选来源搜索短剧
 * 拿到 series_id 后交给父组件走既有的「拉全集 + 选集下载」流程。
 */
function SearchPanel({ onSelectSeries, onSwitchToInput, active = true }) {
  const [source, setSource] = useState('all');
  const { sources: mediaSources, revision: sourceRevision, loading: sourcesLoading, error: sourcesError } = useMediaSources();
  const requestVersion = useRef(0);
  const pendingSearch = useRef(null);
  useEffect(() => () => { requestVersion.current++; cancelMore(); }, []);
  const [keyword, setKeyword] = useState('');
  const [history, setHistory] = useState(readSearchHistory);
  const [historyError, setHistoryError] = useState('');
  const inputRef = useRef(null);
  const suggestions = getSearchSuggestions(keyword, history);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null); // null=未搜索, []=无结果
  const [error, setError] = useState('');
  const [searchWarning, setSearchWarning] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [searchedKeyword, setSearchedKeyword] = useState('');
  const [more, setMore] = useState({});
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState('');
  const moreRequest = useRef(null);
  const [pickingId, setPickingId] = useState('');
  const cancelMore = () => {
    clearTimeout(moreRequest.current?.timer);
    moreRequest.current = null;
  };

  useEffect(() => {
    if (!active) {
      requestVersion.current++;
      pendingSearch.current = null;
      setPickingId('');
      setLoading(false);
      cancelMore(); setMoreLoading(false); setMoreError('');
    }
  }, [active]);

  useEffect(() => {
    requestVersion.current++; pendingSearch.current = null;
    setLoading(false); setPickingId(''); setResults(null); setError(''); setSearchWarning(''); setPageTitle(''); setMore({}); setMoreError(''); setMoreLoading(false); cancelMore();
    if (source !== 'all' && !mediaSources.some(item => item.id === source)) setSource('all');
  }, [sourceRevision, mediaSources]);

  const switchSource = (next) => {
    if (next === source) return;
    requestVersion.current++;
    pendingSearch.current = null;
    setSource(next);
    setLoading(false);
    setPickingId('');
    setResults(null);
    setError('');
    setSearchWarning('');
    setPageTitle('');
    setMore({}); setMoreError(''); setMoreLoading(false); cancelMore();
  };

  const changeKeyword = (value) => {
    requestVersion.current++;
    pendingSearch.current = null;
    setKeyword(value);
    setLoading(false);
    setPickingId('');
    setResults(null);
    setError('');
    setSearchWarning('');
    setMore({}); setMoreError(''); setMoreLoading(false); cancelMore();
  };

  const clearHistory = () => {
    try {
      clearSearchHistory();
      setHistory([]);
      setHistoryError('');
    } catch {
      setHistoryError('搜索历史清除失败，请重试。');
    }
  };

  const removeHistory = (term) => {
    try {
      setHistory(removeSearchTerm(term));
      setHistoryError('');
    } catch {
      setHistoryError('这条搜索历史删除失败，请重试。');
    }
  };

  const doSearch = async () => {
    if (sourcesLoading) return;
    const kw = keyword.trim();
    if (!kw) {
      setError('请输入剧名关键词');
      return;
    }
    const key = JSON.stringify([source, kw]);
    if (pendingSearch.current?.key === key) return;
    const request = ++requestVersion.current;
    pendingSearch.current = { key, request };
    setPickingId('');
    setLoading(true);
    setError('');
    setSearchWarning('');
    setResults(null);
    setPageTitle('');
    setMore({}); setMoreError(''); setMoreLoading(false); cancelMore();
    setSearchedKeyword(kw);
    const sources = source === 'all' ? mediaSources.map(item => item.id) : [source];
    const settled = new Array(sources.length);
    const publishPartial = () => {
      if (request !== requestVersion.current) return;
      const merged = [], nextMore = {};
      sources.forEach((searchSource, index) => {
        const entry = settled[index];
        if (entry?.status !== 'fulfilled') return;
        merged.push(...(entry.value.results || []).map(item => ({ ...item, source: searchSource })));
        if (entry.value.channel && entry.value.channel !== 'dom' && entry.value.hasMore) {
          nextMore[searchSource] = { channel: entry.value.channel, cursor: entry.value.cursor || null, page: entry.value.page || 1, hasMore: true };
        }
      });
      if (merged.length) setResults(rankSearchResults(merged, kw));
      if (sources.length === 1) setPageTitle(settled[0]?.value?.pageTitle || '');
      // Do not offer pagination until every source has settled; otherwise the button can shift under the user.
      if (sources.every((_, index) => settled[index])) setMore(nextMore);
    };
    const applyResponses = (timedOut) => {
      const merged = [], failures = [], warnings = [], nextMore = {};
      sources.forEach((searchSource, index) => {
        const entry = settled[index];
        if (!entry) {
          if (timedOut) failures.push(`${mediaSourceLabel(searchSource, mediaSources)}：搜索超时，未返回结果`);
          return;
        }
        if (entry.status === 'fulfilled') {
          merged.push(...(entry.value.results || []).map(item => ({ ...item, source: searchSource })));
          if (entry.value.partial) warnings.push(`${mediaSourceLabel(searchSource, mediaSources)}：${entry.value.error || '补充搜索未完成，可稍后重试。'}`);
          if (entry.value.meta?.relaxed) warnings.push(`${mediaSourceLabel(searchSource, mediaSources)}：没有完整剧名匹配，已用「${entry.value.meta.relaxedQuery}」补搜。`);
          if (entry.value.meta?.newRelease && entry.value.via !== 'app-new') warnings.push(`${mediaSourceLabel(searchSource, mediaSources)}：官网暂未返回同名结果，已从 App 上新补搜到 ${entry.value.meta.newRelease} 部。`);
          if (sources.length === 1) setPageTitle(entry.value.pageTitle || '');
          if (entry.value.channel && entry.value.channel !== 'dom' && entry.value.hasMore) {
            nextMore[searchSource] = { channel: entry.value.channel, cursor: entry.value.cursor || null, page: entry.value.page || 1, hasMore: true };
          }
        } else {
          failures.push(`${mediaSourceLabel(searchSource, mediaSources)}：${entry.reason?.message || '搜索失败'}`);
        }
      });
      rememberCatalogTitles(merged);
      if (settled.some(entry => entry?.status === 'fulfilled')) {
        try {
          setHistory(saveSearchTerm(kw));
          setHistoryError('');
        } catch {
          setHistoryError('搜索结果已显示，但本机搜索历史保存失败。');
        }
      }
      setResults(rankSearchResults(merged, kw));
      setMore(nextMore);
      setSearchWarning(warnings.join('；'));
      if (failures.length) setError(`${failures.join('；')}。${merged.length ? '已显示其他来源的结果。' : ''}请重试或切换来源。`);
    };
    const safety = setTimeout(() => {
      if (request !== requestVersion.current) return;
      requestVersion.current++;
      pendingSearch.current = null;
      applyResponses(true);
      setLoading(false);
    }, SEARCH_SAFETY_TIMEOUT_MS);
    try {
      // 每个来源完成就记下来；总超时到达时仍能展示已完成来源的结果。
      const responses = await Promise.allSettled(sources.map((searchSource, index) => window.electronAPI.searchSeries(kw, { source: searchSource })
        .then(res => {
          if (!res?.success) throw new Error(res?.error || '搜索失败，请重试');
          const entry = { status: 'fulfilled', value: res };
          settled[index] = entry;
          publishPartial();
          return entry;
        })
        .catch(error => {
          const entry = { status: 'rejected', reason: error };
          settled[index] = entry;
          publishPartial();
          throw error;
        })));
      if (request !== requestVersion.current) return;
      responses.forEach((entry, index) => { settled[index] ||= entry; });
      applyResponses(false);
    } catch (e) {
      if (request !== requestVersion.current) return;
      // allSettled 通常不会 reject；保留防御路径，避免同步异常留下空转圈。
      settled.forEach((entry, index) => { if (!entry) settled[index] = { status: 'rejected', reason: e }; });
      applyResponses(false);
    } finally {
      clearTimeout(safety);
      if (pendingSearch.current?.request === request) pendingSearch.current = null;
      if (request === requestVersion.current) setLoading(false);
    }
  };

  // 选中某部剧 -> 拉取完整分集 -> 交给下载页
  const pick = async (item) => {
    const request = ++requestVersion.current;
    pendingSearch.current = null;
    setLoading(false);
    setPickingId(item.series_id);
    setError('');
    try {
      const res = await window.electronAPI.searchResolve(item.series_id);
      if (request !== requestVersion.current) return;
      if (res && res.success && res.data) {
        onSelectSeries({
          ...res.data,
          cover: res.data.cover || item.cover || '',
          description: [res.data.description, res.data.intro, res.data.series_intro, item.description, item.intro, item.series_intro]
            .find(value => typeof value === 'string' && value.trim())?.trim() || '',
        });
      } else {
        setError((res && res.error) || '拉取分集失败');
      }
    } catch (e) {
      if (request === requestVersion.current) setError('拉取分集异常: ' + e.message);
    } finally {
      if (request === requestVersion.current) setPickingId('');
    }
  };

  const showBrowser = async () => {
    try {
      const term = (searchedKeyword || keyword).trim();
      const sourceUrl = term ? `https://hongguoduanju.com/search/${encodeURIComponent(term)}` : undefined;
      const res = await window.electronAPI.searchWindowShow(true, sourceUrl);
      if (res?.success === false) throw new Error(res.error || '来源页面打开失败');
    } catch (e) { setError(e.message || '来源页面打开失败，请重试'); }
  };

  const loadMore = async () => {
    const entries = Object.entries(more).filter(([, state]) => state.hasMore);
    const kw = searchedKeyword.trim();
    if (!active || sourcesLoading || moreRequest.current || !kw || !entries.length) return;
    const request = { responses: new Map(), timer: null };
    moreRequest.current = request;
    setMoreLoading(true); setMoreError('');
    const finish = (timedOut = false) => {
      if (moreRequest.current !== request) return;
      cancelMore();
      const nextMore = { ...more }, additions = [], errors = [];
      for (const [searchSource, state] of entries) {
        const response = request.responses.get(searchSource);
        if (response?.success) {
          additions.push(...(response.results || []).map(item => ({ ...item, source: searchSource })));
          if (response.hasMore) nextMore[searchSource] = { channel: response.channel || state.channel, cursor: response.cursor || null, page: response.page || state.page + 1, hasMore: true };
          else delete nextMore[searchSource];
        } else {
          errors.push(`${mediaSourceLabel(searchSource, mediaSources)}：${response?.error || (timedOut && !response ? '加载更多超时，请重试' : '加载更多失败')}`);
        }
      }
      if (additions.length) {
        setResults(prev => {
          const map = new Map((prev || []).map(item => [`${item.source}:${item.series_id}`, item]));
          for (const item of additions) map.set(`${item.source}:${item.series_id}`, item);
          return rankSearchResults([...map.values()], kw);
        });
      }
      setMore(nextMore);
      setMoreError(errors.join('；'));
      setMoreLoading(false);
    };
    // Preserve completed sources at the deadline; late IPC replies cannot alter the next request.
    request.timer = setTimeout(() => finish(true), SEARCH_SAFETY_TIMEOUT_MS);
    await Promise.all(entries.map(async ([searchSource, state]) => {
      let response;
      try {
        response = await window.electronAPI.searchSeriesMore(kw, { source: searchSource, channel: state.channel, cursor: state.cursor, page: state.page + 1 });
      } catch (error) { response = { success: false, error: error.message }; }
      if (moreRequest.current === request) request.responses.set(searchSource, response);
    }));
    finish();
  };

  const matchedCount = results ? results.filter(item => item.relevance < 2).length : 0;
  const contentCount = results ? results.filter(item => item.relevance === 2 && !item.fuzzy).length : 0;
  const fuzzyCount = results ? results.filter(item => item.fuzzy).length : 0;
  const otherCount = results ? results.filter(item => item.relevance > 2 && !item.fuzzy).length : 0;

  return (
    <div className="hongguo-card">
      <div className="card-header-title">
        <Search size={18} />
        <span>搜索短剧</span>
        <label className="source-control">来源<select className="input-field" aria-label="短剧来源" value={source} onChange={(e) => switchSource(e.target.value)}><option value="all">全部来源</option>{mediaSources.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>

      {sourcesError && <p className="settings-hint" role="status">来源列表更新失败，暂用上次列表；可在设置重新保存来源后重试。</p>}
      <div className="input-group">
        <input
          type="text"
          className="input-field"
          aria-label="搜索短剧名称"
          aria-describedby="search-suggestions-hint"
          ref={inputRef}
          list="local-search-suggestions"
          autoComplete="off"
          placeholder="输入剧名，例如：一村人养一个神"
          value={keyword}
          onChange={(e) => changeKeyword(e.target.value)}
          onKeyDown={(e) => isSubmitKey(e) && doSearch()}
        />
        <button className="btn btn-primary" onClick={doSearch} disabled={loading || sourcesLoading}>
          {loading ? (
            <>
              <RefreshCw size={16} className="spin" />
              <span>搜索中...</span>
            </>
          ) : (
            <>
              <Search size={16} />
              <span>搜索</span>
            </>
          )}
        </button>
      </div>
      <datalist id="local-search-suggestions">
        {suggestions.map(({ term, source: origin }) => <option key={term} value={term} label={origin} />)}
      </datalist>
      <p className="settings-hint search-suggestions-hint" id="search-suggestions-hint">本机联想：匹配搜索历史和本次浏览过的真实剧名。</p>
      {history.length > 0 && <div className="search-history">
        <div className="search-history-heading"><span>本机搜索历史</span><button type="button" className="btn-chip" onClick={clearHistory}>清除历史</button></div>
        <div className="search-history-terms">{history.map((term) => <span className="search-history-term" key={term}><button type="button" className="btn-chip" title={term} onClick={() => { changeKeyword(term); inputRef.current?.focus(); }}>{term}</button><button type="button" className="search-history-remove" aria-label={`删除搜索历史：${term}`} title="删除这条搜索历史" onClick={() => removeHistory(term)}>×</button></span>)}</div>
      </div>}
      {historyError && <p className="search-history-error" role="alert">{historyError}</p>}
      <p className="settings-hint" style={{ marginTop: 8 }}>
        {source === 'all' ? '同时搜索所有已启用来源，结果标明来源；选择一部即可查看全部剧集。' : '按剧名查找，选择一部即可查看全部剧集。'}
      </p>

      {results === null && !loading && !error && (
        <div className="search-welcome"><Search size={36} /><h3>好故事，从一个名字开始</h3><p>输入完整剧名或关键词，发现你想看的短剧。</p></div>
      )}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {searchWarning && <p className="settings-hint" role="status">{searchWarning} 已显示本次查到的结果。</p>}

      {loading && (
        <div className="search-loading">
          <RefreshCw size={18} className="spin" />
          <span>正在寻找相关短剧，首次加载可能需要几秒…</span>
        </div>
      )}

      {results && results.length === 0 && !loading && !error && (
        <div className="search-empty">
          <p>没有找到相关短剧{pageTitle ? `（页面标题：${pageTitle}）` : ''}</p>
          <div className="search-empty-actions">
            {source === 'hongguo' && <button className="btn btn-outline" onClick={showBrowser}>
              <ExternalLink size={15} />
              打开来源页面
            </button>}
            {source === 'hongguo' && onSwitchToInput && (
              <button className="btn btn-outline" onClick={onSwitchToInput}>
                改用链接 / ID 下载
              </button>
            )}
          </div>
        </div>
      )}

      {results && results.length > 0 && (
        <>
          <div className="search-count">找到 {matchedCount} 部标题匹配短剧{contentCount ? `，另有 ${contentCount} 部剧情提到该词（排在后面）` : ''}{fuzzyCount ? `，另有 ${fuzzyCount} 部补搜结果` : ''}{otherCount ? `，另有 ${otherCount} 部来源返回的其他结果（排在后面）` : ''}</div>
          <div className="search-grid">
            {results.map((item) => (
              <button
                type="button"
                disabled={pickingId !== ''}
                key={`${item.source}:${item.series_id}`}
                className={`search-card ${pickingId === item.series_id ? 'picking' : ''}`}
                onClick={() => pickingId === '' && pick(item)}
                title={`点击查看并下载：${item.series_title}`}
              >
                <div className="search-cover">
                  {item.cover ? (
                    <img src={item.cover} alt={item.series_title} loading="lazy" />
                  ) : (
                    <div className="cover-placeholder">
                      <Film size={22} />
                    </div>
                  )}
                </div>
                <div className="search-card-body">
                  <div className="search-card-title">{item.series_title}</div>
                  <div className="search-card-sub">
                    {pickingId === item.series_id ? (
                      <>
                        <RefreshCw size={13} className="spin" /> 正在拉取分集…
                      </>
                    ) : (
                      <><span className="badge">{mediaSourceLabel(item.source, mediaSources)}</span>{item.new_release && <span className="badge-new">{item.released_today ? '今日上新' : 'App 新剧'}</span>}{item.fuzzy ? '补搜结果 · 查看剧集' : item.relevance === 2 ? '剧情相关 · 查看剧集' : item.relevance > 2 ? '其他结果 · 查看剧集' : '查看剧集'}</>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
          {Object.values(more).some(state => state.hasMore) && (
            <div className="search-more">
              <button type="button" className="btn btn-outline" disabled={moreLoading} onClick={loadMore}>
                {moreLoading ? '加载中…' : '加载更多'}
              </button>
              {moreError && <span role="alert">{moreError}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default SearchPanel;
