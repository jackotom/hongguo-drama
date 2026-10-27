/**
 * main.js - 红果短剧 3.7 下载器（独立版）主进程
 *
 * 功能：
 *   1. 红果短剧解析（分享链接 / series_id -> 全剧集列表）
 *   2. 批量提交下载任务到下载队列
 *   3. 并发下载：流式下载播放直链 -> spade_a 派生 AES Key -> CENC-AES-CTR 解密 -> 输出 mp4
 *   4. 下载管理：进度推送、暂停/取消、重试、删除、打开所在文件夹
 *   5. 设置：下载目录、命名规则、并发数（JSON 文件持久化）
 */
const { app, BrowserWindow, ipcMain: rawIpcMain, dialog, shell, session, protocol, Menu, Notification, screen } = require('electron');
const path = require('path');
const IS_PREVIEW = require('./package.json').name === 'hongguo-experience-preview';
if (IS_PREVIEW) {
  app.setName('红果短剧预览');
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    app.setPath('userData', path.join(app.getPath('appData'), 'hongguo-experience-preview'));
  }
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => app.emit('activate'));
// Windows 便携版：资料跟随程序目录，移动程序时一起带走。
// 迁移必须发生在取得单实例锁之后，避免同一便携目录的两个进程互相清理临时文件。
const { applyPortableDataDir, getPortableDirectory } = require('./src/native/portable-data');
let portableConfig = { mode: 'default', dir: '', reason: '', copied: [],
  portableDir: getPortableDirectory({ env: process.env, platform: process.platform, execPath: process.execPath }) };
if (hasSingleInstanceLock && !IS_PREVIEW && app.commandLine.hasSwitch?.('user-data-dir') !== true) {
  try {
    // 浏览器会话数据也跟随程序目录；applyPortableDataDir 同时设置
    // userData 与 sessionData，失败时把原因留在 portableConfig.reason。
    portableConfig = applyPortableDataDir({ app, defaultUserData: app.getPath('userData'), execPath: process.execPath });
    if (portableConfig.copied?.length) console.log('[Config] 已迁移便携版资料:', portableConfig.copied.join(', '));
    if (portableConfig.reason) console.warn('[Config]', portableConfig.reason);
  } catch (error) {
    console.warn('[Config] 便携版资料目录不可用:', error.message);
  }
}
const fs = require('fs');
const fsp = require('fs/promises');
const axios = require('axios');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID, createHash } = require('node:crypto');

const hongguo = require('./src/native/hongguo');
const { normalizeDownloadQuality, meetsDownloadQuality } = require('./src/native/download-quality');
const { decryptInWorker } = require('./src/native/decrypt-worker.cjs');
const store = require('./src/store');
const watchHistory = require('./src/native/watch-history');
const seriesSearch = require('./src/native/series-search');
const { searchHongguo } = require('./src/native/hongguo-search');
const { fitWindowBounds, getWindowScale, saveWindowZoom } = require('./src/native/window-layout');
const { createEpisodePanelController } = require('./src/native/episode-panel');
const { availableRelease } = require('./src/native/app-update');
const { fetchPublicDetails } = require('./src/native/public-details');
const { fetchEpisodeComments } = require('./src/native/episode-comments');
const { fetchDanmaku, setDeviceIdentityFile } = require('./src/native/danmaku');
const { exportSeriesText } = require('./src/native/text-export');
const mediaAccess = require('./src/native/media-access').createMediaAccess(process.env.VITE_DEV_SERVER_URL);
const rendererSecurity = require('./src/native/renderer-security').createRendererSecurity(
  path.join(__dirname, 'dist-react', 'index.html'), process.env.VITE_DEV_SERVER_URL);
const APP_VERSION = app.getVersion() || '1.0.0';

const APP_TITLE = IS_PREVIEW ? '红果短剧预览' : '红果短剧';
const { createStealthController } = require('./src/native/stealth-window');

let mainWindow = null;
let appUpdateInstaller = null;
let appUpdater = null;
let updateDownloadGeneration = 0;
let pendingUpdateOperations = 0;
let quitCleanup = null;
let quitReady = false;
let mergeTempCleanup = null;
const UPDATE_BLOCKED_CHANNELS = new Set(['hongguo-download-batch', 'download-single-episode', 'retry-task', 'retry-tasks', 'resume-all', 'merge-series', 'transcode-for-playback', 'prepare-online-play', 'save-settings']);
const ipcMain = {
  handle(channel, handler) {
    rawIpcMain.handle(channel, async (event, ...args) => {
      if (!rendererSecurity.isTrustedSender(event, mainWindow)) throw new Error('窗口请求无效');
      if (quitCleanup) return { success: false, error: '正在退出，请等待清理完成。' };
      if (appUpdateInstaller?.getState().status === 'installing' && UPDATE_BLOCKED_CHANNELS.has(channel)) {
        return { success: false, error: '正在安装更新，请等待应用重新启动。' };
      }
      const blocksUpdate = UPDATE_BLOCKED_CHANNELS.has(channel);
      if (blocksUpdate) pendingUpdateOperations++;
      try { return await handler(event, ...args); }
      finally { if (blocksUpdate) pendingUpdateOperations--; }
    });
  },
};
let storageError = null;
store.setErrorHandler?.(payload => {
  storageError = payload;
  sendToRenderer('storage-error', payload);
});

// ===== 视频解码兼容性 =====
// 平台视频是 HEVC(bytevc1)，Chromium 在 Windows 上只能靠硬件解码 HEVC。
// 若显卡不支持、或被 Chromium 的 GPU 黑名单挡掉，就会出现「黑屏但有声音」。
// 这里主动开启平台 HEVC 解码并放宽黑名单，能救回相当一部分机器；
// 仍然不行的，由「兼容模式转码」兜底（见 transcodeForPlayback）。
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 允许在无硬件解码时也尽量使用平台解码器
app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');


// ===== 在线播放：自定义流协议（内存缓存 + Range 支持）=====
// 明文片源按播放器 Range 请求直接流式供给；加密片源仍先下载解密。
// CDN 地址只在主进程保存，渲染器使用随机会话地址。
const STREAM_SCHEME = 'hongguo-stream';
// 本地已下载文件的播放协议。
// 不能在开发模式下直接用 file:// —— 渲染页面来自 http://localhost:5173，
// Chromium 会以「Not allowed to load local resource」拒绝（表现为播放器黑屏、0:00）。
// 因此改由主进程用 Node 读文件并通过自定义协议供给，带 Range 支持以便拖动进度。
//
// 注意：这两个 scheme 刻意不开 bypassCSP —— 视频能否加载由 index.html 的 CSP 白名单
// 决定（media-src / connect-src 必须显式列出 hongguo-stream: 与 hongguo-local:）。
// 用 bypassCSP 绕开自家 CSP 会白白丢掉一层防护，属于掩盖配置疏漏，不要再加回来。
const LOCAL_SCHEME = 'hongguo-local';
protocol.registerSchemesAsPrivileged([
  {
    scheme: STREAM_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  {
    scheme: LOCAL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

/** vid -> { buffer, size, lastUsed, seriesId, vidIndex } */
const onlineCache = new Map();
const ONLINE_MAX_BYTES = 300 * 1024 * 1024; // 单集整块读取及缓存淘汰预算，不是进程总内存上限
const onlinePreparing = new Map(); // vid -> shared preparation + abort controller
const onlineWork = new Set(); // Includes canceled work until its resource cleanup finishes.

function trackOnlineWork(controller, promise) {
  const job = { controller, promise };
  onlineWork.add(job);
  return promise.finally(() => onlineWork.delete(job));
}
const onlineSessions = new Map(); // opaque stream ID -> playback lifetime

function onlineCacheTotal() {
  let t = 0;
  for (const e of onlineCache.values()) t += e.size;
  return t;
}

function trimOnlineCache() {
  let total = onlineCacheTotal();
  while (total > ONLINE_MAX_BYTES && onlineCache.size > 1) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, e] of onlineCache) {
      if (e.lastUsed < oldest) { oldest = e.lastUsed; oldestKey = k; }
    }
    if (!oldestKey) break;
    total -= onlineCache.get(oldestKey).size;
    deleteOnlineCacheEntry(oldestKey);
  }
}

function releaseOnlineSession(id) {
  const session = onlineSessions.get(id);
  if (!session) return;
  onlineSessions.delete(id);
  disposeOnlineDisk(session.entry);
  for (const controller of session.requests) controller.abort();
  const pending = session.job;
  if (pending && ![...onlineSessions.values()].some(s => s.job === pending)) {
    pending.controller.abort();
    if (onlinePreparing.get(session.cacheKey || session.vid) === pending) onlinePreparing.delete(session.cacheKey || session.vid);
  }
}

function clearOnlineCache() {
  for (const id of [...onlineSessions.keys()]) releaseOnlineSession(id);
  for (const key of [...onlineCache.keys()]) deleteOnlineCacheEntry(key);
}




function disposeOnlineDisk(entry) {
  if (!entry?.disk || entry.disk.readers || [...onlineCache.values()].some(e => e.disk === entry.disk)
    || [...onlineSessions.values()].some(s => s.entry?.disk === entry.disk)) return;
  try { fs.rmSync(entry.disk.directory, { recursive:true, force:true }); } catch (_) {}
}
function deleteOnlineCacheEntry(key) {
  const entry = onlineCache.get(key); onlineCache.delete(key); disposeOnlineDisk(entry);
}
function checkCustomAccess(vid) {
  if (String(vid).startsWith('custom:')) require('./src/native/custom-source').assertEnabled(vid);
}
async function prepareHlsFile(playInfo, output, options = {}) {
  try { return await require('./src/native/hls-media').remuxHls({ url:playInfo.url, output, ffmpeg:resolveFfmpeg('ffmpeg'),
    headers:{ ...(playInfo.userAgent ? {'User-Agent':playInfo.userAgent} : {}), ...(playInfo.referer ? {Referer:playInfo.referer} : {}) },
    ...options, checkAccess:() => checkCustomAccess(playInfo.vid) }); }
  catch (error) {
    checkCustomAccess(playInfo.vid);
    if (!options.signal?.aborted && !options.cancelToken?.reason) error.mediaRetryable = true;
    throw error;
  }
}

// ===== 下载任务管理 =====
let downloadTasks = [];
let downloadQueue = [];
let activeDownloads = 0;
const runningDownloads = new Set();
const runningDownloadPaths = new Set();
const downloadRuns = new Map();
let MAX_CONCURRENT_DOWNLOADS = 3;

// ===== 设置 =====
function getDefaultSettings() {
  return {
    root: IS_PREVIEW ? path.join(app.getPath('userData'), 'downloads') : app.getPath('downloads'),
    // 文件命名模板：可用变量 剧名(series_title) 集数(vid_index) 标题(ep_title)
    name_format: '剧名 集数',
    max_concurrent: 3,
    download_quality: 'auto',
    custom_sources: [],
    // 看完一集后自动删除本地文件（边看边清，避免占用磁盘）
    auto_delete_watched: false,
    // 兼容模式：本机无法解码 HEVC 时自动转码为 H.264（解决「黑屏有声」）
    compat_mode: true,
    cache_next_episode: true,
    app_updates_enabled: !IS_PREVIEW,
    watch_updates_enabled: true,
    watch_sequels_enabled: true,
    watch_notifications_enabled: false,
    // 实验：红果 App 搜索优先；失败/空结果自动回退官网 API。
    search_app_enabled: false,
    // ===== 网络代理 =====
    // proxy_enabled: 是否启用代理（关闭时忽略系统代理，直连）
    // proxy_mode:    system=跟随系统/环境变量 · custom=手动指定 · direct=强制直连
    proxy_enabled: false,
    proxy_mode: 'system',
    proxy_host: '127.0.0.1',
    proxy_port: 7890,
    proxy_username: '',
    proxy_password: '',
  };
}

// 启动时记下系统/终端原来的代理。之后 direct/custom 会改写这些变量，
// 「跟随系统」必须读这份快照，否则会把上一次的直连或手动代理当成系统代理。
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const originalProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
let activeProxyAuth = null;
const sessionProxyConfigs = new WeakMap();
let proxyApplyVersion = 0;
let desiredProxyConfig = null;

// proxy-from-env 2.1.0 没有 env 参数；按相同规则解析启动快照，测试与真实依赖逐例对照。
function snapshotProxyUrl(targetUrl = 'https://www.baidu.com') {
  let target;
  try { target = new URL(targetUrl); } catch (_) { return null; }
  if (!target.host) return null;
  const protocol = target.protocol.split(':', 1)[0];
  const hostname = target.host.replace(/:\d*$/, '');
  const port = parseInt(target.port) || { ftp: 21, gopher: 70, http: 80, https: 443, ws: 80, wss: 443 }[protocol] || 0;
  const env = key => originalProxyEnv[key.toLowerCase()] || originalProxyEnv[key.toUpperCase()] || '';
  const bypass = env('no_proxy').toLowerCase();
  if (bypass === '*') return null;
  if (bypass && bypass.split(/[,\s]/).some(entry => {
    if (!entry) return false;
    const match = entry.match(/^(.+):(\d+)$/);
    const host = match ? match[1] : entry;
    const bypassPort = match ? parseInt(match[2]) : 0;
    if (bypassPort && bypassPort !== port) return false;
    if (!/^[.*]/.test(host)) return hostname === host;
    return hostname.endsWith(host.startsWith('*') ? host.slice(1) : host);
  })) return null;
  const proxy = env(protocol + '_proxy') || env('all_proxy');
  return proxy ? (proxy.includes('://') ? proxy : `${protocol}://${proxy}`) : null;
}

function normalizeProxySettings(settings) {
  const copy = { ...settings };
  const host = String(copy.proxy_host || '').trim();
  if (!host.includes('@')) return copy;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
    if (url.username || url.password) {
      copy.proxy_username = decodeURIComponent(url.username);
      copy.proxy_password = decodeURIComponent(url.password);
      copy.proxy_host = host.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/]*@/i, '$1');
    }
  } catch (_) {
    // 无效地址也不能把 userinfo 原样返回给页面。
    copy.proxy_host = host.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/]*@/i, '$1');
  }
  return copy;
}

/**
 * 计算当前生效的代理 URL。
 * 返回 { mode, url }：
 *   mode='direct'  直连
 *   mode='system'  API/下载按启动环境解析（url 为 HTTPS 测试目标的路由）；浏览器跟随系统
 *   mode='custom'  手动指定
 */
function resolveProxyConfig(settings) {
  const s = settings || {};
  if (s.proxy_enabled !== true) {
    return { mode: 'direct', url: null };
  }
  const mode = s.proxy_mode || 'system';
  if (mode === 'direct') {
    return { mode: 'direct', url: null };
  }
  if (mode === 'custom') {
    const host = String(s.proxy_host || '').trim();
    const port = String(s.proxy_port || '').trim();
    if (!host) return { mode: 'custom', url: null };
    // URL 组件避免粘贴完整地址后重复追加端口或 IPv6 方括号。
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
      if (!port && !/:\d+\/?$/.test(host)) return { mode: 'custom', url: null };
      if (port) {
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { mode: 'custom', url: null };
        url.port = port;
      }
      if (String(s.proxy_username || '').trim()) {
        url.username = encodeURIComponent(String(s.proxy_username).trim());
        url.password = encodeURIComponent(String(s.proxy_password || ''));
      }
      return { mode: 'custom', url: url.toString().replace(/\/$/, '') };
    } catch (_) { return { mode: 'custom', url: null }; }
  }
  // system：以启动时的环境变量为准，不读已经被本进程改写过的值
  return { mode: 'system', url: snapshotProxyUrl() };
}

function publicProxyUrl(value) {
  if (!value) return null;
  try { const url = new URL(value); url.username = ''; url.password = ''; return url.toString(); }
  catch (_) { return '(代理地址已隐藏)'; }
}

function publicProxyError(message, settings, resolved) {
  let text = String(message || '代理连接失败').replace(/([a-z]+:\/\/)[^\s/]*@/gi, '$1[认证已隐藏]@');
  for (const secret of [settings.proxy_username, settings.proxy_password, resolved.url]) {
    if (secret) for (const value of new Set([String(secret), encodeURIComponent(String(secret))])) text = text.split(value).join('[已隐藏]');
  }
  return text;
}

/**
 * 把代理写进环境变量，axios 会自动读取（proxy-from-env），
 * 因此红果 API 解析与视频下载都会走代理，无需改动业务代码。
 */
function applyProxyToEnv(resolved) {
  for (const key of PROXY_ENV_KEYS) {
    if (resolved.mode === 'system') {
      if (originalProxyEnv[key] !== undefined) process.env[key] = originalProxyEnv[key];
      else delete process.env[key];
    } else if (resolved.mode === 'custom' && resolved.url && key.toLowerCase() !== 'no_proxy') {
      process.env[key] = resolved.url;
    } else {
      delete process.env[key];
    }
  }
}

// Chromium 的 proxyRules 会忽略 URL 里的账号密码；窗口请求改由 login 事件提供认证。
function proxyRuleForSession(resolved) {
  let url;
  try { url = new URL(resolved.url); } catch (_) { return null; }
  const protocol = (url.protocol || 'http:').replace(/:$/, '').toLowerCase();
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostname = host.includes(':') ? `[${host}]` : host;
  if (!hostname) return null;
  const port = url.port;
  return {
    rule: port ? `${protocol}://${hostname}:${port}` : `${protocol}://${hostname}`,
    auth: url.username ? {
      host,
      port: port ? Number(port) : (protocol === 'https' ? 443 : protocol.startsWith('socks') ? 1080 : 80),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password || ''),
    } : null,
  };
}

/** 窗口和更新器使用不同 Session，代理规则必须分别应用。 */
async function applyProxyToSession(resolved, sessions = [session.defaultSession, appUpdater?.netSession], version = proxyApplyVersion) {
  let auth = null;
  let config = { mode: resolved.mode === 'direct' ? 'direct' : 'system' };
  if (resolved.mode === 'custom' && resolved.url) {
    const built = proxyRuleForSession(resolved);
    if (!built) throw new Error('代理地址无效');
    auth = built.auth;
    config = { mode: 'fixed_servers', proxyRules: built.rule };
  }
  const key = JSON.stringify([config, auth]);
  await Promise.all(sessions.filter(Boolean).map(async ses => {
    if (sessionProxyConfigs.get(ses) !== key) {
      await ses.setProxy(config);
      await ses.clearAuthCache?.();
      await ses.closeAllConnections?.();
    }
    if (version !== proxyApplyVersion) {
      // Electron cannot cancel setProxy; a late completion must restore the newest choice.
      sessionProxyConfigs.delete(ses);
      await applyProxyToSession(desiredProxyConfig, [ses], proxyApplyVersion);
      throw new Error('代理设置已被更新');
    }
    sessionProxyConfigs.set(ses, key);
  }));
  if (version === proxyApplyVersion) activeProxyAuth = auth;
}

function matchesProxyAuth(authInfo) {
  if (!authInfo?.isProxy || !activeProxyAuth) return false;
  const host = String(authInfo.host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === activeProxyAuth.host && Number(authInfo.port) === activeProxyAuth.port;
}

app.on('login', (event, _webContents, _details, authInfo, callback) => {
  if (!matchesProxyAuth(authInfo)) return;
  event.preventDefault();
  callback(activeProxyAuth.username, activeProxyAuth.password);
});

/** 统一入口：设置变化或启动时调用 */
async function applyProxySettings(settings) {
  const resolved = resolveProxyConfig(settings);
  const version = ++proxyApplyVersion;
  desiredProxyConfig = resolved;
  try { await applyProxyToSession(resolved, undefined, version); }
  catch (_) { throw new Error('设置网络代理失败，请重试。'); }
  if (version !== proxyApplyVersion) throw new Error('代理设置已被更新');
  applyProxyToEnv(resolved);
  console.log(`[Proxy] mode=${resolved.mode}`);
  return resolved;
}

/** 保存前校验代理草稿，避免坏配置先落盘、下次启动才发现。 */
function validateProxyDraft(settings) {
  const s = settings || {};
  if (s.proxy_enabled !== true) return;
  const mode = s.proxy_mode || 'system';
  if (!['system', 'custom', 'direct'].includes(mode)) throw new Error('不支持的代理模式');
  if (mode !== 'custom') return;
  const resolved = resolveProxyConfig(s);
  if (!resolved.url) throw new Error('请填写完整的代理地址与端口');
  let url;
  try { url = new URL(resolved.url); } catch (_) { throw new Error('代理地址格式无效'); }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol)) throw new Error('仅支持 HTTP、HTTPS、SOCKS4 或 SOCKS5 代理');
  if (!url.hostname) throw new Error('代理地址格式无效');
  if (!proxyRuleForSession(resolved)) throw new Error('代理地址无法用于系统网络设置');
}

function applyProxyWithTimeout(settings, timeoutMs) {
  let timer;
  return Promise.race([
    applyProxySettings(settings),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('代理启动超时')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

/** 启动时先尝试已保存代理；坏配置临时直连，保证窗口能打开让用户修复。 */
async function applyProxyForStartup(settings) {
  try {
    validateProxyDraft(settings);
    await applyProxyWithTimeout(settings, 15000);
    return { fallback: false, reason: '', fallbackError: '' };
  } catch (error) {
    let fallbackError = '';
    try { await applyProxyWithTimeout({ ...settings, proxy_enabled: false, proxy_mode: 'direct' }, 5000); }
    catch (fallback) { fallbackError = fallback.message; }
    return { fallback: true, reason: error.message, fallbackError };
  }
}

function getCurrentSettings() {
  const saved = store.getSettings() || {};
  const merged = { ...getDefaultSettings(), ...saved };
  // 保证并发数合法
  const mc = parseInt(merged.max_concurrent, 10);
  MAX_CONCURRENT_DOWNLOADS = Number.isInteger(mc) && mc >= 1 && mc <= 10 ? mc : 3;
  return normalizeProxySettings({ ...merged, max_concurrent: MAX_CONCURRENT_DOWNLOADS });
}

// 净化文件夹/文件名称（移除非法字符、结尾的点和空格、Windows 保留名）
function sanitizeFolderName(name) {
  let cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/^ +/, '');
  // 先按码位截断，避免把 emoji 切成半个；再去掉结尾的点或空格。
  const chars = Array.from(cleaned);
  if (chars.length > 80) cleaned = chars.slice(0, 80).join('');
  cleaned = cleaned.replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned)) {
    cleaned = `_${cleaned}`.replace(/[. ]+$/g, '');
  }
  return cleaned;
}

// 按命名模板渲染文件名，返回 名称(不含扩展名) 或 null
function renderName(format, seriesTitle, vidIndex, epTitle) {
  const fmt = String(format || '').trim();
  if (!fmt) return null;
  const vars = {
    'series_title': String(seriesTitle || '').trim(),
    'vid_index': String(vidIndex).padStart(3, '0'),
    'ep_title': String(epTitle || '').trim(),
  };
  const zhMap = {
    '剧名': 'series_title',
    '集数': 'vid_index',
    '标题': 'ep_title',
  };
  const zhRe = /剧名|集数|标题/g;
  let name = fmt
    .replace(zhRe, (w) => zhMap[w] || w)
    .replace(/([A-Za-z]+(?:_[A-Za-z]+)*)/g, (tok) => (vars[tok] !== undefined ? (vars[tok] || '') : tok));
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  return name || null;
}

// ===== 加载/保存下载任务 =====
function loadDownloadTasks() {
  const saved = store.getTasks() || [];
  saved.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  downloadTasks = saved.map((task) => {
    const inProgress = task.status === 'downloading' || task.status === 'pending';
    return {
      ...task,
      status: inProgress ? 'failed' : task.status,
      error: inProgress ? '应用关闭时任务中断' : task.error,
      qualityNotice: task.status === 'completed' ? task.qualityNotice || '' : '',
    };
  });
}

/**
 * 从已有下载任务回填短剧档案。
 * 用户可能在这功能上线前就已经下载了不少剧集，没有档案播放页就看不到它们。
 */
function rebuildSeriesRegistryFromTasks() {
  const groups = new Map();
  for (const t of downloadTasks) {
    const info = t.hongguoInfo;
    if (!info || !info.series_id) continue;
    const sid = String(info.series_id);
    if (!groups.has(sid)) {
      groups.set(sid, {
        series_id: sid,
        series_title: info.series_title || '未命名短剧',
        cover: (t.videoInfo && t.videoInfo.cover) || '',
        episodes: new Map(),
      });
    }
    const g = groups.get(sid);
    const idx = Number(info.vid_index) || 0;
    if (!g.episodes.has(idx)) {
      g.episodes.set(idx, {
        vid: String(info.vid),
        vid_index: idx,
        title: info.ep_title || '',
        cover: (t.videoInfo && t.videoInfo.cover) || '',
      });
    }
  }

  let added = 0;
  for (const g of groups.values()) {
    const existing = seriesRegistry.find((s) => String(s.series_id) === g.series_id);
    const list = Array.from(g.episodes.values()).sort((a, b) => a.vid_index - b.vid_index);
    if (!existing) {
      seriesRegistry.push({
        series_id: g.series_id,
        series_title: g.series_title,
        cover: g.cover,
        total: list.length,
        episodes: list,
        updatedAt: 0, // 回填的排在搜索/解析得到的后面
        dismissed: false,
      });
      added++;
    } else if (!existing.dismissed && (!existing.episodes || existing.episodes.length < list.length)) {
      // 档案里的分集不完整时，用任务里能凑出的补上
      existing.episodes = list;
      existing.total = list.length;
      added++;
    }
  }
  if (added > 0) {
    saveSeriesRegistry();
    console.log(`[Series] 从下载任务回填 ${added} 部短剧档案`);
  }
}

function saveDownloadTasks() {
  const serializable = downloadTasks.map((task) => {
    const { cancelSource, writer, ...rest } = task;
    return rest;
  });
  store.saveTasks(serializable);
  sendToRenderer('download-queue-changed', {});
}

/** 重试/继续类操作在持久化失败时恢复任务字段与队列，避免未保存的任务随后被启动。 */
function snapshotQueueTasks(tasks) {
  return {
    previousQueue: [...downloadQueue],
    snapshots: tasks.map(task => ({ task, previous: { ...task } })),
  };
}

