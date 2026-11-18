const assert = require('node:assert/strict');
const test = require('node:test');

const { safeErrorText, sanitizeIpcValue } = require('./error-text');
const { localMediaEnv } = require('./child-env');
const { downloadTaskView } = require('./download-task-view');
const { createProxyConfig } = require('./proxy-config');
const { createIpcBoundary } = require('./ipc-boundary');

test('diagnostic text removes signed URLs and credentials while retaining local paths', () => {
  const message = safeErrorText('GET https://user:secret@cdn.test/video.m3u8?token=signed Bearer abc failed: /Users/me/video.mp4');
  assert.match(message, /https:\/\/cdn\.test\/\.\.\./);
  assert.match(message, /Bearer \[已隐藏\]/);
  assert.match(message, /\/Users\/me\/video\.mp4/);
  assert.equal(/token=|signed|user:secret/.test(message), false);
});

test('IPC boundary sanitizes error fields and thrown messages', async () => {
  const handles = new Map();
  const pending = [];
  const boundary = createIpcBoundary({
    rawIpcMain: { handle: (name, fn) => handles.set(name, fn) },
    isTrustedSender: () => true,
    getMainWindow: () => ({}),
    getQuitCleanup: () => false,
    getInstaller: () => null,
    blockedChannels: new Set(['save']),
    onPendingChange: change => pending.push(change),
  });
  boundary.handle('get', async () => ({
    items: [{ error: 'https://cdn.test/private?token=secret' }],
    publicUrl: 'https://example.test/page',
  }));
  boundary.handle('fail', async () => { throw new Error('https://cdn.test/private?token=secret'); });
  boundary.handle('save', async () => ({ success: true }));

  const event = {};
  const result = await handles.get('get')(event);
  assert.equal(result.items[0].error, 'https://cdn.test/...');
  assert.equal(result.publicUrl, 'https://example.test/page');
  await assert.rejects(() => handles.get('fail')(event), /https:\/\/cdn\.test\/\.\.\./);
  assert.deepEqual(await handles.get('save')(event), { success: true });
  assert.deepEqual(pending, [1, -1]);
});

test('local media children receive no proxy credentials', () => {
  const env = localMediaEnv({
    PATH: '/bin',
    HTTPS_PROXY: 'http://user:secret@proxy.test:8080',
    no_proxy: 'localhost',
    KEEP: 'value',
  });
  assert.deepEqual(env, { PATH: '/bin', KEEP: 'value' });
});

test('download task view computes shared-path conflicts once and preserves status ordering', () => {
  const tasks = [
    { id: 'completed', status: 'completed', savePath: '/same.mp4', hongguoInfo: { vid: 'one' } },
    { id: 'running', status: 'downloading', savePath: '/run.mp4', hongguoInfo: { vid_index: 2 } },
    { id: 'conflict', status: 'completed', savePath: '/same.mp4', hongguoInfo: { vid: 'two' } },
  ];
  let checks = 0;
  const view = downloadTaskView(tasks, {
    hasCompleteFile: (task, conflicts) => {
      checks++;
      return !conflicts.get(task.savePath)?.has(task);
    },
  });
  assert.equal(view[0].id, 'running');
  assert.equal(view.find(task => task.id === 'completed').status, 'failed');
  assert.equal(view.find(task => task.id === 'conflict').status, 'failed');
  assert.equal(checks, 2);
});

test('proxy config snapshots system routing and keeps credentials out of public URLs', () => {
  const config = createProxyConfig({
    env: { HTTPS_PROXY: 'http://user:secret@proxy.test:8443', NO_PROXY: '' },
  });
  assert.equal(config.snapshotUrl('https://hongguoduanju.com'), 'http://user:secret@proxy.test:8443');
  const resolved = config.resolve({
    proxy_enabled: true,
    proxy_mode: 'custom',
    proxy_host: '127.0.0.1',
    proxy_port: '7890',
    proxy_username: 'fixture',
    proxy_password: 'secret',
  });
  assert.equal(config.publicUrl(resolved.url), 'http://127.0.0.1:7890/');
  assert.equal(config.publicUrl('http://proxy.test:8080/?token=secret#fragment'), 'http://proxy.test:8080/');
  assert.deepEqual(config.requestOption(resolved), {
    protocol: 'http',
    host: '127.0.0.1',
    port: 7890,
    auth: { username: 'fixture', password: 'secret' },
  });
});
