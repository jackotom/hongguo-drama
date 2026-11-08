// Offline proxy routing checks: real main-process handlers, isolated env, no network/app data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-proxy-'));
const target = 'https://hongguoduanju.com';
const system = { proxy_enabled: true, proxy_mode: 'system' };
const custom = { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 19192 };
let failures = 0;
function realResolver(env) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(req.resolve('proxy-from-env'), 'utf8'), { module, exports: module.exports, process: { env }, URL });
  return module.exports.getProxyForUrl;
}
function load(env, initialSettings = { root }, requestError = null) {
  const handlers = {}, proxyCalls = [], requests = [], menus = [], app = new EventEmitter();
  let saved = structuredClone(initialSettings);
  const store = {
    getSettings: () => structuredClone(saved),
    saveSettings: next => { saved = structuredClone(next); },
  };
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, Menu: { buildFromTemplate: value => value, setApplicationMenu: value => menus.push(value) }, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} }, session: { defaultSession: { setProxy: async config => proxyCalls.push(config) } } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './src/store' ? store : name === 'axios' ? { get: async (url, options) => { requests.push({ url, options }); if (typeof requestError === 'function') return requestError(url, options); if (requestError) throw requestError; return { status: 200 }; } } : req(name), __dirname: path.dirname(source), process: { ...process, env: { ...env } }, console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  return { context, handlers, proxyCalls, requests, menus, session: electron.session.defaultSession, store, saved: () => structuredClone(saved) };
}
async function check(name, run) {
  try { await run(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
}
(async () => {
  await check('system draft tests startup route without changing the active proxy', async () => {
    const env = { HTTPS_PROXY: 'http://startup:19191' }, h = load(env);
    for (const active of [custom, { proxy_enabled: false }]) {
      await h.context.applyProxySettings(active);
      const before = { ...h.context.process.env }, sessions = h.proxyCalls.length;
      const result = await h.handlers['test-proxy']({}, system);
      assert.equal(h.requests.at(-1).options.proxy?.host, 'startup');
      assert.equal(result.via, 'http://startup:19191/');
      assert.deepEqual({ ...h.context.process.env }, before);
      assert.equal(h.proxyCalls.length, sessions);
    }
  });
  await check('snapshot routing matches installed proxy-from-env for protocol, priority and bypass', () => {
    const cases = [
      [{}, target],
      [{ HTTP_PROXY: 'http://http-only:80' }, target],
      [{ HTTPS_PROXY: 'http://upper:80', https_proxy: 'http://lower:81' }, target],
      [{ HTTPS_PROXY: 'http://upper:80', https_proxy: '' }, target],
      [{ ALL_PROXY: 'http://upper:80', all_proxy: 'http://lower:81' }, target],
      [{ HTTPS_PROXY: 'proxy.test:443' }, target],
      ...['*', '.baidu.com', '*.baidu.com', 'www.baidu.com:443', 'www.baidu.com:80', 'BAIDU.com, WWW.BAIDU.COM', '', 'other.test'].map(NO_PROXY => [{ HTTPS_PROXY: 'http://proxy:80', NO_PROXY }, target]),
      [{ HTTPS_PROXY: 'http://proxy:80', NO_PROXY: '*', no_proxy: 'other.test' }, target],
      [{ HTTPS_PROXY: 'http://proxy:80', NO_PROXY: '*', no_proxy: '' }, target],
      [{ HTTP_PROXY: 'proxy:80', HTTPS_PROXY: 'other:443' }, 'http://example.test'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: '[::1]:443' }, 'https://[::1]/'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: '[::1]:80' }, 'https://[::1]/'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: 'example.test:21' }, 'ftp://example.test'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: 'example.test:70' }, 'gopher://example.test'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: 'example.test:80' }, 'ws://example.test'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: 'example.test:443' }, 'wss://example.test'],
      [{ ALL_PROXY: 'proxy:80' }, 'not a URL'],
    ];
    for (const [env, url] of cases) {
      const h = load(env);
      assert.equal(h.context.snapshotProxyUrl(url) || '', realResolver(env)(url), `${url} ${JSON.stringify(env)}`);
    }
  });
  await check('test reports actual direct or proxy route, including HTTP-only and NO_PROXY', async () => {
    for (const env of [{}, { HTTP_PROXY: 'http://http-only:80' }, { HTTPS_PROXY: 'http://proxy:80', NO_PROXY: '*' }, { HTTPS_PROXY: 'http://proxy:80', NO_PROXY: 'hongguoduanju.com' }, { HTTPS_PROXY: 'http://upper:80', https_proxy: 'http://lower:81' }]) {
      const h = load(env), result = await h.handlers['test-proxy']({}, system), expected = realResolver(env)(target);
      assert.equal(h.requests[0].url, target);
      if (expected) {
        assert.equal(h.requests[0].options.proxy.host, new URL(expected).hostname);
        assert.equal(result.via, new URL(expected).toString());
      } else {
        assert.equal(h.requests[0].options.proxy, false);
        assert.equal(result.via, '(直连)');
      }
    }
  });
  await check('a stalled proxy handshake is bounded by an independent abort deadline', async () => {
    const h = load({}, { root }, (_url, options) => new Promise((resolve, reject) => {
      assert(options.signal, 'the probe must supply a cancellation signal');
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), {code:'ERR_CANCELED'})), {once:true});
    }));
    h.context.setTimeout = (fn, ms) => setTimeout(fn, Math.min(ms, 5));
    const result = await h.handlers['test-proxy']({}, custom);
    assert.equal(result.success, false);
    assert.match(result.error, /超时/);
    assert.equal(h.requests[0].options.signal.aborted, true);
  });
  await check('interface language updates native menu and rejects unsupported values', async () => {
    const h = load({});
    assert.equal((await h.handlers['set-interface-language']({}, 'en')).success, true);
    if (process.platform === 'darwin') assert.equal(h.menus.at(-1)[1].label, 'Edit');
    const count = h.menus.length;
    assert.equal((await h.handlers['set-interface-language']({}, 'invalid')).success, false);
    assert.equal(h.menus.length, count);
    assert.equal((await h.handlers['set-interface-language']({}, 'zh-CN')).success, true);
    if (process.platform === 'darwin') assert.equal(h.menus.at(-1)[1].label, '编辑');
  });
  await check('official probe keeps TLS verification and reports certificate failures without fallback', async () => {
    const h = load({}, { root }, Object.assign(new Error('certificate chain failure'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }));
    const result = await h.handlers['test-proxy']({}, { proxy_enabled: false });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, target);
    assert.equal(h.requests[0].options.httpsAgent, undefined);
    assert.notEqual(h.context.process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
    assert.equal(result.success, false);
    assert.equal(result.code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    assert.match(result.error, /证书校验失败/);
  });
  await check('invalid custom proxy is rejected before saving and does not change the active proxy', async () => {
    const h = load({}, { root });
    const before = h.saved(), sessions = h.proxyCalls.length;
    const result = await h.handlers['save-settings']({}, { proxy_enabled: true, proxy_mode: 'custom', proxy_host: 'ftp://127.0.0.1', proxy_port: '21' });
    assert.equal(result.success, false);
    assert.match(result.error, /HTTP|HTTPS|SOCKS/);
    assert.deepEqual(h.saved(), before, 'bad proxy must not be persisted');
    assert.equal(h.proxyCalls.length, sessions, 'bad proxy must not be applied');
  });
  await check('a valid custom proxy is applied and saved', async () => {
    const h = load({}, { root });
    const result = await h.handlers['save-settings']({}, { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: '19192' });
    assert.equal(result.success, true, result.error);
    assert.equal(h.saved().proxy_enabled, true);
    assert.equal(h.proxyCalls.at(-1).mode, 'fixed_servers');
  });
  await check('a persisted invalid proxy starts in direct mode without rewriting settings', async () => {
    const h = load({}, { root, proxy_enabled: true, proxy_mode: 'custom', proxy_host: 'ftp://127.0.0.1', proxy_port: '21' });
    const before = h.saved();
    const result = await h.context.applyProxyForStartup(h.context.getCurrentSettings());
    assert.equal(result.fallback, true);
    assert.equal(h.proxyCalls.at(-1).mode, 'direct');
    assert.deepEqual(h.saved(), before, 'startup fallback must not rewrite the bad configuration');
  });

  await check('concurrent saves preserve the later auto-delete choice', async () => {
    const h = load({}, { root, proxy_enabled: false, auto_delete_watched: true });
    let release;
    h.session.setProxy = async config => {
      if (config.mode === 'fixed_servers') await new Promise(resolve => { release = resolve; });
    };
    const first = h.handlers['save-settings']({}, custom);
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    assert.equal(typeof release, 'function');
    const second = h.handlers['save-settings']({}, { auto_delete_watched: false });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    release();
    const results = await Promise.all([first, second]);
    assert(results.every(result => result.success));
    assert.equal(h.saved().auto_delete_watched, false, 'an older save must not restore auto-delete');
    assert.equal(h.saved().proxy_enabled, true);
  });

  await check('a timed-out proxy cannot overwrite a completed direct fallback', async () => {
    const h = load({});
    let release, held = false;
    h.session.setProxy = async config => {
      if (config.mode === 'fixed_servers' && !held) {
        held = true;
        await new Promise(resolve => { release = resolve; });
      }
      h.proxyCalls.push(config);
    };
    await assert.rejects(h.context.applyProxyWithTimeout(custom, 5), /超时/);
    await h.context.applyProxySettings({ proxy_enabled: false });
    release();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(h.context.process.env.HTTPS_PROXY, undefined, 'late custom work must not restore the environment proxy');
    assert.equal(h.proxyCalls.at(-1).mode, 'direct', 'late native completion must restore the current route');
  });

  await check('startup fallback pauses automatic update network requests', async () => {
    const h = load({});
    vm.runInContext('proxyStartupFallback = true', h.context);
    const result = await h.handlers['check-app-update']({});
    assert.equal(result.enabled, false);
    assert.equal(h.requests.length, 0, 'no automatic external request before the proxy is repaired');
  });

  await check('a hung native proxy save times out and releases the save queue', async () => {
    const h = load({}, { root, proxy_enabled: false });
    const apply = h.context.applyProxyWithTimeout;
    h.context.applyProxyWithTimeout = settings => apply(settings, 5);
    h.session.setProxy = async config => {
      if (config.mode === 'fixed_servers') return new Promise(() => {});
      h.proxyCalls.push(config);
    };
    let timer;
    try {
      const result = await Promise.race([h.handlers['save-settings']({}, custom),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('proxy save left the queue blocked')), 150); })]);
      assert.equal(result.success, false);
      assert.match(result.error, /超时/);
      assert.equal(h.saved().proxy_enabled, false);
      assert.equal((await h.handlers['save-settings']({}, { auto_delete_watched: false })).success, true);
    } finally { clearTimeout(timer); }
  });

  await check('custom overrides bypass, direct disables proxies, system restores exact env and Chromium system mode', async () => {
    const env = { HTTPS_PROXY: 'http://upper:80', https_proxy: '', HTTP_PROXY: '', NO_PROXY: '*', no_proxy: '' }, h = load(env);
    const route = realResolver(h.context.process.env);
    await h.context.applyProxySettings(custom);
    assert.equal(route(target), 'http://127.0.0.1:19192');
    assert.equal(h.context.process.env.NO_PROXY, undefined);
    assert.equal(h.context.process.env.no_proxy, undefined);
    await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'direct' });
    assert.equal(route(target), '');
    await h.context.applyProxySettings(system);
    assert.deepEqual({ ...h.context.process.env }, env);
    assert.equal(h.proxyCalls.at(-1).mode, 'system');
    assert.equal(route(target), '');
  });
  assert.equal(failures, 0, `${failures} proxy routing regressions`);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
