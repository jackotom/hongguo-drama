import React, { useEffect, useRef, useState } from 'react';
import { t, useLanguage } from '../i18n';
import { FULL_WAKE_REGION, RIGHT_WAKE_REGION, validWakeRegion, wakeRegionFields, wakeRegionFromFields, adjustWakeRegion } from './stealthWakeRegion.mjs';
import './StealthWakeRegion.css';

const INVALID_REGION = '小窗唤醒区域无效：区域须在窗口内，宽高至少为 5%';
const labels = { x: '距左侧', y: '距顶部', width: '区域宽度', height: '区域高度' };

export default function StealthWakeRegion({ active = true, focusRequest = 0 }) {
  useLanguage();
  const [savedRegion, setSavedRegion] = useState(FULL_WAKE_REGION);
  const [fields, setFields] = useState(() => wakeRegionFields(FULL_WAKE_REGION));
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const edited = useRef(false);
  const savingRef = useRef(false);
  const drag = useRef(null);
  const canvas = useRef(null);
  const heading = useRef(null);
  const region = wakeRegionFromFields(fields);
  const preview = region || savedRegion;
  const dirty = !region || Object.keys(FULL_WAKE_REGION).some(key => Math.abs(region[key] - savedRegion[key]) > 1e-9);

  useEffect(() => {
    if (!active || edited.current) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    window.electronAPI.getSettings().then(settings => {
      if (cancelled || edited.current) return;
      const next = validWakeRegion(settings.stealth_wake_region) ? settings.stealth_wake_region : FULL_WAKE_REGION;
      setSavedRegion(next);
      setFields(wakeRegionFields(next));
      setLoaded(true);
    }).catch(cause => {
      if (!cancelled) setError(cause.message || '唤醒区域加载失败，请重试');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; drag.current = null; };
  }, [active, retry]);

  useEffect(() => {
    if (active && loaded && focusRequest) {
      heading.current?.scrollIntoView({ block: 'center' });
      heading.current?.focus({ preventScroll: true });
    }
  }, [active, loaded, focusRequest]);

  const edit = nextFields => {
    if (!active || !loaded || loading || savingRef.current) return;
    edited.current = true;
    setFields(nextFields);
    setSaved(false);
    setError('');
  };
  const setRegion = next => edit(wakeRegionFields(next));
  const beginDrag = (event, resize) => {
    if (!active || !loaded || loading || savingRef.current || event.button !== 0) return;
    event.preventDefault();
    const bounds = canvas.current.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, bounds, region: preview, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = event => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    setRegion(adjustWakeRegion(current.region, (event.clientX - current.x) / current.bounds.width,
      (event.clientY - current.y) / current.bounds.height, current.resize));
  };
  const endDrag = event => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyboard = (event, resize) => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.05 : 0.01;
    setRegion(adjustWakeRegion(preview, direction[0] * step, direction[1] * step, resize));
  };
  const save = async () => {
    if (!region || !dirty || !active || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const result = await window.electronAPI.saveSettings({ stealth_wake_region: region });
      if (!result?.success) throw new Error(result?.error || '唤醒区域未保存，请重试');
      setSavedRegion(region);
      edited.current = false;
      setSaved(true);
    } catch (cause) {
      setError(cause.message || '唤醒区域未保存，请重试');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const pointerProps = { onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: () => { drag.current = null; } };

  return <section className="settings-group stealth-wake-settings" aria-labelledby="stealth-wake-heading">
    <h3 className="settings-label" id="stealth-wake-heading" ref={heading} tabIndex={-1}>{t('小窗模式：隐藏后唤醒区域')}</h3>
    <p className="settings-hint">{t('隐藏时移入指定区域显示；显示后可在整个窗口操作，移出窗口再隐藏。')}</p>
    <p className="settings-hint">{t('仅用于播放页的“小窗模式”，不影响画中画，也不改变窗口大小或位置。')}</p>
    <fieldset className="stealth-wake-editor" disabled={!active || !loaded || loading || saving}>
      <div className="stealth-wake-preview-column">
        <div className="stealth-wake-canvas" ref={canvas} role="group" aria-label={t('小窗范围示意图')} aria-describedby="stealth-wake-help">
          <div className="stealth-wake-area" style={{ left: `${preview.x * 100}%`, top: `${preview.y * 100}%`, width: `${preview.width * 100}%`, height: `${preview.height * 100}%` }}>
            <button type="button" className="stealth-wake-move" aria-label={t('移动唤醒区域')} title={t('拖动移动；方向键微调，按住 Shift 加快')}
              onPointerDown={event => beginDrag(event, false)} onKeyDown={event => keyboard(event, false)} {...pointerProps} />
            <button type="button" className="stealth-wake-resize" aria-label={t('调整唤醒区域大小')} title={t('拖动右下角缩放；方向键微调，按住 Shift 加快')}
              onPointerDown={event => beginDrag(event, true)} onKeyDown={event => keyboard(event, true)} {...pointerProps}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 12 12 5M9 12l3-3" /></svg>
            </button>
          </div>
        </div>
        <p className="settings-hint" id="stealth-wake-help">{t('拖动红色区域改变位置，拖动右下角改变大小。也可用方向键微调。')}</p>
        <div className="preset-row">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setRegion(FULL_WAKE_REGION)}>{t('恢复全窗')}</button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setRegion(RIGHT_WAKE_REGION)}>{t('右侧窄条（10%）')}</button>
        </div>
      </div>
      <div className="stealth-wake-fields">
        {Object.entries(labels).map(([key, label]) => <label key={key} className="stealth-wake-field" htmlFor={`stealth-wake-${key}`}>
          <span>{t(label)}</span><div><input id={`stealth-wake-${key}`} type="number" className="input-field" min={key === 'x' || key === 'y' ? 0 : 5} max={100} step="0.1"
            value={fields[key]} onChange={event => edit({ ...fields, [key]: event.target.value })} aria-invalid={!region} /><span aria-hidden="true">%</span></div>
        </label>)}
        <p className="settings-hint">{t('位置从小窗左上角计算；宽高至少 5%，区域不能超出小窗。')}</p>
      </div>
    </fieldset>
    {loaded && !region && <p className="appearance-error" role="alert">{t(INVALID_REGION)}</p>}
    {error && <p className="appearance-error" role="alert">{t(error)}</p>}
    <div className="stealth-wake-actions">
      {!loaded && !loading ? <button type="button" className="btn btn-outline" onClick={() => setRetry(value => value + 1)}>{t('重新加载')}</button> :
        <button type="button" className="btn btn-primary" disabled={!active || !loaded || loading || saving || !region || !dirty} onClick={save}>{t(saving ? '正在保存…' : '保存唤醒区域')}</button>}
      <span className="settings-hint" role="status">{t(loading ? '加载中...' : saved ? '唤醒区域已保存' : dirty && loaded ? '有未保存的修改' : '')}</span>
    </div>
  </section>;
}
