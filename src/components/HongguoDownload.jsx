import { t, useLanguage } from '../i18n';
import React, { useState, useRef, useEffect } from 'react';
import './HongguoDownload.css';
import { Film, Download, CheckSquare, Square, RefreshCw, Folder, Link2, Search, Play } from './icons';
import SearchPanel from './SearchPanel';
import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { isSubmitKey, parseEpisodeRange } from './episodeRange';


function HongguoDownload({ onNavigate, active = true }) {
  useLanguage();
  const mobile = window.electronAPI.platform === 'android';
  const { sources: mediaSources, revision: sourceRevision } = useMediaSources();
  const [tab, setTab] = useState('search'); // 'search' | 'input'
  const [inputUrl, setInputUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // 短剧解析结果
  const [seriesData, setSeriesData] = useState(null); // { series_id, series_title, cover, total, episodes: [...] }
  const [publicIntro, setPublicIntro] = useState(null);
  const [introExpanded, setIntroExpanded] = useState(false);
  const seriesDescription = [seriesData?.description, seriesData?.intro, seriesData?.series_intro]
    .find(value => typeof value === 'string' && value.trim())?.trim() || '';
  const description = seriesDescription || (publicIntro?.seriesId === seriesData?.series_id ? publicIntro?.description : '') || '';
  const [selectedVids, setSelectedVids] = useState(new Set());
  const [rangeInput, setRangeInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [exportKinds, setExportKinds] = useState({ danmaku: false, comments: false, reviews: false });
  const [exportNote, setExportNote] = useState('');
  const [exportSettingsNote, setExportSettingsNote] = useState('');
  const exportInitialized = useRef(false);
  const textExportRequest = useRef(null);
  const seriesIdRef = useRef(null);
  seriesIdRef.current = seriesData?.series_id;
  const [downloadQuality, setDownloadQuality] = useState('auto');
  const [qualityLoading, setQualityLoading] = useState(true);
  const [openingPlayer, setOpeningPlayer] = useState(false);
  const playPending = useRef(false);
  const firstPlayable = seriesData?.episodes.find((ep) => !ep.locked);
  // 评论/弹幕/剧评仅红果来源可取（取数函数都以纯数字 ID 为前置校验）；其它来源隐藏导出勾选。
  const isHongguoSource = /^\d{6,30}$/.test(String(seriesData?.series_id || ''));
  const resolveRequest = useRef(0);
  const pendingResolve = useRef(null);
  const searchVersion = resolveRequest.current;

  useEffect(() => {
    setIntroExpanded(false);
    setPublicIntro(null);
    if (!seriesData || seriesDescription || !/^\d{6,30}$/.test(String(seriesData.series_id))) return;
    let cancelled = false;
    const seriesId = seriesData.series_id;
    setPublicIntro({ seriesId, loading: true });
    Promise.resolve().then(() => window.electronAPI.getPublicDetails(seriesId)).then(data => {
      if (cancelled) return;
      const intro = data?.success && String(data.series_id) === String(seriesId) && typeof data.description === 'string' ? data.description.trim() : '';
      setPublicIntro({ seriesId, description: intro, loading: false, failed: !data?.success });
    }).catch(() => {
      if (!cancelled) setPublicIntro({ seriesId, loading: false, failed: true });
    });
    return () => { cancelled = true; };
  }, [seriesData, seriesDescription]);

  useEffect(() => () => { resolveRequest.current++; }, []);
  useEffect(() => { if (!active) { resolveRequest.current++; playPending.current = false; } }, [active]);
  useEffect(() => {
    resolveRequest.current++; pendingResolve.current = null; setLoading(false);
    setSeriesData(current => current?.series_id?.startsWith('custom:') ? null : current);
  }, [sourceRevision]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setQualityLoading(true);
    window.electronAPI.getSettings().then((settings) => {
      if (!cancelled) setDownloadQuality(['1080p', '720p'].includes(settings?.download_quality) ? settings.download_quality : 'auto');
      if (!cancelled && !exportInitialized.current) {
        const et = settings?.export_text || {};
        setExportKinds({ danmaku: et.danmaku === true, comments: et.comments === true, reviews: et.reviews === true });
        exportInitialized.current = true;
      }
    }).catch(() => {
      if (!cancelled) setErrorMsg('默认下载清晰度读取失败，请确认清晰度后再下载');
    }).finally(() => { if (!cancelled) setQualityLoading(false); });
    return () => { cancelled = true; };
  }, [active]);

  // 文字导出转为后台任务，完成后经 text-export-done 事件回报；本订阅只更新提示文案，不阻塞下载。
  useEffect(() => {
    const off = window.electronAPI?.onTextExportDone?.((data) => {
      const request = textExportRequest.current;
      if (!data || !request || request.done || data.requestId !== request.requestId
        || String(data.seriesId) !== String(request.seriesId)
        || String(data.seriesId) !== String(seriesIdRef.current)) return;
      request.done = true;
      const k = request.kinds;
      const part = (key, label) => k[key] && data[key]
        ? `${label} ${data[key].ok} 份${Number.isFinite(data[key].items) ? `，${data[key].items} 条` : ''}${data[key].empty ? `（空数据${data[key].empty}份）` : ''}${data[key].skipped ? `（跳过${data[key].skipped}）` : ''}${data[key].unavailable ? `，来源未开放${data[key].unavailable}集（未生成文件）` : ''}${data[key].fail ? `，失败${data[key].fail}` : ''}${data[key].partial ? `，部分${data[key].partial}（仅保存已获取数据）` : ''}` : null;
      const bits = [part('danmaku', '弹幕'), part('comments', '评论'), part('reviews', '剧评')].filter(Boolean);
      setExportNote(data.failed
        ? `文字导出未完成：${data.error || '未知错误'}`
        : `文字导出结果：${bits.join('、') || '无'}${(k.comments || k.reviews) ? '（评论/剧评受官网限制，仅公开可读部分）' : ''}`);
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  const clearTextExport = () => {
    textExportRequest.current = null;
    setExportNote('');
    setExportSettingsNote('');
  };

  const switchTab = (next) => {
    if (next === tab) return;
    resolveRequest.current++;
    pendingResolve.current = null;
    setLoading(false);
    setTab(next);
  };

  // 搜索选中一部剧后：复用既有的选集下载界面
  const handleSeriesFromSearch = async (data, viewDetails = false) => {
    if (searchVersion !== resolveRequest.current) return;
    if (mobile && !viewDetails) {
      if (playPending.current) return;
      const first = data.episodes.find(ep => !ep.locked);
      if (!first) throw new Error('来源尚未开放可播放集数');
      playPending.current = true;
      try {
        const result = await window.electronAPI.playSeries({ seriesId: data.series_id, resume: true });
        if (!result?.success) throw new Error(result?.error || '打开播放器失败，请重试');
      } finally { playPending.current = false; }
      return;
    }
    resolveRequest.current++;
    setLoading(false);
    setRangeInput('');
    setErrorMsg('');
    setTab('input');
    setSeriesData(data);
    clearTextExport();
    setSelectedVids(new Set(data.episodes.filter((ep) => !ep.locked).map((ep) => ep.vid)));
    setSuccessMsg(`已选中《${data.series_title}》共 ${data.total} 集，可直接播放或提交下载`);
    document.querySelector('.main-content:not([hidden])')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // 解析红果短剧
  const handleResolve = async () => {
    if (!inputUrl.trim()) {
      setErrorMsg('请输入红果短剧分享链接或剧集 ID');
      return;
    }
    const value = inputUrl.trim();
    if (pendingResolve.current?.value === value) return;
    const request = ++resolveRequest.current;
    pendingResolve.current = { value, request };
    setRangeInput('');
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    setSeriesData(null);
    clearTextExport();
    setSelectedVids(new Set());

    try {
      const res = await window.electronAPI.hongguoResolve(value);
      if (request !== resolveRequest.current) return;
      if (res?.success && res.data) {
        setSeriesData(res.data);
        // 默认全选，网页未提供的集数自动尝试 App 片源。
        const allVids = new Set(res.data.episodes.filter((ep) => !ep.locked).map((ep) => ep.vid));
        setSelectedVids(allVids);
        setSuccessMsg(`解析成功！找到《${res.data.series_title}》共 ${res.data.total} 集`);
      } else {
        setErrorMsg(res?.error || '解析失败，请检查链接或网络');
      }
    } catch (err) {
      if (request === resolveRequest.current) setErrorMsg('解析过程出现错误: ' + err.message);
    } finally {
      if (pendingResolve.current?.request === request) pendingResolve.current = null;
      if (request === resolveRequest.current) setLoading(false);
    }
  };

  // 勾选/取消勾选单集
  const toggleVid = (vid) => {
    if (!seriesData?.episodes.some((ep) => ep.vid === vid && !ep.locked)) return;
    const next = new Set(selectedVids);
    if (next.has(vid)) {
      next.delete(vid);
    } else {
      next.add(vid);
    }
    setSelectedVids(next);
  };

  // 全选
  const handleSelectAll = () => {
    if (!seriesData) return;
    setSelectedVids(new Set(seriesData.episodes.filter((ep) => !ep.locked).map((ep) => ep.vid)));
  };

  // 反选
  const handleInvertSelect = () => {
    if (!seriesData) return;
    const next = new Set();
    for (const ep of seriesData.episodes) {
      if (!ep.locked && !selectedVids.has(ep.vid)) {
        next.add(ep.vid);
      }
    }
    setSelectedVids(next);
  };

  // 清空选择
  const handleDeselectAll = () => {
    setSelectedVids(new Set());
  };

  // 快捷集数选择
  const handleQuickSelect = (type) => {
    if (!seriesData || !seriesData.episodes) return;
    const eps = seriesData.episodes;
    const total = eps.length;
    let targetEps = [];
    if (type === 'first10') {
      targetEps = eps.slice(0, 10);
    } else if (type === 'first30') {
      targetEps = eps.slice(0, 30);
    } else if (type === 'last30') {
      targetEps = eps.slice(Math.max(0, total - 30));
    }
    setSelectedVids(new Set(targetEps.filter((ep) => !ep.locked).map((ep) => ep.vid)));
  };

  // 根据区间字符串应用筛选 (如 "1-30" 或 "1,5,10-20")
  const handleApplyRange = () => {
    if (!seriesData?.episodes) return;
    try {
      const nums = parseEpisodeRange(rangeInput, seriesData.episodes.length);
      setSelectedVids(new Set(seriesData.episodes.filter((ep) => !ep.locked && nums.has(ep.vid_index)).map((ep) => ep.vid)));
      setErrorMsg('');
    } catch (error) { setErrorMsg(error.message); }
  };

  const handlePlay = async () => {
    if (!seriesData || !firstPlayable || playPending.current) return;
    const request = resolveRequest.current;
    playPending.current = true;
    setOpeningPlayer(true);
    setErrorMsg('');
    try {
      const res = await window.electronAPI.playSeries({ seriesId: seriesData.series_id, vidIndex: firstPlayable.vid_index });
      if (!res?.success && request === resolveRequest.current) setErrorMsg(res?.error || '打开播放器失败，请重试');
    } catch (error) {
      if (request === resolveRequest.current) setErrorMsg('打开播放器失败: ' + error.message);
    } finally {
      playPending.current = false;
      setOpeningPlayer(false);
    }
  };

  // 提交批量下载
  const handleBatchDownload = async () => {
    if (!seriesData || selectedVids.size === 0) {
      setErrorMsg('请至少勾选一集欲下载的短剧');
      return;
    }
    const kinds = isHongguoSource ? { ...exportKinds } : { danmaku: false, comments: false, reviews: false };
    const wantExport = kinds.danmaku || kinds.comments || kinds.reviews;
    const request = { requestId: crypto.randomUUID(), seriesId: seriesData.series_id, kinds, done: !wantExport };
    textExportRequest.current = request;
    setExportNote(wantExport ? '正在后台导出文字数据…' : '');
    setExportSettingsNote('');
    setSubmitting(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const selectedEps = seriesData.episodes.filter((ep) => !ep.locked && selectedVids.has(ep.vid));
      const res = await window.electronAPI.hongguoDownloadBatch({
        seriesId: seriesData.series_id,
        seriesTitle: seriesData.series_title,
        episodes: selectedEps,
        quality: downloadQuality,
        export: kinds,
        requestId: request.requestId,
      });
      const isCurrent = () => textExportRequest.current === request && seriesIdRef.current === request.seriesId;
      if (res.success) {
        if (isHongguoSource) {
          // 偏好保存失败不改变已提交的视频任务或后台导出结果。
          Promise.resolve().then(() => window.electronAPI.saveSettings({ export_text: kinds })).then(saved => {
            if (!saved?.success) throw new Error(saved?.error || '请稍后重试');
          }).catch(error => {
            if (isCurrent()) setExportSettingsNote(`导出选项未保存：${error.message || '请稍后重试'}；本次视频已提交，文字导出不受影响。`);
          });
        }
        if (isCurrent()) setSuccessMsg(`已成功将 ${res.count} 集提交至下载队列！点击下方按钮跳转至“下载管理”查看实时进度。`);
      } else if (isCurrent()) {
        textExportRequest.current = null;
        setExportNote('');
        setErrorMsg(res.error || '提交下载失败');
      }
    } catch (err) {
      if (textExportRequest.current === request && seriesIdRef.current === request.seriesId) {
        textExportRequest.current = null;
        setExportNote('');
        setErrorMsg('提交下载异常: ' + err.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="hongguo-container">
      {/* 头部 Banner 区 */}
      <div className="hongguo-hero">
        <div className="hero-icon">
          <Film size={32} />
        </div>
        <div className="hero-text">
          <h2>{t("找到下一部好剧")}</h2>
          <p>{t(mobile ? '搜到就能看，也可单独查看详情、选择下载。' : '搜一个剧名，或粘贴分享链接。选择喜欢的集数，保存到本地慢慢看。')}</p>
        </div>
      </div>

      {/* 方式切换 */}
      <div className="mode-tabs">
        <button
          className={`mode-tab ${tab === 'search' ? 'active' : ''}`}
          onClick={() => switchTab('search')}
        >
          <Search size={16} />
          <span>{t("搜索剧集")}</span>
        </button>
        <button
          className={`mode-tab ${tab === 'input' ? 'active' : ''}`}
          onClick={() => switchTab('input')}
        >
          <Link2 size={16} />
          <span>{t("粘贴链接 / ID")}</span>
        </button>
      </div>

      <div hidden={tab !== 'search'}>
        <SearchPanel
          active={active && tab === 'search'}
          onSelectSeries={handleSeriesFromSearch}
          onViewSeries={mobile ? data => handleSeriesFromSearch(data, true) : undefined}
          onSwitchToInput={() => switchTab('input')}
        />
      </div>
      {tab === 'input' && (
        /* 解析输入卡片 */
        <div className="hongguo-card">
          <div className="card-header-title">
            <Link2 size={18} />
            <span>{t("输入短剧链接或 ID")}</span>
          </div>
          <div className="input-group">
            <input
              type="text"
              className="input-field"
              aria-label={t("短剧分享链接或剧集 ID")}
              placeholder={t("粘贴短剧分享链接，或输入剧集 ID")}
              value={inputUrl}
              onChange={(e) => { resolveRequest.current++; pendingResolve.current = null; setLoading(false); setInputUrl(e.target.value); }}
              onKeyDown={(e) => isSubmitKey(e) && handleResolve()}
            />
            <button className="btn btn-outline" disabled={loading} onClick={async () => {
              try {
                const text = (await navigator.clipboard.readText()).trim();
                if (!text || text.length > 4096) throw new Error('剪贴板为空或内容过长，请手动粘贴短剧链接');
                resolveRequest.current++;
                pendingResolve.current = null;
                setInputUrl(text);
                setErrorMsg('');
                setSuccessMsg('已粘贴，请确认链接后获取剧集');
              } catch (error) { setErrorMsg(error.message || '读取剪贴板失败，请手动粘贴'); }
            }}>{t("粘贴链接")}</button>
            <button className="btn btn-primary" onClick={handleResolve} disabled={loading}>
              {loading ? (
                <>
                  <RefreshCw size={16} className="spin" />
                  <span>{t("解析中...")}</span>
                </>
              ) : (
                <>
                  <Film size={16} />
                  <span>{t("获取剧集")}</span>
                </>
              )}
            </button>
          </div>

          {errorMsg && <div className="alert alert-error" role="alert">{t(errorMsg)}</div>}
          {successMsg && <div className="alert alert-success" role="status">{t(successMsg)}</div>}
        </div>
      )}

      {/* 搜索模式下的提示信息（解析卡片被替换了，这里单独显示） */}
      {tab === 'search' && (errorMsg || successMsg) && (
        <div className="hongguo-card" style={{ marginTop: 0 }}>
          {errorMsg && <div className="alert alert-error" role="alert">{t(errorMsg)}</div>}
          {successMsg && <div className="alert alert-success" role="status">{t(successMsg)}</div>}
        </div>
      )}

      {/* 剧集列表与选择控制 */}
      {seriesData && (
        <div className="hongguo-card episode-section">
          {/* 短剧元信息 */}
          <div className="series-header">
            <div className="series-info">
              {seriesData.cover ? (
                <img src={seriesData.cover} alt={seriesData.series_title} className="series-cover" />
              ) : (
                <div className="series-cover-placeholder">
                  <Film size={28} />
                </div>
              )}
              <div className="series-meta">
                <h3 className="series-title">《{seriesData.series_title}》</h3>
                <div className="series-tags">
                  <span className="badge">{mediaSourceLabel(seriesData.series_id, mediaSources)}</span>
                  <span className="badge">{t("共 ")}{t(seriesData.total)}{t(" 集")}</span>
                  <span className="badge badge-secondary">{t("已选 ")}{t(selectedVids.size)}{t(" 集")}</span>
                </div>
                <div className="series-description">
                  <h4>{t("剧情简介")}</h4>
                  {description ? <>
                    <p id="series-description-text">{introExpanded || description.length <= 120 ? description : `${description.slice(0, 120).trimEnd()}…`}</p>
                    {description.length > 120 && <button type="button" className="btn-chip" aria-expanded={introExpanded}
                      aria-controls="series-description-text" onClick={() => setIntroExpanded(value => !value)}>
                      {t(introExpanded ? '收起简介' : '展开简介')}
                    </button>}
                  </> : <p role="status">{t(publicIntro?.seriesId === seriesData.series_id && publicIntro.loading ? '简介加载中…'
                    : publicIntro?.seriesId === seriesData.series_id && publicIntro.failed ? '简介暂未获取，请稍后重新打开剧集。' : '当前来源暂无剧情简介')}</p>}
                </div>
              </div>
            </div>

            <div className="batch-action-bar">
              <div className="batch-action-row">
                <button className="btn btn-outline" onClick={handlePlay}
                  disabled={openingPlayer || !firstPlayable}
                  title={t(firstPlayable ? '在我的剧库播放，未下载的分集会在线播放' : '当前剧集没有可播放的分集')}>
                  {openingPlayer ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}
                  <span>{t(openingPlayer ? '正在打开…' : '立即播放')}</span>
                </button>
                <label className="batch-quality-control">
                  <span>{t("下载清晰度")}</span>
                  <select className="input-field" value={downloadQuality}
                    aria-describedby="batch-quality-hint" disabled={qualityLoading || submitting}
                    onChange={(event) => setDownloadQuality(event.target.value)}>
                    <option value="auto">{t("自动（兼容优先）")}</option>
                    <option value="1080p">1080P</option>
                    <option value="720p">720P</option>
                  </select>
                </label>
                <button
                  className="btn btn-primary"
                  onClick={handleBatchDownload}
                  disabled={qualityLoading || submitting || selectedVids.size === 0}
                >
                  <Download size={16} />
                  <span>{t("下载选中集数 (")}{t(selectedVids.size)}/{t(seriesData.total)})</span>
                </button>
                {onNavigate && (
                  <button className="btn btn-outline" onClick={() => onNavigate('manager')}>
                    <Folder size={16} />
                    <span>{t("查看下载管理")}</span>
                  </button>
                )}
              </div>
              {isHongguoSource && (
                <div className="batch-export-controls" role="group" aria-label={t("随下载导出的文字数据")}>
                  <span className="batch-export-title">{t("随下载导出")}</span>
                  {[['danmaku', '弹幕'], ['comments', '评论'], ['reviews', '剧评']].map(([key, label]) => (
                    <label key={key} className="batch-export-check">
                      <input type="checkbox" aria-label={t(label)} checked={exportKinds[key]}
                        disabled={qualityLoading || submitting}
                        onChange={(event) => setExportKinds(prev => ({ ...prev, [key]: event.target.checked }))} />
                      <span>{t(label)}</span>
                    </label>
                  ))}
                  {exportNote && <span className="batch-export-note" role="status">{t(exportNote)}</span>}
                  {exportSettingsNote && <span className="batch-export-note" role="alert">{t(exportSettingsNote)}</span>}
                </div>
              )}
            </div>
          </div>

          <p className="settings-hint batch-quality-hint" id="batch-quality-hint">{t("新建下载任务生效；红果片源所选清晰度不可用或下载失败时，自动尝试更低清晰度，并在下载管理中提示。已有文件不自动删除或覆盖。")}</p>

          {seriesData.web_accessible_episodes != null && seriesData.web_accessible_episodes < seriesData.total && (
            <p className="settings-hint">{t("网页源提供前 ")}{t(seriesData.web_accessible_episodes)}{t(" 集，后续集数自动尝试 App 片源。")}</p>
          )}

          {seriesData.episodes.some((ep) => ep.locked) && <p className="settings-hint">{t("锁定集需在来源平台解锁，本应用不提供解锁；全选和范围选择会自动跳过。")}</p>}

          {/* 筛选与操作栏 */}
          <div className="controls-row">
            <div className="select-buttons">
              <button className="btn-chip" onClick={handleSelectAll}>{t("全选")}</button>
              <button className="btn-chip" onClick={handleInvertSelect}>{t("反选")}</button>
              <button className="btn-chip" onClick={handleDeselectAll}>{t("取消全选")}</button>
              <span className="divider"></span>
              <button className="btn-chip" onClick={() => handleQuickSelect('first10')}>{t("前 10 集")}</button>
              <button className="btn-chip" onClick={() => handleQuickSelect('first30')}>{t("前 30 集")}</button>
              <button className="btn-chip" onClick={() => handleQuickSelect('last30')}>{t("后 30 集")}</button>
            </div>

            <div className="range-filter">
              <span className="range-label">{t("范围筛选:")}</span>
              <input
                type="text"
                className="range-input"
                aria-label={t("选择集数范围")}
                placeholder={t("如 1-30 或 1,5,10")}
                value={rangeInput}
                onChange={(e) => setRangeInput(e.target.value)}
                onKeyDown={(e) => isSubmitKey(e) && handleApplyRange()}
              />
              <button className="btn-chip btn-chip-primary" onClick={handleApplyRange}>{t("应用")}</button>
            </div>
          </div>

          {/* 剧集网格列表 */}
          <div className="episode-grid">
            {seriesData.episodes.map((ep) => {
              const isChecked = selectedVids.has(ep.vid);
              return (
                <button
                  type="button"
                  disabled={ep.locked === true}
                  title={t(ep.locked ? '需在来源平台解锁' : undefined)}
                  aria-pressed={isChecked}
                  key={ep.vid}
                  className={`episode-card ${isChecked ? 'selected' : ''}`}
                  onClick={() => toggleVid(ep.vid)}
                >
                  <div className="checkbox-icon">
                    {isChecked ? <CheckSquare size={18} className="icon-checked" /> : <Square size={18} className="icon-unchecked" />}
                  </div>
                  <div className="episode-info">
                    <span className="episode-num">{t("第 {0} 集", [String(ep.vid_index).padStart(2, '0')])}</span>
                    {t(ep.locked ? <span className="episode-title">{t("锁定 · 需在来源解锁")}</span> : ep.title && <span className="episode-title">{ep.title}</span>)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default HongguoDownload;
