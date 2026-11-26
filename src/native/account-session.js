const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { signedAccountRequest, requestJson } = require('./app-source');
const { getPlaybackDevice } = require('./playback-device');

const WEB_BASE = 'https://hongguoduanju.com';
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WEB_QUERY = {
  aid: '513755', passport_jssdk_version: '3.4.10', passport_jssdk_type: 'normal',
  account_sdk_source: 'web', is_from_ttaccountsdk: '1', language: 'zh',
};

function safeMessage(error, fallback = '账号操作失败，请稍后重试') {
  return String(error?.message || fallback)
    .replace(/https?:\/\/\S+/gi, '[地址]')
    .replace(/(?:sessionid_ss|sessionid|sid_tt|sid_guard|uid_tt_ss|uid_tt|odin_tt|passport_csrf_token)=[^;\s]+/gi, '$1=[已隐藏]')
    .replace(/(?:cookie|authorization)\s*:\s*[^\r\n]+/gi, '[已隐藏]')
    .slice(0, 160);
}

function withTimeout(promise, timeout, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); }),
  ]).finally(() => clearTimeout(timer));
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function cleanCover(value) {
  const text = String(value || '').trim();
  const url = text.startsWith('//') ? `https:${text}` : text;
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const parsed = new URL(url);
    if (/\.heic$/i.test(parsed.pathname) && /-reading-sign\.fqnovelpic\.com$/i.test(parsed.hostname)) {
      const source = parsed.pathname.split('~tplv-', 1)[0];
      return `https://p3-novel.byteimg.com${source}~tplv-shrink:320:0.webp`;
    }
    return /\.heic$/i.test(parsed.pathname) ? '' : url;
  } catch { return ''; }
}

function responseData(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('红果账号接口返回格式异常');
  if (payload.message && String(payload.message).trim().toLowerCase() !== 'success') {
    const description = payload.data?.description || payload.message;
    throw new Error(cleanText(description) || '红果账号操作未完成');
  }
  if (payload.code !== undefined && Number(payload.code) !== 0) {
    throw new Error(cleanText(payload.message || payload.msg) || `红果账号接口返回错误（${payload.code}）`);
  }
  if (!payload.data || typeof payload.data !== 'object') throw new Error('红果账号接口返回内容为空');
  return payload.data;
}

/**
 * 解析官方「我的 → 收藏」返回的剧集书架。
 *
 * 接口 `/reading/bookapi/bookshelf/video/info/v1/` 返回 `data.video_shelf_info` 数组，
 * 每项里真正的剧集信息放在 `video_data` 里，外层另带收藏时间、简介与标签。
 * 字段名在不同版本间有出入，这里按「外层优先、内层兜底」的顺序逐个尝试。
 */
