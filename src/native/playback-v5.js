// SPDX-License-Identifier: GPL-3.0-only
// Port of N3urda/hongguoTV 18c37c2afd0567520135abcae312352542f09083:
// Signer.kt, AesV3.kt, V5Constants.kt; originally drpys 22261ad (GPL-3.0).
// Public wire constants, no captured sessions, SDK, VM or PolyForm implementation.
'use strict';

const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const sm3 = require('./sm3');
const PROCESS_NONCE = crypto.randomBytes(18).toString('base64url');
const PROCESS_STARTED = Date.now();
const MAGIC = Buffer.from('2d4b4fca49750d433fb5ae2c226dcc56', 'hex');
const SIGN_KEY = Buffer.from('b23c2a470a20d105dc3f8c4438f8272ed46d6c89ffdcdedd5108698d26e9489d', 'hex');
const SBOX = Buffer.from('53290fe9e51f316f90f74a7e034d367784ab49237cd0135cdc632c322fd3be0e2624a417ecd9151a7ff64f60730a87f9445ec6ada2f865d22b696c4188f24c0df37b75510b939f6bc2fe6883e68bc8c722181ba0bdb08c9871b50c9a16b46eea8eed20ba4b8a14e0fcf1468dbbef05a93e5a9d7dcf06898635c1fd99f5de287a80c594daaab19b6279fbd75070cb52eb2555c456e39e7839853874e2f0013ac0b64742d8ca10e4b79c955de8b843ce4ed464a6a72ed508091c92e7b3eedd1e1dd12afac321618fa3d65f9167c982f43d66a53c6a1997585b346dbf9672ff37cdbc073b2dae11453304df00815476b2a13fccdb30b957a8acafe127400248591238922563e36406d37a24100b7902a028044e218453c2a399199c9d13dc40c55ba67e502273850ebdc1a2e2188b8f2d9e3cb909b8c46a2a9f4a6dd93007eafa65b7b3a881aa908cc74f0ad76bbbb58617c37012ca05a469fd44e62eecf1e4272ce860c0ae5eadf99b20d8f0234174006f3f110d7657d01645d4eff8f71471cbfe1cb2f52648727bf3c9de55153e031b4d61757db63dbf7782eeafe9018a8891362fb14759ac32bab03b349aeb5a377c5156be4c8dfbe13a684bda39cf836697c894545fe0f2491acea9fc6252f4ff1e0fe72bd2df6e67a7f635e5bcc6d1a5dd951d89960887a18eb40c785cdb1f80ed42299333ab98cdd67f316cd54346585dccd759fb722789b08807cc0fda293f7e5e1819bb0353517020b31d3d00374952bea2c421e862040a9ec892a05b266b7a0d0cc316f483b81af39715657ffe32ad8de0c13077646035236ee5363e5f900e9a7cf850a81cd9960b6df73317226f99eaa6fff15cec34acb98246639b918ab2851466a7cdfc4ad1b52c2ae95a58d3734e47ddd5b7560193f644ef9c408b7dee39b4d6aabf4de761e3252d4c7ba3843187745d55e6a5db05d42b45caed43c0c5d0b64bfa9d94a4a9d8f2f0e1a108dcfd288fd2bc1fc7bd675412138169cb09249875ba3b68cfb11180afae104fc9789571c6dfce02413886796ae21e3c488cc21b9f423a066c2eabf98e2fdeeb5776e4f5d09a515ba58cbbab3e37b09fd4f6d9244df80512e84cd7956be301cf64f1429d58577cc241f3a2c655144f81aaf95a4e108da894b38970561ae9002619fbbac91fa922ed202bfc62cb08e0de2a7f3631435f8b47c8a3c563b4db4071ce74c46da6fa696a9e282d1e825d663b93bfd56c48dce1884bb10fccea063929f746443fd830a4232e53da21a1f2d1bdfebc3a02c10a1b8ad31d04fd616590d272ac737e98eb33af60528716bee78ec0ee8699031177277d9cff32542c67caf5f44591681335ae0e178f3409a7803db83892dde5b9b7f0c750e24aef077badd678a09b850b84ec1597e4963cb5e675df1c0d6fb618496ecd76c35c798325590c2fb27a5e', 'hex');
const HASH_TABLE = [0xebb64faf,0x7aadcc2,0xcf3187bf,0xe01138ff,0x6d0bfcff,0x5a30a3be,0xb41ad638,0x34180eb8,0xf233eb6f,0xb1a584cc,0xccc30dc7,0x47d1db51,0xd55653de,0x70a84fa1,0x57473c12,0xf76f0288,0x2c077f0a,0xda0dcad0,0xfbb86f6c,0xfdc4cf00,0x688a020d,0xe676c6a6,0x8cd6338b,0x1a3c8d0e,0xcce8b06b,0x6ad0ed0b,0xa0522717,0xdc71ac83,0x2285db71,0xd5b4dda6,0x736f8650,0x6560306c,0x617ce2a6,0xe423417e,0xa40e143,0x544e4032,0x88dffb2a,0x716c1ae0,0x4c467a88,0x5b23bb3,0xe1d0b866,0xbaa3dcb8,0xae3374d3,0xc3381a50,0x1702f75b,0xfe6da368,0xf0b4cf48,0x4e0ffbb8,0x72aad10d,0x26c53a3d,0xf2bce0f6,0xb4557581,0x4a257fdd,0x8c3182a2,0xab0b3b86,0x3d5dfb14,0x4f103634,0xd37b52d7,0x444eff16,0xeb0a33d1,0x6ca86f6e,0x284ba7,0x8387cfa,0x5fb37586];
const md5 = value => crypto.createHash('md5').update(value).digest();
const random32 = () => crypto.randomBytes(4).readUInt32LE();
const rol32 = (value, count) => ((value << (count & 31)) | (value >>> ((32 - count) & 31))) >>> 0;
const ror32 = (value, count) => rol32(value, -count);
const u64 = value => BigInt.asUintN(64, value);
const ror64 = (value, count) => u64((value >> BigInt(count)) | (value << BigInt(64 - count)));
function le32(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out; }
function xor(a, b) { return Buffer.from(a.map((value, i) => value ^ b[i])); }
function varint(value) {
  let n = BigInt(value);
  const out = [];
  while (n > 127n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
  out.push(Number(n));
  return Buffer.from(out);
}
function proto(fields) {
  return Buffer.concat(fields.map(([tag, value, type]) => {
    if (type === 'sint') {
      const n = BigInt(value);
      return Buffer.concat([varint(tag * 8), varint(n < 0n ? -n * 2n - 1n : n * 2n)]);
    }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return bytes.length ? Buffer.concat([varint(tag * 8 + 2), varint(bytes.length), bytes]) : Buffer.alloc(0);
  }));
}
function getIv(initial, bytes) {
  let value = initial;
  for (let i = 0; i < bytes.length; i++) value = (i & 1) === 0
    ? (value >>> 4) ^ value ^ (value << 6) ^ bytes[i]
    : ~((value >>> 7) ^ value ^ (bytes[i] | (value << 12)));
  return value >>> 0;
}
function branch(query, body, ts) { return getIv(getIv(getIv(0x20230928, query), body), le32(ts)) & 15; }
function sumMd5(bytes) {
  let check = 0x20220420;
  for (let i = 0; i < 12; i++) {
    const temp = (check >>> ((i & 1) === 0 ? 3 : 5)) ^ check;
    check = ((i & 1) === 0 ? bytes[i] ^ (check << 7) : ~(bytes[i] | (check << 11))) ^ temp;
  }
  return ((check | 4) ^ 0x1000000) >>> 0;
}

function hashF13(query, body, ts) {
  if (branch(query, body, ts) !== 12) throw new Error('Unsupported v5 hash branch');
  const seed = 0x9d4a97c2, count = (seed + ts) >>> 0;
  const table = HASH_TABLE.map(value => ror32(value, count + 1));
  const shift = (count + 2) & 7;
  const pad = Buffer.from([0xfa, 0x45, 0x61, 0xd7].map(value => ((value | (value << 8)) >>> shift) & 255));
  const data = Buffer.concat([query, body, le32(ts), pad, Buffer.from('00000000000001a0', 'hex')]);
  const schedule = [];
  for (let i = 0; i < data.length; i += 4) schedule.push(data.readUInt32BE(i));
  for (let i = 0; i < 112; i++) {
    const x = schedule[i + 1], y = schedule[i + 14];
    schedule.push((schedule[i] + schedule[i + 9] + (rol32(x, 14) ^ rol32(x, 25) ^ (x >>> 3))
      + (rol32(y, 13) ^ rol32(y, 15) ^ (y >>> 10))) >>> 0);
  }
  const initial = [0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f, 984304912, 3005047866, 2874125293, 2152413264]
    .map(value => ror32(value, count));
  const state = initial.slice();
  // v5 branch 12 state selection: (1,3,4,0,6,5,2,0,7,7), exactly 96 rounds.
  for (let i = 0; i < 96; i++) {
    const base = seed + i;
    const n1 = ((state[4] ^ state[0]) & state[1]) ^ state[4];
    const n2 = rol32(state[1], 26) ^ rol32(state[1], 21) ^ rol32(state[1], 7);
    const n4 = (schedule[base & 127] + n1 + n2 + table[base & 63] + state[6]) >>> 0;
    const n5 = rol32(state[3], 30) ^ rol32(state[3], 19) ^ rol32(state[3], 10);
    const n6 = (state[3] & state[5]) | ((state[3] | state[5]) & state[2]);
    const old = state[7];
    state.unshift(state.pop());
    state[7] = (n5 + n6 + n4) >>> 0;
    state[0] = (old + n4) >>> 0;
  }
  const output = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) output.writeUInt32BE((state[i] + initial[i]) >>> 0, i * 4);
  const folded = xor(output.subarray(0, 16), output.subarray(16));
  return Buffer.concat([folded, le32(sumMd5(folded) | 0x20)]);
}

