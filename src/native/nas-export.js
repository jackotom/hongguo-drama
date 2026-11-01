'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const axios = require('axios');
const { seasonTitle } = require('./watch-history');
const { fetchPublicDetails } = require('./public-details');
const { publishMergedOutput } = require('./merge-runner');

const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

async function checkRoot(destination) {
  try {
    if (!path.isAbsolute(destination.root) || await fsp.realpath(destination.root) !== destination.root ||
        !(await fsp.stat(destination.root)).isDirectory() || (await fsp.stat(destination.root)).dev !== destination.device)
      throw new Error();
  } catch (_) { throw new Error('NAS 目录不可用，请重新挂载共享文件夹后重试'); }
}

async function directoryAt(destination, name) {
  await checkRoot(destination);
  const relative = path.relative(destination.root, destination.directory);
  if ((!relative && !destination.flat) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      path.basename(relative) !== relative) throw new Error('NAS 目标目录无效');
  let directory = destination.root;
  for (const segment of [...(relative ? [relative] : []), ...(name ? [name] : [])]) {
    if (segment !== path.basename(segment) || segment === '..' || segment === '.') throw new Error('NAS 子目录无效');
    directory = path.join(directory, segment);
    try { await fsp.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fsp.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('NAS 目录不能是符号链接或普通文件');
  }
  return directory;
}

async function publishFile(target, data, source) {
  const temporary = path.join(path.dirname(target), `.nas-${randomUUID()}.tmp`);
  try {
    if (source) await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    else await fsp.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    publishMergedOutput(temporary, target);
  } finally { await fsp.unlink(temporary).catch(() => {}); }
}

async function writeMissing(target, data) {
  try { await publishFile(target, data); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fsp.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('NAS 中已有无效的同名资料文件，请检查后重试');
  }
}

function imageExtension(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('来源未提供可用的 JPEG、PNG 或 WebP 封面');
}

async function fetchPoster(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('封面地址无效');
  const response = await axios.get(url.href, { responseType: 'arraybuffer', timeout: 10000,
    signal: AbortSignal.timeout(10000), maxContentLength: 12 * 1024 * 1024, maxRedirects: 3,
    headers: { 'User-Agent': 'Mozilla/5.0' } });
  return Buffer.from(response.data);
}

async function prepareNasExport({ root, folderName, series }, { metadataFetcher = fetchPublicDetails, posterFetcher = fetchPoster } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !folderName || path.basename(folderName) !== folderName ||
      folderName === '.' || folderName === '..') throw new Error('NAS 目录或文件夹名称无效');
  root = await fsp.realpath(root);
  const parsed = seasonTitle(series.series_title);
  const destination = { root, device: (await fsp.stat(root)).dev, directory: root, flat: true,
    seriesId: String(series.series_id), title: folderName.replace(/-[a-f0-9]{12}$/, ''), season: parsed.invalid ? 1 : parsed.season };
  const directory = await directoryAt(destination), warnings = [];
  try {
    const existing = await fsp.lstat(path.join(directory, 'tvshow.nfo'));
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size > 256 * 1024)
      throw new Error('所选目录已有无效或链接形式的剧集资料，请选择其他文件夹');
    const nfo = await fsp.readFile(path.join(directory, 'tvshow.nfo'), 'utf8');
    if (!nfo.includes(`<uniqueid type="hongguo" default="true">${xml(destination.seriesId)}</uniqueid>`))
      throw new Error('所选目录已有其他或无法确认归属的剧集资料，请为本剧选择单独的文件夹');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let metadata = series;
  if (/^\d{6,30}$/.test(destination.seriesId)) {
    try { const fresh = await metadataFetcher(destination.seriesId); if (fresh?.success) metadata = { ...series, ...fresh }; }
    catch (_) { /* Missing source fields are reported below without blocking videos. */ }
  }
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  if (description) {
    await writeMissing(path.join(directory, '简介.txt'), `${series.series_title}\n\n${description}\n`);
    const nfo = `<?xml version="1.0" encoding="UTF-8"?>\n<tvshow>\n  <title>${xml(series.series_title)}</title>\n  <plot>${xml(description)}</plot>\n  <uniqueid type="hongguo" default="true">${xml(destination.seriesId)}</uniqueid>\n</tvshow>\n`;
    await writeMissing(path.join(directory, 'tvshow.nfo'), nfo);
  } else warnings.push('来源暂未提供剧情简介，可再次点击补齐简介与剧集资料');
  try {
    const existing = await Promise.all(['jpg', 'png', 'webp'].map(ext => fsp.lstat(path.join(directory, `poster.${ext}`)).then(stat => stat.isFile() && !stat.isSymbolicLink() && stat.size > 0).catch(error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })));
    if (!existing.some(Boolean)) {
      const cover = metadata.cover || series.cover;
      if (!cover) throw new Error('未提供封面');
      const image = Buffer.from(await posterFetcher(cover));
      const extension = imageExtension(image);
      await writeMissing(path.join(directory, `poster.${extension}`), image);
    }
  } catch (_) { warnings.push('封面未能保存，可再次点击补齐'); }
  return { destination, warnings };
}

