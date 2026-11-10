const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('../node_modules/esbuild');
const root = __dirname;
const tv = process.argv.includes('--tv');
if (tv) {
  fs.mkdirSync(path.join(root, 'build/tv/assets'), {recursive:true});
  fs.copyFileSync(path.join(root, 'web/tv-startup.js'), path.join(root, 'build/tv/assets/tv-startup.js'));
}
const desktop = fs.readFileSync(path.join(root, '../src/native/hongguo.js'), 'utf8');
const start = desktop.indexOf('function aes128EcbEncrypt(');
const end = desktop.indexOf('function decryptMp4File(', start);
if (start < 0 || end < start) throw new Error('桌面解密代码边界已变化，请复核移植');
let decrypt = desktop.slice(start, end);
// Reject malformed input before the desktop parser's final box-copy loop.
decrypt = decrypt.replace('const total = data.length;', `const total = data.length;
  if (total < 16 || total > 64 * 1024 * 1024) throw new Error('视频大小不受支持');
  for (let p = 0; p < total;) {
    if (p + 8 > total) throw new Error('视频容器不完整');
    let size = data.readUInt32BE(p);
    if (size === 1) { if (p + 16 > total) throw new Error('视频容器不完整'); size = Number(data.readBigUInt64BE(p + 8)); }
    if (size === 0) size = total - p;
    if (!Number.isSafeInteger(size) || size < 8 || p + size > total) throw new Error('视频容器长度无效');
    p += size;
  }`);
decrypt = decrypt.replace('const n = data.readUInt32BE(stsz.off + 16);', `const n = data.readUInt32BE(stsz.off + 16);
    if (n > 100000 || (!ss && stsz.size < 20 + n * 4)) throw new Error('视频采样表无效');`);
decrypt = decrypt.replace('const nc = data.readUInt32BE(stco.off + 12);', `const nc = data.readUInt32BE(stco.off + 12);
    if (nc > 100000 || stco.size < 16 + nc * 4) throw new Error('视频块表无效');`);
decrypt = decrypt.replace('const ns = data.readUInt32BE(stsc.off + 12);', `const ns = data.readUInt32BE(stsc.off + 12);
    if (ns > 100000 || stsc.size < 16 + ns * 12) throw new Error('视频块映射无效');`);
decrypt = decrypt.replace('const sc = data.readUInt32BE(senc.off + 12);', `const sc = data.readUInt32BE(senc.off + 12);
      if (sc !== n || senc.size < 16 + sc * 8 || (data.readUInt32BE(senc.off + 8) & 0xffffff) !== 0) throw new Error('视频加密格式不受支持');`);
decrypt = decrypt.replace('if (off + sz > total) continue;', "if (off < 0 || off + sz > total) throw new Error('视频采样越界');");
const out = path.join(root, 'build'); fs.mkdirSync(out, {recursive:true});
const generated = path.join(out, 'decrypt.js');
fs.writeFileSync(generated, `import * as crypto from '../web/crypto.js';\n${decrypt}\nexport { decryptMp4Buffer, decryptSample };\n`);
esbuild.buildSync({
  entryPoints: [path.join(root, tv ? 'web/tv.js' : 'web/app.js')], outfile: path.join(root,tv ? 'build/tv/assets/app.js' : 'app/src/main/assets/app.js'),
  bundle: true, format:'iife', platform:'browser', target:'chrome100', minify:true,
  inject:[path.join(root,'web/globals.js')],
  alias: {'android-decrypt':path.join(root,'build/decrypt.js'), 'node:crypto':path.join(root,'web/crypto.js'), 'node:zlib':path.join(root,'web/zlib.js'), 'axios':path.join(root,'web/axios.cjs')},
  legalComments:'eof',
});
