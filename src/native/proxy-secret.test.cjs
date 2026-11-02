const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../store');

function fakeSafeStorage({ available = true, backend } = {}) {
  const state = {
    available,
    backend,
    failDecrypt: false,
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => state.backend,
    encryptString(value) {
      return Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`);
    },
    decryptString(value) {
      if (state.failDecrypt) throw new Error('mock decrypt failure');
      const text = Buffer.from(value).toString();
      if (!text.startsWith('sealed:')) throw new Error('mock ciphertext invalid');
      return Buffer.from(text.slice(7), 'base64').toString();
    },
  };
  return state;
}

function fixtureFile(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `hongguo-proxy-secret-${name}-`));
  return { directory, file: path.join(directory, 'data.json') };
}

test('proxy password is encrypted at rest and decrypted only through the runtime getter', () => {
  const { directory, file } = fixtureFile('roundtrip');
  try {
    const encryption = fakeSafeStorage();
    store.init(file, { safeStorage: encryption });
    store.saveSettings({
      root: '/fixture-downloads',
      proxy_username: 'fixture-user',
      proxy_password: 'fixture-secret',
    });
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('fixture-secret'), false);
    assert.equal(/"proxy_password"\s*:/.test(raw), false);
    assert.match(raw, /"proxy_password_ciphertext"/);

    const visible = store.getSettings();
    assert.equal(visible.proxy_password, 'fixture-secret');
    assert.equal(visible.proxy_password_set, true);
    assert.equal(visible.proxy_password_warning, '');
    assert.equal(Object.hasOwn(visible, 'proxy_password_ciphertext'), false);

    store.init(file, { safeStorage: encryption });
    assert.equal(store.getSettings().proxy_password, 'fixture-secret');
    store.saveSettings(store.getSettings(), { clearProxyPassword: true });
    assert.equal(!!store.getSettings().proxy_password_set, false);
    assert.equal(fs.readFileSync(file, 'utf8').includes('proxy_password_ciphertext'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy plaintext and proxy host credentials are migrated and scrubbed', () => {
  const { directory, file } = fixtureFile('legacy');
  try {
    fs.writeFileSync(file, JSON.stringify({
      settings: {
        root: '/fixture-downloads',
        proxy_host: 'http://host-user:host-secret@proxy.fixture:8080',
        proxy_password: 'legacy-secret',
      },
      tasks: [],
    }));
    store.init(file, { safeStorage: fakeSafeStorage() });
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('legacy-secret'), false);
    assert.equal(raw.includes('host-secret'), false);
    assert.equal(raw.includes('host-user@'), false);
    const visible = store.getSettings();
    assert.equal(visible.proxy_host, 'http://proxy.fixture:8080');
    assert.equal(visible.proxy_username, 'host-user');
    assert.equal(visible.proxy_password, 'legacy-secret');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unavailable secure storage keeps the password in memory without writing it', () => {
  const { directory, file } = fixtureFile('unavailable');
  try {
    store.init(file, { safeStorage: fakeSafeStorage({ available: false }) });
    store.saveSettings({ root: '/fixture-downloads', proxy_password: 'session-secret' });
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('session-secret'), false);
    assert.equal(raw.includes('proxy_password_ciphertext'), false);
    const visible = store.getSettings();
    assert.equal(visible.proxy_password, 'session-secret');
    assert.equal(visible.proxy_password_set, true);
    assert.match(visible.proxy_password_warning, /安全存储不可用/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Linux basic_text backend keeps the password in memory without writing weak ciphertext', () => {
  const { directory, file } = fixtureFile('basic-text');
  try {
    store.init(file, { safeStorage: fakeSafeStorage({ available: true, backend: 'basic_text' }) });
    store.saveSettings({ root: '/fixture-downloads', proxy_password: 'basic-text-secret' });
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('basic-text-secret'), false);
    assert.equal(raw.includes('proxy_password_ciphertext'), false);
    const visible = store.getSettings();
    assert.equal(visible.proxy_password, 'basic-text-secret');
    assert.equal(visible.proxy_password_set, true);
    assert.match(visible.proxy_password_warning, /安全存储不可用/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('undecryptable ciphertext survives unrelated saves and recovers with the original key', () => {
  const { directory, file } = fixtureFile('decrypt-failure');
  try {
    const encryption = fakeSafeStorage();
    store.init(file, { safeStorage: encryption });
    store.saveSettings({ root: '/fixture-downloads', proxy_password: 'recoverable-secret' });
    const cipherBefore = JSON.parse(fs.readFileSync(file, 'utf8')).settings.proxy_password_ciphertext;

    encryption.failDecrypt = true;
    store.init(file, { safeStorage: encryption });
    const unavailable = store.getSettings();
    assert.equal(unavailable.proxy_password_set, true);
    assert.match(unavailable.proxy_password_warning, /无法解密/);
    store.saveSettings({ ...unavailable, root: '/fixture-downloads-new' });
    const afterSave = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(afterSave.settings.proxy_password_ciphertext, cipherBefore);
    assert.equal(afterSave.settings.root, '/fixture-downloads-new');

    encryption.failDecrypt = false;
    store.init(file, { safeStorage: encryption });
    assert.equal(store.getSettings().proxy_password, 'recoverable-secret');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('disk write failure rolls back the runtime password and ciphertext', () => {
  const { directory, file } = fixtureFile('rollback');
  const renameSync = fs.renameSync;
  try {
    store.init(file, { safeStorage: fakeSafeStorage() });
    store.saveSettings({ root: '/fixture-downloads', proxy_password: 'original-secret' });
    const originalCipher = JSON.parse(fs.readFileSync(file, 'utf8')).settings.proxy_password_ciphertext;

    fs.renameSync = (source, target) => {
      if (target === file) throw Object.assign(new Error('mock disk failure'), { code: 'EIO' });
      return renameSync(source, target);
    };
    assert.throws(
      () => store.saveSettings({ root: '/fixture-downloads', proxy_password: 'replacement-secret' }),
      /mock disk failure/,
    );
    fs.renameSync = renameSync;

    assert.equal(store.getSettings().proxy_password, 'original-secret');
    const afterFailure = JSON.parse(fs.readFileSync(file, 'utf8')).settings;
    assert.equal(afterFailure.proxy_password_ciphertext, originalCipher);
  } finally {
    fs.renameSync = renameSync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
