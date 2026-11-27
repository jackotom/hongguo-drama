import React, { useEffect, useRef, useState } from 'react';
import { t, useLanguage } from '../i18n';
import { Play, Download, Check, X } from './icons';
import './SeriesDrawer.css';

/**
 * 分集抽屉：查看某部剧的分集、选集播放与批量下载。
 *
 * 与「发现短剧」页 Browse.jsx 里的抽屉功能一致，但独立实现，便于
 * 在账号页（观看记录 / 官方收藏夹）复用而改动 Browse 的既有逻辑。
 *
 * 只依赖三个通用 IPC：
 *   searchResolve(seriesId)          拉分集并写入剧集注册表（playSeries 依赖它）
 *   getSeriesEpisodes(seriesId)      读本机已下载状态
 *   hongguoDownloadBatch({...})      批量入队下载
 * 三者都只认剧号，与来源无关，因此红果官方收藏/观看记录的剧号可直接使用。
 */
export default function SeriesDrawer({
  seriesId,
  seriesTitle = '',
  onClose,
  onToast,
  defaultSelect = 'undownloaded',
}) {
  useLanguage();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [opening, setOpening] = useState(false);
  const request = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current++; };
  }, []);

  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!seriesId) return;
    const version = ++request.current;
    setLoading(true); setError(''); setDetail(null);
    setSelected(new Set()); setRangeInput(''); setRangeError('');
    (async () => {
      try {
        const res = await window.electronAPI.searchResolve(seriesId);
        if (version !== request.current || !alive.current) return;
        if (!res?.success) throw new Error(res?.error || '拉取分集失败');
        const data = res.data;
        // 合并本机已下载状态；拿不到就当作未知，不影响选集。
        let statusMap = {};
        try {
          const epRes = await window.electronAPI.getSeriesEpisodes(seriesId);
          if (version !== request.current || !alive.current) return;
          if (epRes?.success) for (const ep of epRes.data.episodes) statusMap[ep.vid_index] = ep;
        } catch { /* 状态读取失败不阻断选集 */ }
        const episodes = (data.episodes || []).map(ep => ({
          ...ep,
          status: statusMap[ep.vid_index]?.status || 'missing',
        }));
        setDetail({ ...data, episodes });
        const picked = defaultSelect === 'all'
          ? episodes.filter(ep => !ep.locked)
          : episodes.filter(ep => !ep.locked && ep.status !== 'completed');
        setSelected(new Set(picked.map(ep => ep.vid_index)));
      } catch (failure) {
        if (version === request.current && alive.current) setError(failure.message || '打开失败，请重试');
      } finally {
        if (version === request.current && alive.current) setLoading(false);
      }
    })();
  }, [seriesId, defaultSelect]);

  const toggle = index => {
    if (!detail?.episodes.some(ep => ep.vid_index === index && !ep.locked)) return;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  // 支持 "1-50" / "1,3,5" / "前10" 这类写法之外的纯区间与列表。
  const applyRange = () => {
    if (!detail) return;
    const text = rangeInput.trim();
    if (!text) { setRangeError('请输入集数范围'); return; }
    const picked = new Set();
    const total = detail.episodes.length;
    try {
      for (const part of text.split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const match = /^(\d+)\s*[-~]\s*(\d+)$/.exec(piece);
        if (match) {
          const start = Number(match[1]), end = Number(match[2]);
          if (!start || !end || start > end) throw new Error('区间写法不正确');
          for (let i = start; i <= end; i++) if (i >= 1 && i <= total) picked.add(i);
        } else if (/^\d+$/.test(piece)) {
          const value = Number(piece);
          if (value >= 1 && value <= total) picked.add(value);
        } else throw new Error('只支持 1-50 或 1,3,5 这样的写法');
      }
    } catch (failure) { setRangeError(failure.message); return; }
    const usable = detail.episodes.filter(ep => !ep.locked && picked.has(ep.vid_index));
    if (!usable.length) { setRangeError('所选范围内没有可下载的分集'); return; }
    setSelected(new Set(usable.map(ep => ep.vid_index)));
    setRangeError('');
  };

  const play = async (index) => {
    if (opening) return;
    const target = index || detail?.episodes.find(ep => !ep.locked)?.vid_index;
    if (!target) { onToast?.('这部剧暂无可播放的分集', 'error'); return; }
    setOpening(true);
    try {
      const result = await window.electronAPI.playSeries({ seriesId, vidIndex: target, resume: false });
      if (!result?.success) throw new Error(result?.error || '打开播放器失败');
      onClose?.();
    } catch (failure) {
      onToast?.('打开失败：' + (failure.message || '请重试'), 'error');
    } finally { if (alive.current) setOpening(false); }
  };

  const download = async () => {
    if (!detail || !selected.size || submitting) return;
    const episodes = detail.episodes.filter(ep => !ep.locked && selected.has(ep.vid_index));
    if (!episodes.length) return;
    setSubmitting(true);
    try {
      const result = await window.electronAPI.hongguoDownloadBatch({
        seriesId: detail.series_id,
        seriesTitle: detail.series_title || seriesTitle,
        episodes,
      });
      if (result?.success) {
        onToast?.(`已加入下载队列：${result.count} 集`);
        onClose?.();
      } else {
        throw new Error(result?.error || '加入下载队列失败');
      }
    } catch (failure) {
      onToast?.('下载失败：' + (failure.message || '请重试'), 'error');
    } finally { if (alive.current) setSubmitting(false); }
  };

  const completed = detail ? detail.episodes.filter(ep => ep.status === 'completed').length : 0;
  const locked = detail ? detail.episodes.filter(ep => ep.locked).length : 0;

  return <div className="sd-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose?.(); }}>
    <div className="sd-panel" role="dialog" aria-modal="true" aria-label={t('分集与下载')}>
      <header className="sd-head">
        <div className="sd-head-main">
          <h2>{detail?.series_title || seriesTitle || t('正在读取…')}</h2>
          {detail && <p className="sd-sub">
            {t('共 {0} 集', [detail.episodes.length])}
            {completed > 0 && <> · {t('已下载 {0} 集', [completed])}</>}
            {locked > 0 && <> · {t('锁定 {0} 集', [locked])}</>}
          </p>}
        </div>
        <button className="sd-close" type="button" onClick={() => onClose?.()} aria-label={t('关闭')}><X size={18} /></button>
      </header>

      <div className="sd-body">
        {loading && <div className="sd-state" role="status">{t('正在读取分集…')}</div>}
        {!loading && error && <div className="sd-state sd-error" role="alert">
          <span>{t(error)}</span>
          <button className="btn btn-outline btn-sm" type="button" onClick={() => { setLoading(true); setError(''); request.current++; }}>{t('重试')}</button>
        </div>}
        {!loading && !error && detail && <>
          <div className="sd-range">
            <input
              type="text"
              className="input-field"
              aria-label={t('选择集数范围')}
              placeholder={t('区间，如 1-50 或 1,3,5')}
              value={rangeInput}
              onChange={event => { setRangeInput(event.target.value); setRangeError(''); }}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyRange(); } }}
            />
            <button className="btn btn-outline btn-sm" type="button" onClick={applyRange}>{t('应用')}</button>
          </div>
          {rangeError && <p className="sd-range-error" role="alert">{t(rangeError)}</p>}
          <div className="sd-presets">
            <button className="btn-chip" type="button" onClick={() => setSelected(new Set(detail.episodes.filter(ep => !ep.locked && ep.vid_index <= 10).map(ep => ep.vid_index)))}>{t('前10集')}</button>
            <button className="btn-chip" type="button" onClick={() => setSelected(new Set(detail.episodes.filter(ep => !ep.locked && ep.vid_index <= 30).map(ep => ep.vid_index)))}>{t('前30集')}</button>
            <button className="btn-chip" type="button" onClick={() => setSelected(new Set(detail.episodes.filter(ep => !ep.locked).map(ep => ep.vid_index)))}>{t('全选')}</button>
            <button className="btn-chip" type="button" onClick={() => setSelected(new Set())}>{t('清空')}</button>
            <span className="sd-picked">{t('已选 {0} 集', [selected.size])}</span>
          </div>
          <div className="sd-eps">
            {detail.episodes.map(ep => (
              <button
                key={ep.vid_index}
                type="button"
                disabled={ep.locked === true}
                aria-pressed={selected.has(ep.vid_index)}
                aria-label={ep.locked ? t('第 {0} 集，需在来源平台解锁', [ep.vid_index]) : t('第 {0} 集', [ep.vid_index])}
                title={ep.locked ? t('需在来源平台解锁') : (ep.title || t('第 {0} 集', [ep.vid_index]))}
                className={`ep-chip ep-${ep.status} ${selected.has(ep.vid_index) ? 'ep-picked' : ''}`}
                onClick={() => toggle(ep.vid_index)}
                onDoubleClick={() => { if (!ep.locked) play(ep.vid_index); }}
              >
                <span className="ep-num">{t(ep.vid_index)}</span>
                {ep.locked && <span className="ep-lock-label">{t('锁定')}</span>}
                {ep.status === 'completed' && <Check size={11} className="ep-badge" />}
                {selected.has(ep.vid_index) && <span className="ep-pick-dot" />}
              </button>
            ))}
          </div>
        </>}
      </div>

      <footer className="sd-foot">
        <button className="btn btn-outline" type="button" disabled={loading || !!error || opening || !detail?.episodes.some(ep => !ep.locked)} onClick={() => play()}>
          <Play size={15} />{t(opening ? '打开中…' : '立即播放')}
        </button>
        <div className="sd-foot-right">
          <span className="sd-hint">{t('双击集数可直接播放')}</span>
          <button className="btn btn-primary" type="button" disabled={submitting || loading || !!error || !selected.size} onClick={download}>
            <Download size={15} />{submitting ? t('正在入队…') : t('下载选中 ({0})', [selected.size])}
          </button>
        </div>
      </footer>
    </div>
  </div>;
}
