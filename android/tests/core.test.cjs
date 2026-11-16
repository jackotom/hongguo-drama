const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('../../node_modules/esbuild');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

function load(entry) {
  const file = path.join(os.tmpdir(), `hongguo-android-${crypto.randomUUID()}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'web', entry)], nodePaths: require.resolve.paths('buffer/'), bundle: true, platform: 'node', format: 'cjs', outfile: file, inject:[path.join(__dirname,'../web/globals.js')], alias:{'node:crypto':path.join(__dirname,'../web/crypto.js'),'node:zlib':path.join(__dirname,'../web/zlib.js'),'axios':path.join(__dirname,'../web/axios.cjs')} });
  try { return require(file); } finally { fs.unlinkSync(file); }
}

global.Native = {
  gzip: data => zlib.gzipSync(Buffer.from(data, 'base64')).toString('base64'),
  gunzip: (data, maxOutputLength) => zlib.gunzipSync(Buffer.from(data, 'base64'), { maxOutputLength }).toString('base64'),
  random: n => crypto.randomBytes(n).toString('base64'),
  digest: (alg, data) => crypto.createHash(alg).update(Buffer.from(data, 'base64')).digest('base64'),
  crypt: (decrypt, alg, key, iv, padding, data) => {
    const c = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)(alg, Buffer.from(key, 'base64'), iv ? Buffer.from(iv, 'base64') : null);
    c.setAutoPadding(padding);
    return Buffer.concat([c.update(Buffer.from(data, 'base64')), c.final()]).toString('base64');
  },
};

test('Android gzip bridge exports bounded gunzipSync with Buffer semantics', () => {
  const mobile = load('zlib.js');
  assert.equal(typeof mobile.gunzipSync, 'function', 'shared playback requires the gunzipSync export');
  const limit = 2 * 1024 * 1024, plain = Buffer.from('中文\0gzip\xff'), packed = zlib.gzipSync(plain);
  const calls = [], original = Native.gunzip;
  Native.gunzip = (data, maximum) => { calls.push(maximum); return original(data, maximum); };
  try {
    const output = mobile.gunzipSync(packed);
    assert.ok(output.constructor.isBuffer(output));
    assert.deepEqual(Buffer.from(output), plain); assert.equal(calls.at(-1), limit);
    assert.deepEqual(Buffer.from(mobile.gunzipSync(packed, { maxOutputLength: plain.length })), plain);
    assert.equal(calls.at(-1), plain.length);
    assert.deepEqual(Buffer.from(mobile.gunzipSync(mobile.gzipSync(plain))), plain);
    assert.equal(mobile.gunzipSync(zlib.gzipSync(Buffer.alloc(0)), { maxOutputLength: 1 }).length, 0);
    const before = calls.length;
    for (const maximum of [0, -1, 1.5, NaN, Infinity, '8', limit + 1]) {
      assert.throws(() => mobile.gunzipSync(packed, { maxOutputLength: maximum }), /limit/);
    }
    assert.throws(() => mobile.gunzipSync(Buffer.alloc(limit + 1)), /limit/);
    assert.equal(calls.length, before, 'invalid bounds never enter the Native bridge');
    const corrupt = Buffer.from(packed); corrupt[corrupt.length - 8] ^= 1;
    for (const bytes of [Buffer.from('not gzip'), packed.subarray(0, 10), corrupt]) assert.throws(() => mobile.gunzipSync(bytes));
    assert.throws(() => mobile.gunzipSync(packed, { maxOutputLength: plain.length - 1 }));
    assert.equal(mobile.gunzipSync(zlib.gzipSync(Buffer.alloc(limit))).length, limit);
    assert.throws(() => mobile.gunzipSync(zlib.gzipSync(Buffer.alloc(limit + 1))));
  } finally { Native.gunzip = original; }
});

test('Android gzip bridge Java method compiles and enforces bounds and closed-business checks', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/src/main/java/io/github/hongguo/personal/MainActivity.java'), 'utf8');
  const start = source.indexOf('@JavascriptInterface public String gunzip(');
  assert.ok(start >= 0);
  const method = source.slice(start, source.indexOf('\n        }', start) + 10);
  assert.match(method, /try \(ByteArrayInputStream/);
  assert.match(method, /GZIPInputStream gzip/);
  assert.match(method, /ByteArrayOutputStream out/);
  const fixture = `import java.io.*; import java.util.*; import java.util.zip.*;
public class GunzipHarness {
  @interface JavascriptInterface {}
  static class Base64 {
    static final int DEFAULT=0, NO_WRAP=2;
    static byte[] decode(String s,int flags) { return java.util.Base64.getDecoder().decode(s); }
    static String encodeToString(byte[] b,int flags) { return java.util.Base64.getEncoder().encodeToString(b); }
  }
  boolean closed; int checks, closeAt=Integer.MAX_VALUE;
  void requireBusinessOpen() { if (++checks >= closeAt || closed) throw new IllegalStateException("closed"); }
  ${method}
  interface Action { void run() throws Exception; }
  static void rejects(Class<? extends Throwable> type,Action action) throws Exception {
    try { action.run(); } catch (Exception error) { if (type.isInstance(error)) return; throw error; }
    throw new AssertionError("expected rejection");
  }
  static String pack(byte[] bytes) throws Exception {
    ByteArrayOutputStream out=new ByteArrayOutputStream();
    try (GZIPOutputStream gzip=new GZIPOutputStream(out)) { gzip.write(bytes); }
    return Base64.encodeToString(out.toByteArray(),0);
  }
  static void check(boolean passed) { if (!passed) throw new AssertionError(); }
  public static void main(String[] args) throws Exception {
    GunzipHarness bridge=new GunzipHarness(); final int limit=2*1024*1024;
    byte[] plain=new byte[]{0,1,-1,3}; String packed=pack(plain);
    check(Arrays.equals(Base64.decode(bridge.gunzip(packed,4),0),plain));
    check(Base64.decode(bridge.gunzip(pack(new byte[0]),1),0).length==0);
    for (int maximum:new int[]{0,-1,limit+1}) rejects(IllegalArgumentException.class,()->bridge.gunzip(packed,maximum));
    rejects(IOException.class,()->bridge.gunzip(packed,3));
    rejects(IOException.class,()->bridge.gunzip(Base64.encodeToString(new byte[limit+1],0),limit));
    rejects(IOException.class,()->bridge.gunzip(Base64.encodeToString(new byte[limit+4],0),limit));
    rejects(IOException.class,()->bridge.gunzip(Base64.encodeToString(new byte[10],0),limit));
    byte[] raw=Base64.decode(packed,0), corrupt=raw.clone(); corrupt[corrupt.length-8]^=1;
    rejects(IOException.class,()->bridge.gunzip(Base64.encodeToString(corrupt,0),limit));
    rejects(IOException.class,()->bridge.gunzip(Base64.encodeToString(Arrays.copyOf(raw,raw.length-1),0),limit));
    check(Base64.decode(bridge.gunzip(pack(new byte[limit]),limit),0).length==limit);
    String bomb=pack(new byte[limit+1]); rejects(IOException.class,()->bridge.gunzip(bomb,limit));
    bridge.closed=true; rejects(IllegalStateException.class,()->bridge.gunzip(null,0)); bridge.closed=false;
    bridge.closeAt=bridge.checks+3;
    rejects(IllegalStateException.class,()->bridge.gunzip(pack(new byte[32768]),limit));
    System.out.print("PASS exact gunzip method: bounds, CRC, truncation and business closure");
  }
}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-gunzip-'));
  const java = process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
  try {
    const file = path.join(dir, 'GunzipHarness.java'); fs.writeFileSync(file, fixture);
    for (const [binary, args] of [['javac', ['--release', '8', '-encoding', 'UTF-8', '-d', dir, file]],
      ['java', ['-cp', dir, 'GunzipHarness']]]) {
      const result = spawnSync(path.join(java, 'bin', binary), args, { encoding: 'utf8', timeout: 20000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${binary}: ${result.stdout}${result.stderr}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Android密码桥与Node哈希、AES分段结果一致', () => {
  const mobile = load('crypto.js');
  for (const alg of ['md5', 'sha512']) {
    assert.equal(mobile.createHash(alg).update('中文').update(Buffer.from([0, 255])).digest('hex'), crypto.createHash(alg).update('中文').update(Buffer.from([0, 255])).digest('hex'));
  }
  const key = crypto.randomBytes(16), iv = crypto.randomBytes(16);
  for (const alg of ['aes-128-ecb', 'aes-128-cbc']) {
    const input = crypto.randomBytes(32), nonce = alg.endsWith('ecb') ? null : iv;
    const native = crypto.createCipheriv(alg, key, nonce); native.setAutoPadding(false);
    const expected = Buffer.concat([native.update(input), native.final()]);
    const cipher = mobile.createCipheriv(alg, key, nonce); cipher.setAutoPadding(false);
    const actual = Buffer.concat([cipher.update(input.subarray(0, 11)), cipher.update(input.subarray(11)), cipher.final()]);
    assert.deepEqual(actual, expected);
    const decipher = mobile.createDecipheriv(alg, key, nonce); decipher.setAutoPadding(false);
    assert.deepEqual(Buffer.concat([decipher.update(actual), decipher.final()]), input);
  }
  assert.match(mobile.randomUUID(), /^[a-f0-9-]{36}$/);
  assert.equal(mobile.randomBytes(12).length, 12);
});

test('网页数据不执行脚本，精确绑定分集，拒绝预览和无效视频地址', () => {
  const web = load('public.js');
  assert.deepEqual(web.readRouter('xx window._ROUTER_DATA = {"loaderData":{"x":{"a":"}\\\"{"}}}; alert(1)'), {loaderData: {x: {a: '}"{'}}});
  assert.throws(() => web.readRouter('window._ROUTER_DATA = {"x":1'), /数据/);
  const detail = {series_id:'123456', series_name:'测试', vid_list:['111','222']};
  const data = {isSuccess:true, series_id:'123456', vid:'111', seriesDetail:detail, publicVideoSeo:{available:true,itemId:'111',seriesId:'123456'}};
  const html = d => `window._ROUTER_DATA = ${JSON.stringify({loaderData:{'player_(series_id)/(vid)/page':d}})};<script type="application/ld+json">${JSON.stringify({'@type':'VideoObject',url:'https://hongguoduanju.com/player/123456/111',contentUrl:'https://hongguoduanju.com/video/public/111/full.mp4'})}</script>`;
  assert.equal(web.parseDetail(html(data),'123456').episodes.length,2);
  assert.throws(() => web.parseDetail(html(data),'999'), /身份/);
  assert.equal(web.parsePublicPlay(html(data),'123456','111').url,'https://hongguoduanju.com/video/public/111/full.mp4');
  assert.throws(() => web.parsePublicPlay(html({...data,protectedPlayback:true}),'123456','111'), /预览/);
  assert.throws(() => web.parsePublicPlay(html(data),'123456','222'), /分集/);
  assert.throws(() => web.parseDetail(html({...data,seriesDetail:{...detail,vid_list:['111','111']}}),'123456'), /分集/);
});

test('HTTP桥正确传输二进制且取消后不会接受晚到结果', async () => {
  const transport = load('transport.js');
  let sent;
  Native.request = (id, raw) => {
    sent = JSON.parse(raw);
    setImmediate(() => global.__nativeResponse(id, JSON.stringify({status:200,headers:{},data:'{"ok":true}'})));
  };
  const res = await transport.default({url:'https://api5-normal-sinfonlineb.fqnovel.com/x',method:'POST',data:Buffer.from([0,1,255]),signal:new AbortController().signal});
  assert.equal(sent.body,'AAH/'); assert.equal(res.status,200);
  const controller = new AbortController();
  Native.request = () => {};
  const pending = transport.default({url:'https://api5-normal-sinfonlineb.fqnovel.com/x',signal:controller.signal});
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ERR_CANCELED');
});

test('复用的CENC解密与标准AES-CTR一致，畸形容器立即拒绝', () => {
  const decoder = load('../build/decrypt.js');
  const key = crypto.randomBytes(16), nonce = crypto.randomBytes(8), input = crypto.randomBytes(61);
  const standard = crypto.createCipheriv('aes-128-ctr',key,Buffer.concat([nonce,Buffer.alloc(8)]));
  const encoded = Buffer.concat([standard.update(input),standard.final()]);
  assert.deepEqual(Buffer.from(decoder.decryptSample(key,nonce,encoded)),input);
  assert.throws(() => decoder.decryptMp4Buffer(Buffer.alloc(4),key), /大小/);
  const bad = Buffer.alloc(16); bad.writeUInt32BE(100,0);
  assert.throws(() => decoder.decryptMp4Buffer(bad,key), /长度/);
});

test('桌面CommonJS接口经过安卓适配后真正调用原生网络', async () => {
  let calls = 0;
  Native.request = (id, raw) => {
    calls++;
    assert.equal(JSON.parse(raw).method,'GET');
    setImmediate(() => global.__nativeResponse(id,JSON.stringify({status:200,headers:{},data:'{"ok":true}'})));
  };
  const requestJson = load('../tests/axios-entry.cjs');
  const result = await requestJson('https://api5-normal-sinfonlineb.fqnovel.com/reading/test',{method:'GET'},Date.now()+1000,new AbortController().signal);
  assert.deepEqual(result,{ok:true});
  assert.equal(calls,1);
});

test('官网仅跟随同站HTTPS跳转，拒绝外站与循环', async () => {
  const web = load('public.js');
  const paths = [];
  Native.request = (id, raw) => {
    const url = new URL(JSON.parse(raw).url); paths.push(url.pathname + url.search);
    const result = url.search ? {status:301,headers:{location:'/category/real-drama'},data:''} : {status:200,headers:{},data:'完整目录'};
    setImmediate(() => global.__nativeResponse(id,JSON.stringify(result)));
  };
  assert.equal(await web.website('/category/real-drama?page=1'),'完整目录');
  assert.deepEqual(paths,['/category/real-drama?page=1','/category/real-drama']);
  Native.request = (id) => setImmediate(() => global.__nativeResponse(id,JSON.stringify({status:302,headers:{location:'https://example.com/'},data:''})));
  await assert.rejects(web.website('/category/real-drama'),/跳转/);
  Native.request = (id) => setImmediate(() => global.__nativeResponse(id,JSON.stringify({status:301,headers:{location:'/category/real-drama'},data:''})));
  await assert.rejects(web.website('/category/real-drama'),/跳转/);
});
