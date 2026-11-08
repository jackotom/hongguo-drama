import { t, useLanguage } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';

export default function SequelFinder({ seriesId, active = true, timeoutMs = 25000 }) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [partial, setPartial] = useState(false);
  const [opening, setOpening] = useState('');
  const request = useRef(0);
  const openingRef = useRef(false);
  const timer = useRef(0);
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = 0; } };

  useEffect(() => {
    request.current++;
    openingRef.current = false;
    clearTimer();
    setOpen(false); setLoading(false); setOpening(''); setResults([]); setError(''); setPartial(false);
    return () => { request.current++; openingRef.current = false; clearTimer(); };
  }, [seriesId, active]);

  const close = () => {
    request.current++;
    openingRef.current = false;
    clearTimer();
    setOpen(false); setLoading(false); setOpening('');
  };

  const find = async () => {
    if (!active || !seriesId || openingRef.current) return;
    const version = ++request.current;
    clearTimer();
    setOpen(true); setLoading(true); setError(''); setPartial(false); setResults([]);
    // 主进程查询可能因为站点页面卡住而长时间不返回；前端兜底，避免一直转圈。
    const timerId = setTimeout(() => {
      if (version !== request.current) return;
      if (timer.current === timerId) timer.current = 0;
      request.current++;
      setLoading(false);
      setError('查询超时，请稍后重试。');
    }, Math.max(1, Number(timeoutMs) || 25000));
    timer.current = timerId;
    try {
      const local = await window.electronAPI.findSeriesSequels(seriesId, { localOnly: true });
      if (version !== request.current) return;
      if (local?.success) setResults(local.results || []);
      const result = await window.electronAPI.findSeriesSequels(seriesId);
      if (version !== request.current) return;
      if (!result?.success) throw new Error(result?.error || '查询失败，请重试');
      setResults(current => {
        const merged = new Map((result.results || []).map(item => [String(item.series_id), item]));
        for (const item of current) if (!merged.has(String(item.series_id))) merged.set(String(item.series_id), item);
        return [...merged.values()];
      });
      setPartial(result.partial === true);
      setError(result.error || '');
    } catch (failure) {
      if (version === request.current) setError(failure.message || '查询失败，请重试');
    } finally {
      // 只清理本次查询自己的计时器；旧请求晚到不能打断新查询的超时保护。
      if (timer.current === timerId) { clearTimeout(timerId); timer.current = 0; }
      if (version === request.current) setLoading(false);
    }
  };

  const play = async (sequel) => {
    if (openingRef.current) return;
    openingRef.current = true;
    const version = ++request.current;
    setOpening(sequel.series_id); setLoading(false); setError('');
    try {
      let result = await window.electronAPI.playSeries({ seriesId: sequel.series_id, vidIndex: 1 });
      if (version !== request.current) return;
      if (!result?.success && result?.code === 'SERIES_NOT_FOUND') {
        const detail = await window.electronAPI.searchResolve(sequel.series_id);
        if (version !== request.current) return;
        if (!detail?.success) throw new Error(detail?.error || '续作详情暂不可用');
        const episode = detail.data?.episodes?.find(item => !item.locked);
        if (!episode) throw new Error('续作暂时没有可播放的分集');
        result = await window.electronAPI.playSeries({ seriesId: sequel.series_id, vidIndex: episode.vid_index });
        if (version !== request.current) return;
      }
      if (!result?.success) throw new Error(result?.error || '打开播放器失败，请重试');
      setOpen(false);
    } catch (failure) {
      if (version === request.current) setError(failure.message || '打开失败，请重试');
    } finally {
      if (version === request.current) { setOpening(''); openingRef.current = false; }
    }
  };

  if (!active || !seriesId) return null;
  return <section className="sequel-finder" aria-label={t("查找当前剧的下一季")}>
    <div className="sequel-finder-actions">
      <button type="button" className="btn btn-outline btn-sm" onClick={find} disabled={loading || !!opening}
        aria-expanded={open} aria-controls="sequel-finder-results">{t(loading ? '正在查找…' : open ? error ? '重试' : '重新查找' : '查找下一季')}</button>
      {open && <button type="button" className="btn btn-outline btn-sm" onClick={close}>{t("收起")}</button>}
    </div>
    {open && <div id="sequel-finder-results" className="sequel-finder-results">
      <p>{t("可能的续作，请核对剧名")}</p>
      {loading && <p role="status">{t(results.length ? '已找到本地记录，正在补充查询…' : '正在查找下一季…')}</p>}
      {error && <p className="sequel-finder-error" role="alert">{t(error)}</p>}
      {partial && <p role="status">{t("部分查询未完成，可稍后重试。")}</p>}
      {!loading && !results.length && <p role="status">{t(error || partial ? '查询未完成，暂时无法判断是否有下一季。' : '暂未找到下一季，可稍后再查。')}</p>}
      {!!results.length && <ul className="sequel-finder-list">{results.map(sequel => <li key={sequel.series_id}>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => play(sequel)} disabled={!!opening}
          aria-label={t(`播放可能的续作《${sequel.series_title}》`)}>{sequel.series_title}{t(opening === sequel.series_id ? ' · 打开中…' : '')}</button>
      </li>)}</ul>}
    </div>}
  </section>;
}
