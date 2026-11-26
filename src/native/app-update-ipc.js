/**
 * IPC handlers for in-app update checking, downloading, cancellation, and installation.
 */
function registerAppUpdateIpc({
  ipcMain,
  app,
  shell,
  axios,
  availableRelease,
  APP_VERSION,
  IS_PREVIEW,
  portableConfig,
  getPortableConfig = () => portableConfig,
  proc = process,
  getMainWindow,
  getCurrentSettings,
  getProxyStartupFallback,
  matchesProxyAuth,
  proxyManager,
  resolveProxyConfig,
  applyProxyToSession,
  sendToRenderer,
  getAppUpdateInstallerRef,
  setAppUpdateInstallerRef,
  getAppUpdaterRef,
  setAppUpdaterRef,
  loadAutoUpdater,
  getLatestAppRelease,
  setLatestAppRelease,
  getUpdateDownloadGeneration,
  bumpUpdateDownloadGeneration,
  getInstallBlocker,
}) {
  let updateRequest = null;

  function appUpdateSupport() {
    let reason = '';
    const currentPortable = getPortableConfig();
    if (IS_PREVIEW || !app.isPackaged) {
      reason = '开发或预览版本不支持应用内安装，请使用正式安装版。';
    } else if (proc.platform === 'win32' && (currentPortable.mode === 'portable' || currentPortable.portableDir
      || proc.env.PORTABLE_EXECUTABLE_FILE || proc.env.PORTABLE_EXECUTABLE_DIR)) {
      reason = '便携版需手动更新。请先退出旧程序，再运行发布页中的 setup 安装包，并从安装后生成的快捷方式启动；安装版支持后续应用内更新。若仍用便携版，请完整解压新版并直接运行新版文件。';
    } else if (!['darwin', 'win32'].includes(proc.platform)) {
      reason = '当前系统请前往发布页手动更新。';
    } else if (proc.platform === 'darwin' && (proc.execPath.startsWith('/Volumes/') || proc.execPath.includes('/AppTranslocation/'))) {
      reason = '请先将应用放入“应用程序”文件夹后重新打开，再使用应用内更新。';
    }
    return { supported: !reason, reason };
  }

  function appUpdateState() {
    return getAppUpdateInstallerRef()?.getState() || { ...appUpdateSupport(), status: 'idle', version: null, percent: 0, error: '' };
  }

  function getAppUpdateInstaller() {
    let installer = getAppUpdateInstallerRef();
    if (!installer) {
      const updater = loadAutoUpdater();
      setAppUpdaterRef(updater);
      updater.on('login', (authInfo, callback) => {
        if (matchesProxyAuth(authInfo)) callback(proxyManager.activeAuth.username, proxyManager.activeAuth.password);
        else callback();
      });
      installer = require('./app-update-installer').createUpdateInstaller({
        updater,
        currentVersion: APP_VERSION,
        isEnabled: () => !IS_PREVIEW && getCurrentSettings().app_updates_enabled !== false,
        installBlocker: getInstallBlocker,
        emit: state => sendToRenderer('app-update-state', state),
      });
      setAppUpdateInstallerRef(installer);
    }
    return installer;
  }

  ipcMain.handle('get-app-update-state', () => appUpdateState());
  ipcMain.handle('download-app-update', async () => {
    const support = appUpdateSupport();
    if (!support.supported) return { success: false, error: support.reason };
    const release = getLatestAppRelease();
    if (!release || getCurrentSettings().app_updates_enabled === false) {
      return { success: false, error: '更新信息已失效，请重新检查更新。' };
    }
    try {
      const request = getUpdateDownloadGeneration();
      const installer = getAppUpdateInstaller();
      const netSession = getAppUpdaterRef()?.netSession;
      if (netSession && !['checking', 'downloading', 'downloaded', 'installing'].includes(installer.getState().status)) {
        await applyProxyToSession(proxyManager.desired || resolveProxyConfig(getCurrentSettings()), [netSession]);
      }
      if (request !== getUpdateDownloadGeneration()) return { success: false, error: '更新已取消。', state: installer.getState() };
      return await installer.download(release.version);
    } catch (_) {
      return { success: false, error: '无法准备应用内更新，请重试或前往发布页下载安装。' };
    }
  });
  ipcMain.handle('cancel-app-update', () => {
    const installer = getAppUpdateInstallerRef();
    if (installer?.getState().status === 'installing') {
      return { success: false, error: '正在安装更新，无法取消。', state: appUpdateState() };
    }
    bumpUpdateDownloadGeneration();
    if (!installer) return { success: true, state: appUpdateState() };
    return installer.cancel();
  });
  ipcMain.handle('install-app-update', () => {
    const installer = getAppUpdateInstallerRef();
    if (!installer) return { success: false, error: '请先完成更新下载。' };
    return installer.install();
  });
  ipcMain.handle('check-app-update', async event => {
    const mainWindow = getMainWindow();
    if (getProxyStartupFallback()) return { enabled: false, release: null, error: '请先修复或明确关闭代理。' };
    if (IS_PREVIEW || !mainWindow || event.sender !== mainWindow.webContents) return { enabled: false, release: null };
    if (getCurrentSettings().app_updates_enabled === false) {
      setLatestAppRelease(null);
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
    const nextRelease = enabled ? result.release : null;
    setLatestAppRelease(nextRelease);
    return { enabled, release: nextRelease, error: enabled ? result.error : '' };
  });
  ipcMain.handle('open-app-update', async event => {
    const mainWindow = getMainWindow();
    if (IS_PREVIEW || !mainWindow || event.sender !== mainWindow.webContents || getCurrentSettings().app_updates_enabled === false) {
      return { success: false, error: '更新信息已失效，请稍后重试' };
    }
    try { await shell.openExternal(getLatestAppRelease()?.url || 'https://github.com/jackotom/hongguo-drama/releases/latest'); return { success: true }; }
    catch { return { success: false, error: '无法打开浏览器，请稍后重试' }; }
  });
  return { appUpdateSupport, appUpdateState };
}

module.exports = { registerAppUpdateIpc };
