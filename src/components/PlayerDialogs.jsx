import React from 'react';
import { t, useLanguage } from '../i18n';
import { Layers, Trash2 } from './icons';

function PlayerDialogs({
  mergeAsk,
  detail,
  playableCount,
  mergeError,
  merging,
  onCloseMerge,
  onMergeSeries,
  confirmAsk,
  onCloseConfirm,
}) {
  useLanguage();
  return (
    <>
      {mergeAsk && (
        <div className="player-confirm-mask" onClick={() => onCloseMerge()}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={t('合并导出')} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title" style={{ color: 'var(--accent)' }}>
              <Layers size={17} />{t("合并导出全集")}</div>
            <div className="player-confirm-msg">
              <p>{t("把《")}{detail ? detail.series_title : ''}{t("》已下载的 ")}{playableCount}{t(" 集合并为一个 mp4。未下载的分集不会自动补齐。")}</p>
              <p><b>{t("高质量分辨率合并")}</b>{t("：逐集检查实际文件，全部达到1080P才能开始；有低清分集请选快速或兼容合并。")}</p>
              <p><b>{t("快速合并")}</b>{t("：优先无损拼接，保留每段原分辨率，部分设备可能不兼容。")}</p>
              <p><b>{t("兼容合并")}</b>{t("：必要时转为H.264/AAC，仍保留每段原分辨率，处理较慢。")}</p>
              <p>{t("三种方式都保留原文件，只合并已下载分集，不自动补齐，也不会把低清变成真高清。")}</p>
              {mergeError && <p className="alert-error" role="alert">{t(mergeError)}</p>}
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => onMergeSeries(false, true)} disabled={merging}>{t("高质量分辨率合并")}</button>
              <button className="btn btn-outline" onClick={() => onCloseMerge()} disabled={merging}>{t("取消")}</button>
              <button className="btn btn-outline" onClick={() => onMergeSeries(true)} disabled={merging}>{t("兼容合并（H.264）")}</button>
              <button className="btn btn-primary" onClick={() => onMergeSeries(false)} disabled={merging}>{t("快速合并")}</button>
            </div>
          </div>
        </div>
      )}

      {confirmAsk && (
        <div className="player-confirm-mask" onClick={onCloseConfirm}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={t(confirmAsk.title || '合并导出')} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title">
              <Trash2 size={17} />
              {t(confirmAsk.title)}
            </div>
            <div className="player-confirm-msg">
              {String(confirmAsk.message).split('\n').map((line, i) => (
                <p key={i}>{t(line)}</p>
              ))}
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={onCloseConfirm}>{t("取消")}</button>
              <button
                className={`btn ${confirmAsk.danger ? 'btn-danger-solid' : 'btn-primary'}`}
                onClick={async () => {
                  const fn = confirmAsk.onOk;
                  onCloseConfirm();
                  try { await fn?.(); } catch (_) {}
                }}
              >
                {t(confirmAsk.okText || '确定')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default PlayerDialogs;
