// Unit and platform checks, including generated real-media decode/recovery fixtures (requires FFmpeg/libx264 and ffprobe).
// Skips Windows installers, external media fixtures, architecture checks, and Electron GUI launches.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const skip = new Set([
  'check-windows-release.cjs',
  'check-windows-installer.cjs',
  'check-hls-media.cjs',
  'check-download-media-validity.cjs',
  'check-ffmpeg-mac.cjs',
  'check-merge.cjs',
  'check-merge-benchmark.cjs',
  'check-error-boundary.cjs',
  'check-danmaku-live.cjs',
  'check-linux-media.cjs',
  'check-linux-appimage.cjs',
]);

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`FAIL node ${args.join(' ')}`);
    process.exitCode = result.status || 1;
  }
  return result.status === 0;
}

const checks = fs.readdirSync(__dirname)
  .filter((name) => name.startsWith('check-') && name.endsWith('.cjs') && !skip.has(name))
  .sort();

let failed = 0;
const unitTests = [
  ...fs.readdirSync(path.join(root, 'src/components/__tests__')).filter((name) => name.endsWith('.mjs')).map((name) => path.join('src/components/__tests__', name)),
  ...fs.readdirSync(path.join(root, 'src/native')).filter((name) => name.endsWith('.test.cjs')).map((name) => path.join('src/native', name)),
];
if (!run(['--test', ...unitTests])) failed++;
if (!run(['src/components/check-ui-state.cjs'])) failed++;
if (!run(['scripts/check-windows-installer.cjs', '--config'])) failed++;
if (!run(['scripts/check-linux-media.cjs', '--config'])) failed++;
for (const name of checks) {
  if (!run([path.join('scripts', name)])) failed++;
}
if (failed) {
  console.error(`npm test: ${failed} command(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`npm test: unit tests and ${checks.length + 3} platform checks passed`);
}
