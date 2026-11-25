const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  MIRRORS, SOURCE_PACK_KEYS, canonicalize, createSourcePackService,
  decodeEnvelope, parsePack, validatePack,
} = require('./source-pack');
const policy = require('./source-policy');

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { id: 'test-key', publicKey, privateKey, keyring: { 'test-key': publicKey } };
}

function packEnvelope(key, revision, routes = [{ id: 'video_tab', order: 1 }]) {
  const payload = {
    format: 2,
    id: 'hongguo-playback',
    keyId: key.id,
    revision,
    issuedAt: '2026-11-25T00:00:00.000Z',
    policy: { routes },
  };
  const raw = Buffer.from(canonicalize(payload));
  return {
    format: 2,
    keyId: key.id,
    payload: raw.toString('base64'),
    signature: crypto.sign(null, raw, key.privateKey).toString('base64'),
  };
}

test('signed packs update after persistence, persist raw envelopes, and roll back', async () => {
  const key = makeKey();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-source-pack-'));
  const filePath = path.join(dir, 'state.json');
  let response = packEnvelope(key, 1);
  let now = 1800000000000;
  const service = createSourcePackService({
    filePath, keyring: key.keyring, now: () => now,
    request: async () => ({ data: response }),
  });
  assert.equal((await service.check({ force: true })).updated, true);
  assert.equal(policy.getPolicy().revision, 1);
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(saved.activeEnvelope?.signature);
  assert.equal(Object.hasOwn(saved, 'active'), false);
  response = packEnvelope(key, 2, [{ id: 'legacy', order: 0 }, { id: 'video_tab', order: 2 }]);
  assert.equal((await service.check({ force: true })).updated, true);
  assert.equal(policy.getPolicy().revision, 2);
  const reopened = createSourcePackService({
    filePath, keyring: key.keyring, now: () => now, request: async () => ({ data: response }),
  });
  assert.equal(reopened.status().revision, 2);
  assert.equal((await reopened.rollback()).rolledBack, true);
  assert.equal(reopened.status().revision, 1);
  assert.equal(policy.getPolicy().revision, 1);
  fs.rmSync(dir, { recursive: true, force: true });
  policy.setPolicy(null);
});

test('remote verification never mutates runtime policy before version acceptance', async () => {
  const key = makeKey();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-source-pack-side-effect-'));
  const newer = packEnvelope(key, 5);
  const older = packEnvelope(key, 2);
  const service = createSourcePackService({
    filePath: path.join(dir, 'state.json'), keyring: key.keyring, bundledEnvelope: newer,
    request: async () => ({ data: older }),
  });
  assert.equal(policy.getPolicy().revision, 5);
  assert.equal((await service.check({ force: true })).upToDate, true);
  assert.equal(policy.getPolicy().revision, 5, 'an older remote pack must not leak into runtime policy');
  fs.rmSync(dir, { recursive: true, force: true });
  policy.setPolicy(null);
});

test('newer bundled pack wins over an older signed saved pack after upgrade', () => {
  const key = makeKey();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-source-pack-upgrade-'));
  const filePath = path.join(dir, 'state.json');
  fs.writeFileSync(filePath, JSON.stringify({
    enabled: true,
    activeEnvelope: packEnvelope(key, 2),
    activeSource: 'remote',
  }));
  const service = createSourcePackService({
    filePath, keyring: key.keyring, bundledEnvelope: packEnvelope(key, 5),
    request: async () => { throw new Error('offline'); },
  });
  assert.equal(service.status().revision, 5);
  assert.equal(service.status().source, 'embedded');
  assert.equal(policy.getPolicy().revision, 5);
  fs.rmSync(dir, { recursive: true, force: true });
  policy.setPolicy(null);
});

test('mirrors are tried in order and invalid signatures leave the active pack untouched', async () => {
  const key = makeKey();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-source-pack-mirror-'));
  const good = packEnvelope(key, 1);
  const calls = [];
  const service = createSourcePackService({
    filePath: path.join(dir, 'state.json'), keyring: key.keyring,
    request: async url => {
      calls.push(url);
      if (calls.length === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      if (calls.length === 2) return { data: { ...good, signature: 'AAAA' } };
      return { data: good };
    },
  });
  assert.equal((await service.check({ force: true })).updated, true);
  assert.deepEqual(calls, MIRRORS.slice(0, 3));
  assert.equal(policy.getPolicy().revision, 1);
  fs.rmSync(dir, { recursive: true, force: true });
  policy.setPolicy(null);
});

test('rollback suppresses automatic reinstall but a manual check can opt back in', async () => {
  const key = makeKey();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-source-pack-rollback-'));
  const first = packEnvelope(key, 1);
  const second = packEnvelope(key, 2);
  let response = first, now = 1800000000000;
  const service = createSourcePackService({
    filePath: path.join(dir, 'state.json'), keyring: key.keyring, now: () => now,
    request: async () => ({ data: response }),
  });
  await service.check({ force: true });
  response = second;
  await service.check({ force: true });
  await service.rollback();
  now += 7 * 60 * 60 * 1000;
  const auto = await service.check({ force: false });
  assert.equal(auto.suppressed, true);
  assert.equal(auto.revision, 1);
  const manual = await service.check({ force: true });
  assert.equal(manual.updated, true);
  assert.equal(manual.revision, 2);
  fs.rmSync(dir, { recursive: true, force: true });
  policy.setPolicy(null);
});

test('checked-in playback pack verifies with a built-in active or standby key', () => {
  const envelope = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../source-packs/hongguo-playback.pack.json'), 'utf8'));
  const { payload } = decodeEnvelope(envelope, SOURCE_PACK_KEYS);
  assert.equal(validatePack(payload).id, 'hongguo-playback');
  assert.ok(parsePack(envelope, 'embedded', SOURCE_PACK_KEYS).policy.routes.some(route => route.id === 'preload_current'));
});
