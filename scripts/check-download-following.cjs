// Real IPC and existing queue logic, with isolated data and no network.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../main.js'), req = createRequire(file);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-following-'));
const app = new EventEmitter(), handlers = {};
Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} },
  requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
const electron = { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, protocol: { registerSchemesAsPrivileged() {} } };
const context = vm.createContext({ require: n => n === 'electron' ? electron : n === './src/store'
  ? { getSettings: () => ({ root }), saveTasks() {}, saveSeries() {} } : req(n), __dirname: path.dirname(file),
  process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout, console });
vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
require('./fixtures/trusted-ipc.cjs')(context, handlers);
const call = (...args) => handlers['download-following-episodes']({}, ...args);
(async () => {
  try {
    const complete = path.join(root, 'completed.mp4'); fs.writeFileSync(complete, Buffer.alloc(200000));
    context.completePath = complete;
    vm.runInContext(`seriesRegistry=[{series_id:'A',series_title:'Fixture',episodes:[1,2,3,4,5,6].map(n=>({vid:'v'+n,vid_index:n,locked:n===6}))}];
      downloadTasks=[{hongguoInfo:{series_id:'A',vid:'v3'},status:'pending'},
        {hongguoInfo:{series_id:'A',vid:'v4'},status:'completed',savePath:completePath},
        {hongguoInfo:{series_id:'A',vid:'v5'},status:'completed',savePath:completePath+'.missing'}];`, context);
    let submitted, resolve;
    context.enqueueEpisodes = payload => { submitted = payload; return new Promise(r => { resolve = r; }); };
    const pending = call('A', 2, '720p');
    assert.deepEqual(Array.from(submitted.episodes, ep => ep.vid_index), [2, 5]);
    assert.equal(submitted.quality, '720p');
    assert.equal((await call('A', 2, '720p')).success, false, 'block double submission');
    resolve(2); assert.equal((await pending).count, 2);
    for (const index of [0, -1, 1.5, '2', 99]) assert.equal((await call('A', index, 'auto')).success, false);
    assert.equal((await call('missing', 1, 'auto')).success, false);
    assert.equal((await call('A', 6, 'auto')).count, 0);
    context.enqueueEpisodes = async () => { throw new Error('disk full'); };
    assert.equal((await call('A', 2, 'auto')).error, 'disk full');
    context.enqueueEpisodes = async () => 2;
    assert.equal((await call('A', 2, 'auto')).count, 2, 'failure releases submission latch');
    const { mount } = require('./check-player-resume.cjs');
    let calls = 0, finish, request;
    const ui = mount({ episodeCount: 4, props: { target: { seriesId: 'A', vidIndex: 2, ts: 1 } }, apiOverrides: {
      downloadFollowingEpisodes: (...args) => { calls++; request = args; return new Promise(resolve => { finish = resolve; }); },
    } });
    await ui.flush(); ui.metadata();
    const button = ui.button('从本集下载至末集');
    assert.equal(button.props.disabled, false);
    const first = button.props.onClick();
    await button.props.onClick();
    assert.equal(calls, 1);
    assert.equal(request[0], 'A'); assert.equal(request[1], 2);
    finish({ success: true, count: 2 }); await first; await ui.flush();
    assert(ui.text().includes('已将 2 集加入下载队列'));
    ui.unmount();
    console.log('PASS following-download IPC: inclusive range, lock/queue/file checks, duplicate submit, failure recovery');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
