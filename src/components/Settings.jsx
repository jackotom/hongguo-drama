import { t, useLanguage } from '../i18n';
import React, { useState, useEffect, useRef } from 'react';
import { useDanmakuSource, writeDanmakuSource } from './danmakuSource.mjs';
import useDialogKeyboard from './useDialogKeyboard';
import './Settings.css';
import AppearanceSettings from './AppearanceSettings';
import ShortcutSettings from './ShortcutSettings';
import StealthWakeRegion from './StealthWakeRegion.jsx';
import CustomSources from './CustomSources';
import BuiltinSources from './BuiltinSources';
import AnnouncementSettings from './AnnouncementSettings';
import { Settings, Folder, Check, Globe, X, RefreshCw, AlertCircle } from './icons';


const FORMAT_PRESETS = [
  { label: '剧名_第N集', value: '剧名 集数' },
  { label: '剧名_第N集_标题', value: '剧名 集数 标题' },
];

const PROXY_MODES = [
  { value: 'system', label: '跟随系统', desc: '接口与下载读取启动环境代理；发现页等浏览器请求使用系统代理' },
  { value: 'custom', label: '手动指定', desc: '填写 HTTP/HTTPS 代理地址与端口，忽略环境变量中的绕过规则（NO_PROXY）' },
  { value: 'direct', label: '强制直连', desc: '忽略一切代理，直接连接' },
];

// 常见代理软件默认端口，方便一键填入
const PORT_PRESETS = [
  { label: 'Clash / Mihomo', port: 7890 },
  { label: 'V2rayN', port: 10809 },
  { label: 'Shadowsocks', port: 1080 },
  { label: 'Burp / 抓包', port: 8080 },
];

/** 已保存设置 -> 当前生效的代理描述 */
function describeProxy(settings) {
  if (!settings || settings.proxy_enabled !== true) {
    return { on: false, text: '未启用（所有请求直连）' };
  }
  const mode = settings.proxy_mode || 'system';
  if (mode === 'direct') {
    return { on: false, text: '已开启但模式为「强制直连」' };
  }
  if (mode === 'custom') {
    const host = (settings.proxy_host || '').trim();
    const port = (settings.proxy_port || '').toString().trim();
    if (!host) return { on: false, text: '已开启，但未填写代理地址' };
    return { on: true, text: `${host}${port ? ':' + port : ''}` };
  }
  return { on: true, text: '接口/下载跟随启动环境，浏览器跟随系统' };
}

