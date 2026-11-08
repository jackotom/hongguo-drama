import { t, useLanguage } from '../i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, RefreshCw } from './icons';
import { notifyMediaSourcesChanged } from './useMediaSources';
import { waitForRequest } from './randomDramaModel.mjs';
import './CustomSources.css';

const emptyDraft = () => ({ name: '', url: '', enabled: true });
export default function CustomSources({ active = true }) {
  useLanguage();
  const [sources, setSources] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState('');
  const listVersion = useRef(0);
  const testController = useRef(null);
  const mutation = useRef(false);

  const load = useCallback(async () => {
    const version = ++listVersion.current;
    setLoading(true);
    try {
      const result = await window.electronAPI.getCustomSources();
      if (version !== listVersion.current) return;
      if (!result?.success) throw new Error(result?.error || '自定义源加载失败');
      setSources(result.sources || []);
    } catch (cause) { if (version === listVersion.current) setError(cause.message || '自定义源加载失败'); }
    finally { if (version === listVersion.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (active) load();
    else { testController.current?.abort(); setBusy(current => current === 'test' ? '' : current); }
    return () => { listVersion.current++; testController.current?.abort(); };
  }, [active, load]);

  const patch = (key, value) => {
    testController.current?.abort(); setMessage(''); setError('');
    setDraft(current => ({ ...current, [key]: value }));
  };
  const edit = source => { testController.current?.abort(); setDraft({ ...source }); setDeleting(''); setMessage(''); setError(''); };
  const reset = () => { testController.current?.abort(); setDraft(emptyDraft()); setMessage(''); setError(''); };

  const test = async () => {
    if (busy || mutation.current) return;
    const controller = new AbortController();
    testController.current = controller;
    setBusy('test'); setMessage(''); setError('');
    try {
      const result = await waitForRequest(window.electronAPI.testCustomSource(draft), { signal: controller.signal, message: '测试超时，请检查 API 地址后重试' });
      if (controller.signal.aborted) return;
      if (!result?.success) throw new Error(result?.error || '测试失败，请检查 API 地址');
      setMessage(`目录连接成功，返回 ${result.count || 0} 部。测试不代表每一集都能播放；保存后加入来源。`);
    } catch (cause) { if (!controller.signal.aborted) setError(cause.message || '来源测试失败'); }
    finally { if (!controller.signal.aborted) setBusy(''); }
  };

  const persist = async (source, kind = 'save') => {
    if (busy || mutation.current) return;
    mutation.current = true; setBusy(kind); setMessage(''); setError('');
    try {
      const result = kind === 'delete' ? await window.electronAPI.deleteCustomSource(source.id)
        : await window.electronAPI.saveCustomSource(source);
      if (!result?.success) throw new Error(result?.error || '来源配置未保存，请重试');
      notifyMediaSourcesChanged();
      if (kind === 'save' || (kind === 'delete' && draft.id === source.id)) setDraft(emptyDraft());
      setDeleting('');
      setMessage(kind === 'delete' ? '已移除来源配置，本地视频保留。' : kind === 'toggle' ? (source.enabled ? '来源已启用。' : '来源已停用。') : '来源已保存，可在搜索、发现和摇一摇中选择。');
      await load();
    } catch (cause) { setError(cause.message || '来源配置未保存，请重试'); }
    finally { mutation.current = false; setBusy(''); }
  };

  return <section className="settings-card custom-sources" aria-labelledby="custom-sources-title">
    <div className="custom-sources-heading"><Globe size={18} /><h3 id="custom-sources-title">{t("自定义播放源")}</h3></div>
    <p className="settings-hint">{t("接入你有权使用的苹果 CMS V10 JSON API。仅支持接口返回的 MP4 / M3U8 直链，不支持任意网页、插件或付费解锁。")}</p>
    <form onSubmit={event => { event.preventDefault(); persist(draft); }}>
      <fieldset disabled={!!busy} className="custom-source-form">
        <label>{t("来源名称")}<input className="input-field" value={draft.name} maxLength={60} required placeholder={t("例如：我的片库")} onChange={event => patch('name', event.target.value)} /></label>
        <label>{t("API 地址")}<input className="input-field" type="url" value={draft.url} maxLength={2048} required placeholder="https://example.com/api.php/provide/vod/" spellCheck={false} autoComplete="off" onChange={event => patch('url', event.target.value)} /></label>
        <label className="custom-source-enabled"><input type="checkbox" checked={draft.enabled !== false} onChange={event => patch('enabled', event.target.checked)} />{t("保存后启用")}</label>
        <div className="custom-source-actions"><button type="button" className="btn btn-outline" disabled={!draft.name.trim() || !draft.url.trim()} onClick={test}><RefreshCw size={14} />{t(busy === 'test' ? '测试中…' : '测试连接')}</button>
          <button className="btn btn-primary" type="submit">{t(busy === 'save' ? '保存中…' : draft.id ? '保存修改' : '保存来源')}</button>
          {draft.id && <button className="btn btn-outline" type="button" onClick={reset}>{t("取消编辑")}</button>}
        </div>
      </fieldset>
    </form>
    {busy === 'test' && <button className="btn btn-outline btn-sm" onClick={() => { testController.current?.abort(); setBusy(''); setMessage('已取消测试。'); }}>{t("取消测试")}</button>}
    {message && <p className="custom-source-message" role="status">{t(message)}</p>}
    {error && <div className="custom-source-error" role="alert"><p>{t(error)}</p><button className="btn btn-outline btn-sm" disabled={!!busy || loading} onClick={() => { setError(''); load(); }}>{t("重新读取配置")}</button></div>}
    <div className="custom-source-list" aria-label={t("已保存的自定义源")}>
      {loading && <p className="settings-hint" role="status">{t("正在读取来源…")}</p>}
      {!loading && sources.length === 0 && <p className="settings-hint">{t("还没有自定义源。内置来源可在上方设置。")}</p>}
      {sources.map(source => <div className="custom-source-row" key={source.id}>
        <div className="custom-source-info"><strong>{source.name}</strong><span>{t(source.enabled ? '已启用' : '已停用')}</span><p>{source.url}</p></div>
        <div className="custom-source-actions"><button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => persist({ ...source, enabled: !source.enabled }, 'toggle')}>{t(source.enabled ? '停用' : '启用')}</button>
          <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => edit(source)}>{t("编辑")}</button>
          <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => setDeleting(source.id)}>{t("删除")}</button></div>
        {deleting === source.id && <div className="custom-source-delete" role="group" aria-label={t(`确认删除${source.name}`)}><p>{t("移除「")}{source.name}{t("」配置？本地视频会保留；此来源在线播放将不可用。")}</p><button className="btn btn-danger-solid btn-sm" disabled={!!busy} onClick={() => persist(source, 'delete')}>{t("确认移除")}</button><button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => setDeleting('')}>{t("保留来源")}</button></div>}
      </div>)}
    </div>
  </section>;
}
