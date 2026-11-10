const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const esbuild = require('../../node_modules/esbuild');
const { buildOptions } = require('../mobile/bundle.cjs');

async function bridge(initial, prepareMedia) {
  let saved = JSON.stringify(initial);
  const storage = new Map(), files = new Map([['12345678-1234-1234-1234-123456789abc.mp4', 1024]]);
  const context = {
    console, URL, Blob, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout,
    crypto: crypto.webcrypto, module: { exports: {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key,value) => storage.set(key,value) },
    document: { addEventListener() {}, querySelectorAll: () => [] },
    Native: {
      random: n => crypto.randomBytes(n).toString('base64'),
      readState: () => saved, writeState: value => { saved = value; },
      readMedia: token => { if (!files.has(token)) throw new Error('未登记文件'); return Buffer.alloc(files.get(token)).toString('base64'); },
      mediaSize: token => files.get(token) || 0, deleteMedia: token => files.delete(token), awake() {},
      request: (id, raw) => {
        const options = JSON.parse(raw);
        const html = `window._ROUTER_DATA = ${JSON.stringify({loaderData:{'player_(series_id)/page':{
          isSuccess:true,series_id:'123456789',seriesDetail:{series_id:'123456789',series_name:'剧集',vid_list:['111111','222222']}
        }}})};`;
        const data = new URL(options.url).pathname === '/api/search/result' ? JSON.stringify({searchList:[{series_id:'123456789',series_name:'剧集'}],hasMore:false}) : html;
        setImmediate(() => context.__nativeResponse(id,JSON.stringify({status:200,headers:{},data})));
      },
    },
  };
  context.window = context;
  context.__prepareMedia = prepareMedia;
  const plugins = [...buildOptions.plugins];
  if (prepareMedia) plugins.push({ name: 'controlled-media-result', setup(build) {
    build.onLoad({ filter: /mobile[\/]media\.js$/ }, () => ({ contents: 'export const prepareMedia = (...args) => globalThis.__prepareMedia(...args);', loader: 'js' }));
  } });
  const result = await esbuild.build({ ...buildOptions, plugins, entryPoints:[path.join(__dirname,'../mobile/bridge.js')], format:'cjs', write:false });
  vm.runInNewContext(result.outputFiles[0].text, context);
  return { api:context.module.exports.api, files, state:()=>JSON.parse(saved) };
}

