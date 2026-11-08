import { t, useLanguage } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
import { X } from './icons';
import './AppUpdateNotice.css';

export default function AppUpdateNotice() {
  useLanguage();
  const [release, setRelease] = useState(null);
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState({ supported: false, reason: '正在读取更新方式…', status: 'idle', percent: 0 });
  const currentState = useRef(state);
  const enabled = useRef(true);
  const actionPending = useRef(false);
  const actionGeneration = useRef(0);
  const openingRelease = useRef(false);
  const checkPending = useRef(false);
  const requestedManually = useRef(false);
  const dismissed = useRef(new Set());
  const checkNow = useRef(null);
  const closedAt = useRef(0);

  useEffect(() => {
    let generation = 0, stateRevision = 0, active = true;
    checkPending.current = false;
    const receiveState = next => {
      if (!active || !next) return;
      stateRevision++;
      currentState.current = next;
      setState(next);
    };
    const check = async (manual = false) => {
      if (manual) { requestedManually.current = true; setVisible(true); setError(''); dismissed.current.clear(); }
      if (checkPending.current || ['checking', 'downloading', 'downloaded', 'installing'].includes(currentState.current.status)) return;
      checkPending.current = true;
      requestedManually.current = manual;
      const request = ++generation;
      const closure = closedAt.current;
      setChecking(true);
      try {
        const result = await window.electronAPI.checkAppUpdate();
        if (!active || request !== generation) return;
        enabled.current = result?.enabled === true;
        if (!enabled.current) {
          setRelease(null);
          if (requestedManually.current) setError(result?.error || '更新检测已关闭，请在设置中开启并保存后重试。');
          else setVisible(false);
          return;
        }
        if (result.error) {
          setRelease(null);
          setError(result.error);
          return;
        }
        setError('');
        setRelease(result.release || null);
        if (result.release) {
          if (closure !== closedAt.current) dismissed.current.add(result.release.version);
          else if (!dismissed.current.has(result.release.version)) setVisible(true);
        }
      } catch {
        if (active && request === generation) { setRelease(null); setError('检查更新失败，请确认网络连接后重试。'); }
      } finally {
        if (active && request === generation) { checkPending.current = false; setChecking(false); }
      }
    };
    checkNow.current = check;
    const manualCheck = () => check(true);
    window.addEventListener('hongguo-check-app-update', manualCheck);
    const unsubscribeState = window.electronAPI.onAppUpdateState(receiveState);
    const unsubscribePreference = window.electronAPI.onAppUpdatePreference(value => {
      generation++;
      checkPending.current = false;
      setChecking(false);
      enabled.current = value;
      if (value) check();
      else { actionGeneration.current++; actionPending.current = false; setPending(false); setVisible(false); setError(''); }
    });
    const revision = stateRevision;
    window.electronAPI.getAppUpdateState().then(next => {
      if (revision === stateRevision) receiveState(next);
    }).catch(() => {
      if (revision === stateRevision) receiveState({ supported: false, reason: '无法读取应用内更新状态，可前往 GitHub 手动下载。', status: 'idle', percent: 0 });
    });
    check();
    const timer = setInterval(() => check(), 6 * 60 * 60 * 1000);
    return () => {
      active = false;
      generation++;
      checkNow.current = null;
      clearInterval(timer);
      window.removeEventListener('hongguo-check-app-update', manualCheck);
      unsubscribeState();
      unsubscribePreference();
    };
  }, []);

  const close = () => {
    closedAt.current++;
    if (release) dismissed.current.add(release.version);
    setVisible(false);
    setError('');
  };
  const act = async kind => {
    if (kind === 'openAppUpdate') {
      if (!enabled.current || openingRelease.current) return;
      openingRelease.current = true;
      try {
        const result = await window.electronAPI.openAppUpdate();
        if (!result?.success && enabled.current) setError(result?.error || '无法打开发布页，请稍后重试。');
      } catch { if (enabled.current) setError('无法打开发布页，请稍后重试。'); }
      finally { openingRelease.current = false; }
      return;
    }
    const cancelling = kind === 'cancelAppUpdate';
    if (!enabled.current) return;
    if (cancelling) {
      if (actionPending.current === 'cancelAppUpdate' || !['checking', 'downloading'].includes(currentState.current.status) && actionPending.current !== 'downloadAppUpdate') return;
    } else if (actionPending.current || checkPending.current || ['checking', 'downloading', 'installing'].includes(currentState.current.status)) return;
    const request = ++actionGeneration.current;
    actionPending.current = kind;
    setPending(true);
    setError('');
    try {
      const result = await window.electronAPI[kind]();
      if (request !== actionGeneration.current) return;
      if (result?.state) { currentState.current = result.state; setState(result.state); }
      if (!result?.success && enabled.current) setError(result?.error || '更新操作失败，请稍后重试。');
    } catch {
      if (request === actionGeneration.current && enabled.current) setError('更新操作失败，请确认网络连接后重试。');
    } finally { if (request === actionGeneration.current) { actionPending.current = false; setPending(false); } }
  };

  if (!visible) return null;
  const downloading = state.status === 'downloading';
  const downloaded = state.status === 'downloaded' || state.status === 'error' && state.downloaded === true;
  const installing = state.status === 'installing';
  const busy = pending || checking || downloading || installing || state.status === 'checking';
  const version = (downloading || downloaded || installing || state.status === 'error') ? state.version || release?.version : release?.version;
  const updateError = error || state.error;
  const percent = Math.max(0, Math.min(100, Math.round(state.percent || 0)));
  const title = checking ? '正在检查更新…' : installing ? '正在重启安装…' : downloaded ? `新版 v${version} 已下载` : downloading ? `正在下载 v${version}` : version ? `发现新版本 v${version}` : '检查更新';
  return <section className="app-update-notice" role="dialog" aria-label={t("软件更新")} aria-describedby="app-update-description" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <button type="button" className="icon-btn app-update-close" aria-label={t("关闭更新提醒")} title={t("关闭更新提醒")} onClick={close}><X size={18} /></button>
    <h2 aria-live="polite">{title}</h2>
    <p id="app-update-description">{t(checking ? '正在查询正式新版，请稍候。' : installing ? '应用即将退出并安装新版。' : downloaded ? '点击后退出应用并安装新版。请先完成视频下载、合并或转码；稍后也可在设置中找回此提醒。' : downloading ? '关闭提醒后继续下载。下载完成不会自动安装，可在设置中找回进度。' : version ? (state.supported ? '在应用内下载新版，完成后由你决定何时重启安装。关闭提醒可继续使用当前版本。' : state.reason) : updateError ? '可稍后重新检查。' : '已是最新版本。')}</p>
    {downloading && <div className="app-update-progress"><progress max="100" value={percent} aria-label={t("更新下载进度")} /><span>{t(percent)}%</span></div>}
    <div className="app-update-actions">
    {(version || downloaded) && <button type="button" className="btn btn-primary" disabled={busy || !enabled.current} onClick={() => act(downloaded ? 'installAppUpdate' : state.supported ? 'downloadAppUpdate' : 'openAppUpdate')}>
      {t(installing ? '正在重启…' : downloading ? '正在下载…' : pending ? '请稍候…' : downloaded ? '重启并安装' : state.supported ? '下载更新' : '前往 GitHub 下载')}
    </button>}
    {(!version || updateError) && !busy && <button type="button" className="btn btn-outline" onClick={() => checkNow.current?.(true)}>{t("重新检查")}</button>}
    {(downloading || state.status === 'checking' || pending && actionPending.current === 'downloadAppUpdate') && <button type="button" className="btn btn-outline" disabled={actionPending.current === 'cancelAppUpdate' || !enabled.current} onClick={() => act('cancelAppUpdate')}>{t("取消下载")}</button>}
    {(state.supported || !version) && <button type="button" className="btn btn-outline" disabled={!enabled.current} onClick={() => act('openAppUpdate')}>{t("前往发布页手动下载")}</button>}
    </div>
    {updateError && <p role="alert">{t(updateError)}</p>}
  </section>;
}
