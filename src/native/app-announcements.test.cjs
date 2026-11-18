const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const servicePath = path.join(__dirname, 'app-announcements.js');
const NORMAL = 'https://raw.githubusercontent.com/jackotom/hongguo-drama/main/announcements/normal.json';
const EMERGENCY = 'https://raw.githubusercontent.com/jackotom/hongguo-drama/main/announcements/emergency.json';
const notice = (id = 'notice-1', active = true) => ({ id, title: '播放提示', body: '平台接口、设备校验或网络可能影响播放。', active });
const response = data => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, data: JSON.stringify(data) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(initial = {}, options = {}) {
  const { createAnnouncementService } = require(servicePath);
  let state = structuredClone(initial);
  let clock = new Date(2026, 9, 27, 12).getTime();
  let enabled = true;
  let failSave = false;
  let normalResponse = response(notice('normal-1'));
  let emergencyResponse = response(notice('emergency-1', false));
  const calls = [];
  const store = {
    getAnnouncementState: () => structuredClone(state),
    saveAnnouncementState: patch => {
      if (failSave) throw new Error('EACCES /private/user-data');
      state = { ...state, ...structuredClone(patch) };
    },
  };
  const make = (version = '3.9.0') => createAnnouncementService({
    store, version, now: () => clock, isEnabled: () => enabled,
    request: async (url, config) => {
      calls.push({ url, config });
      const result = url === NORMAL ? normalResponse : emergencyResponse;
      if (result instanceof Error) throw result;
      return result;
    },
    ...options,
  });
  return {
    service: make(), make, calls,
    get state() { return structuredClone(state); },
    set now(value) { clock = value; },
    advance: ms => { clock += ms; },
    set enabled(value) { enabled = value; },
    set failSave(value) { failSave = value; },
    set normal(value) { normalResponse = value; },
    set emergency(value) { emergencyResponse = value; },
  };
}

test('service factory exists before exercising the announcement contract', () => {
  assert.ok(fs.existsSync(servicePath), 'remote announcement service is not implemented');
});

test('normal fetched once per process; urgent-only polling never initializes normal', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.checkAnnouncements({ urgentOnly: true }), { announcement: null });
  assert.deepEqual(f.calls.map(call => call.url), [EMERGENCY]);
  assert.deepEqual(await f.service.checkAnnouncements({ urgentOnly: false }), {
    announcement: { id: 'normal-1', title: '播放提示', body: notice().body, urgent: false },
  });
  await f.service.checkAnnouncements({ urgentOnly: false });
  f.advance(300000);
  await f.service.checkAnnouncements({ urgentOnly: true });
  assert.equal(f.calls.filter(call => call.url === NORMAL).length, 1);
  assert.equal(f.calls.filter(call => call.url === EMERGENCY).length, 2);
});

test('day suppression prevents normal requests, follows local day and expires on upgrade', async () => {
  const f = fixture();
  assert.deepEqual(f.service.dismissAnnouncement({ mode: 'day' }), { success: true });
  assert.equal((await f.make().checkAnnouncements({ urgentOnly: false })).announcement, null);
  assert.equal(f.calls.some(call => call.url === NORMAL), false);
  f.now = new Date(2026, 9, 28, 0, 0, 1).getTime();
  assert.equal((await f.make().checkAnnouncements({ urgentOnly: false })).announcement.id, 'normal-1');
  f.now = new Date(2026, 9, 27, 13).getTime();
  assert.equal((await f.make('4.0.0').checkAnnouncements({ urgentOnly: false })).announcement.id, 'normal-1');
});

test('version suppression survives days, expires on upgrade and preserves urgent read IDs', async () => {
  const f = fixture({ seenUrgentIds: ['old-emergency'] });
  assert.deepEqual(f.service.dismissAnnouncement({ mode: 'version' }), { success: true });
  f.now = new Date(2026, 10, 1).getTime();
  assert.equal((await f.make().checkAnnouncements({ urgentOnly: false })).announcement, null);
  assert.equal(f.calls.some(call => call.url === NORMAL), false);
  assert.equal((await f.make('4.0.0').checkAnnouncements({ urgentOnly: false })).announcement.id, 'normal-1');
  assert.deepEqual(f.state.seenUrgentIds, ['old-emergency']);
});

