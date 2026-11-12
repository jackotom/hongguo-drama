const { spawn } = require('node:child_process');
const path = require('node:path');

const abortError = () => Object.assign(new Error('硬件编码检测已取消'), { code: 'ERR_CANCELED' });
const inputError = () => Object.assign(new Error('硬件编码检测无法读取当前视频，请重新获取片源后重试'), { code: 'HARDWARE_PROBE_INPUT_FAILED' });

function hardwareEncoderArgs(encoder) {
  if (encoder === 'h264_videotoolbox') return ['-c:v', encoder, '-allow_sw', '0', '-realtime', '0', '-q:v', '68', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-threads:v', '2'];
  if (encoder === 'h264_nvenc') return ['-c:v', encoder, '-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-pix_fmt', 'yuv420p', '-threads:v', '2'];
  // AMD AMF（VCE/VCN）：码率控制用 CQP，quality=speed 对应硬件快速档
  if (encoder === 'h264_amf') return ['-c:v', encoder, '-quality', 'speed', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '26', '-pix_fmt', 'yuv420p', '-threads:v', '2'];
  throw new Error('不支持的硬件编码器');
}

function runProbe(executable, args, { signal, cancelToken }, timeoutMs) {
  if (signal?.aborted || cancelToken?.reason) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let child, timer, killTimer, stopped, finished = false, stdout = '', stderr = '';
    const done = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      cancelToken?.unsubscribe(cancel);
      if (stopped === 'cancelled') reject(abortError());
      else resolve({ ok: code === 0 && !stopped, stdout, stderr });
    };
    const stop = reason => {
      if (finished || stopped) return;
      stopped = reason;
      try { child.kill('SIGTERM'); } catch (_) {}
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} done(null); }, 2000);
    };
    const cancel = () => stop('cancelled');
    try { child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (_) { done(null); return; }
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-65536); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-65536); });
    child.once('error', () => done(null));
    child.once('close', done);
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    cancelToken?.subscribe(cancel);
    if (signal?.aborted || cancelToken?.reason) cancel();
  });
}

async function pickHardwareEncoder({ executable, inputArgs, input, contentKey, signal, cancelToken, timeoutMs = 12000 }) {
  if (signal?.aborted || cancelToken?.reason) throw abortError();
  const candidates = process.platform === 'darwin' ? ['h264_videotoolbox']
    : ['win32', 'linux'].includes(process.platform) ? ['h264_nvenc', 'h264_amf'] : [];
  if (!candidates.length) return null;
  inputArgs ||= [...(contentKey ? ['-decryption_key', contentKey] : []), '-i', input];
  const encrypted = inputArgs.length === 4 && inputArgs[0] === '-decryption_key' && /^[0-9a-f]{32}$/i.test(inputArgs[1]);
  const offset = encrypted ? 2 : 0;
  if (!(encrypted || inputArgs.length === 2) || inputArgs[offset] !== '-i'
    || typeof inputArgs[offset + 1] !== 'string' || !path.isAbsolute(inputArgs[offset + 1])) throw inputError();
  const options = { signal, cancelToken };
  const bound = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(12000, timeoutMs)) : 12000;
  const listed = await runProbe(executable, ['-hide_banner', '-encoders'], options, Math.min(bound, 3000));
  if (!listed.ok) return null;
  const available = new Set(listed.stdout.split(/\r?\n/)
    .map(line => line.trim().split(/\s+/)[1]).filter(Boolean));
  for (const encoder of candidates) {
    if (!available.has(encoder)) continue;
    const result = await runProbe(executable, ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-protocol_whitelist', 'file,pipe',
      '-threads', '2', ...inputArgs, '-t', '1', '-frames:v', '12', '-map', '0:v:0', '-an', ...hardwareEncoderArgs(encoder), '-f', 'null', '-'], options, bound);
    // Input/storage failures cannot be repaired by selecting a software encoder.
    if (/Error opening input|Error reading input|Invalid data found|moov atom not found|No such file|Permission denied|No space left|Read-only file system|Disk quota|Input\/output error|File too large|Cannot allocate memory|Out of memory|Error while decoding|Error submitting packet|corrupt|decryption/i.test(result.stderr)) throw inputError();
    if (result.ok && /^frame=\s*[1-9]\d*\s*$/m.test(result.stdout)) return { encoder };
  }
  return null;
}

module.exports = { pickHardwareEncoder, hardwareEncoderArgs };
