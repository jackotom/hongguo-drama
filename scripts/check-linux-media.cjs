const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
assert.equal(pkg.build.linux.target[0].target, 'AppImage');
assert.deepEqual(pkg.build.linux.target[0].arch, ['x64']);
assert(pkg.build.linux.extraResources.some(resource => resource.from === 'build/ffmpeg/linux-${arch}'));
if (!process.argv.includes('--config')) {
  assert.equal(process.platform, 'linux', 'Build Linux AppImage on Linux');
  assert.equal(process.arch, 'x64');
  const folder = path.resolve(__dirname, '../build/ffmpeg/linux-x64');
  for (const name of ['ffmpeg', 'ffprobe', 'librempeg']) {
    const file = path.join(folder, name);
    fs.accessSync(file, fs.constants.X_OK);
    const header = fs.readFileSync(file).subarray(0, 20);
    assert.equal(header.subarray(0, 4).toString(), '\x7fELF');
    assert.equal(header.readUInt16LE(18), 62, `${name} must be Linux x64`);
    execFileSync(file, ['-version'], { stdio: 'pipe', timeout: 15000 });
  }
  const decoders = execFileSync(path.join(folder, 'librempeg'), ['-hide_banner', '-decoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(decoders, /\bbvc2\b/);
}
console.log('PASS Linux AppImage configuration' + (process.argv.includes('--config') ? '' : ' and bundled media tools'));