test('unread emergency wins over normal and survives suppression until explicitly acknowledged', async () => {
  const f = fixture();
  f.emergency = response(notice('emergency-1'));
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.urgent, true);
  assert.deepEqual(f.state, {}, 'fetch must not mark emergency read');
  f.service.dismissAnnouncement({ mode: 'version' });
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: true })).announcement.id, 'emergency-1');
  assert.deepEqual(f.service.acknowledgeAnnouncement({ id: 'not-delivered' }).success, false);
  assert.deepEqual(f.service.acknowledgeAnnouncement({ id: 'normal-1' }).success, false);
  assert.deepEqual(f.service.acknowledgeAnnouncement({ id: 'emergency-1' }), { success: true });
  f.advance(86400000);
  assert.equal((await f.make('4.0.0').checkAnnouncements({ urgentOnly: true })).announcement, null);
  f.emergency = response(notice('emergency-2'));
  assert.equal((await f.make().checkAnnouncements({ urgentOnly: true })).announcement.id, 'emergency-2');
});

test('normal stays available after emergency acknowledgement without refetching normal', async () => {
  const f = fixture();
  f.emergency = response(notice('emergency-1'));
  await f.service.checkAnnouncements({ urgentOnly: false });
  f.service.acknowledgeAnnouncement({ id: 'emergency-1' });
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id, 'normal-1');
  assert.equal(f.calls.filter(call => call.url === NORMAL).length, 1);
});

test('concurrent checks share both requests; emergency attempts rate-limit even after failure', async () => {
  const f = fixture();
  const pending = deferred();
  f.emergency = pending.promise;
  const first = f.service.checkAnnouncements({ urgentOnly: false });
  const second = f.service.checkAnnouncements({ urgentOnly: false });
  const third = f.service.checkAnnouncements({ urgentOnly: true });
  await Promise.resolve();
  assert.equal(f.calls.length, 2);
  pending.resolve(response(notice('emergency-1')));
  for (const result of await Promise.all([first, second, third])) assert.equal(result.announcement.id, 'emergency-1');
  f.advance(299999);
  await f.service.checkAnnouncements({ urgentOnly: true });
  assert.equal(f.calls.length, 2);
  f.advance(1);
  f.emergency = new Error('offline');
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: true })).announcement, null);
  f.advance(299999);
  await f.service.checkAnnouncements({ urgentOnly: true });
  assert.equal(f.calls.length, 3);
  f.advance(1);
  await f.service.checkAnnouncements({ urgentOnly: true });
  assert.equal(f.calls.length, 4);
});

test('failed normal request never retries within process; emergency failure does not hide normal', async () => {
  const f = fixture();
  f.normal = new Error('offline');
  f.emergency = new Error('offline');
  assert.deepEqual(await f.service.checkAnnouncements({ urgentOnly: false }), { announcement: null });
  f.advance(300000);
  await f.service.checkAnnouncements({ urgentOnly: false });
  assert.equal(f.calls.filter(call => call.url === NORMAL).length, 1);
  const next = fixture();
  next.emergency = new Error('offline');
  assert.equal((await next.service.checkAnnouncements({ urgentOnly: false })).announcement.id, 'normal-1');
});

