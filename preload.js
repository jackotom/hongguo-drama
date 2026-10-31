// 红果短剧 5.2：桌面桥接入口，发行说明见 docs/release-5.2.md。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPublicDetails: (seriesId, vid) => ipcRenderer.invoke('get-public-details', seriesId, vid),
  getEpisodeComments: options => ipcRenderer.invoke('get-episode-comments', options),
  getEpisodeDanmaku: options => ipcRenderer.invoke('get-episode-danmaku', options),
  onTextExportDone: cb => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('text-export-done', listener);
    return () => ipcRenderer.removeListener('text-export-done', listener);
  },
  setStealthMode: enabled => ipcRenderer.invoke('set-stealth-mode', enabled),
  getBossKeyState: () => ipcRenderer.invoke('get-boss-key-state'),
  setBossKey: value => ipcRenderer.invoke('set-boss-key', value),
  onBossKeyState: cb => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('boss-key-state', listener);
    return () => ipcRenderer.removeListener('boss-key-state', listener);
  },
  onStealthState: cb => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('stealth-state', listener);
    return () => ipcRenderer.removeListener('stealth-state', listener);
  },
  // 应用信息 / 官网链接
  checkAnnouncements: options => ipcRenderer.invoke('check-announcements', options),
  getCurrentAnnouncement: () => ipcRenderer.invoke('get-current-announcement'),
  acknowledgeAnnouncement: payload => ipcRenderer.invoke('acknowledge-announcement', payload),
  dismissAnnouncement: payload => ipcRenderer.invoke('dismiss-announcement', payload),
  getAnnouncementPreferences: () => ipcRenderer.invoke('get-announcement-preferences'),
  setAnnouncementPreferences: patch => ipcRenderer.invoke('set-announcement-preferences', patch),
  onAnnouncementPreferences: cb => {
    const listener = (_event, preferences) => cb(preferences);
    ipcRenderer.on('announcement-preferences-changed', listener);
    return () => ipcRenderer.removeListener('announcement-preferences-changed', listener);
  },
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
  openAppUpdate: () => ipcRenderer.invoke('open-app-update'),
  getAppUpdateState: () => ipcRenderer.invoke('get-app-update-state'),
  downloadAppUpdate: () => ipcRenderer.invoke('download-app-update'),
  cancelAppUpdate: () => ipcRenderer.invoke('cancel-app-update'),
  installAppUpdate: () => ipcRenderer.invoke('install-app-update'),
  onAppUpdateState: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('app-update-state', listener);
    return () => ipcRenderer.removeListener('app-update-state', listener);
  },
  onAppUpdatePreference: cb => {
    const listener = (_event, enabled) => cb(enabled);
    ipcRenderer.on('app-update-preference', listener);
    return () => ipcRenderer.removeListener('app-update-preference', listener);
  },
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),


  // 红果解析与下载
  hongguoResolve: (input) => ipcRenderer.invoke('hongguo-resolve', input),
  hongguoDownloadBatch: (payload) => ipcRenderer.invoke('hongguo-download-batch', payload),

  // 搜索（内嵌浏览器嗅探）
  searchSeries: (keyword, options) => ipcRenderer.invoke('search-series', keyword, options),
  searchSeriesMore: (keyword, options) => ipcRenderer.invoke('search-series-more', keyword, options),
  findSeriesSequels: (seriesId, options) => ipcRenderer.invoke('find-series-sequels', seriesId, options),
  searchResolve: (seriesId) => ipcRenderer.invoke('search-resolve', seriesId),
  searchWindowShow: (visible, sourceUrl) => ipcRenderer.invoke('search-window-show', visible, sourceUrl),
  getSeriesList: (options) => ipcRenderer.invoke('get-series-list', options),
  forgetSeries: (seriesId) => ipcRenderer.invoke('forget-series', seriesId),
  removeWatchHistory: (seriesId) => ipcRenderer.invoke('remove-watch-history', seriesId),
  cleanupWatchedEpisode: (seriesId, vidIndex) => ipcRenderer.invoke('cleanup-watched-episode', seriesId, vidIndex),
  removeSeries: (seriesId) => ipcRenderer.invoke('remove-series', seriesId),
  purgeEmptySeries: () => ipcRenderer.invoke('purge-empty-series'),
  restoreDismissedSeries: () => ipcRenderer.invoke('restore-dismissed-series'),
  dismissedCount: () => ipcRenderer.invoke('dismissed-count'),
  rescanDownloads: () => ipcRenderer.invoke('rescan-downloads'),

  // 在线播放（内存或临时磁盘缓存 + 自定义流协议）
  prepareOnlinePlay: (payload) => ipcRenderer.invoke('prepare-online-play', payload),
  releaseOnlinePlay: (payload) => ipcRenderer.invoke('release-online-play', payload),
  onlineCacheStatus: () => ipcRenderer.invoke('online-cache-status'),
  clearOnlineCache: () => ipcRenderer.invoke('clear-online-cache'),
  onOnlinePlayProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('online-play-progress', listener);
    return () => ipcRenderer.removeListener('online-play-progress', listener);
  },

  // 兼容模式（HEVC -> H.264 转码，解决「黑屏有声」）
  transcodeForPlayback: (payload) => ipcRenderer.invoke('transcode-for-playback', payload),
  cancelTranscodeForPlayback: (payload) => ipcRenderer.invoke('cancel-transcode-for-playback', payload),
  compatCacheStatus: () => ipcRenderer.invoke('compat-cache-status'),
  clearCompatCache: () => ipcRenderer.invoke('clear-compat-cache'),
  decodeCapability: () => ipcRenderer.invoke('decode-capability'),
  onTranscodeProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('transcode-progress', listener);
    return () => ipcRenderer.removeListener('transcode-progress', listener);
  },

  // 浏览（分类页）
  getCustomSources: () => ipcRenderer.invoke('get-custom-sources'),
  saveCustomSource: draft => ipcRenderer.invoke('save-custom-source',draft),
  deleteCustomSource: id => ipcRenderer.invoke('delete-custom-source',id),
  testCustomSource: draft => ipcRenderer.invoke('test-custom-source',draft),
  getMediaSources: () => ipcRenderer.invoke('get-media-sources'),
  setBuiltinSourceEnabled: (id, enabled) => ipcRenderer.invoke('set-builtin-source-enabled', id, enabled),
  onMediaSourcesChanged: cb => {
    const listener = () => cb();
    ipcRenderer.on('media-sources-changed', listener);
    return () => ipcRenderer.removeListener('media-sources-changed', listener);
  },
  browseCategories: () => ipcRenderer.invoke('browse-categories'),
  browseList: (options) => ipcRenderer.invoke('browse-list', options),
  playSeries: (payload) => ipcRenderer.invoke('play-series', payload),
  onNavigate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('navigate', listener);
    return () => ipcRenderer.removeListener('navigate', listener);
  },

  // 播放器
  getSeriesEpisodes: (seriesId) => ipcRenderer.invoke('get-series-episodes', seriesId),
  downloadSingleEpisode: (seriesId, vidIndex, quality) =>
    ipcRenderer.invoke('download-single-episode', seriesId, vidIndex, quality),
  savePlaybackPosition: (seriesId, vidIndex, currentTime, metadata) =>
    ipcRenderer.invoke('save-playback-position', seriesId, vidIndex, currentTime, metadata),
  getPlaybackPosition: (seriesId) => ipcRenderer.invoke('get-playback-position', seriesId),

  // 观看记录
  getWatchHistory: () => ipcRenderer.invoke('get-watch-history'),
  refreshWatchHistory: (options) => ipcRenderer.invoke('refresh-watch-history', options),
  checkWatchHistoryItem: (seriesId) => ipcRenderer.invoke('check-watch-history-item', seriesId),
  acknowledgeWatchUpdates: (seriesId, snapshot) => ipcRenderer.invoke('acknowledge-watch-updates', seriesId, snapshot),
  onWatchHistoryUpdated: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('watch-history-updated', listener);
    return () => ipcRenderer.removeListener('watch-history-updated', listener);
  },
  onWatchHistoryProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('watch-history-progress', listener);
    return () => ipcRenderer.removeListener('watch-history-progress', listener);
  },

  // 红果账号（网页扫码，只读同步 APP 观看记录）
  getAccountStatus: () => ipcRenderer.invoke('get-account-status'),
  startAccountLogin: () => ipcRenderer.invoke('start-account-login'),
  pollAccountLogin: (loginId) => ipcRenderer.invoke('poll-account-login', loginId),
  cancelAccountLogin: (loginId) => ipcRenderer.invoke('cancel-account-login', loginId),
  logoutAccount: () => ipcRenderer.invoke('logout-account'),
  getAccountHistory: (options) => ipcRenderer.invoke('get-account-history', options),
  playAccountHistory: (seriesId) => ipcRenderer.invoke('play-account-history', seriesId),
  onAccountUpdated: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('account-updated', listener);
    return () => ipcRenderer.removeListener('account-updated', listener);
  },

  // 一键合并
  getFfmpegStatus: () => ipcRenderer.invoke('get-ffmpeg-status'),
  mergeSeries: (seriesId, outputName, options) => ipcRenderer.invoke('merge-series', seriesId, outputName, options),
  cancelMerge: (id) => ipcRenderer.invoke('cancel-merge', id),
  getMergeTasks: () => ipcRenderer.invoke('get-merge-tasks'),
  deleteMergeTask: (id) => ipcRenderer.invoke('delete-merge-task', id),
  onMergeProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-progress', listener);
    return () => ipcRenderer.removeListener('merge-progress', listener);
  },
  onMergeTaskAdded: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-task-added', listener);
    return () => ipcRenderer.removeListener('merge-task-added', listener);
  },
  onMergeCompleted: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-completed', listener);
    return () => ipcRenderer.removeListener('merge-completed', listener);
  },
  onMergeFailed: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-failed', listener);
    return () => ipcRenderer.removeListener('merge-failed', listener);
  },

  // 设置
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getWindowLayout: () => ipcRenderer.invoke('get-window-layout'),
  setWindowLayout: (mode) => ipcRenderer.invoke('set-window-layout', mode),
  changeWindowZoom: (direction) => ipcRenderer.invoke('change-window-zoom', direction),
  onInterfaceZoomChanged: (cb) => {
    const listener = (_event, zoom) => cb(zoom);
    ipcRenderer.on('interface-zoom-changed', listener);
    return () => ipcRenderer.removeListener('interface-zoom-changed', listener);
  },
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('set-always-on-top', value),
  setEpisodePanelOpen: (value) => ipcRenderer.invoke('set-episode-panel-open', value),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  onStorageError: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('storage-error', listener);
    return () => ipcRenderer.removeListener('storage-error', listener);
  },

  // 网络代理
  getProxyStatus: () => ipcRenderer.invoke('get-proxy-status'),
  testProxy: (draft) => ipcRenderer.invoke('test-proxy', draft),

  // 下载管理
  getDownloadTasks: () => ipcRenderer.invoke('get-download-tasks'),
  deleteTask: (taskId) => ipcRenderer.invoke('delete-task', taskId),
  deleteTasks: (taskIds) => ipcRenderer.invoke('delete-tasks', taskIds),

  // 文件清理
  deleteTaskWithFiles: (taskId, deleteFiles) => ipcRenderer.invoke('delete-task', taskId, { deleteFiles }),
  deleteTasksWithFiles: (taskIds, deleteFiles) => ipcRenderer.invoke('delete-tasks', taskIds, { deleteFiles }),
  deleteSeriesFiles: (seriesId, options) => ipcRenderer.invoke('delete-series-files', seriesId, options),
  deleteEpisodeFile: (seriesId, vidIndex) => ipcRenderer.invoke('delete-episode-file', seriesId, vidIndex),
  getStorageUsage: () => ipcRenderer.invoke('get-storage-usage'),
  deleteAllDownloaded: () => ipcRenderer.invoke('delete-all-downloaded'),
  stopDownload: (taskId) => ipcRenderer.invoke('stop-download', taskId),
  retryTask: (taskId) => ipcRenderer.invoke('retry-task', taskId),
  retryTasks: (taskIds) => ipcRenderer.invoke('retry-tasks', taskIds),
  openFolder: (taskId) => ipcRenderer.invoke('open-folder', taskId),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),

  // 一键启动 / 一键暂停 / 队列状态
  pauseAll: () => ipcRenderer.invoke('pause-all'),
  resumeAll: () => ipcRenderer.invoke('resume-all'),
  getQueueStatus: () => ipcRenderer.invoke('get-queue-status'),

  // 事件监听
  onDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onDownloadTaskAdded: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-task-added', listener);
    return () => ipcRenderer.removeListener('download-task-added', listener);
  },
  onDownloadCompleted: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-completed', listener);
    return () => ipcRenderer.removeListener('download-completed', listener);
  },
  onDownloadFailed: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-failed', listener);
    return () => ipcRenderer.removeListener('download-failed', listener);
  },
  onDownloadStopped: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-stopped', listener);
    return () => ipcRenderer.removeListener('download-stopped', listener);
  },
  onDownloadQueueChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-queue-changed', listener);
    return () => ipcRenderer.removeListener('download-queue-changed', listener);
  },
});
