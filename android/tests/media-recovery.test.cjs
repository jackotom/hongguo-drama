const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('../../node_modules/esbuild');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const publicPlayer = require('./public-player-fixture.cjs');

const entry = path.join(__dirname, '../web/media.js');
const compiled = esbuild.build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'cjs', write: false, logLevel: 'silent', plugins: [{ name: 'controlled-source', setup(build) {
  build.onLoad({ filter: /native\/app-source\.js$/ }, () => ({ contents: 'export const fetchAppPlayUrl = (...args) => globalThis.fetchSource(...args);', loader: 'js' }));
  build.onResolve({ filter: /^android-decrypt$/ }, () => ({path:'decoder',namespace:'test'}));
  build.onLoad({ filter: /.*/, namespace:'test' }, () => ({ contents: 'export const decryptMp4Buffer = () => { throw new Error("unexpected decryption"); };', loader: 'js' }));
} }] });
const source = { variants: ['first', 'second', 'third', 'fourth', 'fifth'].map(host => ({ url: `https://${host}.qznovelvod.com/fixture`, source: 'app', codec: 'h264', quality: '1080p' })) };
const failedRegistration = reason => Object.assign(new Error('registration failed'), { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure: reason });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function harness(fetchSource, respond, configure = () => {}) {
  const requests = [], deleted = [], revoked = [], cancelled = [], timers = new Map();
  class MediaURL extends URL {}
  MediaURL.createObjectURL = () => "blob:prepared"; MediaURL.revokeObjectURL = url => revoked.push(url);
  let timer = 0;
  const context = {
    module: { exports: {} }, URL:MediaURL, Blob, Date, console: { info() {} }, fetchSource,
    setTimeout(fn, ms) { const id = ++timer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    Native: { mediaSize: () => 16, deleteMedia(token) { deleted.push(token); }, readMedia: () => Buffer.alloc(16).toString("base64"), cancel(id) { cancelled.push(id); }, request(id, raw) {
      const options = JSON.parse(raw); requests.push(options);
      queueMicrotask(() => { const response=respond(requests.length,options); if(response!==undefined)context.__nativeResponse(id,JSON.stringify(response)); });
    } },
  };
  configure(context);
  vm.runInNewContext((await compiled).outputFiles[0].text, context);
  return { prepare: context.module.exports.prepareMedia, prepareTV: context.module.exports.prepareTvMedia, context, requests, deleted, revoked, cancelled, timers, runTimer() {
    const [id, task] = timers.entries().next().value; timers.delete(id); task.fn();
  } };
}
const success = () => ({ status: 200, token: '12345678-1234-1234-1234-123456789abc.mp4', bytes: 16 });

test('Android media recovery remains bounded and cancellable', async t => {
  await t.test('rejected redirect uses the next supplied candidate at the same quality', async () => {
    let sourceCalls = 0;
    const h = await harness(async () => { sourceCalls++; return source; }, n => n === 1 ? { error: 'redirect rejected', code: 'MEDIA_REDIRECT_REJECTED' } : success());
    const result = await h.prepare('111111', '1080p', new AbortController().signal);
    assert.equal(result.quality, '1080p'); assert.equal(h.requests.length, 2); assert.equal(sourceCalls, 1);
    assert.equal(new URL(h.requests[1].url).hostname, 'second.qznovelvod.com');
  });
  await t.test('redirect rejection stops at four candidates and fails safely', async () => {
    const h = await harness(async () => source, () => ({ error: 'redirect rejected', code: 'MEDIA_REDIRECT_REJECTED' }));
    await assert.rejects(h.prepare('111111', '1080p', new AbortController().signal), error => error.code === 'MEDIA_REDIRECT_REJECTED');
    assert.equal(h.requests.length, 4);
  });
  await t.test('cancel stops before a second candidate; original URL and business refusals do not rotate', async () => {
    const controller = new AbortController();
    const h = await harness(async () => source, () => { controller.abort(); return { error: 'redirect rejected', code: 'MEDIA_REDIRECT_REJECTED' }; });
    await assert.rejects(h.prepare('111111', '1080p', controller.signal), error => error.code === 'ERR_CANCELED');
    assert.equal(h.requests.length, 1);
    for (const code of ['ERR_NETWORK', 'SECURITY_BLOCKED', 'BUSINESS_REJECTED']) {
      const other = await harness(async () => source, () => ({ error: 'rejected', code }));
      await assert.rejects(other.prepare('111111', '1080p', new AbortController().signal), error => error.code === code);
      assert.equal(other.requests.length, 1);
    }
  });
  await t.test('transient registration retries only once after the existing ten-second cooldown', async () => {
    for (const reason of ['TIMEOUT', 'NETWORK_ERROR']) {
      let calls = 0;
      const h = await harness(async () => { if (++calls === 1) throw failedRegistration(reason); return source; }, success);
      const phases = [];
      const pending = h.prepare('111111', '1080p', new AbortController().signal, (phase, stats) => phases.push({ phase, ...stats }));
      pending.catch(() => {}); await flush();
      assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 10000); assert.equal(calls, 1);
      assert.deepEqual(phases, [{ phase: 'registration-retry', retryAfterMs: 10000 }]);
      h.runTimer(); await pending;
      assert.equal(calls, 2); assert.equal(h.timers.size, 0);
      assert.equal(phases[1].phase, 'preparing');
    }
    let calls = 0;
    const h = await harness(async () => { calls++; throw failedRegistration('TIMEOUT'); }, success);
    const pending = h.prepare('111111', '1080p', new AbortController().signal);
    pending.catch(() => {}); await flush(); assert.equal(h.timers.size, 1);
    h.runTimer(); await assert.rejects(pending, error => error.registrationFailure === 'TIMEOUT');
    assert.equal(calls, 2); assert.equal(h.timers.size, 0);
  });
  await t.test('cooldown is cancellable and explicit registration refusals never retry', async () => {
    let calls = 0;
    const h = await harness(async () => { calls++; throw failedRegistration('NETWORK_ERROR'); }, success);
    const controller = new AbortController(), pending = h.prepare('111111', '1080p', controller.signal);
    pending.catch(() => {}); await flush(); assert.equal(h.timers.size, 1);
    controller.abort(); await assert.rejects(pending, error => error.code === 'ERR_CANCELED');
    assert.equal(calls, 1); assert.equal(h.timers.size, 0);
    for (const reason of ['BUSINESS_REJECTED', 'SECURITY_BLOCKED', 'INVALID_RESPONSE', 'EMPTY_RESPONSE', 'HTTP_403', 'UNKNOWN']) {
      let attempts = 0;
      const other = await harness(async () => { attempts++; throw failedRegistration(reason); }, success);
      await assert.rejects(other.prepare('111111', '1080p', new AbortController().signal), error => error.registrationFailure === reason);
      assert.equal(attempts, 1); assert.equal(other.timers.size, 0);
    }
  });
  await t.test('native marks only caught media redirects, preserving the original URL guard', () => {
    const native = fs.readFileSync(path.join(__dirname, '../app/src/main/java/io/github/hongguo/personal/MainActivity.java'), 'utf8');
    const request = native.slice(native.indexOf('@JavascriptInterface public void request('));
    assert(/catch \(Exception redirectError\) \{\s*mediaRedirectRejected = true;/.test(request), 'mark the media redirect catch only');
    assert(/mediaRedirectRejected && \(getPackageName\(\)\.equals\("io\.github\.hongguo\.personal"\) \|\| isTv\(\)\) \? "MEDIA_REDIRECT_REJECTED"/.test(request), 'return the same caught-redirect code for phone and TV without weakening the URL guard');
    assert(request.indexOf('URL url = checked(') < request.indexOf('mediaRedirectRejected = true;'));
    assert(request.indexOf('if (status >= 300 && status <= 399 && isMedia)') < request.indexOf('mediaRedirectRejected = true;'));
    const expression=request.match(/\.put\("code",(mediaRedirectRejected[^\n]+)\)\);/)[1];
    for(const [name,rejected,expected] of [['io.github.hongguo.tv',true,'MEDIA_REDIRECT_REJECTED'],['io.github.hongguo.personal',true,'MEDIA_REDIRECT_REJECTED'],['other',true,'ERR_NETWORK'],['io.github.hongguo.tv',false,'ERR_NETWORK']]) {
      assert.equal(vm.runInNewContext(expression,{mediaRedirectRejected:rejected,getPackageName:()=>({equals:value=>value===name}),isTv:()=>name==='io.github.hongguo.tv',timed:false}),expected);
    }
  });
});

