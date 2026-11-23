const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadNative } = require('./hongguo-cancellation-fixture.cjs');

const media = 'https://v3-hgweb.qznovelvod.com/path/video.mp4?token=synthetic';

function fixture(payload, status = 200) {
  const calls = [];
  const native = loadNative({ axios: async config => {
    calls.push(config);
    return { status, headers: {}, data: payload };
  } });
  return { calls, native };
}

test('official public fallback supplies a complete 360p MP4 when App playback is empty', async () => {
  const f = fixture({ base_resp: { StatusCode: 0 }, main_url: media, url_expire: Math.floor(Date.now() / 1000) + 60 });
  const result = await f.native.fetchPublicFallbackPlayUrl('7690125606729550872', AbortSignal.timeout(5000));
  assert.equal(result.url, media);
  assert.equal(result.source, 'web');
  assert.equal(result.quality, '360p');
  assert.equal(result.width, 360);
  assert.equal(result.height, 640);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(new URL(f.calls[0].url).pathname, '/api/video/protected/fallback-play-info');
  assert.deepEqual(f.calls[0].data, { item_id: '7690125606729550872' });
  assert.equal(f.calls[0].maxRedirects, 0);
});

test('public fallback rejects expired, private, unsupported or failed responses', async () => {
  const expired = fixture({ base_resp: { StatusCode: 0 }, main_url: media, url_expire: 1 });
  assert.equal(await expired.native.fetchPublicFallbackPlayUrl('11', AbortSignal.timeout(5000)), null);

  const privateUrl = fixture({ base_resp: { StatusCode: 0 },
    main_url: 'https://127.0.0.1/private.mp4', url_expire: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(await privateUrl.native.fetchPublicFallbackPlayUrl('11', AbortSignal.timeout(5000)), null);

  const unsupportedHost = fixture({ base_resp: { StatusCode: 0 },
    main_url: 'https://example.com/video.mp4', url_expire: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(await unsupportedHost.native.fetchPublicFallbackPlayUrl('11', AbortSignal.timeout(5000)), null);

  const rejected = fixture({ error: 'public_fallback_unavailable' }, 403);
  await assert.rejects(rejected.native.fetchPublicFallbackPlayUrl('11', AbortSignal.timeout(5000)),
    { code: 'HTTP_403' });
});