// Protocol-specific two-round carrier; this is not standard AES.
class CarrierV5 {
  constructor(key, ts) {
    const word = ts & 3;
    this.box = SBOX.subarray(word * 256, (word + 1) * 256);
    this.con = [[2,0,3,1], [1,3,2,0], [3,2,1,0], [2,3,1,0]][word];
    this.order = [
      [0,9,14,15,4,13,2,7,8,1,6,3,12,5,10,11],
      [0,9,14,11,4,13,2,3,8,1,6,15,12,5,10,7],
      [0,9,14,3,4,13,2,15,8,1,6,11,12,5,10,7],
      [0,9,14,15,4,13,2,3,8,1,6,11,12,5,10,7],
    ][word];
    const initial = [0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9][word];
    const expanded = Buffer.concat([xor(Buffer.concat(Array.from({ length: 4 }, () => le32(initial))), key), Buffer.alloc(32)]);
    let rounds = 8;
    for (let i = 4; i < 12; i++) {
      const at = 4 * (i - 1);
      let a = expanded[at], b = expanded[at + 1], c = expanded[at + 2], d = expanded[at + 3];
      if ((i & 3) === 0) {
        const temp = ((initial >> (rounds & 24)) ^ this.box[b]) & 255;
        b = this.box[c]; c = this.box[d]; d = this.box[a]; a = temp;
      }
      rounds += 2;
      expanded[at + 4] = a ^ expanded[at - 12]; expanded[at + 5] = b ^ expanded[at - 11];
      expanded[at + 6] = c ^ expanded[at - 10]; expanded[at + 7] = d ^ expanded[at - 9];
    }
    this.keys = Array.from({ length: 12 }, (_, i) => expanded.subarray(i * 4, i * 4 + 4));
  }
  block(value) {
    let rows = Array.from({ length: 4 }, (_, i) => Array.from(value.subarray(i * 4, i * 4 + 4)));
    const add = offset => {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) rows[i][j] ^= this.keys[offset + i][this.con[j]];
    };
    add(0);
    for (let round = 1; round <= 2; round++) {
      const before = rows.map(row => row.map(value => this.box[value]));
      const flat = this.con.flatMap(i => before[i]);
      rows = Array.from({ length: 4 }, (_, i) => this.order.slice(i * 4, i * 4 + 4).map(at => flat[at]));
      if (round === 1) {
        rows = rows.map(row => this.con.map(at => row[at]));
        const xt = x => ((x << 1) ^ ((x & 128) ? 0x1b : 0)) & 255;
        for (let i = 0; i < 4; i++) {
          const t = rows[0][i] ^ rows[1][i] ^ rows[2][i] ^ rows[3][i], u = rows[0][i];
          rows[0][i] ^= t ^ xt(rows[0][i] ^ rows[1][i]);
          rows[1][i] ^= t ^ xt(rows[1][i] ^ rows[2][i]);
          rows[2][i] ^= t ^ xt(rows[2][i] ^ rows[3][i]);
          rows[3][i] ^= t ^ xt(rows[3][i] ^ u);
        }
      }
      add(round * 4);
    }
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) rows[i][j] ^= this.keys[4 + i][j];
    return Buffer.from(rows.flat());
  }
  encrypt(source, iv) {
    if (source.length < 248) throw new RangeError('V5 carrier requires at least 248 bytes');
    const wire = [6,5,3,4,2,7,1,0], compact = [1,7,3,6,2,0,4,5];
    const plaintext = Buffer.alloc(32);
    for (let i = 0; i < 31; i++) for (let j = 0; j < 8; j++) {
      plaintext[i] |= ((source[i * 8 + j] >>> wire[j]) & 1) << compact[j];
    }
    plaintext[31] = 1;
    const first = this.block(xor(plaintext.subarray(0, 16), iv));
    const key = Buffer.concat([first, this.block(xor(plaintext.subarray(16), first))]);
    const output = Buffer.from(source);
    for (let i = 0; i < 31; i++) for (let j = 0; j < 8; j++) {
      const at = i * 8 + j;
      output[at] = (output[at] & ~(1 << wire[j])) | (((key[i] >>> compact[j]) & 1) << wire[j]);
    }
    return Buffer.concat([key.subarray(31), output]);
  }
}

