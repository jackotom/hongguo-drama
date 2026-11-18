const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const store = require('../store');

function fixture(t, name, initial = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `hongguo-store-${name}-`));
  const file = path.join(directory, 'data.json');
  fs.writeFileSync(file, JSON.stringify(initial));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file, playback: path.join(directory, 'data.playback.json') };
}

test('legacy playback migrates to a small file and later progress saves leave the main store untouched', t => {
  const f = fixture(t, 'playback', {
    settings: { root: '/fixture' },
    tasks: [{ id: 'download' }],
    playback: { series: { episode: 3, time: 42 } },
  });
  store.init(f.file);
  assert.deepEqual(store.getPlayback(), { series: { episode: 3, time: 42 } });
  assert.equal(fs.existsSync(f.playback), true);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.file, 'utf8')), 'playback'), false);

  const before = fs.readFileSync(f.file, 'utf8');
  store.savePlayback({ series: { episode: 4, time: 12 } });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.playback, 'utf8')), { series: { episode: 4, time: 12 } });

  store.init(f.file);
  assert.deepEqual(store.getPlayback(), { series: { episode: 4, time: 12 } });
  store.saveSettings({ root: '/new' });
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(f.file, 'utf8')), 'playback'), false);
});

test('oversized local records fail without replacing the previous durable data', t => {
  const f = fixture(t, 'limit', { settings: { root: '/keep' }, tasks: [] });
  store.init(f.file, { maxBytes: 256, playbackMaxBytes: 256 });
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => store.saveSettings({ root: '/new', payload: 'x'.repeat(1024) }), {
    code: 'STORE_TOO_LARGE',
  });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(store.getSettings().root, '/keep');
  assert.throws(() => store.savePlayback({ payload: 'x'.repeat(1024) }), {
    code: 'STORE_TOO_LARGE',
  });
});

test('failed playback writes keep disk and memory at the durable snapshot and report once', t => {
  const f = fixture(t, 'playback-failure', { settings: {}, tasks: [] });
  fs.writeFileSync(f.playback, JSON.stringify({ series: { episode: 1 } }));
  store.init(f.file, { playbackMaxBytes: 64 });
  const errors = [];
  store.setErrorHandler(error => errors.push(error));
  const playback = store.getPlayback();
  playback.series = { episode: 2, payload: 'x'.repeat(100) };
  assert.throws(() => store.savePlayback(playback), { code: 'STORE_TOO_LARGE' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.playback, 'utf8')), { series: { episode: 1 } });
  assert.deepEqual(store.getPlayback(), { series: { episode: 1 } });
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /播放进度保存失败|超过/);
});

test('playback updates merge from the newest durable map instead of overwriting a stale snapshot', t => {
  const f = fixture(t, 'update', { settings: {}, tasks: [] });
  store.init(f.file);
  store.savePlayback({ existing: { position: 1 } });
  store.updatePlayback(map => { map.first = { position: 2 }; });
  store.updatePlayback(map => { map.second = { position: 3 }; });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.playback, 'utf8')), {
    existing: { position: 1 },
    first: { position: 2 },
    second: { position: 3 },
  });
});

test('newer playback written by an older version is merged back after re-upgrade', t => {
  const f = fixture(t, 'merge', {
    settings: {},
    tasks: [],
    playback: {
      series: { episode: 8, updatedAt: 300 },
      legacyOnly: { episode: 2, updatedAt: 100 },
    },
  });
  fs.writeFileSync(f.playback, JSON.stringify({
    series: { episode: 7, updatedAt: 200 },
    newOnly: { episode: 3, updatedAt: 200 },
  }));
  store.init(f.file);
  assert.deepEqual(store.getPlayback(), {
    series: { episode: 8, updatedAt: 300 },
    newOnly: { episode: 3, updatedAt: 200 },
    legacyOnly: { episode: 2, updatedAt: 100 },
  });
});