test('共享页面安卓桥：真实资料持久化、历史校验、文件与任务分离、拒绝未接入功能', async () => {
  const initial = { series:[{series_id:'123456789',series_title:'剧集',total:2,episodes:[{vid:'111111',vid_index:1},{vid:'222222',vid_index:2}]}],
    playback:{},settings:{},tasks:[{id:'download1',status:'completed',token:'12345678-1234-1234-1234-123456789abc.mp4',hongguoInfo:{series_id:'123456789',vid:'111111',vid_index:1}}] };
  const { api, files, state } = await bridge(initial);
  assert.equal((await api.getDownloadTasks())[0].title, '剧集 第1集');
  assert.equal((await api.getSeriesEpisodes('123456789')).data.completedCount, 1);
  assert.match((await api.getSeriesEpisodes('123456789')).data.episodes[0].fileUrl,/^https:\/\/app\.local\/media\//,'共享播放器需要与currentSrc一致的完整地址');
  assert.equal((await api.savePlaybackPosition('123456789',1,12,{duration:100})).success,true);
  assert.equal((await api.getWatchHistory()).results[0].currentTime,12);
  assert.equal((await api.savePlaybackPosition('123456789',0,-1)).success,false);
  assert.equal((await api.prepareOnlinePlay({seriesId:'123456789',vid:'999999',vidIndex:1,requestId:'bad'})).success,false);
  assert.equal((await api.downloadSeriesToNas()).code,'ANDROID_UNAVAILABLE');
  assert.equal((await api.saveSettings({root:'/arbitrary'})).success,false);
  assert.equal((await api.saveSettings({download_quality:'bad'})).success,false);
  assert.equal((await api.saveSettings({auto_delete_watched:'false'})).success,false);
  assert.equal((await api.searchSeries('剧集')).success,true);
  const before = (await api.getDownloadTasks()).length;
  assert.equal((await api.hongguoDownloadBatch({seriesId:'123456789',episodes:[{vid:'222222',vid_index:2},{vid:'999999',vid_index:99}]})).success,false);
  assert.equal((await api.getDownloadTasks()).length,before,'分集校验失败不能留下部分下载');
  assert.equal((await api.deleteTaskWithFiles('download1',false)).success,true);
  assert.equal(files.size,1);
  assert.equal((await api.getDownloadTasks()).length,0);
  assert.equal((await api.getSeriesEpisodes('123456789')).data.completedCount,1,'只删任务必须保留剧库视频');
  assert.equal((await api.deleteEpisodeFile('123456789',1)).success,true);
  assert.equal(files.size,0);
  assert.equal((await api.getSeriesEpisodes('123456789')).data.completedCount,0);
  assert.ok(state().series.length);
});

test('媒体请求不带官网Referer，403仅一次切换来源Referer；取消不重试', async () => {
  const result = await esbuild.build({ ...buildOptions, entryPoints:[path.join(__dirname,'../mobile/media.js')], format:'cjs', write:false });
  const sent=[];
  const context={module:{exports:{}},console,URL,AbortController,AbortSignal,setTimeout,clearTimeout,Native:{random:n=>crypto.randomBytes(n).toString('base64'),request(id,raw){
    const request=JSON.parse(raw); sent.push(request);
    setImmediate(()=>context.__nativeResponse(id,JSON.stringify(sent.length===1 ? {error:'403',code:'HTTP_403'} : {status:200,token:'result'})));
  }}};
  vm.runInNewContext(result.outputFiles[0].text,context);
  const {requestMedia}=context.module.exports;
  const source={url:'https://example.qznovelvod.com/valid-signed-media',source:'app',userAgent:'App UA'};
  await requestMedia(source,new AbortController().signal);
  assert.equal(sent.length,2);
  assert.equal(sent[0].headers.Referer,undefined);
  assert.equal(sent[1].headers.Referer,'https://novelquickapp.com/');
  const controller=new AbortController(); controller.abort();
  await assert.rejects(requestMedia(source,controller.signal),error=>error.code==='ERR_CANCELED');
  assert.equal(sent.length,2);
});

test('安卓CENC样本由系统CTR处理，与标准密文逐字节一致', async () => {
  const result=await esbuild.build({...buildOptions,entryPoints:[path.join(__dirname,'../build/mobile-decrypt.js')],format:'cjs',write:false});
  let calls=0;
  const context={module:{exports:{}},Native:{crypt(decrypt,algorithm,key,iv,padding,data){
    assert.equal(algorithm,'aes-128-ctr'); assert.equal(decrypt,true); assert.equal(padding,false); calls++;
    const cipher=crypto.createDecipheriv(algorithm,Buffer.from(key,'base64'),Buffer.from(iv,'base64'));
    return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('base64');
  }}};
  vm.runInNewContext(result.outputFiles[0].text,context);
  for (const length of [0,1,15,16,17,65537]) {
    const key=crypto.randomBytes(16),nonce=crypto.randomBytes(8),plain=crypto.randomBytes(length);
    const cipher=crypto.createCipheriv('aes-128-ctr',key,Buffer.concat([nonce,Buffer.alloc(8)]));
    const encoded=Buffer.concat([cipher.update(plain),cipher.final()]);
    assert.deepEqual(Buffer.from(context.module.exports.decryptSample(key,nonce,encoded)),plain);
  }
  assert.equal(calls,5);
});

test('整集CENC只跨桥一次，输出与共享解析器一致', async () => {
  const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
  const box=(type,...parts)=>{const body=Buffer.concat(parts);return Buffer.concat([u32(body.length+8),Buffer.from(type),body]);};
  const key=crypto.randomBytes(16),ivs=[crypto.randomBytes(8),crypto.randomBytes(8)],sizes=[17,37];
  const encrypted=sizes.map((size,index)=>{
    const cipher=crypto.createCipheriv('aes-128-ctr',key,Buffer.concat([ivs[index],Buffer.alloc(8)]));
    return Buffer.concat([cipher.update(crypto.randomBytes(size)),cipher.final()]);
  });
  const moov=offset=>{const samples=box('stbl',
    box('stsz',u32(0),u32(0),u32(2),...sizes.map(u32)),
    box('stco',u32(0),u32(1),u32(offset)),
    box('stsc',u32(0),u32(1),u32(1),u32(2),u32(1)),
    box('senc',u32(0),u32(2),...ivs));
    return ['minf','mdia','trak','moov'].reduce((data,type)=>box(type,data),samples);
  };
  const ftyp=box('ftyp',Buffer.from('isom'),u32(0));
  const container=Buffer.concat([ftyp,moov(ftyp.length+moov(0).length+8),box('mdat',...encrypted)]);
  let batches=0;
  const Native={crypt(decrypt,algorithm,k,iv,padding,data){
    const cipher=(decrypt?crypto.createDecipheriv:crypto.createCipheriv)(algorithm,Buffer.from(k,'base64'),iv?Buffer.from(iv,'base64'):null);
    cipher.setAutoPadding(padding);
    return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('base64');
  },decryptSamples(raw,k,rawJobs){
    batches++;
    const data=Buffer.from(raw,'base64'),jobs=JSON.parse(rawJobs);
    assert.equal(jobs.length,2);
    for(const [offset,size,iv] of jobs){
      const cipher=crypto.createDecipheriv('aes-128-ctr',Buffer.from(k,'base64'),Buffer.concat([Buffer.from(iv,'base64'),Buffer.alloc(8)]));
      Buffer.concat([cipher.update(data.subarray(offset,offset+size)),cipher.final()]).copy(data,offset);
    }
    return data.toString('base64');
  }};
  const load=async file=>{
    const contents=`export * from ${JSON.stringify(path.join(__dirname,file))}; export { Buffer } from ${JSON.stringify(path.join(__dirname,'../node_modules/buffer/index.js'))};`;
    const result=await esbuild.build({...buildOptions,stdin:{contents,resolveDir:__dirname},format:'cjs',write:false});
    const context={module:{exports:{}},Native};vm.runInNewContext(result.outputFiles[0].text,context);return context.module.exports;
  };
  const original=await load('../build/decrypt.js'),mobile=await load('../build/mobile-decrypt.js');
  const expected=Buffer.from(original.decryptMp4Buffer(original.Buffer.from(container),original.Buffer.from(key)));
  const actual=Buffer.from(mobile.decryptMp4Buffer(mobile.Buffer.from(container),mobile.Buffer.from(key)));
  assert.deepEqual(actual,expected);
  assert.equal(batches,1,'不能为每个采样块单独跨桥');
});

test('下载进度不结束请求，取消后忽略晚到进度', async () => {
  const result=await esbuild.build({...buildOptions,entryPoints:[path.join(__dirname,'../web/transport.js')],format:'cjs',write:false});
  let requestId,settled=false;
  const changes=[],context={module:{exports:{}},Native:{request(id){requestId=id;},cancel(){}}};
  vm.runInNewContext(result.outputFiles[0].text,context);
  const task=context.module.exports.default({url:'https://example.qznovelvod.com/x',onProgress:value=>changes.push(value)}).then(()=>{settled=true;});
  assert.equal(typeof context.__nativeProgress,'function');
  context.__nativeProgress(requestId,128,1024);
  await Promise.resolve();assert.equal(settled,false);assert.equal(changes[0].received,128);
  context.__nativeResponse(requestId,JSON.stringify({status:200,token:'result'}));await task;
  context.__nativeProgress(requestId,1024,1024);assert.equal(changes.length,1);
  const controller=new AbortController();
  const cancelled=context.module.exports.default({url:'https://example.qznovelvod.com/x',signal:controller.signal,onProgress:value=>changes.push(value)});
  controller.abort();await assert.rejects(cancelled,error=>error.code==='ERR_CANCELED');
  context.__nativeProgress(requestId,100,1000);assert.equal(changes.length,1);
});

test('手机播放器常用倍速直接选择，选集复用底部面板；桌面保留原操作', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const result = await esbuild.build({ ...buildOptions, entryPoints: [path.join(__dirname, '../../src/components/PlayerControls.jsx')],
    format: 'cjs', write: false, external: ['react'], loader: { '.css': 'empty' } });
  const context = { module: { exports: {} }, require, window: { electronAPI: { platform: 'android' } } };
  vm.runInNewContext(result.outputFiles[0].text, context);
  const props = { videoRef: { current: null }, stageRef: { current: null }, rate: 1.75,
    episodes: [{ vid_index: 1 }], currentIndex: 1, onOpenEpisodes() {} };
  const mobile = renderToStaticMarkup(React.createElement(context.module.exports.default, props));
  assert.match(mobile, /<select[^>]*aria-label="播放速度"/);
  assert.match(mobile, /value="1.75" selected=""/);
  assert.doesNotMatch(mobile, /增加播放速度/);
  context.window.electronAPI.platform = 'darwin';
  const desktop = renderToStaticMarkup(React.createElement(context.module.exports.default, props));
  assert.match(desktop, /增加播放速度/);
});

