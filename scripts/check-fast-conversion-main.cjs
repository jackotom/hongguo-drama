// Offline checks of the real settings and compatibility IPC; no video or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const context = vm.createContext({ normalizeProxySettings: value => value,
  normalizeTextExportKinds: value => value, validateStealthWakeRegion: value => value });
vm.runInContext(main.slice(main.indexOf('const SETTINGS_KEYS ='), main.indexOf("ipcMain.handle('get-settings'")), context);
context.current = { fast_conversion: false, root: '/fixture' };
context.patch = { fast_conversion: true };
assert.equal(vm.runInContext('applyEditableSettings(current, patch).fast_conversion', context), true);
for (const value of ['true', 1, null, {}]) {
  context.patch = { fast_conversion: value };
  assert.throws(() => vm.runInContext('applyEditableSettings(current, patch)', context), /显卡加速/);
}
context.patch = { fast_conversion: false };
context.current.fast_conversion = true;
assert.equal(vm.runInContext('applyEditableSettings(current, patch).fast_conversion', context), false);

const harness = fs.readFileSync(path.join(__dirname, 'check-compat-lifecycle.cjs'), 'utf8').split('\n(async () => {')[0];
const harnessModule = { exports: {} };
vm.runInNewContext(harness + '\nmodule.exports={load,root};', { module: harnessModule, require, __dirname, process,
  console, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout, setImmediate });
const { load, root } = harnessModule.exports;
const hardware = require('../src/native/hardware-encoder');
const originalPick = hardware.pickHardwareEncoder;
const originalArgs = hardware.hardwareEncoderArgs;
const payload = { seriesId: 'xifan:S', vid: 'xifan:v', vidIndex: 1, force: true, requestId: 'fast' };
(async () => {
  try {
    for (const available of [true, false]) {
      const h = load();
      h.context.getCurrentSettings = () => ({ fast_conversion: true });
      hardware.pickHardwareEncoder = async () => available ? { encoder: 'h264_nvenc' } : null;
      hardware.hardwareEncoderArgs = encoder => ['-c:v', encoder, '-cq', '21'];
      const result = await h.handlers['transcode-for-playback']({}, { ...payload, force: false });
      assert.equal(result.success, true);
      assert.equal(result.encoder, available ? 'h264_nvenc' : 'libx264');
      assert(h.events.some(event => event.notice?.includes(available ? '显卡加速转换' : '回退CPU转换')));
      assert.equal(h.children.length, 1);
    }
    const h = load();
    h.context.getCurrentSettings = () => ({ fast_conversion: true });
    let probes = 0;
    hardware.pickHardwareEncoder = async () => { probes++; return { encoder: 'h264_nvenc' }; };
    const result = await h.handlers['transcode-for-playback']({}, payload);
    assert.equal(result.success, true);
    assert.equal(result.encoder, 'libx264', 'explicit compatibility repair retains its safe software path');
    assert.equal(probes, 0);
    console.log('PASS fast conversion main: strict setting, hardware IPC, explicit CPU fallback, forced repair');
  } finally {
    hardware.pickHardwareEncoder = originalPick;
    hardware.hardwareEncoderArgs = originalArgs;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
