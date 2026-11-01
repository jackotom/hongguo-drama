import React, { useEffect, useId, useRef, useState } from 'react';
import { Download } from './icons';
import './NasDownload.css';

export default function NasDownload({ seriesId, quality = 'auto', disabled = false }) {
  const descriptionId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
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
      const result = await window.electronAPI.downloadSeriesToNas(seriesId, quality);
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
      aria-describedby={descriptionId} aria-label="下载到 NAS">
      <Download size={15} />
      {submitting ? '提交中…' : '下载到 NAS'}
    </button>
    <div id={descriptionId} className="nas-download-description">
      <p>一并保存封面与剧情简介，直接写入所选的 NAS 文件夹。已下载视频直接复用，缺失分集与配套资料自动补齐。</p>
      <p>先将 NAS 共享文件夹挂载到电脑，再选择保存位置。分集按季号、集号规范命名，资料以来源实际提供为准。</p>
    </div>
    {feedback?.kind === 'success' && <p className="nas-download-success" role="status">{feedback.message}</p>}
    {feedback?.kind === 'error' && <p className="nas-download-error" role="alert">{feedback.message}</p>}
    {feedback?.kind === 'success' && feedback.warnings.map(warning => <p key={warning} className="nas-download-warning">{warning}</p>)}
  </div>;
}
