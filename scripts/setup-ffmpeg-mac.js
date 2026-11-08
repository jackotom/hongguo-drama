// Build from pinned source archives. See build/ffmpeg/MACOS-NOTICE.txt.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..', 'build', 'ffmpeg');
const source = 'ffmpeg-9.0.2+x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55';
const names = ['ffmpeg', 'ffprobe'];
const helperSource = 'librempeg-cb1f8f3eef84999e61b27e2d44664858179bc240+x264-b35605a';
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  assert(process.platform === 'darwin', '需要 macOS');
  const architectures = process.argv.length > 2 ? process.argv.slice(2) : [process.arch];
  assert(architectures.every(arch => ['arm64', 'x64'].includes(arch)), '仅支持 arm64 或 x64');
  for (const arch of new Set(architectures)) {
    assert(arch !== 'arm64' || process.arch === 'arm64', 'arm64 工具需要在 Apple Silicon macOS 构建');
    const dest = path.join(root, `darwin-${arch}`);
    const script = path.resolve(__dirname, arch === 'x64' ? 'build-ffmpeg-source-mac-x64.sh' : 'build-ffmpeg-source-mac.sh');
    const manifestPath = path.join(dest, 'build-manifest.json');
    const scriptHash = sha256(script);
    let saved;
    try { saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    const valid = saved?.source === source && saved?.script_sha256 === scriptHash && names.every(name => fs.existsSync(path.join(dest, name)) && sha256(path.join(dest, name)) === saved.binaries?.[name]);
    if (!valid) {
      const buildRoot = path.join(root, `.source-build-${arch}`);
      console.log('首次从固定源码构建 FFmpeg / x264，通常需要数分钟。');
      execFileSync('/bin/bash', [script, buildRoot], { stdio: 'inherit' });
      fs.mkdirSync(dest, { recursive: true });
      for (const name of names) fs.copyFileSync(path.join(buildRoot, 'artifacts', 'bin', name), path.join(dest, name));
      fs.writeFileSync(manifestPath, JSON.stringify({ source, script_sha256: scriptHash, binaries: Object.fromEntries(names.map(name => [name, sha256(path.join(dest, name))])) }, null, 2) + '\n');
    }
    for (const name of names) {
      const binary = path.join(dest, name);
      fs.chmodSync(binary, 0o755);
      execFileSync('/usr/bin/lipo', [binary, '-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64']);
      const dependencies = execFileSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8' }).trim().split('\n').slice(1);
      assert(dependencies.length && dependencies.every(line => /^\s+\/(usr\/lib|System\/Library)\//.test(line)), '工具含非系统动态库');
      console.log(name + ': 源码构建校验、' + arch + ' 与系统库依赖通过');
    }
    const helperScript = path.resolve(__dirname, 'build-librempeg-source.sh');
    const helperPatch = path.resolve(__dirname, 'librempeg-videotoolbox-prototype.patch');
    const helper = path.join(dest, 'librempeg');
    const helperManifest = path.join(dest, 'librempeg-manifest.json');
    let helperSaved;
    try { helperSaved = JSON.parse(fs.readFileSync(helperManifest, 'utf8')); } catch {}
    if (helperSaved?.source !== helperSource || helperSaved?.script_sha256 !== sha256(helperScript)
        || helperSaved?.patch_sha256 !== sha256(helperPatch)
        || !fs.existsSync(helper) || sha256(helper) !== helperSaved?.sha256) {
      const helperRoot = path.join(root, `.librempeg-build-${arch}`);
      console.log('从固定源码构建 ByteVC2 解码组件，通常需要数分钟。');
      execFileSync('/bin/bash', [helperScript, helperRoot, arch], { stdio: 'inherit' });
      fs.copyFileSync(path.join(helperRoot, 'artifacts/bin/librempeg'), helper);
      for (const name of fs.readdirSync(path.join(helperRoot, 'artifacts/bin')).filter(name => name.startsWith('LIBREMPEG-'))) {
        fs.copyFileSync(path.join(helperRoot, 'artifacts/bin', name), path.join(root, name));
      }
      fs.writeFileSync(helperManifest, JSON.stringify({ source: helperSource, script_sha256: sha256(helperScript), patch_sha256: sha256(helperPatch), sha256: sha256(helper) }, null, 2) + '\n');
    }
    fs.chmodSync(helper, 0o755);
    execFileSync('/usr/bin/lipo', [helper, '-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64']);
    const helperDependencies = execFileSync('/usr/bin/otool', ['-L', helper], { encoding: 'utf8' }).trim().split('\n').slice(1);
    assert(helperDependencies.length && helperDependencies.every(line => /^\s+\/(usr\/lib|System\/Library)\//.test(line)), 'ByteVC2组件含非系统动态库');
    const decoders = execFileSync(helper, ['-hide_banner', '-decoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert(/^\s*V\S*\s+bvc2\s/m.test(decoders), 'ByteVC2组件未包含所需解码器');
    if (arch === 'arm64') {
      const encoders = execFileSync(helper, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      assert(/^\s*V\S*\s+h264_videotoolbox\s/m.test(encoders), 'ByteVC2组件未包含硬件编码器');
    }
  }
} catch (error) { console.error('Mac FFmpeg 准备失败：' + error.message); process.exitCode = 1; }