function restoreQueueTasks(snapshot) {
  for (const { task, previous } of snapshot.snapshots) {
    for (const key of Object.keys(task)) if (!(key in previous)) delete task[key];
    Object.assign(task, previous);
  }
  downloadQueue = snapshot.previousQueue;
  for (const { task } of snapshot.snapshots) {
    if (task.status === 'failed' && task.retryAt) armSourceRetry(task);
  }
  sendToRenderer('download-queue-changed', {});
}

// ===== 短剧档案（播放页据此列出完整分集）=====
let seriesRegistry = [];

function loadSeriesRegistry() {
  seriesRegistry = store.getSeries() || [];
}

function saveSeriesRegistry() {
  store.saveSeries(seriesRegistry);
}

/**
 * 登记/更新一部短剧。data 需含 series_id 与 episodes。
 * 已有的不覆盖 episodes（避免接口异常时把好数据冲掉），仅补全标题与封面。
 */
function upsertSeriesRegistry(data) {
  if (!data || !data.series_id || !Array.isArray(data.episodes) || data.episodes.length === 0) return;
  const sid = String(data.series_id);
  const idx = seriesRegistry.findIndex((s) => String(s.series_id) === sid);
  const entry = {
    series_id: sid,
    series_title: data.series_title || '未命名短剧',
    cover: data.cover || '',
    total: data.episodes.length,
    web_accessible_episodes: data.web_accessible_episodes ?? null,
    episodes: data.episodes.map((e) => ({
      vid: String(e.vid),
      vid_index: e.vid_index || 0,
      title: e.title || '',
      cover: e.cover || '',
      web_available: e.web_available ?? null,
      locked: e.locked === true,
    })),
    updatedAt: Date.now(),
    dismissed: false, // 用户主动移除过；再次登记时自动恢复显示
    forgotten: false,
  };
  if (idx === -1) seriesRegistry.unshift(entry);
  else seriesRegistry[idx] = { ...seriesRegistry[idx], ...entry, dismissed: false };
  saveSeriesRegistry();
}

/** 剧库可见的短剧（过滤掉被用户移除的） */
function visibleSeries() {
  return seriesRegistry.filter((s) => !s.dismissed);
}

// ===== 下载队列调度 =====
// 说明：这里必须「立即返回」。早期实现写成 `await executeDownload(task)`，
// 会让一次调用只启动一个任务、并一直阻塞到该任务结束，
// 导致并发数恒为 1（无论 max_concurrent 设为多少）。
// 现在由 runTask 自行在结束时回调 pumpQueue，调度器只负责按并发上限派发。
function pumpQueue() {
  if (quitCleanup) return;
  downloadQueue = downloadQueue.filter(task => task.status === 'pending');
  for (const task of downloadQueue) repairTaskDestination(task);
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    const index = downloadQueue.findIndex(task => !runningDownloads.has(task.id) && !runningDownloadPaths.has(task.savePath));
    if (index < 0) break;
    const [task] = downloadQueue.splice(index, 1);
    runningDownloads.add(task.id);
    runningDownloadPaths.add(task.savePath);
    activeDownloads++;
    downloadRuns.set(task.id, runTask(task));
  }
}

async function runTask(task) {
  const destination = task.savePath;
  try {
    await executeDownload(task);
  } catch (error) {
    console.error('[Download Queue] 下载失败:', error);
  } finally {
    activeDownloads--;
    runningDownloads.delete(task.id);
    runningDownloadPaths.delete(destination);
    downloadRuns.delete(task.id);
    pumpQueue();
  }
}

// 保留旧名，内部逻辑保持不变（多处调用点仍在用）
function processDownloadQueue() {
  pumpQueue();
}

/** 把等待中的任务重新排进队列（用于启动时自动续跑 / 一键启动） */
function enqueuePendingTasks() {
  const pending = downloadTasks.filter(
    (t) => t.status === 'pending' && !downloadQueue.some((q) => q.id === t.id)
  );
  for (const t of pending) downloadQueue.push(t);
  return pending.length;
}

// Give temporary source/transport failures a bounded recovery window.
const SOURCE_RETRY_DELAYS = [3, 8, 15].map(minutes => minutes * 60000);
const TRANSFER_RETRY_DELAYS = [10, 30, 60].map(seconds => seconds * 1000);
const sourceRetryTimers = new Map();

function isDeferrableSourceError(task, error) {
  if (!/^\d{1,30}$/.test(String(task.hongguoInfo?.vid || ''))) return false;
  if (error?.code === 'SOURCE_UNAVAILABLE') {
    const sources = Array.isArray(error.sources) ? error.sources : [];
    return !sources.some(item => item.code === 'SECURITY_BLOCKED') && sources.some(item =>
      item.source === 'web' || /^(?:TIMEOUT|NETWORK_ERROR|HTTP_(?:408|5\d\d))$/.test(item.code));
  }
  if (error?.mediaStatus === 408 || error?.mediaStatus >= 500 && error?.mediaStatus <= 599) return true;
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ERR_BAD_RESPONSE', 'ERR_STREAM_PREMATURE_CLOSE', 'EAI_AGAIN',
    'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ERR_NETWORK', 'MEDIA_TRANSFER_ERROR'].includes(error?.code)) return true;
  return [404, 410].includes(error?.mediaStatus) && normalizeDownloadQuality(task.downloadQuality) === 'auto';
}

function armSourceRetry(task) {
  clearTimeout(sourceRetryTimers.get(task.id));
  const at = task.retryAt;
  sourceRetryTimers.set(task.id, setTimeout(() => {
    sourceRetryTimers.delete(task.id);
    if (task.status !== 'failed' || task.retryAt !== at || !downloadTasks.includes(task)) return;
    repairTaskDestination(task);
    // Keep the plan durable while waiting for a free download slot.
    task.status = 'pending'; task.progress = 0; task.receivedBytes = 0; task.totalBytes = 0; task.cancelled = false;
    delete task.error;
    if (!downloadQueue.some((t) => t.id === task.id)) downloadQueue.push(task);
    try { saveDownloadTasks(); }
    catch (error) {
      // store reports storage-error; keep the plan for manual retry or the next launch.
      task.status = 'failed'; task.error = storageError?.error || error.message;
      delete task.retryAt;
      downloadQueue = downloadQueue.filter(t => t.id !== task.id);
      sendToRenderer('download-queue-changed', {});
      return;
    }
    sendToRenderer('download-queue-changed', {});
    pumpQueue();
  }, Math.max(1000, at - Date.now())));
}

/** Manual retry, pause and resume take over from any scheduled automatic retry. */
function clearSourceRetry(task) {
  clearTimeout(sourceRetryTimers.get(task.id));
  sourceRetryTimers.delete(task.id);
  delete task.retryAt;
  delete task.sourceRetries;
}

function cancelScheduledRetries(tasks) {
  let changed = false;
  for (const task of tasks) {
    if (task.status !== 'failed' || (!task.retryAt && !sourceRetryTimers.has(task.id))) continue;
    clearSourceRetry(task);
    const reason = String(task.error || '').replace(/ 将在 .*后自动重试（\d+\/\d+）。$/, '');
    task.error = `${reason ? reason + '；' : ''}已取消自动重试，请手动重试`;
    changed = true;
  }
  return changed;
}

/**
 * 一键暂停：取消进行中的任务、清空等待队列、把等待中的标记为已停止。
 * 返回被暂停的任务数。
 */
function pauseAllTasks() {
  let stopped = 0;
  for (const task of downloadTasks) {
    if (task.status === 'failed' && task.retryAt) {
      clearSourceRetry(task);
      task.status = 'stopped';
      task.error = '已手动暂停';
      stopped++;
    } else if (task.status === 'pending') {
      clearSourceRetry(task);
      task.status = 'stopped';
      task.error = '已手动暂停';
      task.endTime = Date.now();
      stopped++;
    } else if (task.status === 'downloading') {
      task.cancelled = true;
      if (task.cancelSource) {
        try { task.cancelSource.cancel('用户一键暂停'); } catch (_) {}
      }
      if (task.writer) {
        try { task.writer.destroy(); } catch (_) {}
      }
      task.status = 'stopped';
      delete task.cancelSource;
      delete task.writer;
      stopped++;
    }
  }
  downloadQueue = [];
  saveDownloadTasks();
  sendToRenderer('download-queue-changed', {});
  return stopped;
}

/**
 * 一键启动：把所有未完成（已停止 / 失败 / 等待中）的任务重新排队开跑。
 * 返回重新排队任务数。
 */
function resumeAllTasks() {
  let count = 0;
  const changed = downloadTasks.filter((task) => task.status === 'stopped' || task.status === 'failed' || task.status === 'pending'
    || (task.status === 'completed' && !hasCompleteTaskFile(task)));
  const snapshot = snapshotQueueTasks(changed);
  for (const task of changed) {
    clearSourceRetry(task);
    repairTaskDestination(task);
    task.status = 'pending';
    task.progress = 0;
    task.receivedBytes = 0;
    task.totalBytes = 0;
    task.cancelled = false;
    delete task.error;
    delete task.cancelSource;
    delete task.writer;

    if (!downloadQueue.some((t) => t.id === task.id)) downloadQueue.push(task);
    count++;
  }
  if (count > 0) {
    try { saveDownloadTasks(); }
    catch (error) { restoreQueueTasks(snapshot); throw error; }
    pumpQueue();
  }
  sendToRenderer('download-queue-changed', {});
  return count;
}

// ===== 下载分发 =====
async function executeDownload(task) {
  if (task.type === 'hongguo') {
    await executeHongguoDownload(task);
    return;
  }
  throw new Error('未知任务类型: ' + task.type);
}

// ===== 红果短剧下载 =====
async function verifyDownloadQuality(file, quality, existing = false) {
  quality = normalizeDownloadQuality(quality);
  const ffprobe = resolveFfmpeg('ffprobe');
  if (!ffprobe) throw Object.assign(new Error('视频检查工具不可用，请修复安装后重试'), { code: 'LOCAL_MEDIA_TOOL_ERROR' });
  const info = await probeVideoInfo(ffprobe, file, undefined, true);
  const prefix = existing ? '已有本地文件' : '片源文件';
  if (!info || ![info.w, info.h, info.duration].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error(`${prefix}缺少有效视频轨、分辨率或时长，未完成下载${existing ? '；文件已保留，请先自行检查或移除' : ''}`);
  }
  if (!meetsDownloadQuality({ width: info.w, height: info.h }, quality)) {
    throw new Error(`${prefix}实际为 ${Math.min(info.w, info.h)}P（${info.w}×${info.h}），不满足 ${quality.toUpperCase()}${existing ? '；文件已保留，如需重新下载请先自行移除本地文件' : '，未自动降级'}`);
  }
  return `${Math.min(info.w, info.h)}p`;
}

function publishDownloadFile(temporary, destination) {
  // Reuse merge publication: hard-link when supported, exclusive copy on FAT/exFAT.
  require('./src/native/merge-runner').publishMergedOutput(temporary, destination);
  fs.unlinkSync(temporary);
}

