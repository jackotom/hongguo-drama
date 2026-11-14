const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const axios = require('axios');
const { loadNative, info } = require('../src/native/hongguo-cancellation-fixture.cjs');

const task = { seriesId: '1', vid: '11', episodeIndex: 1, quality: '1080p' };
const detail = { series_id: '1', total: 1, episodes: [{ vid: '11', vid_index: 1 }] };

function loadMediaWithRealFs(native) {
  const file = path.resolve(__dirname, 'media.cjs'), req = createRequire(file), module = { exports: {} };
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(name => {
    if (name === '../src/native/hongguo') return native;
    return req(name);
  }, module, module.exports);
  return module.exports;
}

test('Docker non-2xx source response destroys the leaked stream and rethrows the original error', async t => {
  const native = loadNative({ appFetch: () => assert.fail('no app lookup') });
  native.fetchEpisodeList = async () => detail;
  native.fetchPlayUrlSingle = async () => info('ok');
  const media = loadMediaWithRealFs(native);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-media-stream-'));
  const store = { output: () => path.join(directory, 'missing.mp4'), directory: () => directory };
  const stream = { destroyed: false, destroy() { this.destroyed = true; } };
  t.mock.method(axios, 'get', async () => { throw Object.assign(new Error('Request failed with status code 404'), { response: { data: stream } }); });
  await assert.rejects(media.download(task, store, new AbortController().signal, () => {}), /status code 404/);
  assert.equal(stream.destroyed, true);
  fs.rmSync(directory, { recursive: true, force: true });
});
