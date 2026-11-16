// SPDX-License-Identifier: GPL-3.0-only
// Offline synthetic vectors: N3urda/hongguoTV 18c37c2afd0567520135abcae312352542f09083.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { gzipSync } = require('node:zlib');
const sm3 = require('./sm3');
const filename = __dirname + '/playback-v5.js';
const fixtures = __dirname + '/fixtures/playback-v5-vectors/';
const NOW = 1800000000000;
const BASE = 'https://example.test/model';
const VALUES = Object.freeze({ aid: '8662', app_name: 'novelread',
  device_id: '1234567890123456789', iid: '2234567890123456789', cdid: 'synthetic-device',
  version_name: '7.4.3.32', channel: 'vivo_8662_64', os_version: '12', device_type: 'PGT-AN10',
  _rticket: '1', text: '中文 !*\'()~ +&=%', empty: '' });
const BODY = gzipSync(Buffer.from('{"mixed_video_id_map":{"1004":["123"]},"dr_scene":"player"}'));

function load(options = {}) {
  const realRequire = createRequire(filename);
  const messages = [];
  let hashes = 0, clocks = 0, randoms = 0;
  class FixedDate extends Date { static now() { clocks++; return options.now ?? NOW; } }
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, Buffer, URL, Date: FixedDate,
    require(name) {
      if (name === 'node:crypto') return { ...crypto, randomBytes(n) {
        randoms++;
        return Buffer.alloc(n, options.randomByte ?? 0x80);
      } };
      if (name === './sm3') return input => {
        hashes++;
        return options.hash ? options.hash(input, hashes) : sm3(input);
      };
      return realRequire(name);
    },
    capture: message => messages.push(Buffer.from(message)),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
    const originalXmxor = xmxor;
    xmxor = (message, key) => { capture(message); return originalXmxor(message, key); };
    module.exports.__test = { hashF13, CarrierV5, getIv, le32, helios };
  `, context, { filename });
  return { ...module.exports, messages, counts: () => ({ hashes, clocks, randoms }) };
}

// Independent wire reader: inspect the bytes actually supplied to the envelope transform.
function fields(bytes) {
  let offset = 0;
  const result = new Map();
  function uint() {
    let value = 0n, shift = 0n;
    while (offset < bytes.length && shift < 70n) {
      const next = bytes[offset++];
      value |= BigInt(next & 127) << shift;
      if (!(next & 128)) return value;
      shift += 7n;
    }
    throw Error('Invalid synthetic protobuf');
  }
  while (offset < bytes.length) {
    const tag = Number(uint()), type = tag & 7;
    let value;
    if (type === 0) value = uint();
    else {
      assert.equal(type, 2);
      const length = Number(uint());
      assert.ok(offset + length <= bytes.length);
      value = bytes.subarray(offset, offset + length);
      offset += length;
    }
    assert.ok(!result.has(tag >>> 3));
    result.set(tag >>> 3, value);
  }
  return result;
}
const text = (message, tag) => message.get(tag)?.toString();
const sint = (message, tag) => Number(message.get(tag) >> 1n);
const md5 = bytes => crypto.createHash('md5').update(bytes).digest();

function ivFold(initial, bytes) {
  let value = initial;
  for (const [i, byte] of bytes.entries()) value = i % 2 === 0
    ? ((value >>> 4) ^ value ^ (value << 6) ^ byte) >>> 0
    : ~((value >>> 7) ^ value ^ (byte | (value << 12))) >>> 0;
  return value;
}
function branch(query, body, ts) {
  const time = Buffer.alloc(4); time.writeUInt32LE(ts);
  return ivFold(ivFold(ivFold(0x20230928, sm3(Buffer.from(query))), md5(body)), time) & 15;
}
function messageFor(api, input = {}) {
  const signed = api.signPlaybackV5({ base: BASE, values: VALUES, body: BODY, now: NOW, ...input });
  return { signed, message: fields(api.messages.at(-1)) };
}

test('only the playback entry point is exported; normal Node loading needs no SDK', () => {
  const api = require('./playback-v5');
  assert.deepEqual(Object.keys(api), ['signPlaybackV5']);
  assert.equal(typeof api.signPlaybackV5, 'function');
  const request = api.signPlaybackV5({ base: BASE, values: VALUES, body: BODY, now: NOW });
  assert.equal(new URL(request.url).origin, 'https://example.test');
});

test('cross-realm plain options and values work, but class instances and custom prototypes stay rejected', () => {
  const { signPlaybackV5 } = require('./playback-v5');
  const input = vm.runInNewContext('({ base, values: JSON.parse(valuesJson), body, now })', {
    base: BASE, valuesJson: JSON.stringify(VALUES), body: BODY, now: NOW,
  });
  assert.notEqual(Object.getPrototypeOf(input), Object.prototype);
  assert.notEqual(Object.getPrototypeOf(input.values), Object.prototype);
  assert.ok(Buffer.isBuffer(input.body));
  const request = signPlaybackV5(input), query = new URL(request.url).searchParams;
  assert.equal(query.get('device_id'), VALUES.device_id);
  assert.equal(query.get('cdid'), 'synthetic-device');
  assert.equal(query.get('ts'), null);
  const invalidRecords = [Object.create({ inherited: true }), new (class Profile {})()];
  for (const record of invalidRecords) {
    Object.assign(record, VALUES);
    assert.throws(() => signPlaybackV5({ ...input, values: record }), /plain string record/);
    Object.assign(record, input);
    assert.throws(() => signPlaybackV5(record), /signing options/);
  }
});

test('independent f13 vectors match all 32 timestamp rotation classes', () => {
  const api = load().__test;
  const rows = JSON.parse(fs.readFileSync(fixtures + 'signing-v5-f13.json'));
  assert.equal(rows.length, 32);
  assert.equal(new Set(rows.map(row => row.ts & 31)).size, 32);
  for (const [index, row] of rows.entries()) {
    const actual = api.hashF13(Buffer.from(row.query, 'hex'), Buffer.from(row.body, 'hex'), row.ts);
    assert.ok(actual.subarray(0, 16).equals(Buffer.from(row.digest, 'hex')), `f13 timestamp class ${index}`);
    assert.equal(actual.length, 20);
    assert.equal(actual[16] & 0x24, 0x24);
  }
  const row = rows[0];
  const wrong = Buffer.from(row.query, 'hex');
  let rejected = false;
  for (let i = 0; i < 256; i++) {
    wrong[0] = i;
    const body = Buffer.from(row.body, 'hex');
    if ((api.getIv(api.getIv(api.getIv(0x20230928, wrong), body), api.le32(row.ts)) & 15) === 12) continue;
    assert.throws(() => api.hashF13(wrong, body, row.ts), /Unsupported v5 hash branch/);
    rejected = true; break;
  }
  assert.ok(rejected);
});

test('independent carrier vectors match all four timestamp permutations, without changing source', () => {
  const { CarrierV5 } = load().__test;
  const rows = JSON.parse(fs.readFileSync(fixtures + 'signing-v5-carrier.json'));
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(row => row.ts & 3)).size, 4);
  for (const [index, row] of rows.entries()) {
    const source = Buffer.from(row.source, 'hex'), before = Buffer.from(source);
    const actual = new CarrierV5(Buffer.from(row.key, 'hex'), row.ts).encrypt(source, Buffer.from(row.iv, 'hex'));
    assert.ok(actual.equals(Buffer.from(row.encrypted, 'hex')), `carrier permutation ${index}`);
    assert.ok(source.equals(before));
    assert.equal(actual.length, source.length + 1);
  }
});

test('final encoded query, exact gzip bytes and original second bind all 32 classes', () => {
  const api = load();
  const beforeBody = Buffer.from(BODY), beforeValues = JSON.stringify(VALUES);
  for (let i = 0; i < 32; i++) {
    const now = NOW + i * 1000 + 999, ts = Math.floor(now / 1000);
    const { signed, message } = messageFor(api, { now });
    const url = new URL(signed.url), query = signed.url.split('?')[1];
    const ticket = Number(url.searchParams.get('_rticket'));
    assert.ok(ticket >= now && ticket <= now + 1023);
    for (let previous = now; previous < ticket; previous++) {
      const candidate = query.replace(/_rticket=\d+/, '_rticket=' + previous);
      assert.notEqual(branch(candidate, BODY, ts), 12, 'must choose first matching ticket');
    }
    assert.equal(branch(query, BODY, ts), 12);
    for (const [key, value] of Object.entries(VALUES)) if (key !== '_rticket') assert.equal(url.searchParams.get(key), value);
    assert.ok(query.includes('text=%E4%B8%AD%E6%96%87%20%21*%27%28%29~%20%2B%26%3D%25'));
    assert.equal(url.searchParams.get('ts'), null);
    assert.equal(signed.headers['x-khronos'], String(ts));
    assert.equal(signed.headers['x-ss-req-ticket'], String(ticket));
    assert.ok(signed.headers['x-ss-stub'] === md5(BODY).toString('hex').toUpperCase());
    assert.equal(sint(message, 12), ts); assert.equal(sint(message, 17), ts);
    assert.ok(message.get(14).equals(sm3(Buffer.from(query)).subarray(0, 6)));
    assert.ok(message.get(13).equals(api.__test.hashF13(sm3(Buffer.from(query)), md5(BODY), ts)));
    assert.equal(sint(message, 3), 0x80808080, 'random u32 must not become signed');
    const prefix = Buffer.from(signed.headers['x-medusa'], 'base64').subarray(0, 20);
    const time = api.__test.le32(ts);
    for (let at = 0; at < prefix.length; at++) prefix[at] ^= time[at & 3];
    assert.equal(prefix.readUInt32LE(), 5);
    assert.ok(prefix.subarray(4).equals(Buffer.from('2d4b4fca49750d433fb5ae2c226dcc56', 'hex')));
    assert.deepEqual(Object.keys(signed.headers).sort(), ['x-helios', 'x-khronos', 'x-medusa', 'x-ss-req-ticket', 'x-ss-stub']);
  }
  assert.ok(BODY.equals(beforeBody)); assert.equal(JSON.stringify(VALUES), beforeValues);
});

test('registered identity and profile enter both query and serialized Medusa, with no fallback identity', () => {
  const api = load();
  for (const identity of [VALUES, { ...VALUES, device_id: '3234567890123456789', iid: '4234567890123456789',
    cdid: 'synthetic-other', version_name: '7.5.1.32', device_type: 'synthetic-model', os_version: '16', channel: 'synthetic-channel' }]) {
    const { signed, message } = messageFor(api, { values: identity });
    const query = new URL(signed.url).searchParams, env = fields(message.get(23)), device = fields(env.get(12));
    for (const key of ['device_id', 'iid', 'cdid']) assert.equal(query.get(key), identity[key]);
    assert.equal(text(message, 5), identity.device_id); assert.equal(text(device, 4), identity.device_id);
    assert.equal(text(message, 7), identity.version_name); assert.equal(text(env, 14), identity.version_name);
    assert.equal(text(env, 8), identity.channel); assert.equal(text(device, 22), identity.os_version);
    assert.equal(text(device, 30), identity.device_type); assert.equal(text(device, 32), identity.device_type);
    assert.equal(text(message, 6), '646637794'); assert.equal(sint(message, 2), 5);
    assert.equal(sint(message, 9), 0x040a0300); assert.equal(sint(message, 21), 377);
    assert.ok(message.get(10).equals(Buffer.alloc(8))); assert.equal(sint(device, 25), NOW);
  }
});

test('body bytes, query bytes, iid and cdid each affect signatures with randomness held fixed', () => {
  const api = load();
  const first = messageFor(api);
  const variants = [
    { body: gzipSync(Buffer.from('{"mixed_video_id_map":{"1004":["124"]}}')) },
    { values: { ...VALUES, extra: 'one' } },
    { values: { ...VALUES, iid: '5234567890123456789' } },
    { values: { ...VALUES, cdid: 'synthetic-another' } },
  ];
  const samePayload = Buffer.from(BODY); samePayload.writeUInt32LE(123, 4);
  variants.push({ body: samePayload });
  for (const input of variants) {
    const next = messageFor(api, input);
    assert.ok(first.signed.headers['x-medusa'] !== next.signed.headers['x-medusa']);
    assert.ok(!first.message.get(13).equals(next.message.get(13)));
    assert.ok(first.signed.headers['x-helios'] === next.signed.headers['x-helios']);
  }
  const time = messageFor(api, { now: NOW + 1000 });
  assert.ok(first.signed.headers['x-helios'] !== time.signed.headers['x-helios']);
});

test('Helios independently decrypts to the original timestamp, v5 license and aid', () => {
  const api = load();
  const signed = messageFor(api, { now: NOW + 999 }).signed;
  const encrypted = Buffer.from(signed.headers['x-helios'], 'base64');
  const ascii = Buffer.from(md5(Buffer.concat([encrypted.subarray(0, 4), Buffer.from('8662')])).toString('hex'));
  const mask = (1n << 64n) - 1n;
  const rotate = (value, n) => ((value << BigInt(n)) | (value >> BigInt(64 - n))) & mask;
  const keys = [ascii.readBigUInt64LE(0)];
  const queue = [ascii.readBigUInt64LE(8), ascii.readBigUInt64LE(16), ascii.readBigUInt64LE(24)];
  for (let i = 0; i < 33; i++) {
    const l = (((rotate(queue.shift(), 56) + keys[i]) & mask) ^ BigInt(i));
    queue.push(l); keys.push(rotate(keys[i], 3) ^ l);
  }
  const plain = Buffer.alloc(encrypted.length - 4);
  for (let at = 4; at < encrypted.length; at += 16) {
    let a = encrypted.readBigUInt64LE(at), b = encrypted.readBigUInt64LE(at + 8);
    for (let round = 33; round >= 0; round--) {
      const oldA = rotate(a ^ b, 61);
      b = rotate(((b ^ keys[round]) - oldA) & mask, 8); a = oldA;
    }
    plain.writeBigUInt64LE(a, at - 4); plain.writeBigUInt64LE(b, at + 4);
  }
  const padding = plain.at(-1);
  assert.ok(padding > 0 && padding <= 16);
  assert.ok(plain.subarray(-padding).equals(Buffer.alloc(padding, padding)));
  assert.ok(plain.subarray(0, -padding).equals(Buffer.from('1800000000-646637794-8662')));
});

test('ticket search stops after exactly 1024 misses without randomness or clock retries', () => {
  // Inject only the hash dependency, forcing a branch miss for every query.
  const time = Buffer.alloc(4); time.writeUInt32LE(NOW / 1000);
  let forced;
  for (let i = 0; i < 256; i++) {
    const candidate = Buffer.alloc(32, i);
    if ((ivFold(ivFold(ivFold(0x20230928, candidate), md5(BODY)), time) & 15) !== 12) { forced = candidate; break; }
  }
  assert.ok(forced);
  const api = load({ hash: () => forced });
  const before = api.counts();
  assert.throws(() => api.signPlaybackV5({ base: BASE, values: VALUES, body: BODY, now: NOW }), /1024/);
  const after = api.counts();
  assert.equal(after.hashes - before.hashes, 1024);
  assert.equal(after.clocks, before.clocks); assert.equal(after.randoms, before.randoms);
  assert.equal(api.messages.length, 0);
});

test('last allowed ticket succeeds, default now is sampled once and explicit query ts stays unified', () => {
  const time = Buffer.alloc(4); time.writeUInt32LE(NOW / 1000);
  let hit, miss;
  for (let i = 0; i < 256; i++) {
    const candidate = Buffer.alloc(32, i);
    const low = ivFold(ivFold(ivFold(0x20230928, candidate), md5(BODY)), time) & 15;
    if (low === 12) hit = candidate; else miss = candidate;
    if (hit && miss) break;
  }
  assert.ok(hit && miss);
  const api = load({ hash: (_, count) => count < 1024 ? miss : hit });
  const before = api.counts();
  const result = api.signPlaybackV5({ base: BASE, values: { ...VALUES, ts: '1' }, body: BODY });
  assert.equal(Number(new URL(result.url).searchParams.get('_rticket')), NOW + 1023);
  assert.equal(new URL(result.url).searchParams.get('ts'), String(NOW / 1000));
  assert.equal(api.counts().clocks - before.clocks, 1);
});

test('strict inputs reject malformed URLs, imprecise identities, non-string queries and non-gzip bodies', () => {
  const api = load();
  const valid = { base: BASE, values: VALUES, body: BODY, now: NOW };
  const invalid = [null, [], {}, { ...valid, base: 'http://example.test/model' },
    ...['https://u:p@example.test/model', BASE + '?x=1', BASE + '#x', BASE + '?', BASE + '#', BASE + ' ',
      'https://example.test:444/model'].map(base => ({ ...valid, base })),
    ...[null, [], 'text', { ...VALUES, iid: 123 }, { ...VALUES, device_id: '0' }, { ...VALUES, device_id: '1.2' },
      { ...VALUES, cdid: '' }, { ...VALUES, version_name: '' }, { ...VALUES, aid: '1' },
      { ...VALUES, device_id: '9'.repeat(31) }, { ...VALUES, nested: {} }, { ...VALUES, bad: '\ud800' },
      { ...VALUES, empty: undefined }, { ...VALUES, x: 'a\nb' }].map(values => ({ ...valid, values })),
    ...[undefined, null, '', Buffer.alloc(0), new Uint8Array(BODY), Buffer.from('{}'),
      BODY.subarray(0, 10), Buffer.concat([BODY.subarray(0, -1), Buffer.from([BODY.at(-1) ^ 1])])].map(body => ({ ...valid, body })),
    ...[null, '1800000000000', -1, NaN, Infinity, NOW + 0.1, Number.MAX_SAFE_INTEGER, 0x100000000 * 1000]
      .map(now => ({ ...valid, now })),
  ];
  const accessor = { ...VALUES };
  Object.defineProperty(accessor, 'device_id', { enumerable: true, get() { throw Error('must not invoke getter'); } });
  invalid.push({ ...valid, values: accessor });
  invalid.push({ ...valid, values: { ...VALUES, [Symbol('hidden')]: 'bad' } });
  for (const [index, input] of invalid.entries()) {
    let error;
    try { api.signPlaybackV5(input); } catch (caught) { error = caught; }
    assert.ok(error && /^(TypeError|RangeError)$/.test(error.name), `invalid input ${index}`);
    assert.ok(!error.message.includes(VALUES.device_id), 'errors must not contain identities');
  }
});
