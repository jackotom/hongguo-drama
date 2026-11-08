const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('../../node_modules/esbuild');

function load(entry) {
  const file = path.join(os.tmpdir(), `hongguo-android-${crypto.randomUUID()}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'web', entry)], bundle: true, platform: 'node', format: 'cjs', outfile: file, inject:[path.join(__dirname,'../web/globals.js')], alias:{'node:crypto':path.join(__dirname,'../web/crypto.js'),'node:zlib':path.join(__dirname,'../web/zlib.js'),'axios':path.join(__dirname,'../web/axios.cjs')} });
  try { return require(file); } finally { fs.unlinkSync(file); }
}

global.Native = {
  random: n => crypto.randomBytes(n).toString('base64'),
  digest: (alg, data) => crypto.createHash(alg).update(Buffer.from(data, 'base64')).digest('base64'),
  crypt: (decrypt, alg, key, iv, padding, data) => {
    const c = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)(alg, Buffer.from(key, 'base64'), iv ? Buffer.from(iv, 'base64') : null);
    c.setAutoPadding(padding);
    return Buffer.concat([c.update(Buffer.from(data, 'base64')), c.final()]).toString('base64');
  },
};

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
