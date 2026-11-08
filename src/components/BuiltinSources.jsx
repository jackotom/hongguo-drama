import { t, useLanguage } from '../i18n';
import React, { useRef, useState } from 'react';
import { Globe } from './icons';
import useMediaSources, { notifyMediaSourcesChanged } from './useMediaSources';
import { BUILTIN_MEDIA_SOURCES } from './mediaSourcesModel.mjs';

export default function BuiltinSources() {
  useLanguage();
  const { sources, loading, error: loadError } = useMediaSources();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const toggle = async (id, enabled) => {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try {
      const result = await window.electronAPI.setBuiltinSourceEnabled(id, enabled);
      if (!result?.success) throw new Error(result?.error || '来源开关未保存，请重试');
    } catch (cause) { setError(cause.message || '来源开关未保存，请重试'); }
    finally { pending.current = false; setSaving(false); }
  };
  return <section className="settings-card builtin-sources" aria-labelledby="builtin-sources-title">
    <div className="custom-sources-heading"><Globe size={18} /><h3 id="builtin-sources-title">{t("内置来源")}</h3></div>
    <p className="settings-hint" id="builtin-sources-hint">{t("立即生效并自动保存。关闭后，全局搜索、发现片单、热播推荐和摇一摇不再使用该来源。红果固定开启。")}</p>
    {BUILTIN_MEDIA_SOURCES.filter(item => !['reelshort', 'dramabox'].includes(item.id) || !['android', 'ios'].includes(window.electronAPI.platform)).map(({ id, label }) => <label className="builtin-source-row" key={id}>
      <span>{t(label)}<em>{t(id === 'hongguo' ? '默认来源，固定开启' : sources.some(source => source.id === id) ? '已开启' : '已关闭')}</em></span>
      <input type="checkbox" role="switch" aria-label={t('{0}来源', [t(label).replace('短剧', '')])} aria-describedby="builtin-sources-hint" checked={id === 'hongguo' || sources.some(source => source.id === id)} disabled={id === 'hongguo' || loading || saving || !!loadError} onChange={event => toggle(id, event.target.checked)} />
    </label>)}
    {!['android', 'ios'].includes(window.electronAPI.platform) && <p className="settings-hint">{t("海外来源默认关闭，仅提供官网公开播放内容。DramaBox 已验证真实搜索、分集和免费整集；部分网络需让官网与官方 CDN 在现有网络工具中走代理。ReelShort 仍为实验来源。")}</p>}
    {saving && <p className="settings-hint" role="status">{t("正在保存…")}</p>}
    {(error || loadError) && <p className="appearance-error" role="alert">{t(error || loadError)}</p>}
    {loadError && <button type="button" className="btn btn-outline btn-sm" disabled={loading} onClick={notifyMediaSourcesChanged}>{t("重新读取来源")}</button>}
  </section>;
}
