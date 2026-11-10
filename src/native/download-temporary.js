const fs = require('node:fs/promises');
const disk = require('node:fs');
const path = require('node:path');

const sameIdentity = (a, b) => b && Number.isSafeInteger(a.ino) && a.ino > 0
  && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const identityOf = stat => ({ dev:stat.dev, ino:stat.ino, birthtimeMs:stat.birthtimeMs });
const downloadTemporaryOwner = task => ({ taskId:String(task.id || ''), seriesId:String(task.hongguoInfo?.series_id || ''),
  vid:String(task.hongguoInfo?.vid || ''), vidIndex:Number(task.hongguoInfo?.vid_index), savePath:task.savePath });

function inspectDownloadTemporary(record, owner) {
  const unknown = () => ({ files:[], unverifiedItems:1, unverifiedBytes:null, missing:false, directoryVerified:false });
  if (!record || record.version !== 1 || !owner || !owner.taskId || !owner.seriesId || !owner.vid
    || !Number.isSafeInteger(owner.vidIndex) || !Object.entries(owner).every(([key, value]) => record.owner?.[key] === value)
    || typeof owner.savePath !== 'string' || !path.isAbsolute(owner.savePath)
    || typeof record.directory !== 'string' || !path.isAbsolute(record.directory)
    || path.resolve(record.directory) !== record.directory || path.dirname(record.directory) !== path.dirname(owner.savePath)
    || !/^\.hongguo-download-[A-Za-z0-9]{6}$/.test(path.basename(record.directory)) || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) return unknown();
  const result = { files:[], unverifiedItems:0, unverifiedBytes:0, missing:false, directoryVerified:true };
  try {
    const directory = disk.lstatSync(record.directory);
    if (!directory.isDirectory() || !sameIdentity(directory, record.identity)) return unknown();
    for (const name of disk.readdirSync(record.directory)) {
      const file = path.join(record.directory, name);
      try {
        const stat = disk.lstatSync(file);
        if (['input.enc.tmp', 'decoded.mp4'].includes(name) && stat.isFile() && sameIdentity(stat, record.files[name])) {
          result.files.push({ file, identity:record.files[name], size:stat.size });
        } else {
          result.unverifiedItems++;
          result.unverifiedBytes = stat.isFile() && result.unverifiedBytes !== null ? result.unverifiedBytes + stat.size : null;
        }
      } catch (_) { result.unverifiedItems++; result.unverifiedBytes = null; }
    }
    return result;
  } catch (error) { return error.code === 'ENOENT' ? { ...result, missing:true } : unknown(); }
}

async function cleanupDownloadTemporary(record, owner, canRemove = () => true) {
  let state = inspectDownloadTemporary(record, owner), count = 0, freed = 0, failed = 0;
  if (!state.missing && state.directoryVerified) {
    for (const item of state.files) {
      try {
        if (!canRemove() || !sameIdentity(await fs.lstat(record.directory), record.identity)) break;
        if (await removeOwnedFile(item.file, item.identity, canRemove)) { count++; freed += item.size; }
      } catch (_) { failed++; }
    }
    try {
      const current = await fs.lstat(record.directory);
      if (canRemove() && sameIdentity(current, record.identity)) await fs.rmdir(record.directory);
    } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) failed++; }
    state = inspectDownloadTemporary(record, owner);
  }
  return { ...state, count, freed, failed };
}

async function isOwnedFile(file, identity) {
  try {
    const current = await fs.lstat(file);
    return current.isFile() && sameIdentity(current, identity);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function removeOwnedFile(file, identity, canRemove = () => true) {
  try {
    const current = await fs.lstat(file);
    if (!current.isFile() || !sameIdentity(current, identity) || !canRemove()) return false;
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function createDownloadTemporary(directory, { owner, onChange = () => {} } = {}) {
  // A fresh private directory avoids legacy leftovers without guessing who owns them.
  const root = await fs.mkdtemp(path.join(directory, '.hongguo-download-'));
  const record = { version:1, owner, directory:root, identity:identityOf(await fs.lstat(root)), files:{} };
  const input = path.join(root, 'input.enc.tmp'), output = path.join(root, 'decoded.mp4');
  const reserve = async file => {
    const handle = await fs.open(file, 'wx', 0o600);
    try { record.files[path.basename(file)] = identityOf(await handle.stat()); onChange(record); } finally { await handle.close(); }
  };
  const removeOutput = async () => {
    if (record.files['decoded.mp4']) {
      if (!await removeOwnedFile(output, record.files['decoded.mp4'])) {
        throw Object.assign(new Error('下载临时文件已变化，已有文件已保留，请重试'), { code: 'EEXIST' });
      }
      delete record.files['decoded.mp4']; onChange(record);
    }
  };
  const cleanup = () => cleanupDownloadTemporary(record, owner);
  try { onChange(record); await reserve(input); }
  catch (error) { await cleanup().catch(() => {}); throw error; }
  return { input, output, record, reserveOutput: () => reserve(output),
    outputCreated: stat => { record.files['decoded.mp4'] = identityOf(stat); onChange(record); }, removeOutput, cleanup,
    checkInput: async () => {
      if (!record.files['input.enc.tmp'] || !await isOwnedFile(input, record.files['input.enc.tmp'])) {
        throw Object.assign(new Error('下载临时文件已变化，已有文件已保留，请重试'), { code: 'EEXIST' });
      }
    },
    checkOutput: async () => {
      if (!record.files['decoded.mp4'] || !await isOwnedFile(output, record.files['decoded.mp4'])) {
        throw Object.assign(new Error('下载临时文件已变化，已有文件已保留，请重试'), { code: 'EEXIST' });
      }
    } };
}

module.exports = { createDownloadTemporary, removeOwnedFile, isOwnedFile, downloadTemporaryOwner, inspectDownloadTemporary, cleanupDownloadTemporary };