test('only bounded plain JSON with strict schema accepted; fixed anonymous HTTPS configuration', async () => {
  const invalid = [
    response(null), response([]), response({ ...notice(), active: 'true' }),
    response({ ...notice(), id: '' }), response({ ...notice(), id: 'a'.repeat(129) }),
    response({ ...notice(), title: 'x'.repeat(121) }), response({ ...notice(), body: 'x'.repeat(4001) }),
    response({ ...notice(), title: '   ' }), response({ ...notice(), title: 'a\nb' }),
    response({ ...notice(), body: 'bad\u0000text' }), response({ ...notice(), body: '<script>alert(1)</script>' }),
    response({ ...notice(), urgent: true }), response({ ...notice(), url: 'https://other.example' }),
    response(notice('inactive', false)), { ...response(notice()), status: 302 },
    { ...response(notice()), headers: { 'content-type': 'text/html' } },
    { ...response(notice()), data: '<html>not JSON</html>' },
    { ...response(notice()), data: '{' }, { ...response(notice()), data: ' '.repeat(32769) },
  ];
  for (const payload of invalid) {
    const f = fixture();
    f.normal = payload;
    f.emergency = payload;
    assert.deepEqual(await f.service.checkAnnouncements({ urgentOnly: false }), { announcement: null });
  }
  const f = fixture();
  await f.service.checkAnnouncements({ urgentOnly: false });
  for (const { url, config } of f.calls) {
    assert.ok([NORMAL, EMERGENCY].includes(url));
    assert.ok(config.timeout > 0 && config.timeout <= 6000);
    assert.equal(config.maxRedirects, 0);
    assert.ok(config.maxContentLength > 0 && config.maxContentLength <= 32768);
    assert.equal(config.responseType, 'text');
    assert.equal(config.validateStatus(200), true);
    assert.equal(config.validateStatus(302), false);
    assert.equal(config.validateStatus(500), false);
    assert.ok(!config.params && !config.auth && !config.data && !config.headers.Authorization);
    assert.equal(config.headers.Accept, 'application/json');
  }
});

test('preview or proxy startup fallback makes no requests', async () => {
  const f = fixture();
  f.enabled = false;
  assert.deepEqual(await f.service.checkAnnouncements({ urgentOnly: false }), { announcement: null });
  assert.deepEqual(await f.service.checkAnnouncements({ urgentOnly: true }), { announcement: null });
  assert.equal(f.calls.length, 0);
});

test('preferences default on, persist across versions and outrank all other announcement rules', async () => {
  const f = fixture();
  assert.deepEqual(f.service.getAnnouncementPreferences(), { normalEnabled: true, emergencyEnabled: true });
  assert.deepEqual(f.service.setAnnouncementPreferences({ normalEnabled: false, emergencyEnabled: false }), {
    success: true, preferences: { normalEnabled: false, emergencyEnabled: false },
  });
  const upgraded = f.make('4.0.0');
  assert.deepEqual(upgraded.getAnnouncementPreferences(), { normalEnabled: false, emergencyEnabled: false });
  f.emergency = response(notice('emergency-1'));
  assert.equal((await upgraded.checkAnnouncements({ urgentOnly: false })).announcement, null);
  assert.equal(f.calls.length, 0);
  upgraded.dismissAnnouncement({ mode: 'day' });
  assert.equal(upgraded.setAnnouncementPreferences({ emergencyEnabled: true }).success, true);
  assert.equal((await upgraded.checkAnnouncements({ urgentOnly: true })).announcement.id, 'emergency-1');
  assert.deepEqual(f.calls.map(call => call.url), [EMERGENCY]);
  upgraded.acknowledgeAnnouncement({ id: 'emergency-1' });
  upgraded.setAnnouncementPreferences({ emergencyEnabled: false });
  upgraded.setAnnouncementPreferences({ emergencyEnabled: true });
  assert.equal((await upgraded.checkAnnouncements({ urgentOnly: true })).announcement, null);
  assert.equal(f.calls.length, 1, 'reenabling must respect 5-minute throttle');
  const normal = fixture({ preferences: { normalEnabled: true, emergencyEnabled: false } });
  normal.emergency = response(notice('emergency-1'));
  assert.equal((await normal.service.checkAnnouncements({ urgentOnly: false })).announcement.id, 'normal-1');
  assert.deepEqual(normal.calls.map(call => call.url), [NORMAL]);
});