test('TV source failure restores only the strict public full-episode path through shared preparation',async()=>{
  const timeout=()=>{throw Object.assign(new Error('model timeout'),{code:'ETIMEDOUT'});};
  const h=await harness(timeout,(_n,options)=>options.media?success():{status:200,headers:{},data:publicPlayer()});
  assert.equal(typeof h.prepareTV,'function','TV must restore its old strict public fallback');
  const output=await h.prepareTV('123','111',new AbortController().signal);
  assert.equal(output.url,'blob:prepared');assert.equal(output.token,success().token);assert.equal(h.requests.length,2);
  assert.equal(h.requests[0].url,'https://hongguoduanju.com/player/123/111');
  assert.equal(h.requests[1].url,'https://hongguoduanju.com/video/public/111/full.mp4');
  assert.equal(h.requests[1].headers.Referer,'https://hongguoduanju.com/');assert.equal(h.deleted.length,0);
  const phone=await harness(timeout,success);
  await assert.rejects(phone.prepare('111','auto',new AbortController().signal),e=>e.code==='ETIMEDOUT');assert.equal(phone.requests.length,0);
});

test('TV public fallback excludes refusal/cancellation and does not run after media download failure',async()=>{
  for(const code of ['BUSINESS_REJECTED','DEVICE_REGISTRATION_FAILED','ERR_CANCELED']){
    const h=await harness(async()=>{throw Object.assign(new Error('blocked'),{code,registrationFailure:'UNKNOWN'});},success);
    assert.equal(typeof h.prepareTV,'function');
    await assert.rejects(h.prepareTV('123','111',new AbortController().signal),e=>e.code===code);assert.equal(h.requests.length,0);
  }
  const aborted=new AbortController();aborted.abort();
  const cancelled=await harness(async()=>source,success);await assert.rejects(cancelled.prepareTV('123','111',aborted.signal),e=>e.code==='ERR_CANCELED');assert.equal(cancelled.requests.length,0);
  const download=await harness(async()=>source,()=>({error:'gone',code:'HTTP_404'}));
  await assert.rejects(download.prepareTV('123','111',new AbortController().signal),e=>e.code==='HTTP_404');
  assert.equal(download.requests.length,4);assert(download.requests.every(r=>r.media));
});

