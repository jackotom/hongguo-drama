import React, { useEffect, useRef, useState } from 'react';

const displayKey = value => value.replaceAll('CommandOrControl', navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl').replaceAll('Command', 'Cmd').replaceAll('Control', 'Ctrl');

export default function BossKeySettings({ active = true }) {
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [recording, setRecording] = useState(false);
  const capturedKey = useRef(null);
  useEffect(() => { if (!active) setRecording(false); }, [active]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    if (!window.electronAPI?.getBossKeyState) { setError('请更新桌面试用包后设置老板键'); return; }
    window.electronAPI.getBossKeyState().then(state => {
      if (cancelled) return;
      setConfig(state); setDraft(displayKey(state.accelerator)); setError(state.error || '');
    }).catch(() => { if (!cancelled) setError('无法读取老板键设置，请重新打开设置页'); });
    return () => { cancelled = true; };
  }, [active]);

  const save = async enabled => {
    setSaving(true); setError(''); setMessage('');
    try {
      const result = await window.electronAPI.setBossKey({ enabled, accelerator: enabled || !config.enabled ? draft : config.accelerator });
      if (!result.success) throw Error(result.error || '老板键保存失败');
      setConfig(result); setDraft(displayKey(result.accelerator));
      setMessage(result.registered ? '已保存，后台也能使用老板键' : '已保存，老板键未开启');
    } catch (failure) { setError(failure.message || '无法保存，请重试'); }
    finally { setSaving(false); }
  };
  const disabled = !active || !config || saving;
  const record = event => {
    if (!recording || event.repeat || event.isComposing) return;
    if (event.key === 'Tab') { setRecording(false); return; }
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setRecording(false); setError(''); return; }
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.code === 'Space' ? 'Space' : event.key.toUpperCase();
    if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Space)$/.test(key) || (!/^F\d+$/.test(key) && !event.ctrlKey && !event.metaKey && !event.altKey)) {
      setError('请按 Ctrl、Cmd 或 Alt 加字母、数字或空格，或 F1–F12'); return;
    }
    capturedKey.current = event.code || event.key;
    setDraft([event.ctrlKey && 'Control', event.metaKey && 'Command', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+'));
    setRecording(false); setError(''); setMessage('新组合键已录入，请点击保存');
  };
  return <>
    <div className="shortcut-settings-row boss-key-row" data-boss-key-settings>
      <label className="boss-key-toggle"><input type="checkbox" aria-label="启用老板键" checked={config?.enabled === true} disabled={disabled}
        onChange={event => save(event.target.checked)} /> 老板键</label>
      <button id="boss-key-shortcut" type="button" className={`btn btn-outline shortcut-record boss-key-input${recording ? ' is-recording' : ''}`} aria-label="老板键快捷键" disabled={disabled}
        aria-describedby="boss-key-help" aria-pressed={recording}
        onClick={() => { setRecording(!recording); setError(''); setMessage(''); }} onKeyDown={record}
        onKeyUp={event => { if (capturedKey.current === (event.code || event.key)) { event.preventDefault(); capturedKey.current = null; } }}
        onBlur={() => { setRecording(false); capturedKey.current = null; }}>
        {recording ? '请按组合键…' : displayKey(draft)}
      </button>
      <button type="button" className="btn btn-outline btn-sm" aria-label="保存老板键" disabled={disabled} onClick={() => save(config.enabled)}>{saving ? '保存中…' : '保存'}</button>
    </div>
    <p className="settings-hint boss-key-hint" id="boss-key-help">老板键点击按键后，同时按下组合键，再点保存；Esc 取消。支持 Ctrl、Cmd、Alt 组合或 F1–F12。启用后在其他应用中也生效：按一次暂停并隐藏，再按恢复窗口，保持暂停。Mac 同时隐藏和恢复 Dock 图标。</p>
    {error && <p className="shortcut-error settings-hint boss-key-hint" role="alert">{error}</p>}
    {message && <p className="settings-hint boss-key-hint" role="status" aria-live="polite">{message}</p>}
  </>;
}