async function executeHongguoDownload(task) {
  const { id, hongguoInfo, filename } = task;
  const { vid, series_title } = hongguoInfo || {};
  const source = axios.CancelToken.source();
  task.cancelSource = source;
  let tmpPath, writer;
  try {
    task.status = 'downloading'; task.cancelled = false; task.progress = 0; delete task.retryAt;
    delete task.qualityNotice; delete task.actualQuality;
    sendToRenderer('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0, qualityNotice: '', actualQuality: null });
    const settings = getCurrentSettings();
    // Old and retried tasks retain their original policy, independent of new defaults.
    const quality = normalizeDownloadQuality(task.downloadQuality);
    const allowLowerQuality = quality !== 'auto' && /^\d{1,30}$/.test(String(vid));
    const notifyQuality = pixels => {
      const lower = allowLowerQuality && pixels > 0 && pixels < Number.parseInt(quality, 10);
      const notice = lower ? `正在下载更低质量片源：${pixels}P（原选 ${quality.toUpperCase()}）` : '';
      if (task.qualityNotice === notice) return;
      task.qualityNotice = notice;
      sendToRenderer('download-progress', { id, qualityNotice: notice });
    };
    const verifyReceived = async file => {
      const actual = await verifyDownloadQuality(file, allowLowerQuality ? 'auto' : quality);
      notifyQuality(Number.parseInt(actual, 10));
      return actual;
    };
    const root = String(settings.root || '').trim() || app.getPath('downloads');
    const downloadDir = task.customDir || seriesDownloadDir(root, hongguoInfo?.series_id, series_title);
    fs.mkdirSync(downloadDir, { recursive: true });
    const finalPath = task.savePath || path.join(downloadDir, filename);
    task.savePath = finalPath;
    // Recheck source access before reusing an existing third-party file or URL.
    const checkedPlayInfo = /^(xifan|hema|custom):/.test(String(vid))
      ? await hongguo.fetchPlayUrlSingle(vid, hongguoInfo?.series_id, { quality }) : null;
    if (checkedPlayInfo && !checkedPlayInfo.url) throw new Error(checkedPlayInfo.error || '来源未开放该集');
    // Existing complete files need no additional media transfer.
    source.token.throwIfRequested();
    if (fs.existsSync(finalPath)) {
      if (!hasCompleteTaskFile(task)) throw new Error('已有本地文件不完整或路径冲突，文件已保留，请先自行检查或移除');
      task.actualQuality = await verifyDownloadQuality(finalPath, quality, true);
      source.token.throwIfRequested();
      task.status = 'completed'; task.progress = 100; task.endTime = Date.now(); delete task.sourceRetries;
      saveDownloadTasks(); sendToRenderer('download-completed', { id, path: finalPath });
      return;
    }
    tmpPath = finalPath + '.enc.tmp';
    const cached = onlineCache.get(onlineCacheKey(vid, quality)) || onlineCache.get(String(vid));
    const sourceId = /^custom:[^:]+/.exec(String(vid))?.[0] || /^(xifan|hema):/.exec(String(vid))?.[1] || 'hongguo';
    let reusedCache = false;
    if (cached?.complete && cached.vid === String(vid) && cached.source === sourceId
      && cached.seriesId === String(hongguoInfo?.series_id || '') && cached.size > 0
      && (cached.filePath || Buffer.isBuffer(cached.buffer) && cached.buffer.length === cached.size)) {
      if (cached.filePath) {
        cached.disk.readers = (cached.disk.readers || 0) + 1;
        try { await fsp.copyFile(cached.filePath, tmpPath); }
        finally { cached.disk.readers--; disposeOnlineDisk(cached); }
      } else await fsp.writeFile(tmpPath, cached.buffer, { mode: 0o600 });
      source.token.throwIfRequested();
      try { task.actualQuality = await verifyDownloadQuality(tmpPath, quality); reusedCache = true; }
      catch (_) { fs.unlinkSync(tmpPath); }
      source.token.throwIfRequested();
      checkCustomAccess(vid);
      if (reusedCache) {
        publishDownloadFile(tmpPath, finalPath);
        task.receivedBytes = task.totalBytes = cached.size;
        cached.lastUsed = Date.now();
      }
    }
    if (!reusedCache) await withMediaRecovery(vid, hongguoInfo?.series_id, { playInfo: checkedPlayInfo, quality, allowLowerQuality, force: true, cancelToken: source.token }, async playInfo => {
      source.token.throwIfRequested();
      notifyQuality(Math.min(Number(playInfo.width), Number(playInfo.height)));
      task.progress = 0; task.receivedBytes = 0; task.totalBytes = 0;
      sendToRenderer('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0 });
      if (playInfo.format === 'hls') {
        await prepareHlsFile(playInfo,tmpPath,{cancelToken:source.token,onProgress:received => { task.receivedBytes = received; sendToRenderer('download-progress',{id,progress:0,receivedBytes:received,totalBytes:0}); }});
        task.actualQuality = await verifyReceived(tmpPath);
        source.token.throwIfRequested(); checkCustomAccess(vid);
        publishDownloadFile(tmpPath,finalPath);
        return;
      }
      const response = await requestMedia(playInfo, { cancelToken: source.token });
      source.token.throwIfRequested();
      const totalLength = Number(response.headers['content-length']) || 0;
      task.totalBytes = totalLength;
      writer = fs.createWriteStream(tmpPath); task.writer = writer;
      let received = 0, lastProgress = 0;
      response.data.on('data', chunk => {
        received += chunk.length; task.receivedBytes = received;
        task.progress = totalLength ? Math.min(99, Math.floor(received / totalLength * 100)) : 0;
        if (Date.now() - lastProgress >= 150 || received === totalLength) {
          sendToRenderer('download-progress', { id, progress: task.progress, receivedBytes: received, totalBytes: totalLength });
          lastProgress = Date.now();
        }
      });
      // pipeline rejects on either side and destroys both streams (including abrupt CDN close).
      await pipeline(response.data, writer);
      source.token.throwIfRequested();
      if (!received || (totalLength && received !== totalLength)) throw mediaTransferError('视频下载不完整，请重试');
      if (playInfo.contentKey) {
        const decodedPath = tmpPath + '.decoded';
        try {
          await decryptContentKeyFile(tmpPath, decodedPath, playInfo.contentKey, { cancelToken: source.token });
          task.actualQuality = await verifyReceived(decodedPath);
          source.token.throwIfRequested();
          publishDownloadFile(decodedPath, finalPath);
        } finally { try { fs.unlinkSync(decodedPath); } catch (_) {} }
        fs.unlinkSync(tmpPath);
      } else if (playInfo.spadeA) {
        const key = hongguo.deriveKey(playInfo.spadeA);
        if (!key) throw new Error('Key 派生失败');
        // Decrypt to another temporary file; never expose partial data as a completed MP4.
        const decodedPath = tmpPath + '.decoded';
        try {
          await decryptInWorker({ srcPath: tmpPath, dstPath: decodedPath, key }, { cancelToken: source.token });
          task.actualQuality = await verifyReceived(decodedPath);
          source.token.throwIfRequested();
          publishDownloadFile(decodedPath, finalPath);
        }
        finally { try { fs.unlinkSync(decodedPath); } catch (_) {} }
        fs.unlinkSync(tmpPath);
      } else {
        task.actualQuality = await verifyReceived(tmpPath);
        source.token.throwIfRequested();
        publishDownloadFile(tmpPath, finalPath);
      }
    });
    task.status = 'completed'; task.progress = 100; task.endTime = Date.now(); delete task.sourceRetries;
    if (task.qualityNotice) task.qualityNotice = task.qualityNotice.replace('正在下载', '已下载');
    saveDownloadTasks(); sendToRenderer('download-completed', { id, path: finalPath, actualQuality: task.actualQuality, qualityNotice: task.qualityNotice || '' });
  } catch (error) {
    if (writer && !writer.destroyed) writer.destroy();
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    task.qualityNotice = '';
    // A retry may already be queued; the cancelled old run must not overwrite it.
    if (source.token.reason || axios.isCancel(error) || task.cancelled) {
      if (task.status !== 'pending') {
        task.status = 'stopped'; task.error = ''; task.endTime = Date.now();
        sendToRenderer('download-stopped', { id, qualityNotice: '' });
      }
    } else {
      const retries = task.sourceRetries || 0;
      task.status = 'failed'; task.error = error.message; task.endTime = Date.now();
      if (retries < SOURCE_RETRY_DELAYS.length && isDeferrableSourceError(task, error)) {
        const delays = error.code === 'SOURCE_UNAVAILABLE' || [404, 410].includes(error.mediaStatus)
          ? SOURCE_RETRY_DELAYS : TRANSFER_RETRY_DELAYS;
        const delay = delays[retries];
        task.sourceRetries = retries + 1; task.retryAt = Date.now() + delay;
        const wait = delays === SOURCE_RETRY_DELAYS ? `${delay / 60000} 分钟` : `${delay / 1000} 秒`;
        task.error = `${error.message} 将在 ${wait}后自动重试（${retries + 1}/${SOURCE_RETRY_DELAYS.length}）。`;
        armSourceRetry(task);
      }
      sendToRenderer('download-failed', { id, error: task.error, retryAt: task.retryAt || null, sourceRetries: task.sourceRetries || 0, qualityNotice: '' });
    }
    saveDownloadTasks();
  } finally {
    if (task.cancelSource === source) delete task.cancelSource;
    if (task.writer === writer) delete task.writer;
  }
}

// 向渲染进程发送事件
function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ===== IPC：红果解析与批量下载 =====
ipcMain.handle('hongguo-resolve', async (event, input) => {
  try {
    const seriesId = await hongguo.resolveSeriesId(input);
    const data = await hongguo.fetchEpisodeList(seriesId);
    upsertSeriesRegistry(data);
    return { success: true, data };
  } catch (error) {
    console.error('[Hongguo] 解析失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 搜索：内嵌浏览器嗅探 hongguoduanju.com =====
const SEARCH_SITE = 'https://hongguoduanju.com';
const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SEARCH_TIMEOUT_MS = 15000;

function sourcePageUrl(value) {
  const url = new URL(value);
  if (url.origin !== SEARCH_SITE || url.username || url.password) throw new Error('仅允许打开红果来源页面');
  return url.href;
}

let searchWindow = null;
let sniffWindow = null;
let searchWindowReady = null;

function getSearchWindow(background = false) {
  const current = background ? sniffWindow : searchWindow;
  if (current && !current.isDestroyed()) return current;
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    title: '搜索 - 红果短剧',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // 站内跳转保持在同一个窗口内，避免弹出新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { win.loadURL(sourcePageUrl(url)).catch(() => {}); } catch (_) {}
    return { action: 'deny' };
  });
  for (const name of ['will-navigate', 'will-redirect']) {
    win.webContents.on(name, (event, url) => {
      try { sourcePageUrl(url); } catch (_) { event.preventDefault(); }
    });
  }
  win.on('closed', () => {
    if (searchWindow === win) searchWindow = null;
    if (sniffWindow === win) sniffWindow = null;
  });
  if (background) sniffWindow = win;
  else searchWindow = win;
  return win;
}

/**
 * 通用卡片提取脚本（分类页 / 搜索页共用）。
 * 只依赖链接里的 series_id（不依赖 hash 类名），剧名优先取 img[alt]，
 * 这样站点改版时更不容易失效。
 */
const SNIFFER_JS = `(() => {
  const out = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a')).filter((a) =>
    /series_id=\\d{6,}/.test(a.getAttribute('href') || '')
  );
  for (const a of links) {
    const m = (a.getAttribute('href') || '').match(/series_id=(\\d{6,})/);
    if (!m) continue;
    const sid = m[1];
    if (seen.has(sid)) continue;
    seen.add(sid);

    const img = a.querySelector('img');
    let title = (img && img.getAttribute('alt')) || '';
    if (!title) {
      const t = a.querySelector('[class*="title"]');
      title = (t ? t.textContent : a.textContent || '').trim();
    }

    // 封面：优先 picture>source[srcset]（分类页用 picture），兜底 img[src]
    let cover = '';
    const pic = a.querySelector('picture');
    if (pic) {
      const src = pic.querySelector('source[srcset]');
      if (src) cover = (src.getAttribute('srcset') || '').split(' ')[0];
    }
    if (!cover && img) cover = img.getAttribute('src') || img.getAttribute('data-src') || '';

    // 总集数：「全86集」
    let episode_count = 0;
    const epEl = a.querySelector('[class*="episode"]');
    if (epEl) {
      const em = (epEl.textContent || '').match(/(\\d+)\\s*集/);
      if (em) episode_count = parseInt(em[1], 10);
    }

    // 标签
    const tags = Array.from(a.querySelectorAll('[class*="tag-text"]'))
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 4);

    out.push({
      series_id: sid,
      series_title: title.trim(),
      cover: cover,
      episode_count: episode_count,
      tags: tags,
    });
  }
  return JSON.stringify(out);
})()`;

/**
 * 分类页附加信息：分页元数据 + 可用的题材筛选项。
 * 题材从页面里的 /category/<cat>/<genre> 链接提取，避免硬编码。
 */
const BROWSE_META_JS = `(() => {
  const out = { page: 1, totalPages: 0, total: 0, genres: [] };

  // 1) 优先读页面内嵌的分页数据
  try {
    const html = document.documentElement.innerHTML;
    const m = html.match(/"pagination":\\s*\\{[^}]*"total":(\\d+)[^}]*"pageNum":(\\d+)[^}]*"pageSize":(\\d+)[^}]*"totalPages":(\\d+)/);
    if (m) {
      out.total = parseInt(m[1], 10);
      out.page = parseInt(m[2], 10);
      out.totalPages = parseInt(m[4], 10);
    }
  } catch (e) {}

  // 2) 兜底：从分页链接推算总页数
  if (!out.totalPages) {
    let maxPage = 0;
    document.querySelectorAll('a[href*="page="]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/[?&]page=(\\d+)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    out.totalPages = maxPage;
  }

  // 3) 题材筛选项：/category/<cat>/<genre>
  const seen = new Set();
  document.querySelectorAll('a[href*="/category/"]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\\/category\\/[a-z0-9\\-]+\\/([a-z0-9\\-]+)/);
    if (!m) return;
    const slug = m[1];
    const label = (a.textContent || '').trim();
    if (!label || label.length > 8 || seen.has(slug)) return;
    seen.add(slug);
    out.genres.push({ slug: slug, label: label });
  });

  return JSON.stringify(out);
})()`;

/** 隐藏搜索窗口串行嗅探；整个任务（含加载和读取）共用超时。 */
async function runSniffOnUrl(url, label, { deadline = 0 } = {}) {
  // 同一窗口串行执行，避免并发导航互相打断
  const task = async () => {
    const budget = deadline > 0 ? Math.min(SEARCH_TIMEOUT_MS, deadline - Date.now()) : SEARCH_TIMEOUT_MS;
    if (budget <= 0) throw new Error('搜索超时，请稍后重试');
    const win = getSearchWindow(true);
    // Reserve the last part of the deadline for empty-page details.
    const pollDeadline = Date.now() + budget * 0.9;
    let expired = false;
    const timeoutError = new Error('搜索超时，请稍后重试');
    const assertActive = () => {
      if (expired) throw timeoutError;
      if (win.isDestroyed()) throw new Error('搜索窗口已关闭，请重试');
    };
    const evaluate = async script => {
      assertActive();
      const value = await win.webContents.executeJavaScript(script, true);
      assertActive();
      return value;
    };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        if (!win.isDestroyed()) win.destroy();
        reject(timeoutError);
      }, budget);
    });
    const sniff = async () => {
      console.log(`[${label}] 打开:`, url);
      try {
        await win.loadURL(url, { userAgent: SEARCH_UA });
      } catch (e) {
        // loadURL 在页面内有重定向/中断时也可能 reject，这里继续尝试读取 DOM
        console.warn(`[${label}] loadURL 返回异常（继续尝试读取）:`, e.message);
      }
      assertActive();

      let last = [];
      const startedAt = Date.now();
      let reloaded = false;
      while (true) {
        assertActive();
        try {
          const raw = await evaluate(SNIFFER_JS);
          last = JSON.parse(raw || '[]');
        } catch (e) {
          assertActive();
          last = [];
        }
        const now = Date.now();
        if (last.length > 0 || now >= pollDeadline) break;
        // 站点偶发返回“加载失败，请刷新页面重试”；自动刷新一次比空等超时更有用。
        if (!reloaded && now - startedAt >= 4000) {
          let failed = false;
          try {
            failed = (await evaluate(`/加载失败|请刷新页面重试/.test(document.body.innerText || '')`)) === true;
          } catch (_) { failed = false; }
          if (failed) {
            reloaded = true;
            console.log(`[${label}] 页面加载失败，自动刷新一次`);
            try { await win.loadURL(url, { userAgent: SEARCH_UA }); } catch (_) { /* 继续尝试读取 */ }
            assertActive();
            continue;
          }
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      let meta = { page: 1, totalPages: 0, total: 0, genres: [] };
      try {
        meta = JSON.parse((await evaluate(BROWSE_META_JS)) || '{}');
      } catch (_) {}
      assertActive();

      if (!last.length) {
        let pageTitle = '';
        try { pageTitle = await evaluate('document.title'); } catch (_) {}
        assertActive();
        let pageFailed = false;
        try {
          pageFailed = (await evaluate('(() => /加载失败|请刷新页面重试/.test(document.body ? document.body.innerText : ""))()')) === true;
        } catch (_) { pageFailed = false; }
        assertActive();
        // 页面明确报错时不能当成“确实没有结果”，否则搜索失败会被说成没找到。
        if (pageFailed) return { success: false, results: [], pageTitle, meta, error: '红果搜索页面加载失败，请稍后重试' };
        return { success: true, results: [], pageTitle, meta };
      }

      const results = last
        .filter((r) => r.series_id && r.series_title)
        .map((r) => ({
          ...r,
          url: `${SEARCH_SITE}/detail?series_id=${r.series_id}`,
        }));

      console.log(`[${label}] 命中 ${results.length} 部`);
      return { success: true, results, meta };
    };
    try { return await Promise.race([sniff(), timeout]); }
    finally { clearTimeout(timer); }
  };

  // 串行化；deadline 同时覆盖排队时间，避免排队后又拿到完整的 15 秒。
  const prev = searchWindowReady || Promise.resolve();
  const queued = prev.then(task, task);
  searchWindowReady = queued.catch(() => {});
  if (!deadline) return queued;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    queued.catch(() => {});
    throw new Error('搜索超时，请稍后重试');
  }
  let guardTimer;
  const guard = new Promise((_, reject) => {
    guardTimer = setTimeout(() => reject(new Error('搜索超时，请稍后重试')), remaining);
  });
  try { return await Promise.race([queued, guard]); }
  finally { clearTimeout(guardTimer); }
}

async function runSearchSniff(keyword, options = {}) {
  return runSniffOnUrl(`${SEARCH_SITE}/search/${encodeURIComponent(keyword)}`, 'Search', { deadline: options.deadline || 0 });
}

// ===== 浏览：分类页（含题材筛选与分页）=====
const BROWSE_CATEGORIES = [
  { slug: 'real-drama', label: '真人剧' },
  { slug: 'comic-drama', label: '漫剧' },
  { slug: 'ai-drama', label: 'AI剧' },
  { slug: 'comic', label: '漫画' },
  { slug: 'hot-drama', label: '综合热播榜', group: 'rank' },
  { slug: 'hot-real-drama', label: '真人热播榜', group: 'rank' },
  { slug: 'hot-comic-drama', label: '漫剧热播榜', group: 'rank' },
  { slug: 'hot-ai-drama', label: 'AI 热播榜', group: 'rank' },
];

ipcMain.handle('browse-categories', async () => BROWSE_CATEGORIES);

async function invalidateCustomSource(id) {
  require('./src/native/custom-source').cancelRequests(id);
  const prefix = `custom:${id}:`;
  for (const [streamId, session] of [...onlineSessions]) if (session.vid.startsWith(prefix)) releaseOnlineSession(streamId);
  for (const [key, job] of [...onlinePreparing]) if (key.startsWith(prefix)) { job.controller.abort(); onlinePreparing.delete(key); }
  for (const key of [...onlineCache.keys()]) if (key.startsWith(prefix)) deleteOnlineCacheEntry(key);
  for (const job of compatPreparing.values()) if (job.sourceVid.startsWith(prefix)) cancelCompatJob(job);
  await Promise.all(downloadTasks.filter(task => String(task.hongguoInfo?.vid).startsWith(prefix) && isTaskInFlight(task)).map(task => stopTaskAndWait(task).catch(() => {})));
  try { saveDownloadTasks(); } catch (_) { /* storage-error already reports task persistence independently. */ }
}
ipcMain.handle('get-custom-sources', async () => ({success:true,sources:getCurrentSettings().custom_sources || []}));
ipcMain.handle('get-media-sources', async () => ({success:true,sources:[
  {id:'hongguo',label:'红果'},{id:'xifan',label:'西饭'},{id:'hema',label:'河马'},
  ...(getCurrentSettings().custom_sources || []).filter(source => source.enabled).map(source => ({id:`custom:${source.id}`,label:source.name,custom:true})),
]}));
ipcMain.handle('save-custom-source', async (_event,draft) => {
  try {
    const source = require('./src/native/custom-source').validateSource(draft);
    const settings = getCurrentSettings(), sources = settings.custom_sources || [];
    if (source.id && !sources.some(item => item.id === source.id)) throw new Error('播放源不存在');
    source.id ||= randomUUID();
    const next = sources.some(item => item.id === source.id) ? sources.map(item => item.id === source.id ? source : item) : [...sources,source];
    store.saveSettings({...settings,custom_sources:next});
    await invalidateCustomSource(source.id);
    return {success:true,source};
  } catch (error) { return {success:false,error:error.message}; }
});
ipcMain.handle('delete-custom-source', async (_event,id) => {
  try {
    const settings = getCurrentSettings();
    if (!(settings.custom_sources || []).some(source => source.id === id)) throw new Error('播放源不存在');
    store.saveSettings({...settings,custom_sources:settings.custom_sources.filter(source => source.id !== id)});
    await invalidateCustomSource(id); return {success:true};
  } catch (error) { return {success:false,error:error.message}; }
});
ipcMain.handle('test-custom-source', async (_event,draft) => {
  try { return await require('./src/native/custom-source').testCustomSource(draft); }
  catch (error) { return {success:false,error:error.message}; }
});


ipcMain.handle('browse-list', async (_event, options) => {
  if (proxyStartupFallback) return { success: false, error: '网络代理配置无效，请先在设置中修复或明确关闭代理。' };
  if ((!options?.source || options.source === 'hongguo') && options?.catalogChannel != null
    && !['app', 'web'].includes(options.catalogChannel)) return { success: false, error: '不支持的红果目录线路' };
  const moduleName = String(options?.source).startsWith('custom:') ? './src/native/custom-source' : options?.source === 'hema' ? './src/native/hema'
    : options?.source === 'xifan' ? './src/native/xifan'
      : options?.catalogChannel === 'web' ? './src/native/catalog' : './src/native/hongguo-app-catalog';
  const catalogOptions = moduleName === './src/native/catalog'
    ? { ...options, allowTrustedDns: resolveProxyConfig(getCurrentSettings()).mode === 'direct' } : options;
  return require(moduleName).browseList(catalogOptions, (authInfo, callback) => {
    if (matchesProxyAuth(authInfo)) callback(activeProxyAuth.username, activeProxyAuth.password);
    else callback();
  });
});

const normalizeSearchTitle = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** 标点/空格导致原名搜不到时，给出最多两个去标点或取首段的补搜词。 */
function relaxedHongguoQueries(keyword) {
  const text = String(keyword || '').normalize('NFKC').trim();
  const stripped = text.replace(/[\s\p{P}\p{S}]+/gu, '');
  const candidates = [];
  if (stripped && stripped !== text) candidates.push(stripped);
  const firstClause = text.split(/[\s\p{P}\p{S}]+/u).map(part => part.trim()).find(part => part.length >= 2);
  if (firstClause && firstClause !== text && !candidates.includes(firstClause)) candidates.push(firstClause);
  return candidates.slice(0, 2);
}

let appSearchCooldownUntil = 0;
const APP_SEARCH_COOLDOWN_MS = 2 * 60 * 1000;
let proxyStartupFallback = false;

/**
 * 官网搜索没有标题匹配时，用 App「近 7 天上新」列表补搜。
 * 只用于第一页，且失败不影响官网结果；成功结果带 new_release 标记。
 */
async function searchNewReleasesForSearch(keyword, options = {}) {
  const { deadline } = options || {};
  // 单字/纯标点搜索无法在上新列表里做有效标题匹配，也不值得为它多打两次 App 接口。
  const normalized = String(keyword || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
  if (normalized.length < 2) return { results: [], checked: false, error: '' };
  const budget = Number(deadline) || 0;
  if (!budget || budget - Date.now() < 900) return { results: [], checked: false, error: '' };
  try {
    const results = await require('./src/native/hongguo-app-new').searchNewReleases(keyword, {
      deadline: Math.min(budget, Date.now() + 8000),
    });
    return { results: Array.isArray(results) ? results : [], checked: true, error: '' };
  } catch (error) {
    console.warn('[Search] App 上新补搜失败:', error?.message || error);
    return { results: [], checked: true, error: error?.message || 'App 上新补搜失败' };
  }
}

function mergeNewReleases(results, extras) {
  const map = new Map((results || []).map(item => [String(item.series_id), item]));
  for (const extra of extras) {
    if (!extra?.series_id) continue;
    const id = String(extra.series_id);
    const existing = map.get(id);
    if (existing) {
      map.set(id, { ...extra, ...existing, new_release: true,
        ...(extra.released_today ? { released_today: true } : {}) });
    } else {
      map.set(id, extra);
    }
  }
  return [...map.values()];
}

async function searchAtSource(keyword, options = {}) {
  const page = options.page === undefined ? 1 : options.page;
  if (!Number.isSafeInteger(page) || page < 1 || page > 50) throw new Error('搜索页码必须是 1 至 50 的整数');
  const source = options.source || 'hongguo';
  if (page > 1 && source !== 'hongguo' && options.channel && options.channel !== source) throw new Error('搜索通道已变化，请重新搜索');
  const response = await searchAtSourcePage(keyword, { ...options, page });
  if (!response?.success) return response;
  const hasMore = response.hasMore === true && page < 50;
  return { ...response, channel: response.channel || source, page, hasMore,
    nextPage: hasMore ? page + 1 : null, cursor: response.cursor || null,
    meta: { ...(response.meta || {}), page, hasMore } };
}

async function searchAtSourcePage(keyword, options = {}) {
  const deadline = Number(options?.deadline) || 0;
  if (String(options?.source).startsWith('custom:')) return require('./src/native/custom-source').searchSeries(keyword, options);
  if (options?.source === 'hema') return require('./src/native/hema').search(keyword, options.page, { deadline });
  if (options?.source === 'xifan') return require('./src/native/xifan').search(keyword, options.page, { deadline });
  if (options?.source && options.source !== 'hongguo') throw new Error('不支持的搜索来源');
  const requestOptions = deadline ? { deadline } : undefined;
  const page = options.page;
  const searchQuery = normalizeSearchTitle(keyword);
  const hasTitleMatch = items => !!searchQuery && items.some(item => normalizeSearchTitle(item.series_title).includes(searchQuery));
  const hasExactTitleMatch = items => !!searchQuery && items.some(item => normalizeSearchTitle(item.series_title) === searchQuery);
  // 第 2 页起必须固定第一页选中的通道，不能中途换源造成重复/漏结果。
  if (page > 1) {
    if (options?.channel === 'app') {
      try {
        const result = await require('./src/native/hongguo-app-search').searchApp(keyword, { page, cursor: options.cursor || null, deadline });
        appSearchCooldownUntil = 0;
        return { ...result, via: 'app', meta: { total: result.results.length, page, hasMore: result.hasMore, relaxed: false } };
      } catch (error) {
        appSearchCooldownUntil = Date.now() + APP_SEARCH_COOLDOWN_MS;
        throw error;
      }
    }
    if (options?.channel === 'web') {
      const response = await searchHongguo(keyword, { ...requestOptions, page });
      return { ...response, success: true, via: 'api', channel: 'web', page, cursor: { page, nextPage: response.nextPage || null }, hasMore: !!response.hasMore, meta: { total: response.total, page, totalPages: response.totalPages, hasMore: !!response.hasMore, relaxed: false } };
    }
    throw new Error('该搜索通道不支持加载更多，请重新搜索');
  }
  const appEnabled = (options?.appSearch === true || (options?.appSearch !== false && getCurrentSettings().search_app_enabled === true))
    && Date.now() >= appSearchCooldownUntil;
  let appFallbackError = '';
  if (appEnabled) {
    try {
      const appDeadline = Math.min(deadline || Date.now() + 3500, Date.now() + 3500);
      const app = await require('./src/native/hongguo-app-search').searchApp(keyword, { page: 1, deadline: appDeadline });
      if (app.results.length && hasTitleMatch(app.results)) {
        appSearchCooldownUntil = 0;
        return { ...app, via: 'app', pageTitle: '', meta: { total: app.results.length, page: 1, hasMore: app.hasMore, relaxed: false } };
      }
      appSearchCooldownUntil = Date.now() + APP_SEARCH_COOLDOWN_MS;
      appFallbackError = app.results.length ? 'App 搜索没有标题匹配' : 'App 搜索没有返回结果';
    } catch (error) {
      appSearchCooldownUntil = Date.now() + APP_SEARCH_COOLDOWN_MS;
      appFallbackError = error.message || 'App 搜索不可用';
      console.warn('[Search] 红果 App 搜索失败，回退官网:', appFallbackError);
    }
  }
  // 官网搜索页的结果由前端请求 /api/search/result 后渲染；直接调用接口
  // 避免一次页面加载失败就空等到 15 秒。接口结构变化时才退回页面嗅探。
  try {
    const response = await searchHongguo(keyword, requestOptions);
    let results = response.results;
    const attempted = [], fuzzyErrors = [];
    if (options?.fuzzy !== false && !hasTitleMatch(results)) {
      // 标点/空格让来源没搜到原名时，先用去标点全名、再用首段各补搜一次；
      // 命中完整标题或两次都失败就停止，最多两次额外请求。
      for (const relaxed of relaxedHongguoQueries(keyword)) {
        if (deadline && Date.now() >= deadline) { fuzzyErrors.push('搜索时间预算已用完'); break; }
        try {
          const extra = await searchHongguo(relaxed, requestOptions);
          const merged = new Map(results.map(item => [String(item.series_id), item]));
          for (const item of extra.results) {
            const id = String(item.series_id);
            if (!merged.has(id)) merged.set(id, { ...item, fuzzy: true, fuzzy_query: relaxed });
          }
          results = [...merged.values()];
          attempted.push(relaxed);
          if (hasTitleMatch(results)) break;
        } catch (error) {
          fuzzyErrors.push(error.message || '补搜失败');
          console.warn('[Search] 红果模糊补搜失败:', error.message);
        }
      }
    }
    // 官网没有标题匹配（常见于当天刚上线、搜索索引未同步），用 App 上新列表补搜。
    // 短剧名还要排除“老剧名包含新剧名”的遮蔽，例如搜「接班」只返回《接班人的考题》。
    const needsNewRelease = searchQuery.length >= 2
      && (!hasTitleMatch(results) || (searchQuery.length <= 4 && !hasExactTitleMatch(results)));
    let newRelease = { results: [], checked: false, error: '' };
    if (options?.fuzzy !== false && needsNewRelease) {
      newRelease = await searchNewReleasesForSearch(keyword, { deadline });
      if (newRelease.results.length) results = mergeNewReleases(results, newRelease.results);
    }
    const relaxedQuery = attempted.join('、');
    const meta = {
      total: response.total,
      page: response.page,
      totalPages: response.totalPages,
      hasMore: response.hasMore,
      relaxed: attempted.length > 0,
      relaxedQuery,
      newRelease: newRelease.results.length,
      newReleaseChecked: newRelease.checked,
      ...(newRelease.error ? { newReleaseError: newRelease.error } : {}),
    };
    const webMeta = { ...meta, channel: 'web', cursor: { page: response.page, nextPage: response.nextPage || null }, hasMore: !!response.hasMore };
    if (fuzzyErrors.length && !results.length) {
      // 原词和补搜都没有结果，不能把服务错误说成“没有找到”。
      return { success: false, results: [], via: 'api', channel: 'web', error: `搜索失败：${[...new Set(fuzzyErrors)].join('；')}`, meta: webMeta, appError: appFallbackError };
    }
    if (fuzzyErrors.length) {
      return { success: true, results, pageTitle: '', via: 'api', channel: 'web', partial: true, error: `模糊补搜未完成：${[...new Set(fuzzyErrors)].join('；')}`, meta: webMeta, hasMore: !!response.hasMore, cursor: { page: response.page, nextPage: response.nextPage || null }, appError: appFallbackError };
    }
    return { success: true, results, pageTitle: '', via: 'api', channel: 'web', meta: webMeta, hasMore: !!response.hasMore, cursor: { page: response.page, nextPage: response.nextPage || null }, appError: appFallbackError };
  } catch (error) {
    const message = error?.message || String(error || '搜索失败');
    console.warn('[Search] 红果接口失败:', message);
    // 接口 5xx/结构变化时 App 上新列表仍可能可用，能补到当天新剧就不必只报错或空等页面嗅探。
    if (page === 1 && options?.fuzzy !== false && searchQuery.length >= 2) {
      const newRelease = await searchNewReleasesForSearch(keyword, { deadline });
      if (newRelease.results.length) {
        return { success: true, results: newRelease.results, pageTitle: '', via: 'app-new', channel: 'app-new', page: 1,
          total: newRelease.results.length, totalPages: 0, hasMore: false, nextPage: null, cursor: null, partial: true,
          error: `官网搜索未完成：${message}；已显示 App 上新补搜结果`,
          meta: { total: newRelease.results.length, page: 1, totalPages: 0, hasMore: false, relaxed: false,
            newRelease: newRelease.results.length, newReleaseChecked: true },
          apiError: message, appError: appFallbackError };
      }
    }
    if (error.fallback !== true) throw error;
    if (deadline && Date.now() >= deadline) {
      return { success: false, results: [], via: 'dom', partial: true, error: '搜索超时，页面兜底未开始', apiError: error.message };
    }
    try {
      const sniffed = await runSearchSniff(keyword, { deadline });
      return { ...sniffed, via: 'dom', channel: 'dom', hasMore: false, cursor: null, apiError: error.message, appError: appFallbackError };
    } catch (fallbackError) {
      console.warn('[Search] 页面兜底失败:', fallbackError.message);
      return { success: false, results: [], via: 'dom', partial: true, error: `搜索未完成：${fallbackError.message}`, apiError: error.message };
    }
  }
}

ipcMain.handle('search-series', async (event, keyword, options = {}) => {
  try {
    const deadline = Date.now() + 20000;
    return await seriesSearch.searchSeries(keyword, (kw, call) => searchAtSource(kw, { ...options, deadline, ...(call || {}) }), [], { deadline });
  } catch (error) {
    console.error('[Search] 失败:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('search-series-more', async (event, keyword, options = {}) => {
  try {
    if (!Number.isSafeInteger(options?.page) || options.page < 2 || options.page > 50) throw new Error('加载更多页码必须是 2 至 50 的整数');
    const deadline = Date.now() + 12000;
    return await searchAtSource(keyword, { ...options, deadline, fuzzy: false });
  } catch (error) {
    return { success: false, results: [], error: error.message, channel: options?.channel || '', cursor: options?.cursor || null };
  }
});

ipcMain.handle('find-series-sequels', async (_event, seriesId, options = {}) => {
  const entry = seriesRegistry.find(item => String(item.series_id) === String(seriesId));
  if (!entry) return { success: false, results: [], error: '未找到该剧档案，请先打开剧集详情。' };
  const deadline = Date.now() + 22000;
  return seriesSearch.findSeriesSequels(entry, seriesRegistry.filter(item => !item.forgotten),
    (kw, call) => searchAtSource(kw, { source: watchHistory.sourceOf(String(entry.series_id)), deadline, ...(call || {}) }),
    { localOnly: options?.localOnly === true, deadline });
});

// 搜索选中某部剧后，拉取完整分集并登记档案
ipcMain.handle('search-resolve', async (event, seriesId) => {
  try {
    if (!seriesId) return { success: false, error: '缺少 series_id' };
    const data = await hongguo.fetchEpisodeList(String(seriesId));
    upsertSeriesRegistry(data);
    return { success: true, data };
  } catch (error) {
    console.error('[Search] 拉取分集失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 搜索窗口可见性（超时兜底：让用户自己操作）
ipcMain.handle('search-window-show', async (event, visible, sourceUrl) => {
  let target;
  try { if (sourceUrl) target = sourcePageUrl(sourceUrl); }
  catch (error) { return { success: false, error: error.message }; }
  const win = getSearchWindow();
  if (target) {
    try { await win.loadURL(target, { userAgent: SEARCH_UA }); }
    catch (error) { return { success: false, error: error.message }; }
  }
  if (visible) {
    win.show();
    win.focus();
  } else {
    win.hide();
  }
  return { success: true };
});

// 已登记的短剧档案（不含被用户移除的）
ipcMain.handle('get-series-list', async (event, options) => {
  const list = visibleSeries();
  // 合并候选与实际合并共用磁盘检查，不能把在线播放档案当成已下载。
  return options?.downloadedOnly === true
    ? list.filter(series => collectSeriesEpisodeFiles(series.series_id, series.series_title).ordered.length > 0)
    : list;
});

/** 从列表移除一部短剧（只取消登记，不删本地文件） */
ipcMain.handle('remove-series', async (event, seriesId) => {
  const sid = String(seriesId);
  const entry = seriesRegistry.find((s) => String(s.series_id) === sid);
  if (!entry) return { success: false, error: '未找到该剧' };
  entry.dismissed = true;
  saveSeriesRegistry();
  return { success: true };
});

/** 保留播放与文件索引，仅从可恢复的列表中永久移除。 */
ipcMain.handle('forget-series', async (_event, seriesId) => {
  try {
    const sid = String(seriesId);
    if (!seriesRegistry.some(entry => String(entry.series_id) === sid)) return { success: false, error: '未找到该剧' };
    const next = seriesRegistry.map(entry => String(entry.series_id) === sid ? { ...entry, dismissed: true, forgotten: true } : entry);
    store.saveSeries(next);
    seriesRegistry = next;
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

/** 批量移除没有下载过任何一集的短剧（清理浏览时留下的空档案） */
ipcMain.handle('purge-empty-series', async () => {
  let removed = 0;
  for (const s of seriesRegistry) {
    if (s.dismissed) continue;
    const files = collectSeriesEpisodeFiles(s.series_id, s.series_title);
    const hasDiskFile = [...files.episodePaths, ...files.mergedPaths].some(file => {
      try { return fs.statSync(file).size > 1024 * 100; } catch (_) { return false; }
    });
    if (!hasDiskFile && !files.scanFailed) {
      s.dismissed = true;
      removed++;
    }
  }
  if (removed > 0) saveSeriesRegistry();
  return { success: true, count: removed };
});

/**
 * 从磁盘补回下载任务记录。
 * 用于任务记录丢失/被清空、或早期版本直接下载没登记的情况——
 * 只要磁盘上有文件且剧集档案里有对应集号，就重新登记为「已完成」。
 */
function rescanDownloadsFromDisk() {
  let added = 0;
  for (const s of seriesRegistry) {
    const sid = String(s.series_id);
    let scanned;
    try {
      scanned = collectSeriesEpisodeFiles(sid, s.series_title);
    } catch (_) {
      continue;
    }
    if (!scanned.dir || !scanned.ordered.length) continue;

    const existing = new Set(
      downloadTasks
        .filter((t) => t.hongguoInfo && String(t.hongguoInfo.series_id) === sid)
        .map((t) => Number(t.hongguoInfo.vid_index))
    );

    for (const f of scanned.ordered) {
      if (existing.has(f.vid_index)) continue;
      const ep = (s.episodes || []).find((e) => Number(e.vid_index) === f.vid_index);
      let size = 0;
      try { size = fs.statSync(f.path).size; } catch (_) {}
      downloadTasks.unshift({
        id: 'rescanned_' + randomUUID(),
        batchId: 'rescanned',
        savePath: f.path,
        customDir: scanned.dir,
        filename: f.filename,
        title: `《${s.series_title}》第${String(f.vid_index).padStart(3, '0')}集`,
        platform: 'hongguo',
        type: 'hongguo',
        status: 'completed',
        progress: 100,
        receivedBytes: size,
        totalBytes: size,
        startTime: Date.now(),
        videoInfo: {
          author: s.series_title,
          title: `《${s.series_title}》第${String(f.vid_index).padStart(3, '0')}集`,
          cover: s.cover || '',
          aweme_id: ep ? ep.vid : '',
        },
        hongguoInfo: {
          vid: ep ? ep.vid : '',
          series_id: sid,
          series_title: s.series_title,
          vid_index: f.vid_index,
          ep_title: ep ? ep.title : '',
        },
      });
      existing.add(f.vid_index);
      added++;
    }
  }
  if (added > 0) saveDownloadTasks();
  console.log(`[Rescan] 从磁盘补回 ${added} 条下载记录`);
  return { success: true, count: added };
}

ipcMain.handle('rescan-downloads', async () => {
  try {
    return rescanDownloadsFromDisk();
  } catch (error) {
    console.error('[Rescan] 失败:', error.message);
    return { success: false, error: error.message };
  }
});

/** 恢复显示被移除的短剧 */
ipcMain.handle('restore-dismissed-series', async () => {
  let n = 0;
  for (const s of seriesRegistry) {
    if (s.dismissed && !s.forgotten) { s.dismissed = false; n++; }
  }
  if (n > 0) saveSeriesRegistry();
  return { success: true, count: n };
});

ipcMain.handle('dismissed-count', async () => seriesRegistry.filter((s) => s.dismissed && !s.forgotten).length);

// ===== 一键合并（ffmpeg concat 流复制，无损且快）=====
let mergeTasks = []; // { id, seriesId, seriesTitle, status, progress, output, total, done, error }
const mergeRuns = new Map();

function resolveFfmpeg(name) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  // 正式包只用随包二进制。PATH / WinGet 只留给开发运行，避免打包后误用系统上的任意同名程序。
  const devLookup = typeof app !== 'undefined' && app.isPackaged !== true;
  const candidates = [
    // 可执行资源必须位于 asar 外；Finder 启动不依赖终端的 PATH。
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', executable) : null,
    path.join(__dirname, 'build', 'ffmpeg', `${process.platform}-${process.arch}`, executable),
    path.join(__dirname, 'build', 'ffmpeg', executable),
  ];
  if (devLookup) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const bare = process.platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir;
      if (bare) candidates.push(path.join(bare, executable));
    }
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      fs.accessSync(c, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch (_) {}
  }
  // 兜底：开发时扫 winget 安装目录
  if (!devLookup || process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    if (base && fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (!/ffmpeg/i.test(d)) continue;
        const exe = path.join(base, d);
        const found = findFileRecursive(exe, `${name}.exe`, 6);
        if (found) return found;
      }
    }
  } catch (_) {}
  return null;
}

function findFileRecursive(dir, fileName, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const r = findFileRecursive(path.join(dir, e.name), fileName, depth - 1);
    if (r) return r;
  }
  return null;
}

function probeDuration(ffprobePath, file, task) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const child = execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { timeout: 30000 },
      (err, stdout) => {
        if (task?.child === child) delete task.child;
        if (err) return resolve(0);
        const d = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(d) ? d : 0);
      });
    if (task) task.child = child;
  });
}

function probeVideoInfo(ffprobePath, file, task, rejectToolErrors = false) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const child = execFile(ffprobePath, ['-v', 'error', '-show_data_hash', 'sha256',
      '-show_entries', 'stream=codec_type,codec_name,codec_tag_string,profile,level,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,time_base,extradata_hash,sample_rate,channels,channel_layout,bit_rate,color_range,color_space,color_transfer,color_primaries,field_order:format=duration,bit_rate,size', '-of', 'json', file],
      { timeout: 30000 }, (err, stdout) => {
        if (task?.child === child) delete task.child;
        if (err) {
          if (rejectToolErrors && (typeof err.code === 'string' || err.killed)) {
            return reject(Object.assign(new Error('视频检查工具无法运行，请检查安装与权限后重试'), { code: 'LOCAL_MEDIA_TOOL_ERROR', cause: err }));
          }
          return resolve(null);
        }
        try { resolve(require('./src/native/merge-plan').readMergeInfo(JSON.parse(stdout))); }
        catch (_) { resolve(null); }
      });
    if (task) task.child = child;
  });
}