test('TV public fallback retains the actual identity/preview/HTTPS/official-full-video parser',async()=>{
  for(const html of [publicPlayer('111',{protectedPlayback:true}),publicPlayer('111',{series_id:'999'}),publicPlayer('222'),
    publicPlayer('111',{publicVideoSeo:{available:false,itemId:'111',seriesId:'123'}}),
    publicPlayer('111',{}, {contentUrl:'http://hongguoduanju.com/video/public/111/full.mp4'}),
    publicPlayer('111',{}, {contentUrl:'https://invalid.example/video/public/111/full.mp4'}),
    publicPlayer('111',{}, {contentUrl:'https://hongguoduanju.com/preview/111.mp4'}),
    publicPlayer('111',{}, {url:'https://hongguoduanju.com/player/123/222'})]){
    const h=await harness(async()=>{throw Object.assign(new Error('source timeout'),{code:'ETIMEDOUT'});},()=>({status:200,headers:{},data:html}));
    assert.equal(typeof h.prepareTV,'function');
    await assert.rejects(h.prepareTV('123','111',new AbortController().signal));assert.equal(h.requests.length,1);assert.equal(h.deleted.length,0);
  }
});


test('shared preparation owns exactly one token/Blob and releases failures or cancellation', async () => {
  const controller = new AbortController();
  let passedSignal;
  const h = await harness(async (_vid, options) => { passedSignal = options.signal; return source; }, success);
  const media = await h.prepare('111111','1080p',controller.signal,undefined,true);
  assert.equal(passedSignal,controller.signal); assert.equal(media.url,'blob:prepared');
  assert.equal(media.bytes,16); assert.equal(h.requests.length,1); assert.equal(h.deleted.length,0);
  const oversized = await harness(async () => source,success,c => { c.Native.mediaSize = () => 64*1024*1024+1; });
  await assert.rejects(oversized.prepare('111111','1080p',new AbortController().signal),/64MB/);
  assert.deepEqual(oversized.deleted,[success().token]);
  const aborted = new AbortController();
  const late = await harness(async () => source,success,c => {
    c.URL.createObjectURL = () => { aborted.abort(); return 'blob:cancelled'; };
  });
  await assert.rejects(late.prepare('111111','1080p',aborted.signal,undefined,true), e => e.code === 'ERR_CANCELED');
  assert.deepEqual(late.deleted,[success().token]); assert.deepEqual(late.revoked,['blob:cancelled']);
  const readError = await harness(async () => source,success,c => { c.Native.readMedia = () => { throw Error('read failed'); }; });
  await assert.rejects(readError.prepare('111111','1080p',new AbortController().signal,undefined,true),/read failed/);
  assert.deepEqual(readError.deleted,[success().token]);
});

