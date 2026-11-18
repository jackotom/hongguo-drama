/**
 * store.js - 红果短剧持久化模块（兼容原资料格式）
 * 主 JSON 保存设置与资料索引；高频播放进度单独原子写入，避免拖慢播放。
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./native/atomic-json');

let dataFile = null;
let playbackFile = null;
let cache = null; // { settings, tasks }
let playbackCache = null;
let durable = '{}';
let errorHandler = null;
let readError = null;
let playbackReadError = null;
let playbackCleanupPending = false;
let writeError = false;
let safeStorage = null;
let runtimeProxyPassword = '';
let proxyPasswordWarning = '';
let maxBytes = 32 * 1024 * 1024;
let playbackMaxBytes = 16 * 1024 * 1024;
const PROXY_PASSWORD_CIPHER = 'proxy_password_ciphertext';
const SECURE_STORAGE_UNAVAILABLE = '系统安全存储不可用；代理密码仅在本次运行期间保留，重启后需要重新输入。';
const PROXY_PASSWORD_DECRYPT_FAILED = '已保存的代理密码无法解密；原密文已保留，可重新输入密码或清除。';
const READ_ERROR_MESSAGE = '读取本地数据失败，已保留原文件并暂停保存；请检查文件或目录权限，恢复数据后重启应用。';
const PLAYBACK_READ_ERROR_MESSAGE = '读取播放进度失败，已保留原文件并暂停覆盖；请检查文件或目录权限，恢复数据后重启应用。';

function reportReadError(message = READ_ERROR_MESSAGE) {
  try { errorHandler?.({ error: message }); } catch {}
}

function encryptionAvailable() {
  try {
    return safeStorage?.isEncryptionAvailable?.() === true
      && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  } catch { return false; }
}

function encryptProxyPassword(password) {
  if (!encryptionAvailable()) return null;
  try {
    const encrypted = safeStorage.encryptString(password);
    if (!encrypted?.length) return null;
    return Buffer.from(encrypted).toString('base64');
  } catch {
    return null;
  }
}

function decodeUrlPart(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function extractEmbeddedProxyPassword(settings) {
  const original = String(settings.proxy_host || '').trim();
  if (!original.includes('@')) return '';
  let username = '';
  let password = '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(original) ? original : `http://${original}`);
    username = decodeUrlPart(url.username);
    password = decodeUrlPart(url.password);
  } catch {
    const at = original.lastIndexOf('@');
    const userInfo = original.slice(0, at).split('://').pop();
    const separator = userInfo.indexOf(':');
    username = decodeUrlPart(separator < 0 ? userInfo : userInfo.slice(0, separator));
    password = separator < 0 ? '' : decodeUrlPart(userInfo.slice(separator + 1));
  }
  settings.proxy_host = original.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/]*@/i, '$1');
  if (username) settings.proxy_username = username;
  return password;
}

function stripPublicSecretFields(settings) {
  delete settings.proxy_password;
  delete settings.proxy_password_set;
  delete settings.proxy_password_warning;
  delete settings.clear_proxy_password;
}

function hydrateProxyPassword(settings) {
  let changed = false;
  const embeddedPassword = extractEmbeddedProxyPassword(settings);
  if (Object.prototype.hasOwnProperty.call(settings, 'proxy_password')) changed = true;
  const plaintext = typeof settings.proxy_password === 'string' ? settings.proxy_password : '';
  const storedCipher = typeof settings[PROXY_PASSWORD_CIPHER] === 'string'
    ? settings[PROXY_PASSWORD_CIPHER] : '';
  stripPublicSecretFields(settings);
  delete settings[PROXY_PASSWORD_CIPHER];
  runtimeProxyPassword = '';
  proxyPasswordWarning = '';

  const password = plaintext || embeddedPassword;
  if (password) {
    runtimeProxyPassword = password;
    const encrypted = encryptProxyPassword(password);
    if (encrypted) settings[PROXY_PASSWORD_CIPHER] = encrypted;
    else proxyPasswordWarning = SECURE_STORAGE_UNAVAILABLE;
    return true;
  }
  if (!storedCipher) return changed;
  settings[PROXY_PASSWORD_CIPHER] = storedCipher;
  if (!encryptionAvailable()) {
    proxyPasswordWarning = SECURE_STORAGE_UNAVAILABLE;
    return changed;
  }
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(storedCipher, 'base64'));
    if (typeof decrypted !== 'string') throw new TypeError('Invalid decrypted proxy password');
    runtimeProxyPassword = decrypted;
  } catch {
    proxyPasswordWarning = PROXY_PASSWORD_DECRYPT_FAILED;
  }
  return changed;
}

function serializableCache() {
  const copy = structuredClone(cache || {});
  if (playbackCache !== null) delete copy.playback;
  if (copy.settings) {
    stripPublicSecretFields(copy.settings);
    if (!copy.settings[PROXY_PASSWORD_CIPHER]) delete copy.settings[PROXY_PASSWORD_CIPHER];
  }
  return copy;
}

function loadCache() {
  if (!dataFile) throw new Error('store 未初始化');
  if (cache) return cache;
  let secretsChanged = false;
  try {
    if (fs.statSync(dataFile).size > maxBytes) {
      throw Object.assign(new Error('STORE_TOO_LARGE'), { code: 'STORE_TOO_LARGE' });
    }
    cache = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      throw new TypeError('Invalid store document');
    }
    for (const key of ['tasks', 'series', 'mergeTasks']) {
      if (key in cache && !Array.isArray(cache[key])) throw new TypeError(`Invalid store ${key}`);
    }
    for (const key of ['settings', 'playback']) {
      if (key in cache && (!cache[key] || typeof cache[key] !== 'object' || Array.isArray(cache[key]))) {
        throw new TypeError(`Invalid store ${key}`);
      }
    }
  } catch (e) {
    cache = {};
    if (e.code !== 'ENOENT') {
      const message = e.code === 'STORE_TOO_LARGE'
        ? `本地记录超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限；已保留原文件并暂停保存，请先备份并清理旧任务或剧库。`
        : READ_ERROR_MESSAGE;
      readError = new Error(message, { cause: e });
      readError.code = 'STORE_READ_FAILED';
      reportReadError(message);
    }
  }
  if (!Array.isArray(cache.tasks)) cache.tasks = [];
  if (!cache.settings || typeof cache.settings !== 'object') cache.settings = {};
  secretsChanged = hydrateProxyPassword(cache.settings);
  durable = JSON.stringify(serializableCache());
  if (secretsChanged && !readError) flush();
  return cache;
}

function flush() {
  if (!dataFile) return;
  if (readError) {
    cache = JSON.parse(durable);
    reportReadError(readError.message);
    throw readError;
  }
  try {
    const serialized = writeJsonAtomic(dataFile, serializableCache(), { maxBytes });
    durable = serialized;
    if (writeError) {
      writeError = false;
      try { errorHandler?.(null); } catch {}
    }
    if (playbackCache !== null) playbackCleanupPending = false;
  } catch (e) {
    cache = JSON.parse(durable);
    writeError = true;
    const message = e.code === 'STORE_TOO_LARGE'
      ? e.message
      : '保存失败，请检查磁盘空间或目录权限；本次变更未能保存。';
    try { errorHandler?.({ error: message }); } catch {}
    throw e;
  }
}

function playbackPathFor(filePath) {
  const extension = path.extname(filePath);
  return path.join(path.dirname(filePath), `${path.basename(filePath, extension)}.playback${extension || '.json'}`);
}

function playbackReadFailure(cause) {
  const error = new Error(PLAYBACK_READ_ERROR_MESSAGE, { cause });
  error.code = 'PLAYBACK_READ_FAILED';
  return error;
}

function loadPlaybackCache() {
  if (playbackCache) return playbackCache;
  if (playbackReadError) throw playbackReadError;
  const legacy = cache?.playback && typeof cache.playback === 'object' && !Array.isArray(cache.playback)
    ? cache.playback : null;
  try {
    if (fs.existsSync(playbackFile)) {
      if (fs.statSync(playbackFile).size > playbackMaxBytes) {
        throw Object.assign(new Error('PLAYBACK_TOO_LARGE'), { code: 'STORE_TOO_LARGE' });
      }
      const parsed = JSON.parse(fs.readFileSync(playbackFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Invalid playback document');
      playbackCache = { ...parsed };
      if (legacy) {
        let changed = false;
        for (const [seriesId, record] of Object.entries(legacy)) {
          const current = playbackCache[seriesId];
          if (!current || Number(record?.updatedAt) > Number(current?.updatedAt)) {
            playbackCache[seriesId] = record;
            changed = true;
          }
        }
        if (changed) writeJsonAtomic(playbackFile, playbackCache, { maxBytes: playbackMaxBytes });
      }
    } else {
      playbackCache = legacy || {};
      if (legacy && Object.keys(legacy).length) {
        writeJsonAtomic(playbackFile, legacy, { maxBytes: playbackMaxBytes });
      }
    }
    if (cache && Object.prototype.hasOwnProperty.call(cache, 'playback')) {
      delete cache.playback;
      if (!readError) {
        try {
          flush();
          playbackCleanupPending = false;
        } catch {
          playbackCleanupPending = true;
        }
      }
    }
    return playbackCache;
  } catch (error) {
    if (error.code === 'ENOENT') {
      playbackCache = legacy || {};
      return playbackCache;
    }
    playbackReadError = playbackReadFailure(error);
    reportReadError(PLAYBACK_READ_ERROR_MESSAGE);
    throw playbackReadError;
  }
}

function init(filePath, {
  safeStorage: injectedSafeStorage,
  maxBytes: injectedMaxBytes,
  playbackMaxBytes: injectedPlaybackMaxBytes,
} = {}) {
  dataFile = filePath;
  playbackFile = playbackPathFor(filePath);
  safeStorage = injectedSafeStorage || null;
  maxBytes = Number(injectedMaxBytes) > 0 ? Number(injectedMaxBytes) : 32 * 1024 * 1024;
  playbackMaxBytes = Number(injectedPlaybackMaxBytes) > 0 ? Number(injectedPlaybackMaxBytes) : 16 * 1024 * 1024;
  cache = null;
  playbackCache = null;
  readError = null;
  playbackReadError = null;
  playbackCleanupPending = false;
  writeError = false;
  runtimeProxyPassword = '';
  proxyPasswordWarning = '';
  loadCache();
  try { loadPlaybackCache(); }
  catch { /* The error handler has already reported it; keep the rest of the app usable. */ }
}

