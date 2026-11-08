import React, { useState } from 'react';
import { t, useLanguage, getLanguagePreference, setLanguagePreference } from '../i18n';

export default function LanguageSettings() {
  useLanguage();
  const [error, setError] = useState('');
  return <div className="settings-group">
    <label className="settings-label" htmlFor="interface-language">{t('界面语言')}</label>
    <select id="interface-language" className="input-field select-field" value={getLanguagePreference()}
      aria-describedby="interface-language-hint" onChange={event => {
        try { setLanguagePreference(event.target.value); setError(''); }
        catch { setError('语言保存失败，请重试。'); }
      }}>
      <option value="system">{t('跟随系统')}</option>
      <option value="zh-CN">简体中文</option>
      <option value="en">English</option>
    </select>
    <p className="settings-hint" id="interface-language-hint">{t('中文系统默认中文，其他系统默认英文。手动选择立即生效并自动保存；剧名、简介和视频保留来源原文。')}</p>
    {error && <p role="alert" className="appearance-error">{t(error)}</p>}
  </div>;
}
