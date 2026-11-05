const fs = require('node:fs/promises');

// Downloads and both prefetched episodes share one CPU budget; never restart an active conversion.
const waiting = [];
let converting = false;
const abortError = () => Object.assign(new Error('已取消 ByteVC2 转码'), { code: 'ERR_CANCELED' });

function drain() {
  if (converting || !waiting.length) return;
  waiting.sort((a, b) => b.getPriority() - a.getPriority());
  const next = waiting.shift();
  converting = true;
  next.cleanup();
  next.resolve(() => { converting = false; drain(); });
}

function acquire(signal, cancelToken, getPriority) {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = waiting.indexOf(entry);
      if (index === -1) return;
      waiting.splice(index, 1);
      entry.cleanup();
      reject(abortError());
    };
    const entry = { resolve, getPriority, cleanup: () => {
      signal?.removeEventListener('abort', cancel);
      cancelToken?.unsubscribe(cancel);
    } };
    waiting.push(entry);
    signal?.addEventListener('abort', cancel, { once: true });
    cancelToken?.subscribe(cancel);
    if (signal?.aborted || cancelToken?.reason) cancel();
    drain();
  });
}

async function convertBytevc2({ executable, input, output, contentKey, duration, signal, cancelToken, onProgress, maxBytes = Infinity, getPriority = () => 0 }) {
  const cancelled = () => signal?.aborted || cancelToken?.reason;
  if (cancelled()) throw abortError();
  if (!executable) throw new Error('未找到内置 ByteVC2 解码组件，请重新下载完整版本后重试');
  if (contentKey != null && !/^[a-f\d]{32}$/i.test(contentKey)) throw new Error('片源解密密钥格式无效');
  if (!Number.isFinite(duration) || duration <= 0 || !(maxBytes > 0) || input === output) throw new Error('ByteVC2 视频参数无效');
  const release = await acquire(signal, cancelToken, getPriority);
  try {
    if (cancelled()) throw abortError();
    const file = await fs.open(output, 'wx', 0o600);
    await file.close();
    try {
      if (cancelled()) throw abortError();
      let seconds = 0;
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-xerror', '-protocol_whitelist', 'file,pipe',
        '-filter_threads', '1', '-threads:v', '2', ...(contentKey ? ['-decryption_key', contentKey] : []), '-i', input,
        '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-threads:v', '2', '-x264-params', 'lookahead_threads=1',
        '-c:a', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
        ...(Number.isFinite(maxBytes) ? ['-fs', String(maxBytes)] : []), '-f', 'mp4', output];
      await new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let killTimer, buffer = '', stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
          killTimer.unref?.();
        };
        const cleanup = () => {
          clearTimeout(killTimer);
          signal?.removeEventListener('abort', stop);
          cancelToken?.unsubscribe(stop);
        };
        child.stdout.on('data', data => {
          buffer += data.toString();
          const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines) {
            const match = /^out_time_us=(\d+)/.exec(line);
            if (match) { seconds = Number(match[1]) / 1e6; onProgress?.(seconds); }
          }
        });
        // Native errors may include paths and content keys; expose only our own messages.
        child.stderr.on('data', () => {});
        child.once('error', () => { cleanup(); reject(new Error('无法启动内置 ByteVC2 解码组件')); });
        child.once('close', code => {
          cleanup();
          if (stopping || cancelled()) reject(abortError());
          else if (code !== 0) reject(Object.assign(new Error('ByteVC2 转码失败，请重新获取片源后重试'), { code: 'BYTEVC2_CONVERSION_FAILED' }));
          else resolve();
        });
        signal?.addEventListener('abort', stop, { once: true });
        cancelToken?.subscribe(stop);
        if (cancelled()) stop();
      });
      if (cancelled()) throw abortError();
      const size = (await fs.stat(output)).size;
      if (size >= maxBytes) throw Object.assign(new Error('本集转码后过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' });
      if (!size || seconds < duration - 1) throw new Error('ByteVC2 转码结果不完整，请重试本集');
      return { codec: 'h264', size };
    } catch (error) {
      await fs.unlink(output).catch(() => {});
      throw error;
    }
  } finally { release(); }
}

module.exports = { convertBytevc2 };
