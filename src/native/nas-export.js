'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const axios = require('axios');
const { seasonTitle } = require('./watch-history');
const { fetchPublicDetails } = require('./public-details');
const { publishMergedOutput } = require('./merge-runner');

const NAS_INDEX = '.hongguo-nas.json';
const NAS_IDENTITY_LIMIT = 256 * 1024;
const nasIndexWrites = new Map();

const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

function nasIdentity(value, label, maxLength = 512) {
  const text = String(value ?? '');
  if (!text || text.length > maxLength || text.trim() !== text || /[\u0000-\u001f\u007f]/.test(text))
    throw new Error(`NAS 分集${label}无效`);
  return text;
}

function episodeIdentity(episode, seriesId) {
  const targetSeries = nasIdentity(seriesId, '剧号', 256);
  if (episode?.series_id != null && String(episode.series_id) !== targetSeries) throw new Error('NAS 剧集身份不匹配');
  const index = Number(episode.vid_index);
  if (!Number.isSafeInteger(index) || index < 1) throw new Error('NAS 分集编号无效');
  return { index, vid: nasIdentity(episode.vid, '身份') };
}

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

function readNasIndex(file, seriesId) {
  seriesId = nasIdentity(seriesId, '剧号', 256);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, seriesId, episodes: [] };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > NAS_IDENTITY_LIMIT)
    throw new Error('NAS 身份索引是链接、过大的文件或无效文件，请检查后重试');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { throw new Error('NAS 身份索引损坏，请检查后重试'); }
  if (value?.version !== 1 || value.seriesId !== seriesId || !Array.isArray(value.episodes) || value.episodes.length > 10000)
    throw new Error('NAS 身份索引无法确认属于当前剧集，请为本剧选择单独文件夹');
  const indexes = new Map(), vids = new Map(), episodes = value.episodes.map(item => {
    const index = Number(item?.index), vid = nasIdentity(item?.vid, '索引身份');
    if (!Number.isSafeInteger(index) || index < 1) throw new Error('NAS 身份索引包含无效分集编号');
    if ((indexes.has(index) && indexes.get(index) !== vid) || (vids.has(vid) && vids.get(vid) !== index))
      throw new Error('NAS 身份索引包含冲突的分集身份');
    indexes.set(index, vid); vids.set(vid, index);
    return { index, vid };
  });
  return { version: 1, seriesId, episodes };
}

function writeNasIndex(file, seriesId, episodes) {
  const temporary = path.join(path.dirname(file), `.nas-index-${randomUUID()}.tmp`);
  let fd;
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile()))
      throw new Error('NAS 身份索引是链接或无效文件，未写入');
    const value = { version: 1, seriesId, episodes: episodes.slice().sort((a, b) => a.index - b.index) };
    const json = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(json, 'utf8') > NAS_IDENTITY_LIMIT)
      throw new Error('NAS 身份索引超过 256 KiB，未写入');
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function hasHongguoIdentity(value, id) {
  const uniqueIds = [...String(value).replace(/<!--[\s\S]*?-->/g, '').matchAll(/<uniqueid\b([^>]*)>([\s\S]*?)<\/uniqueid\s*>/gi)]
    .filter(match => /\btype\s*=\s*(?:"hongguo"|'hongguo')/i.test(match[1]))
    .map(match => match[2].trim());
  return uniqueIds.length === 1 && uniqueIds[0] === xml(id);
}

function indexStatus(index, episode) {
  const byIndex = index.episodes.find(item => item.index === episode.index);
  const byVid = index.episodes.find(item => item.vid === episode.vid);
  return {
    conflict: Boolean((byIndex && byIndex.vid !== episode.vid) || (byVid && byVid.index !== episode.index)),
    matched: Boolean(byIndex || byVid),
  };
}

async function readTvshowIdentity(directory, seriesId) {
  const file = path.join(directory, 'tvshow.nfo');
  let stat;
  try { stat = await fsp.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, matches: false };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > NAS_IDENTITY_LIMIT)
    throw new Error('所选目录的剧集资料是链接、过大的文件或无效文件，请选择其他文件夹');
  const value = await fsp.readFile(file, 'utf8');
  return { exists: true, matches: hasHongguoIdentity(value, seriesId) };
}

async function readEpisodeNfo(file, episode) {
  let stat;
  try { stat = await fsp.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, matches: false };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > NAS_IDENTITY_LIMIT)
    return { exists: true, matches: false };
  return { exists: true, matches: hasHongguoIdentity(await fsp.readFile(file, 'utf8'), episode.vid) };
}

