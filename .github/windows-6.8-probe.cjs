// External 6.8 probe: execute frozen checks; never modify subject source or package bytes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const Module = require('node:module');
const SUBJECT_SHA = '647e40d874d54bbaada6243c60e97e848100adf4';
const HASHES = {
  portable: '8f71b6e31e90fe504f762bf62780ac7aa17da72a114ad678159f2baf970a7c55',
  installer: '6a24928dd61c83c385cb93fadc7644f9322aeb9e1d5f6baf55216ef000cac645',
};
const root = path.resolve(process.argv[2] || '.');
const mode = process.argv[3];
assert(['portable', 'installer', '--self-test'].includes(mode), 'Usage: node helper.cjs subjectRoot portable|installer|--self-test');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const names = { portable: 'check-windows-release.cjs', installer: 'check-windows-installer.cjs' };
function original(kind) {
  const filename = path.join(root, 'scripts', names[kind]);
  const bytes = fs.readFileSync(filename);
  const canonical = cp.execFileSync('git', ['-C', root, 'show', `${SUBJECT_SHA}:scripts/${names[kind]}`]);
  assert.equal(sha256(canonical), HASHES[kind], `Frozen ${kind} checker bytes differ`);
  const crlf = Buffer.from(canonical.toString('utf8').replaceAll('\n', '\r\n'));
  assert(bytes.equals(canonical) || bytes.equals(crlf), 'Checkout must match Git bytes or whole-file CRLF');
  return { filename, source: canonical.toString('utf8'), checkoutSha256: sha256(bytes), canonicalSha256: sha256(canonical) };
}
function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, 'Unexpected frozen checker shape');
  return source.replace(from, to);
}
function transform(kind, source) {
  source = replaceOnce(source, 'sourceCommit: process.env.GITHUB_SHA', 'sourceCommit: process.env.HONGGUO_SUBJECT_SHA');
  if (kind === 'installer') {
    const start = source.indexOf('  async function quitAppNormally() {');
    const end = source.indexOf('\n  function install(', start);
    assert(start >= 0 && end > start, 'Frozen quit function not found');
    const replacement = `  async function quitAppNormally() {
    const appProcess = child;
    assert(appProcess && appProcess.exitCode === null && appProcess.signalCode === null, 'Application must still be running before normal quit');
    await module.__quitProbe.close(appProcess, socket, () => ++sequence, exe);
    socket?.close(); socket = null;
    child = null;
  }
`;
    source = source.slice(0, start) + replacement + source.slice(end);
    const versionCheck = "    assert.equal(actualVersion, expectedVersion, 'Running installed application must report the expected version');";
    source = replaceOnce(source, versionCheck, versionCheck + '\n    module.__quitProbe.target(child, target, actualVersion);');
  }
  return source;
}
const successfulExit = child => child.exitCode === 0 && child.signalCode === null;
if (mode === '--self-test') {
  for (const kind of ['portable', 'installer']) {
    const { source } = original(kind), changed = transform(kind, source);
    new (require('node:vm').Script)(Module.wrap(changed));
    // All non-quit source must remain byte-for-byte equivalent after removing the shim.
    let expected = source.replace('sourceCommit: process.env.GITHUB_SHA', 'sourceCommit: process.env.HONGGUO_SUBJECT_SHA');
    let actual = changed;
    if (kind === 'installer') {
      const cut = text => text.slice(0, text.indexOf('  async function quitAppNormally() {')) + text.slice(text.indexOf('\n  function install(', text.indexOf('  async function quitAppNormally() {')));
      expected = cut(expected);
      actual = cut(actual).replace('\n    module.__quitProbe.target(child, target, actualVersion);', '');
    }
    assert.equal(actual, expected, 'An unrelated assertion or execution path changed');
    assert(changed.includes('process.env.HONGGUO_SUBJECT_SHA'));
  }
  assert(successfulExit({ exitCode: 0, signalCode: null }));
  for (const state of [{ exitCode: null, signalCode: null }, { exitCode: 1, signalCode: null }, { exitCode: 0, signalCode: 'SIGTERM' }]) assert(!successfulExit(state));
  console.log('PASS frozen-checker fingerprints, syntax, unchanged non-quit assertions, explicit subject SHA and strict normal-exit states');
} else {
  assert.equal(process.platform, 'win32', 'Run only on the isolated Windows runner');
  assert.equal(process.arch, 'x64');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.HONGGUO_SUBJECT_SHA, SUBJECT_SHA, 'Explicit tested-source SHA required');
  process.chdir(root);
  const harnessSha = process.env.HONGGUO_HARNESS_SHA || process.env.HARNESS_SHA;
  assert(/^[a-f0-9]{40}$/.test(harnessSha || ''), 'Separate harness SHA required');
  assert(!process.argv.includes('--skip-playback') && !process.argv.includes('--config'), 'Acceptance cannot be skipped');
  assert.notEqual(process.env.HONGGUO_SKIP_PLAYBACK, 'true');
  assert.equal(cp.execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), SUBJECT_SHA);
  assert.equal(cp.execFileSync('git', ['-C', root, 'diff', '--name-only', 'HEAD', '--'], { encoding: 'utf8' }).trim(), '', 'Subject tracked files must match freeze');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, '6.8.0');
  const out = path.join(root, 'dist', 'windows-verification');
  fs.mkdirSync(out, { recursive: true });
  const checker = original(mode);
  const report = { subjectSha: SUBJECT_SHA, harnessSha, helperSha256: sha256(fs.readFileSync(__filename)), mode,
    checkerCheckoutSha256: checker.checkoutSha256, checkerCanonicalSha256: checker.canonicalSha256,
    payloadUnchanged: null, events: [] };
  const reportFile = path.join(out, `probe-${mode}.json`);
  const redact = value => String(value).replace(/https?:\/\/\S+/g, '[URL omitted]').replace(/[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email omitted]').replace(/(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\s"']+/g, '[machine path omitted]').slice(0, 700);
  function event(action, data = {}) {
    const entry = { at: new Date().toISOString(), action, ...data };
    report.events.push(entry);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log('WINDOWS_PROBE ' + JSON.stringify(entry));
  }
  function digestFile(file) {
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, 'r');
    try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
    finally { fs.closeSync(fd); }
    return hash.digest('hex');
  }
  function payload() {
    const files = [];
    const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(file);
    } };
    walk(path.join(root, 'dist', 'win-unpacked'));
    for (const name of fs.readdirSync(path.join(root, 'dist'))) if (/\.exe$/i.test(name)) files.push(path.join(root, 'dist', name));
    assert(files.some(file => file.endsWith('app.asar')), 'Cached ASAR is required');
    assert(files.some(file => file.endsWith('6.8-win-x64-setup.exe')), 'Cached installer is required');
    const entries = files.sort().map(file => [path.relative(root, file).replaceAll('\\', '/'), digestFile(file)]);
    return { files: entries.length, sha256: sha256(JSON.stringify(entries)), entries };
  }
  const before = payload();
  report.originalPayload = before;
  process.once('beforeExit', () => {
    try {
      assert.deepEqual(payload(), before, 'Original EXE/ASAR/unpacked payload bytes changed');
      report.payloadUnchanged = true;
    } catch (error) { report.payloadUnchanged = false; process.exitCode = 1; event('payload-integrity-failed', { error: redact(error.message) }); }
    event('finished', { exitCode: process.exitCode || 0, payloadUnchanged: report.payloadUnchanged });
  });
  function powershell(script, env, timeout) {
    return new Promise((resolve, reject) => cp.execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, ...env }, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(new Error(`PowerShell probe failed: ${error.code || 'unknown'} (private output suppressed)`));
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); } catch { reject(new Error('Invalid PowerShell probe result')); }
    }));
  }
  function exitWithin(child, milliseconds) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(successfulExit(child) ? 'exit0' : 'abnormal');
    return new Promise(resolve => {
      const finish = value => { clearTimeout(timer); child.removeListener('exit', exited); resolve(value); };
      const exited = () => finish(successfulExit(child) ? 'exit0' : 'abnormal');
      const timer = setTimeout(() => finish('timeout'), milliseconds);
      child.once('exit', exited);
    });
  }
  let target, quitCount = 0;
  async function screenshot(label) {
    const name = `quit-${quitCount}-${label}.png`;
    try {
      await powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $r=[Windows.Forms.SystemInformation]::VirtualScreen; $b=New-Object Drawing.Bitmap $r.Width,$r.Height; $g=[Drawing.Graphics]::FromImage($b); try {$g.CopyFromScreen($r.Left,$r.Top,0,0,$r.Size);$b.Save($env:HONGGUO_PROBE_SHOT,[Drawing.Imaging.ImageFormat]::Png)} finally {$g.Dispose();$b.Dispose()}; @{saved=$true}|ConvertTo-Json -Compress`, { HONGGUO_PROBE_SHOT: path.join(out, name) }, 8000);
      event('desktop-screenshot', { file: name });
    } catch (error) { event('screenshot-failed', { error: redact(error.message) }); }
  }
  const probe = {
    target(child, page, version) {
      target = { pid: child.pid, targetId: page.id, type: page.type, page: 'dist-react/index.html', version };
      event('installed-target', target);
    },
    async close(child, socket, nextId, expectedExe) {
      quitCount++;
      event('quit-start', { quit: quitCount, ...target, spawnPid: child.pid });
      assert.equal(target?.pid, child.pid, 'Target must belong to the current spawned app');
      const closeId = nextId();
      const observe = messageEvent => {
        let message; try { message = JSON.parse(messageEvent.data); } catch { return; }
        if (message.id === closeId) event('cdp-close-result', {
          quit: quitCount, id: closeId, protocolError: message.error ? redact(message.error.message) : null,
          exception: message.result?.exceptionDetails ? redact(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text) : null,
          resultType: message.result?.result?.type || null,
        });
        if (['Inspector.detached', 'Runtime.executionContextDestroyed', 'Page.frameDetached'].includes(message.method)) event('cdp-target-event', { quit: quitCount, method: message.method });
      };
      const closed = message => event('cdp-socket-closed', { quit: quitCount, code: message.code, reason: redact(message.reason || '') });
      socket.addEventListener('message', observe);
      socket.addEventListener('close', closed);
      try {
        const exited = exitWithin(child, 15000);
        try {
          socket.send(JSON.stringify({ id: nextId(), method: 'Runtime.enable' }));
          socket.send(JSON.stringify({ id: nextId(), method: 'Page.enable' }));
          socket.send(JSON.stringify({ id: closeId, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }));
        } catch (error) { event('cdp-send-error', { quit: quitCount, error: redact(error.message) }); }
        const state = await exited;
        event('cdp-exit-observation', { quit: quitCount, state, exitCode: child.exitCode, signal: child.signalCode });
        if (state === 'exit0') return;
        await screenshot('after-cdp');
        assert.equal(state, 'timeout', 'CDP close exited abnormally');
        const native = await powershell(`$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById([int]$env:HONGGUO_PROBE_PID);$p.Refresh();if(-not [string]::Equals($p.Path,$env:HONGGUO_PROBE_EXE,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected process path'};$hasWindow=$p.MainWindowHandle -ne [IntPtr]::Zero;$sent=$false;$exited=$false;$code=$null;if($hasWindow){$sent=$p.CloseMainWindow();if($sent){$exited=$p.WaitForExit(15000);if($exited){$code=$p.ExitCode}}};@{pid=$p.Id;hasWindow=$hasWindow;sent=$sent;exited=$exited;exitCode=$code}|ConvertTo-Json -Compress`, { HONGGUO_PROBE_PID: String(child.pid), HONGGUO_PROBE_EXE: expectedExe }, 22000);
        event('native-close-result', { quit: quitCount, ...native });
        if (native.sent && native.exited && native.exitCode === 0) {
          assert.equal(await exitWithin(child, 1000), 'exit0', 'Spawn PID did not acknowledge normal exit');
          event('normal-native-exit0', { quit: quitCount });
          return;
        }
        await screenshot('native-close-failed');
        throw new Error('Installed application failed native normal close / 15-second exit0; diagnostic screenshots retained');
      } catch (error) {
        event('quit-failed', { quit: quitCount, error: redact(error.message) });
        await screenshot('failure');
        throw error;
      } finally { socket.removeEventListener('message', observe); socket.removeEventListener('close', closed); }
    },
  };
  event('started', { subjectSha: SUBJECT_SHA, harnessSha: report.harnessSha, mode, payloadFiles: before.files });
  const { filename, source } = original(mode);
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.paths = Module._nodeModulePaths(path.dirname(filename));
  subject.__quitProbe = probe;
  // Compile in the original module context so all original require paths/assertions remain intact.
  subject._compile(transform(mode, source), filename);
}
