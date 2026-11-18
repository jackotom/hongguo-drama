const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const store = require('../src/store');

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-store-'));
  const file = path.join(dir, 'data.json');
  const errors = [];
  store.setErrorHandler(payload => errors.push(payload));
  try { run({ dir, file, errors }); }
  finally {
    store.setErrorHandler(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const writes = [
  () => store.saveSettings({ theme: 'dark' }),
  () => store.saveTasks([{ id: 'pending' }]),
  () => store.saveSeries([{ series_id: 'new' }]),
  () => store.savePlayback({ new: { position: 10 } }),
  () => store.saveMergeTasks([{ id: 'new' }]),
];

function assertReadOnly(file, original, errors) {
  assert.ok(errors.length, 'read failure must notify the existing error handler');
  let firstError;
  for (const write of writes) {
    assert.throws(write, error => {
      assert.equal(error.code, 'STORE_READ_FAILED');
      assert.ok(error.cause, 'retain the original read/parse error');
      if (firstError) assert.equal(error, firstError, 'retain read failure until reinitialization');
      firstError = error;
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'every write must preserve unreadable data');
  }
  assert.deepEqual(store.getSettings(), {});
  assert.deepEqual(store.getTasks(), []);
  assert.deepEqual(store.getSeries(), []);
  assert.deepEqual(store.getPlayback(), {});
  assert.deepEqual(store.getMergeTasks(), []);
}

test('broken JSON stays intact, startup survives, all writes stay blocked until explicit reload', () => withStore(({ file, errors }) => {
  const original = '{"settings":{"theme":"light"},"tasks":[';
  fs.writeFileSync(file, original);
  assert.doesNotThrow(() => store.init(file));
  assertReadOnly(file, original, errors);
  fs.writeFileSync(file, JSON.stringify({ settings: { theme: 'light' }, tasks: [{ id: 'recovered' }] }));
  assert.throws(() => store.saveTasks([]), { code: 'STORE_READ_FAILED' });
  store.init(file);
  store.savePlayback({ recovered: { position: 10 } });
  assert.equal(JSON.parse(fs.readFileSync(file)).tasks[0].id, 'recovered');
}));

test('read permission failure preserves valid data and reports the original cause', () => withStore(({ file, errors }) => {
  const original = JSON.stringify({ settings: { theme: 'light' }, tasks: [{ id: 'saved' }] });
  fs.writeFileSync(file, original);
  const read = fs.readFileSync;
  const denied = Object.assign(new Error('simulated permission denied'), { code: 'EACCES' });
  fs.readFileSync = (target, ...args) => {
    if (target === file) throw denied;
    return read(target, ...args);
  };
  try { assert.doesNotThrow(() => store.init(file)); }
  finally { fs.readFileSync = read; }
  assertReadOnly(file, original, errors);
  assert.throws(() => store.saveSettings({}), error => error.cause === denied);
}));

test('invalid JSON document shapes are protected instead of silently discarded', () => withStore(({ file, errors }) => {
  for (const invalid of [null, [], 42, { tasks: {} }, { settings: [] }, { series: {} }, { playback: [] }, { mergeTasks: {} }]) {
    const original = JSON.stringify(invalid);
    fs.writeFileSync(file, original);
    errors.length = 0;
    assert.doesNotThrow(() => store.init(file));
    assertReadOnly(file, original, errors);
  }
}));

test('missing file initializes normally; successful saves retain unrelated and future fields', () => withStore(({ dir, file, errors }) => {
  store.init(file);
  store.saveSettings({ theme: 'light' });
  store.saveTasks([{ id: 'complete' }]);
  assert.equal(errors.length, 0);
  const document = JSON.parse(fs.readFileSync(file));
  document.futureField = { preserve: true };
  fs.writeFileSync(file, JSON.stringify(document));
  store.init(file);
  store.savePlayback({ complete: { position: 10 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).futureField, { preserve: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['data.json', 'data.playback.json']);
}));

test('interrupted write, fsync or rename keeps disk and memory at their last durable state without leaking handles', () => withStore(({ dir, file, errors }) => {
  store.init(file);
  store.saveSettings({ theme: 'light' });
  store.saveTasks([{ id: 'saved' }]);
  const before = fs.readFileSync(file, 'utf8');
  for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const open = fs.openSync;
    const handles = [];
    fs.openSync = (target, ...args) => {
      const fd = open(target, ...args);
      if (target === file + '.tmp') handles.push(fd);
      return fd;
    };
    const original = fs[operation];
    fs[operation] = (target, ...args) => {
      if (operation === 'writeFileSync') original(target, '{');
      throw new Error('simulated disk full');
    };
    try {
      store.getTasks()[0].id = 'unsaved';
      assert.throws(() => store.saveTasks(store.getTasks()), /simulated disk full/);
    } finally { fs[operation] = original; fs.openSync = open; }
    for (const fd of handles) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(store.getTasks()[0].id, 'saved');
    assert.deepEqual(fs.readdirSync(dir), ['data.json']);
  }
  assert.equal(errors.length, 3);
  store.saveTasks([{ id: 'complete' }]);
  assert.equal(JSON.parse(fs.readFileSync(file)).tasks[0].id, 'complete');
}));

test('temporary contents are synced and the handle is closed before replacing saved data', () => withStore(({ file }) => {
  store.init(file);
  store.saveTasks([{ id: 'saved' }]);
  const before = fs.readFileSync(file, 'utf8');
  const sync = fs.fsyncSync;
  const rename = fs.renameSync;
  let syncedFd;
  fs.fsyncSync = fd => {
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(file + '.tmp')).tasks[0].id, 'complete');
    sync(fd);
    syncedFd = fd;
  };
  fs.renameSync = (source, destination) => {
    assert.notEqual(syncedFd, undefined, 'sync completed contents before replacing the saved file');
    assert.throws(() => fs.fstatSync(syncedFd), { code: 'EBADF' });
    return rename(source, destination);
  };
  try { store.saveTasks([{ id: 'complete' }]); }
  finally { fs.fsyncSync = sync; fs.renameSync = rename; }
  assert.equal(JSON.parse(fs.readFileSync(file)).tasks[0].id, 'complete');
}));
