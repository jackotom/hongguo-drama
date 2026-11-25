const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOpenhongguoSource } = require('./openhongguo-source');

function playback(extra = {}) {
  return {
    playback: {
      episode_id: '11', duration_seconds: 60, protected: true,
      streams: [
        { url: 'https://cdn.example/low.mp4', codec: 'h264', width: 720, height: 1280, definition: '720p' },
        { url: 'https://cdn.example/high.mp4', backup_url: 'https://backup.example/high.mp4', codec: 'hevc', width: 1080, height: 1920, definition: '1080p' },
        { url: 'https://cdn.example/audio.m4a', dash: true },
      ],
    },
    contentKey: { key: '11'.repeat(16) },
    ...extra,
  };
}

test('openhongguo provider maps compatible streams and uses the highest quality by default', async () => {
  let calls = 0;
  const provider = createOpenhongguoSource({ getClient: async () => ({
    async resolvePlayback() { calls++; return playback(); },
  }) });
  const result = await provider.resolve('11', { quality: 'auto' });
  assert.equal(calls, 1);
  assert.equal(result.sourceProvider, 'openhongguo');
  assert.equal(result.codec, 'hevc');
  assert.equal(result.contentKey, '11'.repeat(16));
  assert.deepEqual(result.candidates.map(item => item.url), ['https://cdn.example/high.mp4', 'https://backup.example/high.mp4']);
});

test('openhongguo quality, key and cancellation failures stay explicit', async () => {
  const provider = createOpenhongguoSource({ getClient: async () => ({
    async resolvePlayback() { return playback({ contentKey: undefined }); },
  }) });
  await assert.rejects(provider.resolve('11', { quality: '1080p' }), { code: 'INVALID_RESPONSE' });

  const noKeyProvider = createOpenhongguoSource({ getClient: async () => ({
    async resolvePlayback() {
      const value = playback();
      value.playback.protected = false;
      value.playback.streams = value.playback.streams.filter(stream => stream.definition === '720p');
      return { ...value, contentKey: undefined };
    },
  }) });
  await assert.rejects(noKeyProvider.resolve('11', { quality: '1080p' }), { code: 'QUALITY_UNAVAILABLE' });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(noKeyProvider.resolve('11', { signal: controller.signal }), { code: 'ERR_CANCELED' });
});

test('device rejection resets once through the official SDK recovery path', async () => {
  let resets = 0, attempts = 0;
  const provider = createOpenhongguoSource({ getClient: async () => ({
    async resolvePlayback() {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('device rejected'), { code: 'DEVICE_REJECTED' });
      return playback();
    },
    async resetDevice() { resets++; },
  }) });
  assert.equal((await provider.resolve('11')).sourceProvider, 'openhongguo');
  assert.equal(attempts, 2);
  assert.equal(resets, 1);
});
