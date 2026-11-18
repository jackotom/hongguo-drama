const fs = require('node:fs');
const path = require('node:path');

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeJsonAtomic(file, value, {
  pretty = 2,
  temporary = `${file}.tmp`,
  mode = 0o600,
  maxBytes = 0,
} = {}) {
  const directory = path.dirname(file);
  const serialized = JSON.stringify(value, null, pretty);
  const bytes = Buffer.byteLength(serialized);
  if (maxBytes > 0 && bytes > maxBytes) {
    throw Object.assign(new Error(`本地记录超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限，请清理旧任务或剧库后重试`), {
      code: 'STORE_TOO_LARGE',
      bytes,
      maxBytes,
    });
  }

  fs.mkdirSync(directory, { recursive: true });
  let fd;
  try {
    try {
      fd = fs.openSync(temporary, 'wx', mode);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(temporary);
      if (!stat.isFile() || stat.isSymbolicLink()) throw error;
      fs.unlinkSync(temporary);
      fd = fs.openSync(temporary, 'wx', mode);
    }
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
      fd = undefined;
    }
    fs.renameSync(temporary, file);
    // The rename is already visible; an unsupported directory fsync must not roll memory back to stale data.
    try { syncDirectory(directory); } catch {}
    return serialized;
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

module.exports = { writeJsonAtomic, syncDirectory };
