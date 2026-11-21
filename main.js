// Hongguo Drama 7.9: desktop runtime; server entry is server/index.cjs.
/**
 * main.js - 红果短剧 6.2 下载器（独立版）主进程
 *
 * 功能：
 *   1. 红果短剧解析（分享链接 / series_id -> 全剧集列表）
 *   2. 批量提交下载任务到下载队列
 *   3. 并发下载：流式下载播放直链 -> spade_a 派生 AES Key -> CENC-AES-CTR 解密 -> 输出 mp4
 *   4. 下载管理：进度推送、暂停/取消、重试、删除、打开所在文件夹
 *   5. 设置：下载目录、命名规则、并发数（JSON 文件持久化）
 */
const { app, BrowserWindow, BaseWindow, View, WebContentsView, globalShortcut, ipcMain: rawIpcMain, dialog, shell, session, protocol, Menu, Notification, screen, safeStorage } = require('electron');
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
const { boundedSignal, throwIfAborted } = require('./src/native/request-signal');
const { normalizeDownloadQuality, meetsDownloadQuality } = require('./src/native/download-quality');
const { decryptInWorker } = require('./src/native/decrypt-worker.cjs');
const { convertBytevc2 } = require('./src/native/bytevc2');
const hardwareEncoding = require('./src/native/hardware-encoder');
const { createDownloadTemporary, downloadTemporaryOwner, inspectDownloadTemporary, cleanupDownloadTemporary } = require('./src/native/download-temporary');
const { readFileIdentity, readFileIdentityAsync, sameFileObject } = require('./src/native/file-identity');
const { localMediaEnv } = require('./src/native/child-env');
const { safeErrorText, sanitizeLogValue, sanitizeIpcValue } = require('./src/native/error-text');
const { createIpcBoundary } = require('./src/native/ipc-boundary');
const { downloadTaskView, pathConflicts } = require('./src/native/download-task-view');
const { createProxyConfig } = require('./src/native/proxy-config');
const { createProxyManager } = require('./src/native/proxy-manager');
const { createHistoryService } = require('./src/native/history-service');
const { createAccountController } = require('./src/native/account-controller');
const { episodeDisplayTitle } = require('./src/native/xifan');
const store = require('./src/store');
const watchHistory = require('./src/native/watch-history');
const { createAccountService, safeMessage: accountSafeMessage } = require('./src/native/account-session');
const seriesSearch = require('./src/native/series-search');
const { searchHongguo } = require('./src/native/hongguo-search');
const { fitWindowBounds, getWindowScale, saveWindowZoom, restoreMainWindowBounds, rememberMainWindowBounds } = require('./src/native/window-layout');
const { createEpisodePanelController } = require('./src/native/episode-panel');
const { availableRelease } = require('./src/native/app-update');
const { createAnnouncementService } = require('./src/native/app-announcements');
const { fetchPublicDetails } = require('./src/native/public-details');
const { fetchEpisodeComments } = require('./src/native/episode-comments');
const { fetchDanmaku, setDeviceIdentityFile } = require('./src/native/danmaku');
const { exportSeriesText } = require('./src/native/text-export');
const { prepareNasExport, inspectNasEpisode, copyNasEpisode, nasEpisodeFilename, checkNasDirectory, nasDirectoryIdentityCurrent } = require('./src/native/nas-export');
const mediaAccess = require('./src/native/media-access').createMediaAccess(process.env.VITE_DEV_SERVER_URL);
const rendererSecurity = require('./src/native/renderer-security').createRendererSecurity(
  path.join(__dirname, 'dist-react', 'index.html'), process.env.VITE_DEV_SERVER_URL);
const attachFloatingPlayerWindow = require('./src/native/floating-player-window');
const APP_VERSION = app.getVersion() || '1.0.0';

for (const level of ['log', 'warn', 'error']) {
  if (typeof console[level] !== 'function') continue;
  const write = console[level].bind(console);
  console[level] = (...args) => write(...args.map(sanitizeLogValue));
}

const APP_TITLE = IS_PREVIEW ? '红果短剧预览' : '红果短剧';
const { createStealthController } = require('./src/native/stealth-window');
const { DEFAULT_STEALTH_WAKE_REGION, validateStealthWakeRegion, normalizeStealthWakeRegion } = require('./src/native/stealth-region');
const { createBossKeyController } = require('./src/native/boss-key');

const casting = require('./src/native/casting').createCastingService();
const castFileRefs = new Map();
const localFileReaders = new Map();
let castBusy = false;
let mainWindow = null;
let appUpdateInstaller = null;
let appUpdater = null;
let updateDownloadGeneration = 0;
let pendingUpdateOperations = 0;
let quitCleanup = null;
let quitReady = false;
let mergeTempCleanup = null;
const UPDATE_BLOCKED_CHANNELS = new Set(['hongguo-download-batch', 'download-single-episode', 'download-following-episodes', 'download-series-to-nas', 'retry-task', 'retry-tasks', 'resume-all', 'merge-series', 'transcode-for-playback', 'prepare-online-play', 'start-casting', 'save-settings', 'set-boss-key']);
const ipcMain = {
  ...createIpcBoundary({
    rawIpcMain,
    isTrustedSender: (event, win) => rendererSecurity.isTrustedSender(event, win),
    getMainWindow: () => mainWindow,
    getQuitCleanup: () => quitCleanup,
    getInstaller: () => appUpdateInstaller,
    blockedChannels: UPDATE_BLOCKED_CHANNELS,
    onPendingChange: change => { pendingUpdateOperations += change; },
  }),
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
    useProxy:!String(playInfo.vid).startsWith('custom:'), ...options, checkAccess:() => checkCustomAccess(playInfo.vid) }); }
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
    ui_zoom: 1,
    download_quality: 'auto',
    download_metadata: false,
    custom_sources: [],
    // 看完一集后自动删除本地文件（边看边清，避免占用磁盘）
    auto_delete_watched: false,
    // 兼容模式：本机无法解码 HEVC 时自动转码为 H.264（解决「黑屏有声」）
    compat_mode: true,
    fast_conversion: false,
    cache_next_episode: true,
    picture_in_picture_mode: 'custom',
    stealth_wake_region: { ...DEFAULT_STEALTH_WAKE_REGION },
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

// 启动时记下系统/终端原来的代理；代理模块负责保留这份快照。
const proxyConfig = createProxyConfig({ env: process.env });
const PROXY_TEST_URL = proxyConfig.testUrl;
const normalizeProxySettings = proxyConfig.normalizeSettings;
const publicProxyUrl = proxyConfig.publicUrl;
const publicProxyError = proxyConfig.publicError;
const validateProxyDraft = proxyConfig.validateDraft;
let accountController = null;
const proxyManager = createProxyManager({
  config: proxyConfig,
  getSessions: () => [session.defaultSession, appUpdater?.netSession, accountController?.peekWebSession()],
  log: message => console.log(message),
  schedule: (...args) => setTimeout(...args),
  cancel: timer => clearTimeout(timer),
});
const sessionProxyConfigs = proxyManager.sessionProxyConfigs;

function snapshotProxyUrl(targetUrl) {
  return proxyConfig.snapshotUrl(targetUrl);
}

function resolveProxyConfig(settings) {
  return proxyConfig.resolve(settings);
}

function applyProxyToSession(resolved, sessions, version) {
  return proxyManager.applyToSession(resolved, sessions, version);
}

function matchesProxyAuth(authInfo) {
  return proxyManager.matches(authInfo);
}

app.on('login', (event, _webContents, _details, authInfo, callback) => {
  if (!matchesProxyAuth(authInfo)) return;
  event.preventDefault();
  callback(proxyManager.activeAuth.username, proxyManager.activeAuth.password);
});

/** 统一入口：设置变化或启动时调用 */
function applyProxySettings(settings) {
  return proxyManager.apply(settings);
}

function applyProxyWithTimeout(settings, timeoutMs) {
  return proxyManager.withTimeout(settings, timeoutMs);
}

/** 启动时先尝试已保存代理；坏配置临时直连，保证窗口能打开让用户修复。 */
function applyProxyForStartup(settings) {
  return proxyManager.startup(settings);
}