test('共享MP4重建：前置索引调整媒体偏移，尾置索引保留原偏移', () => {
  const { decryptMp4Buffer } = require('../../src/native/hongguo.js');
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const box = (type, ...parts) => { const data = Buffer.concat(parts); return Buffer.concat([u32(data.length + 8), Buffer.from(type), data]); };
  const key = crypto.randomBytes(16), iv = crypto.randomBytes(8), plain = crypto.randomBytes(17);
  const cipher = crypto.createCipheriv('aes-128-ctr', key, Buffer.concat([iv, Buffer.alloc(8)]));
  const mdat = box('mdat', cipher.update(plain), cipher.final());
  const ftyp = box('ftyp', Buffer.from('isom'), u32(0)), free = box('free', Buffer.alloc(24));
  const moov = offset => ['minf', 'mdia', 'trak', 'moov'].reduce((data, type) => box(type, data), box('stbl',
    box('stsz', u32(0), u32(0), u32(1), u32(plain.length)), box('stco', u32(0), u32(1), u32(offset)),
    box('stsc', u32(0), u32(1), u32(1), u32(1), u32(1)), box('senc', u32(0), u32(1), iv)));
  for (const tail of [false, true]) {
    const offset = ftyp.length + free.length + 8 + (tail ? 0 : moov(0).length);
    const input = Buffer.concat([ftyp, free, ...(tail ? [mdat, moov(offset)] : [moov(offset), mdat])]);
    const output = decryptMp4Buffer(input, key);
    const chunkOffset = output.readUInt32BE(output.indexOf(Buffer.from('stco')) + 12);
    assert.deepEqual(output.subarray(chunkOffset, chunkOffset + plain.length), plain, tail ? '尾置moov不能挪动前方媒体偏移' : '前置moov缩短后偏移须指向明文');
    if (tail) assert.equal(chunkOffset, offset);
  }
});


