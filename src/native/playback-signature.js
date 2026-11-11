// SPDX-License-Identifier: GPL-3.0-only
// Playback-only 551 Argus/Ladon signing; transport and registered identities remain in their existing modules.
// Adapted from N3urda/hongguoTV 7444bb01aec7b0420740103e551c45f1f66101c9,
// kotlin-tv/core/src/main/kotlin/com/hongguotv/core/Argus.kt (blob 9f1b06f16c778f07d1bd9e1f8e9a596590e57213).
// Upstream attributes GPL-3.0-only ch6vip/fqapp rust/src/sign/{argus,simon,ladon,protobuf}.rs.
// Public protocol constants below are not account credentials. Legacy Gorgon/registration code is excluded.
const crypto = require('node:crypto');
const sm3 = require('./sm3');
const LICENSE_ID = 1611921764n;
const SIGN_KEY = Buffer.from('fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304', 'hex');
const AES_KEY = Buffer.from('d31e3718288a1027baab59f146a09a9c', 'hex');
const AES_IV = Buffer.from('ea180a0336ed352fcd24e4d50018ae54', 'hex');
const MAGIC8 = Buffer.from('f2f7fcfff2f7fcff', 'hex');
const TAIL9 = Buffer.from('eafb2cfe8568519154', 'hex');
const u64 = value => BigInt.asUintN(64, value);
const rol64 = (value, bits) => u64((u64(value) << BigInt(bits)) | (u64(value) >> BigInt(64 - bits)));
const ror64 = (value, bits) => rol64(value, 64 - bits);
const integer = value => {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new TypeError('Safe integer or BigInt required');
  return BigInt(value);
};
const le64 = value => { const out = Buffer.alloc(8); out.writeBigUInt64LE(u64(value)); return out; };
function varint(value) {
  let n = BigInt.asUintN(32, integer(value));
  const out = [];
  while (n >= 128n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
  out.push(Number(n));
  return Buffer.from(out);
}
class ProtoBuf {
  constructor() { this.parts = []; }
  putVarint(tag, value) { this.parts.push(varint(BigInt(tag) << 3n), varint(value)); return this; }
  putBytes(tag, bytes) { const value = Buffer.from(bytes); this.parts.push(varint((BigInt(tag) << 3n) | 2n), varint(value.length), value); return this; }
  putUtf8(tag, value) { return this.putBytes(tag, Buffer.from(value, 'utf8')); }
  putProtobuf(tag, value) { return this.putBytes(tag, value.toBuf()); }
  toBuf() { return Buffer.concat(this.parts); }
}
// The code uses four u64 key words and two u64 block words, despite the upstream size comment.
const Simon = {
  keyExpansion(key) {
    if (!Array.isArray(key) || key.length !== 4) throw new TypeError('Four Simon key words required');
    const expanded = key.map(value => u64(integer(value)));
    for (let i = 4; i < 72; i++) {
      let tmp = ror64(expanded[i - 1], 3) ^ expanded[i - 3];
      tmp ^= ror64(tmp, 1);
      const bit = (0x3dc94c3a046d678bn >> BigInt((i - 4) % 62)) & 1n;
      expanded.push(u64(~expanded[i - 4] ^ tmp ^ bit ^ 3n));
    }
    return expanded;
  },
  encrypt(left, right, key) {
    let x = u64(integer(left)), y = u64(integer(right));
    for (const roundKey of Simon.keyExpansion(key)) {
      const previous = y;
      y = u64(x ^ (rol64(y, 1) & rol64(y, 8)) ^ rol64(y, 2) ^ roundKey);
      x = previous;
    }
    return [x, y];
  },
};
const pad16 = data => Buffer.concat([data, Buffer.alloc(16 - data.length % 16, 16 - data.length % 16)]);
function queryParam(query, name) {
  const decode = value => { try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; } };
  for (const part of query.split('&')) {
    const at = part.indexOf('='), key = at < 0 ? part : part.slice(0, at);
    if (decode(key) === name) return decode(at < 0 ? '' : part.slice(at + 1));
  }
  return null;
}
const Argus = {
  bodyHash(stubHex) {
    if (!stubHex) return sm3(Buffer.alloc(16)).subarray(0, 6);
    const bytes = /^(?:[a-f\d]{2})+$/i.test(stubHex) ? Buffer.from(stubHex, 'hex') : Buffer.alloc(0);
    return sm3(bytes).subarray(0, 6);
  },
  queryHash(query) { return sm3(query ? Buffer.from(query, 'utf8') : Buffer.alloc(16)).subarray(0, 6); },
  sign(query, stubHex, ts, aid, licenseId, deviceId, installId, randField) {
    if (typeof query !== 'string' || typeof stubHex !== 'string' || typeof deviceId !== 'string' || typeof installId !== 'string') throw new TypeError('String protocol fields required');
    const bean = new ProtoBuf().putVarint(1, 1077940818).putVarint(2, 2).putVarint(3, randField)
      .putUtf8(4, String(integer(aid) === 0n ? 1967n : integer(aid))).putUtf8(5, deviceId)
      .putUtf8(6, String(integer(licenseId) === 0n ? LICENSE_ID : integer(licenseId)))
      .putUtf8(7, queryParam(query, 'version_name') || '').putUtf8(8, 'v04.04.05-ov-android')
      .putVarint(9, 134744640).putBytes(10, Buffer.alloc(8)).putVarint(11, 0).putVarint(12, integer(ts) << 1n)
      .putBytes(13, Argus.bodyHash(stubHex)).putBytes(14, Argus.queryHash(query))
      .putProtobuf(15, new ProtoBuf().putVarint(1, 1).putVarint(2, 1).putVarint(3, 1).putVarint(7, 0xc792eccc))
      .putUtf8(16, installId).putUtf8(20, 'none').putVarint(21, 738)
      .putProtobuf(23, new ProtoBuf().putUtf8(1, 'NX551J').putVarint(2, 8196).putVarint(4, 0x80e0d800)).putVarint(25, 2);
    const protobuf = pad16(bean.toBuf()), key = Array.from({ length: 4 }, (_, i) => SIGN_KEY.readBigUInt64LE(i * 8));
    const blocks = [];
    for (let at = 0; at < protobuf.length; at += 16) {
      const encrypted = Simon.encrypt(protobuf.readBigUInt64LE(at), protobuf.readBigUInt64LE(at + 8), key);
      blocks.push(le64(encrypted[0]), le64(encrypted[1]));
    }
    const framed = Buffer.concat([MAGIC8, ...blocks, TAIL9]);
    for (let i = 8; i < framed.length; i++) framed[i] ^= MAGIC8[i % 8];
    const padded = pad16(Buffer.concat([framed.reverse(), Buffer.from('ao', 'ascii')]));
    const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
    cipher.setAutoPadding(false);
    return Buffer.concat([Buffer.from('f281', 'hex'), cipher.update(padded), cipher.final()]).toString('base64');
  },
};
const Ladon = {
  encrypt(ts, licenseId, aid, randomBytes) {
    if (!Buffer.isBuffer(randomBytes) || randomBytes.length !== 4) throw new TypeError('Four Ladon random bytes required');
    const aidText = integer(aid).toString();
    const digest = crypto.createHash('md5').update(Buffer.concat([randomBytes, Buffer.from(aidText)])).digest('hex');
    const ascii = Buffer.from(digest, 'ascii'), words = Array.from({ length: 4 }, (_, i) => ascii.readBigUInt64LE(i * 8));
    const table = [words[0]], queue = words.slice(2);
    let b0 = words[0], b8 = words[1];
    for (let i = 0; i < 34; i++) {
      let x8 = u64(ror64(b8, 8) + b0) ^ BigInt(i);
      queue.push(x8);
      x8 ^= rol64(b0, 3);
      table.push(u64(x8)); b0 = u64(x8); b8 = queue.shift();
    }
    const input = pad16(Buffer.from(`${integer(ts)}-${integer(licenseId)}-${aidText}`, 'ascii')), out = Buffer.alloc(input.length);
    for (let at = 0; at < input.length; at += 16) {
      let a = input.readBigUInt64LE(at), b = input.readBigUInt64LE(at + 8);
      for (let i = 0; i < 34; i++) { b = table[i] ^ u64(a + ror64(b, 8)); a = b ^ rol64(a, 3); }
      out.writeBigUInt64LE(u64(a), at); out.writeBigUInt64LE(u64(b), at + 8);
    }
    return Buffer.concat([randomBytes, out]).toString('base64');
  },
};
function signPlayer({ query, body = null, ts, randField, ladonRandom }) {
  if (typeof query !== 'string' || body !== null && !Buffer.isBuffer(body)) throw new TypeError('Final query string and raw Buffer body required');
  const aidValue = queryParam(query, 'aid');
  let aid = 1967n;
  if (/^[+-]?\d+$/.test(aidValue || '')) {
    const candidate = BigInt(aidValue);
    if (candidate >= -(1n << 63n) && candidate < 1n << 63n) aid = candidate;
  }
  const timestamp = integer(ts), stub = body?.length ? crypto.createHash('md5').update(body).digest('hex') : '';
  if (randField === undefined) randField = crypto.randomBytes(4).readInt32LE();
  if (ladonRandom === undefined) ladonRandom = crypto.randomBytes(4);
  const headers = { 'x-ss-req-ticket': String(timestamp * 1000n), 'x-khronos': String(timestamp),
    'x-ladon': Ladon.encrypt(timestamp, LICENSE_ID, aid, ladonRandom),
    'x-argus': Argus.sign(query, stub, timestamp, aid, LICENSE_ID, queryParam(query, 'device_id') || '', '', randField) };
  if (stub) headers['x-ss-stub'] = stub;
  return headers;
}
module.exports = { signPlayer, Argus, Ladon, ProtoBuf, Simon };
