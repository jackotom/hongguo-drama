// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePolicy, setPolicy } = require('./source-policy');

const DEFAULT_URL = 'https://raw.githubusercontent.com/jackotom/hongguo-drama/main/source-packs/hongguo-playback.pack.json';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_PACK_BYTES = 256 * 1024;
const PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEAjuRI96E/T54X9FP806UEfoS1cwnWPsvPAnePBFSWA6M=';
const DEFAULT_PUBLIC_KEY = crypto.createPublicKey({ key: Buffer.from(PUBLIC_KEY_BASE64, 'base64'), format: 'der', type: 'spki' });

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function decodeEnvelope(envelope, publicKey) {
  if (!envelope || typeof envelope !== 'object' || envelope.format !== 1) throw new Error('取源更新包格式无效');
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('取源更新包缺少签名');
  if (envelope.payload.length > MAX_PACK_BYTES * 2 || envelope.signature.length > 256) throw new Error('取源更新包过大');
  const raw = Buffer.from(envelope.payload, 'base64');
  if (!raw.length || raw.length > MAX_PACK_BYTES) throw new Error('取源更新包过大');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (!crypto.verify(null, raw, publicKey, signature)) throw new Error('取源更新包签名校验失败');
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new Error('取源更新包内容不是有效 JSON'); }
  if (canonicalize(payload) !== raw.toString('utf8')) throw new Error('取源更新包不是规范 JSON');
  return { payload, raw };
}

function validatePack(payload) {
  if (!payload || typeof payload !== 'object' || payload.format !== 1
      || payload.id !== 'hongguo-playback') throw new Error('取源更新包类型无效');
  const revision = Number(payload.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('取源更新包版本无效');
  const issuedAt = Date.parse(payload.issuedAt);
  if (!Number.isFinite(issuedAt)) throw new Error('取源更新包发布时间无效');
  if (payload.expiresAt != null && (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now())) {
    throw new Error('取源更新包已过期');
  }
  const policy = normalizePolicy({ revision, routes: payload.policy?.routes });
  return {
    format: 1,
    id: 'hongguo-playback',
    revision,
    issuedAt: new Date(issuedAt).toISOString(),
    ...(payload.expiresAt ? { expiresAt: new Date(Date.parse(payload.expiresAt)).toISOString() } : {}),
    policy,
  };
}

function publicStatus(record, extra = {}) {
  const active = record?.active;
  return {
    success: true,
    enabled: record?.enabled !== false,
    revision: active?.revision || 0,
    issuedAt: active?.issuedAt || '',
    source: active ? active.source : 'embedded',
    lastCheckAt: record?.lastCheckAt || 0,
    canRollback: !!record?.previous,
    error: record?.error || '',
    ...extra,
  };
}

function createSourcePackService({
  filePath, publicKey, request, now = Date.now, bundledEnvelope,
}) {
  const statePath = path.resolve(filePath);
  let record = { enabled: true, active: null, previous: null, lastCheckAt: 0, error: '' };
  let writeChain = Promise.resolve();

  function verify(envelope, source) {
    const { payload } = decodeEnvelope(envelope, publicKey);
    const pack = validatePack(payload);
    setPolicy(pack.policy);
    return {
      ...pack,
      source,
    };
  }

  function persist() {
    const snapshot = JSON.stringify(record, null, 2);
    writeChain = writeChain.then(async () => {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const temp = `${statePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, snapshot, { mode: 0o600 });
      await fs.promises.rename(temp, statePath);
    });
    return writeChain;
  }

  function applyRecord(next) {
    record = next;
    if (record.active) setPolicy(record.active.policy);
    else if (bundledEnvelope) record.active = verify(bundledEnvelope, 'embedded');
    return publicStatus(record);
  }

  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (saved && typeof saved === 'object') record = { ...record, ...saved };
  } catch {}
  if (record.active?.policy) {
    try {
      const pack = validatePack({ format: 1, id: 'hongguo-playback',
        revision: record.active.revision, issuedAt: record.active.issuedAt,
        expiresAt: record.active.expiresAt, policy: { routes: record.active.policy.routes } });
      record.active = { ...pack, source: record.active.source || 'saved' };
      setPolicy(pack.policy);
    } catch {
      record.active = null;
      record.error = '已保存的取源策略校验失败，改用内置策略';
    }
  } else if (bundledEnvelope) {
    try { record.active = verify(bundledEnvelope, 'embedded'); } catch { record.active = null; }
  }

  return {
    status() { return publicStatus(record); },
    async setEnabled(enabled) {
      record = { ...record, enabled: enabled !== false, error: '' };
      await persist();
      return publicStatus(record);
    },
    async check({ force = false } = {}) {
      if (record.enabled === false) return publicStatus(record, { error: '自动获取播放源已关闭' });
      if (!force && now() - Number(record.lastCheckAt || 0) < CHECK_INTERVAL_MS) return publicStatus(record);
      try {
        const response = await request(DEFAULT_URL, {
          timeout: 12000, responseType: 'json', maxContentLength: MAX_PACK_BYTES,
          maxBodyLength: 1024, headers: { Accept: 'application/json', 'User-Agent': 'hongguo-drama-source-pack/1' },
        });
        const next = verify(response.data, 'remote');
        const currentRevision = Number(record.active?.revision || 0);
        if (next.revision <= currentRevision) {
          record = { ...record, lastCheckAt: now(), error: '' };
          await persist();
          return publicStatus(record, { upToDate: true });
        }
        record = { ...record, previous: record.active || null, active: next, lastCheckAt: now(), error: '' };
        setPolicy(next.policy);
        await persist();
        return publicStatus(record, { updated: true });
      } catch (error) {
        const status = Number(error?.response?.status);
        const message = status === 404 ? '在线取源策略尚未发布，继续使用当前策略'
          : ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code) ? '取源更新检查超时，继续使用当前策略'
          : String(error?.message || '取源更新检查失败').replace(/https?:\/\/\S+/g, '[url]');
        record = { ...record, lastCheckAt: now(), error: message.slice(0, 200) };
        await persist();
        return publicStatus(record);
      }
    },
    async rollback() {
      if (!record.previous) return publicStatus(record, { success: false, error: '没有可回滚的取源策略' });
      record = { ...record, active: record.previous, previous: null, error: '' };
      setPolicy(record.active.policy);
      await persist();
      return publicStatus(record, { rolledBack: true });
    },
  };
}

module.exports = {
  DEFAULT_URL, CHECK_INTERVAL_MS, DEFAULT_PUBLIC_KEY, canonicalize, decodeEnvelope, validatePack,
  createSourcePackService,
};