function nasEpisodeFilename(destination, episode) {
  const index = Number(episode.vid_index);
  if (!Number.isSafeInteger(index) || index < 1 || !Number.isSafeInteger(destination.season) || destination.season < 1 ||
      !destination.title || path.basename(destination.title) !== destination.title) throw new Error('NAS 分集信息无效');
  const season = String(destination.season).padStart(2, '0');
  return `${destination.title} S${season}E${String(index).padStart(3, '0')}.mp4`;
}

async function episodePaths(destination, episode) {
  const filename = nasEpisodeFilename(destination, episode);
  const directory = await directoryAt(destination, destination.flat ? '' : `Season ${String(destination.season).padStart(2, '0')}`);
  const stem = path.join(directory, filename.slice(0, -4));
  return { video: `${stem}.mp4`, nfo: `${stem}.nfo`, index: Number(episode.vid_index) };
}

async function inspectNasEpisode(destination, episode) {
  const files = await episodePaths(destination, episode);
  try {
    const stat = await fsp.lstat(files.video);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 102400) {
      const nfoStat = await fsp.lstat(files.nfo).catch(() => null);
      const nfo = nfoStat?.isFile() && !nfoStat.isSymbolicLink() && nfoStat.size <= 256 * 1024
        ? await fsp.readFile(files.nfo, 'utf8') : '';
      if (nfo.includes(`<uniqueid type="hongguo" default="true">${xml(episode.vid)}</uniqueid>`))
        return { status: 'existing', path: files.video };
    }
    return { status: 'conflict', path: files.video };
  } catch (error) { if (error.code === 'ENOENT') return { status: 'missing', path: files.video }; throw error; }
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyNasEpisode(task, destination) {
  if (String(task.hongguoInfo?.series_id) !== destination.seriesId) throw new Error('NAS 剧集身份不匹配');
  const episode = task.hongguoInfo, files = await episodePaths(destination, episode);
  let copied = path.resolve(task.savePath) !== files.video;
  if (!copied) {
    const stat = await fsp.lstat(files.video);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('NAS 同名视频是链接或无效文件，未写入分集资料');
  }
  try { if (copied) await publishFile(files.video, null, task.savePath); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fsp.lstat(files.video), original = await fsp.stat(task.savePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== original.size || await digest(files.video) !== await digest(task.savePath))
      throw new Error('NAS 中已有内容不同的同名视频，已保留原文件，未覆盖');
    copied = false;
  }
  const nfo = `<?xml version="1.0" encoding="UTF-8"?>\n<episodedetails>\n  <title>${xml(episode.ep_title || episode.title || `第${files.index}集`)}</title>\n  <season>${destination.season}</season>\n  <episode>${files.index}</episode>\n  <uniqueid type="hongguo" default="true">${xml(episode.vid)}</uniqueid>\n</episodedetails>\n`;
  await writeMissing(files.nfo, nfo);
  return { copied, path: files.video };
}

module.exports = { prepareNasExport, inspectNasEpisode, copyNasEpisode, nasEpisodeFilename, checkNasDirectory: directoryAt };
