const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Model provisional IDs and allocation changes; real files and descriptors still do all IO.
module.exports = async function withTransientFileIds(root, check) {
  const original = { open:fsp.open, lstat:fsp.lstat, lstatSync:fs.lstatSync };
  const transient = (file, stat) => {
    if (String(file).startsWith(root + path.sep) && stat.isFile() && typeof stat.ino === 'bigint' && stat.ino > 0n) {
      stat.ino = stat.size === 0n ? -stat.ino : stat.ino * 2n + (stat.size === 1n ? 0n : 1n);
    }
    return stat;
  };
  fsp.open = async (file, ...args) => {
    const handle = await original.open(file, ...args), stat = handle.stat.bind(handle);
    handle.stat = async (...options) => transient(file, await stat(...options));
    return handle;
  };
  fsp.lstat = async (file, ...args) => transient(file, await original.lstat(file, ...args));
  fs.lstatSync = (file, ...args) => transient(file, original.lstatSync(file, ...args));
  try { return await check(); }
  finally { Object.assign(fsp, { open:original.open, lstat:original.lstat }); fs.lstatSync = original.lstatSync; }
};
