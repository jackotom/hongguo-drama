import { t, useLanguage } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';

export default function AnnouncementSettings() {
  useLanguage();
  const [preferences, setPreferences] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [manualMessage, setManualMessage] = useState('');
  const pending = useRef(false);
  const manualPending = useRef(false);
  useEffect(() => {
    let active = true, revision = 0;
    const api = window.electronAPI;
    const unsubscribe = api.onAnnouncementPreferences(next => { revision++; if (active) setPreferences(next); });
    const current = revision;
    api.getAnnouncementPreferences().then(next => { if (active && current === revision) setPreferences(next); })
      .catch(() => { if (active) setError('公告设置读取失败，请重启软件后重试。'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const update = async (key, enabled) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await window.electronAPI.setAnnouncementPreferences({ [key]: enabled });
      if (!result?.success) setError(result?.error || '保存失败，原公告设置已保留。');
      else setPreferences(result.preferences);
    } catch { setError('保存失败，原公告设置已保留。'); }
    finally { pending.current = false; setSaving(false); }
  };
  const viewCurrent = async () => {
    if (manualPending.current) return;
    manualPending.current = true;
    setReading(true);
    setManualMessage('');
    try {
      const result = await window.electronAPI.getCurrentAnnouncement();
      if (result?.announcement) {
        window.dispatchEvent(new CustomEvent('hongguo-show-current-announcement', { detail: result.announcement }));
      } else setManualMessage(result?.error || '当前暂无可查看的公告。');
    } catch { setManualMessage('公告读取失败，请稍后重试。'); }
    finally { manualPending.current = false; setReading(false); }
  };
  return <div className="settings-group">
    <span className="settings-label">{t("公告通知")}</span>
    <label className="proxy-switch-row"><input type="checkbox" checked={preferences?.normalEnabled === false} disabled={!preferences || saving}
      onChange={event => update('normalEnabled', !event.target.checked)} /><span className="proxy-switch-text">{t("关闭普通公告")}<em>{t("开启后不读取、不展示普通公告；软件升级后也保持关闭")}</em></span></label>
    <label className="proxy-switch-row"><input type="checkbox" checked={preferences?.emergencyEnabled === false} disabled={!preferences || saving}
      onChange={event => update('emergencyEnabled', !event.target.checked)} /><span className="proxy-switch-text">{t("关闭紧急公告")}<em>{t("开启后停止紧急公告检查；重新接收后，已提醒过的公告也不会重复")}</em></span></label>
    <p className="settings-hint">{t("更改立即保存。接收紧急公告时每 5 分钟检查一次，每条只提醒一次；不会受普通公告的“今日不提醒”和“版本更新前不提醒”影响。")}</p>
    <button type="button" className="btn btn-outline" disabled={reading} aria-busy={reading} onClick={viewCurrent}>{t(reading ? '正在读取公告…' : '查看当前公告')}</button>
    <p className="settings-hint">{t("手动查看不受自动接收开关或免提醒设置限制。")}</p>
    {manualMessage && <p className="settings-hint" role="status">{t(manualMessage)}</p>}
    {error && <p className="alert alert-error" role="alert">{t(error)}</p>}
  </div>;
}
