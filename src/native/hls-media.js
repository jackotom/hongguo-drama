const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const axios = require('axios');
const { webMediaRequestOptions } = require('./web-media-guard');
const { localMediaEnv } = require('./child-env');
const diskJobs = new Set();
const DISK_RESERVE = 512 * 1024 * 1024;

async function requestHls(url, { signal, headers, useProxy = true }) {
  return axios({ url, method:'GET', responseType:'stream', timeout:30000,
    ...webMediaRequestOptions(url), proxy: useProxy, signal, headers });
}

// The bundled FFmpeg has no HTTP transport: stage guarded HLS resources on disk and allow local protocols only.
async function remuxHls({ url, output, ffmpeg, signal, cancelToken, request = requestHls, checkAccess = () => {}, headers = {}, onProgress, tempCapacityBytes, useProxy = true }) {
  if (!ffmpeg) throw new Error('未找到 FFmpeg，无法准备 HLS 视频');
  webMediaRequestOptions(url);
  const controller = new AbortController(), files = new Map();
  let temporary, child, failure, killed, killTimer, spaceTimer, diskJob, writer;
  let received = 0, lastProgress = 0, stagedBytes = 0, committedBytes = 0, remuxing = false;
  let lastStatfsAt = 0, lastStatfsBytes = 0;
  const capacityBytes = Number.isFinite(tempCapacityBytes) && tempCapacityBytes >= 0 ? tempCapacityBytes : Infinity;
  const stopChild = () => {
    if (!child || killed) return;
    killed = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  };
  const fail = error => { failure ||= error; controller.abort(); stopChild(); };
  const abort = () => fail(new Error('已取消 HLS 准备'));
  const check = () => {
    if (signal?.aborted || cancelToken?.reason) abort();
    if (failure) throw failure;
    checkAccess();
  };
  const ensureCapacity = (extra, forceStatfs = false) => {
    if (stagedBytes + extra > capacityBytes) throw new Error('HLS 暂存空间不足，已停止');
    const now = Date.now();
    if (!forceStatfs && extra > 0 && now - lastStatfsAt < 250 && stagedBytes + extra - lastStatfsBytes < 1024 * 1024) return;
    lastStatfsAt = now;
    lastStatfsBytes = stagedBytes + extra;
    const stat = fs.statfsSync(temporary), free = Number(stat.bsize) * Number(stat.bavail);
    const needed = [...diskJobs].filter(job => job.device === diskJob.device)
      .reduce((sum, job) => sum + job.remaining(job === diskJob ? extra : 0), DISK_RESERVE);
    if (!Number.isFinite(free) || free < needed) throw new Error('HLS 暂存或输出空间不足，已停止');
  };
  signal?.addEventListener('abort', abort, { once:true }); cancelToken?.subscribe(abort);
  const deadline = setTimeout(() => fail(new Error('HLS 准备超时，请重试')), 10 * 60 * 1000);
  const stage = async (remote, playlist = false, ancestors = new Set()) => {
    check(); webMediaRequestOptions(remote);
    if (ancestors.has(remote)) throw new Error('HLS 清单循环引用');
    if (files.has(remote)) return files.get(remote);
    if (files.size >= 10000) throw new Error('HLS 清单过大');
    const extension = playlist ? 'm3u8' : /\.(ts|m4s|mp4|aac|m4a|vtt)$/i.exec(new URL(remote).pathname)?.[1] || 'ts';
    const local = path.join(temporary, `${files.size}.${extension}`);
    files.set(remote,local);
    let upstream;
    try {
      upstream = await request(remote, { signal:controller.signal, headers:{...headers,'Accept-Encoding':'identity'}, useProxy });
      check();
      if (upstream.status !== 200) throw new Error('HLS 媒体请求失败或内容不完整');
      const type = String(upstream.headers['content-type'] || '');
      if (playlist || /mpegurl/i.test(type)) {
        const parts = [];
        let bytes = 0;
        for await (const chunk of upstream.data) {
          check(); bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) throw new Error('HLS 清单过大');
          // Decode only after the whole manifest is buffered: UTF-8 characters may span chunks.
          parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (Number(upstream.headers['content-length']) && bytes !== Number(upstream.headers['content-length'])) throw new Error('HLS 清单下载不完整');
        const text = Buffer.concat(parts).toString('utf8');
        if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('无效 HLS 清单');
        if (/#EXTINF:/.test(text) && !/#EXT-X-ENDLIST/.test(text)) throw new Error('暂不支持未结束的直播清单');
        const base = upstream.request?.res?.responseUrl || upstream.url || remote;
        webMediaRequestOptions(base);
        const chain = new Set([...ancestors,remote]);
        let lines = text.split(/\r?\n/);
        // Keep one highest-bandwidth rendition; final media verification enforces the requested resolution.
        const variants = lines.map((line,index) => ({index,bandwidth:Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(line.slice(line.indexOf(':')+1))?.[1]) || 0})).filter(item => lines[item.index].startsWith('#EXT-X-STREAM-INF:'));
        if (variants.length > 1) {
          const chosen = variants.reduce((a,b) => b.bandwidth > a.bandwidth ? b : a);
          const removed = new Set(variants.filter(item => item !== chosen).flatMap(item => [item.index,item.index+1]));
          lines = lines.filter((line,index) => !removed.has(index));
        }
        const rewritten = []; let variant = false;
        for (const line of lines) {
          check(); const value = line.trim();
          if (!value) { rewritten.push(line); continue; }
          if (!value.startsWith('#')) {
            rewritten.push(await stage(new URL(value,base).href,variant,chain)); variant = false; continue;
          }
          variant = value.startsWith('#EXT-X-STREAM-INF:');
          if (value.startsWith('#EXT-X-DEFINE:')) throw new Error('不支持含动态地址变量的 HLS 清单');
          if (/^#EXT-X-(?:SESSION-)?KEY:/.test(value) && !/METHOD=(?:AES-128|NONE)(?:,|$)/.test(value)) throw new Error('不支持该 HLS 加密方式');
          let result = line, matches = [...line.matchAll(/\bURI="([^"]*)"/g)];
          if ((line.match(/\bURI\s*=/g) || []).length !== matches.length) throw new Error('HLS 地址格式无效');
          for (const match of matches) {
            const file = await stage(new URL(match[1],base).href,/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/.test(value),chain);
            if (/^#EXT-X-(?:SESSION-)?KEY:/.test(value) && fs.statSync(file).size !== 16) throw new Error('HLS 密钥长度无效');
            result = result.replace(match[0],`URI="${file}"`);
          }
          rewritten.push(result);
        }
        const manifest = rewritten.join('\n'), size = Buffer.byteLength(manifest);
        ensureCapacity(size); stagedBytes += size;
        await fsp.writeFile(local,manifest,{mode:0o600});
        committedBytes = stagedBytes;
      } else {
        if (/text\/html|application\/json/i.test(type)) throw new Error('HLS 分片返回了错误页面');
        let bytes = 0;
        upstream.data.on('data',chunk => {
          try { ensureCapacity(chunk.length); }
          catch (error) { fail(error); upstream.data.destroy(error); return; }
          stagedBytes += chunk.length; bytes += chunk.length; received += chunk.length;
          if (Date.now()-lastProgress >= 150) { onProgress?.(received); lastProgress = Date.now(); }
        });
        writer = fs.createWriteStream(local,{mode:0o600});
        await pipeline(upstream.data,writer,{signal:controller.signal});
        committedBytes = stagedBytes; writer = null;
        if (!bytes || (Number(upstream.headers['content-length']) && bytes !== Number(upstream.headers['content-length']))) throw new Error('HLS 分片下载不完整');
        onProgress?.(received);
      }
      check(); return local;
    } finally { upstream?.data?.destroy(); }
  };
  try {
    check();
    // Keep input and output on one device so all HLS jobs share its capacity reservation.
    const outputDir = path.dirname(output);
    await fsp.mkdir(outputDir, { recursive: true });
    temporary = await fsp.mkdtemp(path.join(outputDir, '.hongguo-hls-'));
    diskJob = { device: fs.statSync(temporary).dev, remaining(extra = 0) {
      const pending = Math.max(0, stagedBytes - committedBytes - (writer?.bytesWritten || 0));
      let outputBytes = 0;
      if (remuxing) { try { outputBytes = fs.statSync(output).size; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      // Actual free space already excludes written bytes; reserve only queued writes and the remaining MP4.
      return pending + extra + Math.max(0, Math.ceil((stagedBytes + extra) * 1.1) + 1024 * 1024 - outputBytes);
    } };
    diskJobs.add(diskJob);
    if (!(capacityBytes > 0)) throw new Error('HLS 暂存空间不足');
    ensureCapacity(0);
    const input = await stage(url,true);
    check(); ensureCapacity(0);
    remuxing = true;
    spaceTimer = setInterval(() => { try { ensureCapacity(0); } catch (error) { fail(error); } }, 1000);
    await new Promise((resolve,reject) => {
      child = spawn(ffmpeg,['-v','error','-nostdin','-y','-protocol_whitelist','file,crypto','-allowed_extensions','ALL',
        '-i',input,'-map','0:v:0','-map','0:a?','-c','copy','-movflags','+faststart','-f','mp4',output],
      {windowsHide:true,stdio:['ignore','ignore','pipe'],env:localMediaEnv()});
      child.stderr.on('data',() => {});
      child.once('error',() => reject(new Error('无法启动 FFmpeg')));
      child.once('close',code => { clearTimeout(killTimer); failure ? reject(failure) : code === 0 ? resolve() : reject(new Error('HLS 媒体转换失败')); });
      if (controller.signal.aborted) stopChild();
    });
    check();
    if (!fs.existsSync(output) || !fs.statSync(output).size) throw new Error('HLS 没有生成有效视频');
  } catch (error) {
    try { fs.unlinkSync(output); } catch (_) {}
    throw failure || error;
  } finally {
    clearTimeout(deadline); clearTimeout(killTimer); clearInterval(spaceTimer);
    signal?.removeEventListener('abort',abort); cancelToken?.unsubscribe(abort); controller.abort();
    try { if (temporary) await fsp.rm(temporary,{recursive:true,force:true}); }
    finally { diskJobs.delete(diskJob); }
  }
}
module.exports = { remuxHls };
