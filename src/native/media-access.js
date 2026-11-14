const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 文件签发身份：dev/ino/size/mtime/ctime/birthtime 用 BigInt 精确读取并转十进制字符串，
// 仅在内存比较，不进 JSON。替换、同尺寸改写或属性回退都无法复用旧 token。
function fileIdentity(resolved) {
  try {
    const stat = fs.lstatSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return {
      dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      birthtimeNs: stat.birthtimeNs == null ? '' : String(stat.birthtimeNs),
    };
  } catch (_) { return null; }
}

function sameIdentity(a, b) {
  if (a === null) return b === null;
  if (!b) return false;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

function createMediaAccess(devUrl) {
  const files = new Map(), ids = new Map();
  const devOrigin = devUrl ? new URL(devUrl).origin : '';
  const allowed = origin => origin === 'null' || origin === 'file://' || (!!devOrigin && origin === devOrigin);
  return {
    localUrl(file, validate) {
      const resolved = path.resolve(String(file));
      const identity = fileIdentity(resolved);
      let id = ids.get(resolved);
      if (id) {
        const entry = files.get(id);
        if (!sameIdentity(entry.identity, identity)) { ids.delete(resolved); files.delete(id); id = undefined; }
        else if (typeof validate === 'function') entry.validate = validate;
      }
      if (!id) { id = randomUUID(); ids.set(resolved, id); files.set(id, { file:resolved, identity, validate }); }
      return `hongguo-local://f/${id}`;
    },
    resolveLocal(value) {
      const url = new URL(value);
      if (url.hostname !== 'f' || url.search || url.hash) return null;
      return files.get(url.pathname.slice(1))?.file || null;
    },
    isValid(value) {
      try {
        const url = new URL(value);
        const id = url.hostname === 'f' && !url.search && !url.hash ? url.pathname.slice(1) : null;
        const entry = id && files.get(id);
        if (!entry) return false;
        if (entry.identity === null) return false;
        if (!sameIdentity(entry.identity, fileIdentity(entry.file))) {
          files.delete(id);
          if (ids.get(entry.file) === id) ids.delete(entry.file);
          return false;
        }
        return typeof entry.validate === 'function' && entry.validate(entry.file) === true;
      } catch (_) { return false; }
    },
    corsHeaders(request) {
      const origin = request.headers.get('origin');
      // Opaque origins are not identities: unguessable media capabilities remain mandatory.
      if ((origin && !allowed(origin)) || (request.initiatorOrigin && !allowed(request.initiatorOrigin))) return null;
      if (origin && request.initiatorOrigin && origin !== request.initiatorOrigin && !(origin === 'null' && request.initiatorOrigin === 'file://')) return null;
      return { 'Access-Control-Allow-Origin': origin || 'null', Vary: 'Origin', 'Cache-Control': 'no-store' };
    },
    clear() { files.clear(); ids.clear(); },
  };
}
module.exports = { createMediaAccess };