function getSettings() {
  const settings = { ...loadCache().settings };
  const hasStoredPassword = Object.prototype.hasOwnProperty.call(settings, PROXY_PASSWORD_CIPHER);
  delete settings[PROXY_PASSWORD_CIPHER];
  if (runtimeProxyPassword || hasStoredPassword || proxyPasswordWarning) {
    settings.proxy_password = runtimeProxyPassword;
    settings.proxy_password_set = !!runtimeProxyPassword || hasStoredPassword;
    settings.proxy_password_warning = proxyPasswordWarning;
  }
  return settings;
}

function saveSettings(settings, { clearProxyPassword = false } = {}) {
  const current = loadCache();
  const previousCache = structuredClone(current);
  const previousPassword = runtimeProxyPassword;
  const previousWarning = proxyPasswordWarning;
  const incoming = settings && typeof settings === 'object' ? structuredClone(settings) : {};
  const shouldClear = clearProxyPassword === true || incoming.clear_proxy_password === true;
  const embeddedPassword = extractEmbeddedProxyPassword(incoming);
  const requestedPassword = typeof incoming.proxy_password === 'string' ? incoming.proxy_password : '';
  const currentCipher = typeof current.settings[PROXY_PASSWORD_CIPHER] === 'string'
    ? current.settings[PROXY_PASSWORD_CIPHER] : '';
  stripPublicSecretFields(incoming);
  delete incoming[PROXY_PASSWORD_CIPHER];

  let nextPassword = runtimeProxyPassword;
  let nextCipher = currentCipher;
  let nextWarning = proxyPasswordWarning;
  if (shouldClear) {
    nextPassword = '';
    nextCipher = '';
    nextWarning = '';
  } else if (requestedPassword || embeddedPassword) {
    const password = requestedPassword || embeddedPassword;
    if (password === nextPassword && nextCipher) {
      nextWarning = proxyPasswordWarning;
    } else {
      nextPassword = password;
      nextCipher = encryptProxyPassword(password) || '';
      nextWarning = nextCipher ? '' : SECURE_STORAGE_UNAVAILABLE;
    }
  } else if (nextPassword && !nextCipher) {
    nextCipher = encryptProxyPassword(nextPassword) || '';
    if (nextCipher) nextWarning = '';
  }

  if (nextCipher) incoming[PROXY_PASSWORD_CIPHER] = nextCipher;
  current.settings = incoming;
  runtimeProxyPassword = nextPassword;
  proxyPasswordWarning = nextWarning;
  try {
    flush();
  } catch (error) {
    cache = previousCache;
    runtimeProxyPassword = previousPassword;
    proxyPasswordWarning = previousWarning;
    throw error;
  }
}

