// SPDX-License-Identifier: GPL-3.0-only
// Independent Go-reference vectors from N3urda/hongguoTV 54b91e66932faad60cf12b61b38a063fa194a877,
// kotlin-tv/core/src/test/resources/player-signing.json (blob 97d95fb528ffc8bb3fb2e78cf009fec8602f8b40).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signSinglePlayer } = require('./single-playback-signature');
const rows = require('./single-playback-vectors.json');
const input = row => ({ ...row, body: row.body === null ? null : Buffer.from(row.body), nonce: Buffer.from(row.nonce, 'hex') });
test('single-video signatures match independently generated body and bodyless vectors', () => {
    for (const row of rows) {
        const expected = Object.fromEntries(Object.entries(row.headers).map(([key, value]) => [key.toLowerCase(), value]));
        assert.deepEqual(signSinglePlayer(input(row)), expected);
    }
});
test('single-video signatures bind the exact body, query, identity and timestamp', () => {
    const data = input(rows[1]), original = signSinglePlayer(data);
    for (const update of [{ body: Buffer.from('{}') }, { query: data.query + '&changed=1' },
        { deviceId: '444' }, { now: data.now + 1000 }]) {
        assert.notEqual(signSinglePlayer({ ...data, ...update })['x-argus'], original['x-argus']);
    }
    assert.equal(original.cookie, undefined);
    assert.equal(original['x-medusa'], undefined);
    assert.throws(() => signSinglePlayer({ ...data, nonce: Buffer.alloc(1) }), TypeError);
});
