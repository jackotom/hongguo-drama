const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const axios = require('axios');
const hongguo = require('../src/native/hongguo');
const { webMediaRequestOptions } = require('../src/native/web-media-guard');
const { meetsDownloadQuality } = require('../src/native/download-quality');
const { readMergeInfo } = require('../src/native/merge-plan');
const { runMerge, stopMergeChildren, publishMergedOutput } = require('../src/native/merge-runner');
const { convertBytevc2 } = require('../src/native/bytevc2');
const { fail, numericId } = require('./storage.cjs');
const { throwIfAborted } = require('../src/native/request-signal');
const MAX_BYTES = 1024 * 1024 * 1024;
const tools = { ffmpeg: process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg', ffprobe: process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe', librempeg: process.env.LIBREMPEG_PATH || '/usr/local/bin/librempeg' };
function run(executable, args, signal, timeout = 60000) {
  return new Promise((resolve, reject) => execFile(executable, args, { signal, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(fail(signal?.aborted ? '任务已取消' : `媒体工具执行失败（${typeof error.code === 'number' ? error.code : error.code || '未知'}）`));
    else resolve({ stdout, stderr });
  }));
}
async function probe(_executable, file, task, signal) {
  const result = await run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_data_hash', 'sha256', '-show_streams', '-show_format', '-of', 'json', file], signal, 30000);
  try { return readMergeInfo(JSON.parse(result.stdout)); } catch { throw fail('视频元数据无效'); }
}
async function verify(file, quality, signal, expectedDuration = 0) {
  const info = await probe(tools.ffprobe, file, null, signal);
  if (!info || ![info.duration, info.w, info.h].every(value => Number.isFinite(value) && value > 0)) throw fail('视频缺少有效时长或尺寸');
  if (!meetsDownloadQuality({ width: info.w, height: info.h }, quality)) throw fail(`实际视频不满足 ${quality}，未自动降级`);
  if (expectedDuration && info.duration < expectedDuration - Math.max(1, expectedDuration * 0.01)) throw fail('视频时长不完整');
  const result = await run(tools.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', file, '-t', '3', '-f', 'null', '-'], signal, 30000);
  if (result.stderr.trim()) throw fail('视频解码检查失败');
  return info;
}
function mediaGuard(value) {
  const url = new URL(value);
  const domains = ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com', 'bytecdn.cn', 'bytecdn.com', 'ibytedtos.com'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw fail('片源不属于允许的官方 HTTPS CDN');
  const guarded = webMediaRequestOptions(value);
  const redirect = guarded.beforeRedirect;
  return { ...guarded, proxy: false, beforeRedirect(options, response, request) { mediaGuard(new URL(response.headers.location, request.url).href); redirect(options, response, request); } };
}
async function series(id) {
  const result = await hongguo.fetchEpisodeList(numericId(id), { deadline: Date.now() + 25000 });
  const seen = new Set();
  if (String(result.series_id) !== id || !Array.isArray(result.episodes) || !result.episodes.length || result.episodes.length > 1000) throw fail('剧集目录无效', 502);
  const episodes = result.episodes.map((episode, index) => {
    const vid = numericId(String(episode.vid));
    if (seen.has(vid) || Number(episode.vid_index) !== index + 1 || episode.series_id && String(episode.series_id) !== id || episode.locked) throw fail('分集身份、编号或权限校验失败', 502);
    seen.add(vid); return { vid, vid_index: index + 1, title: String(episode.title || '') };
  });
  if (Number(result.total) && Number(result.total) !== episodes.length) throw fail('剧集目录不完整', 502);
  return { series_id: id, series_title: String(result.series_title || '未命名短剧'), cover: String(result.cover || ''), total: episodes.length, episodes };
}
async function download(task, store, signal, update) {
  throwIfAborted(signal);
  const destination = store.output(task);
  if (fs.existsSync(destination)) { await verify(destination, task.quality, signal); return; }
  const detail = await series(task.seriesId);
  if (!detail.episodes.some(item => item.vid === task.vid && item.vid_index === task.episodeIndex)) throw fail('分集目录已改变，请重新选集');
  throwIfAborted(signal);
  const info = await hongguo.fetchPlayUrlSingle(task.vid, task.seriesId, { quality: task.quality, signal });
  throwIfAborted(signal);
  if (!info?.url || info.locked || info.vid !== task.vid) throw Object.assign(fail(info?.error || '未取得完整可用片源'), { code: info?.code, sources: info?.sources });
  const work = fs.mkdtempSync(path.join(store.directory(task), '.download-'));
  const input = path.join(work, 'input.mp4'), output = path.join(work, 'output.mp4');
  try {
    const response = await axios.get(info.url, { ...mediaGuard(info.url), responseType: 'stream', timeout: 60000, signal,
      headers: { 'User-Agent': info.userAgent || hongguo.UA, 'Accept-Encoding': 'identity', ...(info.referer ? { Referer: info.referer } : {}) } });
    const size = Number(response.headers['content-length']);
    if (response.status !== 200 || /text\/|json/i.test(response.headers['content-type'] || '') || size > MAX_BYTES) { response.data.destroy(); throw fail('片源响应不是完整视频或超过 1 GiB 上限'); }
    let received = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; if (received > MAX_BYTES) callback(fail('视频超过 1 GiB 上限')); else { update(size > 0 ? Math.min(75, Math.floor(received / size * 75)) : 0); callback(null, chunk); } } });
    await pipeline(response.data, meter, fs.createWriteStream(input, { flags: 'wx', mode: 0o600 }), { signal });
    if (!received || size > 0 && received !== size) throw fail('视频传输不完整');
    const key = info.contentKey || (info.spadeA ? hongguo.deriveKey(info.spadeA)?.toString('hex') : null);
    if ((info.spadeA && !key) || (key && !/^[a-f\d]{32}$/i.test(key))) throw fail('解密信息无效');
    if (info.codec === 'bytevc2') await convertBytevc2({ executable: tools.librempeg, input, output, contentKey: key, duration: info.duration, signal, maxBytes: MAX_BYTES, onProgress: seconds => update(75 + Math.floor(Math.min(1, seconds / info.duration) * 20)) });
    else if (key) await run(tools.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe', '-decryption_key', key, '-i', input, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output], signal, 120000);
    else fs.renameSync(input, output);
    update(96);
    const actual = await verify(output, task.quality, signal, Number(info.duration) || 0);
    if (info.width && info.height && (actual.w !== Number(info.width) || actual.h !== Number(info.height))) throw fail('实际画面尺寸与片源不一致');
    signal.throwIfAborted(); store.output(task);
    publishMergedOutput(output, destination);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
async function merge(task, store, signal, update) {
  const inputs = task.taskIds.map(id => store.get(id)).sort((a, b) => a.episodeIndex - b.episodeIndex);
  const ordered = inputs.map(input => {
    if (input.type !== 'download' || input.status !== 'completed' || input.seriesId !== task.seriesId) throw fail('只能合并同剧已完成的下载');
    return { path: store.output(input), vid_index: input.episodeIndex };
  });
  const infos = [];
  for (let i = 0; i < ordered.length; i++) infos.push(await verify(ordered[i].path, inputs[i].quality, signal));
  const duration = infos.reduce((sum, info) => sum + info.duration, 0);
  const output = store.output(task);
  if (fs.existsSync(output)) { await verify(output, 'auto', signal, duration); return; }
  const staging = fs.mkdtempSync(path.join(store.directory(task), '.download-'));
  const job = { ...task, output: path.join(staging, 'merged.mp4'), startTime: Date.now(), totalBytes: ordered.reduce((sum, item) => sum + fs.statSync(item.path).size, 0) };
  const abort = () => { job.cancelled = true; stopMergeChildren(job); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await runMerge({ task: job, ordered, outDir: store.directory(task), ffmpegPath: tools.ffmpeg, ffprobePath: tools.ffprobe, precheckedInfos: infos,
      probe, pickEncoder: async () => 'libx264', compatible: true, update: () => update(Math.min(98, job.progress || 0)) });
    await verify(job.output, 'auto', signal, duration);
    signal.throwIfAborted(); store.output(task);
    publishMergedOutput(job.output, output);
  } finally { signal.removeEventListener('abort', abort); fs.rmSync(staging, { recursive: true, force: true }); }
}
module.exports = { series, download, merge, verify, mediaGuard, tools };
