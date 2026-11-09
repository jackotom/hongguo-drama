// 6.5: run only on an isolated Linux x64 release runner; never use an existing NAS volume.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist/docker');
const name = `hongguo-65-acceptance-${process.pid}`;
const token = crypto.randomBytes(32).toString('hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-65-'));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
let base;
async function request(route, options = {}, authenticated = true) {
  return fetch(base + route, { ...options, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }, signal: AbortSignal.timeout(15000) });
}
async function ready() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await request('/health', {}, false)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Container readiness timed out');
}
async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  fs.mkdirSync(output, { recursive: true });
  for (const dir of ['data', 'downloads']) {
    fs.mkdirSync(path.join(temp, dir));
    fs.chownSync(path.join(temp, dir), process.getuid(), process.getgid());
  }
  docker('run', '-d', '--name', name, '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '-p', '127.0.0.1::3000', '-e', `HONGGUO_TOKEN=${token}`, '-v', `${temp}/data:/data`, '-v', `${temp}/downloads:/downloads`, 'hongguo-drama:6.5');
  base = `http://${docker('port', name, '3000/tcp')}`;
  await ready();
  assert.equal((await request('/api/tasks', {}, false)).status, 401);
  assert.equal((await request('/api/status')).status, 200);
  const page = await request('/', {}, false);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') || '', /default-src/);
  const child = spawn(process.execPath, ['server/live-check.cjs'], {
    cwd: root, env: { ...process.env, HONGGUO_URL: base, HONGGUO_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let liveOutput = '';
  child.stdout.on('data', chunk => { liveOutput += chunk; });
  child.stderr.on('data', chunk => { liveOutput += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 12 * 60 * 1000);
  const code = await new Promise(resolve => child.once('exit', resolve));
  clearTimeout(timer);
  // Live verifier emits only source IDs, result metadata and safe errors, never credentials or signed URLs.
  fs.writeFileSync(path.join(output, 'live-check.log'), liveOutput.replaceAll(token, '[redacted]'));
  assert.equal(code, 0, 'Real search/download/merge failed; see safe live-check receipt');
  const before = await (await request('/api/tasks')).json();
  docker('restart', name);
  // Docker can assign a different ephemeral host port when restarting the container.
  base = `http://${docker('port', name, '3000/tcp')}`;
  await ready();
  const after = await (await request('/api/tasks')).json();
  assert.deepEqual(after, before, 'Completed task state must survive a container restart');
  const info = JSON.parse(docker('image', 'inspect', 'hongguo-drama:6.5'))[0];
  const result = { passed: true, version: require('../package.json').version, sourceCommit: process.env.GITHUB_SHA,
    execution: 'Linux x64 Docker', authentication: true, realSearchDownloadMerge: true, restartPersistence: true,
    imageId: info.Id, imageArchitecture: info.Architecture, imageRevision: info.Config.Labels['org.opencontainers.image.revision'] };
  assert.equal(result.imageRevision, process.env.GITHUB_SHA);
  fs.writeFileSync(path.join(output, 'docker-verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('PASS Docker authentication, real search/download/merge and restart persistence');
}
main().catch(error => {
  console.error(error.message.replaceAll(token, '[redacted]'));
  fs.mkdirSync(output, { recursive: true });
  let diagnostic = '';
  try { diagnostic += docker('inspect', '--format', '{{json .State}}', name) + '\n'; } catch {}
  const logs = spawnSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8', timeout: 15000 });
  diagnostic += String(logs.stdout || '') + String(logs.stderr || '');
  diagnostic = diagnostic.replaceAll(token, '[redacted]').replace(/https?:\/\/[^\s"']+/g, '[URL]');
  fs.writeFileSync(path.join(output, 'container-failure.log'), diagnostic);
  console.error(diagnostic);
  process.exitCode = 1;
})
  .finally(() => { try { docker('rm', '-f', name); } catch {} fs.rmSync(temp, { recursive: true, force: true }); });