function xmxor(data, key) {
  const encoded = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    const at = (i * 4) & 28, d0 = key[at], d1 = key[at + 1];
    let value = (~((((data[i] << 4) | (data[i] >>> 4)) & 255) + d0)) ^ d1;
    value = (((value & 255) << 3) | ((value & 255) >>> 5)) & 255;
    encoded[data.length - i - 1] = ~(((value + d1) & 255) ^ d0) & 255;
  }
  const last = encoded.at(-1) ^ encoded.at(-2), first = encoded[0];
  encoded[0] = (~last + first) & 255;
  encoded[1] = ((encoded[0] ^ encoded.at(-1) ^ 254) + encoded[1]) & 255;
  encoded[2] = (encoded[2] + ((last - first) ^ (((encoded[1] << 3) | (encoded[1] >>> 5)) & 255) ^ 2)) & 255;
  for (let i = 0; i < encoded.length - 4; i++) {
    const temp = (((encoded[i + 2] << 3) | (encoded[i + 2] >>> 5)) & 255) ^ encoded[i + 1] ^ (i + 3);
    encoded[i + 3] = (~temp + encoded[i + 3]) & 255;
  }
  encoded[encoded.length - 1] ^= encoded.at(-2);
  let sum = 0;
  for (let i = 1; i < encoded.length; i++) sum += encoded[i];
  encoded[0] = ((encoded[0] ^ encoded[1]) + sum) & 255;
  return encoded;
}

