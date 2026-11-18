const path = require('node:path');

function createAccountController({
  ipcMain,
  app,
  session,
  safeStorage,
  BrowserWindow,
  createAccountService,
  safeMessage,
  hongguo,
  getSeriesRegistry,
  upsertSeriesRegistry,
  saveSeriesRegistry,
  navigateToPlayer,
  send,
  applyProxyToSession = async () => {},
}) {
  let service = null;
  let webSession = null;
  let webSessionReady = Promise.resolve();
  let cookieCleanup = null;
  let loginWindow = null;
  const resumePositions = new Map();

  function getWebSession() {
    if (!webSession) {
      webSession = session.fromPartition('hongguo-account-login', { cache: false });
      webSessionReady = applyProxyToSession(webSession);
    }
    return webSession;
  }

  async function clearCookies() {
    await getWebSession().clearStorageData({ storages: ['cookies'] });
    await webSessionReady;
    const cookies = await session.defaultSession.cookies.get({});
    await Promise.all(cookies
      .filter(cookie => /(?:^|\.)hongguoduanju\.com$/i.test(String(cookie.domain || '')))
      .map(async cookie => {
        const host = String(cookie.domain || '').replace(/^\./, '');
        if (!host) return;
        try { await session.defaultSession.cookies.remove(`https://${host}${cookie.path || '/'}`, cookie.name); } catch {}
      }));
  }

  function getService() {
    if (!service) {
      cookieCleanup = clearCookies().catch(error => console.warn('[Account] 清除旧登录 Cookie 失败:', safeMessage(error)));
      service = createAccountService({
        filePath: path.join(app.getPath('userData'), 'account-session.bin'), safeStorage,
        webRequest: webRequest,
        onAccountExpired: () => {
          clearCookies().catch(error => console.warn('[Account] 清除登录 Cookie 失败:', error.message));
          send('account-updated', { signedIn: false });
        },
      });
    }
    return service;
  }

  async function webRequest(url, options = {}) {
    await webSessionReady;
    const response = await getWebSession().fetch(url, {
      method: options.method || 'GET', headers: options.headers || {}, redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    const headers = {};
    for (const [name, value] of response.headers) headers[name] = value;
    const cookies = response.headers.getSetCookie?.();
    if (cookies?.length) headers['set-cookie'] = cookies;
    return { status: response.status, headers, data: await response.text() };
  }

  async function action(run) {
    try {
      const current = getService();
      await cookieCleanup;
      await webSessionReady;
      return await run(current);
    } catch (error) {
      const message = safeMessage(error);
      console.warn('[Account]', message);
      return { success: false, error: message };
    }
  }

  ipcMain.handle('open-account-web-login', async () => {
    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return { success: true }; }
    getService();
    await cookieCleanup;
    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return { success: true }; }
    getService().cancelLogin();
    const accountSession = getWebSession();
    await webSessionReady;
    const win = new BrowserWindow({ width: 1000, height: 760, title: '红果官网登录', webPreferences: {
      session: accountSession, contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    loginWindow = win;
    const official = value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.hostname === 'hongguoduanju.com' || url.hostname.endsWith('.hongguoduanju.com'));
      } catch { return false; }
    };
    for (const name of ['will-navigate', 'will-redirect']) win.webContents.on(name, (event, url) => { if (!official(url)) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const observer = require('./account-web-login').createWebLoginObserver({
      readCookies: () => getWebSession().cookies.get({ url: 'https://hongguoduanju.com/' }),
      complete: cookie => action(current => current.completeWebLogin(cookie)),
      cancel: () => getService().cancelLogin(),
      onSignedIn: () => {
        send('account-updated', { signedIn: true });
        if (!win.isDestroyed()) win.close();
      },
      onError: error => {
        const message = safeMessage(error);
        console.warn('[Account]', message);
        send('account-updated', { error: message });
      },
    });
    const changed = () => { void observer.inspect(); };
    getWebSession().cookies.on('changed', changed);
    win.on('closed', () => {
      observer.close();
      getWebSession().cookies.removeListener('changed', changed);
      if (loginWindow === win) loginWindow = null;
    });
    win.webContents.on('did-finish-load', changed);
    await win.loadURL('https://hongguoduanju.com/');
    return { success: true };
  });

  ipcMain.handle('get-account-status', async () => action(current => current.status()));
  ipcMain.handle('start-account-login', async () => {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    getService().cancelLogin();
    await clearCookies();
    return action(current => current.startLogin());
  });
  ipcMain.handle('poll-account-login', async (_event, loginId) => {
    const result = await action(current => current.pollLogin(String(loginId || '')));
    if (!result.success) await clearCookies();
    if (result.status === 'signed-in') send('account-updated', { signedIn: true });
    return result;
  });
  ipcMain.handle('cancel-account-login', async (_event, loginId) => {
    const result = await action(current => current.cancelLogin(String(loginId || '')));
    await clearCookies();
    return result;
  });
  ipcMain.handle('logout-account', async () => {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    const result = await action(current => current.logout());
    if (result.success) {
      await clearCookies();
      send('account-updated', { signedIn: false });
    }
    return result;
  });
  ipcMain.handle('get-account-history', async (_event, options) => action(current => current.history({ refresh: options?.refresh === true })));
  ipcMain.handle('play-account-history', async (_event, seriesId) => {
    try {
      const sid = String(seriesId || '');
      if (!/^\d{1,30}$/.test(sid)) return { success: false, error: 'APP 观看记录编号无效' };
      const current = getService();
      let row = current.row(sid);
      if (!row) {
        const refreshed = await current.refreshHistory();
        if (!refreshed.success) return refreshed;
        row = current.row(sid);
      }
      if (!row) return { success: false, error: 'APP 观看记录已变化，请刷新后重试' };
      let entry = getSeriesRegistry().find(item => String(item.series_id) === sid);
      if (!entry) entry = upsertSeriesRegistry(await hongguo.fetchEpisodeList(sid));
      if (!entry || !entry.episodes?.length) return { success: false, error: '暂时无法读取这部剧的分集' };
      const episode = entry.episodes.find(item => String(item.vid) === String(row.episode_id))
        || (row.vid_index > 0 ? entry.episodes.find(item => Number(item.vid_index) === row.vid_index) : null);
      if (!episode) return { success: false, error: 'APP 进度对应的分集已变化，请先在 APP 中重新打开这部剧' };
      if (episode.locked) return { success: false, error: 'APP 进度对应的分集暂不可播放' };
      if (entry.dismissed) {
        entry.dismissed = false;
        entry.forgotten = false;
        saveSeriesRegistry();
      }
      resumePositions.set(sid, {
        vid_index: Number(episode.vid_index),
        currentTime: Math.max(0, Number(row.currentTime) || 0),
        updatedAt: Number(row.updatedAt) || Date.now(),
      });
      return navigateToPlayer({ seriesId: sid, vidIndex: episode.vid_index, resume: true });
    } catch (error) {
      resumePositions.delete(String(seriesId || ''));
      return { success: false, error: safeMessage(error, '打开 APP 观看记录失败') };
    }
  });

  function takeResumePosition(seriesId) {
    const sid = String(seriesId);
    const position = resumePositions.get(sid);
    if (position) resumePositions.delete(sid);
    return position || null;
  }

  return {
    takeResumePosition,
    peekWebSession: () => webSession,
    ready: () => webSessionReady,
  };
}

module.exports = { createAccountController };
