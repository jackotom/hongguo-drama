// SPDX-License-Identifier: GPL-3.0-only
// Port of tsukiyo-zero/hongguoTV core/Argus.kt @269c6d8, derived from ch6vip/fqapp.
const crypto = require('node:crypto');
const sm3 = require('./sm3');
const U = x => BigInt.asUintN(64, x),
    R = (x, n) => U((U(x) >> BigInt(n)) | (U(x) << BigInt(64 - n))),
    L = (x, n) => R(x, 64 - n);
const hex = x => Buffer.from(x, 'hex');

function v(x) {
    let n = BigInt.asUintN(32, BigInt(x)),
        a = [];
    while (n >= 128n) {
        a.push(Number(n & 127n) | 128);
        n >>= 7n;
    }
    return Buffer.from([...a, Number(n)]);
}

function p(fields) {
    return Buffer.concat(fields.map(([tag, x]) => typeof x === 'number' || typeof x === 'bigint' ? Buffer.concat([v(tag * 8), v(x)]) : Buffer.concat([v(tag * 8 + 2), v(Buffer.byteLength(x)), Buffer.from(x)])));
}

function pad(b) {
    let n = 16 - b.length % 16;
    return Buffer.concat([b, Buffer.alloc(n, n)]);
}

function words(b) {
    return Array.from({
        length: b.length / 8
    }, (_, i) => b.readBigUInt64LE(i * 8));
}

function le(...a) {
    let b = Buffer.alloc(a.length * 8);
    a.forEach((x, i) => b.writeBigUInt64LE(U(x), i * 8));
    return b;
}

function simon(b) {
    let k = words(hex('fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304'));
    for (let i = 4; i < 72; i++) {
        let t = R(k[i - 1], 3) ^ k[i - 3];
        t ^= R(t, 1);
        k[i] = U(~k[i - 4] ^ t ^ ((0x3DC94C3A046D678Bn >> BigInt((i - 4) % 62)) & 1n) ^ 3n);
    }
    let out = [];
    for (let i = 0; i < b.length; i += 16) {
        let a = b.readBigUInt64LE(i),
            c = b.readBigUInt64LE(i + 8);
        for (const key of k)[a, c] = [c, U(a ^ (L(c, 1) & L(c, 8)) ^ L(c, 2) ^ key)];
        out.push(le(a, c));
    }
    return Buffer.concat(out);
}

function argus(q, stub, ts, aid, did, nonce) {
    let qs = new URLSearchParams(q);
    let bean = p([
        [1, 1077940818],
        [2, 2],
        [3, nonce],
        [4, String(aid)],
        [5, did],
        [6, '1611921764'],
        [7, qs.get('version_name') || ''],
        [8, 'v04.04.05-ov-android'],
        [9, 134744640],
        [10, Buffer.alloc(8)],
        [11, 0],
        [12, BigInt(ts) * 2n],
        [13, sm3(stub ? hex(stub) : Buffer.alloc(16)).subarray(0, 6)],
        [14, sm3(q ? Buffer.from(q) : Buffer.alloc(16)).subarray(0, 6)],
        [15, p([
            [1, 1],
            [2, 1],
            [3, 1],
            [7, 0xC792ECCC]
        ])],
        [16, ''],
        [20, 'none'],
        [21, 738],
        [23, p([
            [1, 'NX551J'],
            [2, 8196],
            [4, 0x80E0D800]
        ])],
        [25, 2]
    ]);
    let magic = hex('f2f7fcfff2f7fcff'),
        un = Buffer.concat([magic, simon(pad(bean)), hex('eafb2cfe8568519154')]);
    for (let i = 8; i < un.length; i++) un[i] ^= magic[i % 8];
    un.reverse();
    let c = crypto.createCipheriv('aes-128-cbc', hex('d31e3718288a1027baab59f146a09a9c'), hex('ea180a0336ed352fcd24e4d50018ae54'));
    return Buffer.concat([hex('f281'), c.update(Buffer.concat([un, Buffer.from('ao')])), c.final()]).toString('base64');
}

function ladon(ts, aid, r) {
    let ht = Buffer.alloc(288);
    ht.write(crypto.createHash('md5').update(Buffer.concat([r, Buffer.from(String(aid))])).digest('hex'));
    let [a, b, c, d] = words(ht.subarray(0, 32)), temp = [c, d];
    for (let i = 0; i < 34; i++) {
        let x = U(R(b, 8) + a) ^ BigInt(i);
        temp.push(x);
        x ^= L(a, 3);
        ht.writeBigUInt64LE(U(x), (i + 1) * 8);
        a = x;
        b = temp.shift();
    }
    let k = words(ht),
        input = pad(Buffer.from(`${ts}-1611921764-${aid}`)),
        out = [];
    for (let i = 0; i < input.length; i += 16) {
        let a = input.readBigUInt64LE(i),
            b = input.readBigUInt64LE(i + 8);
        for (let j = 0; j < 34; j++) {
            b = U(k[j] ^ U(a + R(b, 8)));
            a = U(b ^ L(a, 3));
        }
        out.push(le(a, b));
    }
    return Buffer.concat([r, ...out]).toString('base64');
}

function headers(q, body, ticket, random = crypto.randomBytes(8)) {
    let ts = Math.floor(ticket / 1000),
        qs = new URLSearchParams(q),
        aid = Number(qs.get('aid') || 1967),
        stub = body?.length ? crypto.createHash('md5').update(body).digest('hex') : '';
    return {
        'x-ss-req-ticket': String(ticket),
        'x-khronos': String(ts),
        'x-ladon': ladon(ts, aid, random.subarray(0, 4)),
        'x-argus': argus(q, stub, ts, aid, qs.get('device_id') || '', random.readUInt32LE(4)),
        ...(stub ? {
            'x-ss-stub': stub
        } : {})
    };
}
module.exports = {
    headers,
    argus,
    ladon
};