ipcMain.handle('get-ffmpeg-status', async () => {
  const ff = resolveFfmpeg('ffmpeg');
  const fp = resolveFfmpeg('ffprobe');
  return { success: true, ffmpeg: ff, ffprobe: fp, available: !!ff && !!fp };
});

function pathInside(root, target) {
  if (!root || !target) return false;
  let base = path.resolve(String(root));
  let file = path.resolve(String(target));
  try { if (fs.existsSync(base)) base = fs.realpathSync(base); } catch (_) {}
  try { if (fs.existsSync(file)) file = fs.realpathSync(file); } catch (_) {}
  if (process.platform === 'win32') {
    base = base.toLowerCase();
    file = file.toLowerCase();
  }
  const rel = path.relative(base, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function mediaRoots() {
  const roots = [];
  try {
    const root = String(getCurrentSettings().root || '').trim();
    if (root) roots.push(root);
  } catch (_) {}
  try {
    const downloads = app.getPath('downloads');
    if (downloads) roots.push(downloads);
  } catch (_) {}
  return roots;
}

function isInsideMediaRoot(target) {
  return mediaRoots().some((root) => pathInside(root, target));
}

function isRecordedMediaFile(target, episode) {
  try {
    if (!fs.lstatSync(target).isFile()) return false;
    const matches = (recorded, dir) => typeof recorded === 'string'
      && path.relative(path.resolve(recorded), path.resolve(target)) === ''
      && pathInside(dir || path.dirname(recorded), target);
    if (downloadTasks.some(task => matches(task.savePath, task.customDir)
      && (!episode || (hasCompleteTaskFile(task)
        && String(task.hongguoInfo?.series_id) === String(episode.seriesId)
        && Number(task.hongguoInfo?.vid_index) === Number(episode.vidIndex)
        && (!episode.vid || String(task.hongguoInfo?.vid) === String(episode.vid)))))) return true;
    return !episode && mergeTasks.some(task => matches(task.output));
  } catch (_) { return false; }
}

// 只定位下载目录或已登记媒体，不用 openPath，避免把缺失路径的父级当成可执行文件启动。
ipcMain.handle('show-in-folder', async (event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath.trim()) return { success: false, error: '缺少路径' };
    const resolved = path.resolve(filePath);
    const recorded = isRecordedMediaFile(resolved);
    if (!isInsideMediaRoot(resolved) && !recorded) return { success: false, error: '只能打开下载目录中的文件' };
    let target = resolved;
    if (!fs.existsSync(target)) target = path.dirname(resolved);
    if ((!isInsideMediaRoot(target) && !recorded) || !fs.existsSync(target)) return { success: false, error: '路径不存在' };
    const stat = fs.statSync(target);
    if (!stat.isFile() && !stat.isDirectory()) return { success: false, error: '路径不存在' };
    shell.showItemInFolder(target);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-merge-tasks', async () => mergeTasks.map(({ child, ...rest }) => rest));

function seriesDownloadDir(root, seriesId, seriesTitle) {
  const title = sanitizeFolderName(seriesTitle) || '未命名短剧';
  const suffix = createHash('sha256').update(String(seriesId)).digest('hex').slice(0, 12);
  return path.join(root, String(seriesId).startsWith('hema:') ? '河马短剧' : String(seriesId).startsWith('xifan:') ? '西饭短剧' : '红果短剧', `${title}-${suffix}`);
}

/** 找到某剧在磁盘上的目录（优先用任务记录，其次按标题推导） */
function resolveSeriesDir(seriesId, seriesTitle, covers) {
  const fromTask = covers.find((t) => t.customDir && fs.existsSync(t.customDir));
  if (fromTask) return fromTask.customDir;
  const fromFile = covers.find(t => t.savePath && fs.existsSync(path.dirname(t.savePath)));
  if (fromFile) return path.dirname(fromFile.savePath);
  const settings = getCurrentSettings();
  const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : app.getPath('downloads');
  const guess = seriesDownloadDir(root, seriesId, seriesTitle);
  if (fs.existsSync(guess)) return guess;
  // Older versions used title-only directories. Reuse only when ownership is unambiguous.
  if (!/^(xifan|hema|custom):/.test(String(seriesId))) {
    const title = sanitizeFolderName(seriesTitle) || '未命名短剧';
    const owners = seriesRegistry.filter(s => sanitizeFolderName(s.series_title) === title);
    const legacy = path.join(root, '红果短剧', title);
    if (owners.length <= 1 && fs.existsSync(legacy)) return legacy;
  }
  return null;
}

function hasCompleteTaskFile(task) {
  if (!task?.savePath || task.pathConflict) return false;
  if (downloadTasks.some(other => other !== task && other.savePath === task.savePath && String(other.hongguoInfo?.vid) !== String(task.hongguoInfo?.vid))) return false;
  try { const stat = fs.statSync(task.savePath); return stat.isFile() && stat.size > 1024 * 100; }
  catch (_) { return false; }
}

function repairTaskDestination(task) {
  const conflicts = downloadTasks.filter(other => other !== task && other.savePath === task.savePath && String(other.hongguoInfo?.vid) !== String(task.hongguoInfo?.vid));
  if (conflicts.length) for (const item of [task, ...conflicts]) item.pathConflict = true;
  if (!task.pathConflict) return;
  const settings = getCurrentSettings(), info = task.hongguoInfo || {};
  task.customDir = seriesDownloadDir(settings.root || app.getPath('downloads'), info.series_id, info.series_title);
  const filename = uniqueEpisodeFilename(settings, info.series_title, { vid_index: info.vid_index, title: info.ep_title });
  const suffix = createHash('sha256').update(String(info.vid)).digest('hex').slice(0, 8);
  task.filename = filename.replace(/\.mp4$/, `-${suffix}.mp4`);
  task.savePath = path.join(task.customDir, task.filename);
  task.pathConflict = false;
}

function uniqueEpisodeFilename(settings, title, episode) {
  const index = String(episode.vid_index).padStart(3, '0');
  const format = settings.name_format || '';
  const rendered = renderName(format, title, episode.vid_index, episode.title) || title;
  return `${rendered}${/集数|vid_index/.test(format) ? '' : `_第${index}集`}.mp4`;
}

function episodeFilePaths(file) {
  return [file, file + '.enc.tmp', file + '.enc.tmp.decoded'];
}

function ownsEpisodeFiles(file, owners) {
  const paths = new Set(episodeFilePaths(file));
  return !downloadTasks.some(task => paths.has(task.savePath) && !owners.includes(task))
    && !mergeTasks.some(task => paths.has(task.output));
}

/**
 * 组装合并顺序：只认磁盘上真实存在的文件（任务队列可能因为重复提交、
 * 手动删除、跨会话下载等原因与实际文件不一致）。
 * 有任务记录的按标题模板精确寻址；没有记录的按集号扫描目录兜底。
 */
function collectSeriesEpisodeFiles(seriesId, seriesTitle) {
  const sid = String(seriesId);
  const tasks = downloadTasks.filter(
    (t) => t.hongguoInfo && String(t.hongguoInfo.series_id) === sid && t.savePath
  );
  const dir = resolveSeriesDir(sid, seriesTitle, tasks);

  const byIndex = new Map();
  const exists = (p) => {
    try { return fs.existsSync(p) && fs.statSync(p).size > 1024 * 100; } catch (_) { return false; }
  };

  // 1) 任务记录优先（命名模板可能与默认不同）
  for (const t of tasks) {
    if (!hasCompleteTaskFile(t) || !ownsEpisodeFiles(t.savePath, tasks)) continue;
    const idx = Number(t.hongguoInfo.vid_index) || 0;
    if (!idx) continue;
    const prev = byIndex.get(idx);
    if (!prev || (t.startTime || 0) > (prev.startTime || 0)) {
      byIndex.set(idx, { vid_index: idx, startTime: t.startTime || 0, path: t.savePath, filename: t.filename || path.basename(t.savePath) });
    }
  }

  // 2) 目录扫描兜底：把目录里符合命名规律的剧集文件按集号补进来。
  //    不依赖「已登记的分集」——磁盘上可能存在没有任务记录的孤儿文件
  //    （跨会话下载、任务被清理等），这些同样应该合并进去。
  const sharedDirectory = dir && (downloadTasks.some(task => String(task.hongguoInfo?.series_id) !== sid && task.savePath && path.dirname(task.savePath) === dir)
    || mergeTasks.some(task => String(task.seriesId) !== sid && task.output && path.dirname(task.output) === dir));
  const registeredPaths = new Set([...downloadTasks.map(task => task.savePath), ...mergeTasks.map(task => task.output)].filter(Boolean));
  const episodePaths = new Set(tasks.map(task => task.savePath).filter(file => ownsEpisodeFiles(file, tasks)));
  const episodeNames = new Map();
  const formats = new Set([getCurrentSettings().name_format, '剧名 集数', '剧名 集数 标题', '剧名']);
  const entry = seriesRegistry.find(series => String(series.series_id) === sid);
  // 同名档案共用目录时，文件名无法证明归属，只信明确任务记录。
  const ambiguousTitle = sharedDirectory && (seriesRegistry.some(series => String(series.series_id) !== sid && sanitizeFolderName(series.series_title) === sanitizeFolderName(seriesTitle))
    || downloadTasks.some(task => String(task.hongguoInfo?.series_id) !== sid && task.savePath && path.dirname(task.savePath) === dir && sanitizeFolderName(task.hongguoInfo?.series_title || '') === sanitizeFolderName(seriesTitle)));
  if (!ambiguousTitle) for (const episode of entry?.episodes || []) {
    for (const name_format of formats) {
      if (sharedDirectory && !/剧名|\bseries_title\b/.test(name_format || '')) continue;
      episodeNames.set(uniqueEpisodeFilename({ name_format }, seriesTitle, episode), Number(episode.vid_index));
    }
  }
  let names = [], scanFailed = 0;
  if (dir) {
    try { names = fs.readdirSync(dir); } catch (_) { scanFailed = 1; }
    for (const name of episodeNames.keys()) {
      const full = path.join(dir, name);
      if (ownsEpisodeFiles(full, tasks)) episodePaths.add(full);
    }
    for (const n of names) {
      if (!/\.mp4$/i.test(n) || n.includes('合集')) continue;
      const m = !sharedDirectory && n.match(/(\d{1,4})\.mp4$/i);
      const idx = episodeNames.get(n) || (m ? parseInt(m[1], 10) : 0);
      if (!idx || byIndex.has(idx)) continue;
      const full = path.join(dir, n);
      if (registeredPaths.has(full) || !ownsEpisodeFiles(full, tasks)) continue;
      if (exists(full)) byIndex.set(idx, { vid_index: idx, path: full, filename: n });
    }
  }
  for (const episode of byIndex.values()) episodePaths.add(episode.path);
  const temporaryPaths = new Set();
  for (const file of episodePaths) {
    if (!isFileInUse(file)) { temporaryPaths.add(file + '.enc.tmp'); temporaryPaths.add(file + '.enc.tmp.decoded'); }
  }
  const foreignOutputs = new Set(mergeTasks.filter(task => String(task.seriesId) !== sid).map(task => task.output));
  const mergedPaths = new Set(mergeTasks.filter(task => String(task.seriesId) === sid && task.output && !foreignOutputs.has(task.output)
    && !downloadTasks.some(download => download.savePath === task.output)).map(task => task.output));
  const concatPaths = new Set();
  if (dir && !sharedDirectory) {
    const safeTitle = sanitizeFolderName(seriesTitle);
    for (const name of names) {
      const full = path.join(dir, name);
      if (!safeTitle || foreignOutputs.has(full) || downloadTasks.some(task => task.savePath === full)) continue;
      const stem = name.replace(/(?: \(\d+\))?\.mp4$/, '');
      if (name.endsWith('.mp4') && (stem === `${safeTitle}_合集` || stem === `${safeTitle} 合集`)) mergedPaths.add(full);
      if (name === `${safeTitle}.ffconcat.txt`) concatPaths.add(full);
    }
  }

  return {
    dir, sharedDirectory, episodeNames, episodePaths, temporaryPaths, mergedPaths, concatPaths, scanFailed,
    ordered: [...byIndex.values()].sort((a, b) => a.vid_index - b.vid_index),
  };
}

ipcMain.handle('merge-series', async (event, seriesId, outputName, options) => {
  try {
    if (mergeTempCleanup) await mergeTempCleanup;
    const sid = String(seriesId);
    const entry = seriesRegistry.find(s => String(s.series_id) === sid);
    const seriesTitle = entry?.series_title || downloadTasks.find(t => String(t.hongguoInfo?.series_id) === sid)?.hongguoInfo.series_title || '未命名短剧';
    const { dir, ordered } = collectSeriesEpisodeFiles(sid, seriesTitle);
    if (!ordered.length) return { success: false, error: '该剧还没有已下载完成的分集' };
    const ffmpegPath = resolveFfmpeg('ffmpeg'), ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath || !ffprobePath) return { success: false, error: '未找到完整 FFmpeg 工具，无法检查并合并分集' };
    if (mergeTasks.some(t => t.status === 'running')) return { success: false, error: '已有合并任务正在运行，请等待完成或先取消' };
    const outDir = dir || path.dirname(ordered[0].path);
    const baseName = outputName && String(outputName).trim() ? sanitizeFolderName(outputName) : `${sanitizeFolderName(seriesTitle)}_合集`;
    if (!baseName || baseName === '.' || baseName === '..') return { success: false, error: '请输入有效输出名称' };
    let output = path.join(outDir, `${baseName}.mp4`);
    for (let number = 2; fs.existsSync(output); number++) output = path.join(outDir, `${baseName} (${number}).mp4`);
    const totalBytes = ordered.reduce((sum, e) => sum + fs.statSync(e.path).size, 0);
    const id = 'merge_' + randomUUID();
    const task = { id, seriesId: sid, seriesTitle, output, outputName: path.basename(output), total: ordered.length,
      done: 0, checked: 0, progress: 0, status: 'running', stage: 'checking', stageText: '检查分集', totalBytes,
      totalDuration: 0, codecWarning: '', error: '', startTime: Date.now(), elapsedSeconds: 0, speed: 0, etaSeconds: null };
    mergeTasks.unshift(task);
    if (!saveMergeTasks()) { mergeTasks = mergeTasks.filter(t => t.id !== id); return { success: false, error: '无法保存合并任务，请检查存储错误提示后重试' }; }
    sendToRenderer('merge-task-added', { ...task });
    const { runMerge } = require('./src/native/merge-runner');
    const run = (async () => {
      try {
        await runMerge({ task, ordered, outDir, ffmpegPath, ffprobePath, probe: probeVideoInfo,
          pickEncoder: pickH264Encoder, compatible: !!options?.compatible,
          update: () => { const { child, ...data } = task; sendToRenderer('merge-progress', data); } });
      } catch (error) {
        task.status = task.cancelled ? 'stopped' : 'failed';
        task.stage = task.status; task.stageText = task.cancelled ? '已取消' : '合并失败';
        task.error = task.cancelled ? '已取消' : error.message;
      } finally {
        task.endTime = Date.now();
        if (!saveMergeTasks()) task.storageWarning = '合并记录未保存，导出文件状态请以磁盘为准';
        sendToRenderer(task.status === 'completed' ? 'merge-completed' : 'merge-failed', { id, path: output, error: task.error, verified: task.verified, storageWarning: task.storageWarning });
      }
    })().catch(error => console.error('[Merge] 任务通知失败:', error.message)).finally(() => mergeRuns.delete(id));
    mergeRuns.set(id, run);
    return { success: true, id, output, outputName: task.outputName, count: ordered.length, totalBytes, totalDuration: 0, codecWarning: '' };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('cancel-merge', async (event, id) => {
  const task = mergeTasks.find(m => m.id === id);
  if (!task) return { success: false, error: '任务不存在' };
  if (task.status !== 'running') return { success: false, error: '任务已结束' };
  task.cancelled = true;
  require('./src/native/merge-runner').stopMergeChildren(task);
  return { success: true };
});

ipcMain.handle('delete-merge-task', async (event, id) => {
  const task = mergeTasks.find(m => m.id === id);
  if (task?.status === 'running') return { success: false, error: '请先取消合并，再移除记录' };
  const previous = mergeTasks;
  mergeTasks = mergeTasks.filter(m => m.id !== id);
  if (!saveMergeTasks()) { mergeTasks = previous; return { success: false, error: '无法保存任务记录' }; }
  return { success: true };
});

function saveMergeTasks() {
  try { store.saveMergeTasks(mergeTasks.map(({ child, ...rest }) => rest)); return true; }
  catch (error) { console.error('[Merge] 保存任务失败:', error.message); return false; }
}

function loadMergeTasks() {
  try {
    mergeTasks = (store.getMergeTasks() || []).map(t => t.status === 'running'
      ? { ...t, status: 'stopped', stage: 'stopped', stageText: '已中断', error: '应用关闭时中断', endTime: Date.now() } : t);
  } catch (_) { mergeTasks = []; }
  const directories = [...new Set(mergeTasks.filter(task => typeof task.output === 'string' && path.isAbsolute(task.output)).map(task => path.dirname(task.output)))];
  mergeTempCleanup = require('./src/native/merge-runner').cleanupMergeTemps(directories)
    .catch(() => console.warn('[Merge] 部分遗留临时文件未能清理'))
    .finally(() => { mergeTempCleanup = null; });
}

/**
 * 播放页数据源：把「短剧档案」与「下载任务」合并成每集的可播放状态。
 * 判定可播的规则与下载跳过逻辑一致：文件存在且 > 100KB。
 * 由于解密文件是「先写 .enc.tmp、成功后改名 .mp4」，因此不会读到半成品。
 */
ipcMain.handle('get-series-episodes', async (event, seriesId) => {
  try {
    const sid = String(seriesId);
    const entry = seriesRegistry.find((s) => String(s.series_id) === sid);
    const tasks = downloadTasks.filter((t) => t.hongguoInfo && String(t.hongguoInfo.series_id) === sid);

    // 一集只保留一个任务（同 vid 重复提交时取最新的）
    const taskByIndex = new Map();
    for (const t of tasks) {
      const idx = Number(t.hongguoInfo.vid_index);
      const prev = taskByIndex.get(idx);
      if (!prev || (t.startTime || 0) > (prev.startTime || 0)) taskByIndex.set(idx, t);
    }

    const baseEpisodes =
      entry && entry.episodes.length
        ? entry.episodes
        : tasks.map((t) => ({
            vid: t.hongguoInfo.vid,
            vid_index: t.hongguoInfo.vid_index,
            title: t.hongguoInfo.ep_title || '',
          }));

    // 目录兜底：磁盘上可能存在没有任务记录的「孤儿」文件
    // （任务被清理、跨会话下载等），仅靠任务判断会把它们误报成「未下载」。
    const seriesTitle = (entry && entry.series_title) ||
      (tasks[0] && tasks[0].hongguoInfo.series_title) || '未命名短剧';
    let scannedByIndex = new Map();
    let seriesDir = null;
    try {
      const scanned = collectSeriesEpisodeFiles(sid, seriesTitle);
      seriesDir = scanned.dir;
      for (const e of scanned.ordered) scannedByIndex.set(Number(e.vid_index), e);
    } catch (_) {}

    const episodes = baseEpisodes
      .map((ep) => {
        const idx = Number(ep.vid_index);
        const t = taskByIndex.get(idx);
        let status = 'missing';
        let fileUrl = null;
        let progress = 0;
        let fileSize = 0;
        let savePath = null;

        if (t && t.savePath) {
          savePath = t.savePath;
          if (fs.existsSync(t.savePath)) {
            fileSize = fs.statSync(t.savePath).size;
          }
          if (hasCompleteTaskFile(t)) {
            status = 'completed';
            fileUrl = localPlayUrl(t.savePath);
          } else if (t.status === 'downloading') {
            status = 'downloading';
            progress = t.progress || 0;
          } else if (t.status === 'pending') {
            status = 'pending';
          } else {
            status = t.status === 'completed' ? 'missing' : t.status;
          }
        }

        // 任务缺失（或该任务没有可用文件）时，用磁盘扫描结果兜底
        if (status === 'missing') {
          const f = scannedByIndex.get(idx);
          if (f) {
            savePath = f.path;
            fileUrl = localPlayUrl(f.path);
            try { fileSize = fs.statSync(f.path).size; } catch (_) {}
            status = 'completed';
          }
        }

        return {
          vid: ep.vid,
          vid_index: idx,
          title: sid.startsWith('xifan:')
            ? require('./src/native/xifan').episodeDisplayTitle(sid, seriesTitle, ep.title || '') : ep.title || '',
          web_available: ep.web_available ?? null,
          locked: ep.locked === true,
          taskId: t ? t.id : null,
          error: t?.error || '',
          retryAt: t?.retryAt || null,
          actualQuality: t?.actualQuality || null,
          status,
          progress,
          fileSize,
          fileUrl,
          savePath,
        };
      })
      .sort((a, b) => a.vid_index - b.vid_index);

    const completedCount = episodes.filter((e) => e.status === 'completed').length;
    return {
      success: true,
      data: {
        series_id: sid,
        series_title: seriesTitle,
        cover: (entry && entry.cover) || '',
        seriesDir,
        web_accessible_episodes: entry?.web_accessible_episodes ?? null,
        total: episodes.length,
        completedCount,
        episodes,
      },
    };
  } catch (error) {
    console.error('[Player] 读取分集失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 断点续播
ipcMain.handle('save-playback-position', async (event, seriesId, vidIndex, currentTime, metadata) => {  try {
    const map = store.getPlayback() || {};
    const sid = String(seriesId);
    const series = seriesRegistry.find(item => String(item.series_id) === sid);
    if (!series) return { success: false, error: '未找到短剧档案' };
    map[sid] = watchHistory.recordPlayback(map[sid], series, Number(vidIndex), Number(currentTime), Date.now(), metadata);
    store.savePlayback(map);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-playback-position', async (event, seriesId) => {
  const map = store.getPlayback() || {};
  return map[String(seriesId)] || null;
});

/**
 * 从「浏览」页点播：切到播放页并选中该剧。
 * 主进程只负责发导航指令，具体的剧集状态由渲染层拉取，避免重复维护一份数据。
 */
ipcMain.handle('play-series', async (event, payload) => {
  const { seriesId, vidIndex } = payload || {};
  const entry = seriesRegistry.find(item => String(item.series_id) === String(seriesId));
  if (!entry) return { success: false, code: 'SERIES_NOT_FOUND', error: '未找到短剧档案，请重新打开详情' };
  if (entry.dismissed) {
    const wasForgotten = entry.forgotten;
    try { entry.dismissed = false; entry.forgotten = false; saveSeriesRegistry(); }
    catch (error) { entry.dismissed = true; entry.forgotten = wasForgotten; return { success: false, error: error.message }; }
  }
  sendToRenderer('navigate', {
    page: 'player',
    payload: { seriesId: seriesId ? String(seriesId) : '', vidIndex: Number(vidIndex) || 0, resume: payload?.resume === true },
  });
  return { success: true };
});

// ===== 在线播放 =====
function playbackQuality(value = 'auto', vid = '') {
  if (!['auto', '720p', '1080p'].includes(value)) throw new Error('在线播放清晰度无效，请选择自动、720p 或 1080p');
  if (value !== 'auto' && /^(xifan|hema|custom):/.test(String(vid))) throw new Error('此来源暂不支持指定在线播放清晰度，请选择自动');
  return value;
}

function onlineCacheKey(vid, quality = 'auto') {
  return quality === 'auto' ? String(vid) : `${vid}:${quality}`;
}


/** Only a single valid byte range is supported; malformed/unsatisfiable => 416. */
function mediaRange(range, size) {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return false;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { start, end };
}

function bufferedMediaResponse(request, buffer) {
  const range = mediaRange(request.headers.get('range'), buffer.length);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buffer.length}` } });
  const { start, end } = range || { start: 0, end: buffer.length - 1 };
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${buffer.length}`;
  return new Response(request.method === 'HEAD' ? null : buffer.subarray(start, end + 1), { status: range ? 206 : 200, headers });
}

/** Same media headers and cancellation apply to download and playback. */
async function requestMedia(playInfo, options = {}) {
  const url = new URL(playInfo.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效播放地址');
  checkCustomAccess(playInfo.vid);
  const custom = playInfo.source === 'custom';
  const web = playInfo.source === 'web';
  const config = { method: 'GET', url: url.href, responseType: 'stream', timeout: 60000, ...options,
    ...((web || custom) ? require('./src/native/web-media-guard').webMediaRequestOptions(url.href) : {}),
    headers: { 'User-Agent': playInfo.userAgent || (web ? hongguo.WEB_UA : hongguo.UA), 'Accept-Encoding': 'identity',
      ...((playInfo.referer || web) ? { Referer: playInfo.referer || hongguo.WEB_REFERER } : {}), ...options.headers } };
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { response = await axios(config); break; }
    catch (error) {
      error.response?.data?.destroy?.();
      const status = error.response?.status;
      const cancelled = config.signal?.aborted || config.cancelToken?.reason || axios.isCancel(error);
      if (!cancelled && (error.code === 'ERR_WEB_MEDIA_ADDRESS' || error.cause?.code === 'ERR_WEB_MEDIA_ADDRESS')) {
        hongguo.markWebMediaFailure?.(playInfo);
        throw Object.assign(mediaTransferError('官网片源地址不安全，正在尝试其他片源'), { code: 'ERR_WEB_MEDIA_ADDRESS' });
      }
      const retryable = web ? [404, 410].includes(status) || status >= 500 && status <= 599 : status === 403;
      if (!cancelled && attempt === 0 && retryable) {
        if (['app', 'api'].includes(playInfo.source) && config.headers.Referer) delete config.headers.Referer;
        else if (['app', 'api'].includes(playInfo.source) && !config.headers.Referer) config.headers.Referer = hongguo.VIDEO_REFERER;
        continue;
      }
      if (!cancelled && config.method === 'GET' && (retryable || status === 403)) hongguo.markWebMediaFailure?.(playInfo);
      if (!cancelled && status) {
        const failure = new Error(`片源请求失败（HTTP ${status}），请重新连接片源`);
        failure.mediaRetryable = [403, 404, 408, 410].includes(status) || status >= 500 && status <= 599;
        failure.mediaStatus = status;
        throw failure;
      }
      throw error;
    }
  }
  if ([200, 206].includes(response.status) && /(?:text\/html|application\/json)/i.test(response.headers['content-type'] || '')) {
    response.data.destroy();
    throw mediaTransferError('片源返回了错误页面，请重新获取片源');
  }
  if (config.method === 'GET' && !config.headers.Range && response.status === 206) {
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
    if (!range || Number(range[1]) + 1 !== Number(range[2])) {
      response.data.destroy();
      throw mediaTransferError('视频响应不完整，请重新获取片源');
    }
    response.headers['content-length'] = range[2];
  }
  return response;
}

function mediaTransferError(message) {
  return Object.assign(new Error(message), { code: 'MEDIA_TRANSFER_ERROR', mediaRetryable: true });
}

function awaitMediaOperation(promise, signal, timeout = 0) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (settle, value) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); settle(value);
    };
    const abort = () => finish(reject, Object.assign(new Error('已取消媒体请求'), { code: 'ERR_CANCELED' }));
    if (timeout) timer = setTimeout(() => finish(reject, mediaTransferError('获取片源超时，请稍后重试')), timeout);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // The shared provider may finish later; only this consumer's wait is cancelled.
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

/** Retry the complete operation so a broken body never counts as a successful download. */
async function withMediaRecovery(vid, seriesId, options, consume) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  options.cancelToken?.subscribe(abort);
  const cancelled = () => {
    options.cancelToken?.throwIfRequested();
    if (options.signal?.aborted || controller.signal.aborted) throw Object.assign(new Error('已取消媒体请求'), { code: 'ERR_CANCELED' });
  };
  const recoverable = error => error?.mediaRetryable || error?.code === 'SOURCE_UNAVAILABLE'
    || ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ERR_BAD_RESPONSE', 'ERR_STREAM_PREMATURE_CLOSE', 'EAI_AGAIN'].includes(error?.code);
  const rounds = options.recover !== false && /^\d{1,30}$/.test(String(vid)) ? 3 : 1;
  let lastError, transfers = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      cancelled();
      if (round) {
        let timer;
        try { await awaitMediaOperation(new Promise(resolve => { timer = setTimeout(resolve, round * 500); }), controller.signal); }
        finally { clearTimeout(timer); }
      }
      cancelled();
      let info;
      try {
        info = !round && options.playInfo || await awaitMediaOperation(hongguo.fetchPlayUrlSingle(vid, seriesId,
          { quality: options.quality, allowLowerQuality: options.allowLowerQuality, force: options.force || round > 0 }), controller.signal, 30000);
      } catch (error) {
        cancelled();
        if (!recoverable(error)) throw error;
        lastError = error;
        continue;
      }
      cancelled();
      if (!info?.url) {
        lastError = Object.assign(new Error(info?.error || '未获取到有效播放地址'), { code: info?.code, sources: info?.sources });
        if (!recoverable(lastError) || info?.locked) throw lastError;
        continue;
      }
      const seen = new Set();
      for (const candidate of [info, ...(options.recover === false ? [] : info.variants || info.candidates || [])]) {
        const identity = JSON.stringify([candidate.url, candidate.contentKey, candidate.spadeA, candidate.userAgent, candidate.referer]);
        if (!candidate.url || seen.has(identity)) continue;
        seen.add(identity);
        cancelled();
        transfers++;
        try {
          const value = await consume(candidate);
          cancelled();
          return value;
        } catch (error) {
          cancelled();
          // Local storage/security failures cannot be repaired by trying a lower-quality video.
          const terminal = error?.path || error?.dest
            || /^(?:EACCES|EPERM|ENOSPC|EDQUOT|EROFS|EIO|ENOENT|EEXIST|ENOTDIR|EISDIR|EMFILE|ENFILE|EBUSY|ENAMETOOLONG|EMLINK|EFBIG|LOCAL_MEDIA_TOOL_ERROR|SECURITY_BLOCKED|ERR_WEB_MEDIA_ADDRESS)$/.test(error?.code);
          if (options.allowLowerQuality && terminal || (!recoverable(error) && !options.allowLowerQuality)) throw error;
          lastError = error;
          hongguo.markWebMediaFailure?.(candidate);
          if (transfers >= 4 && !options.allowLowerQuality) throw lastError;
        }
      }
    }
    throw lastError;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    options.cancelToken?.unsubscribe(abort);
  }
}

/** Proxy only addresses resolved by our native provider, never renderer-supplied URLs. */
function mediaWithCors(handler) {
  return async request => {
    const headers = mediaAccess.corsHeaders(request);
    if (!headers) return new Response('forbidden origin', { status: 403 });
    const response = await handler(request);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  };
}

function diskMediaResponse(request,entry,session) {
  const range = mediaRange(request.headers.get('range'),entry.size);
  if (range === false) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${entry.size}`}});
  const {start,end} = range || {start:0,end:entry.size-1};
  const headers = {'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':String(end-start+1)};
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${entry.size}`;
  if (request.method === 'HEAD') return new Response(null,{status:range?206:200,headers});
  const reader = fs.createReadStream(entry.filePath,{start,end}), controller = new AbortController();
  entry.disk.readers = (entry.disk.readers || 0) + 1;
  const abort = () => controller.abort();
  controller.signal.addEventListener('abort',() => reader.destroy());
  session.requests.add(controller); request.signal.addEventListener('abort',abort,{once:true});
  reader.once('close',() => {
    session.requests.delete(controller); request.signal.removeEventListener('abort',abort);
    entry.disk.readers--; disposeOnlineDisk(entry);
  });
  trackOnlineWork(controller, new Promise(resolve => reader.once('close', resolve)));
  if (request.signal.aborted) abort();
  return new Response(Readable.toWeb(reader),{status:range?206:200,headers});
}

function registerStreamProtocol() {
  protocol.handle(STREAM_SCHEME, mediaWithCors(async (request) => {
    const url = new URL(request.url);
    const id = url.pathname.replace(/^\/+/, '');
    const session = url.hostname === 'play' && onlineSessions.get(id);
    if (!session || !session.entry) return new Response('not ready', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const entry = session.entry;
    try { checkCustomAccess(session.vid); } catch (_) { releaseOnlineSession(id); return new Response('source disabled',{status:403}); }
    if (entry.filePath) return diskMediaResponse(request,entry,session);
    entry.lastUsed = Date.now();
    if (entry.buffer) {
      if (session.mediaStarted && entry.mediaIdentity && session.mediaIdentity !== entry.mediaIdentity) return new Response('media changed', { status: 502 });
      return bufferedMediaResponse(request, entry.buffer);
    }
    const range = request.headers.get('range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return new Response(null, { status: 416 });
    const controller = new AbortController();
    session.requests.add(controller);
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const cleanup = () => { session.requests.delete(controller); request.signal.removeEventListener('abort', abort); };
    try {
      return await withMediaRecovery(session.vid, entry.seriesId,
        { playInfo: entry.playInfo, quality: entry.quality, signal: controller.signal, recover: !session.mediaStarted }, async playInfo => {
        const identity = JSON.stringify([playInfo.url, playInfo.contentKey, playInfo.spadeA]);
        const checkIdentity = () => {
          if (session.mediaStarted && session.mediaIdentity !== identity) throw new Error('片源已变化，请重新连接播放');
        };
        checkIdentity();
        if (playInfo.format === 'hls') {
          if (!entry.hlsJob) {
            entry.hlsIdentity = identity;
            entry.hlsJob = trackOnlineWork(controller, (async () => {
              const prepared = {...entry}; delete prepared.hlsJob;
              await prepareHlsEntry(playInfo,prepared,controller.signal,received => sendToRenderer('online-play-progress',
                {vid:session.vid,seriesId:entry.seriesId,vidIndex:entry.vidIndex,requestId:session.requestId,received,total:0,percent:0,phase:'downloading'}));
              try { checkIdentity(); } catch (error) { disposeOnlineDisk(prepared); throw error; }
              Object.assign(entry,prepared,{mediaIdentity:identity,vid:session.vid,source:/^custom:[^:]+/.exec(session.vid)?.[0] || 'hongguo',complete:true});
              delete entry.playInfo;
              onlineCache.set(session.cacheKey || session.vid,entry); trimOnlineCache();
            })().catch(error => { delete entry.hlsJob; delete entry.hlsIdentity; throw error; }));
          }
          if (entry.hlsIdentity !== identity) throw new Error('片源已变化，请重新连接播放');
          await entry.hlsJob; checkIdentity();
          session.mediaStarted = true; session.mediaIdentity = identity;
          cleanup(); return diskMediaResponse(request,entry,session);
        }
        // A fallback can change encryption and size; serve Range only after decoding that candidate.
        if (playInfo.spadeA || playInfo.contentKey) {
          const buffer = await trackOnlineWork(controller, fetchDecryptedEpisodeOnce(session.vid, null, entry.seriesId, playInfo, controller.signal));
          checkIdentity();
          entry.buffer = buffer; entry.size = buffer.length; entry.mediaIdentity = identity; delete entry.playInfo;
          session.mediaStarted = true; session.mediaIdentity = identity;
          cleanup();
          return bufferedMediaResponse(request, buffer);
        }
        const upstream = await requestMedia(playInfo, { method: request.method, signal: controller.signal,
          headers: range ? { Range: range } : {}, validateStatus: status => [200, 206, 416].includes(status) });
        try { checkIdentity(); } catch (error) { upstream.data.destroy(); throw error; }
        entry.playInfo = playInfo;
        upstream.data.once('error', () => {
          if (!controller.signal.aborted) hongguo.markWebMediaFailure?.(playInfo);
        });
        upstream.data.once('close', cleanup);
        const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' };
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          if (upstream.headers[name]) headers[name] = upstream.headers[name];
        }
        if (request.method === 'HEAD' || upstream.status === 416) {
          if (request.method === 'HEAD' && upstream.status !== 416) { session.mediaStarted = true; session.mediaIdentity = identity; }
          upstream.data.destroy(); cleanup();
          return new Response(null, { status: upstream.status, headers });
        }
        // Later requests must reconnect by playback time, never reuse offsets against a new rendition.
        session.mediaStarted = true;
        session.mediaIdentity = identity;
        return new Response(Readable.toWeb(upstream.data, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }), { status: upstream.status, headers });
      });
    } catch (error) {
      cleanup();
      if (error.code === 'MEDIA_TOO_LARGE') sendToRenderer('online-play-progress', { requestId: session.requestId, code: error.code, error: error.message });
      return new Response('media unavailable', { status: controller.signal.aborted ? 499 : 502 });
    }
  }));
}

/** 发放进程内随机播放地址，不向网页暴露本地路径。 */
function localPlayUrl(filePath) {
  if (!filePath) return null;
  return mediaAccess.localUrl(filePath);
}

/**
 * 注册本地文件播放协议。
 * 改由主进程用 Node 读文件供给，而不是让 Chromium 读 file://：
 * 开发模式下渲染页面来自 http://localhost:5173，Chromium 会以
 * 「Not allowed to load local resource」拒绝 file:// 请求（表现为播放器黑屏、进度 0:00）。
 * 走自定义协议后开发/打包两种模式行为一致，并且支持 Range 拖动进度。
 */
function registerLocalProtocol() {
  protocol.handle(LOCAL_SCHEME, mediaWithCors(async (request) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      const filePath = mediaAccess.resolveLocal(request.url);
      if (!filePath) {
        return new Response('bad path', { status: 400, headers: { 'Content-Type': 'text/plain' } });
      }
      // 只允许取视频文件，避免该协议被用来读取任意本地文件
      if (!/\.(mp4|m4v|mov|webm)$/i.test(filePath)) {
        return new Response('forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
      }

      let size = 0;
      try {
        size = (await fsp.stat(filePath)).size;
      } catch (_) {
        console.warn('[Local] 文件不存在:', filePath);
        return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }

      const range = mediaRange(request.headers.get('range'), size);
      if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      if (range) {
        const { start, end } = range;
        return new Response(request.method === 'HEAD' ? null : fs.createReadStream(filePath, { start, end }), {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }

      return new Response(request.method === 'HEAD' ? null : fs.createReadStream(filePath), {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(size),
        },
      });
    } catch (e) {
      console.error('[Local] 读取失败:', e.message);
      return new Response('error', { status: 500, headers: { 'Content-Type': 'text/plain' } });
    }
  }));
}

/** App CENC uses native FFmpeg for both senc and saiz/saio layouts. Never log key/args. */
async function decryptContentKeyFile(input, output, contentKey, { signal, cancelToken } = {}) {
  if (typeof contentKey !== 'string' || !/^[a-f\d]{32}$/i.test(contentKey)) throw new Error('片源解密密钥格式无效');
  if (signal?.aborted) throw new Error('已取消媒体解密');
  cancelToken?.throwIfRequested();
  const executable = resolveFfmpeg('ffmpeg');
  if (!executable) throw new Error('未找到内置 FFmpeg，无法准备该片源。请重新下载完整发行包并运行；若已自行安装 FFmpeg，请完全退出软件后重启再试');
  try {
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const child = spawn(executable, ['-y', '-hide_banner', '-loglevel', 'error',
        '-decryption_key', contentKey, '-i', input, '-map', '0:v:0', '-map', '0:a?',
        '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let cancelled = false, killTimer;
      const abort = () => {
        if (cancelled) return;
        cancelled = true; child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      };
      const cleanup = () => {
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        cancelToken?.unsubscribe(abort);
      };
      // Discard native diagnostics: they may contain private input paths or key material.
      child.stderr.on('data', () => {});
      signal?.addEventListener('abort', abort, { once: true });
      cancelToken?.subscribe(abort);
      if (signal?.aborted || cancelToken?.reason) abort();
      child.once('error', () => { cleanup(); reject(new Error('无法启动内置 FFmpeg')); });
      child.once('close', code => {
        cleanup();
        if (cancelled) reject(new Error('已取消媒体解密'));
        else if (code !== 0) reject(new Error(`媒体解密失败（FFmpeg 退出码 ${code}），请重新获取片源后重试`));
        else resolve();
      });
    });
    if (signal?.aborted) throw new Error('已取消媒体解密');
    cancelToken?.throwIfRequested();
    if ((await fsp.stat(output)).size === 0) throw new Error('媒体解密没有生成可用文件');
  } catch (error) {
    try { await fsp.unlink(output); } catch (_) {}
    throw error;
  }
}

/** Encrypted sources and compatibility transcoding still require the complete MP4. */
async function fetchDecryptedEpisode(vid, onProgress, seriesId, playInfo, signal, maxBytes = ONLINE_MAX_BYTES, force = false, quality = 'auto') {
  return withMediaRecovery(vid, seriesId, { playInfo, signal, force, quality }, candidate =>
    fetchDecryptedEpisodeOnce(vid, onProgress, seriesId, candidate, signal, maxBytes));
}

async function fetchDecryptedEpisodeOnce(vid, onProgress, seriesId, playInfo, signal, maxBytes = ONLINE_MAX_BYTES) {
  maxBytes = Math.min(maxBytes, ONLINE_MAX_BYTES);
  const tooLarge = () => Object.assign(new Error('本集过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' });
  if (playInfo?.format === 'hls') throw new Error('HLS 视频必须先准备为本地媒体文件');
  if (!playInfo?.url) throw new Error(playInfo?.error || '未获取到有效播放地址');
  if (signal?.aborted) throw new Error('已取消播放');
  if (playInfo.contentKey && !/^[a-f\d]{32}$/i.test(playInfo.contentKey)) throw new Error('片源解密密钥格式无效');
  const response = await requestMedia(playInfo, { signal });
  const total = Number(response.headers['content-length']) || 0;
  if (total > maxBytes) { response.data.destroy(); throw tooLarge(); }
  const chunks = [];
  let received = 0, lastProgress = 0;
  if (playInfo.contentKey) {
    let temporary;
    try {
      temporary = await fsp.mkdtemp(path.join(app.getPath('temp'), 'hongguo-decrypt-'));
      const input = path.join(temporary, 'encrypted.mp4'), output = path.join(temporary, 'decoded.mp4');
      response.data.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) { response.data.destroy(tooLarge()); return; }
        if (onProgress && (Date.now() - lastProgress >= 150 || received === total)) {
          onProgress(received, total); lastProgress = Date.now();
        }
      });
      await pipeline(response.data, fs.createWriteStream(input, { mode: 0o600 }), { signal });
      if (!received || (total && received !== total)) throw mediaTransferError('视频下载不完整，请重试');
      if (onProgress) onProgress(received, received, 'decrypting');
      await decryptContentKeyFile(input, output, playInfo.contentKey, { signal });
      if ((await fsp.stat(output)).size > maxBytes) throw tooLarge();
      return await fsp.readFile(output);
    } finally {
      response.data.destroy();
      if (temporary) await fsp.rm(temporary, { recursive: true, force: true });
    }
  }
  for await (const chunk of response.data) {
    received += chunk.length;
    if (received > maxBytes) { response.data.destroy(); throw tooLarge(); }
    chunks.push(chunk);
    if (onProgress && (Date.now() - lastProgress >= 150 || received === total)) {
      onProgress(received, total); lastProgress = Date.now();
    }
  }
  if (signal?.aborted) throw new Error('已取消播放');
  if (!received || (total && received !== total)) throw mediaTransferError('视频下载不完整，请重试');
  let buf = Buffer.concat(chunks);
  if (playInfo.spadeA) {
    if (onProgress) onProgress(buf.length, buf.length, 'decrypting');
    const key = hongguo.deriveKey(playInfo.spadeA);
    if (!key) throw new Error('密钥派生失败');
    buf = await decryptInWorker({ buffer: buf, key }, { signal });
  }
  return buf;
}

async function prepareHlsEntry(playInfo,entry,signal,onProgress) {
  entry.disk = {directory:await fsp.mkdtemp(path.join(app.getPath('temp'),'hongguo-online-')),readers:0};
  entry.filePath = path.join(entry.disk.directory,'video.mp4');
  try {
    await prepareHlsFile(playInfo,entry.filePath,{signal,onProgress});
    await verifyDownloadQuality(entry.filePath,entry.quality || 'auto');
    if (signal.aborted) throw new Error('已取消播放');
    entry.size = fs.statSync(entry.filePath).size;
  } catch (error) { disposeOnlineDisk(entry); throw error; }
}

ipcMain.handle('prepare-online-play', async (event, payload) => {
  const { vid, seriesId, vidIndex, requestId, prefetch = false, force = false } = payload || {};
  if (!vid) return { success: false, error: '缺少 vid' };
  let quality;
  try { quality = playbackQuality(payload.quality, vid); } catch (error) { return { success: false, error: error.message }; }
  const sourceVid = String(vid), key = onlineCacheKey(sourceVid, quality), streamId = randomUUID();
  const session = { vid: sourceVid, seriesId: String(seriesId || ''), vidIndex: Number(vidIndex), cacheKey: key, requestId, requests: new Set(), entry: null };
  onlineSessions.set(streamId, session);
  try {
    checkCustomAccess(sourceVid);
    const checkedPlayInfo = /^(xifan|hema|custom):/.test(sourceVid) ? await hongguo.fetchPlayUrlSingle(sourceVid, seriesId, { force, quality }) : null;
    if (!onlineSessions.has(streamId)) throw new Error('已取消播放');
    if (checkedPlayInfo && !checkedPlayInfo.url) throw new Error(checkedPlayInfo.error || '来源未开放该集');
    if (force) deleteOnlineCacheEntry(key);
    let entry = onlineCache.get(key), cached = !!entry;
    if (!entry) {
      let job = onlinePreparing.get(key);
      if (!job || (force && !job.force)) {
        const controller = new AbortController();
        job = { controller, force };
        job.promise = trackOnlineWork(controller, (async () => {
          const progress = (received,total,phase) => {
            for (const active of onlineSessions.values()) if (active.cacheKey === key) {
              sendToRenderer('online-play-progress',{vid:sourceVid,seriesId,vidIndex,requestId:active.requestId,
                received,total,percent:total?Math.floor(received/total*100):0,phase:phase||'downloading'});
            }
          };
          const prepared = await withMediaRecovery(sourceVid,seriesId,{playInfo:checkedPlayInfo,quality,force,signal:controller.signal},async playInfo => {
            const entry = {quality,size:0,lastUsed:Date.now(),seriesId:String(seriesId||''),vidIndex:Number(vidIndex)||0};
            if (playInfo.format === 'hls') await prepareHlsEntry(playInfo,entry,controller.signal,received => progress(received,0));
            else if (!prefetch && !playInfo.spadeA && !playInfo.contentKey) return {...entry,playInfo};
            else {
              entry.buffer = await fetchDecryptedEpisodeOnce(sourceVid,progress,seriesId,playInfo,controller.signal);
              entry.size = entry.buffer.length;
            }
            if (controller.signal.aborted) throw new Error('已取消播放');
            Object.assign(entry,{vid:sourceVid,source:/^custom:[^:]+/.exec(sourceVid)?.[0] || /^(xifan|hema):/.exec(sourceVid)?.[1] || 'hongguo',complete:true});
            return entry;
          });
          prepared.lastUsed = Date.now();
          // Every waiter owns the finished file before eviction can remove its cache entry.
          for (const active of onlineSessions.values()) if (active.job === job) active.entry = {...prepared};
          if (prepared.complete && onlinePreparing.get(key) === job) { onlineCache.set(key,prepared); trimOnlineCache(); }
          return prepared;
        })().finally(() => { if (onlinePreparing.get(key) === job) onlinePreparing.delete(key); }));
        onlinePreparing.set(key, job);
      }
      session.job = job;
      entry = await job.promise;
    }
    if (!onlineSessions.has(streamId)) throw new Error('已取消播放');
    session.entry = { ...entry }; entry.lastUsed = Date.now();
    return { success: true, url: `${STREAM_SCHEME}://play/${streamId}`, streamId, size: entry.size,
      cached, streaming: !!entry.playInfo };
  } catch (error) {
    releaseOnlineSession(streamId);
    return { success: false, error: error.message, code: error.code };
  }
});

ipcMain.handle('release-online-play', async (event, payload = {}) => {
  for (const [id, session] of [...onlineSessions]) {
    if ((payload.streamId && id === payload.streamId) || (payload.requestId && session.requestId === payload.requestId)) releaseOnlineSession(id);
  }
  return { success: true };
});

ipcMain.handle('online-cache-status', async () => {
  const items = [...onlineCache.entries()].map(([vid, e]) => ({
    vid, size: e.size, vidIndex: e.vidIndex, seriesId: e.seriesId,
  }));
  return { success: true, count: items.length, bytes: onlineCacheTotal(), items };
});

ipcMain.handle('clear-online-cache', async () => {
  clearOnlineCache();
  return { success: true };
});

// ===== 兼容模式：把 HEVC 转成 H.264，解决「黑屏有声」=====
const COMPAT_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 转码缓存上限
let compatDir = null;
let compatEncoder = null; // 探测到的最优 H.264 编码器

function getCompatDir() {
  if (!compatDir) {
    compatDir = path.join(app.getPath('userData'), 'compat-cache');
    try { fs.mkdirSync(compatDir, { recursive: true }); } catch (_) {}
    // No jobs have used this directory yet; remove leftovers from an interrupted run.
    try {
      for (const name of fs.readdirSync(compatDir)) {
        if ((name.startsWith('.tmp_') && name.endsWith('.mp4')) || name.endsWith('.mp4.part')) {
          try { fs.unlinkSync(path.join(compatDir, name)); } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return compatDir;
}

function compatFileName(seriesId, vidIndex, quality = 'auto') {
  if (!['string', 'number'].includes(typeof vidIndex) || !/^[1-9]\d*$/.test(String(vidIndex))
    || !Number.isSafeInteger(Number(vidIndex))) throw new Error('集数必须是有效正整数');
  return `${sanitizeFolderName(String(seriesId))}_${String(Number(vidIndex)).padStart(3, '0')}${quality === 'auto' ? '' : `_${playbackQuality(quality)}`}.mp4`;
}

function compatPathFor(seriesId, vidIndex, quality = 'auto') {
  return path.join(getCompatDir(), compatFileName(seriesId, vidIndex, quality));
}

function compatCacheStatus() {
  const dir = getCompatDir();
  let files = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.mp4') || f.startsWith('.tmp_')) continue;
      try { bytes += fs.statSync(path.join(dir, f)).size; files++; } catch (_) {}
    }
  } catch (_) {}
  return { dir, files, bytes };
}

function trimCompatCache(currentOutput) {
  const dir = getCompatDir();
  const protectedFiles = new Set([currentOutput]);
  for (const [output, job] of compatPreparing) {
    protectedFiles.add(output);
    for (const file of job.files || []) protectedFiles.add(file);
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.mp4') && !f.startsWith('.tmp_'))
      .map((f) => {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        return { p, size: st.size, at: st.atimeMs || st.mtimeMs };
      });
  } catch (_) { return; }
  let total = entries.reduce((s, e) => s + e.size, 0);
  if (total <= COMPAT_MAX_BYTES) return;
  entries.sort((a, b) => a.at - b.at); // 最早访问的先删
  for (const e of entries) {
    if (total <= COMPAT_MAX_BYTES) break;
    if (protectedFiles.has(e.p)) continue;
    try { fs.unlinkSync(e.p); total -= e.size; } catch (_) {}
  }
}

/** 探测可用的 H.264 编码器：先看列表，再实际试编一帧（列表里有不代表能用，如无 N 卡时的 nvenc） */
async function pickH264Encoder(ffmpegPath, task) {
  if (compatEncoder) return compatEncoder;
  const { execFile } = require('child_process');

  const list = await new Promise((resolve) => {
    const child = execFile(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 20000 }, (err, stdout) => {
      if (task?.child === child) delete task.child;
      resolve(String(stdout || ''));
    });
    if (task) task.child = child;
  });
  if (task?.cancelled) throw new Error('已取消');

  const candidates = (process.platform === 'darwin'
    ? ['h264_videotoolbox', 'libx264']
    : ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264']).filter((e) =>
    list.includes(e)
  );
  if (!candidates.includes('libx264')) candidates.push('libx264'); // 软件兜底

  const works = (enc) =>
    new Promise((resolve) => {
      const child = execFile(
        ffmpegPath,
        ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
         '-frames:v', '1', '-c:v', enc, '-f', 'null', '-'],
        { timeout: 25000 },
        (err) => { if (task?.child === child) delete task.child; resolve(!err); }
      );
      if (task) task.child = child;
    });

  for (const enc of candidates) {
    if (task?.cancelled) throw new Error('已取消');
    if (await works(enc)) {
      compatEncoder = enc;
      break;
    }
    console.log('[Compat] 编码器不可用，跳过:', enc);
  }
  if (!compatEncoder) compatEncoder = 'libx264';
  console.log('[Compat] 使用编码器:', compatEncoder);
  return compatEncoder;
}

/**
 * 转码为 H.264/AAC。
 * 返回 { success, path, size, elapsed }
 */
const compatPreparing = new Map();
const compatRequests = new Map();
let compatClearing = null;
const compatCancelled = () => ({ success: false, cancelled: true, error: '已取消转码' });
function cancelCompatJob(job) {
  job.cancelled = true;
  job.controller.abort();
}
ipcMain.handle('cancel-transcode-for-playback', async (_event, payload = {}) => {
  if (!payload.seriesId || payload.vidIndex == null) return { success: false };
  let key;
  try { key = compatPathFor(payload.seriesId, payload.vidIndex, playbackQuality(payload.quality, payload.vid || payload.seriesId)); }
  catch (error) { return { success: false, error: error.message }; }
  const request = payload.requestId ? compatRequests.get(String(payload.requestId)) : null;
  // An old request must never fall back to cancelling the newest job for this episode.
  if (payload.requestId && (!request || request.key !== key)) return { success: true };
  const job = request ? request.job : compatPreparing.get(key);
  if (request) request.cancelled = true;
  if (job && (!request || [...job.requests.values()].every(item => item.cancelled))) {
    cancelCompatJob(job);
    await job.promise;
  }
  return { success: true };
});
ipcMain.handle('transcode-for-playback', async (event, payload = {}) => {
  if (!payload.seriesId || payload.vidIndex == null) return { success: false, error: '缺少剧集信息' };
  let key;
  try { key = compatPathFor(payload.seriesId, payload.vidIndex, playbackQuality(payload.quality, payload.vid || payload.seriesId)); }
  catch (error) { return { success: false, error: error.message }; }
  const requestId = String(payload.requestId || randomUUID());
  const existing = compatRequests.get(requestId);
  if (existing) return existing.key === key ? existing.promise : { success: false, error: '请求标识已用于其他剧集' };
  // Register before every await, including permission lookup and a cancelled predecessor.
  const previous = compatPreparing.get(key);
  let job = previous;
  if (job && !job.cancelled && job.sourceVid !== String(payload.vid || '')) return { success: false, error: '该集已有不同来源的准备请求，请稍后重试' };
  if (!job || job.cancelled) {
    job = { controller: new AbortController(), cancelled: false, requests: new Map(), files: new Set(), sourceVid: String(payload.vid || '') };
    const clearing = compatClearing;
    job.promise = Promise.resolve().then(async () => {
      if (previous) await previous.promise;
      if (clearing) await clearing;
      if (job.cancelled) return compatCancelled();
      return transcodeForPlayback(payload, job);
    }).catch(error => ({ success: false, error: error.message })).finally(() => {
      if (compatPreparing.get(key) === job) compatPreparing.delete(key);
    });
    compatPreparing.set(key, job);
  }
  const request = { key, job, requestId, cancelled: false };
  job.requests.set(requestId, request);
  compatRequests.set(requestId, request);
  request.promise = job.promise.then(result => ({ ...(request.cancelled ? compatCancelled() : result), requestId })).finally(() => {
    job.requests.delete(requestId);
    if (compatRequests.get(requestId) === request) compatRequests.delete(requestId);
  });
  return request.promise;
});

async function transcodeForPlayback(payload, job = { controller: new AbortController() }) {
  let tmpInput, tmpOut, diskInput;
  const signal = job.controller.signal;
  const checkCancelled = () => { if (signal.aborted) throw new Error('已取消转码'); };
  const abortPreparation = () => {
    const child = job.child;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch (_) {}
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  };
  const reportProgress = data => {
    if (!job.requests) return sendToRenderer('transcode-progress', { ...data, requestId: payload.requestId });
    for (const request of job.requests.values()) {
      if (!request.cancelled) sendToRenderer('transcode-progress', { ...data, requestId: request.requestId });
    }
  };
  signal.addEventListener('abort', abortPreparation, { once: true });
  try {
    checkCancelled();
    const { seriesId, vidIndex, filePath, force } = payload || {};
    const quality = playbackQuality(payload.quality, payload.vid || seriesId);
    if (!seriesId || vidIndex == null) return { success: false, error: '缺少剧集信息' };
    const out = compatPathFor(seriesId, vidIndex, quality);
    job.files ||= new Set();
    if (filePath) job.files.add(filePath);
    if (filePath && fs.existsSync(filePath) && !isInsideMediaRoot(filePath) && !isRecordedMediaFile(filePath, payload)) {
      return { success: false, error: '只能转码下载目录中的视频' };
    }
    if (!(filePath && fs.existsSync(filePath)) && (/^(xifan|hema|custom):/.test(String(seriesId)) || /^(xifan|hema|custom):/.test(String(payload.vid)))) {
      const current = await hongguo.fetchEpisodeList(seriesId);
      checkCancelled();
      const episode = current.episodes.find(ep => Number(ep.vid_index) === Number(vidIndex));
      if (!episode || (payload.vid && payload.vid !== episode.vid)) return { success: false, error: '分集来源不匹配' };
      if (episode.locked) return { success: false, error: '该集已锁定，请在来源平台解锁' };
    }

    if (!force && fs.existsSync(out) && fs.statSync(out).size > 1024 * 100) {
      // 命中缓存
      try { fs.utimesSync(out, new Date(), new Date()); } catch (_) {}
      return { success: true, url: localPlayUrl(out), size: fs.statSync(out).size, cached: true };
    }

    const ffmpegPath = resolveFfmpeg('ffmpeg');
    const ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath) return { success: false, error: '未找到 ffmpeg，无法转码' };

    // 1) 优先本地原件；强制重建时跳过在线缓存，重新获取输入。
    let inputPath = filePath || null;
    if (!inputPath || !fs.existsSync(inputPath)) {
      const vid = payload.vid;
      if (!vid) return { success: false, error: '既没有本地文件，也没有 vid' };
      const cached = !force && onlineCache.get(onlineCacheKey(vid, quality));
      if (cached?.filePath) { diskInput = cached; cached.disk.readers++; inputPath = cached.filePath; }
      else {
        const playInfo = String(vid).startsWith('custom:') ? await hongguo.fetchPlayUrlSingle(String(vid),seriesId,{force:!!force,quality}) : null;
        tmpInput = path.join(getCompatDir(), `.tmp_${randomUUID()}.mp4`);
        if (playInfo) await withMediaRecovery(vid,seriesId,{playInfo,signal,quality},async candidate => {
          if (candidate.format === 'hls') await prepareHlsFile(candidate,tmpInput,{signal});
          else {
            const buf = await fetchDecryptedEpisodeOnce(String(vid),()=>{},seriesId,candidate,signal);
            checkCancelled(); fs.writeFileSync(tmpInput,buf);
          }
        });
        else {
          const buf = cached?.buffer || await fetchDecryptedEpisode(String(vid), () => {}, seriesId, playInfo, signal, ONLINE_MAX_BYTES, !!force, quality);
          checkCancelled(); fs.writeFileSync(tmpInput,buf);
        }
        inputPath = tmpInput;
      }
    }

    if (quality !== 'auto') await verifyDownloadQuality(inputPath, quality);
    const duration = ffprobePath ? await probeDuration(ffprobePath, inputPath, job) : 0;
    checkCancelled();
    let encoder = force ? 'libx264' : await pickH264Encoder(ffmpegPath, job);
    checkCancelled();

    const started = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      checkCancelled();
      // 2) 转码（硬件编码器用各自推荐的参数）
      const encArgs = encoder === 'libx264'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.2']
        : encoder === 'h264_videotoolbox'
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-pix_fmt', 'yuv420p']
        : encoder === 'h264_nvenc'
        ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-b:v', '0']
        : encoder === 'h264_qsv'
        ? ['-c:v', 'h264_qsv', '-global_quality', '23']
        : encoder === 'h264_amf'
        ? ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23']
        : ['-c:v', encoder, '-cq', '23'];

      tmpOut = out + '.part';
      try { fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut); } catch (_) {}

      const { spawn } = require('child_process');
      const args = [
        '-y', '-hide_banner', '-i', inputPath,
        ...encArgs,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats',
        '-f', 'mp4', tmpOut,
      ];

      console.log(`[Compat] 转码 第${vidIndex}集  编码器=${encoder}  时长=${duration.toFixed(0)}s`);
      let stderrTail = '';
      const code = await new Promise((resolve) => {
        const child = spawn(ffmpegPath, args, { windowsHide: true });
        let killTimer;
        const abort = () => {
          try { child.kill('SIGTERM'); } catch (_) {}
          killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
          killTimer.unref?.();
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const m = line.match(/^out_time_us=(\d+)/);
            if (m && duration > 0) {
              const sec = parseInt(m[1], 10) / 1e6;
              const pct = Math.max(0, Math.min(99, Math.floor((sec / duration) * 100)));
              reportProgress({ seriesId: String(seriesId), vidIndex: Number(vidIndex), percent: pct });
            }
          }
        });
        child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-1500); });
        child.on('error', (e) => { stderrTail += ' | spawn: ' + e.message; resolve(-1); });
        child.on('close', (c) => {
          signal.removeEventListener('abort', abort);
          clearTimeout(killTimer);
          resolve(c);
        });
      });
      checkCancelled();

      if (code !== 0 || !fs.existsSync(tmpOut)) {
        try { fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut); } catch (_) {}
        const tail = stderrTail.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
        console.warn('[Compat] 转码失败 code=', code, tail);
        if (encoder !== 'libx264') {
          encoder = 'libx264';
          continue;
        }
        return { success: false, error: `软件转码失败（ffmpeg 退出码 ${code}）${tail ? '：' + tail : ''}` };
      }
      break;
    }

    fs.renameSync(tmpOut, out);
    trimCompatCache(out);
    const size = fs.statSync(out).size;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[Compat] 完成 ${(size / 1048576).toFixed(1)}MB  用时 ${elapsed}s`);

    reportProgress({ seriesId: String(seriesId), vidIndex: Number(vidIndex), percent: 100, done: true });
    return { success: true, url: localPlayUrl(out), size, elapsed: Number(elapsed), encoder };
  } catch (error) {
    if (signal.aborted) return compatCancelled();
    console.error('[Compat] 转码失败:', error.message);
    return { success: false, error: error.message, code: error.code };
  } finally {
    signal.removeEventListener('abort', abortPreparation);
    if (diskInput) { diskInput.disk.readers--; disposeOnlineDisk(diskInput); }
    for (const temporary of [tmpInput, tmpOut]) {
      if (temporary) { try { await fsp.unlink(temporary); } catch (_) {} }
    }
  }
}

ipcMain.handle('compat-cache-status', async () => {
  const st = compatCacheStatus();
  return { success: true, ...st, maxBytes: COMPAT_MAX_BYTES };
});

ipcMain.handle('clear-compat-cache', async () => {
  if (compatClearing) return compatClearing;
  const jobs = [...compatPreparing.values()];
  for (const job of jobs) cancelCompatJob(job);
  const clearing = Promise.all(jobs.map(job => job.promise)).then(() => {
    const dir = getCompatDir();
    let freed = 0, count = 0, failed = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.mp4') && !f.endsWith('.part')) continue;
        const p = path.join(dir, f);
        try { const size = fs.statSync(p).size; fs.unlinkSync(p); freed += size; count++; } catch (_) { failed++; }
      }
    } catch (_) { failed++; }
    return { success: failed === 0, count, freed, error: failed ? '部分兼容缓存删除失败，请稍后重试' : undefined };
  }).finally(() => { if (compatClearing === clearing) compatClearing = null; });
  compatClearing = clearing;
  return clearing;
});

/** 报告本机是否能解码 HEVC（供界面提前提示） */
ipcMain.handle('decode-capability', async () => ({
  ffmpegEncoder: compatEncoder || null,
  compatDir: getCompatDir(),
}));



/**
 * 把若干集加入下载队列（批量下载与播放器「下载本集」共用）。
 * 返回新建的任务数。
 */
async function enqueueEpisodes({ seriesId, seriesTitle, episodes, cover, quality }) {
  if (!Array.isArray(episodes) || episodes.length === 0) return 0;
  const settings = getCurrentSettings();
  const downloadQuality = normalizeDownloadQuality(quality ?? settings.download_quality);
  if (/^(xifan|hema|custom):/.test(String(seriesId))) {
    const current = await hongguo.fetchEpisodeList(seriesId);
    episodes = episodes.map(requested => {
      const ep = current.episodes.find(item => item.vid === requested.vid && Number(item.vid_index) === Number(requested.vid_index));
      if (!ep) throw new Error('分集不属于所选来源，请重新打开剧集');
      if (ep.locked) throw new Error('该集已锁定，请在来源平台解锁');
      return ep;
    });
  } else if (episodes.some(ep => /^(xifan|hema|custom):/.test(String(ep.vid)))) {
    throw new Error('剧集来源不匹配');
  }

  // Validate duplicate quality before changing the queue or files. Never replace a user's file.
  for (const ep of episodes) {
    const dup = downloadTasks.find(t => String(t.hongguoInfo?.vid) === String(ep.vid));
    if (!dup) continue;
    if (['pending', 'downloading'].includes(dup.status) && normalizeDownloadQuality(dup.downloadQuality) !== downloadQuality) {
      throw new Error('同一集已有其他清晰度的下载任务，请先停止该任务再重新选择');
    }
    if (dup.status === 'completed' && hasCompleteTaskFile(dup)) {
      dup.actualQuality = await verifyDownloadQuality(dup.savePath, downloadQuality, true);
    }
  }
  const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : app.getPath('downloads');
  const cleanSeriesTitle = sanitizeFolderName(seriesTitle) || '红果短剧';
  const downloadDir = seriesDownloadDir(root, seriesId, cleanSeriesTitle);
  try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (_) {}

  const batchId = 'hongguobatch_' + randomUUID();
  const firstCover = cover || (episodes[0] && episodes[0].cover) || '';

  const batchInfo = {
    batchId,
    platform: 'hongguo',
    nickname: `《${cleanSeriesTitle}》`,
    avatar: firstCover,
    totalCount: episodes.length,
    createTime: Date.now(),
  };

  let created = 0;
  const changedTasks = [];
  const previousQueue = downloadQueue.slice();
  for (const ep of episodes) {
    const epIndexStr = String(ep.vid_index).padStart(3, '0');
    const filename = uniqueEpisodeFilename(settings, cleanSeriesTitle, ep);
    const finalPath = path.join(downloadDir, filename);

    // 已有同一集在队列/已完成，避免重复建任务
    const dup = downloadTasks.find(
      (t) => t.hongguoInfo && String(t.hongguoInfo.vid) === String(ep.vid)
    );
    if (dup) {
      // 已停止或失败的重新入队
      if (dup.status === 'stopped' || dup.status === 'failed' || (dup.status === 'completed' && !hasCompleteTaskFile(dup))) {
        changedTasks.push({ task: dup, previous: { ...dup } });
        repairTaskDestination(dup);
        dup.status = 'pending';
        dup.cancelled = false;
        dup.progress = 0;
        dup.receivedBytes = 0;
        dup.totalBytes = 0;
        dup.downloadQuality = downloadQuality;
        delete dup.actualQuality;
        delete dup.error;
        if (!downloadQueue.some((t) => t.id === dup.id)) downloadQueue.push(dup);
        created++;
      }
      continue;
    }

    const task = {
      id: randomUUID(),
      batchId,
      batchInfo,
      savePath: finalPath,
      customDir: downloadDir,
      title: `《${cleanSeriesTitle}》第${epIndexStr}集${ep.title ? ' ' + ep.title : ''}`,
      filename,
      platform: 'hongguo',
      type: 'hongguo',
      downloadQuality,
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      startTime: Date.now(),
      videoInfo: {
        author: cleanSeriesTitle,
        title: `《${cleanSeriesTitle}》第${epIndexStr}集`,
        cover: ep.cover || firstCover,
        aweme_id: ep.vid,
      },
      hongguoInfo: {
        vid: ep.vid,
        series_id: seriesId,
        series_title: cleanSeriesTitle,
        vid_index: ep.vid_index,
        ep_title: ep.title,
      },
    };

    downloadTasks.unshift(task);
    downloadQueue.push(task);
    sendToRenderer('download-task-added', task);
    created++;
  }

  try { saveDownloadTasks(); }
  catch (error) {
    // An unpersisted submission must not start later through another queue action.
    downloadTasks = downloadTasks.filter(task => task.batchId !== batchId);
    for (const { task, previous } of changedTasks) Object.assign(task, previous);
    downloadQueue = previousQueue;
    sendToRenderer('download-queue-changed', {});
    throw error;
  }
  pumpQueue();
  return created;
}

ipcMain.handle('hongguo-download-batch', async (event, payload) => {
  try {
    const { seriesId, seriesTitle, episodes, quality, export: exportKinds } = payload || {};
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return { success: false, error: '未选择集数' };
    }
    const count = await enqueueEpisodes({ seriesId, seriesTitle, episodes, quality });
    const kinds = exportKinds || {};
    const wantExport = kinds.danmaku === true || kinds.comments === true || kinds.reviews === true;
    // 文字导出转后台：不阻塞下载响应，任何异常都吞掉并经事件回报，绝不影响视频下载。
    if (wantExport) {
      try {
        const settings = getCurrentSettings();
        const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : app.getPath('downloads');
        const cleanTitle = sanitizeFolderName(seriesTitle) || '红果短剧';
        const downloadDir = seriesDownloadDir(root, seriesId, cleanTitle);
        try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (_) {}
        const stems = episodes.map(ep => ({
          vid: ep.vid, vid_index: ep.vid_index,
          stem: uniqueEpisodeFilename(settings, cleanTitle, ep).replace(/\.mp4$/, ''),
        }));
        exportSeriesText({ seriesId, seriesTitle, episodes: stems, kinds, downloadDir, reviewsBaseName: cleanTitle })
          .then(r => sendToRenderer('text-export-done', { seriesId, ...r }))
          .catch(error => sendToRenderer('text-export-done', { seriesId, failed: true, error: String(error?.message || error) }));
      } catch (error) {
        console.error('[Hongguo] 文字导出启动失败:', error.message);
        sendToRenderer('text-export-done', { seriesId, failed: true, error: error.message });
      }
    }
    return { success: true, count, requested: episodes.length, exportRequested: wantExport };
  } catch (error) {
    console.error('[Hongguo] 提交批量下载失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 播放器里「下载本集」：按 series_id + vid_index 补单集
ipcMain.handle('download-single-episode', async (event, seriesId, vidIndex, quality) => {
  try {
    const entry = seriesRegistry.find((s) => String(s.series_id) === String(seriesId));
    if (!entry) return { success: false, error: '未找到该剧档案，请先解析一次' };
    const ep = entry.episodes.find((e) => Number(e.vid_index) === Number(vidIndex));
    if (!ep) return { success: false, error: '未找到该集' };
    const count = await enqueueEpisodes({
      seriesId: entry.series_id,
      seriesTitle: entry.series_title,
      episodes: [{ ...ep, cover: entry.cover }],
      cover: entry.cover,
      quality,
    });
    return { success: true, count };
  } catch (error) {
    console.error('[Player] 下载单集失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 观看记录与更新检测 =====
let historyRefresh = null;
const historyItemChecks = new Map();
const historySequelPending = new Map();
const historySequelCache = new Map();
const HISTORY_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const HISTORY_COMPLETED_LOW_INTERVAL = 24 * 60 * 60 * 1000;
const HISTORY_SEQUEL_INTERVAL = 24 * 60 * 60 * 1000;
const HISTORY_BATCH_BUDGET = 90 * 1000;
const HISTORY_ITEM_TIMEOUT = 10 * 1000;
const HISTORY_SEQUEL_TIMEOUT = 12 * 1000;
const HISTORY_GROUP_CONCURRENCY = 2;
const HISTORY_EPISODE_CONCURRENCY = 2;
const HISTORY_SEQUEL_CACHE_TTL = 30 * 60 * 1000;
const HISTORY_SEQUEL_FAILURE_TTL = 5 * 60 * 1000;
const HISTORY_SCOPES = new Set(['all', 'latest', 'unfinished', 'skip-completed-low']);

function historyRows() {
  return watchHistory.listHistory(seriesRegistry, store.getPlayback(), getCurrentSettings().watch_sequels_enabled !== false);
}

function historyOptions(value) {
  const raw = typeof value === 'boolean' ? { force: value } : (value && typeof value === 'object' ? value : {});
  return { force: raw.force === true, scope: HISTORY_SCOPES.has(raw.scope) ? raw.scope : 'all' };
}

function historyGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = watchHistory.familyKey(row) || `series:${row.series_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function historyFamilyRows(allRows, row) {
  const key = watchHistory.familyKey(row);
  return key ? allRows.filter(item => watchHistory.familyKey(item) === key) : [row];
}

function historyScopeRows(rows, scope) {
  if (scope === 'latest') return rows.filter(row => row.isLatestSeason);
  if (scope === 'unfinished') return rows.filter(row => !row.completed);
  if (scope === 'skip-completed-low') return rows.filter(row => !(row.completed && !row.isLatestSeason));
  return rows;
}

function historyInterval(row) {
  return row.completed && !row.isLatestSeason ? HISTORY_COMPLETED_LOW_INTERVAL : HISTORY_CHECK_INTERVAL;
}

function historyPriority(row) {
  if (row.hasUpdates) return 0;
  if (!row.completed) return 1;
  if (row.isLatestSeason) return 2;
  return 3;
}

function historyDeadline(ms) {
  return Date.now() + ms;
}

function historyTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

async function runHistoryPool(items, concurrency, worker, deadline = 0) {
  let cursor = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      if (deadline && Date.now() >= deadline) return;
      const item = items[cursor++];
      await worker(item);
    }
  }));
}

