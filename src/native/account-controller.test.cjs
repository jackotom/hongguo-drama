const assert = require('node:assert/strict');
const test = require('node:test');

const { createAccountController } = require('./account-controller');

test('account controller scopes resume positions and registers the existing IPC contract', async () => {
  const handlers = new Map();
  const sent = [];
  let navigation;
  let signedIn = false;
  let partitionCleared = 0, partitionProxied = 0;
  const partition = {
    clearStorageData: async () => { partitionCleared++; },
    fetch: async () => ({ status: 200, headers: new Map(), text: async () => '' }),
  };
  const service = {
    async status() { return { success: true, signedIn }; },
    async startLogin() { signedIn = true; return { success: true, loginId: 'login' }; },
    async pollLogin() { return { success: true, status: 'signed-in' }; },
    row(id) { return id === '1000001' ? { episode_id: 'v1', vid_index: 1, currentTime: 12, updatedAt: 1 } : null; },
    async refreshHistory() { return { success: true }; },
    async history() { return { success: true, rows: [] }; },
    cancelLogin() {},
  };
  const entries = [{ series_id: '1000001', series_title: 'Fixture', episodes: [{ vid: 'v1', vid_index: 1 }] }];
  const controller = createAccountController({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { getPath: () => '/fixture' },
    session: {
      fromPartition: () => partition,
      defaultSession: { cookies: { get: async () => [], remove: async () => {} } },
    },
    safeStorage: {},
    BrowserWindow: class {},
    createAccountService: () => service,
    safeMessage: error => error.message,
    hongguo: { fetchEpisodeList: async () => entries[0] },
    getSeriesRegistry: () => entries,
    upsertSeriesRegistry: () => entries[0],
    saveSeriesRegistry() {},
    navigateToPlayer: value => { navigation = value; return { success: true }; },
    send: (...value) => sent.push(value),
    applyProxyToSession: async session => {
      assert.equal(session, partition);
      partitionProxied++;
    },
  });

  assert.equal((await handlers.get('get-account-status')({})).success, true);
  assert.deepEqual(await handlers.get('play-account-history')({}, '1000001'), { success: true });
  assert.deepEqual(navigation, { seriesId: '1000001', vidIndex: 1, resume: true });
  assert.deepEqual(controller.takeResumePosition('1000001'), { vid_index: 1, currentTime: 12, updatedAt: 1 });
  assert.equal(controller.takeResumePosition('1000001'), null);
  assert.equal((await handlers.get('start-account-login')({})).success, true);
  assert.equal(partitionProxied, 1);
  assert.ok(partitionCleared >= 1, 'starting a new login must clear the dedicated partition cookies');
  await handlers.get('poll-account-login')({}, 'login');
  assert.ok(sent.some(([name, payload]) => name === 'account-updated' && payload.signedIn === true));
});