function medusa(query, f13, ts, who, field21 = 377) {
  const flags = Buffer.alloc(8);
  const device = proto([[1,1,'sint'], [2,2,'sint'], [3,'8662'], [4,who.device_id],
    [5,PROCESS_NONCE], [6,'!noperm!'], [12,'Asia/Shanghai,8'], [13,'zh_CN'],
    [22,who.os_version], [25,PROCESS_STARTED,'sint'], [30,who.device_type], [31,'HONOR'],
    [32,who.device_type], [34,'HONOR']]);
  const env = proto([[6,'v04.10.03.04-bugfix'], [8,who.channel], [12,device], [14,who.version_name]]);
  const message = proto([[1,MAGIC], [2,5,'sint'], [3,random32(),'sint'], [4,'8662'], [5,who.device_id],
    [6,'646637794'], [7,who.version_name], [8,'v04.10.03-ml-android'], [9,0x040a0300,'sint'],
    [10,flags], [12,ts,'sint'], [13,f13], [14,query.subarray(0,6)],
    [15,proto([[1,1,'sint'], [2,1,'sint'], [3,1,'sint'], [5,1,'sint']])],
    [17,ts,'sint'], [20,'none'], [21,field21,'sint'], [23,env],
    [24,'{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,"kd":0,"dyn":"","do":1,"tk":true}']]);
  const nonce = random32(), high = (nonce >>> 16) & 255;
  const hash = sm3(Buffer.concat([SIGN_KEY, le32(nonce), SIGN_KEY]));
  const seed = le32(~(((high << 11) | (nonce >>> 24)) ^ (high >>> 5) ^ high));
  const transformed = Buffer.concat([flags, xmxor(message, hash)]).reverse();
  for (let i = 0; i < transformed.length; i++) transformed[i] ^= seed[(~i) & 3];
  const check = 0x18000001 | ((query[0] & 63) << 14) | ((f13[0] & 63) << 8);
  const packed = Buffer.concat([Buffer.from([0xca]), le32(random32()), le32(check), transformed,
    Buffer.from([nonce >>> 16, nonce >>> 24])]);
  const encrypted = new CarrierV5(md5(SIGN_KEY.subarray(0,16)), ts).encrypt(packed, md5(SIGN_KEY.subarray(16)));
  const prefix = Buffer.concat([le32(5), MAGIC]), time = le32(ts);
  for (let i = 0; i < prefix.length; i++) prefix[i] ^= time[i & 3];
  return Buffer.concat([prefix, Buffer.from([nonce, nonce >>> 8, 0, 1]), encrypted]).toString('base64');
}