test('disabled normal does not initialize one-time promise; enabling allows first fetch', async () => {
  const f = fixture({ preferences: { normalEnabled: false, emergencyEnabled: false } });
  await f.service.checkAnnouncements({ urgentOnly: false });
  f.service.setAnnouncementPreferences({ normalEnabled: true });
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id, 'normal-1');
  f.service.setAnnouncementPreferences({ normalEnabled: false });
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: false })).announcement, null);
  f.service.setAnnouncementPreferences({ normalEnabled: true });
  f.normal = response(notice('must-not-refetch'));
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id, 'normal-1');
  assert.equal(f.calls.length, 1);
});

for (const stage of ['pending', 'settled']) {
  test(`normal request invalidated by off/on stays discarded when a new check starts while ${stage}`, async () => {
    const f = fixture({ preferences: { normalEnabled: true, emergencyEnabled: false } });
    const pending = deferred();
    f.normal = pending.promise;
    const original = f.service.checkAnnouncements({ urgentOnly: false });
    f.service.setAnnouncementPreferences({ normalEnabled: false });
    f.service.setAnnouncementPreferences({ normalEnabled: true });
    const reopened = stage === 'pending' ? f.service.checkAnnouncements({ urgentOnly: false }) : null;
    pending.resolve(response(notice('late-normal')));
    assert.equal((await original).announcement, null);
    if (reopened) assert.equal((await reopened).announcement, null);
    assert.equal((await f.service.checkAnnouncements({ urgentOnly: false })).announcement, null);
    assert.deepEqual(f.calls.map(call => call.url), [NORMAL]);
  });
}

test('switching off during requests discards late responses, including off/on race', async () => {
  for (const channel of ['normalEnabled', 'emergencyEnabled']) {
    const f = fixture();
    const pending = deferred();
    if (channel === 'normalEnabled') f.normal = pending.promise;
    else f.emergency = pending.promise;
    const check = f.service.checkAnnouncements({ urgentOnly: channel === 'emergencyEnabled' });
    await Promise.resolve();
    f.service.setAnnouncementPreferences({ [channel]: false });
    f.service.setAnnouncementPreferences({ [channel]: true });
    pending.resolve(response(notice('late')));
    assert.equal((await check).announcement, null);
    assert.equal(f.service.acknowledgeAnnouncement({ id: 'late' }).success, false);
  }
});

test('failed acknowledgement reports safe error and prevents repeats within process; next save can persist all read IDs', async () => {
  const f = fixture({ unrelated: 'keep' });
  f.emergency = response(notice('emergency-1'));
  await f.service.checkAnnouncements({ urgentOnly: true });
  f.failSave = true;
  const result = f.service.acknowledgeAnnouncement({ id: 'emergency-1' });
  assert.equal(result.success, false);
  assert.ok(result.error && !result.error.includes('/private/'));
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: true })).announcement, null);
  assert.deepEqual(f.state, { unrelated: 'keep' });
  f.failSave = false;
  assert.equal(f.service.acknowledgeAnnouncement({ id: 'emergency-1' }).success, true);
  assert.deepEqual(f.state.seenUrgentIds, ['emergency-1']);
  assert.equal((await f.make('4.0.0').checkAnnouncements({ urgentOnly: true })).announcement, null);
});

test('failed suppression/preferences writes preserve data and keep previous preferences', () => {
  const f = fixture({ seenUrgentIds: ['keep'], preferences: { normalEnabled: true, emergencyEnabled: false } });
  const original = f.state;
  f.failSave = true;
  assert.equal(f.service.dismissAnnouncement({ mode: 'day' }).success, false);
  assert.equal(f.service.setAnnouncementPreferences({ normalEnabled: false }).success, false);
  assert.deepEqual(f.state, original);
  assert.deepEqual(f.service.getAnnouncementPreferences(), original.preferences);
  for (const payload of [null, [], { normalEnabled: 'false' }, { other: false }]) {
    assert.equal(f.service.setAnnouncementPreferences(payload).success, false);
  }
  assert.equal(f.service.dismissAnnouncement({ mode: 'forever' }).success, false);
  assert.equal(f.service.acknowledgeAnnouncement(null).success, false);
});

