// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePolicy, setPolicy } = require('./source-policy');

const DEFAULT_URL = 'https://raw.githubusercontent.com/jackotom/hongguo-drama/main/source-packs/hongguo-playback.pack.json';
const MIRRORS = Object.freeze([
  DEFAULT_URL,
  'https://cdn.jsdelivr.net/gh/jackotom/hongguo-drama@main/source-packs/hongguo-playback.pack.json',
  'https://fastly.jsdelivr.net/gh/jackotom/hongguo-drama@main/source-packs/hongguo-playback.pack.json',
]);
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_PACK_BYTES = 256 * 1024;
const PACK_FORMAT = 2;
const ACTIVE_KEY_ID = 'primary-2026-11';
const STANDBY_KEY_ID = 'standby-2026-11';

function publicKey(base64) {
  return crypto.createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
}

const SOURCE_PACK_KEYS = Object.freeze({
  [ACTIVE_KEY_ID]: publicKey('MCowBQYDK2VwAyEAjuRI96E/T54X9FP806UEfoS1cwnWPsvPAnePBFSWA6M='),
  [STANDBY_KEY_ID]: publicKey('MCowBQYDK2VwAyEA+WpDTdstYLrCl9EdDwtSV1PrwojElbPnOZk1LoXwnEU='),
});

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function decodeEnvelope(envelope, keyring = SOURCE_PACK_KEYS) {
  if (!envelope || typeof envelope !== 'object' || envelope.format !== PACK_FORMAT) throw new Error('取源更新包格式无效');
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string'
      || typeof envelope.keyId !== 'string' || !envelope.keyId) throw new Error('取源更新包缺少签名');
  const key = keyring && Object.prototype.hasOwnProperty.call(keyring, envelope.keyId) ? keyring[envelope.keyId] : null;
  if (!key) throw new Error('取源更新包使用了未知签名密钥');
  if (envelope.payload.length > MAX_PACK_BYTES * 2 || envelope.signature.length > 256) throw new Error('取源更新包过大');
  const raw = Buffer.from(envelope.payload, 'base64');
  if (!raw.length || raw.length > MAX_PACK_BYTES) throw new Error('取源更新包过大');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (!crypto.verify(null, raw, key, signature)) throw new Error('取源更新包签名校验失败');
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new Error('取源更新包内容不是有效 JSON'); }
  if (canonicalize(payload) !== raw.toString('utf8')) throw new Error('取源更新包不是规范 JSON');
  if (payload.keyId !== envelope.keyId) throw new Error('取源更新包签名密钥标识不一致');
  return { payload, raw, keyId: envelope.keyId };
}