function SettingsPage({ active = true, preview = false, appInfo = null, wakeRegionFocus = 0 }) {
  useLanguage();
  const danmakuSource = useDanmakuSource();
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pictureModeSaving, setPictureModeSaving] = useState(false);
  const [pictureModeNotice, setPictureModeNotice] = useState('');
  const [pictureModeError, setPictureModeError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState('');
  const testVersion = useRef(0);
  const savingRef = useRef(false);
  const pictureModeRequest = useRef({ pending: false, version: 0 });
  const editedKeys = useRef(new Set());
  const savedTimer = useRef(null);

  const loadSettings = async () => {
    setLoadError('');
    try { setSettings({ download_quality: 'auto', picture_in_picture_mode: 'custom', ...await window.electronAPI.getSettings() }); }
    catch (error) { setLoadError(error.message || '设置加载失败，请重试'); }
  };

  // 重新进入设置页时同步播放器里刚改过的共享选项；保留用户未保存的字段。
  const refreshSettings = async () => {
    if (savingRef.current) return;
    const modeVersion = pictureModeRequest.current.version;
    try {
      const fresh = { download_quality: 'auto', picture_in_picture_mode: 'custom', ...await window.electronAPI.getSettings() };
      setSettings(prev => {
        if (!prev) return fresh;
        const merged = { ...fresh };
        for (const key of editedKeys.current) {
          if (Object.hasOwn(prev, key)) merged[key] = prev[key];
        }
        if (pictureModeRequest.current.pending || modeVersion !== pictureModeRequest.current.version) {
          merged.picture_in_picture_mode = prev.picture_in_picture_mode;
        }
        return merged;
      });
      setLoadError('');
    } catch (error) {
      setLoadError(error.message || '设置加载失败，请重试');
    }
  };

  useEffect(() => () => { testVersion.current++; clearTimeout(savedTimer.current); }, []);

  useEffect(() => {
    if (!active) {
      testVersion.current++;
      setTesting(false);
      setTestResult(null);
      return;
    }
    void refreshSettings();
  }, [active]);

  const update = (key, value) => {
    editedKeys.current.add(key);
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setDirty(true);
    setSaveError('');
  };

  const changePictureInPictureMode = async (event) => {
    const mode = event.target.value;
    const request = pictureModeRequest.current;
    if (!['native', 'custom'].includes(mode) || request.pending) return;
    request.pending = true;
    request.version++;
    const previous = settings.picture_in_picture_mode === 'native' ? 'native' : 'custom';
    setSettings(prev => ({ ...prev, picture_in_picture_mode: mode }));
    setPictureModeSaving(true);
    setPictureModeNotice('');
    setPictureModeError('');
    try {
      const result = await window.electronAPI.saveSettings({ picture_in_picture_mode: mode });
      if (!result?.success) throw new Error(result?.error || '画中画小窗设置保存失败，请重试');
      setPictureModeNotice('已自动保存，下次开启悬浮窗时生效');
    } catch (error) {
      setSettings(prev => ({ ...prev, picture_in_picture_mode: previous }));
      setPictureModeError(error.message || '画中画小窗设置保存失败，请重试');
    } finally {
      request.pending = false;
      request.version++;
      setPictureModeSaving(false);
    }
  };

  const selectFolder = async () => {
    try {
      const dir = await window.electronAPI.selectFolder();
      if (dir) update('root', dir);
    } catch (error) { setSaveError(error.message || '文件夹选择失败，请重试'); }
  };

  const persist = async (next, isProxy = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError('');
    try {
      // Submit only edited fields; the main process merges newer playback options.
      const editable = ['root', 'name_format', 'download_quality', 'download_metadata', 'cache_next_episode', 'compat_mode', 'auto_delete_watched', 'show_danmaku_controls', 'max_concurrent', 'proxy_enabled', 'proxy_mode', 'proxy_host', 'proxy_port', 'proxy_username', 'proxy_password', 'watch_updates_enabled', 'watch_sequels_enabled', 'watch_notifications_enabled', 'search_app_enabled', 'app_updates_enabled'];
      const submitted = {};
      for (const key of editable) {
        if (Object.hasOwn(next, key) && (editedKeys.current.has(key) || isProxy && key.startsWith('proxy_'))) submitted[key] = next[key];
      }
      if (isProxy) submitted.clear_proxy_password = next.clear_proxy_password === true && !String(next.proxy_password || '');
      const res = await window.electronAPI.saveSettings(submitted);
      if (!res?.success) throw new Error(res?.error || '设置未保存，请重试');
      if (isProxy) closeProxy();
      const saved = await window.electronAPI.getSettings();
      setSettings(saved);
      window.dispatchEvent(new CustomEvent('hongguo-playback-settings', { detail: saved }));
      editedKeys.current.clear();
      setDirty(false);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setSaveError(error.message || '设置保存失败，请重试');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const save = () => persist(settings);

  const closeProxy = () => {
    testVersion.current++;
    setTesting(false);
    setProxyOpen(false);
    setProxyDraft(null);
    setTestResult(null);
  };

  // ===== 代理弹窗 =====
  const openProxyModal = () => {
    testVersion.current++;
    setProxyDraft({
      proxy_enabled: settings.proxy_enabled === true,
      proxy_mode: settings.proxy_mode || 'system',
      proxy_host: settings.proxy_host || '127.0.0.1',
      proxy_port: settings.proxy_port || 7890,
      proxy_username: settings.proxy_username || '',
      proxy_password: '',
      clear_proxy_password: false,
    });
    setTestResult(null);
    setSaveError('');
    setProxyOpen(true);
  };

  const patchDraft = (key, value) => {
    testVersion.current++;
    setProxyDraft((prev) => ({ ...prev, [key]: value }));
    setTesting(false);
    setTestResult(null);
  };

  const runTest = async () => {
    const request = ++testVersion.current;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.electronAPI.testProxy(proxyDraft);
      if (request === testVersion.current) setTestResult(res);
    } catch (e) {
      if (request === testVersion.current) setTestResult({ success: false, error: e.message });
    } finally {
      if (request === testVersion.current) setTesting(false);
    }
  };

  const applyProxy = () => persist({ ...settings, ...proxyDraft }, true);

  useDialogKeyboard(active && proxyOpen, () => { if (!savingRef.current) closeProxy(); }, '.proxy-modal');

  if (!settings) {
    return <div className="settings-container">{t(loadError ? <div role="alert"><p>{t(loadError)}</p><button className="btn btn-outline" onClick={loadSettings}>{t("重新加载")}</button></div> : '加载中...')}</div>;
  }

  const proxyInfo = describeProxy(settings);
  const mode = proxyDraft ? proxyDraft.proxy_mode : 'system';

  return (
    <div className="settings-container">
      <div className="settings-header">
        <Settings size={22} />
        <div><h2>{t("设置")}</h2><p className="page-description">{t("让下载、保存和网络连接，按你的习惯运行。")}</p></div>
      </div>

      <section className="settings-card" aria-label={t("外观设置")}><AppearanceSettings active={active} /></section>
      <fieldset className="settings-card" disabled={saving} aria-label={t("网络代理")}>
        <div className="settings-group">
          <label className="settings-label">{t("网络代理")}</label>
          <div className="proxy-status-row">
            <span className={`proxy-dot ${proxyInfo.on ? 'proxy-dot-on' : 'proxy-dot-off'}`} />
            <span className="proxy-status-text">
              {t(proxyInfo.on ? <>{t("已启用：")}<code>{proxyInfo.text}</code></> : proxyInfo.text)}
            </span>
            <button className="btn btn-outline btn-sm" onClick={openProxyModal}>
              <Globe size={15} />{t("配置代理")}</button>
          </div>
          <p className="settings-hint">{t("手动代理用于接口、下载和应用内浏览器；跟随系统时，接口与下载读取启动时的环境代理及绕过规则，发现页等浏览器请求使用系统代理。保存后立即生效。")}</p>
        </div>

      </fieldset>
      <ShortcutSettings active={active} />
      <section className="settings-card" aria-label={t("画中画小窗设置")}>
        <div className="settings-group">
          <label className="settings-label" htmlFor="picture-in-picture-mode">{t("画中画小窗")}</label>
          <select id="picture-in-picture-mode" className="input-field select-field"
            value={settings.picture_in_picture_mode === 'native' ? 'native' : 'custom'}
            disabled={!active || saving || pictureModeSaving}
            aria-describedby="picture-in-picture-mode-hint"
            onChange={changePictureInPictureMode}>
            <option value="native">{t("系统原生")}</option>
            <option value="custom">{t("应用自带")}</option>
          </select>
          <p className="settings-hint" id="picture-in-picture-mode-hint">{t("选择立即自动保存。已打开的小窗不会被中断或切换，下次开启时生效。系统原生使用操作系统的画中画能力；应用自带可显示当前剧名，并支持返回主窗口。")}</p>
          {(pictureModeSaving || pictureModeNotice) && <p className="settings-hint" role="status">{t(pictureModeSaving ? '正在保存…' : pictureModeNotice)}</p>}
          {pictureModeError && <p className="appearance-error" role="alert">{t(pictureModeError)}</p>}
        </div>
      </section>
      {window.electronAPI.platform !== 'android' && <section className="settings-card" aria-label={t('小窗模式')}>
        <StealthWakeRegion active={active} focusRequest={wakeRegionFocus} />
      </section>}
      <BuiltinSources />
      <CustomSources active={active} />
      <p className="settings-hint">{t("播放页顶部可开启小窗模式：窗口缩小、置顶并在支持的系统上跨虚拟桌面可见；鼠标移开时暂停隐藏，移回继续，Esc 或 Dock 可恢复主窗口。")}</p>
      <fieldset className="settings-card" disabled={saving}>
        <div className="settings-group">
          <span className="settings-label">{t("播放与缓存")}</span>
          <label className="proxy-switch-row"><input type="checkbox" checked={settings.cache_next_episode !== false} onChange={event => update('cache_next_episode', event.target.checked)} /><span className="proxy-switch-text">{t("缓存后续 2 集")}<em>{t("开始播放后最多预取接下来两集可在线播放的分集，减少连续切集等待；会使用网络流量。")}</em></span></label>
          <label className="proxy-switch-row"><input type="checkbox" checked={settings.compat_mode !== false} onChange={event => update('compat_mode', event.target.checked)} /><span className="proxy-switch-text">{t("自动兼容模式")}<em>{t("无法解码时尝试转码播放，解决部分黑屏有声问题。")}</em></span></label>
          <label className="proxy-switch-row"><input type="checkbox" checked={settings.auto_delete_watched === true} onChange={event => update('auto_delete_watched', event.target.checked)} /><span className="proxy-switch-text">{t("看完自动删除")}<em>{t("看完一集后删除该集已下载的视频、在线播放缓存和转码缓存。下载文件会永久删除；需要时可重新下载。保存后生效。")}</em></span></label>
          <label className="proxy-switch-row"><input type="checkbox" aria-label={t("优先使用红果 App 搜索")} checked={settings.search_app_enabled === true} onChange={event => update('search_app_enabled', event.target.checked)} /><span className="proxy-switch-text">{t("优先使用红果 App 搜索")}<em>{t("失败或空结果自动回退官网；关闭此项时，官网不可用仍会尝试 App 备用搜索。")}</em></span></label>
        </div>
        <div className="settings-group">
          <span className="settings-label">{t("弹幕按钮设置")}</span>
          <div className="settings-inline-save">
          <label className="proxy-switch-row"><input type="checkbox" aria-label={t("显示弹幕按钮")} checked={settings.show_danmaku_controls !== false} onChange={event => update('show_danmaku_controls', event.target.checked)} /><span className="proxy-switch-text">{t("显示弹幕按钮")}<em>{t("保存后生效。关闭时隐藏弹幕及弹幕设置按钮，并停用弹幕；再次开启会恢复原有弹幕偏好。")}</em></span></label>
            <button type="button" className="btn btn-primary" aria-label={t("保存当前设置")} onClick={save}>{t(saving ? '保存中…' : saved ? '已保存' : '保存')}</button>
          </div>
        </div>
        <div className="settings-group">
          <label className="settings-label" htmlFor="danmaku-source">{t("弹幕来源")}</label>
          <select id="danmaku-source" className="input-field select-field" value={danmakuSource} onChange={event => writeDanmakuSource(event.target.value)}>
            <option value="official">{t("时间轴弹幕")}</option><option value="comments">{t("本集评论（备用）")}</option>
          </select>
          <p className="settings-hint">{t("切换立即生效，仅请求所选来源。时间轴弹幕跟随视频进度；本集评论依次展示，与视频时间无对应。两种来源共用显示偏好。")}</p>
          <button type="button" className="btn btn-outline btn-sm" onClick={async () => {
            try {
              const result = await window.electronAPI.openExternalUrl('https://github.com/dawei233/hongguo-drama');
              if (result?.success === false) throw new Error(result.error || '来源链接打开失败');
            } catch (error) { setSaveError(error.message || '来源链接打开失败'); }
          }}>{t("弹幕实现参考 dawei233/hongguo-drama（GPL-3.0）")}</button>
        </div>
        <div className="settings-group">
          <label className="settings-label">{t("下载目录")}</label>
          <div className="folder-row">
            <input
              type="text"
              className="input-field"
              aria-label={t("下载目录")}
              value={settings.root || ''}
              onChange={(e) => update('root', e.target.value)}
              placeholder={t("选择下载保存目录")}
            />
            <button className="btn btn-outline" onClick={selectFolder}>
              <Folder size={16} />{t("选择文件夹")}</button>
          </div>
          <p className="settings-hint">{t("文件将保存到 ")}<code>{t("下载目录/红果短剧/剧名/")}</code>{t(" 下")}</p>
          <label className="proxy-switch-row"><input type="checkbox" aria-label={t("普通下载保存整剧资料")} checked={settings.download_metadata === true}
            onChange={event => update('download_metadata', event.target.checked)} /><span className="proxy-switch-text">{t("普通下载保存整剧资料")}<em>{t("自动随视频保存封面、简介和 tvshow.nfo，不生成分集 NFO。可将下载目录设为已挂载的 NAS，程序会自动建剧名文件夹，无需再使用“下载到 NAS”。普通下载仍遵循看完自动删除设置。")}</em></span></label>
        </div>

        <div className="settings-group">
          <label className="settings-label">{t("文件命名规则")}</label>
          <div className="preset-row">
            {FORMAT_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`btn-chip ${settings.name_format === p.value ? 'btn-chip-primary' : ''}`}
                onClick={() => update('name_format', p.value)}
              >
                {t(p.label)}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="input-field mt8"
            aria-label={t("文件命名规则")}
            value={settings.name_format || ''}
            onChange={(e) => update('name_format', e.target.value)}
          />
          <p className="settings-hint">{t("可用变量：")}<code>{t("剧名")}</code> · <code>{t("集数")}</code>{t("（如 001）· ")}<code>{t("标题")}</code>{t("。每集保留独立集号，避免同名覆盖。")}</p>
        </div>

        <div className="settings-group">
          <label className="settings-label" htmlFor="default-download-quality">{t("默认下载清晰度")}</label>
          <select id="default-download-quality" className="input-field select-field"
            value={settings.download_quality || 'auto'} aria-describedby="default-download-quality-hint"
            onChange={(event) => update('download_quality', event.target.value)}>
            <option value="auto">{t("自动（兼容优先）")}</option>
            <option value="1080p">1080P</option>
            <option value="720p">720P</option>
          </select>
          <p className="settings-hint" id="default-download-quality-hint">{t("保存后用于新建下载任务，也可在下载时单独选择。红果片源所选清晰度不可用或下载失败时，自动尝试更低清晰度，并在下载管理中提示；已有文件不自动删除或覆盖。")}</p>
        </div>

        <div className="settings-group">
          <label className="settings-label">{t("最大并发下载数")}</label>
          <select
            className="input-field select-field"
            aria-label={t("最大并发下载数")}
            value={settings.max_concurrent || 3}
            onChange={(e) => update('max_concurrent', parseInt(e.target.value, 10))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>{t(n)}{t(" 个同时下载")}</option>
            ))}
          </select>
          <p className="settings-hint">{t("同时下载 ")}<b>{settings.max_concurrent || 3}</b>{t(" 集（保存后立即生效）。 并发越高越快，但可能触发接口限流，建议 3~5。")}</p>
        </div>


        <div className="settings-group">
          <span className="settings-label">{t("追剧提醒")}</span>
          <label className="proxy-switch-row"><input type="checkbox" checked={settings.watch_updates_enabled !== false} onChange={event => update('watch_updates_enabled', event.target.checked)} /><span className="proxy-switch-text">{t("自动检查新集")}<em>{t("应用运行期间，每部剧约 6 小时检查一次；列表较多时分批检查")}</em></span></label>
          <label className="proxy-switch-row"><input type="checkbox" checked={settings.watch_sequels_enabled !== false} onChange={event => update('watch_sequels_enabled', event.target.checked)} /><span className="proxy-switch-text">{t("查找疑似新一季")}<em>{t("约每天按剧名搜索一次，仅提示同名且季数更高的剧；可能遗漏或误报")}</em></span></label>
          <label className="proxy-switch-row"><input type="checkbox" checked={settings.watch_notifications_enabled === true} onChange={event => update('watch_notifications_enabled', event.target.checked)} /><span className="proxy-switch-text">{t("发送系统通知")}<em>{t("默认关闭。开启后还需允许 macOS 通知；关闭不影响观看记录红点")}</em></span></label>
        </div>

        <div className="settings-group">
          <span className="settings-label">{t("配置文件位置")}</span>
          {settings.proxy_password_warning && <p className="alert alert-error" role="alert">{t(settings.proxy_password_warning)}</p>}
          <p className="settings-hint">{t("代理密码由本机系统安全存储加密；更换电脑后可能需要重新输入。")}</p>
          <p className="settings-hint settings-path"><code>{t(appInfo?.dataDir || '系统配置目录')}</code></p>
          {appInfo?.configNote
            ? <p className="settings-hint" role="status">{t(appInfo.configNote)}</p>
            : <p className="settings-hint">{t(appInfo?.configMode === 'portable'
              ? '便携版：设置、下载记录与界面数据保存在程序目录的 data 文件夹；从旧版本切换时，原系统目录里的搜索历史不会自动带入。移动或备份程序时请连同该文件夹一起保留。'
              : '设置、下载记录与界面数据保存在系统用户目录；更换电脑时可复制这个文件夹。')}</p>}
        </div>

        {preview ? <>
        <div className="settings-group">
          <span className="settings-label">{t("独立预览")}</span>
          <p className="settings-hint">{t("预览数据独立保存，不接收正式版更新，不会覆盖已安装的红果短剧。")}</p>
        </div>
        </> : <>
        <div className="settings-group">
          <span className="settings-label">{t("检测更新")}</span>
          <label className="proxy-switch-row"><input type="checkbox" aria-label={t("自动检测更新")} checked={settings.app_updates_enabled !== false} onChange={event => update('app_updates_enabled', event.target.checked)} /><span className="proxy-switch-text">{t("自动检测更新")}<em>{t("启动时及运行期间每 6 小时检查正式新版。保存后生效；下载和重启安装都由你点击确认。")}</em></span></label>
          <button type="button" className="btn btn-outline" disabled={settings.app_updates_enabled === false} onClick={() => window.dispatchEvent(new CustomEvent('hongguo-check-app-update'))}><RefreshCw size={15} />{t("检查更新")}</button>
          <p className="settings-hint">{t("可重新打开已关闭的更新提醒、查看下载进度或安装已下载的新版。关闭检测后需重新开启并保存。")}</p>
        </div>
        </>}

        {!preview && <AnnouncementSettings />}

        <div className="settings-footer">
          {dirty && <span className="settings-hint" role="status">{t("有未保存的修改")}</span>}
          <button className="btn btn-primary" onClick={save}>
            {t(saving ? '正在保存…' : saved ? <><Check size={16} />{t(" 已保存")}</> : '保存设置')}
          </button>
        </div>
        {saveError && !proxyOpen && <p className="alert alert-error" role="alert">{t(saveError)}</p>}
      </fieldset>

      {proxyOpen && proxyDraft && (
        <div className="proxy-modal-mask" onClick={() => !saving && closeProxy()}>
          <div className="proxy-modal" role="dialog" aria-modal="true" aria-label={t("网络代理设置")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="proxy-modal-head">
              <div className="proxy-modal-title">
                <Globe size={18} />
                <span>{t("网络代理设置")}</span>
              </div>
              <button className="icon-btn" title={t("关闭")} disabled={saving} onClick={closeProxy}>
                <X size={16} />
              </button>
            </div>

            <fieldset className="proxy-modal-body" disabled={saving}>
              <label className="proxy-switch-row">
                <input
                  type="checkbox"
                  checked={proxyDraft.proxy_enabled}
                  onChange={(e) => patchDraft('proxy_enabled', e.target.checked)}
                />
                <span className="proxy-switch-text">{t("启用代理")}<em>{t("关闭时代理不生效，所有请求直连")}</em>
                </span>
              </label>

              <div className={`proxy-fields ${proxyDraft.proxy_enabled ? '' : 'proxy-fields-disabled'}`}>
                <div className="settings-group">
                  <label className="settings-label">{t("代理模式")}</label>
                  <div className="proxy-mode-list">
                    {PROXY_MODES.map((m) => (
                      <label
                        key={m.value}
                        className={`proxy-mode-item ${mode === m.value ? 'active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="proxy_mode"
                          value={m.value}
                          checked={mode === m.value}
                          disabled={!proxyDraft.proxy_enabled}
                          onChange={() => patchDraft('proxy_mode', m.value)}
                        />
                        <span className="proxy-mode-body">
                          <b>{t(m.label)}</b>
                          <em>{t(m.desc)}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">{t("代理地址")}</label>
                    <div className="proxy-host-row">
                      <input
                        type="text"
                        className="input-field"
                        aria-label={t("代理服务器地址")}
                        placeholder="127.0.0.1"
                        value={proxyDraft.proxy_host}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_host', e.target.value)}
                      />
                      <span className="proxy-colon">:</span>
                      <input
                        type="number"
                        className="input-field proxy-port"
                        aria-label={t("代理端口")}
                        placeholder="7890"
                        min="1"
                        max="65535"
                        value={proxyDraft.proxy_port}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_port', e.target.value)}
                      />
                    </div>
                    <div className="preset-row mt8">
                      {PORT_PRESETS.map((p) => (
                        <button
                          key={p.port}
                          type="button"
                          className="btn-chip"
                          disabled={!proxyDraft.proxy_enabled}
                          onClick={() => patchDraft('proxy_port', p.port)}
                        >
                          {t(p.label)} {t(p.port)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">{t("代理认证（可选）")}</label>
                    <div className="proxy-auth-row">
                      <input
                        type="text"
                        className="input-field"
                        aria-label={t("代理用户名")}
                        placeholder={t("用户名")}
                        autoComplete="off"
                        value={proxyDraft.proxy_username}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_username', e.target.value)}
                      />
                      <input
                        type="password"
                        className="input-field"
                        aria-label={t("代理密码")}
                        placeholder={t(settings.proxy_password_set ? '已保存，留空表示不修改' : '密码')}
                        autoComplete="new-password"
                        value={proxyDraft.proxy_password}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => {
                          patchDraft('proxy_password', e.target.value);
                          if (e.target.value) patchDraft('clear_proxy_password', false);
                        }}
                      />
                    </div>
                    <p className="settings-hint">{t(proxyDraft.clear_proxy_password ? '保存后将清除已保存的密码。' : settings.proxy_password_set ? '已保存密码。输入新密码可替换；留空则保持不变。' : '代理无需认证时留空即可')}</p>
                    {settings.proxy_password_set && <button type="button" className="btn btn-outline" disabled={!proxyDraft.proxy_enabled} onClick={() => { patchDraft('proxy_password', ''); patchDraft('clear_proxy_password', true); }}>{t("清除已保存密码")}</button>}
                  </div>
                )}
              </div>

              <p className="settings-hint">{t("测试仅检查接口与下载访问红果官网的连接，不代表发现页等浏览器请求的代理状态。")}</p>
              {testResult && (
                <div className={`proxy-test-result ${testResult.success ? 'ok' : 'fail'}`}>
                  {testResult.success ? <Check size={15} /> : <AlertCircle size={15} />}
                  <span>
                    {t(testResult.success ? testResult.message : testResult.error)}
                    {testResult.success && testResult.via ? t(' · 经由 {0}', [testResult.via === '(直连)' ? t('(直连)') : testResult.via]) : ''}
                  </span>
                </div>
              )}
              {saveError && <p className="alert alert-error" role="alert">{t(saveError)}</p>}
            </fieldset>

            <div className="proxy-modal-foot">
              <button className="btn btn-outline" onClick={runTest} disabled={testing || saving}>
                <RefreshCw size={15} />
                {t(testing ? '测试中...' : '测试连接')}
              </button>
              <div className="proxy-foot-right">
                <button className="btn btn-outline" disabled={saving} onClick={closeProxy}>{t("取消")}</button>
                <button className="btn btn-primary" disabled={saving} onClick={applyProxy}>
                  <Check size={15} />
                  {t(saving ? '正在保存…' : '保存并生效')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


export default SettingsPage;