test('store announcement patch is independent of settings and rollback preserves original data', () => {
  const store = require('../store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-announcements-'));
  const file = path.join(dir, 'data.json');
  const original = { settings: { root: '/keep', app_updates_enabled: false }, tasks: [{ id: 'download' }], playback: { series: { time: 12 } } };
  fs.writeFileSync(file, JSON.stringify(original));
  try {
    store.init(file);
    const staleSettings = { ...store.getSettings() };
    store.saveAnnouncementState({ seenUrgentIds: ['keep'], preferences: { normalEnabled: false, emergencyEnabled: true } });
    store.saveSettings(staleSettings);
    store.saveAnnouncementState({ normalSuppression: { mode: 'day', version: '3.9.0', day: '2026-10-27' } });
    const before = fs.readFileSync(file, 'utf8');
    const read = store.getAnnouncementState();
    read.seenUrgentIds.push('must-not-mutate-cache');
    assert.deepEqual(store.getAnnouncementState().seenUrgentIds, ['keep']);
    fs.mkdirSync(file + '.tmp');
    assert.throws(() => store.saveAnnouncementState({ seenUrgentIds: ['lost'] }));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(store.getTasks(), original.tasks);
    assert.deepEqual(store.getPlayback(), original.playback);
    assert.deepEqual(store.getSettings(), original.settings);
    assert.deepEqual(store.getAnnouncementState().seenUrgentIds, ['keep']);
    fs.rmdirSync(file + '.tmp');
    fs.writeFileSync(file, '{broken original data');
    store.init(file);
    assert.throws(() => store.saveAnnouncementState({ seenUrgentIds: ['lost'] }), { code: 'STORE_READ_FAILED' });
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken original data');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manual viewing ignores automatic switches and suppression without changing preferences or read IDs', async () => {
  for (const mode of ['day', 'version']) {
    const f = fixture({ preferences: { normalEnabled: false, emergencyEnabled: false }, seenUrgentIds: ['manual-urgent'] });
    f.service.dismissAnnouncement({ mode });
    const before = f.state;
    f.emergency = response(notice('manual-urgent'));
    assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'manual-urgent');
    assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'manual-urgent');
    assert.deepEqual(f.state, before);
    f.emergency = response(notice('inactive', false));
    assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'normal-1');
    assert.deepEqual(f.state, before);
  }
});

test('manually received urgent IDs can be acknowledged without preventing manual rereads', async () => {
  const f = fixture();
  f.emergency = response(notice('manual-urgent'));
  assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'manual-urgent');
  assert.deepEqual(f.state, {});
  assert.deepEqual(f.service.acknowledgeAnnouncement({ id: 'manual-urgent' }), { success: true });
  assert.deepEqual(f.state.seenUrgentIds, ['manual-urgent']);
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: true })).announcement, null);
  assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'manual-urgent');
  assert.deepEqual(f.state.seenUrgentIds, ['manual-urgent']);
});

test('manual reads neither consume nor replace the automatic one-time normal request', async () => {
  const f = fixture({ preferences: { normalEnabled: true, emergencyEnabled: false } });
  f.normal = response(notice('manual-before'));
  assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'manual-before');
  f.normal = response(notice('automatic'));
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id, 'automatic');
  f.normal = response(notice('manual-after'));
  assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'manual-after');
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: false })).announcement.id, 'automatic');
  assert.equal(f.calls.filter(call => call.url === NORMAL).length, 3);
});

