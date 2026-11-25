import { t, useLanguage } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, RefreshCw, Shield } from './icons';
import './SourcePackSettings.css';

const DEFAULT_SOURCE_ORDER = ['openhongguo', 'sdk', 'app', 'web'];

export default function SourcePackSettings() {
  useLanguage();
  const [status, setStatus] = useState(null);
  const [sourceOrder, setSourceOrder] = useState(DEFAULT_SOURCE_ORDER);
  const [sdkAvailable, setSdkAvailable] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const orderSaving = useRef(false);

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
    window.electronAPI.getPlaybackSourceOrder?.().then(next => {
      if (active && next?.success) {
        setSourceOrder(next.order || DEFAULT_SOURCE_ORDER);
        setSdkAvailable(next.availability?.sdk !== false);
      }
    }).catch(() => {});
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
  const sourceDetails = {
    app: ['官方 App 动态策略', '使用当前签名策略包里的官方请求入口、字段和签名族'],
    sdk: ['SDK 取源', '调用官方 SDK helper；首次使用会自动注册匿名设备'],
    web: ['官网公开片源', '使用官网公开的完整 MP4 兜底，画质可能低于 App 片源'],
    openhongguo: ['openhongguo 社区 SDK', '固定版本 Apache-2.0 本地 WASM，使用独立匿名设备档案'],
  };
  const saveOrder = async (next, successMessage) => {
    if (orderSaving.current || busy) return;
    orderSaving.current = true;
    const previous = sourceOrder;
    setSourceOrder(next); setBusy('order'); setError(''); setMessage('');
    try {
      const result = await window.electronAPI.setPlaybackSourceOrder(next);
      if (!result?.success) throw new Error(result?.error || '取源顺序保存失败');
      setSourceOrder(result.order);
      setSdkAvailable(result.availability?.sdk !== false);
      setMessage(successMessage);
    } catch (failure) {
      setSourceOrder(previous);
      setError(failure.message || '取源顺序保存失败');
    } finally {
      orderSaving.current = false;
      setBusy('');
    }
  };
  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= sourceOrder.length || busy) return;
    const next = [...sourceOrder];
    [next[index], next[target]] = [next[target], next[index]];
    saveOrder(next, '取源优先级已保存，下次播放或下载立即使用。');
  };
  const isDefaultOrder = sourceOrder.every((id, index) => id === DEFAULT_SOURCE_ORDER[index]);
  return <section className="settings-card source-pack-settings" aria-labelledby="source-pack-title">
    <div className="source-pack-heading"><Shield size={18} /><h3 id="source-pack-title">{t("自动获取播放源")}</h3></div>
    <label className="proxy-switch-row">
      <input type="checkbox" checked={status?.enabled !== false} disabled={!status || !!busy}
        onChange={event => run('toggle', () => window.electronAPI.setSourcePackEnabled(event.target.checked),
          next => next.enabled ? '自动获取播放源已开启。' : '自动获取播放源已关闭，现有策略保持不变。')} />
      <span className="proxy-switch-text">{t("自动检查签名取源更新")}
        <em>{t("启动时及每 6 小时检查一次。只接受项目签名且通过格式校验的红果官方请求入口、字段和签名族，不会执行远端脚本。")}</em>
      </span>
    </label>
    <div className="source-order-heading">
      <strong>{t("取源优先级")}</strong>
      <span>{t("点击右侧箭头上下调整；越靠上越先尝试")}</span>
      {!isDefaultOrder && <button type="button" className="source-order-reset" disabled={!!busy}
        onClick={() => saveOrder(DEFAULT_SOURCE_ORDER, '已恢复默认取源优先级。')}>{t("恢复默认")}</button>}
    </div>
    {sourceOrder[0] === 'web' && <p className="source-order-warning" role="status">
      {t("官网公开片源排在首位，可能优先得到较低画质的公开 MP4。")}
    </p>}
    <ol className="source-order-list" aria-label={t("取源优先级")}>
      {sourceOrder.map((id, index) => <li key={id}>
        <span className="source-order-index">{index + 1}</span>
        <span className="source-order-copy">
          <strong>{t(sourceDetails[id]?.[0] || id)}</strong>
          <small>{id === 'sdk' && !sdkAvailable
            ? t('当前环境未内置或未启用 SDK；置顶会先失败一次再继续回退')
            : t(sourceDetails[id]?.[1] || '')}</small>
        </span>
        {id === 'sdk' && !sdkAvailable && <span className="source-order-unavailable">{t("当前不可用")}</span>}
        <span className="source-order-actions">
          <button type="button" className="source-order-arrow up" aria-label={`${t('上移')} ${t(sourceDetails[id]?.[0] || id)}`}
            disabled={index === 0 || !!busy} onClick={() => move(index, -1)}><ChevronDown size={16} /></button>
          <button type="button" className="source-order-arrow" aria-label={`${t('下移')} ${t(sourceDetails[id]?.[0] || id)}`}
            disabled={index === sourceOrder.length - 1 || !!busy} onClick={() => move(index, 1)}><ChevronDown size={16} /></button>
        </span>
      </li>)}
    </ol>
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