function getCurrentSettings() {
  const saved = store.getSettings() || {};
  const merged = { ...getDefaultSettings(), ...saved };
  merged.stealth_wake_region = normalizeStealthWakeRegion(merged.stealth_wake_region);
  merged.fast_conversion = merged.fast_conversion === true;
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
  let migrated = false;
  for (const task of downloadTasks) {
    if (task.status !== 'completed' || !task.savePath) continue;
    try {
      if (!task.fileIdentity) {
        if (!legacyFileMatches(task, task.savePath)) continue;
        task.fileIdentity = readFileIdentity(task.savePath);
        migrated = true;
      } else if (!task.fileIdentity.contentHash) {
        const current = readFileIdentity(task.savePath);
        if (!sameFileObject(task.fileIdentity, current)) continue;
        task.fileIdentity = { ...task.fileIdentity, contentHash: current.contentHash };
        migrated = true;
      }
    } catch (_) {}
  }
  if (migrated) {
    try { saveDownloadTasks(); } catch (_) { /* The next user-approved save will retry the migration. */ }
  }
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
  invalidateSeriesProgress();
  const serializable = downloadTasks.map((task) => {
    const { cancelSource, writer, ...rest } = task;
    if (rest.error) rest.error = safeErrorText(rest.error);
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
const SERIES_PROGRESS_TTL_MS = 3 * 60 * 1000;
const SERIES_SCAN_REACHABILITY_MS = 4000;
const seriesProgressCache = new Map();
const seriesEpisodeJobs = new Map();
let seriesProgressRevision = 0;

function invalidateSeriesProgress() {
  seriesProgressRevision++;
  seriesProgressCache.clear();
}

function loadSeriesRegistry() {
  seriesRegistry = store.getSeries() || [];
}

function saveSeriesRegistry() {
  invalidateSeriesProgress();
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
  return seriesRegistry.find(item => String(item.series_id) === sid);
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
let hongguoDownloadReadyAt = 0;
let downloadQueueTimer = null;
function pumpQueue() {
  clearTimeout(downloadQueueTimer);
  downloadQueueTimer = null;
  if (quitCleanup) return;
  downloadQueue = downloadQueue.filter(task => task.status === 'pending');
  // Recovered/retried episodes reuse their series' queue slots without overtaking another series.
  const episodeSlots = new Map();
  downloadQueue.forEach((task, index) => {
    const seriesId = String(task.hongguoInfo?.series_id ?? '');
    const episode = Number(task.hongguoInfo?.vid_index);
    if (!seriesId || !Number.isSafeInteger(episode) || episode < 1) return;
    const slots = episodeSlots.get(seriesId) || [];
    slots.push(index);
    episodeSlots.set(seriesId, slots);
  });
  for (const slots of episodeSlots.values()) {
    const episodes = slots.map(index => downloadQueue[index])
      .sort((a, b) => Number(a.hongguoInfo.vid_index) - Number(b.hongguoInfo.vid_index));
    slots.forEach((index, order) => { downloadQueue[index] = episodes[order]; });
  }
  for (const task of downloadQueue) repairTaskDestination(task);
  const cooldown = hongguoDownloadReadyAt - Date.now();
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    const index = downloadQueue.findIndex(task => !runningDownloads.has(task.id) && !runningDownloadPaths.has(task.savePath)
      && (cooldown <= 0 || !/^\d{1,30}$/.test(String(task.hongguoInfo?.vid || ''))));
    if (index < 0) break;
    const [task] = downloadQueue.splice(index, 1);
    runningDownloads.add(task.id);
    runningDownloadPaths.add(task.savePath);
    activeDownloads++;
    downloadRuns.set(task.id, runTask(task));
  }
  if (activeDownloads < MAX_CONCURRENT_DOWNLOADS && cooldown > 0
    && downloadQueue.some(task => /^\d{1,30}$/.test(String(task.hongguoInfo?.vid || '')))) {
    downloadQueueTimer = setTimeout(pumpQueue, cooldown);
    downloadQueueTimer.unref?.();
  }
}

async function runTask(task) {
  const destination = task.savePath;
  try {
    await executeDownload(task);
  } catch (error) {
    console.error('[Download Queue] 下载失败:', error);
  } finally {
    if (/^\d{1,30}$/.test(String(task.hongguoInfo?.vid || ''))) {
      hongguoDownloadReadyAt = Math.max(hongguoDownloadReadyAt, Date.now() + 1000);
    }
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
const REJECTION_RETRY_DELAYS = [15, 30, 60, 120, 300, 600].map(seconds => seconds * 1000);
const sourceRetryTimers = new Map();
let sourceRejectionStreak = 0;

function isTransientRegistrationFailure(error) {
  const app = error?.code === 'DEVICE_REGISTRATION_FAILED' ? error
    : error?.code === 'SOURCE_UNAVAILABLE' && Array.isArray(error.sources)
      ? error.sources.find(item => item.source === 'app') : null;
  return /^(?:TIMEOUT|NETWORK_ERROR|HTTP_(?:408|5\d\d))$/.test(app?.registrationFailure || '');
}

function isDownloadSourceRejection(error) {
  if (error?.code === 'DEVICE_REGISTRATION_FAILED') return !isTransientRegistrationFailure(error);
  return error?.code === 'SOURCE_UNAVAILABLE' && Array.isArray(error.sources)
    && error.sources.some(item => item.source === 'app'
      && /^(?:DEVICE_REGISTRATION_FAILED|HTTP_(?:403|429))$/.test(item.code));
}

function holdHongguoLookups(delay) {
  hongguoDownloadReadyAt = Math.max(hongguoDownloadReadyAt, Date.now() + delay);
}

function clearHongguoSourceBackoff() {
  sourceRejectionStreak = 0;
  hongguoDownloadReadyAt = 0;
}

function sourceFailureIsTransient(error) {
  const sources = Array.isArray(error?.sources) ? error.sources : [];
  // A timeout on another route cannot repair an explicit App/device rejection.
  if (sources.some(item => item.source === 'app' && /^(?:DEVICE_REGISTRATION_FAILED|HTTP_(?:403|429)|BUSINESS_REJECTED|SECURITY_BLOCKED)$/.test(item.code))) return false;
  return sources.some(item =>
    (item.source === 'web' && /^HTTP_(?:404|410)$/.test(item.code))
    || /^(?:TIMEOUT|NETWORK_ERROR|HTTP_(?:408|5\d\d))$/.test(item.code));
}

function sourceFailureHasEmpty(error) {
  return Array.isArray(error?.sources) && error.sources.some(item => item.code === 'EMPTY_RESPONSE');
}

function isDeferrableSourceError(task, error) {
  if (!/^\d{1,30}$/.test(String(task.hongguoInfo?.vid || ''))) return false;
  if (isTransientRegistrationFailure(error)) return true;
  if (error?.code === 'EMPTY_RESPONSE') return true;
  if (error?.code === 'SOURCE_UNAVAILABLE') {
    const sources = Array.isArray(error.sources) ? error.sources : [];
    return !sources.some(item => item.code === 'SECURITY_BLOCKED')
      && (sourceFailureIsTransient(error) || sourceFailureHasEmpty(error));
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
  delete task.retryAt; delete task.sourceRetries; delete task.sourceRetryLimit;
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
  const tasks = downloadTasks.filter(task => ['pending', 'downloading'].includes(task.status) || task.status === 'failed' && task.retryAt);
  const snapshot = snapshotQueueTasks(tasks);
  for (const task of tasks) {
    task.status = 'stopped'; task.error = '已手动暂停'; task.endTime = Date.now(); task.cancelled = true;
    delete task.retryAt; delete task.sourceRetries; delete task.sourceRetryLimit;
  }
  downloadQueue = [];
  try { saveDownloadTasks(); }
  catch (error) { restoreQueueTasks(snapshot); throw error; }
  clearTimeout(downloadQueueTimer);
  downloadQueueTimer = null;
  for (const task of tasks) {
    clearSourceRetry(task);
    try { task.cancelSource?.cancel('用户一键暂停'); } catch (_) {}
    try { task.writer?.destroy(); } catch (_) {}
    delete task.cancelSource; delete task.writer;
  }
  sendToRenderer('download-queue-changed', {});
  return tasks.length;
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
function verifyDownloadDecode(file, cancelToken = null) {
  const ffmpeg = resolveFfmpeg('ffmpeg');
  if (!ffmpeg) return Promise.reject(Object.assign(new Error('视频解码校验工具不可用，请修复安装后重试'), { code: 'LOCAL_MEDIA_TOOL_ERROR' }));
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    let settled = false, child;
    const abort = () => {
      if (settled) return;
      try { child?.kill(); } catch (_) {}
      finish(reject, Object.assign(new Error('已取消视频解码校验'), { code: 'ERR_CANCELED' }));
    };
    const cleanup = () => cancelToken?.unsubscribe?.(abort);
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle(value);
    };
    if (cancelToken?.reason) {
      finish(reject, Object.assign(new Error('已取消视频解码校验'), { code: 'ERR_CANCELED' }));
      return;
    }
    cancelToken?.subscribe?.(abort);
    child = execFile(ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-i', file, '-t', '3', '-f', 'null', '-'],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: localMediaEnv() }, (error, stdout, stderr) => {
        if (error) {
          const code = String(error.code || '');
          if (error.killed || error.signal || code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
            return finish(reject, Object.assign(new Error('视频解码校验工具超时或无法运行'), { code: 'LOCAL_MEDIA_TOOL_ERROR', cause: error }));
          }
          if (['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(code)) {
            return finish(reject, Object.assign(new Error('视频解码校验工具不可用，请修复安装后重试'), { code: 'LOCAL_MEDIA_TOOL_ERROR', cause: error }));
          }
          return finish(reject, Object.assign(new Error('视频解码校验失败，文件可能损坏，请重新下载'), { code: 'MEDIA_DECODE_ERROR', cause: error }));
        }
        if (String(stderr || '').trim()) {
          return finish(reject, Object.assign(new Error('视频解码校验失败，文件可能损坏，请重新下载'), { code: 'MEDIA_DECODE_ERROR' }));
        }
        finish(resolve);
      });
  });
}

async function verifyDownloadQuality(file, quality, existing = false, verifyDecode = false, cancelToken = null, expectedDuration = 0) {
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
  const declared = Number(expectedDuration);
  if (declared > 0 && info.duration < declared - Math.max(1, declared * 0.01)) {
    throw new Error(`${prefix}仅 ${info.duration.toFixed(1)} 秒，短于片源声明的 ${declared.toFixed(1)} 秒，未完成下载`);
  }
  if (verifyDecode) await verifyDownloadDecode(file, cancelToken);
  return `${Math.min(info.w, info.h)}p`;
}

function publishDownloadFile(temporary, destination) {
  // A hard link would change the final file's ctime when deferred temporary cleanup runs.
  fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
}

async function completeNasExports(task) {
  if (!task.nasDestination && !task.nasTargets?.length) return [];
  const warnings = [];
  for (const destination of task.nasDestination ? [task.nasDestination] : task.nasTargets || []) {
    try {
      await copyNasEpisode(task, destination);
      sendToRenderer('nas-export-done', { seriesId: task.hongguoInfo.series_id, vidIndex: task.hongguoInfo.vid_index, success: true });
    } catch (_) {
      const error = 'NAS 整理失败，请确认共享目录在线后再次点击「下载到 NAS」重试；本地视频已保留';
      warnings.push(error);
      sendToRenderer('nas-export-done', { seriesId: task.hongguoInfo.series_id, vidIndex: task.hongguoInfo.vid_index, success: false, error });
    }
  }
  task.nasWarning = warnings.join('；');
  return warnings;
}

async function executeHongguoDownload(task) {
  const { id, hongguoInfo, filename } = task;
  const { vid, series_title } = hongguoInfo || {};
  const source = axios.CancelToken.source();
  task.cancelSource = source;
  let tmpPath, writer, temporary, finalPath;
  const numeric = /^\d{1,30}$/.test(String(vid));
  try {
    delete task.published;
    task.status = 'downloading'; task.cancelled = false; task.progress = 0; delete task.retryAt;
    delete task.qualityNotice; delete task.actualQuality;
    sendToRenderer('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0, qualityNotice: '', actualQuality: null });
    const settings = getCurrentSettings();
    // Old and retried tasks retain their original policy, independent of new defaults.
    const quality = normalizeDownloadQuality(task.downloadQuality);
    const allowLowerQuality = quality !== 'auto' && numeric;
    const notifyQuality = pixels => {
      const lower = allowLowerQuality && pixels > 0 && pixels < Number.parseInt(quality, 10);
      const notice = lower ? `正在下载更低质量片源：${pixels}P（原选 ${quality.toUpperCase()}）` : '';
      if (task.qualityNotice === notice) return;
      task.qualityNotice = notice;
      sendToRenderer('download-progress', { id, qualityNotice: notice });
    };
    const verifyReceived = async (file, expectedDuration = 0) => {
      const actual = await verifyDownloadQuality(file, allowLowerQuality ? 'auto' : quality, false, true, source.token, expectedDuration);
      notifyQuality(Number.parseInt(actual, 10));
      return actual;
    };
    const root = String(settings.root || '').trim() || app.getPath('downloads');
    const downloadDir = task.customDir || seriesDownloadDir(root, hongguoInfo?.series_id, series_title);
    finalPath = task.savePath || path.join(downloadDir, filename);
    task.savePath = finalPath;
    task.customDir ||= downloadDir;
    if (task.nasDestination) {
      if (task.pathConflict) throw new Error('NAS 文件路径与其他分集冲突，请检查所选文件夹后重试');
      await checkNasDirectory(task.nasDestination);
    }
    else {
      if (task.directoryIdentity) validateDirectoryIdentity(task.directoryIdentity, task.savePath || path.join(downloadDir, filename));
      fs.mkdirSync(downloadDir, { recursive: true });
      if (!task.directoryIdentity) {
        task.directoryIdentity = readDirectoryIdentity(downloadDir);
        if (downloadTasks.includes(task)) saveDownloadTasks();
      }
    }
    // Recheck source access before reusing an existing third-party file or URL.
    const checkedPlayInfo = /^(xifan|hema|reelshort|dramabox|custom):/.test(String(vid))
      ? await hongguo.fetchPlayUrlSingle(vid, hongguoInfo?.series_id, { quality }) : null;
    if (checkedPlayInfo && !checkedPlayInfo.url) throw new Error(checkedPlayInfo.error || '来源未开放该集');
    // Existing complete files need no additional media transfer.
    source.token.throwIfRequested();
    if (fs.existsSync(finalPath)) {
      if (!hasCompleteTaskFile(task)) throw new Error('已有本地文件不完整或路径冲突，文件已保留，请先自行检查或移除');
      task.actualQuality = await verifyDownloadQuality(finalPath, quality, true);
      source.token.throwIfRequested();
      await completeNasExports(task);
      source.token.throwIfRequested();
      task.fileIdentity = readFileIdentity(finalPath);
      task.status = 'completed'; task.progress = 100; task.endTime = Date.now();
      delete task.sourceRetries; delete task.sourceRetryLimit;
      saveDownloadTasks(); sendToRenderer('download-completed', { id, path: finalPath });
      return;
    }
    temporary = await createDownloadTemporary(downloadDir, { owner:downloadTemporaryOwner(task), onChange:record => {
      if (!downloadTasks.includes(task) || task.temporaryDownloads != null && !Array.isArray(task.temporaryDownloads)) throw new Error('任务记录已变化，已保留文件和记录，请重试');
      task.temporaryDownloads ||= [];
      if (!task.temporaryDownloads.includes(record)) task.temporaryDownloads.push(record);
      saveDownloadTasks();
    } });
    tmpPath = temporary.input;
    const sourceId = /^custom:[^:]+/.exec(String(vid))?.[0] || /^(xifan|hema|reelshort|dramabox):/.exec(String(vid))?.[1] || 'hongguo';
    const completeCache = cached => cached?.complete && cached.vid === String(vid) && cached.source === sourceId
      && cached.seriesId === String(hongguoInfo?.series_id || '') && cached.size > 0
      && (cached.filePath || Buffer.isBuffer(cached.buffer) && cached.buffer.length === cached.size);
    let preparedCache;
    const rejectedCaches = new Set();
    // Cache keys describe the request, not measured output quality; verify the actual file before publishing.
    const reuseCache = async () => {
      const caches = new Set([onlineCache.get(onlineCacheKey(vid, quality)), onlineCache.get(String(vid)), preparedCache,
        onlineCache.get(onlineCacheKey(vid, '1080p')), onlineCache.get(onlineCacheKey(vid, '720p')), ...onlineCache.values()]);
      for (const cached of caches) {
        if (!completeCache(cached) || rejectedCaches.has(cached)) continue;
        if (cached.filePath) {
          cached.disk.readers = (cached.disk.readers || 0) + 1;
          // macOS copyFile copies birthtime too, invalidating our reserved file's ownership receipt.
          try {
            await temporary.checkInput();
            writer = fs.createWriteStream(tmpPath); task.writer = writer;
            await pipeline(fs.createReadStream(cached.filePath), writer);
          }
          finally { cached.disk.readers--; disposeOnlineDisk(cached); }
        } else await fsp.writeFile(tmpPath, cached.buffer, { mode: 0o600 });
        source.token.throwIfRequested();
        try { task.actualQuality = await verifyDownloadQuality(tmpPath, quality, false, true, source.token); }
        catch (_) {
          source.token.throwIfRequested();
          rejectedCaches.add(cached);
          continue;
        }
        await temporary.checkInput();
        source.token.throwIfRequested();
        checkCustomAccess(vid);
        publishDownloadFile(tmpPath, finalPath);
        task.receivedBytes = task.totalBytes = cached.size;
        cached.lastUsed = Date.now();
        return true;
      }
      return false;
    };
    let reusedCache = await reuseCache();
    if (!reusedCache && numeric) {
      const qualities = new Set([quality, 'auto', '1080p', ...(quality === '1080p' ? [] : ['720p'])]);
      const pending = [...qualities].map(value => onlinePreparing.get(onlineCacheKey(vid, value))).find(job => job
        && !job.controller.signal.aborted && [...onlineSessions.values()].some(session => session.job === job
          && session.vid === String(vid) && session.seriesId === String(hongguoInfo?.series_id || '')));
      if (pending) {
        const controller = new AbortController(), cancel = () => controller.abort();
        source.token.subscribe(cancel);
        task.qualityNotice = '等待同集在线播放缓存准备完成，避免重复下载和转换';
        sendToRenderer('download-progress', { id, qualityNotice: task.qualityNotice });
        try { preparedCache = await awaitMediaOperation(pending.promise, controller.signal); }
        catch (error) {
          source.token.throwIfRequested();
          if (isDownloadSourceRejection(error)) throw error;
        } finally {
          source.token.unsubscribe(cancel);
          task.qualityNotice = '';
          sendToRenderer('download-progress', { id, qualityNotice: '' });
        }
      }
      reusedCache = await reuseCache();
    }
    if (!reusedCache) await withMediaRecovery(vid, hongguoInfo?.series_id, { playInfo: checkedPlayInfo, quality, allowLowerQuality, force: true, cancelToken: source.token,
      onSourceReady: numeric ? clearHongguoSourceBackoff : null }, async playInfo => {
      source.token.throwIfRequested();
      const bytevc2Executable = playInfo.codec === 'bytevc2' ? requireBytevc2Executable() : null;
      notifyQuality(Math.min(Number(playInfo.width), Number(playInfo.height)));
      task.progress = 0; task.receivedBytes = 0; task.totalBytes = 0;
      sendToRenderer('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0 });
      if (playInfo.format === 'hls') {
        await prepareHlsFile(playInfo,tmpPath,{cancelToken:source.token,onProgress:received => { task.receivedBytes = received; sendToRenderer('download-progress',{id,progress:0,receivedBytes:received,totalBytes:0}); }});
        task.actualQuality = await verifyReceived(tmpPath, playInfo.duration);
        await temporary.checkInput();
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
      if (playInfo.contentKey || playInfo.codec === 'bytevc2') {
        const decodedPath = temporary.output;
        try {
          if (playInfo.codec === 'bytevc2') {
            const notice = task.qualityNotice;
            let conversionMeta;
            const progress = (seconds, phase = 'transcoding', meta = conversionMeta) => {
              conversionMeta = meta;
              task.progress = Math.min(99, Math.floor(seconds / playInfo.duration * 100));
              task.qualityNotice = phase === 'queued' ? '视频已下载，等待其他视频转换完成'
                : conversionNotice(meta) || '视频已下载，正在转换为可播放格式';
              sendToRenderer('download-progress', { id, progress: task.progress, qualityNotice: task.qualityNotice });
            };
            try {
              await convertBytevc2({ executable: bytevc2Executable, input: tmpPath, output: decodedPath,
                fastConversion: getCurrentSettings().fast_conversion,
                contentKey: playInfo.contentKey, duration: playInfo.duration, cancelToken: source.token, onProgress: progress,
                onPhase: (phase, meta) => progress(0, phase, meta), reserveOutput: temporary.reserveOutput });
            } finally { task.qualityNotice = notice || ''; }
          } else {
            await temporary.reserveOutput();
            await decryptContentKeyFile(tmpPath, decodedPath, playInfo.contentKey, { cancelToken: source.token, cleanupOutput: temporary.removeOutput });
          }
          task.actualQuality = await verifyReceived(decodedPath, playInfo.duration);
          await temporary.checkOutput();
          source.token.throwIfRequested();
          publishDownloadFile(decodedPath, finalPath);
        } catch (error) {
          await temporary.removeOutput().catch(() => {});
          throw error;
        }
      } else if (playInfo.spadeA) {
        const key = hongguo.deriveKey(playInfo.spadeA);
        if (!key) throw new Error('Key 派生失败');
        // Decrypt to another temporary file; never expose partial data as a completed MP4.
        const decodedPath = temporary.output;
        try {
          await temporary.reserveOutput();
          await decryptInWorker({ srcPath: tmpPath, dstPath: decodedPath, key }, { cancelToken: source.token });
          task.actualQuality = await verifyReceived(decodedPath, playInfo.duration);
          await temporary.checkOutput();
          source.token.throwIfRequested();
          publishDownloadFile(decodedPath, finalPath);
        }
        catch (error) {
          await temporary.removeOutput().catch(() => {});
          throw error;
        }
      } else {
        task.actualQuality = await verifyReceived(tmpPath, playInfo.duration);
        await temporary.checkInput();
        source.token.throwIfRequested();
        publishDownloadFile(tmpPath, finalPath);
      }
    });
    task.published = true;
    task.fileIdentity = readFileIdentity(finalPath);
    await completeNasExports(task);
    source.token.throwIfRequested();
    task.status = 'completed'; task.progress = 100; task.endTime = Date.now();
    delete task.sourceRetries; delete task.sourceRetryLimit;
    if (task.qualityNotice) task.qualityNotice = task.qualityNotice.replace('正在下载', '已下载');
    saveDownloadTasks(); sendToRenderer('download-completed', { id, path: finalPath, actualQuality: task.actualQuality, qualityNotice: task.qualityNotice || '' });
  } catch (error) {
    if (writer && !writer.destroyed) writer.destroy();
    task.qualityNotice = '';
    // Once the verified final file is published, a late cancel only affects NAS export.
    if (task.published && fs.existsSync(finalPath)) {
      try {
        task.fileIdentity = readFileIdentity(finalPath);
        task.status = 'completed'; task.progress = 100; task.endTime = Date.now();
        delete task.error; delete task.sourceRetries; delete task.sourceRetryLimit;
        saveDownloadTasks();
        sendToRenderer('download-completed', { id, path: finalPath, actualQuality: task.actualQuality, qualityNotice: task.qualityNotice || '' });
        return;
      } catch (_) { /* Fall through to the normal cancellation/error state. */ }
    }
    // A retry may already be queued; the cancelled old run must not overwrite it.
    if (source.token.reason || axios.isCancel(error) || task.cancelled) {
      if (task.status !== 'pending') {
        task.status = 'stopped'; task.error = ''; task.endTime = Date.now();
        sendToRenderer('download-stopped', { id, qualityNotice: '' });
      }
    } else {
      const retries = task.sourceRetries || 0;
      task.status = 'failed'; task.error = error.code === 'EEXIST' ? '下载临时文件发生冲突或已变化，已有文件已保留，请重试' : error.message; task.endTime = Date.now();
      const rejection = numeric && isDownloadSourceRejection(error);
      const rejectionRetry = rejection || isTransientRegistrationFailure(error)
        || error.code === 'EMPTY_RESPONSE' || error.code === 'SOURCE_UNAVAILABLE' && sourceFailureHasEmpty(error);
      const delays = rejectionRetry ? REJECTION_RETRY_DELAYS
        : error.code === 'SOURCE_UNAVAILABLE' || [404, 410].includes(error.mediaStatus)
          ? SOURCE_RETRY_DELAYS : TRANSFER_RETRY_DELAYS;
      if (rejectionRetry) {
        holdHongguoLookups(REJECTION_RETRY_DELAYS[Math.min(sourceRejectionStreak, REJECTION_RETRY_DELAYS.length - 1)]);
        sourceRejectionStreak++;
      }
      if (retries < delays.length && (rejection || isDeferrableSourceError(task, error))) {
        const delay = delays[retries];
        task.sourceRetries = retries + 1; task.retryAt = Date.now() + delay; task.sourceRetryLimit = delays.length;
        const wait = delay >= 120000 ? `${delay / 60000} 分钟` : `${delay / 1000} 秒`;
        task.error = `${error.message} 将在 ${wait}后自动重试（${retries + 1}/${delays.length}）。`;
        armSourceRetry(task);
      }
      sendToRenderer('download-failed', { id, error: task.error, retryAt: task.retryAt || null,
        sourceRetries: task.sourceRetries || 0, sourceRetryLimit: task.sourceRetryLimit || 3, qualityNotice: '' });
    }
    saveDownloadTasks();
  } finally {
    if (temporary) {
      const result = await temporary.cleanup().catch(() => null);
      if (!result?.missing) console.warn('下载临时文件未清理完毕，已保留身份记录供后续安全清理');
      if (result?.missing) {
        task.temporaryDownloads = task.temporaryDownloads.filter(record => record !== temporary.record);
        try { saveDownloadTasks(); } catch (_) { /* The stored receipt remains recoverable on restart. */ }
      }
    }
    if (task.cancelSource === source) delete task.cancelSource;
    if (task.writer === writer) delete task.writer;
  }
}

// 向渲染进程发送事件
function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, sanitizeIpcValue(payload));
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
ipcMain.handle('get-media-sources', async () => ({ success: true, sources: require('./src/native/media-sources').getMediaSources(getCurrentSettings()) }));
ipcMain.handle('set-builtin-source-enabled', async (_event, id, enabled) => {
  try {
    store.saveSettings(require('./src/native/media-sources').setBuiltinSourceEnabled(getCurrentSettings(), id, enabled));
    for (const win of new Set([mainWindow, ...BrowserWindow.getAllWindows()])) {
      if (win?.webContents && !win.webContents.isDestroyed()) win.webContents.send('media-sources-changed');
    }
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});
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
  if ((['xifan', 'hema'].includes(options?.source) && getCurrentSettings().builtin_sources?.[options.source] === false)
    || (['reelshort', 'dramabox'].includes(options?.source) && getCurrentSettings().builtin_sources?.[options.source] !== true)) return { success: false, results: [], error: '此来源已关闭，可在设置中重新开启' };
  if (proxyStartupFallback) return { success: false, error: '网络代理配置无效，请先在设置中修复或明确关闭代理。' };
  if ((!options?.source || options.source === 'hongguo') && options?.catalogChannel != null
    && !['app', 'web'].includes(options.catalogChannel)) return { success: false, error: '不支持的红果目录线路' };
  const moduleName = String(options?.source).startsWith('custom:') ? './src/native/custom-source' : options?.source === 'hema' ? './src/native/hema'
    : options?.source === 'xifan' ? './src/native/xifan'
    : options?.source === 'reelshort' ? './src/native/reelshort'
    : options?.source === 'dramabox' ? './src/native/dramabox'
      : options?.catalogChannel === 'web' ? './src/native/catalog' : './src/native/hongguo-app-catalog';
  const catalogOptions = moduleName === './src/native/catalog'
    ? { ...options, allowTrustedDns: resolveProxyConfig(getCurrentSettings()).mode === 'direct' } : options;
  return require(moduleName).browseList(catalogOptions, (authInfo, callback) => {
    if (matchesProxyAuth(authInfo)) callback(proxyManager.activeAuth.username, proxyManager.activeAuth.password);
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
let newReleaseCooldownUntil = 0;
const NEW_RELEASE_COOLDOWN_MS = 30 * 1000;
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
  if (Date.now() < newReleaseCooldownUntil) {
    return { results: [], partial: false, checked: false, error: 'App 上新补搜暂时不可用，请稍后重试' };
  }
  const budget = Number(deadline) || 0;
  if (!budget || budget - Date.now() < 900) return { results: [], checked: false, error: '' };
  try {
    const module = require('./src/native/hongguo-app-new');
    const detailed = await module.searchNewReleasesDetailed(keyword, {
      deadline: Math.min(budget, Date.now() + 8000),
    });
    if (detailed?.partial && !detailed?.results?.length) newReleaseCooldownUntil = Date.now() + NEW_RELEASE_COOLDOWN_MS;
    else newReleaseCooldownUntil = 0;
    return {
      results: Array.isArray(detailed?.results) ? detailed.results : [],
      partial: detailed?.partial === true,
      checked: true,
      error: detailed?.partial ? 'App 上新目录只读取到部分分类' : '',
    };
  } catch (error) {
    newReleaseCooldownUntil = Date.now() + NEW_RELEASE_COOLDOWN_MS;
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
  if ((['xifan', 'hema'].includes(source) && getCurrentSettings().builtin_sources?.[source] === false)
    || (['reelshort', 'dramabox'].includes(source) && getCurrentSettings().builtin_sources?.[source] !== true)) throw new Error('此来源已关闭，可在设置中重新开启');
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
  if (options?.source === 'reelshort') return require('./src/native/reelshort').search(keyword, options.page, { deadline });
  if (options?.source === 'dramabox') return require('./src/native/dramabox').search(keyword, options.page, { deadline });
  if (options?.source && options.source !== 'hongguo') throw new Error('不支持的搜索来源');
  const page = options.page;
  const searchQuery = normalizeSearchTitle(keyword);
  const reserveNewRelease = page === 1 && options?.fuzzy !== false && searchQuery.length >= 2;
  const officialDeadline = reserveNewRelease && deadline
    ? Math.min(deadline, Date.now() + 12000)
    : deadline;
  const requestOptions = deadline ? { deadline } : undefined;
  const officialRequestOptions = officialDeadline ? { deadline: officialDeadline } : undefined;
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
      const appDeadline = Math.min(deadline || Date.now() + 8000, Date.now() + 8000);
      const app = await require('./src/native/hongguo-app-search').searchApp(keyword, { page: 1, deadline: appDeadline });
      if (app.results.length && hasTitleMatch(app.results)) {
        appSearchCooldownUntil = 0;
        return { ...app, via: 'app', pageTitle: '', meta: { total: app.results.length, page: 1, hasMore: app.hasMore, relaxed: false } };
      }
      appSearchCooldownUntil = 0;
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
    const response = await searchHongguo(keyword, officialRequestOptions);
    let results = response.results;
    const attempted = [], fuzzyErrors = [];
    if (options?.fuzzy !== false && !hasTitleMatch(results)) {
      // 标点/空格让来源没搜到原名时，先用去标点全名、再用首段各补搜一次；
      // 命中完整标题或两次都失败就停止，最多两次额外请求。
      for (const relaxed of relaxedHongguoQueries(keyword)) {
        if (deadline && Date.now() >= deadline) { fuzzyErrors.push('搜索时间预算已用完'); break; }
        try {
          const extra = await searchHongguo(relaxed, officialRequestOptions);
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
    // Any non-exact result can be an older title that merely contains the query.
    // For longer titles, a "contains" match previously suppressed the new-release
    // lookup even when the exact new drama existed.
    const needsNewRelease = searchQuery.length >= 2 && !hasExactTitleMatch(results);
    let newRelease = { results: [], checked: false, error: '' };
    if (options?.fuzzy !== false && needsNewRelease) {
      // When the website already has usable results, give the App supplement a
      // short additive budget instead of blocking the whole search for 8 seconds.
      const supplementDeadline = results.length
        ? Math.min(deadline || Date.now() + 2500, Date.now() + 2500)
        : deadline;
      newRelease = await searchNewReleasesForSearch(keyword, { deadline: supplementDeadline });
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
      newReleasePartial: newRelease.partial === true,
      ...(newRelease.error ? { newReleaseError: newRelease.error } : {}),
    };
    const webMeta = { ...meta, channel: 'web', cursor: { page: response.page, nextPage: response.nextPage || null }, hasMore: !!response.hasMore };
    const supplementalErrors = [
      ...fuzzyErrors,
      ...(newRelease.error || (newRelease.checked && newRelease.partial)
        ? [newRelease.error || 'App 上新目录只读取到部分分类'] : []),
    ];
    if (supplementalErrors.length && !results.length) {
      // 原词和补搜都没有结果，不能把服务错误说成“没有找到”。
      return { success: false, results: [], via: 'api', channel: 'web', partial: true,
        error: `搜索未完成：${[...new Set(supplementalErrors)].join('；')}`, meta: webMeta, appError: appFallbackError };
    }
    if (supplementalErrors.length) {
      return { success: true, results, pageTitle: '', via: 'api', channel: 'web', partial: true,
        error: `补充搜索未完成：${[...new Set(supplementalErrors)].join('；')}`, meta: webMeta,
        hasMore: !!response.hasMore, cursor: { page: response.page, nextPage: response.nextPage || null }, appError: appFallbackError };
    }
    return { success: true, results, pageTitle: '', via: 'api', channel: 'web', meta: webMeta, hasMore: !!response.hasMore, cursor: { page: response.page, nextPage: response.nextPage || null }, appError: appFallbackError };
  } catch (error) {
    const message = error?.message || String(error || '搜索失败');
    console.warn('[Search] 红果接口失败:', message);
    if (!appEnabled && options?.appSearch !== false && Date.now() >= appSearchCooldownUntil
      && error?.kind !== 'input' && (!deadline || deadline - Date.now() >= 1000)) {
      try {
        const appDeadline = Math.min(deadline || Date.now() + 8000, Date.now() + 8000);
        const app = await require('./src/native/hongguo-app-search').searchApp(keyword, { page: 1, deadline: appDeadline });
        appSearchCooldownUntil = 0;
        if (app.results.length) {
          return { ...app, via: 'app', pageTitle: '', partial: true,
            error: `官网搜索未完成：${message}；已自动切换 App 搜索`, apiError: message,
            meta: { total: app.results.length, page: 1, hasMore: app.hasMore, relaxed: false } };
        }
        appFallbackError = 'App 搜索没有返回结果';
      } catch (appError) {
        appSearchCooldownUntil = Date.now() + APP_SEARCH_COOLDOWN_MS;
        appFallbackError = appError?.message || 'App 搜索不可用';
        console.warn('[Search] 官网失败后的 App 搜索也未完成:', appFallbackError);
      }
    }
    // 接口 5xx/结构变化时 App 上新列表仍可能可用，能补到当天新剧就不必只报错或空等页面嗅探。
    if (page === 1 && options?.fuzzy !== false && searchQuery.length >= 2) {
      const newRelease = await searchNewReleasesForSearch(keyword, { deadline });
      const newReleaseIssue = newRelease.error || (newRelease.partial ? 'App 上新目录只读取到部分分类' : '');
      if (newRelease.results.length) {
        return { success: true, results: newRelease.results, pageTitle: '', via: 'app-new', channel: 'app-new', page: 1,
          total: newRelease.results.length, totalPages: 0, hasMore: false, nextPage: null, cursor: null, partial: true,
          error: `官网搜索未完成：${message}；已显示 App 上新补搜结果${newReleaseIssue ? `；App 上新补搜未完成：${newReleaseIssue}` : ''}`,
          meta: { total: newRelease.results.length, page: 1, totalPages: 0, hasMore: false, relaxed: false,
            newRelease: newRelease.results.length, newReleaseChecked: true, newReleasePartial: newRelease.partial === true,
            ...(newReleaseIssue ? { newReleaseError: newReleaseIssue } : {}) },
          apiError: message, appError: appFallbackError };
      }
      if (newRelease.checked && newReleaseIssue) {
        return { success: false, results: [], via: 'app-new', channel: 'app-new', page: 1, partial: true,
          error: `官网搜索未完成：${message}；App 上新补搜未完成：${newReleaseIssue}`,
          meta: { total: 0, page: 1, totalPages: 0, hasMore: false, relaxed: false,
            newRelease: 0, newReleaseChecked: true, newReleasePartial: newRelease.partial === true,
            newReleaseError: newReleaseIssue },
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
ipcMain.handle('forget-series', async (_event, seriesId, options = {}) => {
  try {
    const sid = String(seriesId);
    if (!seriesRegistry.some(entry => String(entry.series_id) === sid)) return { success: false, error: '未找到该剧' };
    if (options.clearCache === true) await clearSeriesPlaybackCache(sid);
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
        directoryIdentity: readDirectoryIdentity(path.dirname(f.path)),
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

function requireBytevc2Executable() {
  const executable = resolveFfmpeg('librempeg');
  if (!executable) throw Object.assign(new Error('未找到内置 ByteVC2 解码组件，请重新下载完整版本后重试'), { code:'LOCAL_MEDIA_TOOL_ERROR' });
  return executable;
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
      { timeout: 30000, env: localMediaEnv() },
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
      { timeout: 30000, env: localMediaEnv() }, (err, stdout) => {
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

function readDirectoryIdentity(directory) {
  directory = fs.realpathSync(directory);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) throw new Error('下载目录不可用');
  return { directory, device: stat.dev, ino: stat.ino };
}

function fileIdentityMatches(identity, file) {
  try {
    const current = readFileIdentity(file);
    return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'contentHash']
      .every(key => identity?.[key] === current[key]);
  } catch (_) { return false; }
}

// ctime/mtime can change without replacing the file; destructive actions still require the full identity.
function fileIdentityStillSameObject(identity, file) {
  try {
    const current = readFileIdentity(file, { content: false });
    if (!sameFileObject(identity, current)) return false;
    if (!identity.contentHash) return true;
    if (current.mtimeNs === identity.mtimeNs && current.ctimeNs === identity.ctimeNs
      && current.birthtimeNs === identity.birthtimeNs) return true;
    return sameFileObject(identity, readFileIdentity(file));
  } catch (_) { return false; }
}

function legacyFileMatches(task, file) {
  try {
    const started = Number(task.startTime);
    const ended = Number(task.endTime);
    if (!Number.isFinite(started) || started <= 0 || !Number.isFinite(ended) || ended < started) return false;
    const stat = fs.lstatSync(file);
    const birth = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    return stat.isFile() && !stat.isSymbolicLink()
      && birth >= started - 2000 && birth <= ended + 2000;
  } catch (_) { return false; }
}

function validateDirectoryIdentity(identity, file) {
  try {
    const stat = fs.lstatSync(identity.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.device
      || fs.realpathSync(identity.directory) !== identity.directory
      || fs.realpathSync(path.dirname(file)) !== identity.directory) throw new Error();
    // shortcut: same path+device can be a fresh replacement; the inode disambiguates on stable-ID filesystems.
    if (Number.isSafeInteger(identity.ino) && identity.ino > 0
      && Number.isSafeInteger(stat.ino) && stat.ino > 0
      && stat.ino !== identity.ino) throw new Error();
  } catch (_) { throw new Error('下载目录不可用或挂载已变化，已保留文件和任务记录；请确认原目录后重试'); }
}

/** 同步核验 NAS 根目录、目标目录的设备与真实路径，防止错挂载同名文件被误认。 */
function nasDestinationCurrent(destination, file) {
  try {
    if (!destination?.root || !destination?.directory) return false;
    const root = fs.lstatSync(destination.root);
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== destination.device
      || fs.realpathSync(destination.root) !== destination.root) return false;
    const directory = fs.lstatSync(destination.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== destination.device
      || fs.realpathSync(destination.directory) !== destination.directory) return false;
    if (!nasDirectoryIdentityCurrent(destination)) return false;
    return pathInside(destination.directory, file);
  } catch (_) { return false; }
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

function isRegularFile(file) {
  try { return fs.lstatSync(file).isFile(); } catch (_) { return false; }
}

function fileOwnedByRecord(record, file, recordedPath) {
  if (!recordedPath || path.resolve(recordedPath) !== path.resolve(file)) return false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
  } catch (error) {
    // The final file may already be gone while an exact teammate temporary remains.
    return error.code === 'ENOENT';
  }
  return record.fileIdentity ? fileIdentityMatches(record.fileIdentity, file) : legacyFileMatches(record, file);
}

function ownsRecordedMediaFile(file) {
  const target = path.resolve(file);
  return downloadTasks.some(task => fileOwnedByRecord(task, target, task.savePath))
    || mergeTasks.some(task => fileOwnedByRecord(task, target, task.output));
}

function matchingFileRecord(file) {
  const target = path.resolve(file);
  const download = downloadTasks.find(task => task.savePath && fileOwnedByRecord(task, target, task.savePath));
  if (download) return { record: download, recordedPath: download.savePath };
  const merge = mergeTasks.find(task => task.output && fileOwnedByRecord(task, target, task.output));
  return merge ? { record: merge, recordedPath: merge.output } : null;
}

function restoreQuarantinedFile(quarantine, original) {
  if (fs.existsSync(original)) return false;
  try { fs.renameSync(quarantine, original); return true; }
  catch (_) { return false; }
}

/** Move first, then re-check the moved object so a replacement cannot be deleted. */
function quarantineAndRemove(file) {
  const original = path.resolve(file);
  if (!fs.existsSync(original)) return { count: 0, freed: 0, failed: 0 };
  const match = matchingFileRecord(original);
  let before;
  try { before = readFileIdentity(original); }
  catch (_) { return { count: 0, freed: 0, failed: 0, warning: `文件已变化或不再是普通文件（${path.basename(original)}），已保留` }; }
  const quarantine = path.join(path.dirname(original),
    `.hongguo-delete-${randomUUID()}${path.extname(original)}`);
  try {
    fs.renameSync(original, quarantine);
    const stillOwned = match
      ? (match.record.fileIdentity
          ? fileIdentityStillSameObject(match.record.fileIdentity, quarantine)
          : legacyFileMatches(match.record, quarantine))
      : fileIdentityStillSameObject(before, quarantine);
    if (!stillOwned) {
      const restored = restoreQuarantinedFile(quarantine, original);
      return { count: 0, freed: 0, failed: 0,
        warning: restored
          ? `文件在删除前发生变化（${path.basename(original)}），已保留`
          : `文件在删除前发生变化（${path.basename(original)}），已隔离保留为 ${path.basename(quarantine)}` };
    }
    const stat = fs.lstatSync(quarantine);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('文件类型已变化');
    fs.unlinkSync(quarantine);
    return { count: 1, freed: stat.size, failed: 0 };
  } catch (error) {
    if (fs.existsSync(quarantine)) restoreQuarantinedFile(quarantine, original);
    return { count: 0, freed: 0, failed: 1, warning: `文件删除失败（${path.basename(original)}）：${error.message}` };
  }
}

function isRecordedMediaFile(target, episode) {
  try {
    if (!isRegularFile(target)) return false;
    const matches = (recorded, dir) => typeof recorded === 'string'
      && path.relative(path.resolve(recorded), path.resolve(target)) === ''
      && pathInside(dir || path.dirname(recorded), target);
    const taskMatches = task => {
      if (!matches(task.savePath, task.customDir)) return false;
      if (!task.nasDestination && !task.nasTargets?.length && task.directoryIdentity) {
        try { validateDirectoryIdentity(task.directoryIdentity, task.savePath); } catch (_) { return false; }
      }
      return true;
    };
    if (downloadTasks.some(task => taskMatches(task)
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
    const stat = fs.lstatSync(target);
    if (!stat.isFile() && !stat.isDirectory()) return { success: false, error: '路径不存在' };
    shell.showItemInFolder(target);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-episode-external', async (_event, seriesId, vidIndex) => {
  try {
    const task = downloadTasks.find(item => item.status === 'completed'
      && String(item.hongguoInfo?.series_id) === String(seriesId)
      && Number(item.hongguoInfo?.vid_index) === Number(vidIndex) && hasCompleteTaskFile(item));
    if (!task || !/\.mp4$/i.test(task.savePath)
      || !isRecordedMediaFile(task.savePath, { seriesId, vidIndex, vid: task.hongguoInfo.vid })) {
      return { success: false, error: '请先完整下载本集，再使用系统播放器打开' };
    }
    const error = await shell.openPath(task.savePath);
    return error ? { success: false, error: '无法打开系统播放器，请检查 MP4 的默认打开方式' } : { success: true };
  } catch {
    return { success: false, error: '无法打开系统播放器，请检查文件和默认打开方式' };
  }
});

ipcMain.handle('get-merge-tasks', async () => mergeTasks.map(({ child, ...rest }) => rest));

function seriesDownloadDir(root, seriesId, seriesTitle) {
  const title = sanitizeFolderName(seriesTitle) || '未命名短剧';
  const suffix = createHash('sha256').update(String(seriesId)).digest('hex').slice(0, 12);
  return path.join(root, String(seriesId).startsWith('dramabox:') ? 'DramaBox' : String(seriesId).startsWith('reelshort:') ? 'ReelShort' : String(seriesId).startsWith('hema:') ? '河马短剧' : String(seriesId).startsWith('xifan:') ? '西饭短剧' : '红果短剧', `${title}-${suffix}`);
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
  if (!/^(xifan|hema|reelshort|dramabox|custom):/.test(String(seriesId))) {
    const title = sanitizeFolderName(seriesTitle) || '未命名短剧';
    const owners = seriesRegistry.filter(s => sanitizeFolderName(s.series_title) === title);
    const legacy = path.join(root, '红果短剧', title);
    if (owners.length <= 1 && fs.existsSync(legacy)) return legacy;
  }
  return null;
}

function hasCompleteTaskFile(task, conflicts = null) {
  if (!task?.savePath || task.pathConflict) return false;
  if (conflicts ? conflicts.get(task.savePath)?.has(task)
    : downloadTasks.some(other => other !== task && other.savePath === task.savePath && String(other.hongguoInfo?.vid) !== String(task.hongguoInfo?.vid))) return false;
  try {
    if (task.nasDestination) {
      if (!nasDestinationCurrent(task.nasDestination, task.savePath)) return false;
    } else if (task.directoryIdentity) {
      validateDirectoryIdentity(task.directoryIdentity, task.savePath);
    }
    if (!isRegularFile(task.savePath) || fs.statSync(task.savePath).size <= 1024 * 100) return false;
    return task.fileIdentity ? fileIdentityStillSameObject(task.fileIdentity, task.savePath) : legacyFileMatches(task, task.savePath);
  }
  catch (_) { return false; }
}

function repairTaskDestination(task) {
  const conflicts = downloadTasks.filter(other => other !== task && other.savePath === task.savePath && String(other.hongguoInfo?.vid) !== String(task.hongguoInfo?.vid));
  if (conflicts.length) for (const item of [task, ...conflicts]) item.pathConflict = true;
  if (!task.pathConflict) return;
  if (task.nasDestination) return;
  const settings = getCurrentSettings(), info = task.hongguoInfo || {};
  task.customDir = seriesDownloadDir(settings.root || app.getPath('downloads'), info.series_id, info.series_title);
  const filename = uniqueEpisodeFilename(settings, info.series_title, { vid_index: info.vid_index, title: info.ep_title });
  const suffix = createHash('sha256').update(String(info.vid)).digest('hex').slice(0, 8);
  task.filename = filename.replace(/\.mp4$/, `-${suffix}.mp4`);
  task.savePath = path.join(task.customDir, task.filename);
  if (task.directoryIdentity && path.resolve(task.customDir) !== path.resolve(task.directoryIdentity.directory)) delete task.directoryIdentity;
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

function episodeFileFamilyExists(file) {
  return episodeFilePaths(file).some(candidate => fs.existsSync(candidate));
}

function taskTemporaryRecords(task) {
  return task.temporaryDownloads == null ? [] : Array.isArray(task.temporaryDownloads) ? task.temporaryDownloads : [task.temporaryDownloads];
}

function untrackedTemporaryDirectories(directory) {
  const recorded = new Set(downloadTasks.flatMap(task => taskTemporaryRecords(task).map(record => record?.directory)));
  try { return fs.readdirSync(directory).filter(name => /^\.hongguo-download-[A-Za-z0-9]{6}$/.test(name))
    .map(name => path.join(directory, name)).filter(file => !recorded.has(file)); }
  catch (error) { return error.code === 'ENOENT' ? [] : [directory]; }
}

function hasPendingTemporaries(task) {
  return taskTemporaryRecords(task).length > 0 || !!task.savePath && untrackedTemporaryDirectories(path.dirname(task.savePath)).length > 0;
}

function temporaryWarning(count) {
  return count ? `临时文件归属无法确认，已保留 ${count} 个文件／目录及任务记录；这些项目未计入可释放空间。` : undefined;
}

function taskTemporaryState(task, record) {
  if (record?.directory && downloadTasks.some(other => other !== task && taskTemporaryRecords(other).some(item => item?.directory === record.directory))) {
    return { files:[], unverifiedItems:1, unverifiedBytes:null, missing:false, directoryVerified:false };
  }
  return inspectDownloadTemporary(record, downloadTemporaryOwner(task));
}

async function cleanupTaskTemporaries(tasks, extraDirectory) {
  let count = 0, freed = 0, failed = 0, retained = 0, changed = false;
  const previous = [];
  for (const task of tasks) {
    if (isTaskInFlight(task)) continue;
    const removed = new Set(), owner = downloadTemporaryOwner(task);
    for (const record of [...taskTemporaryRecords(task)]) {
      const state = taskTemporaryState(task, record);
      const canRemove = () => downloadTasks.includes(task) && !isTaskInFlight(task) && task.savePath === owner.savePath && taskTemporaryRecords(task).includes(record);
      const result = state.directoryVerified || state.missing ? await cleanupDownloadTemporary(record, owner, canRemove)
        : { ...state, count:0, freed:0, failed:0 };
      count += result.count; freed += result.freed; failed += result.failed;
      if (result.missing) removed.add(record);
      else retained += Math.max(1, result.files.length + result.unverifiedItems);
    }
    if (removed.size) {
      previous.push([task, task.temporaryDownloads]);
      task.temporaryDownloads = taskTemporaryRecords(task).filter(record => !removed.has(record)); changed = true;
    }
  }
  const parents = new Set([extraDirectory, ...tasks.map(task => task.savePath && path.dirname(task.savePath))].filter(Boolean));
  retained += new Set([...parents].flatMap(untrackedTemporaryDirectories)).size;
  if (changed) {
    try { saveDownloadTasks(); }
    catch (_) { for (const [task, records] of previous) task.temporaryDownloads = records; failed++; retained++; }
  }
  return { count, freed, failed:failed + retained, warning:temporaryWarning(retained) };
}

function ownsEpisodeFiles(file, owners) {
  const paths = new Set(episodeFilePaths(file));
  return !downloadTasks.some(task => paths.has(task.savePath) && !owners.includes(task))
    && !mergeTasks.some(task => paths.has(task.output));
}

function withDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('网络目录响应超时'));
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('网络目录响应超时')), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function seriesDirectoryIsUsable(directory, deadline) {
  try {
    const stat = await withDeadline(fsp.lstat(directory), deadline);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (_) { return false; }
}

async function resolveSeriesDirAsync(seriesId, seriesTitle, tasks, deadline) {
  for (const task of tasks) {
    if (task.customDir && await seriesDirectoryIsUsable(task.customDir, deadline)) return task.customDir;
    if (task.savePath && await seriesDirectoryIsUsable(path.dirname(task.savePath), deadline)) return path.dirname(task.savePath);
  }
  const settings = getCurrentSettings();
  const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : app.getPath('downloads');
  const guess = seriesDownloadDir(root, seriesId, seriesTitle);
  if (await seriesDirectoryIsUsable(guess, deadline)) return guess;
  if (!/^(xifan|hema|reelshort|dramabox|custom):/.test(String(seriesId))) {
    const title = sanitizeFolderName(seriesTitle) || '未命名短剧';
    const owners = seriesRegistry.filter(series => sanitizeFolderName(series.series_title) === title);
    const legacy = path.join(root, '红果短剧', title);
    if (owners.length <= 1 && await seriesDirectoryIsUsable(legacy, deadline)) return legacy;
  }
  return null;
}

async function readDirectoryIdentityAsync(directory) {
  const real = await fsp.realpath(directory);
  const stat = await fsp.stat(real, { bigint: true });
  if (!stat.isDirectory()) throw new Error('下载目录不可用');
  return { directory: real, device: Number(stat.dev), ino: Number(stat.ino) };
}

async function directoryIdentityMismatch(identity, file) {
  try {
    const stat = await fsp.lstat(identity.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'type';
    if (stat.dev !== identity.device) return 'device';
    const identityPath = await fsp.realpath(identity.directory);
    const parentPath = await fsp.realpath(path.dirname(file));
    if (path.relative(identityPath, parentPath) !== '') return 'path';
    if (Number.isSafeInteger(identity.ino) && identity.ino > 0
      && Number.isSafeInteger(stat.ino) && stat.ino > 0
      && stat.ino !== identity.ino) return 'inode';
    return '';
  } catch (_) { return 'unavailable'; }
}

async function nasDestinationCurrentAsync(destination, file) {
  try {
    if (!destination?.root || !destination?.directory || !pathInside(destination.directory, file)) return false;
    const root = await fsp.lstat(destination.root, { bigint: true });
    const directory = await fsp.lstat(destination.directory, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || Number(root.dev) !== destination.device
      || await fsp.realpath(destination.root) !== destination.root
      || !directory.isDirectory() || directory.isSymbolicLink() || Number(directory.dev) !== destination.device
      || await fsp.realpath(destination.directory) !== destination.directory) return false;
    for (const [name, identity] of [['root', destination.rootIdentity], ['directory', destination.directoryIdentity]]) {
      if (!identity) continue;
      const stat = name === 'root' ? root : directory;
      if (String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino
        || (identity.birthtimeNs != null && String(stat.birthtimeNs) !== identity.birthtimeNs)) return false;
    }
    return true;
  } catch (_) { return false; }
}

async function legacyFileMatchesAsync(task, file) {
  try {
    const started = Number(task.startTime), ended = Number(task.endTime);
    if (!Number.isFinite(started) || started <= 0 || !Number.isFinite(ended) || ended < started) return false;
    const stat = await fsp.lstat(file);
    const birth = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    return stat.isFile() && !stat.isSymbolicLink() && birth >= started - 2000 && birth <= ended + 2000;
  } catch (_) { return false; }
}

async function completeTaskFileForList(task, conflicts) {
  const failed = reason => ({ error: reason });
  if (!task?.savePath) return failed('missing-path');
  if (task.pathConflict) return failed('path-conflict');
  if (conflicts.get(task.savePath)?.has(task)) return failed('task-conflict');
  if (task.nasDestination && !await nasDestinationCurrentAsync(task.nasDestination, task.savePath)) return failed('nas-identity');
  if (!task.nasDestination && task.directoryIdentity) {
    const mismatch = await directoryIdentityMismatch(task.directoryIdentity, task.savePath);
    if (mismatch) return failed(`directory-${mismatch}`);
  }
  try {
    const stat = await fsp.lstat(task.savePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return failed('not-file');
    if (stat.size <= 1024 * 100) return failed('too-small');
    if (task.fileIdentity) {
      const current = await readFileIdentityAsync(task.savePath, { content: false });
      if (!sameFileObject(task.fileIdentity, current)) return failed('file-identity');
      if (task.fileIdentity.contentHash
        && (current.mtimeNs !== task.fileIdentity.mtimeNs || current.ctimeNs !== task.fileIdentity.ctimeNs
          || current.birthtimeNs !== task.fileIdentity.birthtimeNs)) {
        const full = await readFileIdentityAsync(task.savePath);
        if (!sameFileObject(task.fileIdentity, full)) return failed('content-identity');
      }
    } else if (!await legacyFileMatchesAsync(task, task.savePath)) return failed('legacy-identity');
    return { size: stat.size, identity: task.fileIdentity?.contentHash ? task.fileIdentity : null };
  } catch (_) { return failed('stat-error'); }
}

async function scanSeriesEpisodes(seriesId, seriesTitle, tasks, entry) {
  const conflicts = pathConflicts(downloadTasks);
  const byIndex = new Map(), failures = new Map();
  for (let offset = 0; offset < tasks.length; offset += 6) {
    const batch = tasks.slice(offset, offset + 6);
    const checked = await Promise.all(batch.map(task => completeTaskFileForList(task, conflicts)));
    batch.forEach((task, index) => {
      const complete = checked[index];
      const idx = Number(task.hongguoInfo?.vid_index) || 0;
      if (!complete || complete.error) {
        if (idx && task.status === 'completed') failures.set(task.id, complete?.error || 'incomplete');
        return;
      }
      if (!idx || !ownsEpisodeFiles(task.savePath, tasks)) {
        if (idx && task.status === 'completed') failures.set(task.id, 'ownership');
        return;
      }
      const previous = byIndex.get(idx);
      if (!previous || (task.startTime || 0) > (previous.startTime || 0)) byIndex.set(idx, {
        vid_index: idx, startTime: task.startTime || 0, path: task.savePath,
        filename: task.filename || path.basename(task.savePath), size: complete.size,
        identity: complete.identity, task,
      });
    });
  }

  const deadline = Date.now() + SERIES_SCAN_REACHABILITY_MS;
  const dir = await resolveSeriesDirAsync(seriesId, seriesTitle, tasks, deadline);
  let names = [], scanFailed = 0, dirIdentity = null;
  if (dir) {
    try {
      const stat = await withDeadline(fsp.lstat(dir), deadline);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      dirIdentity = await withDeadline(readDirectoryIdentityAsync(dir), deadline);
      names = await withDeadline(fsp.readdir(dir), deadline);
    } catch (_) { scanFailed = 1; }
  } else {
    scanFailed = 1;
  }

  const sharedDirectory = dir && (downloadTasks.some(task => String(task.hongguoInfo?.series_id) !== seriesId
      && task.savePath && path.dirname(task.savePath) === dir)
    || mergeTasks.some(task => String(task.seriesId) !== seriesId && task.output && path.dirname(task.output) === dir));
  const registeredPaths = new Set([...downloadTasks.map(task => task.savePath), ...mergeTasks.map(task => task.output)].filter(Boolean));
  const episodeNames = new Map();
  const formats = new Set([getCurrentSettings().name_format, '剧名 集数', '剧名 集数 标题', '剧名']);
  const ambiguousTitle = sharedDirectory && (seriesRegistry.some(series => String(series.series_id) !== seriesId
      && sanitizeFolderName(series.series_title) === sanitizeFolderName(seriesTitle))
    || downloadTasks.some(task => String(task.hongguoInfo?.series_id) !== seriesId && task.savePath
      && path.dirname(task.savePath) === dir
      && sanitizeFolderName(task.hongguoInfo?.series_title || '') === sanitizeFolderName(seriesTitle)));
  if (!ambiguousTitle) for (const episode of entry?.episodes || []) {
    for (const nameFormat of formats) {
      if (sharedDirectory && !/剧名|\bseries_title\b/.test(nameFormat || '')) continue;
      episodeNames.set(uniqueEpisodeFilename({ name_format: nameFormat }, seriesTitle, episode), Number(episode.vid_index));
    }
  }
  const candidates = names.map(name => {
    if (!/\.mp4$/i.test(name) || name.includes('合集')) return null;
    const idx = episodeNames.get(name) || 0;
    const full = dir && path.join(dir, name);
    if (!idx || !full || byIndex.has(idx) || registeredPaths.has(full) || !ownsEpisodeFiles(full, tasks)) return null;
    return { idx, full, name };
  }).filter(Boolean);
  for (let offset = 0; offset < candidates.length; offset += 6) {
    const batch = candidates.slice(offset, offset + 6);
    const checked = await Promise.all(batch.map(async item => {
      try {
        const stat = await fsp.lstat(item.full);
        return stat.isFile() && !stat.isSymbolicLink() && stat.size > 1024 * 100 ? stat.size : null;
      } catch (_) { return null; }
    }));
    batch.forEach((item, index) => {
      if (checked[index] != null) byIndex.set(item.idx, {
        vid_index: item.idx, path: item.full, filename: item.name, size: checked[index], identity: null, task: null,
      });
    });
  }
  return {
    dir, dirIdentity, scanFailed, failures, ordered: [...byIndex.values()].sort((a, b) => a.vid_index - b.vid_index),
  };
}

function seriesEpisodeBase(seriesId, entry, tasks) {
  return entry && entry.episodes.length
    ? entry.episodes
    : tasks.map(task => ({
        vid: task.hongguoInfo.vid,
        vid_index: task.hongguoInfo.vid_index,
        title: task.hongguoInfo.ep_title || '',
      }));
}

function getSeriesView(seriesId) {
  const revision = seriesProgressRevision;
  const existing = seriesEpisodeJobs.get(seriesId);
  if (existing?.revision === revision) return existing.promise;
  const jobEntry = { revision, promise: null };
  const job = (async () => {
    const seriesEntry = seriesRegistry.find(series => String(series.series_id) === seriesId);
    const tasks = downloadTasks.filter(task => task.hongguoInfo && String(task.hongguoInfo.series_id) === seriesId);
    const seriesTitle = seriesEntry?.series_title || tasks[0]?.hongguoInfo?.series_title || '未命名短剧';
    return {
      at: Date.now(),
      entry: seriesEntry,
      seriesTitle,
      baseEpisodes: seriesEpisodeBase(seriesId, seriesEntry, tasks),
      scan: await scanSeriesEpisodes(seriesId, seriesTitle, tasks, seriesEntry),
    };
  })().finally(() => { if (seriesEpisodeJobs.get(seriesId) === jobEntry) seriesEpisodeJobs.delete(seriesId); });
  jobEntry.promise = job;
  seriesEpisodeJobs.set(seriesId, jobEntry);
  return job;
}

async function seriesEpisodesData(seriesId, { withUrls = true } = {}) {
  const view = await getSeriesView(seriesId);
  const { entry, seriesTitle, baseEpisodes, scan } = view;
  const tasks = downloadTasks.filter(task => task.hongguoInfo && String(task.hongguoInfo.series_id) === seriesId);
  const taskByIndex = new Map();
  for (const task of tasks) {
    const index = Number(task.hongguoInfo.vid_index);
    const previous = taskByIndex.get(index);
    if (!previous || (task.startTime || 0) > (previous.startTime || 0)) taskByIndex.set(index, task);
  }
  const scannedByIndex = new Map(scan.ordered.map(item => [Number(item.vid_index), item]));
  const episodes = baseEpisodes.map(episode => {
    const idx = Number(episode.vid_index), task = taskByIndex.get(idx), scanned = scannedByIndex.get(idx);
    let status = 'missing', fileUrl = null, progress = 0, fileSize = 0, savePath = null;
    let candidate = null;
    if (task?.savePath) {
      savePath = task.savePath;
      const complete = scanned?.task === task;
      if (complete) {
        status = 'completed';
        candidate = scanned;
        fileSize = scanned.size;
      } else if (task.status === 'downloading') {
        status = 'downloading'; progress = task.progress || 0;
      } else if (task.status === 'pending') status = 'pending';
      else if (task.status !== 'completed') status = task.status;
    }
    if (status === 'missing' && scanned && scanned.task !== task) {
      status = 'completed'; candidate = scanned; savePath = scanned.path; fileSize = scanned.size;
    }
    return {
      vid: episode.vid, vid_index: idx,
      title: seriesId.startsWith('xifan:')
        ? require('./src/native/xifan').episodeDisplayTitle(seriesId, seriesTitle, episode.title || '') : episode.title || '',
      web_available: episode.web_available ?? null,
      locked: episode.locked === true,
      taskId: task ? task.id : null,
      error: task?.error || '',
      retryAt: task?.retryAt || null,
      actualQuality: task?.actualQuality || null,
      status, progress, fileSize, fileUrl, savePath,
      candidate,
      localCheck: task?.status === 'completed' && !candidate ? scan.failures.get(task.id) || 'not-matched' : undefined,
    };
  }).sort((a, b) => a.vid_index - b.vid_index);

  if (withUrls) {
    for (let offset = 0; offset < episodes.length; offset += 6) {
      await Promise.all(episodes.slice(offset, offset + 6).map(async episode => {
        const candidate = episode.candidate;
        if (episode.status !== 'completed' || !candidate) return;
        const validate = candidate.task
          ? () => downloadTasks.includes(candidate.task) && candidate.task.savePath === candidate.path
            && hasCompleteTaskFile(candidate.task)
          : () => {
              try {
                if (!scan.dirIdentity) return false;
                validateDirectoryIdentity(scan.dirIdentity, candidate.path);
                return isRegularFile(candidate.path);
              } catch (_) { return false; }
            };
        try {
          const identity = candidate.identity || await readFileIdentityAsync(candidate.path);
          candidate.identity = identity;
          episode.fileUrl = mediaAccess.localUrlWithIdentity(candidate.path, identity, validate);
        } catch (_) {
          episode.status = 'missing';
          episode.fileUrl = null;
        }
        delete episode.candidate;
      }));
    }
  }
  episodes.forEach(episode => { delete episode.candidate; });
  const completedCount = episodes.filter(episode => episode.status === 'completed').length;
  const data = {
    series_id: seriesId, series_title: seriesTitle, cover: entry?.cover || '', seriesDir: scan.dir,
    web_accessible_episodes: entry?.web_accessible_episodes ?? null,
    total: episodes.length, completedCount, episodes,
  };
  const revision = seriesProgressRevision;
  if (revision === seriesProgressRevision) {
    seriesProgressCache.set(seriesId, { at: Date.now(), completed: completedCount, total: episodes.length });
  }
  return data;
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
    try { const stat = fs.lstatSync(p); return stat.isFile() && stat.size > 1024 * 100; } catch (_) { return false; }
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
  let names = [], scanFailed = 0, dirIdentity = null;
  if (dir) {
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      dirIdentity = readDirectoryIdentity(dir);
      names = fs.readdirSync(dir);
    } catch (_) { scanFailed = 1; }
    for (const name of episodeNames.keys()) {
      const full = path.join(dir, name);
      if (ownsEpisodeFiles(full, tasks)) episodePaths.add(full);
    }
    for (const n of names) {
      if (!/\.mp4$/i.test(n) || n.includes('合集')) continue;
      // Unregistered files must match a known naming template exactly. A bare
      // numeric suffix is not proof that the file belongs to this series.
      const idx = episodeNames.get(n) || 0;
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
    dir, dirIdentity, sharedDirectory, episodeNames, episodePaths, temporaryPaths, mergedPaths, concatPaths, scanFailed,
    downloadTemporaries:tasks.flatMap(task => taskTemporaryRecords(task).map(record => ({ task, record }))),
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
    const mergedPaths = new Set(ordered.map(episode => episode.path));
    const sourceTaskIds = options?.deleteSources === true
      ? downloadTasks.filter(task => task.status === 'completed' && mergedPaths.has(task.savePath)).map(task => task.id)
      : [];
    const ffmpegPath = resolveFfmpeg('ffmpeg'), ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath || !ffprobePath) return { success: false, error: '未找到完整 FFmpeg 工具，无法检查并合并分集' };
    if (mergeTasks.some(t => t.status === 'running')) return { success: false, error: '已有合并任务正在运行，请等待完成或先取消' };
    let precheckedInfos;
    if (options?.require1080 === true) {
      const below1080 = [];
      precheckedInfos = [];
      for (const episode of ordered) {
        let info;
        try { info = await probeVideoInfo(ffprobePath, episode.path, undefined, true); }
        catch (_) { info = null; }
        if (!info || !(info.w > 0) || !(info.h > 0)) {
          return { success: false, code: 'MERGE_1080_UNAVAILABLE',
            error: `第 ${episode.vid_index} 集视频信息读取失败，无法确认是否达到 1080P；请选择快速合并或兼容合并。` };
        }
        const quality = Math.min(info.w, info.h);
        precheckedInfos.push(info);
        if (quality < 1080) below1080.push({ index: episode.vid_index, quality, w: info.w, h: info.h });
      }
      if (below1080.length) {
        const shown = below1080.slice(0, 3).map(item => `第 ${item.index} 集实际为 ${item.quality}P（${item.w}×${item.h}）`).join('、');
        const more = below1080.length > 3 ? `…共 ${below1080.length} 集未达到 1080P` : `；共 ${below1080.length} 集未达到 1080P`;
        return { success: false, code: 'MERGE_1080_UNAVAILABLE', error: `${shown}${more}；请选择快速合并或兼容合并。` };
      }
      // Probing yields to other IPC requests; re-check before synchronously creating and saving a task.
      if (mergeTasks.some(t => t.status === 'running')) return { success: false, error: '已有合并任务正在运行，请等待完成或先取消' };
    }
    const outDir = dir || path.dirname(ordered[0].path);
    const baseName = outputName && String(outputName).trim() ? sanitizeFolderName(outputName) : `${sanitizeFolderName(seriesTitle)}_合集`;
    if (!baseName || baseName === '.' || baseName === '..') return { success: false, error: '请输入有效输出名称' };
    let output = path.join(outDir, `${baseName}.mp4`);
    for (let number = 2; fs.existsSync(output); number++) output = path.join(outDir, `${baseName} (${number}).mp4`);
    const totalBytes = ordered.reduce((sum, e) => sum + fs.statSync(e.path).size, 0);
    const id = 'merge_' + randomUUID();
    const task = { id, seriesId: sid, seriesTitle, output, outputName: path.basename(output), total: ordered.length,
      deleteSourcesAfterMerge: options?.deleteSources === true,
      done: 0, checked: 0, progress: 0, status: 'running', stage: 'checking', stageText: '检查分集', totalBytes,
      totalDuration: 0, codecWarning: '', error: '', startTime: Date.now(), elapsedSeconds: 0, speed: 0, etaSeconds: null };
    mergeTasks.unshift(task);
    if (!saveMergeTasks()) { mergeTasks = mergeTasks.filter(t => t.id !== id); return { success: false, error: '无法保存合并任务，请检查存储错误提示后重试' }; }
    sendToRenderer('merge-task-added', { ...task });
    const { runMerge } = require('./src/native/merge-runner');
    const run = (async () => {
      try {
        await runMerge({ task, ordered, outDir, ffmpegPath, ffprobePath, probe: probeVideoInfo,
          precheckedInfos, pickEncoder: pickH264Encoder, compatible: !!options?.compatible,
          update: () => { const { child, ...data } = task; sendToRenderer('merge-progress', data); } });
        if (task.status === 'completed') {
          const info = await probeVideoInfo(ffprobePath, output, task, true);
          const expected = Number(task.totalDuration) || 0;
          const tolerance = Math.max(2, expected * 0.02);
          if (!info || !(info.duration > 0) || !(info.w > 0) || !(info.h > 0)
            || expected > 0 && info.duration < expected - tolerance
            || task.hasAudio === true && info.audio !== true) {
            throw new Error('合并输出时长或音视频轨校验失败，分集未删除；请检查输出文件后重试');
          }
          task.verified = '合并输出时长与轨道校验通过';
          task.fileIdentity = readFileIdentity(output);
          if (options?.deleteSources === true) {
            const cleanup = await deleteTaskRecords(sourceTaskIds.filter(taskId => {
              const source = downloadTasks.find(item => item.id === taskId);
              return source?.status === 'completed' && mergedPaths.has(source.savePath);
            }), { deleteFiles: true });
            task.cleanedCount = cleanup.fileCount || 0;
            task.cleanedBytes = cleanup.freed || 0;
            task.cleanupWarning = cleanup.success ? '' : (cleanup.error || cleanup.warning || '分集删除未完全完成');
          }
        }
      } catch (error) {
        task.status = task.cancelled ? 'stopped' : 'failed';
        task.stage = task.status; task.stageText = task.cancelled ? '已取消' : '合并失败';
        task.error = task.cancelled ? '已取消' : error.message;
      } finally {
        task.endTime = Date.now();
        if (!saveMergeTasks()) task.storageWarning = '合并记录未保存，导出文件状态请以磁盘为准';
        sendToRenderer(task.status === 'completed' ? 'merge-completed' : 'merge-failed', {
          id, path: output, error: task.error, verified: task.verified, storageWarning: task.storageWarning,
          cleanedCount: task.cleanedCount || 0, cleanedBytes: task.cleanedBytes || 0, cleanupWarning: task.cleanupWarning || '',
        });
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
  try {
    store.saveMergeTasks(mergeTasks.map(({ child, ...rest }) => rest.error ? { ...rest, error: safeErrorText(rest.error) } : rest));
    return true;
  }
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
ipcMain.handle('get-series-progress', async () => {
  const progress = {}, pending = [];
  for (const series of visibleSeries()) {
    const sid = String(series.series_id);
    const cached = seriesProgressCache.get(sid);
    if (cached) {
      progress[sid] = { completed: cached.completed, total: cached.total };
      if (Date.now() - cached.at >= SERIES_PROGRESS_TTL_MS) pending.push(sid);
    } else {
      progress[sid] = {
        completed: 0,
        total: Number(series.total) || (Array.isArray(series.episodes) ? series.episodes.length : 0),
      };
      pending.push(sid);
    }
  }
  return { success: true, progress, pending };
});

ipcMain.handle('warm-series-progress', async (_event, seriesId) => {
  const sid = String(seriesId || '');
  if (!sid) return { success: false, error: '缺少剧集编号' };
  try {
    const data = await seriesEpisodesData(sid, { withUrls: false });
    return { success: true, progress: { completed: data.completedCount, total: data.total } };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-series-episodes', async (event, seriesId) => {
  try {
    const data = await seriesEpisodesData(String(seriesId));
    return { success: true, data };
  } catch (error) {
    console.error('[Player] 读取分集失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 断点续播
ipcMain.handle('save-playback-position', async (event, seriesId, vidIndex, currentTime, metadata) => {  try {
    const sid = String(seriesId);
    const series = seriesRegistry.find(item => String(item.series_id) === sid);
    if (!series) return { success: false, error: '未找到短剧档案' };
    store.updatePlayback(map => {
      map[sid] = watchHistory.recordPlayback(map[sid], series, Number(vidIndex), Number(currentTime), Date.now(), metadata);
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-playback-position', async (event, seriesId) => {
  const sid = String(seriesId);
  const accountResume = accountController.takeResumePosition(sid);
  if (accountResume) return accountResume;
  const map = store.getPlayback() || {};
  return map[sid] || null;
});

function navigateToPlayer(payload) {
  sendToRenderer('navigate', {
    page: 'player',
    payload: {
      seriesId: payload?.seriesId ? String(payload.seriesId) : '',
      vidIndex: Number(payload?.vidIndex) || 0,
      resume: payload?.resume === true,
    },
  });
  return { success: true };
}

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
  return navigateToPlayer({ seriesId, vidIndex, resume: payload?.resume === true });
});

// ===== 在线播放 =====
function playbackQuality(value = 'auto', vid = '') {
  if (!['auto', '720p', '1080p'].includes(value)) throw new Error('在线播放清晰度无效，请选择自动、720p 或 1080p');
  if (value !== 'auto' && /^(xifan|hema|reelshort|dramabox|custom):/.test(String(vid))) throw new Error('此来源暂不支持指定在线播放清晰度，请选择自动');
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
  const web = playInfo.source === 'web';
  const safeNetwork = playInfo.source === 'dramabox'
    ? require('./src/native/dramabox').mediaRequestOptions(url.href)
    : {
        ...require('./src/native/web-media-guard').webMediaRequestOptions(url.href),
        ...(String(playInfo.vid).startsWith('custom:') ? { proxy: false } : {}),
      };
  const config = { method: 'GET', url: url.href, responseType: 'stream', timeout: 60000, ...options,
    ...safeNetwork,
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
  const recoverable = error => isDownloadSourceRejection(error) || isTransientRegistrationFailure(error)
    || error?.code === 'EMPTY_RESPONSE' || sourceFailureHasEmpty(error) ? false : error?.code === 'SOURCE_UNAVAILABLE'
    ? sourceFailureIsTransient(error)
    : error?.mediaRetryable || error?.code === 'MEDIA_DECODE_ERROR'
      || ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ERR_BAD_RESPONSE', 'ERR_STREAM_PREMATURE_CLOSE', 'EAI_AGAIN'].includes(error?.code);
  const rounds = options.recover !== false && /^\d{1,30}$/.test(String(vid)) ? 3 : 1;
  let lastError, decodeFailure, transfers = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      cancelled();
      if (round) {
        let timer;
        try { await awaitMediaOperation(new Promise(resolve => { timer = setTimeout(resolve, round * 500); }), controller.signal); }
        finally { clearTimeout(timer); }
      }
      cancelled();
      let info, lookup;
      try {
        info = !round && options.playInfo;
        if (!info) {
          lookup = boundedSignal(controller.signal, 30000);
          info = await awaitMediaOperation(hongguo.fetchPlayUrlSingle(vid, seriesId,
            { quality: options.quality, allowLowerQuality: options.allowLowerQuality, force: options.force || round > 0, signal: lookup.signal }), lookup.signal);
          throwIfAborted(lookup.signal);
        }
      } catch (error) {
        cancelled();
        if (lookup?.signal.aborted && lookup.signal.reason?.name === 'TimeoutError') error = mediaTransferError('获取片源超时，请稍后重试');
        if (!recoverable(error)) throw error;
        lastError = error;
        continue;
      } finally {
        lookup?.dispose();
      }
      cancelled();
      if (!info?.url) {
        lastError = Object.assign(new Error(info?.error || '未获取到有效播放地址'), { code: info?.code, sources: info?.sources });
        if (!recoverable(lastError) || info?.locked) throw lastError;
        continue;
      }
      options.onSourceReady?.();
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
          if (isDownloadSourceRejection(error)) throw error;
          // Local storage/security failures cannot be repaired by trying a lower-quality video.
          const terminal = error?.path || error?.dest
            || /^(?:EACCES|EPERM|ENOSPC|EDQUOT|EROFS|EIO|ENOENT|EEXIST|ENOTDIR|EISDIR|EMFILE|ENFILE|EBUSY|ENAMETOOLONG|EMLINK|EFBIG|LOCAL_MEDIA_TOOL_ERROR|SECURITY_BLOCKED|ERR_WEB_MEDIA_ADDRESS)$/.test(error?.code);
          if (options.allowLowerQuality && terminal || (!recoverable(error) && !options.allowLowerQuality)) throw error;
          lastError = error;
          // A bad Web body changes source priority; retry lookup before giving up on App recovery.
          if (error?.code === 'MEDIA_DECODE_ERROR' && candidate.source !== 'web') decodeFailure = error;
          hongguo.markWebMediaFailure?.(candidate);
          if (transfers >= 4 && !options.allowLowerQuality) throw lastError;
        }
      }
      if (decodeFailure) throw decodeFailure;
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
function localPlayUrl(filePath, validate) {
  if (!filePath) return null;
  return mediaAccess.localUrl(filePath, validate);
}

/**
 * 注册本地文件播放协议。
 * 改由主进程用 Node 读文件供给，而不是让 Chromium 读 file://：
 * 开发模式下渲染页面来自 http://localhost:5173，Chromium 会以
 * 「Not allowed to load local resource」拒绝 file:// 请求（表现为播放器黑屏、进度 0:00）。
 * 走自定义协议后开发/打包两种模式行为一致，并且支持 Range 拖动进度。
 */
function localMediaBody(file, options) {
  const stream = fs.createReadStream(file, options);
  localFileReaders.set(file, (localFileReaders.get(file) || 0) + 1);
  stream.once('close', () => {
    const remaining = localFileReaders.get(file) - 1;
    if (remaining) localFileReaders.set(file, remaining); else localFileReaders.delete(file);
  });
  return Readable.toWeb(stream);
}

function registerLocalProtocol() {
  protocol.handle(LOCAL_SCHEME, mediaWithCors(async (request) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      const filePath = mediaAccess.resolveLocal(request.url);
      if (!filePath || !mediaAccess.isValid(request.url)) {
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
        return new Response(request.method === 'HEAD' ? null : localMediaBody(filePath, { start, end }), {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }

      return new Response(request.method === 'HEAD' ? null : localMediaBody(filePath), {
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
async function decryptContentKeyFile(input, output, contentKey, { signal, cancelToken, cleanupOutput = () => fsp.unlink(output) } = {}) {
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
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: localMediaEnv() });
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
    await cleanupOutput().catch(() => {});
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
  const bytevc2Executable = playInfo.codec === 'bytevc2' ? requireBytevc2Executable() : null;
  const response = await requestMedia(playInfo, { signal });
  const total = Number(response.headers['content-length']) || 0;
  if (total > maxBytes) { response.data.destroy(); throw tooLarge(); }
  const chunks = [];
  let received = 0, lastProgress = 0;
  if (playInfo.contentKey || playInfo.codec === 'bytevc2') {
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
      if (playInfo.codec === 'bytevc2') {
        let conversionMeta;
        await convertBytevc2({ executable: bytevc2Executable, input, output,
          fastConversion: getCurrentSettings().fast_conversion,
          contentKey: playInfo.contentKey, duration: playInfo.duration, signal, maxBytes,
          onPhase: (phase, meta) => { conversionMeta = meta; onProgress?.(0, received, phase, conversionNotice(meta)); },
          getPriority: () => [...onlineSessions.values()].some(session => session.vid === String(vid) && !session.prefetch) ? 2 : 1,
          onProgress: seconds => onProgress?.(Math.floor(received * Math.min(1, seconds / playInfo.duration)), received, 'transcoding', conversionNotice(conversionMeta)) });
      } else {
        if (onProgress) onProgress(received, received, 'decrypting');
        await decryptContentKeyFile(input, output, playInfo.contentKey, { signal });
      }
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
  const session = { vid: sourceVid, seriesId: String(seriesId || ''), vidIndex: Number(vidIndex), cacheKey: key, requestId, prefetch, requests: new Set(), entry: null };
  onlineSessions.set(streamId, session);
  try {
    checkCustomAccess(sourceVid);
    const checkedPlayInfo = /^(xifan|hema|reelshort|dramabox|custom):/.test(sourceVid) ? await hongguo.fetchPlayUrlSingle(sourceVid, seriesId, { force, quality }) : null;
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
          const progress = (received,total,phase,notice) => {
            job.progress = { received, total, percent: total ? Math.floor(received / total * 100) : 0, phase: phase || 'downloading', ...(notice ? {notice} : {}) };
            for (const active of onlineSessions.values()) if (active.cacheKey === key) {
              sendToRenderer('online-play-progress',{vid:sourceVid,seriesId,vidIndex,requestId:active.requestId, ...job.progress});
            }
          };
          const prepared = await withMediaRecovery(sourceVid,seriesId,{playInfo:checkedPlayInfo,quality,force,signal:controller.signal},async playInfo => {
            const entry = {quality,codec:playInfo.codec === 'bytevc2' ? 'h264' : playInfo.codec || '',size:0,lastUsed:Date.now(),seriesId:String(seriesId||''),vidIndex:Number(vidIndex)||0};
            if (playInfo.format === 'hls') await prepareHlsEntry(playInfo,entry,controller.signal,received => progress(received,0));
            else if (!prefetch && !playInfo.spadeA && !playInfo.contentKey && playInfo.codec !== 'bytevc2') return {...entry,playInfo};
            else {
              entry.buffer = await fetchDecryptedEpisodeOnce(sourceVid,progress,seriesId,playInfo,controller.signal);
              entry.size = entry.buffer.length;
            }
            if (controller.signal.aborted) throw new Error('已取消播放');
            Object.assign(entry,{vid:sourceVid,source:/^custom:[^:]+/.exec(sourceVid)?.[0] || /^(xifan|hema|reelshort|dramabox):/.exec(sourceVid)?.[1] || 'hongguo',complete:true});
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
      if (job.progress) sendToRenderer('online-play-progress', { vid: sourceVid, seriesId, vidIndex, requestId, ...job.progress });
      entry = await job.promise;
    }
    if (!onlineSessions.has(streamId)) throw new Error('已取消播放');
    session.entry = { ...entry }; entry.lastUsed = Date.now();
    return { success: true, url: `${STREAM_SCHEME}://play/${streamId}`, streamId, size: entry.size,
      cached, streaming: !!entry.playInfo, codec: entry.codec || '' };
  } catch (error) {
    releaseOnlineSession(streamId);
    return { success: false, error: error.message, code: error.code,
      ...(Array.isArray(error.sources) ? { sources: error.sources.map(({ source, code }) => ({ source, code })) } : {}) };
  }
});

ipcMain.handle('promote-online-play', (event, payload = {}) => {
  for (const session of onlineSessions.values()) {
    if (payload.requestId && session.requestId === payload.requestId) {
      session.prefetch = false;
      if (session.job?.progress) sendToRenderer('online-play-progress', { vid: session.vid, seriesId: session.seriesId,
        vidIndex: session.vidIndex, requestId: session.requestId, ...session.job.progress });
    }
  }
  return { success: true };
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

async function clearSeriesPlaybackCache(sid) {
  const belongs = entry => String(entry?.seriesId || '') === sid;
  const jobs = new Set([...onlineSessions.values()].filter(belongs).map(session => session.job).filter(Boolean));
  for (const [id, session] of [...onlineSessions]) if (belongs(session)) releaseOnlineSession(id);
  await Promise.allSettled([...jobs].filter(job => ![...onlineSessions.values()].some(session => session.job === job)).map(job => job.promise));
  for (const [key, entry] of [...onlineCache]) if (belongs(entry)) deleteOnlineCacheEntry(key);

  const cacheDir = path.resolve(getCompatDir());
  const base = compatSeriesStem(sid);
  if (!base) throw new Error('兼容缓存文件名无效，已停止清理');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(`^${escaped}_(\\d{3,})(?:_(?:720p|1080p))?\\.mp4(?:\\.part)?$`);
  const ownsName = name => {
    const match = namePattern.exec(name);
    const index = match ? Number(match[1]) : 0;
    return !!match && Number.isSafeInteger(index) && index > 0 && match[1] === String(index).padStart(3, '0');
  };
  const outputForName = name => path.join(cacheDir, name.replace(/\.part$/, ''));

  const active = [...compatPreparing].filter(([output]) =>
    path.dirname(path.resolve(output)) === cacheDir && ownsName(path.basename(output)));
  for (const [output, job] of active) {
    job.cancelled = true;
    job.controller.abort();
    await job.promise;
  }

  let entries;
  try { entries = await fsp.readdir(cacheDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !ownsName(entry.name)) continue;
    const file = path.join(cacheDir, entry.name);
    const output = outputForName(entry.name);
    const job = compatPreparing.get(output);
    if (job) {
      job.cancelled = true;
      job.controller.abort();
      await job.promise;
      continue;
    }
    if (isFileInUse(file)) continue;
    try { await fsp.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
ipcMain.handle('clear-series-playback-cache', async (_event, seriesId) => {
  try { await clearSeriesPlaybackCache(String(seriesId)); return { success: true }; }
  catch { return { success: false, error: '部分播放缓存未能清理，请停止播放后重试' }; }
});

ipcMain.handle('discover-cast-devices', async () => {
  try { return { success: true, devices: await casting.discover() }; }
  catch { return { success: false, error: '搜索电视失败，请检查局域网连接和防火墙' }; }
});
ipcMain.handle('start-casting', async (_event, payload = {}) => {
  if (castBusy) return { success: false, error: '正在连接电视，请稍候', ...casting.status() };
  castBusy = true;
  let pinned, pinnedFile, released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (pinnedFile) {
      const remaining = (castFileRefs.get(pinnedFile) || 1) - 1;
      if (remaining) castFileRefs.set(pinnedFile, remaining); else castFileRefs.delete(pinnedFile);
    }
    if (pinned?.disk) { pinned.disk.readers--; disposeOnlineDisk(pinned); }
  };
  try {
    const source = String(payload.source || '');
    const file = mediaAccess.resolveLocal(source);
    let media;
    if (file) {
      if (!mediaAccess.isValid(source)) throw new Error('本地视频已变化，请重新选择');
      media = { filePath: file };
    }
    else {
      const url = new URL(source);
      const entry = url.protocol === `${STREAM_SCHEME}:` && url.hostname === 'play' && onlineSessions.get(url.pathname.slice(1))?.entry;
      if (!entry?.complete) throw new Error('请先完整缓存本集');
      pinned = entry;
      if (entry.disk) entry.disk.readers++;
      media = { buffer: entry.buffer, filePath: entry.filePath };
    }
    pinnedFile = media.filePath;
    if (pinnedFile) castFileRefs.set(pinnedFile, (castFileRefs.get(pinnedFile) || 0) + 1);
    const result = await casting.start(String(payload.deviceId), { ...media, title: String(payload.title || '').slice(0,150), release });
    return { success: true, ...result, ...casting.status() };
  } catch (error) {
    release();
    return { success: false, error: '连接电视失败，请确认电视可用并重试', ...casting.status() };
  } finally { castBusy = false; }
});
ipcMain.handle('control-casting', async (_event, action) => {
  if (castBusy && action !== 'Stop') return { success: false, error: '正在连接电视，请稍候', ...casting.status() };
  try { await casting.control(action); return { success: true, ...casting.status() }; }
  catch { return { success: false, error: '电视控制失败，请重新连接', ...casting.status() }; }
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

function compatSeriesStem(seriesId) {
  const raw = String(seriesId || '');
  const safe = sanitizeFolderName(raw);
  if (safe === raw && safe) return safe;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${safe || 'series'}-${hash}`;
}

function compatFileName(seriesId, vidIndex, quality = 'auto') {
  if (!['string', 'number'].includes(typeof vidIndex) || !/^[1-9]\d*$/.test(String(vidIndex))
    || !Number.isSafeInteger(Number(vidIndex))) throw new Error('集数必须是有效正整数');
  return `${compatSeriesStem(seriesId)}_${String(Number(vidIndex)).padStart(3, '0')}${quality === 'auto' ? '' : `_${playbackQuality(quality)}`}.mp4`;
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

function conversionNotice(meta) {
  if (!meta?.fastConversion) return '';
  if (meta.hardwareFallbackReason === 'unavailable') return '显卡加速不可用，已回退CPU转换';
  if (meta.hardwareFallbackReason) return '显卡加速失败，已回退CPU转换';
  return meta.encoder && meta.encoder !== 'libx264' ? '正在使用显卡加速转换' : '';
}

/** 探测自动兼容路径的编码器；新增显卡编码仅由高性能选项启用。 */
async function pickH264Encoder(ffmpegPath, task) {
  if (compatEncoder) return compatEncoder;
  const { execFile } = require('child_process');

  const list = await new Promise((resolve) => {
    const child = execFile(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 20000, env: localMediaEnv() }, (err, stdout) => {
      if (task?.child === child) delete task.child;
      resolve(String(stdout || ''));
    });
    if (task) task.child = child;
  });
  if (task?.cancelled) throw new Error('已取消');

  const candidates = (process.platform === 'darwin'
    ? ['h264_videotoolbox', 'libx264']
    : ['libx264']).filter((e) =>
    list.includes(e)
  );
  if (!candidates.includes('libx264')) candidates.push('libx264'); // 软件兜底

  const works = (enc) =>
    new Promise((resolve) => {
      const child = execFile(
        ffmpegPath,
        ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
         '-frames:v', '1', '-c:v', enc, '-f', 'null', '-'],
        { timeout: 25000, env: localMediaEnv() },
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
    if (!(filePath && fs.existsSync(filePath)) && (/^(xifan|hema|reelshort|dramabox|custom):/.test(String(seriesId)) || /^(xifan|hema|reelshort|dramabox|custom):/.test(String(payload.vid)))) {
      const current = await hongguo.fetchEpisodeList(seriesId);
      checkCancelled();
      const episode = current.episodes.find(ep => Number(ep.vid_index) === Number(vidIndex));
      if (!episode || (payload.vid && payload.vid !== episode.vid)) return { success: false, error: '分集来源不匹配' };
      if (episode.locked) return { success: false, error: '该集已锁定，请在来源平台解锁' };
    }

    if (!force && fs.existsSync(out) && fs.statSync(out).size > 1024 * 100) {
      // 命中缓存
      try { fs.utimesSync(out, new Date(), new Date()); } catch (_) {}
      return { success: true, url: localPlayUrl(out, () => isRegularFile(out)), size: fs.statSync(out).size, cached: true };
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
        const playInfo = /^(custom|reelshort|dramabox):/.test(String(vid)) ? await hongguo.fetchPlayUrlSingle(String(vid),seriesId,{force:!!force,quality}) : null;
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
    const fastConversion = !force && getCurrentSettings().fast_conversion;
    let hardwareFallbackReason = null;
    let encoder;
    if (fastConversion) {
      encoder = (await hardwareEncoding.pickHardwareEncoder({ executable: ffmpegPath,
        inputArgs: ['-i', inputPath], signal }))?.encoder || 'libx264';
      if (encoder === 'libx264') hardwareFallbackReason = 'unavailable';
    } else encoder = force ? 'libx264' : await pickH264Encoder(ffmpegPath, job);
    checkCancelled();

    const started = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      checkCancelled();
      const notice = conversionNotice({ fastConversion, encoder, hardwareFallbackReason });
      if (notice) reportProgress({ seriesId: String(seriesId), vidIndex: Number(vidIndex), percent: 0, notice });
      // 2) 转码（硬件编码器用各自推荐的参数）
      const encArgs = fastConversion && encoder !== 'libx264'
        ? hardwareEncoding.hardwareEncoderArgs(encoder)
        : encoder === 'libx264'
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
        const child = spawn(ffmpegPath, args, { windowsHide: true, env: localMediaEnv() });
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
              reportProgress({ seriesId: String(seriesId), vidIndex: Number(vidIndex), percent: pct, ...(notice ? {notice} : {}) });
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
          if (fastConversion && /No space left|Permission denied|Input\/output error|Disk quota|Read-only file system|File too large|Cannot allocate memory|Out of memory|Invalid data found|Error while decoding|Error submitting packet|corrupt|decryption/i.test(stderrTail)) {
            return { success: false, error: '视频输入或存储不可用，转换已停止，原视频已保留' };
          }
          hardwareFallbackReason = 'encoder-failed';
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
    return { success: true, url: localPlayUrl(out, () => isRegularFile(out)), size, elapsed: Number(elapsed), encoder,
      fastConversion, hardwareFallbackReason };
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
async function enqueueEpisodes({ seriesId, seriesTitle, episodes, cover, quality, nasDestination }) {
  if (!Array.isArray(episodes) || episodes.length === 0) return 0;
  const settings = getCurrentSettings();
  const downloadQuality = normalizeDownloadQuality(quality ?? settings.download_quality);
  if (/^(xifan|hema|reelshort|dramabox|custom):/.test(String(seriesId))) {
    const current = await hongguo.fetchEpisodeList(seriesId);
    episodes = episodes.map(requested => {
      const ep = current.episodes.find(item => item.vid === requested.vid && Number(item.vid_index) === Number(requested.vid_index));
      if (!ep) throw new Error('分集不属于所选来源，请重新打开剧集');
      if (ep.locked) throw new Error('该集已锁定，请在来源平台解锁');
      return ep;
    });
  } else if (episodes.some(ep => /^(xifan|hema|reelshort|dramabox|custom):/.test(String(ep.vid)))) {
    throw new Error('剧集来源不匹配');
  }

  // Validate duplicate quality before changing the queue or files. Never replace a user's file.
  const nasReady = new Set();
  for (const ep of episodes) {
    const dup = downloadTasks.find(t => String(t.hongguoInfo?.vid) === String(ep.vid));
    if (dup && ['pending', 'downloading'].includes(dup.status) && normalizeDownloadQuality(dup.downloadQuality) !== downloadQuality) {
      throw new Error('同一集已有其他清晰度的下载任务，请先停止该任务再重新选择');
    }
    if (dup?.status === 'completed' && hasCompleteTaskFile(dup)) {
      dup.actualQuality = await verifyDownloadQuality(dup.savePath, downloadQuality, true);
    }
    if (nasDestination) {
      const finalPath = path.join(nasDestination.directory, nasEpisodeFilename(nasDestination, ep));
      if (dup && (dup.status === 'downloading' || runningDownloads.has(dup.id)) && dup.savePath !== finalPath)
        throw new Error('该剧正在下载到其他位置，请先暂停下载，再选择新的保存文件夹');
      if (downloadTasks.some(task => task !== dup && task.savePath === finalPath && String(task.hongguoInfo?.vid) !== String(ep.vid)))
        throw new Error('所选目录的视频路径与其他分集冲突，未覆盖已有文件');
      const target = await inspectNasEpisode(nasDestination, ep);
      if (target.status === 'existing') {
        await verifyDownloadQuality(target.path, downloadQuality, true);
        nasReady.add(String(ep.vid));
      } else if (dup?.status === 'completed' && hasCompleteTaskFile(dup)) {
        await copyNasEpisode(dup, nasDestination);
        nasReady.add(String(ep.vid));
      } else if (target.status === 'conflict') throw new Error('所选目录已有无法确认的同名视频，未覆盖，请检查后重试');
    }
  }
  // No await follows this check until queue persistence, so active runs cannot be retargeted midway.
  if (nasDestination && episodes.some(ep => downloadTasks.some(task => String(task.hongguoInfo?.vid) === String(ep.vid) &&
      (task.status === 'downloading' || runningDownloads.has(task.id)) && task.savePath !== path.join(nasDestination.directory, nasEpisodeFilename(nasDestination, ep)))))
    throw new Error('该剧正在下载到其他位置，请先暂停下载，再选择新的保存文件夹');
  const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : app.getPath('downloads');
  const cleanSeriesTitle = sanitizeFolderName(seriesTitle) || '红果短剧';
  const downloadDir = nasDestination ? nasDestination.directory : seriesDownloadDir(root, seriesId, cleanSeriesTitle);
  if (!nasDestination) fs.mkdirSync(downloadDir, { recursive: true });
  const directoryIdentity = nasDestination ? null : readDirectoryIdentity(downloadDir);
  let metadataWarning = '';
  if (!nasDestination && settings.download_metadata === true) {
    try {
      const entry = seriesRegistry.find(item => String(item.series_id) === String(seriesId));
      const result = await prepareNasExport({ root: downloadDir, folderName: cleanSeriesTitle,
        series: entry || { series_id: seriesId, series_title: seriesTitle, cover: cover || episodes[0]?.cover || '' } });
      metadataWarning = result.warnings.join('；');
    } catch (_) { metadataWarning = '整剧封面或简介未能保存，视频下载不受影响；检查目录后可重新提交补齐'; }
  }

  if (directoryIdentity) validateDirectoryIdentity(directoryIdentity, path.join(downloadDir, 'directory-check'));
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
    const filename = nasDestination ? nasEpisodeFilename(nasDestination, ep) : uniqueEpisodeFilename(settings, cleanSeriesTitle, ep);
    const finalPath = path.join(downloadDir, filename);

    // 已有同一集在队列/已完成，避免重复建任务
    const dup = downloadTasks.find(
      (t) => t.hongguoInfo && String(t.hongguoInfo.vid) === String(ep.vid)
    );
    if (dup) {
      changedTasks.push({ task: dup, previous: { ...dup } });
      if (!nasDestination) dup.metadataWarning = metadataWarning;
      if (!nasDestination && !dup.nasDestination && !dup.directoryIdentity && typeof dup.savePath === 'string' && fs.existsSync(path.dirname(dup.savePath)))
        dup.directoryIdentity = readDirectoryIdentity(path.dirname(dup.savePath));
      if (nasDestination) {
        Object.assign(dup, { savePath: finalPath, customDir: downloadDir, filename, nasDestination, downloadQuality, nasWarning: '', pathConflict: false });
        delete dup.nasTargets;
        if (nasReady.has(String(ep.vid)) && dup.status !== 'downloading' && !runningDownloads.has(dup.id)) {
          Object.assign(dup, { status: 'completed', progress: 100, endTime: Date.now(), fileIdentity: readFileIdentity(finalPath) });
          delete dup.error;
          downloadQueue = downloadQueue.filter(task => task !== dup);
        }
      }
      // 已停止或失败的重新入队
      if (dup.status === 'stopped' || dup.status === 'failed' || (dup.status === 'completed' && !hasCompleteTaskFile(dup))) {
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
      ...(metadataWarning ? { metadataWarning } : {}),
      ...(nasDestination ? { nasDestination } : {}),
      ...(directoryIdentity ? { directoryIdentity } : {}),
      status: nasReady.has(String(ep.vid)) ? 'completed' : 'pending',
      progress: nasReady.has(String(ep.vid)) ? 100 : 0,
      ...(nasReady.has(String(ep.vid)) ? { endTime: Date.now(), fileIdentity: readFileIdentity(finalPath) } : {}),
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
    if (task.status === 'pending') downloadQueue.push(task);
    sendToRenderer('download-task-added', task);
    if (task.status === 'pending') created++;
  }

  try { saveDownloadTasks(); }
  catch (error) {
    // An unpersisted submission must not start later through another queue action.
    downloadTasks = downloadTasks.filter(task => task.batchId !== batchId);
    restoreQueueTasks({ snapshots: changedTasks, previousQueue });
    throw error;
  }
  pumpQueue();
  return created;
}

const followingSubmissions = new Set();
ipcMain.handle('download-following-episodes', async (_event, seriesId, vidIndex, quality) => {
  const sid = String(seriesId || '');
  if (followingSubmissions.has(sid)) return { success: false, error: '本剧正在提交下载，请稍候' };
  if (!Number.isSafeInteger(vidIndex) || vidIndex < 1) return { success: false, error: '起始集数无效' };
  const entry = seriesRegistry.find(item => String(item.series_id) === sid);
  if (!entry?.episodes?.some(ep => ep.vid_index === vidIndex)) return { success: false, error: '未找到起始分集，请重新打开剧集' };
  followingSubmissions.add(sid);
  try {
    const episodes = entry.episodes.filter(ep => ep.vid_index >= vidIndex && !ep.locked && !downloadTasks.some(task =>
      String(task.hongguoInfo?.series_id) === sid && String(task.hongguoInfo?.vid) === String(ep.vid)
      && (['pending', 'downloading'].includes(task.status) || task.status === 'completed' && hasCompleteTaskFile(task))));
    const count = episodes.length ? await enqueueEpisodes({ seriesId: sid, seriesTitle: entry.series_title, episodes, quality }) : 0;
    return { success: true, count };
  } catch (error) { return { success: false, error: error.message || '提交后续剧集失败' }; }
  finally { followingSubmissions.delete(sid); }
});

const nasSubmissions = new Set();
ipcMain.handle('download-series-to-nas', async (_event, seriesId, quality, options = {}) => {
  const sid = String(seriesId || '');
  if (nasSubmissions.has(sid)) return { success: false, error: '本剧正在整理到 NAS，请等待本次提交完成' };
  nasSubmissions.add(sid);
  try {
    const entry = seriesRegistry.find(item => String(item.series_id) === sid);
    if (!entry?.episodes?.length) return { success: false, error: '未找到该剧档案，请先打开剧集' };
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: options.createFolder === true ? '选择 NAS 保存位置，将自动创建剧名文件夹' : '选择已挂载的 NAS 共享文件夹',
      buttonLabel: '保存到此目录', properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths?.[0]) return { success: false, canceled: true };
    const folderName = `${sanitizeFolderName(entry.series_title) || '未命名短剧'}-${createHash('sha256').update(sid).digest('hex').slice(0, 12)}`;
    const { destination, warnings } = await prepareNasExport({ root: selection.filePaths[0], folderName, series: entry,
      createFolder: options.createFolder === true });
    const wanted = entry.episodes.filter(episode => !episode.locked);
    const locked = entry.episodes.length - wanted.length;
    if (locked) warnings.push(`${locked} 集已锁定，需在来源平台解锁后再下载`);
    const count = await enqueueEpisodes({ seriesId: sid, seriesTitle: entry.series_title, episodes: wanted,
      cover: entry.cover, quality, nasDestination: destination });
    const copied = wanted.filter(episode => downloadTasks.some(task => String(task.hongguoInfo?.series_id) === sid &&
      String(task.hongguoInfo?.vid) === String(episode.vid) && task.nasDestination?.directory === destination.directory &&
      task.status === 'completed' && hasCompleteTaskFile(task))).length;
    return { success: true, count, copied, warnings, directory: destination.directory };
  } catch (error) { return { success: false, error: error.message || 'NAS 下载提交失败，请检查共享目录后重试' }; }
  finally { nasSubmissions.delete(sid); }
});

ipcMain.handle('hongguo-download-batch', async (event, payload) => {
  try {
    const { seriesId, seriesTitle, episodes, quality, export: exportKinds } = payload || {};
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return { success: false, error: '未选择集数' };
    }
    const count = await enqueueEpisodes({ seriesId, seriesTitle, episodes, quality });
    const kinds = normalizeTextExportKinds(exportKinds);
    const exportRequested = /^\d{6,30}$/.test(String(seriesId)) && Object.values(kinds).some(Boolean);
    const requestId = typeof payload.requestId === 'string' && payload.requestId.length <= 128 && payload.requestId
      ? payload.requestId : randomUUID();
    if (exportRequested) {
      Promise.resolve().then(() => {
        // Reuse persisted task destinations, including old settings and repaired filename conflicts.
        const destinations = episodes.map(ep => {
          const task = downloadTasks.find(item => String(item.hongguoInfo?.series_id) === String(seriesId)
            && String(item.hongguoInfo?.vid) === String(ep.vid));
          if (!task?.savePath) throw new Error('找不到分集下载路径，请重新提交');
          return { id: task.id, vid: String(task.hongguoInfo.vid), vid_index: task.hongguoInfo.vid_index, savePath: task.savePath,
            nasDestination: task.nasDestination, nasTargets: task.nasTargets, directoryIdentity: task.directoryIdentity };
        });
        const exportSnapshots = new Map();
        for (const item of destinations) {
          const parent = path.dirname(item.savePath);
          let identity = null;
          if (!item.nasDestination) {
            try { identity = item.directoryIdentity || readDirectoryIdentity(parent); } catch (_) {}
          }
          const snaps = exportSnapshots.get(parent) || [];
          snaps.push({ id: item.id, savePath: item.savePath, nasDestination: item.nasDestination,
            nasTargets: item.nasTargets, directoryIdentity: item.directoryIdentity, parentIdentity: identity });
          exportSnapshots.set(parent, snaps);
        }
        const check = target => {
          const parent = path.dirname(target);
          const snaps = exportSnapshots.get(parent);
          if (!snaps?.length) throw new Error('导出文件所在目录已变化，未写入');
          for (const snap of snaps) {
            const current = downloadTasks.find(task => task.id === snap.id);
            if (!current) throw new Error('导出对应下载任务已删除，未写入');
            if (current.savePath !== snap.savePath) throw new Error('下载任务已迁移，未写入');
            if (current.nasDestination !== snap.nasDestination || current.nasTargets !== snap.nasTargets
              || current.directoryIdentity !== snap.directoryIdentity) throw new Error('下载任务保存位置已变化，未写入');
          }
          const snap = snaps[0];
          if (snap.nasDestination) {
            if (!nasDestinationCurrent(snap.nasDestination, target)) throw new Error('NAS 目录不可用或挂载已变化，未写入');
          } else if (snap.parentIdentity) {
            validateDirectoryIdentity(snap.parentIdentity, path.join(parent, 'directory-check'));
          } else {
            throw new Error('导出目录身份缺失，未写入');
          }
        };
        const title = sanitizeFolderName(seriesTitle) || '红果短剧';
        return exportSeriesText({ seriesId: String(seriesId), seriesTitle, episodes: destinations, kinds,
          reviewsPath: path.join(path.dirname(destinations[0].savePath), `${title}.reviews.json`), check });
      }).then(result => sendToRenderer('text-export-done', { ...result, requestId, seriesId, kinds }))
        .catch(error => sendToRenderer('text-export-done', {
          requestId, seriesId, kinds, failed: true, error: String(error?.message || error),
        }));
    }
    return { success: true, count, requested: episodes.length, exportRequested, requestId };
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
const historyService = createHistoryService({
  ipcMain,
  watchHistory,
  seriesSearch,
  store,
  hongguo,
  Notification,
  getSettings: getCurrentSettings,
  getSeriesRegistry: () => seriesRegistry,
  upsertSeriesRegistry,
  saveSeriesRegistry,
  searchAtSource,
  send: (...args) => sendToRenderer(...args),
  safeErrorText,
  onNotificationClick: () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    sendToRenderer('navigate', { page: 'history' });
  },
});
const historySequelCache = historyService.sequelCache;

function historyRows() {
  return historyService.rows();
}

function refreshWatchHistory(forceOrOptions = false) {
  return historyService.refresh(forceOrOptions);
}

accountController = createAccountController({
  ipcMain,
  app,
  session,
  safeStorage,
  BrowserWindow,
  createAccountService,
  safeMessage: accountSafeMessage,
  hongguo,
  getSeriesRegistry: () => seriesRegistry,
  upsertSeriesRegistry,
  saveSeriesRegistry,
  navigateToPlayer,
  send: (...args) => sendToRenderer(...args),
  applyProxyToSession: ses => applyProxyToSession(proxyManager.desired || resolveProxyConfig(getCurrentSettings()), [ses]),
});

// ===== IPC：设置 =====
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

const SETTINGS_KEYS = ['root', 'name_format', 'max_concurrent', 'download_quality', 'download_metadata', 'export_text', 'auto_delete_watched', 'compat_mode', 'fast_conversion', 'cache_next_episode', 'picture_in_picture_mode', 'stealth_wake_region', 'show_danmaku_controls', 'app_updates_enabled', 'watch_updates_enabled', 'watch_sequels_enabled', 'watch_notifications_enabled', 'search_app_enabled', 'proxy_enabled', 'proxy_mode', 'proxy_host', 'proxy_port', 'proxy_username', 'proxy_password'];

function normalizeTextExportKinds(value) {
  return { danmaku: value?.danmaku === true, comments: value?.comments === true, reviews: value?.reviews === true };
}

function settingsForRenderer(settings) {
  const copy = { ...settings };
  copy.proxy_password_set = copy.proxy_password_set === true || !!copy.proxy_password;
  delete copy.proxy_password;
  return copy;
}

function applyEditableSettings(current, incoming) {
  const source = normalizeProxySettings(incoming && typeof incoming === 'object' ? incoming : {});
  if (Object.prototype.hasOwnProperty.call(source, 'fast_conversion') && typeof source.fast_conversion !== 'boolean') throw new Error('显卡加速设置必须为开关值');
  if (Object.prototype.hasOwnProperty.call(source, 'picture_in_picture_mode')
    && !['native', 'custom'].includes(source.picture_in_picture_mode)) throw new Error('不支持的画中画小窗模式');
  const merged = { ...current };
  for (const key of SETTINGS_KEYS) {
    if (key === 'proxy_password') continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) merged[key] = source[key];
  }
  if (Object.prototype.hasOwnProperty.call(source, 'stealth_wake_region')) merged.stealth_wake_region = validateStealthWakeRegion(source.stealth_wake_region);
  if (Object.prototype.hasOwnProperty.call(source, 'export_text')) merged.export_text = normalizeTextExportKinds(source.export_text);
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
    try { store.saveSettings(latest, { clearProxyPassword: settings?.clear_proxy_password === true && !String(settings?.proxy_password || '') }); }
    catch (error) {
      try { await applyProxyWithTimeout(current, 5000); } catch (_) { /* 旧配置也可能已不可用 */ }
      throw error;
    }
    invalidateSeriesProgress();
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
  let proxyOption;
  try { proxyOption = proxyConfig.requestOption(resolved); }
  catch { return { success: false, error: '代理地址格式无效' }; }

  const started = Date.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await axios.get(PROXY_TEST_URL, {
      timeout: 12000,
      signal: controller.signal,
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
        message: `红果官网连接正常（HTTP ${res.status}，耗时 ${ms}ms）`,
      };
    }
    return { success: false, error: `请求返回 HTTP ${res.status}（耗时 ${ms}ms）` };
  } catch (error) {
    const ms = Date.now() - started;
    const code = (error && error.code) || '';
    let hint = publicProxyError(error.message, settings, resolved);
    if (['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) hint = `测试站点证书校验失败，连接已拒绝；请检查系统时间、证书链或代理的 HTTPS 配置（${code}）`;
    else if (code === 'ECONNREFUSED') hint = '代理端口拒绝连接，请确认代理软件已启动、端口填写正确';
    else if (controller.signal.aborted || code === 'ETIMEDOUT' || code === 'ECONNABORTED') hint = '连接超时，请检查代理地址/端口或代理是否可用';
    else if (code === 'ENOTFOUND') hint = '无法解析代理地址，请检查主机名';
    else if (/407/.test(hint)) hint = '代理需要认证，请填写用户名与密码';
    return { success: false, error: `${hint}（耗时 ${ms}ms）`, code };
  } finally {
    clearTimeout(deadline);
  }
});

// ===== IPC：下载管理 =====
async function currentDownloadTaskView(verifyFiles = false) {
  const options = {
    xifanTitleConflict: info => episodeDisplayTitle(info.series_id, info.series_title, info.ep_title) !== info.ep_title,
  };
  if (!verifyFiles) {
    return downloadTaskView(downloadTasks, {
      ...options,
      // Path conflicts are cheap and safe to detect here; full file identity checks run in the explicit verification pass.
      hasCompleteFile: (task, conflicts) => !conflicts.get(task.savePath)?.has(task),
    });
  }
  const conflicts = pathConflicts(downloadTasks);
  const checks = new Map();
  for (const task of downloadTasks) {
    if (task.status !== 'completed') continue;
    await new Promise(resolve => setTimeout(resolve, 0));
    checks.set(task, !conflicts.get(task.savePath)?.has(task) && hasCompleteTaskFile(task, conflicts));
  }
  return downloadTaskView(downloadTasks, { ...options, hasCompleteFile: task => checks.get(task) === true });
}

ipcMain.handle('get-download-tasks', (_event, options = {}) => currentDownloadTaskView(options?.verifyFiles !== false));


// ===== 文件清理（删除已下载的本地文件）=====

/** 单任务与单集共用：文件及其临时产物必须归目标记录独占。 */
async function validateNasDeletion(tasks, paths = []) {
  const expected = tasks.map(task => ({ task, savePath: task.savePath, destination: task.nasDestination, directoryIdentity: task.directoryIdentity }));
  const directories = [...new Map([...paths, ...tasks.map(task => task.savePath)].filter(Boolean)
    .map(file => [path.dirname(file), file])).values()].map(file => {
    let identity = null;
    try {
      const stat = fs.lstatSync(path.dirname(file));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('下载目录不可用或挂载已变化，已保留文件和任务记录');
      identity = readDirectoryIdentity(path.dirname(file));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { file, identity };
  });
  const roots = [...new Map(expected.filter(item => item.destination).map(({ destination }) =>
    [destination.root, { directory:destination.root, device:destination.device }])).values()];
  for (const { savePath, destination, directoryIdentity } of expected) {
    if (!destination && directoryIdentity) validateDirectoryIdentity(directoryIdentity, savePath);
    if (!destination) continue;
    const stat = await fsp.lstat(destination.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== destination.device) throw new Error('NAS 目录不可用或挂载已变化，已保留文件和任务记录');
    const directory = await checkNasDirectory(destination);
    if (!pathInside(directory, savePath)) throw new Error('NAS 文件已不在登记目录中，已保留文件和任务记录');
  }
  return () => {
    if (expected.some(({ task, savePath, destination, directoryIdentity }) => !downloadTasks.includes(task)
      || task.savePath !== savePath || task.nasDestination !== destination || task.directoryIdentity !== directoryIdentity)) {
      throw new Error('任务保存位置已变化，已保留文件和记录，请重试');
    }
    for (const { file, identity } of directories) {
      if (identity) validateDirectoryIdentity(identity, file);
      else if (fs.existsSync(path.dirname(file))) throw new Error('下载目录不可用或挂载已变化，已保留文件和任务记录');
    }
    for (const { directory, device } of roots) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device || fs.realpathSync(directory) !== directory)
        throw new Error('NAS 目录不可用或挂载已变化，已保留文件和任务记录');
    }
  };
}

async function removeEpisodeFiles(paths, owners, validateBeforeDelete) {
  let freed = 0, failed = 0, count = 0, warning, checkCurrent;
  try { checkCurrent = await validateNasDeletion(owners, paths); checkCurrent(); }
  catch (error) { return { count, freed, failed, warning: error.message }; }
  const temporary = await cleanupTaskTemporaries(owners);
  count += temporary.count; freed += temporary.freed; failed += temporary.failed; warning = temporary.warning;
  try { checkCurrent(); }
  catch (error) { return { count, freed, failed, warning:error.message }; }
  for (const file of new Set(paths.filter(Boolean))) {
    const baseFile = file.replace(/\.enc\.tmp(?:\.decoded)?$/, '');
    const family = episodeFilePaths(baseFile);
    if (!ownsEpisodeFiles(file, owners) || family.some(isFileInUse)
      || owners.some(task => mergeTasks.some(merge => String(merge.seriesId) === String(task.hongguoInfo?.series_id) && merge.status === 'running'))) {
      warning = '文件正在使用或登记给其他任务／合并产物，已保留文件和任务记录';
      continue;
    }
    if (!ownsRecordedMediaFile(baseFile)) {
      warning = `文件缺少可验证的下载身份（${path.basename(baseFile)}），已保留文件和任务记录`;
      continue;
    }
    for (const p of family) {
      try { checkCurrent(); }
      catch (error) { return { count, freed, failed, warning:error.message }; }
      if (typeof validateBeforeDelete === 'function') {
        try { validateBeforeDelete(); }
        catch (error) { return { count, freed, failed, warning:error.message }; }
      }
      try {
        const result = quarantineAndRemove(p);
        count += result.count; freed += result.freed; failed += result.failed;
        if (result.warning) warning = result.warning;
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
  return castFileRefs.has(file) || localFileReaders.has(file) || runningDownloadPaths.has(file) || downloadTasks.some(task => task.savePath === file && isTaskInFlight(task));
}

function removeFinishedRecords(seriesId, saveChanges = false) {
  const ids = downloadTasks.filter(task => (seriesId == null || String(task.hongguoInfo?.series_id) === String(seriesId)) && !isTaskInFlight(task) && !hasPendingTemporaries(task)
    && (task.status === 'completed' || Array.isArray(task.temporaryDownloads) && task.temporaryDownloads.length === 0)
    && task.savePath && episodeFilePaths(task.savePath).every(file => !fs.existsSync(file))).map(task => task.id);
  if (ids.length || saveChanges) dropTaskRecords(ids);
}

/** 删掉一组任务记录（从内存与队列中移除） */
function dropTaskRecords(ids, keepFiles = false) {
  const set = new Set(ids.filter(id => !downloadTasks.some(task => task.id === id && (isTaskInFlight(task) || !keepFiles && hasPendingTemporaries(task)))));
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
        const result = await removeEpisodeFiles([task.savePath], [task]);
        freed += result.freed; fileCount += result.count; failed += result.failed;
        if (result.warning) { warnings.push(result.warning); errors.push(result.warning); }
        if (result.failed) { errors.push('部分文件删除失败，对应任务记录已保留'); continue; }
        if (result.warning) continue;
      }
      removed.push(id);
    } catch (error) { errors.push(error.message); }
  }
  try { if (removed.length || cancelledRetries) count = dropTaskRecords(removed, !deleteFiles); }
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
async function deleteSeriesFiles(seriesId, options) {
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
    const checkCurrent = await validateNasDeletion(downloadTasks.filter(task => String(task.hongguoInfo?.series_id) === sid), paths);
    checkCurrent();
    const cancelledRetries = cancelScheduledRetries(downloadTasks.filter(task => String(task.hongguoInfo?.series_id) === sid));
    let count = 0, freed = 0, failed = files.scanFailed, fileWarning = '';
    const temporary = await cleanupTaskTemporaries(downloadTasks.filter(task => String(task.hongguoInfo?.series_id) === sid), dir);
    count += temporary.count; freed += temporary.freed; failed += temporary.failed;
    if (mergeTasks.some(task => String(task.seriesId) === sid && task.status === 'running'))
      return { success:false, count, freed, failed, error:'该剧正在合并，请完成或取消合并后再清理' };
    try { checkCurrent(); }
    catch (error) { return { success:false, count, freed, failed, error:error.message }; }
    const deletablePaths = [...paths].filter(file => {
      const baseFile = file.replace(/\.enc\.tmp(?:\.decoded)?$/, '');
      return ownsRecordedMediaFile(baseFile);
    });
    const unowned = [...paths].filter(file => {
      const baseFile = file.replace(/\.enc\.tmp(?:\.decoded)?$/, '');
      return episodeFileFamilyExists(baseFile) && !ownsRecordedMediaFile(baseFile);
    });
    for (const file of deletablePaths) {
      if (isFileInUse(file)) continue;
      try { checkCurrent(); }
      catch (error) { return { success:false, count, freed, failed, error:error.message }; }
      try {
        const result = quarantineAndRemove(file);
        count += result.count; freed += result.freed; failed += result.failed;
        if (result.warning) fileWarning = result.warning;
      } catch (_) { failed++; }
    }
    // 只移除本剧空目录；未知文件与仍在下载的临时文件会使目录保留。
    try { checkCurrent(); if (dir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_) {}
    try { removeFinishedRecords(sid, cancelledRetries); }
    catch (error) { return { success: false, count, freed, failed, error: `文件清理已执行；任务记录保存失败，原记录已保留：${error.message}${cancelledRetries ? '；自动重试取消状态未保存' : ''}` }; }
    const warning = [temporary.warning, fileWarning, unowned.length ? '部分文件缺少可验证的下载身份，已保留文件和任务记录' : '']
      .filter(Boolean).join('；') || undefined;
    return { success: failed === 0 && !warning, count, freed, failed, warning,
      error: warning || (failed ? '部分文件删除失败，对应记录已保留' : undefined) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

ipcMain.handle('delete-series-files', (_event, seriesId, options) => deleteSeriesFiles(seriesId, options));

/** 删除单集本地文件（看完即删用） */
async function deleteEpisodeFile(seriesId, vidIndex, validateBeforeDelete) {
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
    const ownedPaths = paths.filter(file => {
      const baseFile = file.replace(/\.enc\.tmp(?:\.decoded)?$/, '');
      return ownsRecordedMediaFile(baseFile) || episodeFileFamilyExists(baseFile);
    });
    const cancelledRetries = cancelScheduledRetries(tasks);
    const result = await removeEpisodeFiles(ownedPaths, tasks, validateBeforeDelete);
    if (result.warning || result.failed) {
      try { if (cancelledRetries) dropTaskRecords([]); }
      catch (error) { return { ...result, success: false, error: `任务记录保存失败，原记录已保留：${error.message}${cancelledRetries ? '；自动重试取消状态未保存' : ''}` }; }
      return { ...result, success: false,
        error: [result.warning, result.failed ? '文件删除失败，任务记录已保留' : ''].filter(Boolean).join('；') || undefined };
    }
    const ids = tasks.filter(task => task.savePath && ownsEpisodeFiles(task.savePath, tasks)
      && !hasPendingTemporaries(task) && episodeFilePaths(task.savePath).every(file => !fs.existsSync(file))).map(task => task.id);
    try { if (ids.length || cancelledRetries) dropTaskRecords(ids); }
    catch (error) { return { ...result, success: false, error: `文件清理已执行；任务记录保存失败，原记录已保留：${error.message}${cancelledRetries ? '；自动重试取消状态未保存' : ''}` }; }
    return { ...result, success: true, error: undefined };
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
    if (downloadTasks.some(task => String(task.hongguoInfo?.series_id) === sid && Number(task.hongguoInfo?.vid_index) === idx && task.nasDestination))
      return { success: true, count: 0, freed: 0, skipped: true };
    if (downloadTasks.some(task => String(task.hongguoInfo?.series_id) === sid && Number(task.hongguoInfo?.vid_index) === idx && task.nasWarning))
      return { success: false, error: '本集尚未完成 NAS 整理，本地视频已保留；请再次点击「下载到 NAS」重试' };
    if (getCurrentSettings().auto_delete_watched !== true)
      return { success: true, count: 0, freed: 0, skipped: true };
    const matches = entry => entry && String(entry.seriesId) === sid && Number(entry.vidIndex) === idx;
    const compatFiles = ['auto', '720p', '1080p'].map(quality => compatPathFor(sid, idx, quality));
    if ([...onlineSessions.values()].some(session => matches(session.entry || session)) || compatFiles.some(file => compatPreparing.has(file))) {
      return { success: false, error: '该集仍在播放或准备，稍后再清理' };
    }
    const autoDeleteCheck = () => {
      if (getCurrentSettings().auto_delete_watched !== true) throw new Error('自动删除已关闭，本集文件已保留');
    };
    const result = await deleteEpisodeFile(sid, idx, autoDeleteCheck);
    if (!result.success) return result;
    try { autoDeleteCheck(); } catch (_) { return result; }
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
    let unverifiedItems = 0, unverifiedBytes = 0;
    const seenTemporaries = new Set();
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
      if (!merging) for (const { task, record } of owned.downloadTemporaries) {
        if (isTaskInFlight(task)) continue;
        const key = record?.directory || record;
        if (key && seenTemporaries.has(key)) continue;
        if (key) seenTemporaries.add(key);
        const state = taskTemporaryState(task, record);
        bytes += state.files.reduce((sum, file) => sum + file.size, 0); files += state.files.length;
        unverifiedItems += state.unverifiedItems;
        unverifiedBytes = state.unverifiedBytes === null || unverifiedBytes === null ? null : unverifiedBytes + state.unverifiedBytes;
      }
      for (const directory of new Set([owned.dir, ...downloadTasks.filter(task => String(task.hongguoInfo?.series_id) === target.series_id)
        .map(task => task.savePath && path.dirname(task.savePath))].filter(Boolean))) {
        for (const file of untrackedTemporaryDirectories(directory)) if (!seenTemporaries.has(file)) {
          seenTemporaries.add(file); unverifiedItems++; unverifiedBytes = null;
        }
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
    const warning = temporaryWarning(unverifiedItems);
    if (warning) sendToRenderer('storage-error', { error:warning });
    return { success: true, totalBytes, totalFiles, series, unverifiedItems, unverifiedBytes, warning };
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
      const result = await deleteSeriesFiles(sid);
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

  const snapshot = snapshotQueueTasks([task]);
  task.cancelled = true;
  delete task.retryAt; delete task.sourceRetries; delete task.sourceRetryLimit;
  task.status = 'stopped';
  task.error = '';
  task.endTime = Date.now();
  downloadQueue = downloadQueue.filter(item => item.id !== task.id);
  try { saveDownloadTasks(); }
  catch (error) { restoreQueueTasks(snapshot); throw error; }
  clearSourceRetry(task);
  if (task.cancelSource) { try { task.cancelSource.cancel('用户停止下载'); } catch (_) {} }
  if (task.writer) { try { task.writer.destroy(); } catch (_) {} }
  delete task.cancelSource;
  delete task.writer;
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

  const nasDestination = task.nasDestination || task.nasTargets?.at(-1);
  const nasDirectory = nasDestination?.directory;
  if (nasDirectory) {
    if (!fs.existsSync(nasDirectory)) return { success: false, error: 'NAS 保存目录不可用，请重新挂载后再打开' };
    try {
      const directory = await checkNasDirectory(nasDestination);
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    } catch (_) { return { success: false, error: 'NAS 保存目录不可用，请重新挂载后再打开' }; }
    const error = await shell.openPath(nasDirectory);
    return error ? { success: false, error } : { success: true };
  }

  if (task.customDir && fs.existsSync(task.customDir)) {
    try {
      if (task.directoryIdentity) validateDirectoryIdentity(task.directoryIdentity, task.savePath || path.join(task.customDir, 'directory-check'));
      const stat = fs.lstatSync(task.customDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    } catch (_) { return { success: false, error: '下载目录不可用或挂载已变化，已保留文件和任务记录；请确认原目录后重试' }; }
    await shell.openPath(task.customDir);
    return { success: true };
  }
  if (task.savePath && fs.existsSync(task.savePath)) {
    try { if (task.directoryIdentity) validateDirectoryIdentity(task.directoryIdentity, task.savePath); }
    catch (_) { return { success: false, error: '下载目录不可用或挂载已变化，已保留文件和任务记录；请确认原目录后重试' }; }
    const stat = fs.lstatSync(task.savePath);
    if (stat.isSymbolicLink()) return { success: false, error: '路径不存在' };
    const isDir = stat.isDirectory();
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

// ===== 远程公告：固定公共 JSON，普通和紧急偏好独立于 settings =====
const appAnnouncements = createAnnouncementService({
  store,
  version: APP_VERSION,
  request: (url, options) => axios.get(url, options),
  isEnabled: () => !IS_PREVIEW && !proxyStartupFallback,
});
ipcMain.handle('check-announcements', (_event, options) => appAnnouncements.checkAnnouncements(options));
ipcMain.handle('get-current-announcement', () => appAnnouncements.getCurrentAnnouncement());
ipcMain.handle('acknowledge-announcement', (_event, payload) => appAnnouncements.acknowledgeAnnouncement(payload));
ipcMain.handle('dismiss-announcement', (_event, payload) => appAnnouncements.dismissAnnouncement(payload));
ipcMain.handle('get-announcement-preferences', () => appAnnouncements.getAnnouncementPreferences());
ipcMain.handle('set-announcement-preferences', (_event, patch) => {
  const result = appAnnouncements.setAnnouncementPreferences(patch);
  if (result.success) sendToRenderer('announcement-preferences-changed', result.preferences);
  return result;
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
      if (matchesProxyAuth(authInfo)) callback(proxyManager.activeAuth.username, proxyManager.activeAuth.password);
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
      await applyProxyToSession(proxyManager.desired || resolveProxyConfig(getCurrentSettings()), [appUpdater.netSession]);
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

function applyInterfaceLanguage(language) {
  const label = (zh, en) => language === 'en' ? en : zh;
  const appName = label(APP_TITLE, IS_PREVIEW ? 'Hongguo Drama Preview' : 'Hongguo Drama');
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle?.(appName);
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: appName, submenu: [
      { role: 'about', label: label(`关于${APP_TITLE}`, `About ${appName}`) },
      { type: 'separator' },
      { role: 'services', label: label('服务', 'Services') },
      { type: 'separator' },
      { role: 'hide', label: label('隐藏', 'Hide') },
      { role: 'hideOthers', label: label('隐藏其他应用', 'Hide Others') },
      { role: 'unhide', label: label('显示全部', 'Show All') },
      { type: 'separator' },
      { role: 'quit', label: label('退出', 'Quit') },
    ] },
    { label: label('编辑', 'Edit'), submenu: [
      { role: 'undo', label: label('撤销', 'Undo') }, { role: 'redo', label: label('重做', 'Redo') },
      { type: 'separator' },
      { role: 'cut', label: label('剪切', 'Cut') }, { role: 'copy', label: label('复制', 'Copy') },
      { role: 'paste', label: label('粘贴', 'Paste') }, { role: 'selectAll', label: label('全选', 'Select All') },
    ] },
    { label: label('视图', 'View'), submenu: [
      { label: label('实际大小', 'Actual Size'), accelerator: 'CmdOrCtrl+0', click: () => changeMainWindowZoom('reset') },
      { label: label('放大', 'Zoom In'), accelerator: 'CmdOrCtrl+Plus', click: () => changeMainWindowZoom('in') },
      { label: label('缩小', 'Zoom Out'), accelerator: 'CmdOrCtrl+-', click: () => changeMainWindowZoom('out') },
      { type: 'separator' }, { role: 'togglefullscreen', label: label('全屏', 'Full Screen') },
    ] },
    { label: label('窗口', 'Window'), submenu: [
      { role: 'minimize', label: label('最小化', 'Minimize') }, { role: 'close', label: label('关闭窗口', 'Close Window') },
      { type: 'separator' },
      { label: label('回到主窗口', 'Return to Main Window'), accelerator: 'CmdOrCtrl+1', click: () => app.emit('activate') },
      { label: label('退出隐身小窗', 'Exit Mini Window'), click: () => { stealth.setEnabled(false); syncMainWindowScale(); } },
    ] },
  ]));
}

ipcMain.handle('set-interface-language', (_event, language) => {
  if (!['zh-CN', 'en'].includes(language)) return { success: false, error: 'Unsupported interface language' };
  applyInterfaceLanguage(language);
  return { success: true };
});

ipcMain.handle('get-app-info', async () => ({
  version: APP_VERSION,
  brand: APP_TITLE,
  appName: APP_TITLE,
  platform: process.platform,
  preview: IS_PREVIEW,
  dataDir: app.getPath('userData'),
  systemLocale: (await import('./src/native/ui-language.mjs')).systemLocale(
    process.env, app.getPreferredSystemLanguages?.()[0] || app.getLocale(), process.platform),
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
const stealth = createStealthController({ screen, BaseWindow, View, getWindow: () => mainWindow, getWakeRegion: () => getCurrentSettings().stealth_wake_region });
const bossKey = createBossKeyController({ globalShortcut, getWindows: () => BaseWindow.getAllWindows(), getMainWindow: () => mainWindow, store,
  dock: process.platform === 'darwin' ? app.dock : undefined });
ipcMain.handle('get-boss-key-state', () => bossKey.getState());
ipcMain.handle('set-boss-key', (_event, value) => {
  const result = settingsSaveQueue.then(() => ({ success: true, ...bossKey.set(value) }))
    .catch(error => ({ success: false, error: error.message }));
  settingsSaveQueue = result.then(() => {});
  return result;
});
app.on('will-quit', () => bossKey.dispose());
function syncMainWindowScale() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const scale = getWindowScale(getCurrentSettings().ui_zoom);
  mainWindow.webContents.setZoomFactor(scale);
}
function changeMainWindowZoom(direction) {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: '主窗口不可用' };
  try {
    saveWindowZoom(store, direction);
    syncMainWindowScale();
    const zoom = getWindowScale(getCurrentSettings().ui_zoom);
    sendToRenderer('interface-zoom-changed', zoom);
    return { success: true, zoom };
  } catch (_) {
    const error = '界面大小保存失败，请检查磁盘空间或目录权限后重试。';
    sendToRenderer('storage-error', { error });
    return { success: false, error };
  }
}
ipcMain.handle('change-window-zoom', (_event, direction) => changeMainWindowZoom(direction));
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
  const options = {
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 620,
    ...(process.platform === 'darwin' ? restoreMainWindowBounds(store, screen) : {}),
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
  };
  mainWindow = process.platform === 'darwin' ? new BaseWindow(options) : new BrowserWindow(options);
  if (process.platform === 'darwin') {
    // Own the live view so stealth can move it to a panel without recreating the player.
    const root = mainWindow.contentView;
    const view = new WebContentsView({ webPreferences: options.webPreferences });
    mainWindow.webContents = view.webContents;
    root.addChildView(view);
    const resizeView = () => {
      const { width, height } = root.getBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    root.on('bounds-changed', resizeView);
    resizeView();
  }
  const contents = mainWindow.webContents;

  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('resize', syncMainWindowScale);
  mainWindow.on('enter-full-screen', syncMainWindowScale);
  mainWindow.on('leave-full-screen', syncMainWindowScale);
  mainWindow.webContents.on('did-finish-load', syncMainWindowScale);
  mainWindow.webContents.on('zoom-changed', (_event, direction) => changeMainWindowZoom(direction));
  syncMainWindowScale();
  rendererSecurity.protectWindow(mainWindow);
  attachFloatingPlayerWindow(mainWindow, {
    BrowserWindow,
    isTrustedUrl: rendererSecurity.isTrustedUrl,
    store,
    screen,
  });
  episodePanel.attach(mainWindow);
  if (process.platform === 'darwin') rememberMainWindowBounds(mainWindow, {
    store, screen, isNormal: () => !stealth.enabled && windowLayout === 'landscape' && !layoutChanging,
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (storageError) sendToRenderer('storage-error', storageError);
  });

  // 开发模式加载 vite dev server，生产模式加载打包产物
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const page = process.platform === 'darwin' ? mainWindow.webContents : mainWindow;
  if (devUrl) {
    page.loadURL(devUrl);
  } else {
    page.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  }

  mainWindow.on('close', event => {
    if (process.platform !== 'darwin' && !quitReady) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.on('closed', () => {
    stealth.dispose();
    if (process.platform === 'darwin' && !contents.isDestroyed()) contents.destroy();
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
    store.init(dataFile, { safeStorage });
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

    bossKey.start();

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
      if (bossKey.hidden && bossKey.restore()) return;
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
      applyInterfaceLanguage(/^zh(?:[-_.@]|$)/i.test(app.getPreferredSystemLanguages?.()[0] || app.getLocale()) ? 'zh-CN' : 'en');
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
  casting.close();
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