function getAnnouncementState() {
  const state = loadCache().announcement;
  return state && typeof state === 'object' && !Array.isArray(state) ? structuredClone(state) : {};
}

function saveAnnouncementState(patch) {
  loadCache().announcement = { ...getAnnouncementState(), ...patch };
  flush();
}

function getTasks() {
  return loadCache().tasks;
}

function saveTasks(tasks) {
  loadCache().tasks = tasks || [];
  flush();
}

// ===== 短剧档案（让播放页在没有下载任务时也能列出完整分集）=====
function getSeries() {
  const c = loadCache();
  if (!Array.isArray(c.series)) c.series = [];
  return c.series;
}

function saveSeries(list) {
  loadCache().series = list || [];
  flush();
}

// ===== 播放进度（断点续播）=====
function getPlayback() {
  loadCache();
  return structuredClone(loadPlaybackCache());
}

function savePlayback(map) {
  loadCache();
  if (readError) throw readError;
  loadPlaybackCache();
  if (playbackCleanupPending) {
    delete cache.playback;
    try {
      flush();
      playbackCleanupPending = false;
    } catch {
      /* Playback is saved independently; a later main save will retry the cleanup. */
    }
  }
  const next = structuredClone(map || {});
  try {
    writeJsonAtomic(playbackFile, next, { maxBytes: playbackMaxBytes });
    playbackCache = next;
    if (writeError) {
      writeError = false;
      try { errorHandler?.(null); } catch {}
    }
  } catch (error) {
    writeError = true;
    const message = error.code === 'STORE_TOO_LARGE'
      ? error.message
      : '播放进度保存失败，已保留上次成功记录；请检查磁盘空间或目录权限。';
    try { errorHandler?.({ error: message }); } catch {}
    throw error;
  }
}

function updatePlayback(updater) {
  loadCache();
  if (readError) throw readError;
  loadPlaybackCache();
  const next = structuredClone(playbackCache || {});
  const result = updater(next);
  savePlayback(next);
  return result;
}

// ===== 合并任务记录 =====
function getMergeTasks() {
  const c = loadCache();
  if (!Array.isArray(c.mergeTasks)) c.mergeTasks = [];
  return c.mergeTasks;
}

function saveMergeTasks(list) {
  loadCache().mergeTasks = list || [];
  flush();
}

module.exports = {
  setErrorHandler: (handler) => { errorHandler = handler; },
  init,
  getSettings,
  saveSettings,
  getAnnouncementState,
  saveAnnouncementState,
  getTasks,
  saveTasks,
  getSeries,
  saveSeries,
  getPlayback,
  savePlayback,
  updatePlayback,
  getMergeTasks,
  saveMergeTasks,
};
