const assert = require('node:assert/strict');
const { test } = require('node:test');
const { axiosTransport, createLazyClient, createOpenhongguoSource } = require('./openhongguo-source');

function playback(extra = {}) {
  return {
    playback: {
      episode_id: '11', duration_seconds: 60, protected: true,
      streams: [
        { url: 'https://cdn.example/low.mp4', codec: 'h264', width: 720, height: 1280, definition: '720p' },
        { url: 'https://cdn.example/high.mp4', backup_url: 'https://backup.example/high.mp4', codec: 'hevc', width: 1080, height: 1920, definition: '1080p' },
        { url: 'https://cdn.example/high-h264.mp4', codec: 'h264', width: 1080, height: 1920, definition: '1080p' },
        { url: 'https://cdn.example/bytevc2.mp4', codec: 'bytevc2', width: 2160, height: 3840, definition: '4k' },
        { url: 'http://127.0.0.1/private.mp4', codec: 'h264', width: 2160, height: 3840, definition: '4k' },
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
  assert.equal(result.codec, 'h264');
  assert.equal(result.contentKey, '11'.repeat(16));
  assert.equal(result.url, 'https://cdn.example/high-h264.mp4');
  assert.ok(result.candidates.every(item => !/127\.0\.0\.1|bytevc2/.test(item.url)));
});

test('openhongguo returns every episode with numeric playback IDs', async () => {
  const provider = createOpenhongguoSource({ getClient: async () => ({
    async getSeriesBatch([sid]) {
      assert.equal(sid, '7700000000000000001');
      return [{
        series: { id: sid, title: '完整剧', cover_url: 'https://img.example/cover.jpg', episode_count: 7 },
        episodes: Array.from({ length: 7 }, (_, index) => ({
          id: String(7700000000000000100n + BigInt(index)),
          series_id: sid,
          number: index + 1,
          title: `第${index + 1}集`,
          playable: true,
        })),
      }];
    },
  }) });
  const result = await provider.list('7700000000000000001');
  assert.equal(result.total, 7);
  assert.equal(result.source, 'openhongguo');
  assert.deepEqual(result.episodes.map(item => item.vid_index), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(result.episodes.every(item => /^\d+$/.test(item.vid) && item.content_type === '1004'));
});

test('openhongguo rejects a partial series batch instead of returning preview episodes', async () => {
  const provider = createOpenhongguoSource({ getClient: async () => ({
    async getSeriesBatch([sid]) {
      return [{
        series: { id: sid, title: '缺集剧', episode_count: 80 },
        episodes: [{ id: '7700000000000000201', series_id: sid, number: 1, playable: true }],
      }];
    },
  }) });
  await assert.rejects(provider.list('7700000000000000002'), { code: 'INVALID_RESPONSE' });
});

test('openhongguo list resets rejected anonymous device once and preserves SDK content_type', async () => {
  let resets = 0, attempts = 0;
  const provider = createOpenhongguoSource({ getClient: async () => ({
    async getSeriesBatch([sid]) {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('device rejected'), { code: 'DEVICE_REJECTED' });
      return [{
        series: { id: sid, title: 'PUGC剧', cover_url: 'javascript:alert(1)', content_type: 1001, episode_count: 2 },
        episodes: [
          { id: '7700000000000000301', series_id: sid, number: 1, cover_url: 'https://img.example/ep1.jpg', content_type: 1001, playable: true },
          { id: '7700000000000000302', series_id: sid, number: 2, cover_url: 'file:///etc/passwd', playable: false },
        ],
      }];
    },
    async resetDevice() { resets++; },
  }) });
  const result = await provider.list('7700000000000000003');
  assert.equal(attempts, 2);
  assert.equal(resets, 1);
  assert.equal(result.content_type, '1001');
  assert.equal(result.cover, 'https://img.example/ep1.jpg');
  assert.deepEqual(result.episodes.map(item => item.content_type), ['1001', '1001']);
  assert.deepEqual(result.episodes.map(item => item.cover), ['https://img.example/ep1.jpg', '']);
  assert.deepEqual(result.episodes.map(item => item.locked), [false, true]);
  const overridden = await provider.list('7700000000000000003', { content_type: '1004' });
  assert.equal(overridden.content_type, '1004');
  assert.deepEqual(overridden.episodes.map(item => item.content_type), ['1004', '1004']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.list('7700000000000000003', { signal: controller.signal }), { code: 'ERR_CANCELED' });
});

test('openhongguo axios transport preserves raw bodies and inherits ambient proxy handling', async () => {
  let config;
  const transport = axiosTransport({ request: async value => {
    config = value;
    return {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': ['a=1; Path=/'] },
      data: Buffer.from('raw-body'),
    };
  } });
  const response = await transport({ method: 'POST', url: 'https://api.example/j', headers: { Accept: '*' }, body: new Uint8Array([1, 2, 3]) });
  assert.equal(config.decompress, false);
  assert.equal(config.headers['Accept-Encoding'], 'gzip');
  assert.equal(config.maxContentLength, 8 * 1024 * 1024);
  assert.equal(Object.hasOwn(config, 'proxy'), false, 'ambient app proxy environment must remain in control');
  assert.deepEqual([...config.data], [1, 2, 3]);
  assert.equal(Buffer.from(response.body).toString(), 'raw-body');
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(response.cookies.a, '1');
});

test('explicit quality prefers a stream that meets the target before allowing lower fallback', async () => {
  const provider = createOpenhongguoSource({ getClient: async () => ({
    async resolvePlayback() {
      const value = playback();
      value.playback.streams = [
        { url: 'https://cdn.example/h264-720.mp4', codec: 'h264', width: 720, height: 1280, definition: '720p' },
        { url: 'https://cdn.example/hevc-1080.mp4', codec: 'hevc', width: 1080, height: 1920, definition: '1080p' },
      ];
      return value;
    },
  }) });
  const result = await provider.resolve('11', { quality: '1080p', allowLowerQuality: true });
  assert.equal(result.url, 'https://cdn.example/hevc-1080.mp4');
  assert.equal(result.codec, 'hevc');
});

test('a failed openhongguo initialization is not cached permanently', async () => {
  let attempts = 0;
  const client = { marker: true };
  const lazy = createLazyClient({
    getProfilePath: () => '/tmp/test-profile.json',
    createTransport: () => ({ transport: true }),
    loadSdk: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary wasm load failure');
      return {
        fileProfileStore: path => ({ path }),
        createClient: async options => ({ ...client, options }),
      };
    },
  });
  await assert.rejects(lazy(), /temporary wasm load failure/);
  const recovered = await lazy();
  assert.equal(recovered.marker, true);
  assert.equal(recovered.options.transport.transport, true);
  assert.equal(attempts, 2);
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

test('anonymous limits cool down before another openhongguo request', async () => {
  let currentTime = 1_000, attempts = 0;
  const provider = createOpenhongguoSource({
    now: () => currentTime,
    getClient: async () => ({
      async resolvePlayback() {
        attempts++;
        throw Object.assign(new Error('anonymous limited'), { code: 'ANONYMOUS_LIMITED' });
      },
    }),
  });
  await assert.rejects(provider.resolve('11'), { code: 'ANONYMOUS_LIMITED' });
  currentTime += 59_999;
  await assert.rejects(provider.resolve('12'), error => {
    assert.equal(error.code, 'ANONYMOUS_LIMITED');
    assert.equal(error.cooldown, true);
    return true;
  });
  assert.equal(attempts, 1);
  currentTime += 1;
  await assert.rejects(provider.resolve('13'), { code: 'ANONYMOUS_LIMITED' });
  assert.equal(attempts, 2);
});

test('concurrent DEVICE_REJECTED failures coalesce resetDevice and reject plaintext http media URLs', async () => {
  let resets = 0, calls = 0;
  let releaseReset;
  const provider = createOpenhongguoSource({ getClient: async () => ({
    async resolvePlayback() {
      calls++;
      if (calls <= 2) throw Object.assign(new Error('device rejected'), { code: 'DEVICE_REJECTED' });
      const value = playback();
      value.playback.streams = [
        { url: 'http://cdn.example/insecure.mp4', codec: 'h264', width: 1080, height: 1920, definition: '1080p' },
        { url: 'https://cdn.example/secure.mp4', codec: 'h264', width: 1080, height: 1920, definition: '1080p' },
      ];
      return value;
    },
    resetDevice() {
      resets++;
      return new Promise(resolve => { releaseReset = resolve; });
    },
  }) });
  const a = provider.resolve('11');
  const b = provider.resolve('12');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resets, 1);
  releaseReset();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.url, 'https://cdn.example/secure.mp4');
  assert.equal(rb.url, 'https://cdn.example/secure.mp4');
});

test('openhongguo transport validates redirect Location instead of local proxy host', async () => {
  let config;
  const transport = axiosTransport({ request: async value => {
    config = value;
    return { status: 200, headers: {}, data: Buffer.from('ok') };
  } });
  await transport({ method: 'GET', url: 'https://api.example/start', headers: {} });
  assert.doesNotThrow(() => config.beforeRedirect(
    { protocol: 'http:', hostname: '127.0.0.1', port: 7890, path: 'https://cdn.example/next' },
    { headers: { location: 'https://cdn.example/next' } },
    { url: 'https://api.example/start' },
  ));
  assert.throws(() => config.beforeRedirect(
    { protocol: 'http:', hostname: '127.0.0.1', port: 7890, path: 'http://127.0.0.1/secret' },
    { headers: { location: 'http://127.0.0.1/secret' } },
    { url: 'https://api.example/start' },
  ), { code: 'SECURITY_BLOCKED' });
});