test('manual reads do not start or reset the automatic emergency interval', async () => {
  const f = fixture();
  f.emergency = response(notice('urgent-1'));
  await f.service.getCurrentAnnouncement();
  await f.service.checkAnnouncements({ urgentOnly: true });
  assert.equal(f.calls.filter(call => call.url === EMERGENCY).length, 2);
  f.advance(299999);
  f.emergency = response(notice('urgent-2'));
  assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'urgent-2');
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: true })).announcement.id, 'urgent-1');
  assert.equal(f.calls.filter(call => call.url === EMERGENCY).length, 3);
  f.advance(1);
  assert.equal((await f.service.checkAnnouncements({ urgentOnly: true })).announcement.id, 'urgent-2');
  assert.equal(f.calls.filter(call => call.url === EMERGENCY).length, 4);
});

test('concurrent manual reads share both fixed requests and the next manual read fetches fresh data', async () => {
  const f = fixture();
  const pending = deferred();
  f.normal = pending.promise;
  f.emergency = pending.promise;
  const first = f.service.getCurrentAnnouncement();
  const second = f.service.getCurrentAnnouncement();
  assert.deepEqual(f.calls.map(call => call.url).sort(), [NORMAL, EMERGENCY].sort());
  for (const { config } of f.calls) {
    assert.equal(config.maxRedirects, 0);
    assert.equal(config.maxContentLength, 32768);
    assert.equal(config.responseType, 'text');
    assert.equal(config.timeout, 6000);
    assert.ok(config.signal);
  }
  pending.resolve(response(notice('urgent-shared')));
  for (const result of await Promise.all([first, second])) assert.equal(result.announcement.id, 'urgent-shared');
  f.emergency = response(notice('urgent-fresh'));
  assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'urgent-fresh');
  assert.equal(f.calls.length, 4);
});

test('manual empty, failed or invalid responses give readable feedback and allow retry', async () => {
  for (const payload of [response(notice('inactive', false)), new Error('offline /private/secret'),
    { ...response(null), data: '{' }, response({ ...notice(), extra: true }),
    response({ ...notice(), body: '<script>bad</script>' }), { ...response(notice()), data: ' '.repeat(32769) }]) {
    const f = fixture();
    f.normal = payload;
    f.emergency = payload;
    const result = await f.service.getCurrentAnnouncement();
    assert.equal(result.announcement, null);
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
    assert.ok(!result.error.includes('/private/'));
    assert.deepEqual(f.state, {});
    f.normal = response(notice('recovered'));
    assert.equal((await f.service.getCurrentAnnouncement()).announcement.id, 'recovered');
  }
});

test('manual reads block preview or proxy fallback before and after requests without acknowledging IDs', async () => {
  const f = fixture();
  f.enabled = false;
  const blocked = await f.service.getCurrentAnnouncement();
  assert.equal(blocked.announcement, null);
  assert.ok(blocked.error);
  assert.equal(f.calls.length, 0);
  f.enabled = true;
  const pending = deferred();
  f.emergency = pending.promise;
  const check = f.service.getCurrentAnnouncement();
  f.enabled = false;
  pending.resolve(response(notice('blocked-urgent')));
  const late = await check;
  assert.equal(late.announcement, null);
  assert.ok(late.error);
  assert.equal(f.service.acknowledgeAnnouncement({ id: 'blocked-urgent' }).success, false);
  assert.deepEqual(f.state, {});
});

