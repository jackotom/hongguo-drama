/**
 * setup-winCodeSign.js —— Windows 打包前置环境准备
 *
 * 背景：
 *   electron-builder 打包 Windows 时会下载 winCodeSign-2.6.0.7z，其中包含两个
 *   macOS 用的符号链接（darwin/10.12/lib/libcrypto.dylib、libssl.dylib）。
 *   7-Zip 在 Windows 上创建符号链接需要管理员权限或开启「开发者模式」，
 *   非管理员环境下 7za 会以退出码 2 结束，electron-builder 反复重试后中止打包。
 *
 * 本脚本做的事：
 *   借助 electron-builder 自带的 app-builder 把该压缩包解压到一个**固定目录**，
 *   之后配合 node_modules 里的小补丁（basename 会加入 .dsh-bak）即可跳过重复解压。
 *   注意：想重新生成时，请先把 .dsh-bak 备份改回原名。
 *
 * 用法：
 *   node scripts/setup-winCodeSign.js
 *   然后正常执行：npm run build
 */
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.eb-cache');
const LOCK = path.join(CACHE, 'winCodeSign', 'winCodeSign-2.6.0');
const ARCHIVE = path.join(CACHE, 'winCodeSign-2.6.0.7z');
const APP_BUILDER = path.join(ROOT, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');

const MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
const URL = `${MIRROR}winCodeSign-2.6.0/winCodeSign-2.6.0.7z`;
// Official winCodeSign-2.6.0.7z from electron-userland/electron-builder-binaries.
// SHA-256 matches app-builder-lib; SHA-512 is what app-builder download-artifact checks.
const SHA256 = 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4';
const SHA512 = '6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA==';

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('重定向过多'));
    const client = url.startsWith('http://') ? http : https;
    client.get(url, { headers: { 'User-Agent': 'hongguo-downloader-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function serveFile(file) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': fs.statSync(file).size, 'Content-Type': 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/winCodeSign-2.6.0.7z` });
    });
  });
}

if (process.platform !== 'win32') {
  console.log('非 Windows 平台，无需此步骤。');
  process.exit(0);
}

if (fs.existsSync(path.join(LOCK, 'windows-10', 'x64', 'signtool.exe'))) {
  console.log('winCodeSign 已就绪：' + LOCK);
  process.exit(0);
}

fs.mkdirSync(CACHE, { recursive: true });

console.log('正在下载并校验 winCodeSign…');

download(URL, ARCHIVE).then(() => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(ARCHIVE)).digest('hex');
  if (digest !== SHA256) {
    fs.rmSync(ARCHIVE, { force: true });
    console.error('winCodeSign 压缩包 SHA-256 不匹配，已删除下载文件');
    process.exit(1);
  }
  return serveFile(ARCHIVE);
}).then(({ server, url }) => {
  console.log('正在解压 winCodeSign（跳过 macOS 符号链接的报错不影响 Windows 文件）...');
  // 只把已校验过的本地文件交给 app-builder，避免镜像在校验后被调包。
  const sevenZipDir = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64');
  const env = {
    ...process.env,
    ELECTRON_BUILDER_CACHE: CACHE + path.sep,
    PATH: sevenZipDir + path.delimiter + (process.env.PATH || ''),
  };
  execFile(
    APP_BUILDER,
    ['download-artifact', '--name', 'winCodeSign', '--url', url, '--sha512', SHA512],
    { cwd: ROOT, env },
    (err, stdout, stderr) => {
      server.close();
    // 注意：那两个 macOS 符号链接会让 7za 返回退出码 2，app-builder 因此判定失败
    // 并保留随机命名的临时目录；但 Windows 需要的文件其实已经解压完整。
    // 所以这里不因 err 直接退出，而是按目录内容做校验。
    const parent = path.join(CACHE, 'winCodeSign');
    if (!fs.existsSync(parent)) {
      console.error('解压目录不存在，app-builder 输出：');
      console.error(stderr || stdout || (err && err.message));
      process.exit(1);
    }

    const isUsable = (d) =>
      fs.existsSync(path.join(d, 'windows-10', 'x64', 'signtool.exe')) &&
      fs.existsSync(path.join(d, 'rcedit-x64.exe'));

    // 随机目录名可能是纯数字，也可能是别的；统一按内容筛选
    const dirs = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(parent, d.name));

    const complete = dirs.find(isUsable);
    if (!complete) {
      console.error('未找到解压完整的目录，app-builder 输出：');
      console.error(stderr || stdout || (err && err.message));
      console.error('现有子目录：' + dirs.join(', '));
      process.exit(1);
    }

    fs.rmSync(LOCK, { recursive: true, force: true });
    fs.cpSync(complete, LOCK, { recursive: true });
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    fs.readdirSync(parent)
      .filter((f) => f.endsWith('.7z'))
      .forEach((f) => fs.rmSync(path.join(parent, f), { force: true }));

    console.log('完成：' + LOCK);
    }
  );
}).catch((error) => {
  fs.rmSync(ARCHIVE, { force: true });
  console.error('失败：' + error.message);
  process.exit(1);
});
