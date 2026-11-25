import { t, useLanguage } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Shield } from './icons';
import './SourcePackSettings.css';

export default function SourcePackSettings() {
  useLanguage();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.electronAPI.onSourcePackStatus?.(next => {
      if (active) setStatus(next);
    });
    window.electronAPI.getSourcePackStatus?.().then(next => {
      if (!active) return;
      if (!next?.success) throw new Error(next?.error || '动态取源状态读取失败');
      setStatus(next);
      if (next.error) setError(next.error);
    }).catch(failure => {
      if (active) setError(failure.message || '动态取源状态读取失败，请重启软件后重试。');
    });
    return () => { active = false; unsubscribe?.(); };
  }, []);

  const run = async (kind, task, success) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(kind); setMessage(''); setError('');
    try {
      const result = await task();
      if (!result?.success) throw new Error(result?.error || '动态取源操作失败');
      setStatus(result);
      if (result.error) throw new Error(result.error);
      setMessage(success(result));
    } catch (failure) {
      setError(failure.message || '动态取源操作失败，请稍后重试');
    } finally {
      pending.current = false;
      setBusy('');
    }
  };

  const sourceLabel = status?.source === 'remote' ? '在线更新包' : '内置稳定包';
  return <section className="settings-group source-pack-settings" aria-labelledby="source-pack-title">
    <span className="settings-label" id="source-pack-title"><Shield size={17} />{t("自动获取播放源")}</span>
    <label className="proxy-switch-row">
      <input type="checkbox" checked={status?.enabled !== false} disabled={!status || !!busy}
        onChange={event => run('toggle', () => window.electronAPI.setSourcePackEnabled(event.target.checked),
          next => next.enabled ? '自动获取播放源已开启。' : '自动获取播放源已关闭，现有策略保持不变。')} />
      <span className="proxy-switch-text">{t("自动检查签名取源更新")}
        <em>{t("启动时及每 6 小时检查一次。只接受项目签名且通过格式校验的红果官方请求入口、字段和签名族，不会执行远端脚本。")}</em>
      </span>
    </label>
    <div className="source-pack-status" role="status">
      <div><span>{t("当前策略")}</span><strong>{t(sourceLabel)}</strong></div>
      <div><span>{t("策略版本")}</span><strong>{status?.revision || 0}</strong></div>
      <div><span>{t("发布时间")}</span><strong>{status?.issuedAt ? new Date(status.issuedAt).toLocaleString() : t('内置默认')}</strong></div>
      <div><span>{t("最近检查")}</span><strong>{status?.lastCheckAt ? new Date(status.lastCheckAt).toLocaleString() : t('尚未检查')}</strong></div>
    </div>
    <div className="source-pack-actions">
      <button type="button" className="btn btn-outline" disabled={!status || !!busy || status.enabled === false}
        onClick={() => run('check', () => window.electronAPI.checkSourcePack(),
          next => next.updated ? `已更新到策略第 ${next.revision} 版。` : next.upToDate ? '当前已经是最新取源策略。' : '已读取取源策略。')}>
        <RefreshCw size={15} />{t(busy === 'check' ? '正在检查…' : '立即检查')}
      </button>
      <button type="button" className="btn btn-outline" disabled={!status?.canRollback || !!busy}
        onClick={() => run('rollback', () => window.electronAPI.rollbackSourcePack(),
          next => `已回滚到策略第 ${next.revision} 版。`)}>
        {t(busy === 'rollback' ? '正在回滚…' : '回滚上一版')}
      </button>
    </div>
    {message && <p className="source-pack-message" role="status">{t(message)}</p>}
    {error && <p className="alert alert-error" role="alert">{t(error)}</p>}
  </section>;
}