async function copyEpisodeIndex(destination, episode) {
  const file = path.join(destination.directory, NAS_INDEX);
  const previous = nasIndexWrites.get(file) || Promise.resolve();
  const write = previous.catch(() => {}).then(() => {
    const index = readNasIndex(file, destination.seriesId), status = indexStatus(index, episode);
    if (status.conflict) throw new Error('NAS 身份索引中的分集身份冲突，未覆盖原有资料');
    if (!status.matched) index.episodes.push(episode);
    writeNasIndex(file, destination.seriesId, index.episodes);
  });
  nasIndexWrites.set(file, write);
  const clean = () => { if (nasIndexWrites.get(file) === write) nasIndexWrites.delete(file); };
  write.then(clean, clean);
  return write;
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

async function prepareNasExport({ root, folderName, series, createFolder = false }, { metadataFetcher = fetchPublicDetails, posterFetcher = fetchPoster } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !folderName || path.basename(folderName) !== folderName ||
      folderName.length > 255 || folderName === '.' || folderName === '..' || /[\u0000-\u001f\u007f]/.test(folderName) ||
      typeof createFolder !== 'boolean') throw new Error('NAS 目录或文件夹名称无效');
  root = await fsp.realpath(root);
  const parsed = seasonTitle(series.series_title);
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw new Error('NAS 目录不可用，请重新挂载共享文件夹后重试');
  const seriesId = nasIdentity(series.series_id, '剧号');
  const destination = { root, device: rootStat.dev, directory: createFolder ? path.join(root, folderName) : root, flat: true,
    seriesId, title: folderName.replace(/-[a-f0-9]{12}$/, ''), season: parsed.invalid ? 1 : parsed.season };
  const directory = await directoryAt(destination), warnings = [];
  const tvshow = await readTvshowIdentity(directory, destination.seriesId);
  if (tvshow.exists && !tvshow.matches)
    throw new Error('所选目录已有其他或无法确认归属的剧集资料，请为本剧选择单独的文件夹');
  readNasIndex(path.join(directory, NAS_INDEX), destination.seriesId);
  let metadata = series;
  if (/^\d{6,30}$/.test(destination.seriesId)) {
    try { const fresh = await metadataFetcher(destination.seriesId); if (fresh?.success) metadata = { ...series, ...fresh }; }
    catch (_) { /* Missing source fields are reported below without blocking videos. */ }
  }
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  if (description) {
    await writeMissing(path.join(directory, '简介.txt'), `${series.series_title}\n\n${description}\n`);
  } else warnings.push('来源暂未提供剧情简介，可再次点击补齐简介与剧集资料');
  const plot = description ? `\n  <plot>${xml(description)}</plot>` : '';
  const nfo = `<?xml version="1.0" encoding="UTF-8"?>\n<tvshow>\n  <title>${xml(series.series_title)}</title>${plot}\n  <uniqueid type="hongguo" default="true">${xml(destination.seriesId)}</uniqueid>\n</tvshow>\n`;
  await writeMissing(path.join(directory, 'tvshow.nfo'), nfo);
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
  const identity = episodeIdentity(episode, destination.seriesId);
  const files = await episodePaths(destination, episode);
  const index = readNasIndex(path.join(destination.directory, NAS_INDEX), destination.seriesId);
  const indexState = indexStatus(index, identity);
  const nfoState = await readEpisodeNfo(files.nfo, identity);
  const conflict = indexState.conflict || (nfoState.exists && !nfoState.matches);
  const matched = indexState.matched || nfoState.matches;
  try {
    const stat = await fsp.lstat(files.video);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 102400) {
      if (!conflict && matched) return { status: 'existing', path: files.video };
    }
    return { status: 'conflict', path: files.video };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: conflict ? 'conflict' : 'missing', path: files.video };
    throw error;
  }
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyNasEpisode(task, destination) {
  if (String(task.hongguoInfo?.series_id) !== destination.seriesId) throw new Error('NAS 剧集身份不匹配');
  const episode = episodeIdentity(task.hongguoInfo, destination.seriesId);
  const files = await episodePaths(destination, task.hongguoInfo);
  const tvshow = await readTvshowIdentity(destination.directory, destination.seriesId);
  if (!tvshow.exists || !tvshow.matches)
    throw new Error('NAS 剧集资料无法确认属于当前剧集，未写入分集资料');
  const index = readNasIndex(path.join(destination.directory, NAS_INDEX), destination.seriesId);
  const indexState = indexStatus(index, episode), nfoState = await readEpisodeNfo(files.nfo, episode);
  if (indexState.conflict || (nfoState.exists && !nfoState.matches))
    throw new Error('NAS 同名分集身份冲突，已保留原有资料，未覆盖');
  if (typeof task.savePath !== 'string' || !path.isAbsolute(task.savePath)) throw new Error('NAS 源视频路径无效');
  let copied = path.resolve(task.savePath) !== files.video;
  if (!copied) {
    const stat = await fsp.lstat(files.video);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 102400)
      throw new Error('NAS 同名视频是链接或无效文件，未写入分集资料');
  } else {
    const stat = await fsp.lstat(task.savePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 102400) throw new Error('NAS 源视频是链接或无效文件');
  }
  try { if (copied) await publishFile(files.video, null, task.savePath); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fsp.lstat(files.video), original = await fsp.stat(task.savePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== original.size || await digest(files.video) !== await digest(task.savePath))
      throw new Error('NAS 中已有内容不同的同名视频，已保留原文件，未覆盖');
    copied = false;
  }
  await copyEpisodeIndex(destination, episode);
  return { copied, path: files.video };
}

module.exports = { prepareNasExport, inspectNasEpisode, copyNasEpisode, nasEpisodeFilename, checkNasDirectory: directoryAt };