function parseFavorites(payload) {
  const data = responseData(payload);
  // 空书架时官方给的是 null；有条目时是数组。两者含义不同，不能混为一谈。
  if (!Object.prototype.hasOwnProperty.call(data, 'video_shelf_info')) {
    throw new Error('官方收藏数据格式已变化');
  }
  const rows = data.video_shelf_info == null ? [] : data.video_shelf_info;
  if (!Array.isArray(rows)) throw new Error('官方收藏数据格式已变化');
  const pick = (source, keys) => {
    for (const key of keys) {
      const value = source?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return '';
  };
  const parsed = rows.map(row => {
    const video = row?.video_data && typeof row.video_data === 'object' ? row.video_data : row;
    const seriesId = pick(video, ['series_id']) || pick(row, ['series_id', 'book_id']);
    const title = pick(row, ['series_title']) || pick(video, ['title']) || pick(row, ['book_name']);
    if (!/^\d{1,30}$/.test(seriesId) || !title) return null;
    const cover = cleanCover(pick(row, ['series_cover_url']) || pick(video, ['cover', 'cover_url', 'thumb_url']) || pick(row, ['thumb_url']));
    const rawCount = Number(video?.episode_cnt ?? video?.episode_count ?? row?.episode_cnt ?? 0);
    const intro = cleanText(pick(row, ['series_intro']) || pick(video, ['video_desc']) || pick(row, ['abstract']));
    const stamp = Number(row?.collect_time ?? 0);
    return {
      series_id: seriesId,
      series_title: title,
      cover,
      intro,
      total: Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0,
      // collect_time 有秒和毫秒两种口径：10 位以内是秒，更长的是毫秒，统一成毫秒。
      collectedAt: stamp > 0 && stamp < 10_000_000_000 ? stamp * 1000 : stamp,
      account: true,
    };
  }).filter(Boolean)
    .sort((a, b) => b.collectedAt - a.collectedAt)
    .filter((row, index, list) => list.findIndex(item => item.series_id === row.series_id) === index);
  // 有条目却一条都解析不出来，多半是官方改了字段，需要如实报错而不是显示空列表。
  if (rows.length > 0 && parsed.length === 0) throw new Error('官方收藏条目格式已变化');
  return parsed;
}

function parseQr(payload) {  const data = responseData(payload);
  const token = String(data.token || '').trim();
  const source = String(data.qrcode || '').trim();
  if (!token || !source) throw new Error('红果登录二维码格式已变化');
  const image = /^data:image\//i.test(source) ? source : `data:image/png;base64,${source.split('base64,').pop()}`;
  const rawExpiry = Number(data.expire_time);
  const expiresIn = rawExpiry > 1_000_000_000
    ? Math.max(0, Math.min(600, rawExpiry - Math.floor(Date.now() / 1000)))
    : Math.max(0, Math.min(600, rawExpiry || 180));
  return { token, image, expiresIn: Math.round(expiresIn) };
}

function parsePassportProfile(payload) {
  const data = responseData(payload);
  const id = String(data.user_id_str || data.user_id || '').trim();
  if (!id) throw new Error('登录态未通过红果账号验证，请重新扫码');
  if (!/^\d{1,30}$/.test(id) || !/[1-9]/.test(id)) throw new Error('红果账号编号无效，请重新扫码');
  return { id, nickname: cleanText(data.name || data.screen_name || data.username) || '红果用户' };
}

function parseStoredProfile(value) {
  const id = String(value?.id || '').trim();
  if (!/^\d{1,30}$/.test(id) || !/[1-9]/.test(id)) return null;
  return { id, nickname: cleanText(value?.nickname) || '红果用户' };
}

function parseHistory(payload) {
  const data = responseData(payload);
  const rows = data.data_list;
  if (!Array.isArray(rows)) throw new Error('APP 观看记录格式已变化');
  return rows.map(row => {
    if (row?.is_delete) return null;
    const seriesId = String(row?.book_id_str || row?.book_id || row?.series_id || '').trim();
    const episodeId = String(row?.vid || row?.item_id || '').trim();
    if (!/^\d{1,30}$/.test(seriesId) || !/^\d{1,30}$/.test(episodeId)) return null;
    const index = Number(row?.vid_index);
    const seconds = value => Math.max(0, (Number(value) || 0) / 1000);
    const rawTime = Number(row?.read_timestamp_ms || row?.last_watch_time) || 0;
    return {
      series_id: seriesId,
      series_title: cleanText(row?.series_title || row?.book_name),
      cover: cleanCover(row?.series_cover_url || row?.thumb_url || row?.cover),
      episode_id: episodeId,
      vid_index: Number.isSafeInteger(index) && index > 0 ? index : 0,
      currentTime: seconds(row?.current_play_position ?? row?.current_play_time),
      duration: seconds(row?.duration ?? row?.current_total_time),
      updatedAt: rawTime > 0 && rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime,
      total: Math.max(0, Number(row?.episode_cnt || row?.episode_count) || 0),
      account: true,
    };
  }).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((row, index, list) => list.findIndex(item => item.series_id === row.series_id) === index)
    .slice(0, 50);
}

class CookieJar {
  constructor(header = '') {
    this.values = new Map();
    for (const pair of String(header).split(';')) {
      const at = pair.indexOf('=');
      if (at > 0) this.values.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
  absorb(headers) {
    const raw = headers?.['set-cookie'];
    const lines = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const line of lines) {
      const pair = String(line).split(';', 1)[0];
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      this.values.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
  header() {
    return [...this.values].filter(([name, value]) => name && value).map(([name, value]) => `${name}=${value}`).join('; ');
  }
  hasSession() {
    return this.values.has('sessionid') || this.values.has('sessionid_ss');
  }
}

async function defaultWebRequest(url, options) {
  const axios = require('axios');
  const response = await axios({
    url, method: options.method || 'GET', headers: options.headers || {}, timeout: 12000,
    maxRedirects: 0, responseType: 'text', transformResponse: [data => data],
    maxContentLength: 2 * 1024 * 1024, maxBodyLength: 1024 * 1024, validateStatus: () => true,
  });
  return { status: response.status, headers: response.headers || {}, data: response.data || '' };
}

function checkedWebResponse(response) {
  if (!response || response.status !== 200) throw new Error(`红果网页登录请求失败（HTTP ${response?.status || '未知'}）`);
  const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
  if (!raw.trim() || raw.length > 2 * 1024 * 1024) throw new Error('红果网页登录响应异常');
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('红果网页登录响应格式异常'); }
  return payload;
}

function secureSessionStore({ filePath, safeStorage }) {
  const encryptionAvailable = () => {
    try {
      return safeStorage?.isEncryptionAvailable?.() === true
        && safeStorage?.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  };
  return {
    save(credentials) {
      if (!encryptionAvailable()) throw new Error('系统安全存储不可用，本次登录只保留到应用退出');
      const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
      const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      try {
        fs.renameSync(temporary, filePath);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
      }
      try { fs.chmodSync(filePath, 0o600); } catch {}
    },
    load() {
      if (!fs.existsSync(filePath)) return null;
      if (!encryptionAvailable()) throw new Error('系统安全存储不可用，无法读取上次登录');
      const text = safeStorage.decryptString(fs.readFileSync(filePath));
      const value = JSON.parse(text);
      if (!value || typeof value.cookie !== 'string' || !value.cookie.trim()) throw new Error('登录态文件无效，请重新扫码');
      return value;
    },
    clear() {
      try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

function createAccountService({
  filePath, safeStorage, webRequest = defaultWebRequest, identityRequest = getPlaybackDevice,
  accountRequest = requestJson, now = Date.now, onAccountExpired = () => {},
}) {
  const sessionStore = secureSessionStore({ filePath, safeStorage });
  let credentials = null;
  let profile = null;
  let history = [];
  let historyLoaded = false;
  let restorePromise = null;
  let generation = 0;
  let login = null;
  let loginGeneration = 0;

  const publicAccount = extra => ({
    success: true, signedIn: !!profile, account: profile ? { ...profile } : null, ...extra,
  });

  async function accountJson(targetCredentials, apiPath, params = {}) {
    // Website authentication does not depend on anonymous App device availability.
    const identity = targetCredentials.deviceId && targetCredentials.installId && targetCredentials.cdid ? {
      device_id: targetCredentials.deviceId, iid: targetCredentials.installId, cdid: targetCredentials.cdid,
    } : await withTimeout(identityRequest(accountRequest), 10000, '账号设备初始化超时，请重试');
    if (targetCredentials !== credentials) throw new Error('账号已退出，请重新登录');
    const signed = signedAccountRequest(apiPath, params, identity);
    const deadline = Date.now() + 12000;
    return accountRequest(signed.url, {
      method: 'GET', headers: { ...signed.headers, Cookie: targetCredentials.cookie },
      preserveLargeIntegerFields: ['vid', 'video_id', 'item_id'],
    }, deadline, AbortSignal.timeout(12000));
  }

  async function verify(targetCredentials) {
    return parsePassportProfile(await webJson('/passport/account/info/v2/', {}, new CookieJar(targetCredentials.cookie)));
  }

  async function restore() {
    try {
      const saved = sessionStore.load();
      if (!saved) return publicAccount();
      const token = generation;
      const cachedProfile = parseStoredProfile(saved.profile);
      if (cachedProfile) {
        credentials = saved;
        profile = cachedProfile;
        withTimeout(verify(saved), 12000, '登录态验证超时').then(nextProfile => {
          if (token !== generation) return;
          profile = nextProfile;
          try { sessionStore.save({ ...saved, profile: nextProfile }); } catch {}
        }).catch(error => {
          if (token !== generation) return;
          const message = safeMessage(error);
          if (!/会话过期|登录态未通过|账号编号无效|HTTP\s*(?:401|403)/i.test(message)) return;
          credentials = null;
          profile = null;
          history = [];
          historyLoaded = false;
          restorePromise = Promise.resolve(publicAccount());
          try { sessionStore.clear(); } catch {}
          onAccountExpired();
        });
        return publicAccount();
      }
      const nextProfile = await withTimeout(verify(saved), 12000, '登录态验证超时，请稍后重试');
      if (token !== generation) return publicAccount();
      credentials = saved;
      profile = nextProfile;
      try { sessionStore.save({ ...saved, profile: nextProfile }); } catch {}
      return publicAccount();
    } catch (error) {
      return { success: true, signedIn: false, account: null, error: safeMessage(error, '上次登录暂时无法恢复') };
    }
  }

  async function ensureRestored() {
    if (!restorePromise) restorePromise = restore();
    return restorePromise;
  }

  async function webJson(pathname, params = {}, jar = new CookieJar(), referer = `${WEB_BASE}/`) {
    const url = new URL(pathname, WEB_BASE);
    for (const [name, value] of Object.entries({ ...WEB_QUERY, ...params })) url.searchParams.set(name, value);
    const cookie = jar.header();
    const headers = {
      'User-Agent': WEB_UA, Referer: referer, Origin: WEB_BASE,
      Accept: 'application/json, text/javascript',
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const response = await webRequest(url.href, { method: 'GET', headers });
    jar.absorb(response.headers);
    return checkedWebResponse(response);
  }

  async function finishRedirect(value, jar) {
    let url = new URL(value, WEB_BASE);
    for (let count = 0; count < 5; count++) {
      if (url.protocol !== 'https:' || !(url.hostname === 'hongguoduanju.com' || url.hostname.endsWith('.hongguoduanju.com'))) {
        throw new Error('登录确认跳转到了不支持的站点');
      }
      const response = await webRequest(url.href, {
        method: 'GET', headers: { 'User-Agent': WEB_UA, Referer: `${WEB_BASE}/`, Cookie: jar.header() },
      });
      jar.absorb(response.headers);
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers?.location) {
        url = new URL(response.headers.location, url);
        continue;
      }
      if (response.status !== 200) throw new Error(`登录确认失败（HTTP ${response.status}）`);
      return;
    }
    throw new Error('登录确认跳转次数过多');
  }

  return {
    async status() {
      const restored = await ensureRestored();
      return restored.signedIn ? publicAccount() : restored;
    },

    async completeWebLogin(cookie) {
      if (typeof cookie !== 'string' || !cookie.trim() || cookie.length > 32768 || /[\r\n\0]/.test(cookie)) {
        throw new Error('登录态无效，请重新登录');
      }
      const attempt = ++loginGeneration;
      login = null;
      const token = generation;
      const nextProfile = await withTimeout(verify({ cookie }), 15000, '账号资料验证超时，请重试');
      if (attempt !== loginGeneration || token !== generation) return { success: true, status: 'cancelled' };
      const nextCredentials = { cookie };
      let storageWarning = '';
      try { sessionStore.save({ ...nextCredentials, profile: nextProfile }); } catch (error) { storageWarning = safeMessage(error); }
      credentials = nextCredentials; profile = nextProfile; history = []; historyLoaded = false;
      generation++; restorePromise = Promise.resolve(publicAccount());
      return publicAccount({ status: 'signed-in', storageWarning });
    },

    async startLogin() {
      const attempt = ++loginGeneration;
      login = null;
      const jar = new CookieJar();
      const payload = await webJson('/passport/web/get_qrcode/', { next: `${WEB_BASE}/` }, jar);
      if (attempt !== loginGeneration) throw new Error('扫码已取消，请重新获取二维码');
      const qr = parseQr(payload);
      login = { id: randomUUID(), token: qr.token, jar, expiresAt: now() + qr.expiresIn * 1000 };
      return { success: true, loginId: login.id, image: qr.image, expiresIn: qr.expiresIn };
    },

    async pollLogin(loginId) {
      if (!login || login.id !== loginId) throw new Error('扫码会话已失效，请重新获取二维码');
      if (login.polling) return login.polling;
      if (now() >= login.expiresAt) {
        login = null;
        return { success: true, status: 'expired' };
      }
      const currentLogin = login;
      const attempt = loginGeneration;
      const stillCurrent = () => login === currentLogin && attempt === loginGeneration;
      const run = (async () => {
        const data = responseData(await webJson('/passport/web/check_qrconnect/', {
          next: `${WEB_BASE}/`, token: currentLogin.token,
        }, currentLogin.jar));
        if (!stillCurrent()) return { success: true, status: 'cancelled' };
        console.log('[Account] QR status:', String(data.status || ''), data.redirect_url ? 'redirect' : 'no-redirect');
        if (['5', 'expired'].includes(String(data.status))) {
          login = null;
          return { success: true, status: 'expired' };
        }
        if (!['3', 'confirmed'].includes(String(data.status))) return { success: true, status: 'pending' };
        if (data.redirect_url) await finishRedirect(String(data.redirect_url), currentLogin.jar);
        if (!stillCurrent()) return { success: true, status: 'cancelled' };
        console.log('[Account] Login session cookie:', currentLogin.jar.hasSession() ? 'present' : 'missing');
        if (!currentLogin.jar.hasSession()) return { success: true, status: 'pending' };

        const cookie = currentLogin.jar.header();
        console.log('[Account] Profile verify: start');
        const nextProfile = await withTimeout(verify({ cookie }), 15000, '账号资料验证超时，请重试');
        if (!stillCurrent()) return { success: true, status: 'cancelled' };
        console.log('[Account] Profile verify: done');
        const nextCredentials = { cookie };
        let storageWarning = '';
        try { sessionStore.save({ ...nextCredentials, profile: nextProfile }); }
        catch (error) { storageWarning = safeMessage(error); }
        credentials = nextCredentials;
        profile = nextProfile;
        history = [];
        historyLoaded = false;
        generation++;
        login = null;
        restorePromise = Promise.resolve(publicAccount());
        return publicAccount({ storageWarning, status: 'signed-in' });
      })();
      currentLogin.polling = run;
      try { return await run; }
      finally { if (currentLogin.polling === run) currentLogin.polling = null; }
    },

    cancelLogin(loginId) {
      if (loginId && login && login.id !== loginId) return { success: true };
      loginGeneration++;
      login = null;
      return { success: true };
    },

    async logout() {
      loginGeneration++;
      generation++;
      credentials = null;
      profile = null;
      history = [];
      historyLoaded = false;
      login = null;
      restorePromise = Promise.resolve(publicAccount());
      let storageWarning = '';
      try { sessionStore.clear(); } catch (error) { storageWarning = safeMessage(error); }
      return publicAccount({ storageWarning });
    },

    async refreshHistory() {
      const current = credentials;
      if (!current || !profile) return { success: true, signedIn: false, account: null, results: [] };
      const token = generation;
      const rows = parseHistory(await accountJson(current, '/reading/bookapi/read_history/list/v1/', {
        book_type: '2', limit: '0', offset: '0', last_min_read_timestamp_ms: '0',
        full_field: 'true', is_first_load: 'true', query_soft_deleted: 'false',
      }));
      if (token !== generation) return { success: true, signedIn: false, account: null, results: [] };
      history = rows.map(row => ({
        ...row,
        series_title: row.series_title || `剧集 ${row.series_id}`,
      }));
      historyLoaded = true;
      return publicAccount({ results: history.map(row => ({ ...row })) });
    },

    async history({ refresh = false } = {}) {
      const current = credentials;
      if (!current || !profile) return { success: true, signedIn: false, account: null, results: [] };
      if (!historyLoaded || refresh) return this.refreshHistory();
      return publicAccount({ results: history.map(row => ({ ...row })) });
    },

    /** 官方「我的 → 收藏」里的剧集书架（云端，不是本机收藏）。 */
    async favorites() {
      const current = credentials;
      if (!current || !profile) return { success: true, signedIn: false, account: null, results: [] };
      const token = generation;
      const rows = parseFavorites(await accountJson(current, '/reading/bookapi/bookshelf/video/info/v1/'));
      if (token !== generation) return { success: true, signedIn: false, account: null, results: [] };
      return publicAccount({ results: rows.map(row => ({ ...row })) });
    },

    row(seriesId) {
      return history.find(row => row.series_id === String(seriesId)) || null;
    },
  };
}

module.exports = {
  createAccountService, secureSessionStore, parseQr, parsePassportProfile, parseHistory, parseFavorites, safeMessage,
};
