import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Clock } from './icons';
import './WatchHistory.css';

const PREFERENCES_KEY = 'hongguo:watch-history-preferences';

export default function WatchHistory({ active = true, onNavigate }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkingRow, setCheckingRow] = useState('');
  const [opening, setOpening] = useState('');
  const [removing, setRemoving] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState('all');
  const [preferences, setPreferences] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY));
      return {
        scope: ['all', 'latest', 'unfinished', 'skip-completed-low'].includes(saved?.scope) ? saved.scope : 'all',
        hideLowSeasons: saved?.hideLowSeasons === true,
      };
    } catch { return { scope: 'all', hideLowSeasons: false }; }
  });
  const { scope, hideLowSeasons } = preferences;
  const [progress, setProgress] = useState(null);
  const request = useRef(0);
  const openingRef = useRef(false);
  const openingRequest = useRef(0);
  const listedRows = hideLowSeasons ? rows.filter(row => !row.hasHigherSeason) : rows;
  const completedCount = listedRows.filter(row => row.completed === true).length;
  const visibleRows = listedRows.filter(row => filter === 'all' || (row.completed === true) === (filter === 'completed'));

  const savePreferences = next => {
    setPreferences(next);
    try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next)); }
    catch { setStatus('本次选择已生效，但未能保存；重启后可能恢复默认。'); }
  };

  const load = async () => {
    const version = ++request.current;
    try {
      const result = await window.electronAPI.getWatchHistory();
      if (version !== request.current) return;
      if (!result?.success) throw new Error(result?.error || '观看记录加载失败');
      setRows(result.results || []);
      setError('');
    } catch (failure) {
      if (version === request.current) setError(failure.message || '观看记录加载失败，请重试');
    } finally { if (version === request.current) setLoading(false); }
  };

  useLayoutEffect(() => {
    setOpening(''); openingRef.current = false;
    return () => { openingRequest.current++; openingRef.current = false; };
  }, [active]);
  useEffect(() => {
    if (active) load();
    return () => { request.current++; };
  }, [active]);
  useEffect(() => window.electronAPI.onWatchHistoryUpdated?.(() => { if (active) load(); }), [active]);
  useEffect(() => window.electronAPI.onWatchHistoryProgress?.(data => { if (active) setProgress(data); }), [active]);

  const checkUpdates = async () => {
    setChecking(true); setStatus(''); setError(''); setProgress(null);
    try {
      const result = await window.electronAPI.refreshWatchHistory({ scope });
      if (!result?.success) throw new Error(result?.error || '检查失败，请重试');
      await load();
      setStatus(`已检查 ${result.checked} 部${result.failed ? `，${result.failed} 部未完成，可稍后重试` : ''}${result.remaining ? `；本次预算内还有 ${result.remaining} 部，点击继续检查` : ''}`);
    } catch (failure) { setError(failure.message || '检查失败，请重试'); }
    finally { setChecking(false); setProgress(null); }
  };

  const checkRow = async (row) => {
    if (checking || checkingRow) return;
    setCheckingRow(row.series_id); setStatus(''); setError('');
    try {
      const result = await window.electronAPI.checkWatchHistoryItem(row.series_id);
      if (!result?.success) throw new Error(result?.error || '检查失败，请重试');
      await load();
      setStatus(result.error
        ? `《${row.series_title}》分集已检查；续作检查未完成：${result.error}`
        : `《${row.series_title}》${result.checked ? '已检测完成' : '没有可更新的记录'}。`);
    } catch (failure) {
      await load();
      setError(failure.message || '检查失败，请重试');
    }
    finally { setCheckingRow(''); }
  };

  const remove = async (row) => {
    setRemoving(row.series_id); setError(''); setStatus('');
    try {
      const result = await window.electronAPI.removeWatchHistory(row.series_id);
      if (!result?.success) throw new Error(result?.error || '移除失败，请重试');
      setRows(current => current.filter(item => item.series_id !== row.series_id));
      setStatus(`已移除《${row.series_title}》的观看记录，视频文件不受影响。`);
      void load();
    } catch (failure) { setError(failure.message || '移除失败，请重试'); }
    finally { setRemoving(''); }
  };

  const resume = async (row, sequel = null) => {
    if (!active || openingRef.current) return;
    const version = ++openingRequest.current;
    openingRef.current = true;
    setOpening(row.series_id); setError('');
    try {
      if (sequel) {
        let result = await window.electronAPI.playSeries({ seriesId: sequel.series_id, vidIndex: 1 });
        if (!result?.success && version !== openingRequest.current) return;
        if (!result?.success && result?.code === 'SERIES_NOT_FOUND') {
          const detail = await window.electronAPI.searchResolve(sequel.series_id);
          if (version !== openingRequest.current) return;
          if (!detail?.success) throw new Error(detail?.error || '续作详情暂不可用');
          const episode = detail.data?.episodes?.find(item => !item.locked);
          if (!episode) throw new Error('续作暂时没有可播放的分集');
          result = await window.electronAPI.playSeries({ seriesId: sequel.series_id, vidIndex: episode.vid_index });
        }
        if (!result?.success) throw new Error(result?.error || '打开播放器失败');
      } else {
        const result = await window.electronAPI.playSeries({ seriesId: row.series_id, vidIndex: row.vid_index, resume: true });
        if (!result?.success) throw new Error(result?.error || '打开播放器失败');
      }
      // An unconfirmed title match must not clear the original show's update markers.
      if (sequel && row.similarSeries?.some(item => item.series_id === sequel.series_id)) return;
      const acknowledged = await window.electronAPI.acknowledgeWatchUpdates(row.series_id, { total: row.total, sequelIds: (row.sequels || []).map(item => item.series_id) });
      if (!acknowledged?.success) throw new Error(acknowledged?.error || '更新标记保存失败');
      if (version === openingRequest.current) setRows(current => current.map(item => item.series_id === row.series_id ? { ...item, hasUpdates: false, unreadEpisodes: 0 } : item));
    } catch (failure) { if (version === openingRequest.current) setError(failure.message || '打开失败，请重试'); }
    finally { if (version === openingRequest.current) { setOpening(''); openingRef.current = false; } }
  };

  const emptyTitle = hideLowSeasons
    ? filter === 'completed' ? '最高季里没有已看完的短剧' : '最高季里没有未看完的短剧'
    : filter === 'completed' ? '还没有已看完的短剧' : '没有未看完的短剧';

  return <section className="history-container" aria-labelledby="history-title">
    <div className="history-header">
      <div><h1 id="history-title">观看记录</h1><p>继续上次的故事。记录仅保存在这台电脑。</p></div>
      <div className="history-tools">
        <select className="history-scope" value={scope} onChange={event => savePreferences({ ...preferences, scope: event.target.value })} disabled={checking || !!checkingRow || loading} aria-label="批量检测范围">
          <option value="all">全部记录</option>
          <option value="latest">仅最高季</option>
          <option value="unfinished">仅未看完</option>
          <option value="skip-completed-low">排除已看完低季</option>
        </select>
        <button className="btn btn-outline" onClick={checkUpdates} disabled={checking || !!checkingRow || loading || !rows.length}>
          <RefreshCw size={15} className={checking ? 'spin' : ''} />{checking ? '正在检查更新…' : '检查更新'}
        </button>
      </div>
    </div>
    <p className="history-hint">运行期间自动检查新集；同一部剧的多个季会共用一次续作搜索，已看完的低季每 24 小时检测一次。不同剧号的新一季标为“疑似续作”。可在设置中关闭检测或开启系统通知。</p>
    <div className="history-filter-bar">
      <div className="history-filter" role="group" aria-label="观看进度筛选">
        {[
          ['all', '全部', listedRows.length],
          ['unfinished', '未看完', listedRows.length - completedCount],
          ['completed', '已看完', completedCount],
        ].map(([value, label, count]) => <button key={value} type="button" aria-pressed={filter === value} disabled={loading} onClick={() => setFilter(value)}>{label} {count}</button>)}
      </div>
      <label className="history-display-option" title="只调整当前列表；批量检测范围不变，也不会删除记录">
        <input type="checkbox" checked={hideLowSeasons} disabled={loading} onChange={event => savePreferences({ ...preferences, hideLowSeasons: event.target.checked })} />
        <span>隐藏同剧低季</span>
      </label>
    </div>
    <p className="history-hint">按当前最后一集的片尾进度判断；隐藏低季后，计数仅代表列表中的季，旧记录可能显示未看完。</p>
    {error && <div className="history-error" role="alert"><span>{error}</span><button className="btn btn-outline btn-sm" onClick={load}>重新加载</button></div>}
    {status && <p className="history-hint" role="status">{status}</p>}
    {checking && progress?.total > 0 && <p className="history-hint" role="status">
      正在检查 {(progress.checked || 0) + (progress.failed || 0) + (progress.skipped || 0)} / {progress.total}{progress.current ? `：${progress.current}` : ''}
    </p>}
    {loading ? <p role="status">正在读取观看记录…</p> : !rows.length ? <div className="history-empty">
      <Clock size={30} /><h2>还没有观看记录</h2><p>真正开始播放后，短剧和进度会出现在这里。</p>
      <button className="btn btn-primary" onClick={() => onNavigate?.('browse')}>去发现短剧</button>
    </div> : !visibleRows.length ? <div className="history-empty" role="status">
      <Clock size={30} /><h2>{emptyTitle}</h2>
      <button type="button" className="btn btn-outline" onClick={() => setFilter('all')}>查看全部</button>
    </div> : <ul className="history-list">{visibleRows.map(row => <li className="history-row" key={row.series_id}>
      <div className="history-main">
      <button className="history-resume" onClick={() => resume(row)} disabled={!active || !!opening || !!removing} aria-label={`继续观看 ${row.series_title} 第${row.vid_index}集${row.hasUpdates ? `，有更新${row.unreadEpisodes ? `，新增${row.unreadEpisodes}集` : '，发现疑似续作'}` : ''}`}>
        {row.cover ? <img className="history-cover" src={row.cover} alt="" loading="lazy" /> : <span className="history-cover history-cover-empty"><Play size={20} /></span>}
        <span className="history-copy">
          <span className="history-name">{row.hasUpdates && <span className="history-dot" role="img" aria-label="有更新" />}{row.series_title}</span>
          <span className="history-progress">看到第 {row.vid_index} 集 / 共 {row.total} 集 · {Math.floor((row.currentTime || 0) / 60)}:{String(Math.floor((row.currentTime || 0) % 60)).padStart(2, '0')}</span>
          <span className="history-time">最近观看 {new Date(row.updatedAt).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })}</span>
          {row.unreadEpisodes > 0 && <span className="history-update">新增 {row.unreadEpisodes} 集</span>}
        </span>
        <span className="history-action"><Play size={15} />{opening === row.series_id ? '打开中…' : '继续观看'}</span>
      </button>
      <div className="history-row-actions">
        <button type="button" className="btn btn-outline btn-sm history-check" disabled={checking || !!checkingRow || !!removing || !!opening} aria-label={`检测《${row.series_title}》的更新`} title="只检测这一条观看记录" onClick={() => checkRow(row)}>
          <RefreshCw size={14} className={checkingRow === row.series_id ? 'spin' : ''} />{checkingRow === row.series_id ? '检测中…' : '检测'}
        </button>
        <button type="button" className="btn btn-outline btn-sm history-remove" disabled={!!removing || !!opening || !!checkingRow} aria-label={`移除观看记录《${row.series_title}》`} title="仅移除观看记录，不删除视频文件" onClick={() => remove(row)}>{removing === row.series_id ? '移除中…' : '移除'}</button>
      </div>
      </div>
      {!!row.sequels?.length && <div className="history-sequels"><span>疑似续作</span>{row.sequels.map(sequel => <button key={sequel.series_id} className="btn btn-outline btn-sm" disabled={!active || !!opening || !!removing} onClick={() => resume(row, sequel)}>{sequel.series_title}</button>)}</div>}
      {!!row.similarSeries?.length && <div className="history-sequels" title="名称相近，仅供核对；不会用于隐藏低季或批量归组">
        <span>疑似同剧（仅提示）</span>{row.similarSeries.map(candidate => <button key={candidate.series_id} className="btn btn-outline btn-sm" disabled={!active || !!opening || !!removing} onClick={() => resume(row, candidate)}>{candidate.series_title}</button>)}
      </div>}
      {row.lastEpisodeCheckError && <p className="history-check-error">分集更新检查未完成：{row.lastEpisodeCheckError}</p>}
      {row.lastSequelCheckError && <p className="history-check-error">续作检查未完成：{row.lastSequelCheckError}</p>}
      {!row.lastEpisodeCheckError && !row.lastSequelCheckError && row.lastCheckError && <p className="history-check-error">更新检查未完成：{row.lastCheckError}</p>}
    </li>)}</ul>}
  </section>;
}