test('本机Blob播放只读取登记视频，释放播放地址不删除已下载文件', async () => {
  const token = '12345678-1234-1234-1234-123456789abc.mp4';
  const initial = { series: [], playback: {}, settings: {}, tasks: [], files: [{ seriesId: '123456789', index: 1, token }] };
  const { api, files } = await bridge(initial);
  const result = await api.openLocalPlayback('https://app.local/media/' + token);
  assert.equal(result.success, true);
  assert.match(result.url, /^blob:/);
  const response = await fetch(result.url);
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
  assert.equal((await api.openLocalPlayback('https://example.com/' + token)).success, false);
  assert.equal((await api.openLocalPlayback('https://app.local/media/ffffffff-ffff-ffff-ffff-ffffffffffff.mp4')).success, false);
  await api.releaseLocalPlayback(result.url);
  await assert.rejects(fetch(result.url));
  assert.equal(files.size, 1);
  await api.releaseLocalPlayback(result.url);
});

test('在线播放取消后晚到的Blob必须释放，不留下临时视频', async () => {
  const token = '12345678-1234-1234-1234-123456789abc.mp4';
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const initial = { series: [{ series_id:'123456789', episodes:[{vid:'111111',vid_index:1}] }], playback:{},settings:{},tasks:[] };
  const { api, files } = await bridge(initial, () => ready);
  const pending = api.prepareOnlinePlay({ seriesId:'123456789',vid:'111111',vidIndex:1,requestId:'cancelled' });
  await api.releaseOnlinePlay({ requestId:'cancelled' });
  const url = URL.createObjectURL(new Blob(['real lifecycle test']));
  finish({ token, url, bytes:1024 });
  assert.equal((await pending).cancelled,true);
  await assert.rejects(fetch(url));
  assert.equal(files.size,0);
  assert.equal((await api.onlineCacheStatus()).count,0);
});
