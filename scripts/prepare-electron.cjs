// Fetch the pinned official runtime through GitHub's asset API when the download redirect times out.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').devDependencies.electron;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert(['linux', 'win32', 'darwin'].includes(process.platform));
  assert(['x64', 'arm64'].includes(process.arch));
  const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const release = JSON.parse(execFileSync('gh', ['api', `repos/electron/electron/releases/tags/v${version}`], { encoding: 'utf8' }));
  const asset = release.assets.find(item => item.name === name);
  assert(asset && Number.isSafeInteger(asset.id) && asset.size > 1000000);
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  const cache = path.join(root, '.cache/electron');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, name);
  const valid = () => fs.existsSync(archive) && fs.statSync(archive).size === asset.size
    && 'sha256:' + createHash('sha256').update(fs.readFileSync(archive)).digest('hex') === asset.digest;
  if (!valid()) {
    const temporary = archive + '.tmp', fd = fs.openSync(temporary, 'w', 0o600);
    try {
      execFileSync('gh', ['api', `repos/electron/electron/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'],
        { stdio: ['ignore', fd, 'pipe'] });
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, archive);
  }
  assert(valid(), 'Official Electron asset size or SHA256 mismatch');
  const dist = path.join(root, 'node_modules/electron/dist');
  fs.mkdirSync(dist, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:HONGGUO_ELECTRON_ZIP -DestinationPath $env:HONGGUO_ELECTRON_DIST -Force'],
    { env: { ...process.env, HONGGUO_ELECTRON_ZIP: archive, HONGGUO_ELECTRON_DIST: dist }, stdio: 'pipe' });
  } else if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', archive, dist], { stdio: 'pipe' });
  else execFileSync('unzip', ['-q', '-o', archive, '-d', dist], { stdio: 'pipe' });
  const executable = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron';
  assert(fs.statSync(path.join(dist, executable)).isFile());
  fs.writeFileSync(path.join(root, 'node_modules/electron/path.txt'), executable);
  console.log(`PASS pinned official Electron ${version} ${process.platform}/${process.arch}: exact asset size and SHA256`);
})().catch(error => {
  const detail = String(error?.stderr || error?.message || error || '')
    .replace(/https?:\/\/[^\s"']+/g, '[URL]').replace(/\s+/g, ' ').trim().slice(0, 400);
  console.error(`Verified official Electron runtime preparation failed${detail ? `: ${detail}` : ''}`);
  process.exitCode = 1;
});
