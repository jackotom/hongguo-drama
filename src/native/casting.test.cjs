const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createCastingService,parseDevice,rangeFor}=require('./casting');
test('device description pins control requests to the discovered private host',()=>{
  const xml='<root><friendlyName>客厅 &amp; 电视</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/control</controlURL></service></serviceList></root>';
  assert.equal(parseDevice(xml,'http://192.168.1.2:80/device','192.168.1.3').name,'客厅 & 电视');
  assert.throws(()=>parseDevice(xml.replace('/control','http://8.8.8.8/control'),'http://192.168.1.2/device','192.168.1.3'));
  assert.throws(()=>parseDevice('<!DOCTYPE root>'+xml,'http://192.168.1.2/device','192.168.1.3'));
});
test('single byte ranges handle suffixes and reject invalid/multiple ranges',()=>{
  assert.deepEqual(rangeFor('bytes=-3',10),{start:7,end:9,partial:true});
  assert.deepEqual(rangeFor('bytes=3-99',10),{start:3,end:9,partial:true});
  for(const value of ['bytes=-0','bytes=10-','bytes=3-1','bytes=0-1,3-4','garbage'])assert.equal(rangeFor(value,10),null);
});
test('casting serves only a selected capability, supports seek, and revokes it on stop',async()=>{
  let url, released=0;const actions=[];
  const service=createCastingService({discoverDevices:async()=>[{id:'tv',name:'Fixture TV',host:'127.0.0.1',localAddress:'127.0.0.1'}],sendAction:async(_device,action,args)=>{actions.push(action);if(action==='SetAVTransportURI')url=args.CurrentURI;}});
  const get=(target,range)=>new Promise((resolve,reject)=>{http.get(target,{headers:range?{Range:range}:{}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));}).on('error',reject);});
  try {
    await service.discover();await assert.rejects(service.start('unknown',{buffer:Buffer.from('protocol fixture')}));
    await service.start('tv',{buffer:Buffer.from('0123456789'),release:()=>released++});
    assert.deepEqual(await get(url,'bytes=2-4'),{status:206,body:'234'});
    assert.equal((await get(new URL('/wrong',url))).status,404);
    await service.control('Pause');await service.control('Play');await service.control('Stop');
    assert.equal(released,1);assert.deepEqual(actions,['SetAVTransportURI','Play','Pause','Play','Stop']);
    await assert.rejects(get(url));
  } finally {service.close();}
});
test('closing during television handshake revokes the URL without a late Play',async()=>{
  let entered, finish, url, releases=0; const actions=[];
  const waiting=new Promise(r=>entered=r), gate=new Promise(r=>finish=r);
  const service=createCastingService({discoverDevices:async()=>[{id:'tv',name:'Fixture',host:'127.0.0.1',localAddress:'127.0.0.1'}],sendAction:async(_device,action,args)=>{actions.push(action);if(action==='SetAVTransportURI'){url=args.CurrentURI;entered();await gate;}}});
  await service.discover(); const pending=service.start('tv',{buffer:Buffer.from('protocol fixture'),release:()=>releases++});
  const rejected=assert.rejects(pending,/取消/);
  await waiting; service.close(); finish(); await rejected;
  assert.equal(releases,1); assert.deepEqual(actions,['SetAVTransportURI']);
  await assert.rejects(new Promise((resolve,reject)=>http.get(url,resolve).on('error',reject)));
});
test('invalid replacement preserves the active session and its pin',async()=>{
  let releases=0;
  const service=createCastingService({discoverDevices:async()=>[{id:'tv',name:'Fixture',host:'127.0.0.1',localAddress:'127.0.0.1'}],sendAction:async()=>{}});
  try { await service.discover();await service.start('tv',{buffer:Buffer.from('protocol fixture'),release:()=>releases++});await assert.rejects(service.start('missing',{buffer:Buffer.from('protocol fixture')}));assert.equal(releases,0);await service.control('Pause');}finally{service.close();}
  assert.equal(releases,1);
});
test('device URLBase and namespace-qualified services resolve without leaving the device',()=>{
  const xml='<root><URLBase>http://192.168.1.2:1234/base/</URLBase><s:service><s:serviceType>urn:schemas-upnp-org:service:AVTransport:1</s:serviceType><s:controlURL>control</s:controlURL></s:service></root>';
  assert.equal(parseDevice(xml,'http://192.168.1.2/desc','192.168.1.3').controlUrl,'http://192.168.1.2:1234/base/control');
  assert.throws(()=>parseDevice(xml.replace('192.168.1.2:1234','10.attacker.example'),'http://192.168.1.2/desc','192.168.1.3'));
});