test('shared Android consumer cancels the delivered G2 registration/model/fallback transport', async t => {
  const root = path.resolve(__dirname,'..');
  const built = await esbuild.build({entryPoints:[path.join(root,'web/media.js')],bundle:true,format:'cjs',platform:'browser',write:false,logLevel:'silent',
    inject:[path.join(root,'web/globals.js')],alias:{'node:crypto':path.join(root,'web/crypto.js'),'node:zlib':path.join(root,'web/zlib.js'),'node:timers/promises':path.join(root,'web/timers.cjs'),axios:path.join(root,'web/axios.cjs')},
    plugins:[{name:'unused-decoder',setup(build){
      build.onResolve({filter:/^android-decrypt$/},()=>({path:'decoder',namespace:'unused'}));
      build.onLoad({filter:/.*/,namespace:'unused'},()=>({contents:'export function decryptMp4Buffer(){throw Error("decoder must not run");}'}));
    }}]});
  for (const phase of ['registration','model','fallback']) await t.test(phase,async () => {
    const sent=[],cancelled=[]; let arrived,held;
    const reached = new Promise(resolve => { arrived=resolve; });
    const context={module:{exports:{}},URL,Blob,AbortController,AbortSignal,setTimeout,clearTimeout,console:{info(){}},Native:{
      random:n=>crypto.randomBytes(n).toString('base64'),
      digest:(a,d)=>crypto.createHash(a).update(Buffer.from(d,'base64')).digest('base64'),
      gzip:d=>zlib.gzipSync(Buffer.from(d,'base64')).toString('base64'),
      crypt(decrypt,alg,key,iv,padding,data){const c=(decrypt?crypto.createDecipheriv:crypto.createCipheriv)(alg,Buffer.from(key,'base64'),iv?Buffer.from(iv,'base64'):null);c.setAutoPadding(padding);return Buffer.concat([c.update(Buffer.from(data,'base64')),c.final()]).toString('base64');},
      cancel:id=>cancelled.push(id),
      request(id,raw){
        const options=JSON.parse(raw),url=new URL(options.url); sent.push({id,path:url.pathname});
        const registration=url.pathname.includes('device_register'),fallback=url.pathname==='/fallback';
        if ((phase==='registration'&&registration)||(phase==='model'&&!registration)||(phase==='fallback'&&fallback)) { held=id;arrived();return; }
        const data=registration?{device_id_str:'1000000000000001',install_id_str:'1000000000000002'}:{code:0,data:{'111111':{video_model:{fallback_api:'https://api5-normal-sinfonlineb.fqnovel.com/fallback'}}}};
        queueMicrotask(()=>context.__nativeResponse(id,JSON.stringify({status:200,headers:{},data:JSON.stringify(data)})));
      },
    }};
    vm.runInNewContext(built.outputFiles[0].text,context);
    const controller=new AbortController();
    const pending=context.module.exports.prepareMedia('111111','auto',controller.signal);
    pending.catch(()=>{}); await Promise.race([reached,pending]); assert.notEqual(held,undefined); const before=sent.length; controller.abort();
    await assert.rejects(pending,e=>e.code==='ERR_CANCELED');
    assert.deepEqual(cancelled,[held]);
    context.__nativeResponse(held,JSON.stringify({status:200,headers:{},data:'{}'}));
    await flush(); assert.equal(sent.length,before,'no fallback or retry after cancellation');
  });
});
