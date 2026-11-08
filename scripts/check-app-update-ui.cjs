// Isolated renderer checks: no network, installed app, user data or actual timers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const idle = { supported: true, reason: '', status: 'idle', version: null, percent: 0, error: '' };
const release = { version: '9.0', url: 'https://github.com/jackotom/hongguo-drama/releases/tag/v9.0' };
function mount(api = {}, component = 'AppUpdateNotice', props = {}) {
  const slots = [], effects = [], cleanups = [], effectFns = [], events = new Map(), timers = new Map();
  let cursor = 0, tree, timerId = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((d, j) => !Object.is(d, slots[i][j]))) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); effectFns[i] = fn; cleanups[i] = fn(); }); } },
  };
  const defaults = { checkAppUpdate: async () => ({ enabled: true, release }), getAppUpdateState: async () => idle, getSettings: async () => ({ app_updates_enabled: true }) };
  const window = { electronAPI: new Proxy({ ...defaults, ...api }, { get: (o, k) => o[k] || (k.startsWith('on') ? cb => { events.set(k, cb); return () => events.delete(k); } : async () => ({ success: true })) }),
    addEventListener: (name, cb) => events.set(name, cb), removeEventListener: name => events.delete(name), dispatchEvent: event => events.get(event.type)?.(event) };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/components/${component}.jsx`, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
    module, exports: module.exports, require: name => name === '../i18n' ? { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {} } : name === 'react' ? react : name === './useDialogKeyboard' ? () => {}
      : name === './danmakuSource.mjs' ? { useDanmakuSource: () => 'official', writeDanmakuSource() {} } : {}, window, console,
    CustomEvent: class { constructor(type) { this.type = type; } },
    setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id), setTimeout: () => 1, clearTimeout() {},
  });
  const render = () => { cursor = 0; tree = module.exports.default(props); effects.splice(0).forEach(fn => fn()); };
  const nodes = () => { const out = []; const walk = n => { if (!n || typeof n !== 'object') return; out.push(n); n.children?.forEach(walk); }; walk(tree); return out; };
  const textOf = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(textOf).join('') || '';
  const find = fn => nodes().find(fn);
  render();
  return { render, find, nodes, text: () => textOf(tree), button: label => find(n => n.type === 'button' && (textOf(n).includes(label) || n.props['aria-label'] === label)),
    flush: async () => { for (let i = 0; i < 25; i++) { await Promise.resolve(); render(); } }, emit: (name, data) => events.get(name)?.(data),
    restartEffects: () => { cleanups.forEach(fn => fn?.()); effectFns.forEach((fn, i) => { cleanups[i] = fn(); }); }, timer: () => timers.forEach(fn => fn()), unmount: () => cleanups.forEach(fn => fn?.()), events };
}
(async () => {
  let passed = 0, failed = 0;
  const test = async (name, fn) => { try { await fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); } };
  await test('download progress, close/reopen, and explicit install', async () => {
    let downloads = 0, installs = 0, finish;
    const ui = mount({ downloadAppUpdate: () => { downloads++; return new Promise(r => { finish = r; }); }, installAppUpdate: async () => { installs++; return { success: true }; } });
    await ui.flush(); assert.ok(ui.button('下载更新'), 'new version must offer in-app download');
    const click = ui.button('下载更新').props.onClick; const pending = click(); click(); await ui.flush(); assert.equal(downloads, 1);
    ui.emit('onAppUpdateState', { ...idle, status: 'downloading', version: '9.0', percent: 37.2 }); await ui.flush();
    assert.ok(ui.text().includes('37%')); assert.ok(ui.find(n => n.type === 'progress' && n.props.value === 37));
    assert.ok(!ui.nodes().some(n => n.props['aria-live'] && /37%/.test(n.children.map(c => typeof c === 'string' ? c : '').join(''))));
    ui.button('关闭更新提醒').props.onClick(); await ui.flush(); assert.equal(ui.text(), '');
    ui.emit('onAppUpdateState', { ...idle, status: 'downloaded', version: '9.0', percent: 100 }); finish({ success: true }); await pending; await ui.flush(); assert.equal(installs, 0); assert.equal(ui.text(), '');
    ui.emit('hongguo-check-app-update'); await ui.flush(); assert.ok(ui.button('重启并安装')); assert.equal(installs, 0);
    await ui.button('重启并安装').props.onClick(); assert.equal(installs, 1); ui.unmount(); assert.equal(ui.events.size, 0);
  });
  await test('manual check reports no new release and network failure', async () => {
    let result = { enabled: true, release: null };
    const ui = mount({ checkAppUpdate: async () => result }); await ui.flush(); assert.equal(ui.text(), '');
    ui.emit('hongguo-check-app-update'); await ui.flush(); assert.ok(ui.text().includes('已是最新版本'));
    result = { enabled: true, release: null, error: '网络连接失败' }; ui.emit('hongguo-check-app-update'); await ui.flush(); assert.ok(ui.text().includes('网络连接失败')); assert.ok(ui.button('重新检查')); ui.unmount();
  });
  await test('disabled checks preserve the backend reason and recover after proxy repair', async () => {
    let result = { enabled: false, release: null, error: '请先修复或明确关闭代理。' };
    const ui = mount({ checkAppUpdate: async () => result }); await ui.flush(); assert.equal(ui.text(), '');
    ui.emit('hongguo-check-app-update'); await ui.flush();
    assert.ok(ui.text().includes(result.error), 'manual checks must show the proxy failure reason');
    assert.ok(!ui.text().includes('更新检测已关闭'), 'a blocked proxy is not an update preference');
    result = { enabled: false, release: null };
    await ui.button('重新检查').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('更新检测已关闭'));
    result = { enabled: true, release };
    await ui.button('重新检查').props.onClick(); await ui.flush(); assert.ok(ui.button('下载更新')); ui.unmount();
  });
  await test('unsupported installation provides accurate manual fallback', async () => {
    let opened = 0;
    const ui = mount({ getAppUpdateState: async () => ({ ...idle, supported: false, reason: '便携版请手动安装新版' }), openAppUpdate: async () => { opened++; return { success: true }; } });
    await ui.flush(); assert.ok(ui.text().includes('便携版请手动安装新版')); assert.equal(ui.button('下载更新'), undefined);
    await ui.button('前往 GitHub 下载').props.onClick(); assert.equal(opened, 1); ui.unmount();
  });
  await test('disable blocks late check and retained download/install callbacks', async () => {
    let calls = 0;
    const ui = mount({ downloadAppUpdate: async () => { calls++; return { success: true }; } }); await ui.flush();
    const click = ui.button('下载更新')?.props.onClick; assert.ok(click);
    ui.emit('onAppUpdatePreference', false); await ui.flush(); await click(); assert.equal(calls, 0); assert.equal(ui.text(), '');
    ui.emit('onAppUpdateState', { ...idle, status: 'downloaded', version: '9.0' }); await ui.flush(); assert.equal(ui.text(), ''); ui.unmount();
    let resolve;
    const late = mount({ checkAppUpdate: () => new Promise(r => { resolve = r; }) }); await late.flush(); late.emit('onAppUpdatePreference', false); resolve({ enabled: true, release }); await late.flush(); assert.equal(late.text(), ''); late.unmount();
  });
  await test('download errors retry and install refusal preserves install action', async () => {
    let attempts = 0;
    const ui = mount({ downloadAppUpdate: async () => { attempts++; return { success: false, error: '校验失败，请重试' }; }, installAppUpdate: async () => ({ success: false, error: '请等待下载任务完成' }) });
    await ui.flush(); assert.ok(ui.button('下载更新')); await ui.button('下载更新').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('校验失败'));
    await ui.button('下载更新').props.onClick(); assert.equal(attempts, 2);
    ui.emit('onAppUpdateState', { ...idle, status: 'downloaded', version: '9.0' }); await ui.flush(); await ui.button('重启并安装').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('请等待下载任务完成')); assert.equal(!!ui.button('重启并安装').props.disabled, false); ui.unmount();
  });
  await test('closing a manual check suppresses its late result', async () => {
    let resolve, first = true;
    const ui = mount({ checkAppUpdate: async () => { if (first) { first = false; return { enabled: true, release: null }; } return new Promise(r => { resolve = r; }); } }); await ui.flush();
    ui.emit('hongguo-check-app-update'); await ui.flush(); ui.button('关闭更新提醒').props.onClick(); resolve({ enabled: true, release }); await ui.flush(); assert.equal(ui.text(), ''); ui.unmount();
  });
  await test('StrictMode effect restart does not leave check pending forever', async () => {
    const ui = mount(); ui.restartEffects(); await ui.flush(); assert.ok(ui.button('下载更新')); assert.equal(!!ui.button('下载更新').props.disabled, false); ui.unmount();
  });
  await test('manual check joins initial request and still reports its failure', async () => {
    let resolve, checks = 0;
    const ui = mount({ checkAppUpdate: () => { checks++; return new Promise(r => { resolve = r; }); } });
    ui.emit('hongguo-check-app-update'); await ui.flush(); assert.equal(checks, 1);
    resolve({ enabled: true, release: null, error: '无法连接更新服务' }); await ui.flush(); assert.ok(ui.text().includes('无法连接更新服务')); assert.ok(!ui.text().includes('已是最新版本')); ui.unmount();
  });
  await test('failed recheck clears stale release and can recover inside the notice', async () => {
    let result = { enabled: true, release }, checks = 0;
    const ui = mount({ checkAppUpdate: async () => { checks++; return result; } }); await ui.flush();
    assert.ok(ui.button('下载更新')); result = { enabled: true, release: null, error: '网络中断，版本信息已失效' };
    ui.emit('hongguo-check-app-update'); await ui.flush();
    assert.ok(ui.button('重新检查'), 'failed check with a previous release must expose retry');
    assert.equal(ui.button('下载更新'), undefined, 'invalidated release must not keep its download action');
    assert.ok(ui.button('前往发布页手动下载'), 'failed checks retain the fixed official release fallback');
    result = { enabled: true, release }; await ui.button('重新检查').props.onClick(); await ui.flush();
    assert.equal(checks, 3); assert.ok(ui.button('下载更新')); assert.ok(!ui.text().includes('版本信息已失效')); ui.unmount();
  });
  await test('failed download provides an explicit manual release fallback', async () => {
    let opened = 0;
    const ui = mount({ downloadAppUpdate: async () => ({ success: false, error: '更新下载校验失败' }), openAppUpdate: async () => { opened++; return { success: true }; } });
    await ui.flush(); await ui.button('下载更新').props.onClick(); await ui.flush();
    assert.ok(ui.button('前往发布页手动下载')); await ui.button('前往发布页手动下载').props.onClick(); assert.equal(opened, 1); ui.unmount();
  });
  await test('manual download remains reachable while downloading and checking', async () => {
    let opened = 0, finish;
    const ui = mount({ downloadAppUpdate: () => new Promise(r => { finish = r; }), openAppUpdate: async () => { opened++; return { success: true }; } });
    await ui.flush(); assert.ok(ui.button('前往发布页手动下载'));
    const pending = ui.button('下载更新').props.onClick();
    for (const status of ['checking', 'downloading']) {
      ui.emit('onAppUpdateState', { ...idle, status, version: '9.0' }); await ui.flush();
      const manual = ui.button('前往发布页手动下载'); assert.ok(manual); assert.equal(!!manual.props.disabled, false);
      await manual.props.onClick();
    }
    assert.equal(opened, 2); finish({ success: true }); await pending; ui.unmount();
  });
  await test('cancel ignores old download response and allows retry', async () => {
    let cancelled = 0; const completions = [];
    const ui = mount({ downloadAppUpdate: () => new Promise(r => completions.push(r)), cancelAppUpdate: async () => { cancelled++; return { success: true, state: idle }; } });
    await ui.flush(); const old = ui.button('下载更新').props.onClick();
    ui.emit('onAppUpdateState', { ...idle, status: 'checking', version: '9.0' }); await ui.flush();
    assert.ok(ui.button('取消下载')); await ui.button('取消下载').props.onClick(); await ui.flush();
    assert.equal(cancelled, 1); assert.equal(!!ui.button('下载更新').props.disabled, false);
    const retry = ui.button('下载更新').props.onClick();
    ui.emit('onAppUpdateState', { ...idle, status: 'downloading', version: '9.0', percent: 20 }); await ui.flush();
    completions[0]({ success: false, error: '更新已取消。', state: idle }); await old; await ui.flush();
    assert.ok(ui.text().includes('20%')); assert.ok(!ui.text().includes('更新已取消。'));
    assert.equal(ui.button('正在下载…').props.disabled, true);
    completions[1]({ success: true, state: { ...idle, status: 'downloaded', version: '9.0', percent: 100 } }); await retry; await ui.flush();
    assert.ok(ui.button('重启并安装')); ui.unmount();
  });
  await test('late native install failure remains recoverable without a check release', async () => {
    let opened = 0;
    const ui = mount({ checkAppUpdate: async () => ({ enabled: true, release: null }), getAppUpdateState: async () => ({ ...idle, status: 'downloaded', version: '9.0' }),
      installAppUpdate: async () => ({ success: true, state: { ...idle, status: 'installing', version: '9.0' } }), openAppUpdate: async () => { opened++; return { success: true }; } });
    await ui.flush(); ui.emit('hongguo-check-app-update'); await ui.flush(); await ui.button('重启并安装').props.onClick(); await ui.flush();
    ui.emit('onAppUpdateState', { ...idle, status: 'error', version: '9.0', error: '系统安装器启动失败' }); await ui.flush();
    assert.ok(ui.text().includes('系统安装器启动失败')); assert.ok(ui.button('前往发布页手动下载')); assert.ok(!ui.text().includes('已是最新版本'));
    await ui.button('前往发布页手动下载').props.onClick(); assert.equal(opened, 1); ui.unmount();
  });
  await test('settings emits one check event and disables it for unsaved opt-out', async () => {
    let checks = 0, events = 0;
    const ui = mount({ checkAppUpdate: async () => { checks++; return { enabled: true, release }; } }, 'Settings'); await ui.flush();
    ui.events.set('hongguo-check-app-update', () => { events++; }); assert.ok(ui.button('检查更新')); ui.button('检查更新').props.onClick(); assert.equal(events, 1); assert.equal(checks, 0);
    ui.find(n => n.props['aria-label'] === '自动检测更新').props.onChange({ target: { checked: false } }); await ui.flush(); assert.equal(ui.button('检查更新').props.disabled, true); ui.unmount();
  });
  console.log(`App update UI: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
