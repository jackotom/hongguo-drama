import React, { useEffect, useState } from 'react';
import AppearanceSettings from '../../src/components/AppearanceSettings.jsx';

export default function MobileSettings({ active, appInfo }) {
  const [settings, setSettings] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => { window.electronAPI.getSettings().then(setSettings).catch(error => setMessage(error.message)); }, [active]);
  const change = async (key, value) => {
    const result = await window.electronAPI.saveSettings({ [key]: value });
    if (result.success) { setSettings(current => ({ ...current, [key]: value })); setMessage('已保存'); }
    else setMessage(result.error);
  };
  return <div className="settings-container"><div className="settings-header"><h2>设置</h2></div>
    <section className="settings-card"><AppearanceSettings active={active} showZoom={false} /></section>
    {settings && <section className="settings-card"><h3>播放与下载</h3>
      <label className="settings-group">默认下载画质<select className="input-field" value={settings.download_quality} onChange={event => change('download_quality', event.target.value)}><option value="auto">自动</option><option value="1080p">1080P</option><option value="720p">720P</option></select></label>
      {[['cache_next_episode','预缓存后续两集'],['auto_delete_watched','看完自动删除本机下载'],['show_danmaku_controls','显示弹幕按钮'],['search_app_enabled','优先使用 App 搜索']].map(([key,label]) => <label className="proxy-switch-row" key={key}><input type="checkbox" checked={settings[key] === true} onChange={event => change(key,event.target.checked)} /><span>{label}</span></label>)}
      <p className="settings-hint">自动删除会永久删除已看完的本机视频。缓存与下载会使用网络流量。</p>
    </section>}
    <section className="settings-card"><h3>关于红果·自用</h3><p>安卓个人版 {appInfo?.version?.replace(/\.0$/,'')} · 与 Mac 版共用页面和播放器</p><p>下载保存在应用私有目录，卸载应用会删除；覆盖安装保留资料。</p><p>无广告 SDK。H.264／HEVC 使用系统解码；ByteVC2 兼容转换、NAS、投屏尚未接入。</p><p>账号登录复用 Mac 版协议，凭据使用 Android 系统密钥加密。账号与弹幕仍需真机验收。</p></section>
    {message && <p role="status" className="alert">{message}</p>}
  </div>;
}
