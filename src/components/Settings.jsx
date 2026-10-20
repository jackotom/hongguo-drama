import React, { useState, useEffect, useRef } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import './Settings.css';
import AppearanceSettings from './AppearanceSettings';
import ShortcutSettings from './ShortcutSettings';
import CustomSources from './CustomSources';
import { Settings, Folder, Check, Globe, X, RefreshCw, AlertCircle } from './icons';


const FORMAT_PRESETS = [
  { label: '剧名_第N集', value: '剧名 集数' },
  { label: '剧名_第N集_标题', value: '剧名 集数 标题' },
];

const PROXY_MODES = [
  { value: 'system', label: '跟随系统', desc: '使用系统 / 环境变量里已有的代理设置' },
  { value: 'custom', label: '手动指定', desc: '自己填写代理地址与端口（支持 HTTP/HTTPS 代理）' },
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
  return { on: true, text: '跟随系统 / 环境变量代理' };
}

function SettingsPage({ active = true, preview = false }) {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState('');
  const testVersion = useRef(0);
  const savingRef = useRef(false);
  const savedTimer = useRef(null);

  const loadSettings = async () => {
    setLoadError('');
    try { setSettings({ download_quality: 'auto', ...await window.electronAPI.getSettings() }); }
    catch (error) { setLoadError(error.message || '设置加载失败，请重试'); }
  };

  useEffect(() => {
    loadSettings();
    return () => { testVersion.current++; clearTimeout(savedTimer.current); };
  }, []);

  useEffect(() => {
    if (!active) { testVersion.current++; setTesting(false); setTestResult(null); }
  }, [active]);

  const update = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setDirty(true);
    setSaveError('');
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
      // Playback options may change while this retained settings page is hidden.
      const current = await window.electronAPI.getSettings();
      const editable = ['root', 'name_format', 'download_quality', 'show_danmaku_controls', 'max_concurrent', 'proxy_enabled', 'proxy_mode', 'proxy_host', 'proxy_port', 'proxy_username', 'proxy_password', 'watch_updates_enabled', 'watch_sequels_enabled', 'watch_notifications_enabled', 'app_updates_enabled'];
      const submitted = { ...current };
      for (const key of editable) if (Object.hasOwn(next, key)) submitted[key] = next[key];
      if (isProxy) submitted.clear_proxy_password = next.clear_proxy_password === true && !String(next.proxy_password || '');
      const res = await window.electronAPI.saveSettings(submitted);
      if (!res?.success) throw new Error(res?.error || '设置未保存，请重试');
      setSettings(submitted);
      if (isProxy) closeProxy();
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
    return <div className="settings-container">{loadError ? <div role="alert"><p>{loadError}</p><button className="btn btn-outline" onClick={loadSettings}>重新加载</button></div> : '加载中...'}</div>;
  }

  const proxyInfo = describeProxy(settings);
  const mode = proxyDraft ? proxyDraft.proxy_mode : 'system';

  return (
    <div className="settings-container">
      <div className="settings-header">
        <Settings size={22} />
        <div><h2>设置</h2><p className="page-description">让下载、保存和网络连接，按你的习惯运行。</p></div>
      </div>

      <section className="settings-card" aria-label="外观设置"><AppearanceSettings /></section>
      <ShortcutSettings active={active} />
      <CustomSources active={active} />
      <p className="settings-hint">播放页顶部可开启隐身小窗。鼠标移开时暂停隐藏，移回继续；Esc 或 Dock 可恢复主窗口。</p>
      <fieldset className="settings-card" disabled={saving}>
        <div className="settings-group">
          <span className="settings-label">弹幕按钮设置</span>
          <div className="settings-inline-save">
          <label className="proxy-switch-row"><input type="checkbox" aria-label="显示弹幕按钮" checked={settings.show_danmaku_controls !== false} onChange={event => update('show_danmaku_controls', event.target.checked)} /><span className="proxy-switch-text">显示弹幕按钮<em>保存后生效。关闭时隐藏弹幕及弹幕设置按钮，并停用评论弹幕；再次开启会恢复原有弹幕偏好。</em></span></label>
            <button type="button" className="btn btn-primary" aria-label="保存当前设置" onClick={save}>{saving ? '保存中…' : saved ? '已保存' : '保存'}</button>
          </div>
        </div>
        <div className="settings-group">
          <label className="settings-label">下载目录</label>
          <div className="folder-row">
            <input
              type="text"
              className="input-field"
              aria-label="下载目录"
              value={settings.root || ''}
              onChange={(e) => update('root', e.target.value)}
              placeholder="选择下载保存目录"
            />
            <button className="btn btn-outline" onClick={selectFolder}>
              <Folder size={16} />
              选择文件夹
            </button>
          </div>
          <p className="settings-hint">文件将保存到 <code>下载目录/红果短剧/剧名/</code> 下</p>
        </div>

        <div className="settings-group">
          <label className="settings-label">文件命名规则</label>
          <div className="preset-row">
            {FORMAT_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`btn-chip ${settings.name_format === p.value ? 'btn-chip-primary' : ''}`}
                onClick={() => update('name_format', p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="input-field mt8"
            aria-label="文件命名规则"
            value={settings.name_format || ''}
            onChange={(e) => update('name_format', e.target.value)}
          />
          <p className="settings-hint">
            可用变量：<code>剧名</code> · <code>集数</code>（如 001）· <code>标题</code>
            。每集保留独立集号，避免同名覆盖。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label" htmlFor="default-download-quality">默认下载清晰度</label>
          <select id="default-download-quality" className="input-field select-field"
            value={settings.download_quality || 'auto'} aria-describedby="default-download-quality-hint"
            onChange={(event) => update('download_quality', event.target.value)}>
            <option value="auto">自动（兼容优先）</option>
            <option value="1080p">1080P</option>
            <option value="720p">720P</option>
          </select>
          <p className="settings-hint" id="default-download-quality-hint">保存后用于新建下载任务，也可在下载时单独选择。所选清晰度不可用时提示，不自动降级；已有文件不自动删除或覆盖。</p>
        </div>

        <div className="settings-group">
          <label className="settings-label">最大并发下载数</label>
          <select
            className="input-field select-field"
            aria-label="最大并发下载数"
            value={settings.max_concurrent || 3}
            onChange={(e) => update('max_concurrent', parseInt(e.target.value, 10))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>{n} 个同时下载</option>
            ))}
          </select>
          <p className="settings-hint">
            同时下载 <b>{settings.max_concurrent || 3}</b> 集（保存后立即生效）。
            并发越高越快，但可能触发接口限流，建议 3~5。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label">网络代理</label>
          <div className="proxy-status-row">
            <span className={`proxy-dot ${proxyInfo.on ? 'proxy-dot-on' : 'proxy-dot-off'}`} />
            <span className="proxy-status-text">
              {proxyInfo.on ? <>已启用：<code>{proxyInfo.text}</code></> : proxyInfo.text}
            </span>
            <button className="btn btn-outline btn-sm" onClick={openProxyModal}>
              <Globe size={15} />
              配置代理
            </button>
          </div>
          <p className="settings-hint">
            本机有代理（Clash / V2rayN 等）时在这里填上，解析剧集与下载视频都会走该代理。保存后立即生效，无需重启。
          </p>
        </div>

        <div className="settings-group">
          <span className="settings-label">追剧提醒</span>
          <label className="proxy-switch-row"><input type="checkbox" checked={settings.watch_updates_enabled !== false} onChange={event => update('watch_updates_enabled', event.target.checked)} /><span className="proxy-switch-text">自动检查新集<em>应用运行期间，每部剧约 6 小时检查一次；列表较多时分批检查</em></span></label>
          <label className="proxy-switch-row"><input type="checkbox" checked={settings.watch_sequels_enabled !== false} onChange={event => update('watch_sequels_enabled', event.target.checked)} /><span className="proxy-switch-text">查找疑似新一季<em>约每天按剧名搜索一次，仅提示同名且季数更高的剧；可能遗漏或误报</em></span></label>
          <label className="proxy-switch-row"><input type="checkbox" checked={settings.watch_notifications_enabled === true} onChange={event => update('watch_notifications_enabled', event.target.checked)} /><span className="proxy-switch-text">发送系统通知<em>默认关闭。开启后还需允许 macOS 通知；关闭不影响观看记录红点</em></span></label>
        </div>

        {preview ? <>
        <div className="settings-group">
          <span className="settings-label">独立预览</span>
          <p className="settings-hint">预览数据独立保存，不接收正式版更新，不会覆盖已安装的红果短剧。</p>
        </div>
        </> : <>
        <div className="settings-group">
          <span className="settings-label">检测更新</span>
          <label className="proxy-switch-row"><input type="checkbox" aria-label="自动检测更新" checked={settings.app_updates_enabled !== false} onChange={event => update('app_updates_enabled', event.target.checked)} /><span className="proxy-switch-text">自动检测更新<em>启动时及运行期间每 6 小时检查正式新版。保存后生效；下载和重启安装都由你点击确认。</em></span></label>
          <button type="button" className="btn btn-outline" disabled={settings.app_updates_enabled === false} onClick={() => window.dispatchEvent(new CustomEvent('hongguo-check-app-update'))}><RefreshCw size={15} />检查更新</button>
          <p className="settings-hint">可重新打开已关闭的更新提醒、查看下载进度或安装已下载的新版。关闭检测后需重新开启并保存。</p>
        </div>
        </>}

        <div className="settings-footer">
          {dirty && <span className="settings-hint" role="status">有未保存的修改</span>}
          <button className="btn btn-primary" onClick={save}>
            {saving ? '正在保存…' : saved ? <><Check size={16} /> 已保存</> : '保存设置'}
          </button>
        </div>
        {saveError && !proxyOpen && <p className="alert alert-error" role="alert">{saveError}</p>}
      </fieldset>

      {proxyOpen && proxyDraft && (
        <div className="proxy-modal-mask" onClick={() => !saving && closeProxy()}>
          <div className="proxy-modal" role="dialog" aria-modal="true" aria-label="网络代理设置" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="proxy-modal-head">
              <div className="proxy-modal-title">
                <Globe size={18} />
                <span>网络代理设置</span>
              </div>
              <button className="icon-btn" title="关闭" disabled={saving} onClick={closeProxy}>
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
                <span className="proxy-switch-text">
                  启用代理
                  <em>关闭时代理不生效，所有请求直连</em>
                </span>
              </label>

              <div className={`proxy-fields ${proxyDraft.proxy_enabled ? '' : 'proxy-fields-disabled'}`}>
                <div className="settings-group">
                  <label className="settings-label">代理模式</label>
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
                          <b>{m.label}</b>
                          <em>{m.desc}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">代理地址</label>
                    <div className="proxy-host-row">
                      <input
                        type="text"
                        className="input-field"
                        aria-label="代理服务器地址"
                        placeholder="127.0.0.1"
                        value={proxyDraft.proxy_host}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_host', e.target.value)}
                      />
                      <span className="proxy-colon">:</span>
                      <input
                        type="number"
                        className="input-field proxy-port"
                        aria-label="代理端口"
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
                          {p.label} {p.port}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">代理认证（可选）</label>
                    <div className="proxy-auth-row">
                      <input
                        type="text"
                        className="input-field"
                        aria-label="代理用户名"
                        placeholder="用户名"
                        autoComplete="off"
                        value={proxyDraft.proxy_username}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_username', e.target.value)}
                      />
                      <input
                        type="password"
                        className="input-field"
                        aria-label="代理密码"
                        placeholder={settings.proxy_password_set ? '已保存，留空表示不修改' : '密码'}
                        autoComplete="new-password"
                        value={proxyDraft.proxy_password}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => {
                          patchDraft('proxy_password', e.target.value);
                          if (e.target.value) patchDraft('clear_proxy_password', false);
                        }}
                      />
                    </div>
                    <p className="settings-hint">{proxyDraft.clear_proxy_password ? '保存后将清除已保存的密码。' : settings.proxy_password_set ? '已保存密码。输入新密码可替换；留空则保持不变。' : '代理无需认证时留空即可'}</p>
                    {settings.proxy_password_set && <button type="button" className="btn btn-outline" disabled={!proxyDraft.proxy_enabled} onClick={() => { patchDraft('proxy_password', ''); patchDraft('clear_proxy_password', true); }}>清除已保存密码</button>}
                  </div>
                )}
              </div>

              {testResult && (
                <div className={`proxy-test-result ${testResult.success ? 'ok' : 'fail'}`}>
                  {testResult.success ? <Check size={15} /> : <AlertCircle size={15} />}
                  <span>
                    {testResult.success ? testResult.message : testResult.error}
                    {testResult.success && testResult.via ? ` · 经由 ${testResult.via}` : ''}
                  </span>
                </div>
              )}
              {saveError && <p className="alert alert-error" role="alert">{saveError}</p>}
            </fieldset>

            <div className="proxy-modal-foot">
              <button className="btn btn-outline" onClick={runTest} disabled={testing || saving}>
                <RefreshCw size={15} />
                {testing ? '测试中...' : '测试连接'}
              </button>
              <div className="proxy-foot-right">
                <button className="btn btn-outline" disabled={saving} onClick={closeProxy}>取消</button>
                <button className="btn btn-primary" disabled={saving} onClick={applyProxy}>
                  <Check size={15} />
                  {saving ? '正在保存…' : '保存并生效'}
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
