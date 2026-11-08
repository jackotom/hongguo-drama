import { t, useLanguage } from '../i18n';
import React, { useEffect, useId, useRef, useState } from 'react';
import { Download } from './icons';
import './NasDownload.css';

export default function NasDownload({ seriesId, quality = 'auto', disabled = false }) {
  useLanguage();
  const descriptionId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [createFolder, setCreateFolder] = useState(true);
  const request = useRef(0);
  const submittingRef = useRef(false);
  const eventFailure = useRef(null);
  const currentSeries = useRef(seriesId);
  currentSeries.current = seriesId;

  useEffect(() => {
    request.current++;
    submittingRef.current = false;
    eventFailure.current = null;
    setSubmitting(false);
    setFeedback(null);
    return () => {
      request.current++;
      submittingRef.current = false;
    };
  }, [seriesId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onNasExportDone?.(event => {
      if (!event || String(event.seriesId) !== String(currentSeries.current)) return;
      if (!event.success) {
        const failure = { version: request.current, message: event.error || `第 ${event.vidIndex} 集整理到 NAS 失败。` };
        eventFailure.current = failure;
        setFeedback({ kind: 'error', message: failure.message, warnings: [] });
      }
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, [seriesId]);

  const submit = async () => {
    if (!seriesId || disabled || submittingRef.current) return;
    const version = ++request.current;
    const requestedSeries = String(seriesId);
    submittingRef.current = true;
    eventFailure.current = null;
    setFeedback(null);
    setSubmitting(true);
    try {
      if (!window.electronAPI?.downloadSeriesToNas) throw new Error('当前环境暂不支持下载到 NAS');
      const result = await window.electronAPI.downloadSeriesToNas(seriesId, quality, { createFolder });
      if (version !== request.current || requestedSeries !== String(currentSeries.current)) return;
      if (result?.success) {
        if (eventFailure.current?.version === version) return;
        setFeedback({
          kind: 'success',
          message: `新增 ${Number(result.count) || 0} 集下载，复用 ${Number(result.copied) || 0} 集。保存目录：${result.directory}`,
          warnings: Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [],
        });
      } else if (!result?.canceled) {
        setFeedback({ kind: 'error', message: result?.error || '下载到 NAS 失败，请重试。', warnings: [] });
      }
    } catch (failure) {
      if (version === request.current && requestedSeries === String(currentSeries.current)) {
        setFeedback({ kind: 'error', message: failure.message || '下载到 NAS 失败，请重试。', warnings: [] });
      }
    } finally {
      if (version === request.current && requestedSeries === String(currentSeries.current)) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  if (!seriesId) return null;
  return <div className="nas-download">
    <button type="button" className="btn btn-outline" onClick={submit} disabled={disabled || submitting}
      aria-describedby={descriptionId} aria-label={t("下载到 NAS")}>
      <Download size={15} />
      {t(submitting ? '提交中…' : '下载到 NAS')}
    </button>
    <label className="nas-download-description"><input type="checkbox" checked={createFolder} disabled={disabled || submitting}
      onChange={event => setCreateFolder(event.target.checked)} />{t(" 自动创建剧名文件夹")}</label>
    <div id={descriptionId} className="nas-download-description">
      <p>{t("保存整剧封面、简介和 tvshow.nfo，不再新建分集 NFO。已有视频安全复用，缺失资料补齐。")}</p>
      <p>{t("先挂载 NAS，再选择保存位置；已建好本剧文件夹时可取消自动创建。也可在设置中将 NAS 设为普通下载目录并开启整剧资料，无需每次使用本按钮。")}</p>
    </div>
    {feedback?.kind === 'success' && <p className="nas-download-success" role="status">{t(feedback.message)}</p>}
    {feedback?.kind === 'error' && <p className="nas-download-error" role="alert">{t(feedback.message)}</p>}
    {feedback?.kind === 'success' && feedback.warnings.map(warning => <p key={warning} className="nas-download-warning">{t(warning)}</p>)}
  </div>;
}