test('preload forwards contracts and preference subscription can unsubscribe', async () => {
  let api;
  const calls = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke: async (...args) => { calls.push(args); return { success: true }; },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => { assert.equal(listeners.get(channel), listener); listeners.delete(channel); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../preload.js'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer }; },
  });
  await api.checkAnnouncements({ urgentOnly: true });
  await api.acknowledgeAnnouncement({ id: 'emergency-1' });
  await api.dismissAnnouncement({ mode: 'day' });
  await api.getAnnouncementPreferences();
  await api.setAnnouncementPreferences({ normalEnabled: false });
  await api.getCurrentAnnouncement();
  assert.deepEqual(calls.map(call => call[0]), ['check-announcements', 'acknowledge-announcement', 'dismiss-announcement', 'get-announcement-preferences', 'set-announcement-preferences', 'get-current-announcement']);
  assert.deepEqual(calls[0][1], { urgentOnly: true });
  assert.equal(calls[5].length, 1);
  let received;
  const unsubscribe = api.onAnnouncementPreferences(value => { received = value; });
  const preferences = { normalEnabled: false, emergencyEnabled: true };
  listeners.get('announcement-preferences-changed')({}, preferences);
  assert.equal(received, preferences);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test('main IPC uses trusted main-window/frame guard, broadcasts only saved preferences and blocks preview/fallback network', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const { createAnnouncementService } = require(servicePath);
  const { createRendererSecurity } = require('./renderer-security');
  const { createIpcBoundary } = require('./ipc-boundary');
  const handlers = new Map();
  const events = [];
  const frame = { url: 'http://localhost:5173/' };
  const mainWindow = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const event = { sender: mainWindow.webContents, senderFrame: frame };
  let state = {};
  let failed = false;
  let requests = 0;
  const context = vm.createContext({
    createAnnouncementService, APP_VERSION: '3.9.0', IS_PREVIEW: false, proxyStartupFallback: false,
    createIpcBoundary,
    mainWindow, quitCleanup: null, appUpdateInstaller: null, pendingUpdateOperations: 0,
    rendererSecurity: createRendererSecurity('/temporary/index.html', frame.url),
    rawIpcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    axios: { get: async () => { requests++; return response(notice('inactive', false)); } },
    store: {
      getAnnouncementState: () => structuredClone(state),
      saveAnnouncementState: patch => { if (failed) throw new Error('disk full'); state = { ...state, ...patch }; },
    },
    sendToRenderer: (...args) => events.push(args),
  });
  vm.runInContext(source.slice(source.indexOf('const UPDATE_BLOCKED_CHANNELS'), source.indexOf('let storageError')), context);
  const start = source.indexOf('// ===== 远程公告');
  assert.ok(start >= 0, 'main announcement IPC block is missing');
  vm.runInContext(source.slice(start, source.indexOf('// ===== 应用内更新', start)), context);
  for (const channel of ['check-announcements', 'acknowledge-announcement', 'dismiss-announcement', 'get-announcement-preferences', 'set-announcement-preferences']) {
    assert.ok(handlers.has(channel), channel);
    await assert.rejects(handlers.get(channel)({ ...event, senderFrame: { ...frame } }, {}), /窗口请求无效/);
  }
  await handlers.get('set-announcement-preferences')(event, { normalEnabled: false });
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'announcement-preferences-changed');
  assert.deepEqual(events[0][1], { normalEnabled: false, emergencyEnabled: true });
  failed = true;
  assert.equal((await handlers.get('set-announcement-preferences')(event, { emergencyEnabled: false })).success, false);
  assert.equal(events.length, 1);
  context.proxyStartupFallback = true;
  assert.equal((await handlers.get('check-announcements')(event, { urgentOnly: false })).announcement, null);
  context.proxyStartupFallback = false;
  context.IS_PREVIEW = true;
  assert.equal((await handlers.get('check-announcements')(event, { urgentOnly: false })).announcement, null);
  assert.equal(requests, 0);
});

test('checked-in announcement files pass service parser and respect their active flags', async () => {
  for (const channel of ['normal', 'emergency']) {
    const raw = fs.readFileSync(path.join(__dirname, `../../announcements/${channel}.json`), 'utf8');
    const data = JSON.parse(raw);
    assert.equal(typeof data.active, 'boolean');
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 32768);
    const f = fixture({ preferences: { normalEnabled: channel === 'normal', emergencyEnabled: channel === 'emergency' } });
    const options = { urgentOnly: channel === 'emergency' };
    const expected = { id: data.id, title: data.title.trim(), body: data.body.trim(), urgent: options.urgentOnly };
    f[channel] = { ...response(null), data: raw };
    assert.deepEqual((await f.service.checkAnnouncements(options)).announcement, data.active ? expected : null);
    if (!data.active) {
      f[channel] = response({ ...data, active: true });
      assert.deepEqual((await f.make().checkAnnouncements(options)).announcement, expected);
    }
  }
});
