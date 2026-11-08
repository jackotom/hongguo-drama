import { t, useLanguage } from '../i18n';
import LanguageSettings from './LanguageSettings';
import React, { useEffect, useRef, useState } from 'react';
import { getThemePreference, setThemePreference, getPosterSize, setPosterSize } from '../theme';

export default function AppearanceSettings({ active = true, showZoom = true }) {
  useLanguage();
  const [preference, setPreference] = useState(getThemePreference);
  const [posterSize, setPosterPreference] = useState(getPosterSize);
  const [zoom, setZoom] = useState(null);
  const [zoomBusy, setZoomBusy] = useState(false);
  const zoomPending = useRef(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let changed = false;
    const unsubscribe = window.electronAPI.onInterfaceZoomChanged?.(value => {
      changed = true;
      if (!cancelled) setZoom(value);
    });
    window.electronAPI.getSettings().then(settings => {
      if (!cancelled && !changed) setZoom(settings.ui_zoom ?? 1);
    }).catch(() => {
      if (!cancelled) setError('界面大小读取失败，请重新进入设置。');
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [active]);

  const changeZoom = async direction => {
    if (zoomPending.current) return;
    zoomPending.current = true;
    setZoomBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.changeWindowZoom(direction);
      if (!result?.success) throw new Error(result?.error || '界面大小保存失败，请重试。');
      setZoom(result.zoom);
    } catch (error) {
      setError(error.message || '界面大小保存失败，请重试。');
    } finally {
      zoomPending.current = false;
      setZoomBusy(false);
    }
  };

  const changePosterSize = event => {
    try {
      setPosterSize(event.target.value);
      setPosterPreference(event.target.value);
      setError('');
    } catch {
      setError('海报大小保存失败，请重试。');
    }
  };

  const changeTheme = (event) => {
    try {
      setThemePreference(event.target.value);
      setPreference(event.target.value);
      setError('');
    } catch {
      setError('外观保存失败，请重试。');
    }
  };

  return (
    <>
    <LanguageSettings />
    <div className="settings-group">
      <label className="settings-label" htmlFor="appearance-theme">{t("外观")}</label>
      <select id="appearance-theme" className="input-field select-field" value={preference} onChange={changeTheme} aria-describedby="appearance-hint">
        <option value="system">{t("跟随系统")}</option>
        <option value="light">{t("浅色")}</option>
        <option value="dark">{t("深色")}</option>
      </select>
      <p className="settings-hint" id="appearance-hint">{t("立即生效并自动保存。跟随系统时，外观会随系统切换。")}</p>
    </div>
    {showZoom && <div className="settings-group">
      <span className="settings-label" id="appearance-zoom-label">{t("界面与字号")}</span>
      <div className="appearance-zoom" role="group" aria-labelledby="appearance-zoom-label" aria-describedby="appearance-zoom-hint">
        <button type="button" className="btn btn-outline" aria-label={t("缩小界面与字号")} disabled={zoomBusy || zoom === null || zoom <= 0.5} onClick={() => changeZoom('out')}>{t("缩小")}</button>
        <output aria-live="polite">{t(zoom === null ? '读取中…' : `${Math.round(zoom * 100)}%`)}</output>
        <button type="button" className="btn btn-outline" aria-label={t("放大界面与字号")} disabled={zoomBusy || zoom === null || zoom >= 2} onClick={() => changeZoom('in')}>{t("放大")}</button>
        <button type="button" className="btn btn-outline" disabled={zoomBusy || zoom === null || zoom === 1} onClick={() => changeZoom('reset')}>{t("恢复 100%")}</button>
      </div>
      <p className="settings-hint" id="appearance-zoom-hint">{t("默认 100%，不会按屏幕分辨率自动放大。需要时可手动调整文字和按钮大小（50%–200%），立即生效并记住你的选择。")}</p>
    </div>}
    <div className="settings-group">
      <label className="settings-label" htmlFor="appearance-poster-size">{t("海报大小")}</label>
      <select id="appearance-poster-size" className="input-field select-field" value={posterSize} onChange={changePosterSize} aria-describedby="appearance-poster-hint">
        <option value="small">{t("小")}</option>
        <option value="standard">{t("标准")}</option>
        <option value="large">{t("大")}</option>
        <option value="extra-large">{t("特大")}</option>
      </select>
      <p className="settings-hint" id="appearance-poster-hint">{t("发现页海报随窗口宽度自动排列；调大后每行显示更少。保持原有比例，立即生效并自动保存。")}</p>
      {error && <p className="appearance-error" role="alert">{t(error)}</p>}
    </div>
    </>
  );
}
