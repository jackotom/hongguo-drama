// Offline FFmpeg discovery regression. Temporary files only; no app launch or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = path.resolve(__dirname, '../main.js');
const main = fs.readFileSync(source, 'utf8');
const discovery = main.slice(main.indexOf('function resolveFfmpeg('), main.indexOf('function probeDuration('));
const decryption = main.slice(main.indexOf('async function decryptContentKeyFile('), main.indexOf('/** Encrypted sources and compatibility'));
assert(discovery.startsWith('function resolveFfmpeg(') && decryption.startsWith('async function decryptContentKeyFile('));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-ffmpeg-'));

function load(platform = 'win32', packaged = false) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const context = vm.createContext({
    fs, path: { ...path, delimiter: platform === 'win32' ? ';' : ':' }, __dirname: dir,
    app: { isPackaged: packaged },
    process: { platform, arch: 'x64', resourcesPath: path.join(dir, 'resources'), env: { PATH: '' } },
  });
  vm.runInContext(discovery + '\n' + decryption, context, { filename: source });
  const tool = relative => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture', { mode: 0o755 });
    return file;
  };
  return { dir, context, tool };
}

(async () => {
  const failures = [];
  async function check(name, fn) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message); }
  }
  await check('Windows falls back to quoted PATH directories when bundled tools are absent', () => {
    const h = load(), ff = h.tool('tools with spaces/ffmpeg.exe'), fp = h.tool('tools with spaces/ffprobe.exe');
    h.context.process.env.PATH = `missing;"${path.dirname(ff)}";other`;
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), ff);
    assert.equal(h.context.resolveFfmpeg('ffprobe'), fp);
  });
  await check('Windows keeps bundled tools first and unquoted PATH fallback working', () => {
    const h = load(), bundled = h.tool('resources/bin/ffmpeg.exe'), system = h.tool('system/ffmpeg.exe');
    h.context.process.env.PATH = path.dirname(system);
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), bundled);
    fs.unlinkSync(bundled);
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), system);
  });
  await check('Windows retains WinGet fallback with no PATH entry', () => {
    const h = load(), ff = h.tool('Microsoft/WinGet/Packages/Gyan.FFmpeg/build/bin/ffmpeg.exe');
    h.context.process.env.LOCALAPPDATA = h.dir;
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), ff);
  });
  await check('Packaged builds ignore PATH and WinGet', () => {
    const h = load('win32', true), system = h.tool('system/ffmpeg.exe'), winget = h.tool('Microsoft/WinGet/Packages/Gyan.FFmpeg/build/bin/ffmpeg.exe');
    h.context.process.env.PATH = path.dirname(system);
    h.context.process.env.LOCALAPPDATA = h.dir;
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), null);
    const bundled = h.tool('resources/bin/ffmpeg.exe');
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), bundled);
    assert.notEqual(bundled, system);
    assert.notEqual(bundled, winget);
  });
  await check('Missing tools explain recovery before native decryption starts', async () => {
    const h = load();
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), null);
    await assert.rejects(h.context.decryptContentKeyFile('unused', 'unused', '01'.repeat(16)), /FFmpeg.*重新下载.*重启/);
  });
  await check('macOS bundled executable discovery remains unchanged', () => {
    const h = load('darwin'), ff = h.tool('resources/bin/ffmpeg');
    assert.equal(h.context.resolveFfmpeg('ffmpeg'), ff);
  });
  assert.equal(failures.length, 0, failures.join('; '));
})().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
