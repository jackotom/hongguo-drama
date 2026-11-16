// SPDX-License-Identifier: GPL-3.0-only
// Single-video signing adapted from N3urda/hongguoTV 54b91e66932faad60cf12b61b38a063fa194a877,
// kotlin-tv/core/src/main/kotlin/com/hongguotv/core/PlayerSignature.kt.
// Upstream: Argus/Simon structure from tr4cex/TikTok-Encryption (MIT), protocol
// verified against qq294716498/HongguoTV-Phone-TV-NoAds 8eafa3908e9191c0a5ae186d5beff11e3a971f3c.
// Changes: Node crypto/BigInt; reuse the existing Simon and Ladon primitives.
const crypto = require('node:crypto');
const sm3 = require('./sm3');
const { Simon, Ladon } = require('./playback-signature');
const hex = value => Buffer.from(value, 'hex');
const md5 = value => crypto.createHash('md5').update(value).digest();
const pad = bytes => Buffer.concat([bytes, Buffer.alloc(16 - bytes.length % 16, 16 - bytes.length % 16)]);
const word = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt.asUintN(64, value)); return bytes; };
function varint(value) {
    let number = BigInt(value);
    const bytes = [];
    while (number >= 128n) { bytes.push(Number(number & 127n) | 128); number >>= 7n; }
    bytes.push(Number(number));
    return Buffer.from(bytes);
}
function proto(fields) {
    return Buffer.concat(fields.flatMap(([tag, value]) => {
        if (typeof value === 'number' || typeof value === 'bigint') return [varint(tag << 3), varint(value)];
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        return [varint((tag << 3) | 2), varint(bytes.length), bytes];
    }));
}
function argus(query, body, deviceId, ts, nonce) {
    const message = proto([
        [1, 0x40401252], [2, 2], [3, nonce.readUInt32LE(6) & 0x7fffffff],
        [4, '8662'], [5, deviceId], [6, '1611921764'], [7, '7.3.5.32'],
        [8, 'v04.07.01-ml-android'], [9, 135135744], [10, Buffer.alloc(8)], [11, 0], [12, ts * 2],
        [13, sm3(body ? md5(body) : Buffer.alloc(16)).subarray(0, 6)],
        [14, sm3(Buffer.from(query)).subarray(0, 6)],
        [15, proto([[1, 1], [2, 1], [3, 1], [7, 3348294860]])], [16, Buffer.alloc(0)],
        [20, 'none'], [21, 738],
        [23, proto([[1, '25053RT47C'], [2, '16'], [3, 'update_64'], [4, 2147483648]])], [25, 2],
    ]);
    const secret = hex('ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c');
    const derived = sm3(Buffer.concat([secret, hex('3ccc567b'), secret]));
    const keys = Array.from({ length: 4 }, (_, i) => derived.readBigUInt64LE(i * 8));
    const blocks = pad(message), encrypted = [];
    for (let i = 0; i < blocks.length; i += 16) {
        encrypted.push(...Simon.encrypt(blocks.readBigUInt64LE(i), blocks.readBigUInt64LE(i + 8), keys).map(word));
    }
    const mask = hex('d04ffdffd04ffdff'), scrambled = Buffer.concat(encrypted);
    for (let i = 0; i < scrambled.length; i++) scrambled[i] ^= mask[i % mask.length];
    const container = Buffer.concat([hex('a6e783ee7001100918'), Buffer.concat([mask, scrambled]).reverse(), hex('567b')]);
    const cipher = crypto.createCipheriv('aes-128-cbc', md5(secret.subarray(0, 16)), md5(secret.subarray(16)));
    return Buffer.concat([hex('3ccc'), cipher.update(container), cipher.final()]).toString('base64');
}
function signSinglePlayer({ query, body = null, deviceId, now = Date.now(), nonce = crypto.randomBytes(11) }) {
    if (typeof query !== 'string' || body !== null && !Buffer.isBuffer(body)
        || typeof deviceId !== 'string' || !/^\d{1,30}$/.test(deviceId) || !/[1-9]/.test(deviceId)
        || !Number.isSafeInteger(now) || now < 0 || !Buffer.isBuffer(nonce) || nonce.length !== 11) {
        throw new TypeError('Final query, raw body, registered device, timestamp and 11-byte nonce required');
    }
    const ts = Math.floor(now / 1000), time = Buffer.alloc(4);
    time.writeUInt32BE(ts >>> 0);
    const bytes = Buffer.concat([md5(Buffer.from(query)).subarray(0, 4),
        body ? md5(body).subarray(0, 4) : Buffer.alloc(4), Buffer.alloc(4), hex('00060b1c'), time]);
    const key = hex('44b9b9d9a4aef9fca493aa757ca3c2c4a496938f');
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i];
    for (let i = 0; i < bytes.length; i++) {
        const swapped = ((bytes[i] << 4) | (bytes[i] >>> 4)) & 255;
        let value = swapped ^ bytes[(i + 1) % bytes.length], reversed = 0;
        for (let bit = 0; bit < 8; bit++) { reversed = (reversed << 1) | (value & 1); value >>>= 1; }
        bytes[i] = reversed ^ 0xeb;
    }
    return {
        'x-gorgon': Buffer.concat([hex('8404401c0000'), bytes]).toString('hex'),
        'x-khronos': String(ts), 'x-ss-req-ticket': String(now),
        'x-argus': argus(query, body, deviceId, ts, nonce),
        'x-ladon': Ladon.encrypt(BigInt(ts), 1611921764n, 8662n, nonce.subarray(2, 6)),
        ...(body ? { 'x-ss-stub': md5(body).toString('hex').toUpperCase() } : {}),
    };
}
module.exports = { signSinglePlayer };