function historySequelResult(series, deadline, retryFailed = false) {
  const key = watchHistory.familyKey(series) || `series:${series.series_id}`;
  const now = Date.now();
  let cached = historySequelCache.get(key);
  if (retryFailed && cached && (cached.result?.success !== true || cached.result?.partial === true)) {
    historySequelCache.delete(key);
    cached = null;
  }
  if (cached && cached.expires > now) return Promise.resolve(cached.result);
  if (historySequelPending.has(key)) return historySequelPending.get(key);
  const task = (async () => {
    const searchDeadline = Math.min(deadline || historyDeadline(HISTORY_SEQUEL_TIMEOUT), historyDeadline(HISTORY_SEQUEL_TIMEOUT));
    const local = watchHistory.findSequels(series, seriesRegistry.filter(item => !item.forgotten));
    let result;
    try {
      result = await historyTimeout(seriesSearch.findSeriesSequels(series, seriesRegistry.filter(item => !item.forgotten),
        (keyword, call) => searchAtSource(keyword, {
          source: watchHistory.sourceOf(String(series.series_id)), deadline: searchDeadline, ...(call || {}),
        }), { deadline: searchDeadline }), Math.max(1000, searchDeadline - Date.now()), '续作搜索超时');
    } catch (error) {
      result = { success: false, results: local, candidates: local, partial: true, error: error.message };
    }
    const ok = result?.success === true && result?.partial !== true;
    historySequelCache.set(key, {
      result, expires: Date.now() + (ok ? HISTORY_SEQUEL_CACHE_TTL : HISTORY_SEQUEL_FAILURE_TTL),
    });
    if (historySequelCache.size > 64) historySequelCache.delete(historySequelCache.keys().next().value);
    return result;
  })().finally(() => historySequelPending.delete(key));
  historySequelPending.set(key, task);
  return task;
}

