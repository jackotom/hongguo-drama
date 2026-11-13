const fs = require('node:fs/promises');
const disk = require('node:fs');
const path = require('node:path');

// Persist exact IDs as strings: 64-bit file IDs can exceed Number's safe integer range.
const identityOf = stat => typeof stat.ino === 'bigint'
  ? { dev:String(stat.dev), ino:String(stat.ino), birthtimeNs:String(stat.birthtimeNs) }
  : { dev:stat.dev, ino:stat.ino, birthtimeMs:stat.birthtimeMs };
const statOptions = identity => ({ bigint:typeof identity?.ino !== 'number' });
const sameIdentity = (stat, identity) => {
  if (typeof identity?.ino === 'number') return Number.isSafeInteger(stat.ino) && stat.ino > 0
    && stat.dev === identity.dev && stat.ino === identity.ino && stat.birthtimeMs === identity.birthtimeMs;
  if (typeof stat.ino !== 'bigint' || stat.ino <= 0n || typeof stat.birthtimeNs !== 'bigint') return false;
  const a = identityOf(stat), b = typeof identity?.ino === 'bigint' ? identityOf(identity) : identity;
  return !!b && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
};
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
    const directory = disk.lstatSync(record.directory, statOptions(record.identity));
    if (!directory.isDirectory() || !sameIdentity(directory, record.identity)) return unknown();
    for (const name of disk.readdirSync(record.directory)) {
      const file = path.join(record.directory, name);
      try {
        const stat = disk.lstatSync(file, statOptions(record.files[name]));
        if (['input.enc.tmp', 'decoded.mp4'].includes(name) && stat.isFile() && sameIdentity(stat, record.files[name])) {
          result.files.push({ file, identity:record.files[name], size:Number(stat.size) });
        } else {
          result.unverifiedItems++;
          result.unverifiedBytes = stat.isFile() && result.unverifiedBytes !== null ? result.unverifiedBytes + Number(stat.size) : null;
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
        if (!canRemove() || !sameIdentity(await fs.lstat(record.directory, statOptions(record.identity)), record.identity)) break;
        if (await removeOwnedFile(item.file, item.identity, canRemove)) { count++; freed += item.size; }
      } catch (_) { failed++; }
    }
    try {
      const current = await fs.lstat(record.directory, statOptions(record.identity));
      if (canRemove() && sameIdentity(current, record.identity)) await fs.rmdir(record.directory);
    } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) failed++; }
    state = inspectDownloadTemporary(record, owner);
  }
  return { ...state, count, freed, failed };
}

async function isOwnedFile(file, identity) {
  try {
    const current = await fs.lstat(file, statOptions(identity));
    return current.isFile() && sameIdentity(current, identity);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function removeOwnedFile(file, identity, canRemove = () => true) {
  try {
    const current = await fs.lstat(file, statOptions(identity));
    if (!current.isFile() || !sameIdentity(current, identity) || !canRemove()) return false;
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function reserveOwnedFile(file, onChange = () => {}) {
  const handle = await fs.open(file, 'wx', 0o600);
  let identity, held = false;
  const inspect = async () => {
    let stat = identity;
    if (held) {
      stat = await handle.stat({ bigint:true });
      // exFAT assigns the durable ID on allocation, and changes it again after truncation.
      if (stat.ino < 0n && stat.size === 0n) {
        await handle.write(Buffer.alloc(1), 0, 1, 0);
        stat = await handle.stat({ bigint:true });
      }
    }
    const current = await fs.lstat(file, statOptions(stat));
    if (!current.isFile() || !sameIdentity(current, stat)) return null;
    if (held) { identity = stat; onChange(stat); }
    return stat;
  };
  const check = async () => {
    try { const stat = await inspect(); if (stat) return stat; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    throw Object.assign(new Error('下载临时文件已变化，已有文件已保留，请重试'), { code:'EEXIST' });
  };
  try {
    identity = await handle.stat({ bigint:true });
    held = typeof identity.ino === 'bigint' && identity.ino < 0n;
    if (held) await check();
    else { onChange(identity); await handle.close(); }
  } catch (error) { await handle.close().catch(() => {}); throw error; }
  return { check,
    remove: async () => {
      try {
        if (!await inspect()) return false;
        await fs.unlink(file);
        return true;
      } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    },
    close: async () => { if (held) { held = false; await handle.close(); } } };
}

async function createDownloadTemporary(directory, { owner, onChange = () => {} } = {}) {
  // A fresh private directory avoids legacy leftovers without guessing who owns them.
  const root = await fs.mkdtemp(path.join(directory, '.hongguo-download-'));
  const record = { version:1, owner, directory:root, identity:identityOf(await fs.lstat(root, { bigint:true })), files:{} };
  const input = path.join(root, 'input.enc.tmp'), output = path.join(root, 'decoded.mp4');
  const reservations = new Map();
  const reserve = async file => {
    reservations.set(path.basename(file), await reserveOwnedFile(file, stat => {
      record.files[path.basename(file)] = identityOf(stat); onChange(record);
    }));
  };
  const removeOutput = async () => {
    if (record.files['decoded.mp4']) {
      const reserved = reservations.get('decoded.mp4');
      if (!await (reserved ? reserved.remove() : removeOwnedFile(output, record.files['decoded.mp4']))) {
        throw Object.assign(new Error('下载临时文件已变化，已有文件已保留，请重试'), { code: 'EEXIST' });
      }
      await reserved?.close(); reservations.delete('decoded.mp4');
      delete record.files['decoded.mp4']; onChange(record);
    }
  };
  const cleanup = async () => {
    try {
      if (inspectDownloadTemporary(record, owner).directoryVerified) {
        for (const reserved of reservations.values()) await reserved.check().catch(() => {});
      }
      return await cleanupDownloadTemporary(record, owner);
    } finally { await Promise.all([...reservations.values()].map(reserved => reserved.close())); }
  };
  try { onChange(record); await reserve(input); }
  catch (error) { await cleanup().catch(() => {}); throw error; }
  return { input, output, record, reserveOutput: () => reserve(output),
    outputCreated: stat => { record.files['decoded.mp4'] = identityOf(stat); onChange(record); }, removeOutput, cleanup,
    checkInput: async () => {
      if (reservations.has('input.enc.tmp')) return reservations.get('input.enc.tmp').check();
      if (!record.files['input.enc.tmp'] || !await isOwnedFile(input, record.files['input.enc.tmp'])) {
        throw Object.assign(new Error('下载临时文件已变化，已有文件已保留，请重试'), { code: 'EEXIST' });
      }
    },
    checkOutput: async () => {
      if (reservations.has('decoded.mp4')) return reservations.get('decoded.mp4').check();
      if (!record.files['decoded.mp4'] || !await isOwnedFile(output, record.files['decoded.mp4'])) {
        throw Object.assign(new Error('下载临时文件已变化，已有文件已保留，请重试'), { code: 'EEXIST' });
      }
    } };
}

module.exports = { createDownloadTemporary, reserveOwnedFile, removeOwnedFile, isOwnedFile, downloadTemporaryOwner, inspectDownloadTemporary, cleanupDownloadTemporary };
