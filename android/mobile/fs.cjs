const { Buffer } = require('buffer/');
const staged = new Map();
const allowed = new Set(['account.session','account.session.tmp','danmaku.identity']);
function name(path) { if (!allowed.has(path)) throw new Error('安卓私有资料路径无效'); return path; }
function readFileSync(path, encoding) {
  const value = Native.readPrivate(name(path));
  if (!value) throw Object.assign(new Error('资料不存在'), { code:'ENOENT' });
  const data = Buffer.from(value,'base64'); return encoding ? data.toString(encoding) : data;
}
function writeFileSync(path, value, options) {
  if (typeof path === 'number') { staged.set(path,Buffer.from(value)); return; }
  name(path);
  if (options?.flag === 'wx' && Native.readPrivate(path)) throw Object.assign(new Error('资料已存在'),{code:'EEXIST'});
  Native.writePrivate(path,Buffer.from(value).toString('base64'));
}
module.exports = {
  readFileSync, writeFileSync,
  existsSync: path => !!Native.readPrivate(name(path)),
  mkdirSync() {}, chmodSync() {}, fsyncSync() {}, closeSync() {},
  openSync(path) { name(path); const fd = staged.size + 10; staged.set(fd,null); return fd; },
  renameSync(from,to) {
    name(from); name(to);
    const entry = [...staged].at(-1); if (!entry?.[1]) throw new Error('账号保存未完成');
    Native.writePrivate(to,entry[1].toString('base64')); staged.delete(entry[0]);
  },
  unlinkSync: path => Native.deletePrivate(name(path)),
};