function historyContext(rows, allRows, force, deadline, retryFailed = false) {
  const familyRows = historyFamilyRows(allRows, rows[0]);
  const latest = familyRows.reduce((best, row) => watchHistory.seasonOf(row) > watchHistory.seasonOf(best) ? row : best, familyRows[0]);
  const sequelDue = new Set();
  if (getCurrentSettings().watch_sequels_enabled !== false) {
    for (const row of rows) {
      const previous = store.getPlayback()[String(row.series_id)];
      if (force || Date.now() - (previous?.lastSequelCheckAt || 0) >= HISTORY_SEQUEL_INTERVAL) sequelDue.add(String(row.series_id));
    }
  }
  const latestSeries = seriesRegistry.find(item => String(item.series_id) === String(latest.series_id));
  const sequelPromise = sequelDue.size && latestSeries && watchHistory.sourceOf(String(latestSeries.series_id))
    ? historySequelResult(latestSeries, deadline, retryFailed) : null;
  return { sequelDue, sequelPromise, deadline, notifiedSequelIds: new Set() };
}

async function checkHistoryRow(row, context) {
  const sid = String(row.series_id);
  if (historyItemChecks.has(sid)) return historyItemChecks.get(sid);
  const task = (async () => {
    const itemDeadline = Math.min(context.deadline, historyDeadline(HISTORY_ITEM_TIMEOUT));
    try {
      const fresh = await historyTimeout(hongguo.fetchEpisodeList(sid, { force: true, deadline: itemDeadline }),
        Math.max(1, itemDeadline - Date.now()), '分集更新检查超时');
      if (!Array.isArray(fresh?.episodes) || !fresh.episodes.length) throw new Error('来源没有返回分集，请稍后重试');

      let sequelResponse = null;
      if (context.sequelPromise && context.sequelDue.has(sid)) sequelResponse = await context.sequelPromise;

      // Re-read after network waits: a concurrent player save or episode refresh must not be rolled back.
      const map = store.getPlayback();
      if (!map[sid]) return { status: 'skipped' };
      const currentSeries = seriesRegistry.find(item => String(item.series_id) === sid);
      if (!currentSeries) return { status: 'skipped' };
      const previousRecord = map[sid];
      const next = watchHistory.applyEpisodeUpdate(previousRecord, currentSeries, fresh);
      if (sequelResponse) {
        const candidates = watchHistory.findSequels(currentSeries, sequelResponse.candidates || sequelResponse.results || []);
        const combined = new Map((previousRecord.sequels || []).map(item => [item.series_id, item]));
        for (const item of candidates) combined.set(item.series_id, item);
        next.sequels = [...combined.values()].slice(-20);
        next.lastSequelCheckError = sequelResponse.partial ? (sequelResponse.error || '请稍后重试') : '';
        if (sequelResponse.success === true && sequelResponse.partial !== true) next.lastSequelCheckAt = Date.now();
      }
      next.lastCheckError = next.lastSequelCheckError ? `续作检查未完成：${next.lastSequelCheckError}` : '';
      const newEpisodes = next.knownTotal > (previousRecord.knownTotal ?? currentSeries.total ?? currentSeries.episodes?.length ?? 0);
      const knownSequels = new Set((previousRecord.sequels || []).map(item => item.series_id));
      const rowCandidates = sequelResponse
        ? watchHistory.findSequels(currentSeries, sequelResponse.candidates || sequelResponse.results || [])
        : [];
      const newSequel = sequelResponse?.success === true && rowCandidates.some(item => !knownSequels.has(item.series_id));
      if (fresh.episodes.length >= (currentSeries.episodes?.length || 0)) {
        const wasDismissed = currentSeries.dismissed === true;
        const wasForgotten = currentSeries.forgotten === true;
        upsertSeriesRegistry(fresh);
        if (wasDismissed) {
          Object.assign(seriesRegistry.find(item => String(item.series_id) === sid), { dismissed: true, forgotten: wasForgotten });
          saveSeriesRegistry();
        }
      }
      map[sid] = next;
      store.savePlayback(map);
      const settings = getCurrentSettings();
      const unseenSequels = rowCandidates.filter(item => !knownSequels.has(item.series_id) && !context.notifiedSequelIds.has(item.series_id));
      for (const item of unseenSequels) context.notifiedSequelIds.add(item.series_id);
      if ((newEpisodes || unseenSequels.length) && settings.watch_notifications_enabled === true && Notification?.isSupported()) {
        try {
          const title = currentSeries.series_title || fresh.series_title || '短剧';
          const notification = new Notification({ title: `${title} 有更新`,
            body: newEpisodes ? `已更新至 ${next.knownTotal} 集，打开观看记录继续看。` : '发现疑似新一季，打开观看记录查看。' });
          notification.on('click', () => {
            if (!mainWindow || mainWindow.isDestroyed()) createWindow();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show(); mainWindow.focus();
            sendToRenderer('navigate', { page: 'history' });
          });
          notification.show();
        } catch (error) { console.warn('[History] 系统通知不可用:', error.message); }
      }
      return { status: 'checked', hasUpdates: newEpisodes || newSequel,
        error: next.lastEpisodeCheckError || next.lastSequelCheckError || '' };
    } catch (error) {
      const map = store.getPlayback();
      if (map[sid]) {
        map[sid] = { ...map[sid], lastCheckedAt: Date.now(), lastEpisodeCheckError: error.message,
          lastSequelCheckError: map[sid].lastSequelCheckError || '', lastCheckError: error.message };
        store.savePlayback(map);
      }
      return { status: 'failed', error: error.message };
    }
  })().finally(() => historyItemChecks.delete(sid));
  historyItemChecks.set(sid, task);
  return task;
}

