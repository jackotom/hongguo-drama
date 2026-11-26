import React from 'react';
import { t, useLanguage } from '../i18n';
import { Film, X, Trash2, Zap } from './icons';

function SeriesPicker({
  seriesList,
  activeSeriesId,
  pickerQuery,
  setPickerQuery,
  downloadedMap,
  storageMap,
  storageTotal,
  cacheInfo,
  compatCache,
  current,
  onlineUrl,
  compatMap,
  currentIndex,
  selectedSeriesRef,
  fmtSize,
  onClose,
  onSwitchSeries,
  onConfirmAsk,
  onStopPlayback,
  onDeleteDownloadedFiles,
  onRemoveSeries,
  onClearCache,
  onClearCompatCache,
}) {
  useLanguage();
  const normalizedQuery = pickerQuery.trim().toLowerCase();
  return (
    <div className="series-picker">
      <div className="series-picker-head">
        <input
          type="text"
          className="input-field"
          aria-label={t("在我的剧库搜索")}
          placeholder={t("搜索剧名…")}
          value={pickerQuery}
          onChange={(e) => setPickerQuery(e.target.value)}
        />
        <button className="icon-btn" title={t("关闭")} onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="series-picker-list">
        {seriesList.length === 0 && <div className="series-picker-empty">{t("还没有剧集")}</div>}
        {seriesList
          .filter((s) => !normalizedQuery || (s.series_title || '').toLowerCase().includes(normalizedQuery))
          .map((s) => {
            const isActive = String(s.series_id) === String(activeSeriesId);
            const dl = downloadedMap[String(s.series_id)];
            const st = storageMap[String(s.series_id)];
            const hasFiles = st && st.files > 0;
            return (
              <div
                key={s.series_id}
                role="button"
                tabIndex={0}
                aria-label={t(`选择剧集 ${s.series_title}`)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || !['Enter', ' '].includes(e.key)) return;
                  e.preventDefault();
                  if (!isActive) onSwitchSeries(s.series_id);
                  onClose();
                }}
                className={`series-row ${isActive ? 'active' : ''}`}
                onClick={() => {
                  if (!isActive) onSwitchSeries(s.series_id);
                  onClose();
                }}
              >
                <div className="series-row-cover">
                  {s.cover ? <img src={s.cover} alt="" loading="lazy" /> : <Film size={14} />}
                </div>
                <div className="series-row-body">
                  <div className="series-row-title">{s.series_title}</div>
                  <div className="series-row-sub">
                    {t(dl && dl.completed > 0 ? `已下载 ${dl.completed}/${dl.total} 集` : `共 ${(s.episodes || []).length} 集 · 未下载`)}
                  </div>
                </div>
                {isActive && <span className="series-row-cur">{t("当前")}</span>}
                {hasFiles && (
                  <button
                    className="icon-btn icon-btn-danger series-row-del"
                    title={t(`删除本地文件（${st.files} 个 · ${fmtSize(st.bytes)}）`)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onConfirmAsk({
                        title: '删除本地文件',
                        message: `将删除《${s.series_title}》已下载的 ${st.files} 个文件，释放 ${fmtSize(st.bytes)}。\n剧集仍保留在列表中，之后可以随时在线播放或重新下载。`,
                        okText: '删除文件',
                        danger: true,
                        onOk: async () => {
                          if (String(s.series_id) === selectedSeriesRef.current && !onlineUrl && !compatMap[currentIndex]) {
                            onStopPlayback('本地播放已停止，可重新连接片源观看');
                          }
                          await onDeleteDownloadedFiles(() => window.electronAPI.deleteSeriesFiles(s.series_id));
                        },
                      });
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
                <button
                  className="icon-btn series-row-del"
                  title={t("永久移除剧库记录（不删除本地文件）")}
                  aria-label={t(`永久移除 ${s.series_title} 的剧库记录`)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onConfirmAsk({
                      title: '永久移除剧库记录',
                      message: `将永久移除《${s.series_title}》的剧库记录，不能通过恢复列表找回。同时清理本剧播放缓存。本地下载视频文件不会删除；以后可重新搜索添加。`,
                      okText: '永久移除',
                      danger: true,
                      onOk: () => onRemoveSeries(s.series_id, s.series_title),
                    });
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            );
          })}
      </div>

      <div className="series-picker-foot">
        {storageTotal.files > 0 && (
          <span className="series-picker-usage">{t("本地已占用 ")}<b>{fmtSize(storageTotal.bytes)}</b> / {storageTotal.files}{t(" 个文件")}</span>
        )}
        {storageTotal.files > 0 && (
          <button
            className="btn btn-outline btn-sm btn-danger-text"
            title={t("删除所有已下载的本地文件")}
            onClick={() => {
              onConfirmAsk({
                title: '删除全部本地文件',
                message: `将删除所有已下载的剧集文件（包括已从剧库移除但保留的视频），共 ${storageTotal.files} 个文件、${fmtSize(storageTotal.bytes)}。\n剧集列表与分集信息会保留，之后仍可在线播放或重新下载。`,
                okText: '全部删除',
                danger: true,
                onOk: async () => {
                  if (current?.fileUrl && !onlineUrl && !compatMap[currentIndex]) {
                    onStopPlayback('本地播放已停止，可重新连接片源观看');
                  }
                  await onDeleteDownloadedFiles(() => window.electronAPI.deleteAllDownloaded());
                },
              });
            }}
          >{t("删除全部已下载")}</button>
        )}
        <button className="btn btn-outline btn-sm" onClick={onClearCache} title={t("释放在线播放占用的内存")}>
          <Zap size={14} />{t("清空播放缓存")}{cacheInfo.count > 0 ? ` (${cacheInfo.count})` : ''}
        </button>
        {compatCache.files > 0 && (
          <button className="btn btn-outline btn-sm" onClick={onClearCompatCache} title={t("删除转码产生的兼容格式文件")}>
            <Trash2 size={14} />{t("清空转码缓存 (")}{fmtSize(compatCache.bytes)})
          </button>
        )}
      </div>
    </div>
  );
}

export default SeriesPicker;
