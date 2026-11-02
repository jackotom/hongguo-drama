const http = require('node:http');
const { isIPv4 } = require('node:net');
const { networkInterfaces } = require('node:os');
const dgram = require('node:dgram');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const privateIp = ip => isIPv4(ip) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const xmlEscape = text => String(text).replace(/[<>&"']/g, char => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]));
const xmlText = (xml, tag) => (xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i'))?.[1] || '').trim().replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
function checkedUrl(value, host) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !privateIp(url.hostname) || (host && url.hostname !== host) || url.username || url.password) throw new Error('电视设备地址无效');
  return url;
}
function request(url, options = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { ...options, timeout: 4000, agent: false }, res => {
      const localAddress = req.socket.localAddress;
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) req.destroy(new Error('设备响应过大')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => res.statusCode === 200 ? resolve({ text: Buffer.concat(chunks).toString(), localAddress }) : reject(new Error(`电视请求失败（HTTP ${res.statusCode}）`)));
    });
    req.on('timeout', () => req.destroy(new Error('电视连接超时')));
    req.on('error', reject); req.end(body);
  });
}
function parseDevice(xml, location, localAddress) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('设备描述格式不支持');
  const url = checkedUrl(location);
  const service = [...xml.matchAll(/<(?:[\w-]+:)?service\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?service>/gi)].map(match => match[1]).find(part => /^urn:schemas-upnp-org:service:AVTransport:\d+$/.test(xmlText(part,'serviceType')));
  if (!service) throw new Error('该设备不支持视频投屏');
  const base = xmlText(xml, 'URLBase') ? checkedUrl(xmlText(xml, 'URLBase'), url.hostname).href : location;
  return { id: location, name: xmlText(xml,'friendlyName').slice(0,100) || url.hostname, host: url.hostname,
    localAddress, serviceType: xmlText(service,'serviceType'), controlUrl: checkedUrl(new URL(xmlText(service,'controlURL'), base).href, url.hostname).href };
}
async function discover() {
  const socket = dgram.createSocket('udp4');
  const locations = new Map();
  await new Promise((resolve,reject) => { socket.once('error',reject); socket.bind(0, resolve); });
  try {
    socket.on('message', (message, remote) => {
      if (locations.size >= 32 || !privateIp(remote.address)) return;
      const location = message.toString().match(/^location:\s*(.+)$/im)?.[1]?.trim();
      try { const url = checkedUrl(location, remote.address); locations.set(url.href, true); } catch {}
    });
    const packet = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n');
    const addresses = Object.values(networkInterfaces()).flat().filter(item => !item.internal && privateIp(item.address)).map(item => item.address);
    if (!addresses.length) throw new Error('没有可用的局域网连接');
    for (const address of addresses) {
      socket.setMulticastInterface(address);
      await new Promise((resolve,reject) => socket.send(packet,1900,'239.255.255.250',error => error ? reject(error) : resolve()));
    }
    await new Promise(resolve => setTimeout(resolve,3000));
  } finally { socket.close(); }
  return (await Promise.allSettled([...locations.keys()].map(async url => { const response = await request(url); return parseDevice(response.text,url,response.localAddress); }))).filter(result => result.status === 'fulfilled').map(result => result.value);
}
async function soap(device, action, values = {}, signal) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${device.serviceType}"><InstanceID>0</InstanceID>${Object.entries(values).map(([key,value])=>`<${key}>${xmlEscape(value)}</${key}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  await request(device.controlUrl,{method:'POST',signal,headers:{'Content-Type':'text/xml; charset="utf-8"',SOAPAction:`"${device.serviceType}#${action}"`,'Content-Length':Buffer.byteLength(body)}},body);
}
function rangeFor(value, size) {
  if (!value) return { start:0, end:size-1, partial:false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0,size-Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size-1,Number(match[2])) : size-1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size ? {start,end,partial:true} : null;
}
function createCastingService({ discoverDevices = discover, sendAction = soap } = {}) {
  let devices = new Map(), current = null, scanning = null, startController = null, controlJob = null;
  const dispose = context => {
    if (!context || context.disposed) return;
    context.disposed = true;
    context.controller.abort();
    for (const stream of context.streams) stream.destroy();
    context.server.close();
    context.server.closeAllConnections();
    context.release?.();
  };
  const close = () => {
    startController?.abort();
    const previous = current; current = null;
    dispose(previous);
  };
  return {
    async discover() {
      scanning ||= discoverDevices().then(list => { devices = new Map(list.map(item=>[item.id,item])); return list.map(({id,name})=>({id,name})); }).finally(()=>{scanning=null;});
      return scanning;
    },
    async start(id, media) {
      if (startController || controlJob) throw new Error('投屏操作正在进行，请稍候');
      const controller = new AbortController();
      startController = controller;
      let context;
      const ensureActive = () => { if (controller.signal.aborted) throw new Error('投屏已取消'); };
      try {
      const device = devices.get(id); if (!device) throw new Error('请重新搜索并选择电视');
      if (!media?.buffer && !media?.filePath) throw new Error('请先下载或缓存本集后投屏');
      const size = media.buffer?.length || fs.statSync(media.filePath).size;
      if (!size) throw new Error('视频文件为空');
      const previous = current;
      if (previous) {
        await sendAction(previous.device, 'Stop', {}, controller.signal);
        if (current === previous) current = null;
        dispose(previous);
      }
      ensureActive();
      const token = randomUUID(), streams = new Set();
      const server = http.createServer((req,res) => {
        if (req.socket.remoteAddress?.replace(/^::ffff:/,'') !== device.host || req.url !== `/${token}.mp4`) {res.writeHead(404).end();return;}
        if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405).end();return;}
        const range = rangeFor(req.headers.range,size);
        if (!range) {res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}
        const {start,end,partial} = range;
        res.writeHead(partial ? 206 : 200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,'transferMode.dlna.org':'Streaming',...(partial?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
        if(req.method==='HEAD') {res.end();return;}
        if(media.buffer) res.end(media.buffer.subarray(start,end+1));
        else { const stream=fs.createReadStream(media.filePath,{start,end});streams.add(stream);stream.on('error',()=>res.destroy());stream.on('close',()=>streams.delete(stream));res.on('close',()=>stream.destroy());stream.pipe(res); }
      });
      context = { server, device, streams, controller, release: media.release };
      current = context;
      await new Promise((resolve, reject) => {
        const aborted = () => reject(new Error('投屏已取消'));
        controller.signal.addEventListener('abort', aborted, { once: true });
        server.once('error', reject);
        server.listen({ port: 0, host: device.localAddress, signal: controller.signal }, () => {
          controller.signal.removeEventListener('abort', aborted);
          resolve();
        });
      });
      server.on('error', () => { if (current === context) close(); });
      ensureActive();
      const url=`http://${device.localAddress}:${server.address().port}/${token}.mp4`;
      const metadata=`<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${xmlEscape(media.title || '红果短剧')}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:video/mp4:*" size="${size}">${xmlEscape(url)}</res></item></DIDL-Lite>`;
      await sendAction(device, 'SetAVTransportURI', { CurrentURI: url, CurrentURIMetaData: metadata }, controller.signal);
      ensureActive();
      await sendAction(device, 'Play', { Speed: '1' }, controller.signal);
      ensureActive();
      return { name: device.name };
      } catch (error) {
        if (current === context) current = null;
        dispose(context);
        throw error;
      } finally { if (startController === controller) startController = null; }
    },
    async control(action) {
      if (!['Play', 'Pause', 'Stop'].includes(action)) throw new Error('投屏操作无效');
      if (action !== 'Stop' && (controlJob || startController)) throw new Error('投屏操作正在进行，请稍候');
      const context = current;
      if (!context && !startController) { if (action === 'Stop') return; throw new Error('当前没有投屏'); }
      const job = {};
      controlJob = job;
      try {
        if (action === 'Stop') close();
        if (context) await sendAction(context.device, action, action === 'Play' ? { Speed: '1' } : {}, action === 'Stop' ? undefined : context.controller.signal);
      } finally {
        if (controlJob === job) controlJob = null;
      }
    },
    status: () => current ? { active: true, name: current.device.name } : { active: false, name: '' },
    close,
  };
}
module.exports={createCastingService,parseDevice,rangeFor,privateIp};
