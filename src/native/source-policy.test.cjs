const assert = require('node:assert/strict');
const { test } = require('node:test');
const policy = require('./source-policy');

test('source policy accepts bounded route changes and rejects unsafe expansion', () => {
  const normalized = policy.normalizePolicy({
    revision: 3,
    routes: [
      { id: 'video_tab', order: 1, auth: 'v5', values: { version_code: '75000' } },
      { id: 'preload_current', enabled: false, order: 2 },
    ],
  });
  assert.equal(normalized.revision, 3);
  assert.equal(normalized.routes[0].values.version_code, '75000');
  for (const bad of [
    { id: 'unknown' },
    { id: 'video_tab', auth: 'eval' },
    { id: 'video_tab', url: 'https://example.com/steal' },
    { id: 'video_tab', headers: { Cookie: 'secret' } },
    { id: 'video_tab', values: { device_id: 'attacker' } },
    { id: 'video_tab', body: { '__proto__.polluted': true } },
    { id: 'video_tab', url: 'https://api5-normal-sinfonlineb.fqnovel.com/path?device_id=evil' },
    { id: 'video_tab', headers: { 'user-agent': 'bad\r\nX-Injected: 1' } },
  ]) assert.throws(() => policy.normalizePolicy({ revision: 1, routes: [bad] }));
  assert.throws(() => policy.normalizePolicy({ revision: 1, routes: [{ id: 'video_tab' }, { id: 'video_tab' }] }));
});

test('active policy reorders and disables routes without changing the default set', () => {
  policy.setPolicy(policy.normalizePolicy({
    revision: 4,
    routes: [
      { id: 'legacy', order: 0 },
      { id: 'preload_current', enabled: false },
      { id: 'video_tab', order: 99 },
    ],
  }));
  const routes = policy.applyRoutes([
    { id: 'preload_current', order: 10 }, { id: 'video_tab', order: 20 }, { id: 'legacy', order: 30 },
  ]);
  assert.deepEqual(routes.map(route => route.id), ['legacy', 'video_tab']);
  policy.setPolicy(null);
});