async function refreshWatchHistory(forceOrOptions = false) {
  if (historyRefresh) return historyRefresh;
  const options = historyOptions(forceOrOptions);
  if (!options.force && getCurrentSettings().watch_updates_enabled === false) {
    return { success: true, checked: 0, failed: 0, remaining: 0, disabled: true };
  }
  historyRefresh = (async () => {
    const now = Date.now();
    const allRows = historyRows();
    const scoped = historyScopeRows(allRows, options.scope);
    const eligible = scoped.filter(item => options.force || now - item.lastCheckedAt >= historyInterval(item));
    const groups = historyGroups(eligible).sort((a, b) => {
      const priority = rows => Math.min(...rows.map(historyPriority));
      return priority(a) - priority(b) || Math.max(...b.map(row => row.updatedAt)) - Math.max(...a.map(row => row.updatedAt));
    });
    const deadline = historyDeadline(HISTORY_BATCH_BUDGET);
    const processed = new Set();
    let checked = 0, failed = 0, skipped = 0;
    sendToRenderer('watch-history-progress', { phase: 'start', total: eligible.length, checked, failed, current: '', remaining: eligible.length });
    await runHistoryPool(groups, HISTORY_GROUP_CONCURRENCY, async group => {
      if (Date.now() >= deadline) return;
      const context = historyContext(group, allRows, options.force, deadline, options.force);
      await runHistoryPool(group, HISTORY_EPISODE_CONCURRENCY, async row => {
        const result = await checkHistoryRow(row, context);
        processed.add(String(row.series_id));
        if (result.status === 'checked') { checked++; if (result.error) failed++; }
        else if (result.status === 'failed') failed++;
        else skipped++;
        const remaining = eligible.filter(item => !processed.has(String(item.series_id))).length;
        sendToRenderer('watch-history-progress', {
          phase: 'running', total: eligible.length, checked, failed, skipped, current: row.series_title, remaining,
        });
      }, deadline);
    }, deadline);
    const remaining = eligible.filter(item => !processed.has(String(item.series_id))).length;
    sendToRenderer('watch-history-progress', { phase: 'done', total: eligible.length, checked, failed, skipped, current: '', remaining });
    sendToRenderer('watch-history-updated', {});
    return { success: true, checked, failed, skipped, remaining, total: eligible.length, scope: options.scope };
  })().catch(error => ({ success: false, error: error.message })).finally(() => { historyRefresh = null; });
  return historyRefresh;
}

