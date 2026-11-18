// Portable configuration directory resolution; uses temporary directories only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePortableDataDir, applyPortableDataDir, DATA_FILES, PORTABLE_MARKER, MIGRATION_SENTINEL } = require('../src/native/portable-data');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-portable-'));
const appData = path.join(root, 'appdata');
const portableDir = path.join(root, 'portable');
fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(portableDir, { recursive: true });
fs.writeFileSync(path.join(appData, 'data.json'), '{"settings":{"theme":"dark"}}');
fs.writeFileSync(path.join(appData, 'data.playback.json'), '{"series":{"time":12}}');
fs.writeFileSync(path.join(appData, 'danmaku-client.json'), '{"id":"device-1"}');
fs.writeFileSync(path.join(appData, 'compat-cache'), 'not migrated');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
}

check('non-Windows keeps the system data directory', () => {
  const result = resolvePortableDataDir({ platform: 'darwin', env: { PORTABLE_EXECUTABLE_DIR: portableDir }, defaultUserData: appData });
  assert.equal(result.mode, 'default');
  assert.equal(result.dir, appData);
  assert.deepEqual(result.copied, []);
});

check('missing portable variable keeps the system data directory', () => {
  const result = resolvePortableDataDir({ platform: 'win32', env: {}, defaultUserData: appData });
  assert.equal(result.mode, 'default');
  assert.equal(result.dir, appData);
});

check('portable version copies settings next to the program once', () => {
  const result = resolvePortableDataDir({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: portableDir }, defaultUserData: appData });
  assert.equal(result.mode, 'portable');
  assert.equal(result.dir, path.join(portableDir, 'data'));
  assert.deepEqual(result.copied.slice().sort(), DATA_FILES.slice().sort());
  assert.equal(fs.readFileSync(path.join(result.dir, 'data.json'), 'utf8'), '{"settings":{"theme":"dark"}}');
  assert.equal(fs.readFileSync(path.join(result.dir, 'data.playback.json'), 'utf8'), '{"series":{"time":12}}');
  assert.equal(fs.existsSync(path.join(result.dir, 'compat-cache')), false, 'temporary cache must not move');

  // 用户已经在便携目录里改过配置：再次启动不得用系统目录的旧文件覆盖。
  fs.writeFileSync(path.join(result.dir, 'data.json'), '{"settings":{"theme":"light"}}');
  const second = resolvePortableDataDir({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: portableDir }, defaultUserData: appData });
  assert.equal(second.mode, 'portable');
  assert.deepEqual(second.copied, []);
  assert.equal(fs.readFileSync(path.join(result.dir, 'data.json'), 'utf8'), '{"settings":{"theme":"light"}}');
});

check('a portable ZIP marker next to the executable selects the program folder', () => {
  const zipDir = path.join(root, 'zip');
  fs.mkdirSync(zipDir, { recursive: true });
  fs.writeFileSync(path.join(zipDir, PORTABLE_MARKER), 'portable');
  const result = resolvePortableDataDir({
    platform: 'win32',
    env: {},
    defaultUserData: appData,
    execPath: path.join(zipDir, 'hongguo-downloader.exe'),
  });
  assert.equal(result.mode, 'portable');
  assert.equal(result.dir, path.join(zipDir, 'data'));
  assert.ok(fs.existsSync(path.join(result.dir, 'data.json')));
});

check('an unwritable portable location falls back with a visible reason', () => {
  const blocked = path.join(root, 'blocked');
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'data'), 'this is a file, not a directory');
  const result = resolvePortableDataDir({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: blocked }, defaultUserData: appData });
  assert.equal(result.mode, 'default');
  assert.equal(result.dir, appData);
  assert.match(result.reason, /不可写/);
});

check('a failed migration rolls back and keeps using the old data directory', () => {
  const oldData = path.join(root, 'incomplete-appdata');
  const portableLocked = path.join(root, 'portable-incomplete');
  fs.mkdirSync(oldData, { recursive: true });
  fs.mkdirSync(portableLocked, { recursive: true });
  fs.writeFileSync(path.join(oldData, 'data.json'), '{"settings":{"theme":"dark"}}');
  // 让第二个文件无法复制：目录不能被 copyFileSync 当文件复制。
  fs.mkdirSync(path.join(oldData, 'danmaku-client.json'), { recursive: true });
  const result = resolvePortableDataDir({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: portableLocked }, defaultUserData: oldData });
  assert.equal(result.mode, 'default');
  assert.equal(result.dir, oldData);
  assert.match(result.reason, /复制失败/);
  assert.equal(fs.existsSync(path.join(portableLocked, 'data', 'data.json')), false, 'a failed migration must not leave a partial copy');
  assert.equal(fs.existsSync(path.join(oldData, 'data.json')), true, 'the original data must stay untouched');
});

check('portable migration is guarded by the single-instance lock', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.ok(main.indexOf('requestSingleInstanceLock') < main.indexOf("require('./src/native/portable-data')"),
    'the lock must be requested before any portable migration work');
  assert.match(main, /if \(hasSingleInstanceLock && !IS_PREVIEW/);
});

check('applying portable data switches both userData and sessionData', () => {
  const calls = [];
  const app = { setPath: (name, dir) => calls.push([name, dir]) };
  const portDir = path.join(root, 'portable-apply');
  fs.mkdirSync(portDir, { recursive: true });
  const result = applyPortableDataDir({ app, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: portDir }, defaultUserData: appData });
  assert.equal(result.mode, 'portable');
  assert.deepEqual(calls, [['userData', path.join(portDir, 'data')], ['sessionData', path.join(portDir, 'data')]]);
});

check('session data failure is reported without losing the portable user data path', () => {
  const calls = [];
  const app = { setPath: name => { calls.push(name); if (name === 'sessionData') throw new Error('blocked'); } };
  const portDir = path.join(root, 'portable-session');
  fs.mkdirSync(portDir, { recursive: true });
  const result = applyPortableDataDir({ app, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: portDir }, defaultUserData: appData });
  assert.equal(result.mode, 'portable');
  assert.deepEqual(calls, ['userData', 'sessionData']);
  assert.match(result.reason, /会话目录/);
});

check('an incomplete migration marker is cleaned and the migration retries', () => {
  const portDir = path.join(root, 'portable-recover');
  const dataDir = path.join(portDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'data.json'), '{"partial":true}');
  fs.writeFileSync(path.join(dataDir, MIGRATION_SENTINEL), JSON.stringify({ files: ['data.json'] }));
  const result = resolvePortableDataDir({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: portDir }, defaultUserData: appData });
  assert.equal(result.mode, 'portable');
  assert.equal(fs.existsSync(path.join(dataDir, MIGRATION_SENTINEL)), false, 'the marker must be cleared after recovery');
  assert.equal(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8'), '{"settings":{"theme":"dark"}}', 'the old system data replaces the partial copy');
});

check('an unrecoverable incomplete migration falls back to the system directory', () => {
  const portDir = path.join(root, 'portable-stuck');
  const dataDir = path.join(portDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'data.json'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, MIGRATION_SENTINEL), JSON.stringify({ files: ['data.json'] }));
  const result = resolvePortableDataDir({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: portDir }, defaultUserData: appData });
  assert.equal(result.mode, 'default');
  assert.equal(result.dir, appData);
  assert.match(result.reason, /迁移未完成/);
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`FAIL ${failures} portable configuration check(s)`); process.exitCode = 1; }
else console.log('PASS portable configuration directories and migration');
