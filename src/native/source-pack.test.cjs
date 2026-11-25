const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DEFAULT_PUBLIC_KEY, canonicalize, createSourcePackService, decodeEnvelope, validatePack } = require('./source-pack');
const policy = require('./source-policy');

function packEnvelope(privateKey, revision, routes = [{ id: 'video_tab', order: 1 }]) {
  const payload = {
    format: 1,
    id: 'hongguo-playback',
    revision,
    issuedAt: '2026-11-25T00:00:00.000Z',
    policy: { routes },
  };
  const raw = Buffer.from(canonicalize(payload));
  return {
    format: 1,
    payload: raw.toString('base64'),
    signature: crypto.sign(null, raw, privateKey).toString('base64'),
  };
}

test('signed source packs update policy, persist, and roll back', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-source-pack-'));
  const filePath = path.join(dir, 'state.json');
  let response = packEnvelope(privateKey, 1);
  let now = 1800000000000;
  const service = createSourcePackService({
    filePath, publicKey, now: () => now,
    request: async () => ({ data: response }),
  });
  assert.equal((await service.check({ force: true })).updated, true);
  assert.equal(policy.getPolicy().revision, 1);
  response = packEnvelope(privateKey, 2, [{ id: 'legacy', order: 0 }, { id: 'video_tab', order: 2 }]);
  assert.equal((await service.check({ force: true })).updated, true);
  assert.equal(policy.getPolicy().revision, 2);
  const reopened = createSourcePackService({ filePath, publicKey, now: () => now, request: async () => ({ data: response }) });
  assert.equal(reopened.status().revision, 2);
  assert.equal((await reopened.rollback()).rolledBack, true);
  assert.equal(reopened.status().revision, 1);
  assert.equal(policy.getPolicy().revision, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checked-in playback pack verifies with the embedded project public key', () => {
  const envelope = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../source-packs/hongguo-playback.pack.json'), 'utf8'));
  const { payload } = decodeEnvelope(envelope, DEFAULT_PUBLIC_KEY);
  const pack = validatePack(payload);
  assert.equal(pack.id, 'hongguo-playback');
  assert.ok(pack.policy.routes.some(route => route.id === 'preload_current'));
});

test('bad signatures leave the active policy untouched and automatic checks are throttled', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-source-pack-bad-'));
  let now = 1800000000000, calls = 0;
  const good = packEnvelope(privateKey, 1);
  const service = createSourcePackService({
    filePath: path.join(dir, 'state.json'), publicKey, now: () => now,
    request: async () => { calls++; return { data: calls === 1 ? good : { ...good, signature: 'AAAA' } }; },
  });
  await service.check({ force: true });
  const bad = await service.check({ force: true });
  assert.equal(bad.revision, 1);
  assert.match(bad.error, /签名/);
  assert.equal(policy.getPolicy().revision, 1);
  now += 1000;
  await service.check();
  assert.equal(calls, 2, 'automatic checks inside the six-hour window must not request again');
  fs.rmSync(dir, { recursive: true, force: true });
  policy.setPolicy(null);
});
