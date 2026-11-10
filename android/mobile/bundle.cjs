const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('../../node_modules/esbuild');
const root = path.resolve(__dirname, '..');
const contract = [...fs.readFileSync(path.join(root, '../preload.js'), 'utf8').matchAll(/^  (\w+):/gm)].map(match => match[1]);
fs.writeFileSync(path.join(root, 'build/contract.json'), JSON.stringify(contract));
const sharedDecrypt = fs.readFileSync(path.join(root,'build/decrypt.js'),'utf8');
const sampleFunction = sharedDecrypt.match(/function decryptSample\(key, nonce, cipher\) \{[\s\S]*?\n\}/)?.[0];
if (!sampleFunction) throw new Error('共享CENC解密结构已变化，请复核安卓适配');
// Keep the desktop MP4 parser; Android's cipher handles the per-block CTR loop.
let mobileDecrypt = sharedDecrypt.replace(sampleFunction,`function decryptSample(key, nonce, cipher) {
  if (!cipher || cipher.length === 0) return Buffer.alloc(0);
  const iv = Buffer.alloc(16);
  nonce.copy(iv, 0, 0, 8);
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}`);
const sampleLoop = mobileDecrypt.indexOf('  for (const ti of trackInfo) {');
const afterSamples = mobileDecrypt.indexOf('  const newMoov = rebuildMoov(',sampleLoop);
if (sampleLoop < 0 || afterSamples < sampleLoop) throw new Error('共享CENC采样循环已变化，请复核安卓适配');
mobileDecrypt = mobileDecrypt.slice(0,sampleLoop) + `  const jobs = [];
  for (const ti of trackInfo) {
    for (let i = 0; i < ti.offs.length; i++) {
      const off = ti.offs[i], size = ti.sizes[i];
      if (!Number.isSafeInteger(off) || !Number.isSafeInteger(size) || off < 0 || size < 0 || off + size > total) throw new Error('视频采样越界');
      if (i < ti.ivs.length) jobs.push([off, size, ti.ivs[i].subarray(0,8).toString('base64')]);
    }
  }
  if (jobs.length) {
    jobs.sort((left,right) => left[0] - right[0]);
    data = Buffer.from(Native.decryptSamples(data.toString('base64'),key.toString('base64'),JSON.stringify(jobs)),'base64');
    if (data.length !== total) throw new Error('视频处理结果不完整');
  }

` + mobileDecrypt.slice(afterSamples);
fs.writeFileSync(path.join(root,'build/mobile-decrypt.js'),mobileDecrypt);
const buildOptions = {
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome100', minify: true,
  inject: [path.join(root, 'web/globals.js')],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
  alias: { 'android-decrypt': path.join(root,'build/mobile-decrypt.js'), 'node:crypto': path.join(root,'web/crypto.js'), 'node:zlib': path.join(root,'web/zlib.js'),
    'node:fs': path.join(root,'mobile/fs.cjs'), 'node:path': path.join(root,'mobile/path.cjs'),
    axios: path.join(root,'mobile/axios.cjs'), electron: path.join(root,'mobile/electron.cjs') },
  plugins: [{ name: 'android-media-boundary', setup(build) {
    build.onResolve({ filter: /[\/]web-media-guard$/ }, () => ({ path: path.join(root, 'mobile/web-media-guard.cjs') }));
  } }],
  legalComments: 'eof', logLevel: 'warning',
};
async function main() {
  const assets = path.join(root, 'build/mobile-assets');
  fs.mkdirSync(assets,{recursive:true});
  await esbuild.build({ ...buildOptions, entryPoints: [path.join(root, 'mobile/main.jsx')], outfile: path.join(assets, 'app.js') });
  fs.copyFileSync(path.join(root,'mobile/index.html'), path.join(assets,'index.html'));
  fs.copyFileSync(path.join(root,'mobile/boot.js'), path.join(assets,'boot.js'));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildOptions };
