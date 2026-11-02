/**
 * store.js - 红果短剧 3.2 持久化模块（沿用原资料格式）
 * 用单个 JSON 文件保存「设置」与「下载任务」，替代原项目里的 sql.js 数据库 + electron-store，
 * 减少依赖，方便独立打包。
 */
const fs = require('fs');
const path = require('path');

let dataFile = null;
let cache = null; // { settings, tasks }
let durable = '{}';
let errorHandler = null;
let readError = null;
let writeError = false;
let safeStorage = null;
let runtimeProxyPassword = '';
let proxyPasswordWarning = '';
const PROXY_PASSWORD_CIPHER = 'proxy_password_ciphertext';
const SECURE_STORAGE_UNAVAILABLE = '系统安全存储不可用；代理密码仅在本次运行期间保留，重启后需要重新输入。';
const PROXY_PASSWORD_DECRYPT_FAILED = '已保存的代理密码无法解密；原密文已保留，可重新输入密码或清除。';
const READ_ERROR_MESSAGE = '读取本地数据失败，已保留原文件并暂停保存；请检查文件或目录权限，恢复数据后重启应用。';

function reportReadError() {
  try { errorHandler?.({ error: READ_ERROR_MESSAGE }); } catch {}
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
      readError = new Error(READ_ERROR_MESSAGE, { cause: e });
      readError.code = 'STORE_READ_FAILED';
      reportReadError();
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
    reportReadError();
    throw readError;
  }
  const temporary = dataFile + '.tmp';
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const serialized = JSON.stringify(serializableCache(), null, 2);
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, dataFile);
    durable = serialized;
    if (writeError) {
      writeError = false;
      try { errorHandler?.(null); } catch {}
    }
  } catch (e) {
    try { fs.unlinkSync(temporary); } catch {}
    cache = JSON.parse(durable);
    writeError = true;
    try { errorHandler?.({ error: '保存失败，请检查磁盘空间或目录权限；本次变更未能保存。' }); } catch {}
    throw e;
  }
}

function init(filePath, { safeStorage: injectedSafeStorage } = {}) {
  dataFile = filePath;
  safeStorage = injectedSafeStorage || null;
  cache = null;
  readError = null;
  writeError = false;
  runtimeProxyPassword = '';
  proxyPasswordWarning = '';
  loadCache();
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
  const c = loadCache();
  if (!c.playback || typeof c.playback !== 'object') c.playback = {};
  return c.playback;
}

function savePlayback(map) {
  loadCache().playback = map || {};
  flush();
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
  getMergeTasks,
  saveMergeTasks,
};