function validatePack(payload, keyring = SOURCE_PACK_KEYS, now = Date.now) {
  if (!payload || typeof payload !== 'object' || payload.format !== PACK_FORMAT
      || payload.id !== 'hongguo-playback') throw new Error('取源更新包类型无效');
  if (typeof payload.keyId !== 'string' || !Object.prototype.hasOwnProperty.call(keyring || {}, payload.keyId)) {
    throw new Error('取源更新包密钥标识无效');
  }
  const revision = Number(payload.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('取源更新包版本无效');
  const issuedAt = Date.parse(payload.issuedAt);
  if (!Number.isFinite(issuedAt)) throw new Error('取源更新包发布时间无效');
  if (payload.expiresAt != null && (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= now())) {
    throw new Error('取源更新包已过期');
  }
  const policy = normalizePolicy({ revision, routes: payload.policy?.routes });
  return {
    format: PACK_FORMAT,
    id: 'hongguo-playback',
    keyId: payload.keyId,
    revision,
    issuedAt: new Date(issuedAt).toISOString(),
    ...(payload.expiresAt ? { expiresAt: new Date(Date.parse(payload.expiresAt)).toISOString() } : {}),
    policy,
  };
}

function parsePack(envelope, source, keyring = SOURCE_PACK_KEYS, now = Date.now) {
  const { payload } = decodeEnvelope(envelope, keyring);
  return { ...validatePack(payload, keyring, now), source, envelope: { ...envelope } };
}

function publicStatus(record, active, extra = {}) {
  return {
    success: true,
    enabled: record?.enabled !== false,
    revision: active?.revision || 0,
    issuedAt: active?.issuedAt || '',
    source: active?.source || 'embedded',
    keyId: active?.keyId || '',
    lastCheckAt: record?.lastCheckAt || 0,
    canRollback: !!record?.previousEnvelope,
    suppressedRevision: record?.suppressAutoThroughRevision || 0,
    error: record?.error || '',
    ...extra,
  };
}

function createSourcePackService({
  filePath, keyring = SOURCE_PACK_KEYS, request, now = Date.now, bundledEnvelope,
}) {
  const statePath = path.resolve(filePath);
  let record = {
    enabled: true, activeEnvelope: null, activeSource: 'embedded',
    previousEnvelope: null, previousSource: '', lastCheckAt: 0,
    suppressAutoThroughRevision: 0, error: '',
  };
  let active = null;
  let writeChain = Promise.resolve();
  let operationChain = Promise.resolve();
  let writeSeq = 0;

  function persist(next = record) {
    const snapshot = JSON.stringify(next, null, 2);
    const task = writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
      const temp = `${statePath}.${process.pid}.${++writeSeq}.tmp`;
      try {
        await fs.promises.writeFile(temp, snapshot, { mode: 0o600 });
        await fs.promises.rename(temp, statePath);
      } catch (error) {
        await fs.promises.unlink(temp).catch(() => {});
        throw error;
      }
    });
    // Never let a single disk error poison future persistence attempts.
    writeChain = task.catch(() => {});
    return task;
  }

  function serialize(fn) {
    const run = operationChain.then(fn, fn);
    operationChain = run.catch(() => {});
    return run;
  }

  async function commit(nextRecord, nextActive) {
    await persist(nextRecord);
    record = nextRecord;
    active = nextActive;
    setPolicy(active?.policy || null);
  }

  function readPack(envelope, source) {
    if (!envelope) return null;
    try { return parsePack(envelope, source, keyring, now); } catch { return null; }
  }

  let savedPack = null;
  let hadSavedEnvelope = false;
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (saved && typeof saved === 'object') record = { ...record, ...saved };
    hadSavedEnvelope = !!record.activeEnvelope;
    savedPack = readPack(record.activeEnvelope, record.activeSource || 'saved');
  } catch {}
  const bundledPack = readPack(bundledEnvelope, 'embedded');
  const upgradedToBundled = !!bundledPack && (!savedPack || bundledPack.revision >= savedPack.revision);
  active = upgradedToBundled ? bundledPack : savedPack;
  if (active) {
    record.activeEnvelope = active.envelope;
    record.activeSource = active.source;
    setPolicy(active.policy);
  } else {
    setPolicy(null);
  }
  if (upgradedToBundled && hadSavedEnvelope && (!savedPack || bundledPack.revision > savedPack.revision)) {
    void persist(record).catch(() => {});
  }

  async function fetchPack() {
    const failures = [];
    for (const url of MIRRORS) {
      try {
        const response = await request(url, {
          timeout: 8000, responseType: 'json', maxContentLength: MAX_PACK_BYTES,
          maxBodyLength: 1024, maxRedirects: 0, decompress: false,
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'hongguo-drama-source-pack/2' },
        });
        const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        return parsePack(data, 'remote', keyring, now);
      } catch (error) {
        failures.push(error);
      }
    }
    const error = new Error('所有取源更新镜像均不可用');
    error.failures = failures;
    throw error;
  }

  return {
    status() { return publicStatus(record, active); },
    setEnabled(enabled) {
      return serialize(async () => {
        const nextRecord = { ...record, enabled: enabled !== false, error: '' };
        await persist(nextRecord);
        record = nextRecord;
        return publicStatus(record, active);
      });
    },
    check({ force = false } = {}) {
      return serialize(async () => {
        if (record.enabled === false) return publicStatus(record, active, { error: '自动获取播放源已关闭' });
        if (!force && now() - Number(record.lastCheckAt || 0) < CHECK_INTERVAL_MS) return publicStatus(record, active);
        try {
          const next = await fetchPack();
          if (record.enabled === false) return publicStatus(record, active, { error: '自动获取播放源已关闭' });
          const currentRevision = Number(active?.revision || 0);
          const suppressed = Number(record.suppressAutoThroughRevision || 0);
          if (!force && next.revision <= suppressed) {
            const nextRecord = { ...record, lastCheckAt: now(), error: '' };
            await persist(nextRecord);
            record = nextRecord;
            return publicStatus(record, active, { suppressed: true });
          }
          if (next.revision <= currentRevision) {
            const nextRecord = { ...record, lastCheckAt: now(), error: '' };
            await persist(nextRecord);
            record = nextRecord;
            return publicStatus(record, active, { upToDate: true });
          }
          await commit({
            ...record,
            activeEnvelope: next.envelope,
            activeSource: 'remote',
            previousEnvelope: active?.envelope || null,
            previousSource: active?.source || '',
            lastCheckAt: now(),
            suppressAutoThroughRevision: force || next.revision > suppressed ? 0 : record.suppressAutoThroughRevision,
            error: '',
          }, next);
          return publicStatus(record, active, { updated: true });
        } catch (error) {
          const failures = Array.isArray(error?.failures) ? error.failures : [error];
          const allMissing = failures.length > 0 && failures.every(item => Number(item?.response?.status) === 404);
          const timedOut = failures.some(item => ['ECONNABORTED', 'ETIMEDOUT'].includes(item?.code));
          const message = allMissing ? '在线取源策略尚未发布，继续使用当前策略'
            : timedOut ? '取源更新检查超时，继续使用当前策略'
            : String(error?.message || '取源更新检查失败').replace(/https?:\/\/\S+/g, '[url]');
          const nextRecord = { ...record, lastCheckAt: now(), error: message.slice(0, 200) };
          await persist(nextRecord);
          record = nextRecord;
          return publicStatus(record, active);
        }
      });
    },
    rollback() {
      return serialize(async () => {
        const previous = readPack(record.previousEnvelope, record.previousSource || 'saved');
        if (!previous) return publicStatus(record, active, { success: false, error: '没有可回滚的取源策略' });
        const rolledBackFrom = Number(active?.revision || 0);
        await commit({
          ...record,
          activeEnvelope: previous.envelope,
          activeSource: previous.source,
          previousEnvelope: null,
          previousSource: '',
          suppressAutoThroughRevision: Math.max(Number(record.suppressAutoThroughRevision || 0), rolledBackFrom),
          error: '',
        }, previous);
        return publicStatus(record, active, { rolledBack: true });
      });
    },
  };
}

module.exports = {
  DEFAULT_URL, MIRRORS, CHECK_INTERVAL_MS, PACK_FORMAT, ACTIVE_KEY_ID, STANDBY_KEY_ID,
  SOURCE_PACK_KEYS, canonicalize, decodeEnvelope, validatePack, parsePack,
  createSourcePackService,
};
