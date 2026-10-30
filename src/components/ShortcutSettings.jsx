import React, { useEffect, useRef, useState } from 'react';
import { SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, formatShortcut, readShortcuts, saveShortcuts, shortcutKey, subscribeShortcuts, validateShortcuts } from '../shortcuts';
import BossKeySettings from './BossKeySettings';

export default function ShortcutSettings({ active = true }) {
  const capturedKey = useRef(null);
  const [bindings, setBindings] = useState(readShortcuts);
  const [recording, setRecording] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => subscribeShortcuts(setBindings), []);
  useEffect(() => { if (!active) setRecording(null); }, [active]);

  const save = next => {
    try {
      saveShortcuts(next);
      setBindings(next);
      setRecording(null);
      setError('');
      setMessage('快捷键已保存，立即生效');
    } catch (failure) {
      setError(failure.message || '无法保存，请重试');
    }
  };
  const record = (event, action) => {
    if (recording !== action.id || event.repeat || event.isComposing) return;
    // Keep OS/browser combinations untouched; only player-owned keys are captured.
    if (event.metaKey || event.ctrlKey || event.altKey) { setError('Cmd、Ctrl、Alt 组合保留给系统，请使用单键或 Shift 组合'); return; }
    if (event.key === 'Tab') { setRecording(null); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRecording(null); setError(''); return; }
    if (event.key === 'Shift') return;
    const key = shortcutKey(event);
    if (!key) { if (event.key === 'Enter') event.preventDefault(); setError('请选择字母、数字、方向键或空格；可加 Shift（Shift + 空格保留给输入法）'); return; }
    event.preventDefault(); event.stopPropagation();
    capturedKey.current = event.code || event.key;
    const next = { ...readShortcuts(), [action.id]: key };
    const conflict = validateShortcuts(next);
    if (conflict) { setError(conflict); return; }
    save(next);
  };

  return <section className="shortcut-settings settings-card" data-shortcut-settings aria-labelledby="shortcut-settings-title">
    <div className="shortcut-settings-heading">
      <h2 id="shortcut-settings-title">播放快捷键</h2>
      <button type="button" className="btn btn-outline" onClick={() => save({ ...DEFAULT_SHORTCUTS })}>恢复默认</button>
    </div>
    <p className="settings-hint" id="shortcut-settings-help">播放操作点击按键后录入，支持单键或 Shift 组合；Esc 取消。仅在播放页生效，输入文字时不响应。老板键使用全局组合键，单独启用。</p>
    <div className="shortcut-settings-list">
      {SHORTCUT_ACTIONS.map(action => <div className="shortcut-settings-row" key={action.id}>
        <span id={`shortcut-label-${action.id}`}>{action.label}</span>
        <button type="button" className={`btn btn-outline shortcut-record ${recording === action.id ? 'is-recording' : ''}`}
          aria-label={`${action.label}：${formatShortcut(bindings[action.id])}，点击更改`}
          aria-describedby="shortcut-settings-help" aria-pressed={recording === action.id}
          onClick={() => { setRecording(recording === action.id ? null : action.id); setError(''); setMessage(''); }}
          onKeyDown={event => record(event, action)} onKeyUp={event => { if (capturedKey.current === (event.code || event.key)) { event.preventDefault(); capturedKey.current = null; } }}
          onBlur={() => { capturedKey.current = null; if (recording === action.id) setRecording(null); }}>
          {recording === action.id ? '请按新键…' : formatShortcut(bindings[action.id])}
        </button>
      </div>)}
      <BossKeySettings active={active} />
    </div>
    {error && <p className="settings-hint shortcut-error" role="alert">{error}</p>}
    <p className="settings-hint" role="status" aria-live="polite">{recording ? `正在更改「${SHORTCUT_ACTIONS.find(action => action.id === recording)?.label}」` : message}</p>
  </section>;
}
