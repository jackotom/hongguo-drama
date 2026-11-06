// Launch the actual AppImage in a disposable directory (run under xvfb-run in CI).
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { connect, sleep } = require('./fixtures/cdp.cjs');
const pkg = require('../package.json');
(async () => {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const dist = path.resolve(__dirname, '../dist');
  const images = fs.readdirSync(dist).filter(name => name.endsWith('.AppImage'));
  assert.equal(images.length, 1, 'Keep one AppImage candidate in dist');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-linux-'));
  const output = path.join(dist, 'linux-verification'); fs.mkdirSync(output, { recursive: true });
  const result = { version: pkg.version, passed: false, checks: [] };
  let child, cdp;
  try {
    const image = path.join(dist, images[0]);
    assert.equal(fs.readFileSync(image).readUInt16LE(18), 62, 'AppImage runtime must also be x86_64');
    const emulated = process.argv.includes('--emulated-appimage');
    // shortcut: ARM Docker binfmt does not recognize AppImage's AI2 ELF padding; explicitly run the unchanged image in QEMU.
    execFileSync(emulated ? '/usr/bin/qemu-x86_64-static' : image,
      emulated ? [image, '--appimage-extract'] : ['--appimage-extract'], { cwd: temp, stdio: 'pipe', timeout: 60000 });
    result.execution = emulated ? 'Linux x64 under QEMU on ARM host' : 'Linux x64';
    const folder = path.join(temp, 'squashfs-root');
    const launcher = fs.readFileSync(path.join(folder, 'AppRun'), 'utf8');
    assert.match(launcher, /exec "\$APPDIR\/hongguo-drama" "\$@"/);
    assert.doesNotMatch(launcher, /NO_SANDBOX|NO_SANDBOX=\(/);
    const desktop = fs.readdirSync(folder).find(name => name.endsWith('.desktop'));
    assert.doesNotMatch(fs.readFileSync(path.join(folder, desktop), 'utf8'), /^Exec=.*--no-sandbox/m);
    for (const tool of ['ffmpeg', 'ffprobe', 'librempeg']) execFileSync(path.join(folder, 'resources/bin', tool), ['-version'], { stdio: 'pipe', timeout: 15000 });
    result.checks.push('Actual AppImage extraction and all three bundled media executables');
    const net = require('node:net'), server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const log = fs.openSync(path.join(output, 'launch.log'), 'w');
    child = spawn(path.join(folder, 'AppRun'), ['--mute-audio', '--user-data-dir=' + path.join(temp, 'profile'),
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
      ...(emulated ? ['--disable-gpu', '--in-process-gpu', '--no-zygote', '--single-process'] : []),
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])], { cwd: folder, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    cdp = await connect(port);
    assert.equal((await cdp.evaluate('window.electronAPI.getAppInfo()')).version, pkg.version);
    assert.equal(await cdp.evaluate('document.title'), '红果短剧');
    const assets = await cdp.evaluate(`(async()=>{
      const module=await import(new URL('software/avplayer/avplayer.js',document.baseURI).href);
      const bytes=await (await fetch(new URL('software/decode/hevc-simd.wasm',document.baseURI))).arrayBuffer();
      return {player:typeof module.default,wasm:WebAssembly.validate(bytes)};
    })()`);
    assert.equal(assets.player, 'function'); assert.equal(assets.wasm, true);
    result.checks.push('AppImage launches its UI and reports 6.1; packaged CPU player and HEVC Wasm load');
    result.passed = true;
    console.log('PASS actual Linux AppImage: extraction, media tools, launch, version and bundled software decoder');
  } catch (error) { result.error = error.message; throw error; }
  finally {
    cdp?.close(); child?.kill('SIGTERM'); await sleep(250);
    fs.writeFileSync(path.join(output, 'appimage-result.json'), JSON.stringify(result, null, 2) + '\n');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