ipcMain.handle('remove-watch-history', async (_event, seriesId) => {
  try {
    const map = { ...store.getPlayback() };
    delete map[String(seriesId)];
    store.savePlayback(map);
    sendToRenderer('watch-history-updated', { removedSeriesId: String(seriesId) });
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('get-watch-history', async () => ({ success: true, results: historyRows() }));
ipcMain.handle('refresh-watch-history', async (_event, options) => refreshWatchHistory({ force: true, scope: options?.scope }));
ipcMain.handle('check-watch-history-item', async (_event, seriesId) => {
  const sid = String(seriesId || '');
  const allRows = historyRows();
  const row = allRows.find(item => String(item.series_id) === sid);
  if (!row) return { success: false, error: '未找到这条观看记录，请刷新后重试。' };
  const context = historyContext([row], allRows, true, historyDeadline(HISTORY_ITEM_TIMEOUT + HISTORY_SEQUEL_TIMEOUT), true);
  const result = await checkHistoryRow(row, context);
  sendToRenderer('watch-history-updated', {});
  return { success: result.status !== 'failed', checked: result.status === 'checked' ? 1 : 0,
    failed: result.status === 'failed' || result.error ? 1 : 0, status: result.status, error: result.error || '' };
});
ipcMain.handle('acknowledge-watch-updates', async (_event, seriesId, snapshot) => {
  try {
    const map = store.getPlayback();
    const sid = String(seriesId);
    if (map[sid]) { map[sid] = watchHistory.acknowledge(map[sid], snapshot); store.savePlayback(map); }
    sendToRenderer('watch-history-updated', {});
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

// ===== IPC：设置 =====
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

const SETTINGS_KEYS = ['root', 'name_format', 'max_concurrent', 'download_quality', 'export_text', 'auto_delete_watched', 'compat_mode', 'cache_next_episode', 'show_danmaku_controls', 'app_updates_enabled', 'watch_updates_enabled', 'watch_sequels_enabled', 'watch_notifications_enabled', 'search_app_enabled', 'proxy_enabled', 'proxy_mode', 'proxy_host', 'proxy_port', 'proxy_username', 'proxy_password'];

function settingsForRenderer(settings) {
  const copy = { ...settings };
  copy.proxy_password_set = !!copy.proxy_password;
  delete copy.proxy_password;
  return copy;
}

function applyEditableSettings(current, incoming) {
  const source = normalizeProxySettings(incoming && typeof incoming === 'object' ? incoming : {});
  const merged = { ...current };
  for (const key of SETTINGS_KEYS) {
    if (key === 'proxy_password') continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) merged[key] = source[key];
  }
  if (source.clear_proxy_password === true) merged.proxy_password = '';
  else if (typeof source.proxy_password === 'string' && source.proxy_password.length > 0) merged.proxy_password = source.proxy_password;
  else merged.proxy_password = current.proxy_password || '';
  merged.custom_sources = current.custom_sources;
  return merged;
}

ipcMain.handle('get-settings', async () => settingsForRenderer(getCurrentSettings()));

async function saveSettings(settings) {
  try {
    const current = getCurrentSettings();
    const wasCheckingUpdates = current.app_updates_enabled !== false;
    const merged = applyEditableSettings(current, settings);
    merged.download_quality = normalizeDownloadQuality(merged.download_quality);
    validateProxyDraft(merged);
    // 先让代理真正生效，再落盘；任一步失败都恢复旧代理，避免坏配置锁死下次启动。
    try { await applyProxyWithTimeout(merged, 15000); }
    catch (error) {
      try { await applyProxyWithTimeout(current, 5000); } catch (_) { /* 旧配置也可能已不可用 */ }
      throw error;
    }
    // Window/source preferences may change while the native proxy operation is pending.
    const latest = applyEditableSettings(getCurrentSettings(), settings);
    latest.download_quality = merged.download_quality;
    try { store.saveSettings(latest); }
    catch (error) {
      try { await applyProxyWithTimeout(current, 5000); } catch (_) { /* 旧配置也可能已不可用 */ }
      throw error;
    }
    if (merged.app_updates_enabled === false) { updateDownloadGeneration++; appUpdateInstaller?.cancel(); }
    if (wasCheckingUpdates !== (merged.app_updates_enabled !== false)) {
      sendToRenderer('app-update-preference', merged.app_updates_enabled !== false);
    }
    getCurrentSettings(); // 刷新并发数
    proxyStartupFallback = false;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

let settingsSaveQueue = Promise.resolve();
ipcMain.handle('save-settings', (_event, settings) => {
  const result = settingsSaveQueue.then(() => saveSettings(settings));
  settingsSaveQueue = result.catch(() => {});
  return result;
});

// ===== IPC：网络代理 =====
ipcMain.handle('get-proxy-status', async () => {
  const settings = getCurrentSettings();
  const resolved = resolveProxyConfig(settings);
  return {
    enabled: settings.proxy_enabled === true,
    mode: resolved.mode,
    url: publicProxyUrl(resolved.url),
    effective: resolved.mode !== 'direct' && !!resolved.url,
  };
});

// 用当前表单值实测代理是否连通（未保存也能测）
ipcMain.handle('test-proxy', async (event, draft) => {
  const settings = applyEditableSettings(getCurrentSettings(), draft);
  const resolved = resolveProxyConfig(settings);
  if (resolved.mode === 'custom' && !resolved.url) {
    return { success: false, error: '请填写完整的代理地址与端口' };
  }

  // 只测 API/下载路由。system 使用启动快照，避免未保存的草稿读到当前手动/直连环境。
  let proxyOption = false;
  if (resolved.url) {
    try {
      const url = new URL(resolved.url);
      proxyOption = { protocol: url.protocol.replace(':', ''), host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
      if (url.username) proxyOption.auth = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    } catch (_) { return { success: false, error: '代理地址格式无效' }; }
  }

  const started = Date.now();
  try {
    const res = await axios.get('https://www.baidu.com', {
      timeout: 12000,
      proxy: proxyOption,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: () => true,
    });
    const ms = Date.now() - started;
    if (res.status >= 200 && res.status < 400) {
      return {
        success: true,
        elapsed: ms,
        mode: resolved.mode,
        via: publicProxyUrl(resolved.url) || '(直连)',
        message: `API/下载连通正常（HTTP ${res.status}，耗时 ${ms}ms）`,
      };
    }
    return { success: false, error: `请求返回 HTTP ${res.status}（耗时 ${ms}ms）` };
  } catch (error) {
    const ms = Date.now() - started;
    const code = (error && error.code) || '';
    let hint = publicProxyError(error.message, settings, resolved);
    if (code === 'ECONNREFUSED') hint = '代理端口拒绝连接，请确认代理软件已启动、端口填写正确';
    else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') hint = '连接超时，请检查代理地址/端口或代理是否可用';
    else if (code === 'ENOTFOUND') hint = '无法解析代理地址，请检查主机名';
    else if (/407/.test(hint)) hint = '代理需要认证，请填写用户名与密码';
    return { success: false, error: `${hint}（耗时 ${ms}ms）`, code };
  }
});

// ===== IPC：下载管理 =====
ipcMain.handle('get-download-tasks', () => {
  const STATUS_ORDER = {
    downloading: 0,
    pending: 1,
    failed: 2,
    stopped: 3,
    completed: 4,
  };
  const sorted = downloadTasks.slice().sort((a, b) => {
    const wa = STATUS_ORDER[a.status] ?? 99;
    const wb = STATUS_ORDER[b.status] ?? 99;
    if (wa !== wb) return wa - wb;
    if (wa <= 1) {
      return (a.hongguoInfo?.vid_index || 0) - (b.hongguoInfo?.vid_index || 0) || (a.startTime || 0) - (b.startTime || 0);
    }
    return (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0);
  });
  return sorted.map((task) => {
    const { cancelSource, writer, ...serializableTask } = task;
    const info = task.hongguoInfo;
    if (String(info?.series_id).startsWith('xifan:')
      && require('./src/native/xifan').episodeDisplayTitle(info.series_id, info.series_title, info.ep_title) !== info.ep_title) {
      serializableTask.title = `《${info.series_title}》第${String(info.vid_index).padStart(3, '0')}集`;
    }
    if (task.status === 'completed' && !hasCompleteTaskFile(task)) {
      return { ...serializableTask, status: 'failed', progress: 0, qualityNotice: '', error: '本地文件已丢失或路径冲突，请重新下载' };
    }
    return { ...serializableTask, qualityNotice: ['downloading', 'completed'].includes(task.status) ? task.qualityNotice || '' : '' };
  });
});


// ===== 文件清理（删除已下载的本地文件）=====

/** 单任务与单集共用：文件及其临时产物必须归目标记录独占。 */
function removeEpisodeFiles(paths, owners) {
  let freed = 0, failed = 0, count = 0, warning;
  for (const file of new Set(paths.filter(Boolean))) {
    const family = episodeFilePaths(file);
    if (!ownsEpisodeFiles(file, owners) || family.some(isFileInUse)
      || owners.some(task => mergeTasks.some(merge => String(merge.seriesId) === String(task.hongguoInfo?.series_id) && merge.status === 'running'))) {
      warning = '文件正在使用或登记给其他任务／合并产物，已保留文件和任务记录';
      continue;
    }
    for (const p of family) {
      try {
        if (fs.existsSync(p)) {
          const st = fs.statSync(p);
          fs.unlinkSync(p);
          freed += st.size; count++;
        }
      } catch (_) { failed++; }
    }
  }
  return { count, freed, failed, warning };
}

async function stopTaskAndWait(task) {
  clearSourceRetry(task);
  task.cancelled = true;
  task.cancelSource?.cancel('用户删除任务');
  task.writer?.destroy();
  task.status = 'stopped';
  downloadQueue = downloadQueue.filter(item => item.id !== task.id);
  await downloadRuns.get(task.id);
}

function isTaskInFlight(task) {
  return task.status === 'pending' || task.status === 'downloading' || runningDownloads.has(task.id);
}

function isFileInUse(file) {
  return runningDownloadPaths.has(file) || downloadTasks.some(task => task.savePath === file && isTaskInFlight(task));
}

function removeFinishedRecords(seriesId, saveChanges = false) {
  const ids = downloadTasks.filter(task => (seriesId == null || String(task.hongguoInfo?.series_id) === String(seriesId)) && !isTaskInFlight(task) && task.status === 'completed' && task.savePath && episodeFilePaths(task.savePath).every(file => !fs.existsSync(file))).map(task => task.id);
  if (ids.length || saveChanges) dropTaskRecords(ids);
}

/** 删掉一组任务记录（从内存与队列中移除） */
function dropTaskRecords(ids) {
  const set = new Set(ids.filter(id => !downloadTasks.some(task => task.id === id && isTaskInFlight(task))));
  const previousTasks = downloadTasks, previousQueue = downloadQueue;
  downloadTasks = downloadTasks.filter((t) => !set.has(t.id));
  downloadQueue = downloadQueue.filter((t) => !set.has(t.id));
  try { saveDownloadTasks(); }
  catch (error) { downloadTasks = previousTasks; downloadQueue = previousQueue; throw error; }
  return previousTasks.length - downloadTasks.length;
}

async function deleteTaskRecords(taskIds, options) {
  const deleteFiles = options?.deleteFiles === true;
  let freed = 0, failed = 0, fileCount = 0, count = 0;
  let cancelledRetries = false;
  const removed = [], errors = [], warnings = [];
  for (const id of new Set(taskIds)) {
    const task = downloadTasks.find(item => item.id === id);
    if (!task) continue;
    if (deleteFiles && mergeTasks.some(merge => String(merge.seriesId) === String(task.hongguoInfo?.series_id) && merge.status === 'running')) {
      failed++; errors.push('该剧正在合并，请完成或取消合并后再删除文件'); continue;
    }
    try {
      cancelledRetries = cancelScheduledRetries([task]) || cancelledRetries;
      clearSourceRetry(task);
      if (isTaskInFlight(task)) {
        await stopTaskAndWait(task);
        if (!downloadTasks.includes(task) || isTaskInFlight(task) || task.cancelled === false || task.retryAt) {
          errors.push('任务状态已变化，已保留文件和记录，请重试'); continue;
        }
      }
      if (deleteFiles) {
        const result = removeEpisodeFiles([task.savePath], [task]);
        freed += result.freed; fileCount += result.count; failed += result.failed;
        if (result.warning) { warnings.push(result.warning); errors.push(result.warning); }
        if (result.failed) { errors.push('部分文件删除失败，对应任务记录已保留'); continue; }
        if (result.warning) continue;
      }
      removed.push(id);
    } catch (error) { errors.push(error.message); }
  }
  try { if (removed.length || cancelledRetries) count = dropTaskRecords(removed); }
  catch (error) { errors.push(`任务记录保存失败，原记录已保留：${error.message}${cancelledRetries ? '；自动重试取消状态未保存' : ''}`); }
  return { success: errors.length === 0, count, fileCount, freed, failed, warning: warnings.length ? [...new Set(warnings)].join('；') : undefined, error: errors.length ? [...new Set(errors)].join('；') : undefined };
}

ipcMain.handle('delete-task', (_event, taskId, options) => {
  if (!downloadTasks.some(task => task.id === taskId)) return { success: false, count: 0, fileCount: 0, freed: 0, failed: 0, error: '任务不存在' };
  return deleteTaskRecords([taskId], options);
});

ipcMain.handle('delete-tasks', (_event, taskIds, options) => {
  if (!Array.isArray(taskIds) || !taskIds.length) return { success: false, count: 0, fileCount: 0, freed: 0, failed: 0, error: '没有要删除的任务' };
  return deleteTaskRecords(taskIds, options);
});

/**
 * 删除某一部剧的全部本地文件（含合并产物），并清理对应任务记录。
 * 剧集档案保留（仍能看到分集、可在线播放），只是变成「未下载」。
 */
function deleteSeriesFiles(seriesId, options) {
  try {
    const sid = String(seriesId);
    const includeMerged = !(options && options.includeMerged === false);
    if (mergeTasks.some(task => task.seriesId === sid && task.status === 'running')) return { success: false, error: '该剧正在合并，请完成或取消合并后再清理' };
    const entry = seriesRegistry.find(s => String(s.series_id) === sid);
    const title = entry?.series_title || '';
    const files = collectSeriesEpisodeFiles(sid, title);
    const { dir } = files;
    const paths = new Set([...files.episodePaths, ...files.temporaryPaths,
      ...(includeMerged ? [...files.mergedPaths, ...files.concatPaths] : [])]);
    const cancelledRetries = cancelScheduledRetries(downloadTasks.filter(task => String(task.hongguoInfo?.series_id) === sid));
    let count = 0, freed = 0, failed = files.scanFailed;
    for (const file of paths) {
      if (isFileInUse(file)) continue;
      try {
        if (!fs.existsSync(file)) continue;
        const size = fs.statSync(file).size;
        fs.unlinkSync(file);
        freed += size;
        count++;
      } catch (_) { failed++; }
    }
    // 只移除本剧空目录；未知文件与仍在下载的临时文件会使目录保留。
    try { if (dir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_) {}
    try { removeFinishedRecords(sid, cancelledRetries); }
    catch (error) { return { success: false, count, freed, failed, error: `文件清理已执行；任务记录保存失败，原记录已保留：${error.message}${cancelledRetries ? '；自动重试取消状态未保存' : ''}` }; }
    return { success: failed === 0, count, freed, failed, error: failed ? '部分文件删除失败，对应记录已保留' : undefined };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

ipcMain.handle('delete-series-files', (_event, seriesId, options) => deleteSeriesFiles(seriesId, options));

/** 删除单集本地文件（看完即删用） */
async function deleteEpisodeFile(seriesId, vidIndex) {
  try {
    const sid = String(seriesId);
    const idx = Number(vidIndex);
    if (!sid || !Number.isSafeInteger(idx) || idx < 1) return { success: false, error: '剧集信息无效', count: 0, freed: 0 };
    const tasks = downloadTasks.filter(task => String(task.hongguoInfo?.series_id) === sid && Number(task.hongguoInfo?.vid_index) === idx);
    if (tasks.some(isTaskInFlight) || mergeTasks.some(task => task.seriesId === sid && task.status === 'running')) return { success: false, error: '该集正在下载或合并，暂不删除', count: 0, freed: 0 };
    const entry = seriesRegistry.find(item => String(item.series_id) === sid);
    const scanned = collectSeriesEpisodeFiles(sid, entry?.series_title || '');
    const paths = [...tasks.map(task => task.savePath), ...scanned.ordered.filter(episode => episode.vid_index === idx).map(episode => episode.path),
      ...(scanned.dir ? [...scanned.episodeNames].filter(([, index]) => index === idx).map(([name]) => path.join(scanned.dir, name)) : [])];
    const cancelledRetries = cancelScheduledRetries(tasks);
    const result = removeEpisodeFiles(paths, tasks);
    const ids = tasks.filter(task => task.savePath && ownsEpisodeFiles(task.savePath, tasks)
      && episodeFilePaths(task.savePath).every(file => !fs.existsSync(file))).map(task => task.id);
    try { if (ids.length || cancelledRetries) dropTaskRecords(ids); }
    catch (error) { return { ...result, success: false, error: `文件清理已执行；任务记录保存失败，原记录已保留：${error.message}${cancelledRetries ? '；自动重试取消状态未保存' : ''}` }; }
    return { ...result, success: result.failed === 0 && !result.warning,
      error: [result.warning, result.failed ? '文件删除失败，任务记录已保留' : ''].filter(Boolean).join('；') || undefined };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

ipcMain.handle('delete-episode-file', (_event, seriesId, vidIndex) => deleteEpisodeFile(seriesId, vidIndex));

/** 前端先释放看完的媒体；只清本集，不影响预缓存的下一集。 */
ipcMain.handle('cleanup-watched-episode', async (_event, seriesId, vidIndex) => {
  try {
    const sid = String(seriesId), idx = Number(vidIndex);
    if (!sid || !Number.isSafeInteger(idx) || idx < 1) return { success: false, error: '剧集信息无效' };
    const matches = entry => entry && String(entry.seriesId) === sid && Number(entry.vidIndex) === idx;
    const compatFiles = ['auto', '720p', '1080p'].map(quality => compatPathFor(sid, idx, quality));
    if ([...onlineSessions.values()].some(session => matches(session.entry || session)) || compatFiles.some(file => compatPreparing.has(file))) {
      return { success: false, error: '该集仍在播放或准备，稍后再清理' };
    }
    const result = await deleteEpisodeFile(sid, idx);
    if (!result.success) return result;
    for (const [key, entry] of [...onlineCache]) {
      if (!matches(entry)) continue;
      const bytes = entry.size || 0;
      deleteOnlineCacheEntry(key);
      if (entry.filePath && fs.existsSync(entry.filePath)) { onlineCache.set(key, entry); result.failed++; continue; }
      result.freed += bytes;
      result.count++;
    }
    for (const file of compatFiles) {
      if (isFileInUse(file)) { result.failed++; continue; }
      try {
        if (fs.existsSync(file)) { const size = fs.statSync(file).size; fs.unlinkSync(file); result.freed += size; result.count++; }
      } catch (_) { result.failed++; }
    }
    result.success = !result.failed;
    if (!result.success) result.error = '部分缓存清理失败，请稍后重试';
    return result;
  } catch (error) { return { success: false, error: error.message }; }
});

/** 各处磁盘占用统计（用于展示「可释放多少」） */
/** 统计与删除共用同一目标集合：包括已移除档案和只有下载任务的剧。 */
function deletionTargets() {
  const targets = new Map();
  for (const series of seriesRegistry) {
    const id = String(series?.series_id || '').trim();
    if (id) targets.set(id, series.series_title || '');
  }
  for (const task of downloadTasks) {
    const info = task?.hongguoInfo;
    const id = String(info?.series_id || '').trim();
    if (!id) continue;
    if (!targets.has(id)) targets.set(id, info.series_title || '');
  }
  return [...targets].map(([series_id, series_title]) => ({ series_id, series_title }));
}

ipcMain.handle('get-storage-usage', async () => {
  try {
    const series = [];
    let totalBytes = 0;
    let totalFiles = 0;
    for (const target of deletionTargets()) {
      const entry = seriesRegistry.find(item => String(item.series_id) === target.series_id);
      const owned = collectSeriesEpisodeFiles(target.series_id, target.series_title || entry?.series_title || '');
      const merging = mergeTasks.some(task => String(task.seriesId) === String(target.series_id) && task.status === 'running');
      const paths = merging ? [] : new Set([...owned.episodePaths, ...owned.temporaryPaths, ...owned.mergedPaths, ...owned.concatPaths]);
      let bytes = 0, files = 0, merged = 0;
      for (const file of paths) {
        if (isFileInUse(file)) continue;
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) continue;
          bytes += stat.size; files++;
          if (owned.mergedPaths.has(file)) merged++;
        } catch (_) {}
      }
      totalBytes += bytes;
      totalFiles += files;
      series.push({
        series_id: target.series_id,
        series_title: target.series_title || entry?.series_title || '',
        total: (entry?.episodes || []).length,
        files,
        bytes,
        merged,
      });
    }
    series.sort((a, b) => b.bytes - a.bytes);
    return { success: true, totalBytes, totalFiles, series };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/** 删除所有已下载的本地文件（剧集档案保留，之后仍可在线看） */
ipcMain.handle('delete-all-downloaded', async () => {
  try {
    let freed = 0, count = 0, failed = 0, skipped = 0;
    const errors = [];
    const targets = deletionTargets();
    for (const { series_id: sid } of targets) {
      if (mergeTasks.some(task => String(task.seriesId) === String(sid) && task.status === 'running')) { skipped++; continue; }
      const result = deleteSeriesFiles(sid);
      if (result.error) errors.push(result.error);
      count += result.count || 0;
      freed += result.freed || 0;
      failed += result.failed ?? (result.success ? 0 : 1);
    }
    return { success: failed === 0 && errors.length === 0, count, freed, failed, skipped, warning: skipped ? `${skipped} 部剧正在合并，已跳过` : undefined, error: (failed || errors.length) ? [...new Set(errors)].join('；') || '部分文件删除失败，对应记录已保留' : undefined };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('stop-download', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  clearSourceRetry(task);
  task.cancelled = true;
  if (task.cancelSource) { try { task.cancelSource.cancel('用户停止下载'); } catch (_) {} }
  if (task.writer) { try { task.writer.destroy(); } catch (_) {} }

  task.status = 'stopped';
  task.error = '';
  task.endTime = Date.now();
  delete task.cancelSource;
  delete task.writer;

  saveDownloadTasks();
  sendToRenderer('download-stopped', { id: taskId, path: task.savePath });
  return { success: true };
});

ipcMain.handle('retry-task', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };
  if (!['failed', 'stopped'].includes(task.status) && !(task.status === 'completed' && !hasCompleteTaskFile(task))) return { success: false, error: '任务仍在进行中或已完成' };

  const snapshot = snapshotQueueTasks([task]);
  clearSourceRetry(task);
  repairTaskDestination(task);

  task.status = 'pending';
  task.progress = 0;
  task.receivedBytes = 0;
  task.totalBytes = 0;
  task.cancelled = false;
  delete task.error;
  delete task.cancelSource;
  delete task.writer;

  if (!downloadQueue.some((t) => t.id === taskId)) downloadQueue.push(task);
  try { saveDownloadTasks(); }
  catch (error) { restoreQueueTasks(snapshot); return { success: false, error: error.message }; }
  processDownloadQueue();
  return { success: true };
});

ipcMain.handle('retry-tasks', async (event, taskIds) => {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return { success: false, error: '没有要重试的任务' };
  let count = 0;
  const changed = [];
  for (const taskId of taskIds) {
    const task = downloadTasks.find((t) => t.id === taskId);
    if (task && (task.status === 'failed' || task.status === 'stopped' || (task.status === 'completed' && !hasCompleteTaskFile(task)))) changed.push(task);
  }
  const snapshot = snapshotQueueTasks(changed);
  for (const task of changed) {
    const taskId = task.id;
    clearSourceRetry(task);
    repairTaskDestination(task);
    task.status = 'pending';
    task.progress = 0;
    task.receivedBytes = 0;
    task.totalBytes = 0;
    task.cancelled = false;
    delete task.error;
    delete task.cancelSource;
    delete task.writer;
    if (!downloadQueue.some((t) => t.id === taskId)) downloadQueue.push(task);
    count++;
  }
  if (count > 0) {
    try { saveDownloadTasks(); }
    catch (error) { restoreQueueTasks(snapshot); return { success: false, error: error.message, count: 0 }; }
    processDownloadQueue();
  }
  return { success: true, count };
});

// ===== IPC：一键启动 / 一键暂停 =====
ipcMain.handle('pause-all', async () => ({ success: true, count: pauseAllTasks() }));

ipcMain.handle('resume-all', async () => {
  try { return { success: true, count: resumeAllTasks() }; }
  catch (error) { return { success: false, count: 0, error: error.message }; }
});

// 队列实时状态（供界面显示「进行中 x/并发上限」）
ipcMain.handle('get-queue-status', async () => ({
  active: activeDownloads,
  queued: downloadQueue.length,
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
}));

ipcMain.handle('open-folder', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  if (task.customDir && fs.existsSync(task.customDir)) {
    await shell.openPath(task.customDir);
    return { success: true };
  }
  if (task.savePath && fs.existsSync(task.savePath)) {
    const isDir = fs.statSync(task.savePath).isDirectory();
    if (isDir) {
      await shell.openPath(task.savePath);
    } else {
      shell.showItemInFolder(task.savePath);
    }
    return { success: true };
  }
  if (task.savePath) {
    const parentDir = path.dirname(task.savePath);
    if (fs.existsSync(parentDir)) {
      await shell.openPath(parentDir);
      return { success: true };
    }
  }
  return { success: false, error: '文件夹不存在' };
});

// ===== 应用内更新：固定官方源，下载和重启均由用户确认 =====
let updateRequest = null;
let latestAppRelease = null;
function appUpdateSupport() {
  let reason = '';
  if (IS_PREVIEW || !app.isPackaged) reason = '开发或预览版本不支持应用内安装，请使用正式安装版。';
  else if (process.platform === 'win32' && (portableConfig.mode === 'portable' || portableConfig.portableDir
    || process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)) reason = '便携版需手动更新。请先退出旧程序，再运行发布页中的 setup 安装包，并从安装后生成的快捷方式启动；安装版支持后续应用内更新。若仍用便携版，请完整解压新版并直接运行新版文件。';
  else if (!['darwin', 'win32'].includes(process.platform)) reason = '当前系统请前往发布页手动更新。';
  else if (process.platform === 'darwin' && (process.execPath.startsWith('/Volumes/') || process.execPath.includes('/AppTranslocation/'))) reason = '请先将应用放入“应用程序”文件夹后重新打开，再使用应用内更新。';
  return { supported: !reason, reason };
}
function appUpdateState() {
  return appUpdateInstaller?.getState() || { ...appUpdateSupport(), status: 'idle', version: null, percent: 0, error: '' };
}
function getAppUpdateInstaller() {
  if (!appUpdateInstaller) {
    appUpdater = require('electron-updater').autoUpdater;
    appUpdater.on('login', (authInfo, callback) => {
      if (matchesProxyAuth(authInfo)) callback(activeProxyAuth.username, activeProxyAuth.password);
      else callback();
    });
    appUpdateInstaller = require('./src/native/app-update-installer').createUpdateInstaller({
      updater: appUpdater,
      currentVersion: APP_VERSION,
      isEnabled: () => !IS_PREVIEW && getCurrentSettings().app_updates_enabled !== false,
      installBlocker: () => {
        if (pendingUpdateOperations) return '正在处理任务或保存设置，请稍后再安装更新。';
        if (downloadRuns.size || downloadQueue.length || sourceRetryTimers.size) return '还有下载或等待重试的任务，请先在下载管理中暂停全部任务，再安装更新。';
        if (mergeTasks.some(task => task.status === 'running') || compatPreparing.size || onlinePreparing.size) return '正在合并或准备视频，请等待完成或取消后再安装更新。';
        if (storageError) return '本地数据保存异常，请先处理保存问题，再安装更新。';
        return '';
      },
      emit: state => sendToRenderer('app-update-state', state),
    });
  }
  return appUpdateInstaller;
}
ipcMain.handle('get-app-update-state', () => appUpdateState());
ipcMain.handle('download-app-update', async () => {
  const support = appUpdateSupport();
  if (!support.supported) return { success: false, error: support.reason };
  if (!latestAppRelease || getCurrentSettings().app_updates_enabled === false) return { success: false, error: '更新信息已失效，请重新检查更新。' };
  try {
    const request = updateDownloadGeneration;
    const installer = getAppUpdateInstaller();
    if (!['checking', 'downloading', 'downloaded', 'installing'].includes(installer.getState().status)) {
      await applyProxyToSession(desiredProxyConfig || resolveProxyConfig(getCurrentSettings()), [appUpdater.netSession]);
    }
    if (request !== updateDownloadGeneration) return { success: false, error: '更新已取消。', state: installer.getState() };
    return await installer.download(latestAppRelease.version);
  }
  catch (_) { return { success: false, error: '无法准备应用内更新，请重试或前往发布页下载安装。' }; }
});
ipcMain.handle('cancel-app-update', () => {
  if (appUpdateInstaller?.getState().status === 'installing') return { success: false, error: '正在安装更新，无法取消。', state: appUpdateState() };
  updateDownloadGeneration++;
  if (!appUpdateInstaller) return { success: true, state: appUpdateState() };
  return appUpdateInstaller.cancel();
});
ipcMain.handle('install-app-update', () => {
  if (!appUpdateInstaller) return { success: false, error: '请先完成更新下载。' };
  return appUpdateInstaller.install();
});
ipcMain.handle('check-app-update', async event => {
  if (proxyStartupFallback) return { enabled: false, release: null, error: '请先修复或明确关闭代理。' };
  if (IS_PREVIEW || !mainWindow || event.sender !== mainWindow.webContents) return { enabled: false, release: null };
  if (getCurrentSettings().app_updates_enabled === false) {
    latestAppRelease = null;
    return { enabled: false, release: null };
  }
  if (!updateRequest) {
    updateRequest = axios.get('https://api.github.com/repos/jackotom/hongguo-drama/releases/latest', {
      timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Hongguo-Drama-Update-Check' },
    }).catch(() => axios.get('https://github.com/jackotom/hongguo-drama/releases/latest', {
      // GitHub's public release endpoint does not consume the anonymous API quota.
      timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024,
      headers: { Accept: 'application/json', 'User-Agent': 'Hongguo-Drama-Update-Check' },
      validateStatus: status => status === 200 || status === 302,
    }).then(response => {
      if (response.status !== 302) return response;
      const tag = /^https:\/\/github\.com\/jackotom\/hongguo-drama\/releases\/tag\/(v?\d+\.\d+(?:\.\d+)?)$/.exec(response.headers.location || '');
      if (!tag) throw new Error('Unexpected update redirect');
      return { data: { tag_name: tag[1] } };
    })).then(response => ({ release: availableRelease(response.data, APP_VERSION), error: '' }))
      .catch(() => ({ release: null, error: '暂时无法检查更新，请检查网络后重试。' }))
      .finally(() => { updateRequest = null; });
  }
  const result = await updateRequest;
  const enabled = getCurrentSettings().app_updates_enabled !== false;
  latestAppRelease = enabled ? result.release : null;
  return { enabled, release: latestAppRelease, error: enabled ? result.error : '' };
});
ipcMain.handle('open-app-update', async event => {
  if (IS_PREVIEW || !mainWindow || event.sender !== mainWindow.webContents || getCurrentSettings().app_updates_enabled === false) {
    return { success: false, error: '更新信息已失效，请稍后重试' };
  }
  try { await shell.openExternal(latestAppRelease?.url || 'https://github.com/jackotom/hongguo-drama/releases/latest'); return { success: true }; }
  catch { return { success: false, error: '无法打开浏览器，请稍后重试' }; }
});

// ===== 应用信息 =====
ipcMain.handle('get-public-details', async (event, seriesId, vid) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { success: false, error: 'Window unavailable' };
  return fetchPublicDetails(seriesId, vid);
});
ipcMain.handle('get-episode-comments', async (event, options) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { success: false, error: 'Window unavailable' };
  return fetchEpisodeComments(options);
});

ipcMain.handle('get-episode-danmaku', async (_event, options) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return fetchDanmaku(null);
  const { seriesId, vid, fresh, limit } = options;
  return fetchDanmaku({ seriesId, vid, fresh, limit });
});

ipcMain.handle('get-app-info', async () => ({
  version: APP_VERSION,
  brand: APP_TITLE,
  appName: APP_TITLE,
  platform: process.platform,
  preview: IS_PREVIEW,
  dataDir: app.getPath('userData'),
  configMode: portableConfig.mode,
  configNote: portableConfig.reason || '',
}));

// 打开外部链接（保留给需要时调用）
ipcMain.handle('open-external-url', async (event, url) => {
  if (!url) return { success: false, error: '缺少链接' };
  try {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      return { success: false, error: '仅支持打开网页链接' };
    }
    await shell.openExternal(target.href);
    return { success: true };
  } catch (err) {
    console.error('[Shell] 打开链接失败:', err.message);
    return { success: false, error: err.message };
  }
});

let windowLayout = 'landscape';
let landscapeBounds = null;
let layoutChanging = false;
const stealth = createStealthController({ screen, getWindow: () => mainWindow });
function syncMainWindowScale() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const scale = getWindowScale(getCurrentSettings().ui_zoom);
  mainWindow.webContents.setZoomFactor(scale);
}
function changeMainWindowZoom(direction) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    saveWindowZoom(store, direction);
    syncMainWindowScale();
  } catch (_) {
    sendToRenderer('storage-error', { error: '界面大小保存失败，请检查磁盘空间或目录权限后重试。' });
  }
}
ipcMain.handle('set-stealth-mode', async (event, enabled) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof enabled !== 'boolean') return { success: false, error: '无法切换小窗' };
  if (enabled && (mainWindow.isFullScreen() || layoutChanging)) return { success: false, error: '请先退出全屏，再开启隐身小窗' };
  try {
    episodePanel.close();
    stealth.setEnabled(enabled);
    syncMainWindowScale();
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});
const episodePanel = createEpisodePanelController({ ipcMain, screen, getMainWindow: () => mainWindow, getLayout: () => windowLayout });
ipcMain.handle('get-window-layout', () => windowLayout);
ipcMain.handle('set-window-layout', async (event, mode) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !['portrait', 'landscape'].includes(mode)) {
    return { success: false, error: '无法切换窗口布局' };
  }
  if (stealth.enabled) return { success: false, error: '请先退出隐身小窗' };
  if (layoutChanging) return { success: false, error: '窗口正在切换，请稍后重试' };
  if (mode === windowLayout) return { success: true, mode };
  layoutChanging = true;
  try {
    const win = mainWindow;
    if (mode === 'portrait') landscapeBounds = win.getNormalBounds();
    if (win.isFullScreen()) {
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { win.removeListener('leave-full-screen', done); reject(new Error('请先退出全屏后再切换')); }, 3000);
        win.once('leave-full-screen', done);
        win.setFullScreen(false);
      });
    }
    if (win.isMaximized()) win.unmaximize();
    if (mode === 'landscape') episodePanel.close();
    const current = win.getBounds();
    const area = screen.getDisplayMatching(current).workArea;
    const bounds = fitWindowBounds(mode, current, area, landscapeBounds);
    win.setMinimumSize(Math.min(mode === 'portrait' ? 420 : 900, bounds.width), Math.min(560, bounds.height));
    win.setBounds(bounds);
    windowLayout = mode;
    syncMainWindowScale();
    return { success: true, mode };
  } catch (error) {
    return { success: false, error: error.message };
  } finally { layoutChanging = false; }
});

// ===== 窗口创建 =====
function createWindow() {
  windowLayout = 'landscape';
  landscapeBounds = null;
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 620,
    title: APP_TITLE,
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 20, y: 18 },
    } : {}),
    autoHideMenuBar: true,
    backgroundColor: '#f5f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      zoomMode: 'isolated',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('resize', syncMainWindowScale);
  mainWindow.on('enter-full-screen', syncMainWindowScale);
  mainWindow.on('leave-full-screen', syncMainWindowScale);
  mainWindow.webContents.on('did-finish-load', syncMainWindowScale);
  mainWindow.webContents.on('zoom-changed', (_event, direction) => changeMainWindowZoom(direction));
  syncMainWindowScale();
  rendererSecurity.protectWindow(mainWindow);
  episodePanel.attach(mainWindow);
  mainWindow.webContents.once('did-finish-load', () => {
    if (storageError) sendToRenderer('storage-error', storageError);
  });

  // 开发模式加载 vite dev server，生产模式加载打包产物
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  }

  mainWindow.on('close', event => {
    if (process.platform !== 'darwin' && !quitReady) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.on('closed', () => {
    stealth.dispose();
    mediaAccess.clear();
    clearOnlineCache();
    for (const job of compatPreparing.values()) { job.cancelled = true; job.controller.abort(); }
    mainWindow = null;
  });
}

// ===== 应用生命周期 =====
// Remote pages get no permissions; the trusted player keeps fullscreen and clipboard controls.
app.on('web-contents-created', (_event, contents) => {
  const allowed = (webContents, permission, details) => ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)
    && details?.isMainFrame === true && rendererSecurity.isTrustedUrl(details.requestingUrl)
    && rendererSecurity.isTrustedSender({ sender: webContents, senderFrame: webContents?.mainFrame }, mainWindow);
  contents.session.setPermissionRequestHandler((webContents, permission, callback, details) => callback(allowed(webContents, permission, details)));
  contents.session.setPermissionCheckHandler((webContents, permission, _origin, details) => allowed(webContents, permission, details));
});

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  let startupStage = '读取本地数据';
  try {
    const dataFile = path.join(app.getPath('userData'), 'data.json');
    store.init(dataFile);
    setDeviceIdentityFile(path.join(app.getPath('userData'), 'danmaku-client.json'));
    loadDownloadTasks();
    loadSeriesRegistry();
    try { rebuildSeriesRegistryFromTasks(); } catch (_) { /* storage-error reports the failed write when the window opens. */ }
    // 外置盘或网络盘可能阻塞同步扫描；分集访问按需查找，下载管理保留手动补登记。
    loadMergeTasks();
    getCompatDir();
    registerStreamProtocol();
    registerLocalProtocol();
    const settings = getCurrentSettings();

    // 代理必须在创建窗口、发起任何请求之前生效
    startupStage = '初始化网络';
    const proxyStartup = await applyProxyForStartup(settings);
    proxyStartupFallback = proxyStartup.fallback;
    if (proxyStartup.fallback) console.warn('[Proxy] 启动代理不可用，已临时直连:', proxyStartup.reason);
    else {
      // 启动后自动接着跑「等待中」的任务（上次未下完的队列），无需手动点启动
      // Automatic source retries scheduled before the app closed continue on the same schedule.
      for (const task of downloadTasks) if (task.status === 'failed' && task.retryAt) armSourceRetry(task);
      const resumed = enqueuePendingTasks();
      if (resumed > 0) {
        console.log(`[Queue] 启动自动续跑 ${resumed} 个等待中任务，并发 ${MAX_CONCURRENT_DOWNLOADS}`);
        pumpQueue();
      }
    }

    app.on('activate', () => {
      stealth.setEnabled(false);
      syncMainWindowScale();
      // 搜索窗口可能仍在后台，不能用所有窗口数量判断主窗口是否存在。
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });

    if (process.platform === 'darwin') {
      app.setAboutPanelOptions?.({ applicationVersion: APP_VERSION.replace(/^(\d+\.\d+)\.0$/, '$1'), version: '' });
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: APP_TITLE, submenu: [
          { role: 'about', label: `关于${APP_TITLE}` },
          { type: 'separator' },
          { role: 'services', label: '服务' },
          { type: 'separator' },
          { role: 'hide', label: '隐藏' },
          { role: 'hideOthers', label: '隐藏其他应用' },
          { role: 'unhide', label: '显示全部' },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ] },
        { label: '编辑', submenu: [
          { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
        ] },
        { label: '视图', submenu: [
          { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => changeMainWindowZoom('reset') },
          { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => changeMainWindowZoom('in') },
          { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => changeMainWindowZoom('out') },
          { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' },
        ] },
        { label: '窗口', submenu: [
          { role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' },
          { type: 'separator' },
          { label: '回到主窗口', accelerator: 'CmdOrCtrl+1', click: () => app.emit('activate') },
          { label: '退出隐身小窗', click: () => { stealth.setEnabled(false); syncMainWindowScale(); } },
        ] },
      ]));
    }
    // Warm the official-host trusted DNS cache before the first catalog card request.
    // This is best-effort and must never block startup or a user action.
    if (!proxyStartupFallback && resolveProxyConfig(getCurrentSettings()).mode === 'direct') {
      try { require('./src/native/web-media-guard').warmOfficialDns?.(); } catch (_) {}
    }
    startupStage = '创建主窗口';
    createWindow();
    if (proxyStartup.fallback) {
      // 只停自动任务；窗口仍打开，用户可在设置中修复代理或明确关闭代理。
      setTimeout(() => {
        try {
          dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: `${APP_TITLE} 网络代理`,
            message: '上次保存的代理配置无法生效，已临时使用直连启动。',
            detail: `自动续下载、追剧刷新和浏览页自动请求已暂停，避免绕过你设置的代理。${proxyStartup.fallbackError ? `\n临时直连也失败：${proxyStartup.fallbackError}` : ''}\n请在设置中修复代理，或明确关闭代理后保存。`,
            buttons: ['知道了'],
            noLink: true,
          }).catch(() => {});
        } catch (_) { /* 无窗口环境忽略 */ }
      }, 500);
    } else {
      setTimeout(() => { void refreshWatchHistory(); }, 10000).unref();
      setInterval(() => { void refreshWatchHistory(); }, 15 * 60 * 1000).unref();
    }
  } catch (_) {
    console.error(`[Startup] ${startupStage}失败`);
    try {
      dialog.showErrorBox(`${APP_TITLE}启动失败`, `未能完成${startupStage}。请退出后重试；若仍失败，请将此提示反馈给开发者。已有资料不会被清空。`);
    } finally { app.quit(); }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', event => {
  if (quitCleanup) { event.preventDefault(); return; }
  const jobs = [...compatPreparing.values()];
  const onlineJobs = [...onlineWork, ...onlinePreparing.values()];
  const pending = [...jobs.map(job => job.promise), ...onlineJobs.map(job => job.promise), ...mergeRuns.values(), ...downloadRuns.values()];
  if (compatClearing) pending.push(compatClearing);
  if (mergeTempCleanup) pending.push(mergeTempCleanup);
  const downloading = downloadRuns.size || downloadQueue.length || sourceRetryTimers.size;
  if (!pending.length && !downloading) { quitReady = true; return; }
  event.preventDefault();
  if (downloading) {
    try { pauseAllTasks(); }
    catch (_) {
      dialog.showErrorBox('退出未完成', '无法保存下载暂停状态，已取消本次退出。请检查本地存储后重试。');
      return;
    }
  }
  for (const job of jobs) cancelCompatJob(job);
  for (const job of onlineJobs) { try { job.controller.abort(); } catch (_) {} }
  for (const task of mergeTasks) {
    if (task.status !== 'running') continue;
    task.cancelled = true;
    require('./src/native/merge-runner').stopMergeChildren(task);
  }
  let timer;
  // A stalled child or predecessor must cancel this quit, never skip cleanup or quit later.
  quitCleanup = Promise.race([
    Promise.allSettled(pending).then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); }),
  ]).then(completed => {
    clearTimeout(timer);
    quitCleanup = null;
    if (completed) app.quit();
    else dialog.showErrorBox('退出未完成', '任务清理超过 10 秒，已取消本次退出。应用未强制关闭，原始分集保留；任务仍在收尾，请稍后再次退出。');
  });
});
