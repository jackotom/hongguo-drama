const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const harnessSource = fs.readFileSync(path.join(__dirname, 'check-app-update-ui.cjs'), 'utf8').split('\n(async () => {')[0];
const harnessModule = { exports: {} };
vm.runInNewContext(`${harnessSource}\nmodule.exports = { mount };`, { module: harnessModule, require, __dirname, console });
const mount = harnessModule.exports.mount;
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(text).join('') || '';

(async () => {
  const settingsSource = fs.readFileSync(path.join(__dirname, '../src/components/Settings.jsx'), 'utf8');
  const accountSource = fs.readFileSync(path.join(__dirname, '../src/components/AccountManagement.jsx'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8');
  const shortcutIndex = settingsSource.indexOf('<ShortcutSettings');
  const pictureModeIndex = settingsSource.indexOf('aria-label="画中画小窗设置"');
  const builtinIndex = settingsSource.indexOf('<BuiltinSources');
  assert.ok(shortcutIndex >= 0 && shortcutIndex < pictureModeIndex && pictureModeIndex < builtinIndex, 'picture-in-picture setting must sit between shortcuts and built-in sources');
  assert.match(appSource, /label: '红果账号'/);
  assert.match(appSource, /id: 'manager'[^\n]+\n\s*\{ id: 'account', label: '红果账号'/, 'account follows download management');
  const sidebarMenu = appSource.split('<nav className="sidebar-menu">')[1].split('</nav>')[0];
  assert.match(sidebarMenu, /MENU\.filter\(\(item\) => item\.id !== 'settings'\)\.map/, 'main navigation includes the account entry');
  const sidebarFooter = appSource.split('<div className="sidebar-footer">')[1].split('</aside>')[0];
  assert.doesNotMatch(sidebarFooter, /account|红果账号/, 'footer must not duplicate the account entry');
  assert.match(sidebarFooter, /navigate\('settings'\)/, 'settings stays in the footer');
  assert.doesNotMatch(appSource, /登录管理/);
  assert.doesNotMatch(accountSource, /登录管理/);

  let persisted = { root: '/fixture' };
  const saves = [];
  let failure = '';
  let reject = false;
  const settingsUi = mount({
    getSettings: async () => ({ ...persisted }),
    saveSettings: async patch => {
      saves.push(structuredClone(patch));
      if (reject) throw new Error('画中画设置写入失败');
      if (failure) return { success: false, error: failure };
      Object.assign(persisted, patch);
      return { success: true };
    },
  }, 'Settings');
  const modeSelect = () => settingsUi.find(node => node.props.id === 'picture-in-picture-mode');
  try {
    await settingsUi.flush();
    assert.equal(modeSelect().props.value, 'custom', 'missing setting defaults to the app floating window');
    assert.match(settingsUi.text(), /已打开的小窗不会被中断或切换/);
    assert.match(settingsUi.text(), /下次开启时生效/);

    failure = '画中画设置保存失败';
    await modeSelect().props.onChange({ target: { value: 'native' } });
    await settingsUi.flush();
    assert.equal(modeSelect().props.value, 'custom', 'failed save restores the persisted mode');
    assert.ok(settingsUi.find(node => node.props.role === 'alert' && text(node).includes(failure)));

    failure = '';
    reject = true;
    await modeSelect().props.onChange({ target: { value: 'native' } });
    await settingsUi.flush();
    assert.equal(modeSelect().props.value, 'custom', 'rejected save also restores the persisted mode');
    assert.ok(settingsUi.find(node => node.props.role === 'alert' && text(node).includes('画中画设置写入失败')));

    reject = false;
    await modeSelect().props.onChange({ target: { value: 'native' } });
    await settingsUi.flush();
    assert.equal(persisted.picture_in_picture_mode, 'native');
    assert.equal(modeSelect().props.value, 'native');
    assert.ok(settingsUi.find(node => node.props.role === 'status' && text(node).includes('已自动保存，下次开启悬浮窗时生效')));
    assert.equal(saves.length, 3);
    for (const patch of saves) assert.deepEqual(patch, { picture_in_picture_mode: 'native' }, 'mode changes submit only the floating-window field');
  } finally {
    settingsUi.unmount();
  }

  for (const lateRefresh of [false, true]) {
    let persistedMode = 'custom', finishSave, finishRefresh, delayRefresh = false;
    const props = { active: true };
    const ui = mount({
      getSettings: () => {
        const snapshot = { picture_in_picture_mode: persistedMode };
        return delayRefresh ? new Promise(resolve => { finishRefresh = () => resolve(snapshot); }) : Promise.resolve(snapshot);
      },
      saveSettings: patch => new Promise(resolve => {
        finishSave = () => { persistedMode = patch.picture_in_picture_mode; resolve({ success: true }); };
      }),
    }, 'Settings', props);
    const select = () => ui.find(node => node.props.id === 'picture-in-picture-mode');
    try {
      await ui.flush();
      if (lateRefresh) {
        delayRefresh = true;
        props.active = false; ui.render(); props.active = true; ui.render();
      }
      const saving = select().props.onChange({ target: { value: 'native' } });
      await ui.flush();
      if (!lateRefresh) {
        props.active = false; ui.render(); props.active = true; ui.render();
        await ui.flush();
        assert.equal(select().props.value, 'native', 'returning during save must retain the selected mode');
      }
      finishSave(); await saving; await ui.flush();
      if (lateRefresh) { finishRefresh(); await ui.flush(); }
      assert.equal(persistedMode, 'native');
      assert.equal(select().props.value, persistedMode, 'an old refresh must not replace the saved mode');
    } finally { ui.unmount(); }
  }

  const accountUi = mount({
    getAccountStatus: async () => ({ success: true, signedIn: false }),
  }, 'AccountManagement');
  try {
    await accountUi.flush();
    assert.ok(accountUi.find(node => node.type === 'h2' && text(node) === '红果账号'), 'account page heading uses the product name');
    assert.ok(!accountUi.text().includes('登录管理'));
  } finally {
    accountUi.unmount();
  }

  console.log('PASS settings picture-in-picture mode; 红果账号 follows 下载管理, 设置 stays in footer, account page opens');
})().catch(error => { console.error(error); process.exitCode = 1; });
