const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const file = path.resolve(__dirname, '../main.js'), req = createRequire(file);
const app = new EventEmitter();
Object.assign(app, { getVersion: () => '1.2.0', getPath: () => '/synthetic', commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
let settings = {}, response, requests = 0, requestOptions, responses = [];
const handlers = {}, opened = [], events = [], sender = {};
const store = { setErrorHandler() {}, getSettings: () => settings, saveSettings: v => { settings = v; } };
const electron = { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, protocol: { registerSchemesAsPrivileged() {} },
  shell: { openExternal: async url => { opened.push(url); } },
  session: { defaultSession: { setProxy: async () => {}, clearAuthCache: async () => {}, closeAllConnections: async () => {} } } };
const axios = { get: async (url, options) => { requests++; requestOptions = { url, ...options }; const next = responses.length ? responses.shift() : response; if (next instanceof Error) throw next; return next?.httpResponse || { data: await next }; } };
const context = vm.createContext({ require: name => name === 'electron' ? electron : name === 'axios' ? axios : name === './src/store' ? store : req(name), __dirname: path.dirname(file), process, Buffer, URL, AbortController, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } });
vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
vm.runInContext('mainWindow = { webContents: testSender };', Object.assign(context, { testSender: sender }));
require('./fixtures/trusted-ipc.cjs')(context, handlers);
context.sendToRenderer = (name, value) => events.push([name,value]);
context.applyProxySettings = async () => {};
const ipc = (name, ...args) => handlers[name]({}, ...args);
(async()=>{
  assert.equal(typeof handlers['check-app-update'], 'function', 'update detection IPC must exist');
  assert.equal(typeof handlers['download-app-update'], 'function', 'in-app download IPC must exist');
  assert.equal(typeof handlers['cancel-app-update'], 'function', 'cancellation IPC must exist');
  assert.equal((await ipc('cancel-app-update')).success, true);
  assert.equal(typeof handlers['install-app-update'], 'function', 'explicit installation IPC must exist');
  assert.equal((await ipc('get-app-update-state')).supported, false, 'development app must not update itself');
  assert.equal((await ipc('download-app-update')).success, false);
  assert.equal((await ipc('install-app-update')).success, false);
  assert.equal((await ipc('get-settings')).app_updates_enabled, true);
  settings.app_updates_enabled=false;
  assert.equal((await ipc('check-app-update')).enabled,false);assert.equal(requests,0);
  settings.app_updates_enabled=true;
  for(const tag of ['v1.1.9','1.2','v1.2.0','v1.2.0-beta.1','garbage']){
    response={tag_name:tag,draft:false,prerelease:false};assert.equal((await ipc('check-app-update')).release,null,tag);
  }
  for(const flags of [{draft:true},{prerelease:true}]){response={tag_name:'v2.0',...flags};assert.equal((await ipc('check-app-update')).release,null);}
  response={tag_name:'v1.2.1',html_url:'https://evil.invalid/download'};
  let result=await ipc('check-app-update');assert.equal(result.release.version,'1.2.1');
  assert.equal(result.release.url,'https://github.com/jackotom/hongguo-drama/releases/tag/v1.2.1');
  await ipc('open-app-update');assert.equal(opened[0],result.release.url);
  assert.equal(requestOptions.url,'https://api.github.com/repos/jackotom/hongguo-drama/releases/latest');
  assert.equal(requestOptions.timeout,10000);assert.equal(requestOptions.maxRedirects,0);
  response={tag_name:'v2.0'};result=await ipc('check-app-update');assert.equal(result.release.version,'2.0');
  for (const reason of ['HTTP 403', 'HTTP 429', 'network timeout']) {
    responses = [Error(reason), { tag_name: 'v2.0', html_url: 'https://evil.invalid' }];
    result = await ipc('check-app-update');
    assert.equal(result.release?.version, '2.0', `${reason} must use the quota-free official fallback`);
    assert.equal(requestOptions.url, 'https://github.com/jackotom/hongguo-drama/releases/latest');
    assert.equal(requestOptions.headers.Accept, 'application/json');
    assert.equal(requestOptions.maxRedirects, 0);
    assert.equal(requestOptions.timeout, 10000);
  }
  responses=[Error('HTTP 403'),{httpResponse:{status:302,headers:{location:'https://github.com/jackotom/hongguo-drama/releases/tag/v2.0'}}}];
  result=await ipc('check-app-update');
  assert.equal(result.release?.version,'2.0','official latest redirect must provide stable version without following the URL');
  for (const location of ['https://evil.invalid/releases/tag/v2.0','https://github.com/other/repo/releases/tag/v2.0','https://github.com/jackotom/hongguo-drama/releases/tag/v2.0-beta.1','https://github.com/jackotom/hongguo-drama/releases/tag/v2.0?evil=1']) {
    responses=[Error('HTTP 403'),{httpResponse:{status:302,headers:{location}}}];
    assert.equal((await ipc('check-app-update')).release,null,'untrusted redirect rejected');
  }
  for (const data of [{tag_name:'v2.0-beta.1'}, {tag_name:'../../evil'}, {tag_name:'v2.0',prerelease:true}, {tag_name:'v2.0',draft:true}, {tag_name:'1.2'}, '<html>error</html>']) {
    responses = [Error('HTTP 403'), data];
    assert.equal((await ipc('check-app-update')).release, null, 'fallback must reject unsafe or non-new releases');
  }
  response=Error('network timeout');assert.equal((await ipc('check-app-update')).release,null);
  assert.equal((await ipc('open-app-update')).success,true, 'failed checks must retain a fixed manual fallback');
  assert.equal(opened.at(-1),'https://github.com/jackotom/hongguo-drama/releases/latest');
  let resolve;response=new Promise(r=>{resolve=r});const pending=ipc('check-app-update');
  await ipc('save-settings',{app_updates_enabled:false});resolve({tag_name:'v3.0'});
  assert.equal((await pending).enabled,false);assert.ok(events.some(([n,v])=>n==='app-update-preference'&&v===false));
  assert.equal((await ipc('open-app-update')).success,false);
  settings.app_updates_enabled=true;
  let finishFallback;
  responses=[Error('HTTP 403'),new Promise(resolve=>{finishFallback=resolve;})];
  const lateFallback=ipc('check-app-update');
  await Promise.resolve();
  await ipc('save-settings',{app_updates_enabled:false});
  finishFallback({tag_name:'v3.0'});
  assert.equal((await lateFallback).enabled,false,'disabled setting must suppress late fallback results');
  vm.runInContext("appUpdateInstaller = {getState:()=>({status:'installing'}),cancel:()=>{throw Error('must not cancel installation')}}",context);
  assert.equal((await ipc('cancel-app-update')).success,false,'cannot cancel once installation starts');
  console.log('PASS update IPC: opt-out, persisted preference, versions, stable releases, fixed GitHub destination, timeout and late-response suppression');
})().catch(e=>{console.error(e);process.exitCode=1});