function helios(ts) {
  const nonce = le32(random32());
  const ascii = Buffer.from(md5(Buffer.concat([nonce, Buffer.from('8662')])).toString('hex'));
  const words = Array.from({ length: 4 }, (_, i) => ascii.readBigUInt64LE(i * 8));
  const table = [words[0]];
  let b0 = words.shift(), b8 = words.shift();
  for (let i = 0; i < 34; i++) {
    let value = u64(ror64(b8, 8) + b0) ^ BigInt(i);
    words.push(value); value = u64(value ^ ror64(b0, 61));
    table.push(value); b0 = value; b8 = words.shift();
  }
  const text = Buffer.from(`${ts}-646637794-8662`);
  const padding = 16 - text.length % 16;
  const data = Buffer.concat([text, Buffer.alloc(padding, padding)]), output = Buffer.alloc(data.length);
  for (let at = 0; at < data.length; at += 16) {
    let a = data.readBigUInt64LE(at), b = data.readBigUInt64LE(at + 8);
    for (let i = 0; i < 34; i++) { b = u64(table[i] ^ (a + ror64(b, 8))); a = u64(b ^ ror64(a, 61)); }
    output.writeBigUInt64LE(a, at); output.writeBigUInt64LE(b, at + 8);
  }
  return Buffer.concat([nonce, output]).toString('base64');
}

function plainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
function encode(value) {
  // Match upstream URLEncoder: spaces are %20, '*' and '~' stay literal.
  return encodeURIComponent(value).replace(/[!'()]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}
function validatedValues(values) {
  if (!plainObject(values) || Object.getOwnPropertySymbols(values).length) throw new TypeError('V5 values must be a plain string record');
  const result = Object.create(null), entries = Object.entries(Object.getOwnPropertyDescriptors(values));
  if (entries.length > 128) throw new RangeError('Too many V5 query fields');
  for (const [key, descriptor] of entries) {
    const value = descriptor.value;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !key || key.length > 128 ||
        typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(key + value)) {
      throw new TypeError('V5 query fields must be bounded strings without control characters or accessors');
    }
    try { encode(key); encode(value); } catch { throw new TypeError('V5 query fields must be valid Unicode'); }
    result[key] = value;
  }
  for (const key of ['device_id', 'iid']) {
    if (!/^[1-9]\d{0,29}$/.test(result[key] || '')) throw new TypeError(`V5 ${key} must be a positive decimal string`);
  }
  for (const key of ['cdid', 'version_name', 'channel', 'os_version', 'device_type']) {
    if (!result[key] || !result[key].trim() || result[key].length > 128) throw new TypeError(`V5 ${key} is required and must be bounded`);
  }
  if (result.aid !== undefined && result.aid !== '8662') throw new TypeError('V5 aid must be 8662');
  return result;
}

function signPlaybackV5(input) {
  if (!plainObject(input)) throw new TypeError('V5 signing options are required');
  const { base, values, body, now = Date.now(), field21 = 377 } = input;
  if (typeof base !== 'string' || base.length > 8192 || /[\s?#]/.test(base)) throw new TypeError('V5 base must be an HTTPS URL without query or fragment');
  let parsed;
  try { parsed = new URL(base); } catch { throw new TypeError('V5 base must be a valid HTTPS URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443') {
    throw new TypeError('V5 base must use HTTPS without credentials or a custom port');
  }
  if (!Number.isSafeInteger(now) || now < 0 || Math.floor(now / 1000) > 0x7fffffff) throw new RangeError('V5 now must be nonnegative integer milliseconds within signed timestamp range');
  if (!Number.isInteger(field21) || field21 < 0 || field21 > 0xffff) throw new RangeError('V5 field21 must be an unsigned 16-bit integer');
  const who = validatedValues(values);
  if (body !== null && !Buffer.isBuffer(body)) throw new TypeError('V5 body must be the original gzip Buffer');
  const hasBody = body !== null;
  if (hasBody && (body.length < 18 || body.length > 2 * 1024 * 1024 || body[0] !== 0x1f || body[1] !== 0x8b || body[2] !== 8)) {
    throw new TypeError('V5 body must be a bounded gzip Buffer');
  }
  if (hasBody) try { gunzipSync(body, { maxOutputLength: 2 * 1024 * 1024 }); } catch { throw new TypeError('V5 body must contain valid bounded gzip data'); }
  const ts = Math.floor(now / 1000), bodyHash = hasBody ? md5(body) : md5(Buffer.alloc(0));
  if (Object.hasOwn(who, 'ts')) who.ts = String(ts);
  for (let offset = 0; offset < 1024; offset++) {
    const ticket = String(now + offset);
    const query = Object.entries({ ...who, _rticket: ticket }).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
    const queryHash = sm3(Buffer.from(query));
    if (branch(queryHash, bodyHash, ts) !== 12) continue;
    const f13 = hashF13(queryHash, bodyHash, ts);
    return { url: `${parsed.href}?${query}`, headers: {
      'x-khronos': String(ts), 'x-helios': helios(ts), 'x-medusa': medusa(queryHash, f13, ts, who, field21),
      ...(hasBody ? { 'x-ss-stub': bodyHash.toString('hex').toUpperCase() } : {}),
    } };
  }
  throw new Error('Unable to select V5 playback signature branch within 1024 tickets');
}

module.exports = { signPlaybackV5 };
