#!/usr/bin/env node
// Private acceptance overlay: compile the frozen probe in memory; never change the subject.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const SUBJECT = '647e40d874d54bbaada6243c60e97e848100adf4';
const PROBE_HASH = '5d5c129f746241e819741e234e7f81fbadd4a1aa4758b9e7b31b3e4d909832d2';
const CDP_HASH = '6dc83004140a618754ff248003ab32d30070342aa690efac2a8ae47059552fcb';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = data => createHash('sha256').update(data).digest('hex');
function fileHash(file) {
  const digest = createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null));) digest.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Frozen probe patch anchor missing or duplicated');
  return source.replace(before, () => after);
}
function instrumentProbe(source, subjectSHA) {
  assert.equal(subjectSHA, SUBJECT, 'Explicit subject SHA must be the approved 647 freeze');
  source = replaceOnce(source, "const { connect, sleep } = require('./fixtures/cdp.cjs');", "const { sleep } = require('./fixtures/cdp.cjs');\nconst connect = port => module.__probeRuntime.connect(port);");
  source = replaceOnce(source, 'sourceCommit: process.env.GITHUB_SHA', 'sourceCommit: ' + JSON.stringify(subjectSHA));
  source = replaceOnce(source, '\n(async () => {\n  assert.equal(process.platform', '\nmodule.exports = (async () => {\n  assert.equal(process.platform');
  source = replaceOnce(source, '  let child, cdp;', "  let child, cdp;\n  module.__probeRuntime.scope = { temp, output };\n  module.__probeRuntime.phase('probe:start');");
  source = replaceOnce(source, '    child = spawn(', "    module.__probeRuntime.phase('launch:start');\n    child = module.__probeRuntime.spawn(");
  source = replaceOnce(source, "    cdp?.close(); child?.kill('SIGTERM'); await sleep(250);\n    fs.writeFileSync(path.join(output, 'appimage-result.json'), JSON.stringify(result, null, 2) + '\\n');\n    fs.rmSync(temp, { recursive: true, force: true });", '    await module.__probeRuntime.finish({ result, child, cdp, temp, output });');
  return source;
}
function instrumentCdp(source) {
  source = replaceOnce(source, '  let target;', '  let target;\n  const deadline = Date.now() + 20000;');
  source = replaceOnce(source, '    try { target =', "    if (Date.now() >= deadline) throw Error('CDP connection deadline exceeded');\n    try { target =");
  source = replaceOnce(source, 'fetch(`http://127.0.0.1:${port}/json`)', 'fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))) })');
  source = replaceOnce(source, "  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });", "  await module.__probeRuntime.openSocket(socket);");
  source = replaceOnce(source, '  const pending = new Map(); let sequence = 0;', "  const pending = new Map(); let sequence = 0;\n  const failPending = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('CDP socket closed')); } pending.clear(); };\n  socket.addEventListener('close', failPending); socket.addEventListener('error', failPending);");
  return source;
}
function compile(source, filename, runtime) {
  const compiled = new Module(filename, module);
  compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled.__probeRuntime = runtime; compiled._compile(source, filename);
  return compiled.exports;
}
function processTable() {
  return execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,args='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 })
    .split('\n').flatMap(line => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return m ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], state: m[4], args: m[5] }] : [];
    });
}
function scopedProcesses(child, temp) {
  if (!child?.pid) return [];
  const rows = processTable(), own = new Set([child.pid]);
  // The test child has its own process group; temp paths also catch escaped crash handlers.
  for (const row of rows) if (row.pgid === child.pid || row.args.includes(temp + path.sep)) own.add(row.pid);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (own.has(row.ppid) && !own.has(row.pid)) { own.add(row.pid); changed = true; } }
  const protectedPids = new Set([1, process.pid]);
  let parent = process.ppid;
  while (parent > 1 && !protectedPids.has(parent)) { protectedPids.add(parent); parent = rows.find(row => row.pid === parent)?.ppid || 0; }
  return rows.filter(row => own.has(row.pid) && !protectedPids.has(row.pid));
}
async function stopTree(child, temp, { termMs = 3000, killMs = 3000 } = {}) {
  const record = { forcedCleanup: false, normalQuitPass: false, noResidualProcesses: true, childExitObserved: !child, termPids: [], killPids: [] };
  if (!child?.pid) return record;
  const signal = (rows, name, key) => {
    for (const row of rows) {
      if (row.state.startsWith('Z')) continue;
      try { process.kill(row.pid, name); record[key].push(row.pid); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  let rows = scopedProcesses(child, temp);
  signal(rows, 'SIGTERM', 'termPids');
  let deadline = Date.now() + termMs;
  while (Date.now() < deadline && (rows = scopedProcesses(child, temp)).length) await sleep(100);
  rows = scopedProcesses(child, temp);
  if (rows.length) {
    record.forcedCleanup = true;
    deadline = Date.now() + killMs;
    do {
      signal(rows, 'SIGKILL', 'killPids'); await sleep(100); rows = scopedProcesses(child, temp);
    } while (rows.length && Date.now() < deadline);
  }
  // Allow Node to observe/reap the direct child, including the already-exited case.
  await sleep(25);
  record.residualPids = scopedProcesses(child, temp).map(row => row.pid);
  record.noResidualProcesses = record.residualPids.length === 0;
  record.childExitObserved = child.exitCode !== null || child.signalCode !== null;
  record.childExitCode = child.exitCode; record.childExitSignal = child.signalCode;
  return record;
}
function boundedRemove(temp, timeout = 10000) {
  return new Promise((resolve, reject) => {
    // Keep synchronous recursive removal out of the probe event loop and bound its lifetime.
    execFile(process.execPath, ['-e', "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", temp],
      { timeout, killSignal: 'SIGKILL' }, error => error ? reject(Error('Temporary cleanup failed or timed out')) : resolve());
  });
}
async function main(rootArgument, subjectSHA) {
  assert.equal(process.platform, 'linux', 'Helper execution requires native Linux x64');
  assert.equal(process.arch, 'x64'); assert.equal(subjectSHA, SUBJECT, 'Explicit subject SHA required');
  const root = fs.realpathSync(rootArgument);
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.equal(fs.realpathSync(git(['rev-parse', '--show-toplevel'])), root, 'Subject must be its own checkout');
  assert.equal(git(['rev-parse', 'HEAD']), SUBJECT, 'Subject checkout does not match freeze');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'Subject tracked source must be unchanged');
  const probeFile = path.join(root, 'scripts/check-linux-appimage.cjs'), cdpFile = path.join(root, 'scripts/fixtures/cdp.cjs');
  const original = fs.readFileSync(probeFile, 'utf8'), fixture = fs.readFileSync(cdpFile, 'utf8');
  assert.equal(hash(original), PROBE_HASH, 'Frozen probe bytes changed'); assert.equal(hash(fixture), CDP_HASH, 'Frozen CDP bytes changed');
  const dist = path.join(root, 'dist'), images = fs.readdirSync(dist).filter(name => name.endsWith('.AppImage'));
  assert.equal(images.length, 1, 'Exactly one frozen AppImage required');
  const image = path.join(dist, images[0]), imageHash = fileHash(image), output = path.join(dist, 'linux-verification');
  fs.mkdirSync(output, { recursive: true });
  const receiptFile = path.join(output, 'probe-helper-result.json'), rawFile = path.join(output, 'appimage-result.json');
  assert(!fs.existsSync(rawFile) && !fs.existsSync(receiptFile), 'Preserve previous acceptance receipts; use a fresh runner');
  const receipt = { sourceCommit: subjectSHA, subjectSHA, workflowHeadSha: process.env.GITHUB_SHA || null,
    harnessSourceSha: process.env.HARNESS_SOURCE_SHA || process.env.GITHUB_SHA || null,
    harnessSha256: fileHash(__filename), originalProbeSha256: PROBE_HASH, originalCdpSha256: CDP_HASH,
    subjectAppImage: images[0], subjectAppImageSha256: imageHash, mediaPassed: false, passed: false,
    normalQuitPass: false, phases: [] };
  const save = () => fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  const phase = name => { receipt.phases.push({ phase: name, at: new Date().toISOString() }); save(); console.log('[linux-probe] ' + name); };
  let cleanupGood = false;
  const runtime = {
    phase,
    spawn(command, args, options) {
      assert(runtime.scope && path.resolve(command) === path.join(runtime.scope.temp, 'squashfs-root/AppRun'));
      const child = spawn(command, args, { ...options, detached: true });
      child.on('error', () => phase('launch:error'));
      return child;
    },
    openSocket(socket) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(Error('CDP WebSocket handshake timed out')); }, 5000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('CDP WebSocket connection failed')); }, { once: true });
      });
    },
    async connect(port) {
      phase('cdp-connect:start');
      const client = await compile(instrumentCdp(fixture), cdpFile, runtime).connect(port);
      phase('cdp-connect:done');
      let sequence = 0;
      return { close: () => client.close(), async evaluate(expression, timeout) {
        const label = ++sequence; phase('evaluate-' + label + ':start');
        const value = await client.evaluate(expression, timeout); phase('evaluate-' + label + ':done'); return value;
      } };
    },
    async finish({ result, child, cdp, temp, output }) {
      // Preserve the original media result before touching sockets, processes, or temporary media.
      fs.writeFileSync(rawFile, JSON.stringify(result, null, 2) + '\n');
      receipt.rawResultSha256 = fileHash(rawFile); receipt.mediaPassed = result.passed === true;
      phase('raw-result:saved');
      try { cdp?.close(); } catch { receipt.socketCloseError = true; }
      try {
        phase('process-cleanup:start'); receipt.cleanup = await stopTree(child, temp); phase('process-cleanup:done');
        assert(receipt.cleanup.noResidualProcesses && receipt.cleanup.childExitObserved, 'Isolated test processes did not exit');
        phase('temp-cleanup:start'); await boundedRemove(temp); phase('temp-cleanup:done');
        assert(!fs.existsSync(temp), 'Temporary directory still exists');
        receipt.subjectAppImageSha256After = fileHash(image);
        assert.equal(receipt.subjectAppImageSha256After, imageHash, 'AppImage bytes changed during acceptance');
        cleanupGood = true;
      } catch (error) { receipt.cleanupError = error.message; process.exitCode = 1; phase('cleanup:failed'); }
      receipt.passed = receipt.mediaPassed && cleanupGood;
      phase('probe:finished');
    },
  };
  phase('subject:verified');
  await compile(instrumentProbe(original, subjectSHA), probeFile, runtime);
  assert(receipt.passed && cleanupGood && !process.exitCode, 'Original media assertions or bounded cleanup did not pass');
  // Only the original success result plus verified child cleanup can permit a successful hard exit.
  process.exit(0);
}
module.exports = { instrumentProbe, instrumentCdp, stopTree, boundedRemove };
if (require.main === module) main(...process.argv.slice(2)).catch(error => { console.error('[linux-probe] FAIL: ' + error.message); process.exit(1); });
