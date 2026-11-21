const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-xifan-title-'));

function load(dir) {
  const handlers = {};
  const app = new EventEmitter();
  Object.assign(app, {
    getVersion: () => 'test',
    getPath: () => dir,
    commandLine: { appendSwitch() {}, hasSwitch: () => false },
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then() {} }),
  });
  const electron = {
    app,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    protocol: { registerSchemesAsPrivileged() {} },
    shell: { showItemInFolder() {}, openPath: async () => '' },
    session: { defaultSession: { setProxy: async () => {} } },
  };
  const store = {
    getSettings: () => ({ root: dir, name_format: '剧名 集数' }),
    saveTasks() {}, saveSeries() {}, saveMergeTasks() {}, saveSettings() {},
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './src/store' ? store : req(name),
    __dirname: path.dirname(source),
    process: { ...process, env: { ...process.env } },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  return {
    handlers,
    set(name, value) {
      context.fixture = value;
      vm.runInContext(`${name} = fixture`, context);
    },
  };
}

async function check({ sid = 'xifan:jiuzhou:253', seriesTitle = '天龙战神', title = '爱归良辰',
  expected = '', registered = true, complete = true } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const episode = { vid: `${sid}:65863`, vid_index: 1, title, locked: false };
  const seriesRegistry = registered ? [{ series_id: sid, series_title: seriesTitle, episodes: [episode] }] : [];
  const oldTaskTitle = `《${seriesTitle}》第001集 ${title}`;
  const savePath = path.join(dir, 'unchanged.mp4');
  const downloadTasks = [{ id: 'existing', title: oldTaskTitle, filename: 'unchanged.mp4', savePath, status: 'completed',
    startTime: 1000, endTime: 2000, hongguoInfo: { series_id: sid, series_title: seriesTitle, vid: episode.vid, vid_index: 1, ep_title: title } }];
  if (complete) {
    fs.writeFileSync(savePath, Buffer.alloc(120000, 1));
    downloadTasks[0].fileIdentity = req('./src/native/file-identity').readFileIdentity(savePath);
  }
  const before = JSON.stringify({ seriesRegistry, downloadTasks: downloadTasks.map(({ fileIdentity, ...task }) => task) });
  const h = load(dir);
  h.set('seriesRegistry', seriesRegistry);
  h.set('downloadTasks', downloadTasks);

  const result = await h.handlers['get-series-episodes']({}, sid);
  assert.equal(result.success, true);
  assert.equal(result.data.series_title, seriesTitle);
  assert.equal(result.data.episodes[0].title, expected, '旧剧库或任务回退显示应使用同一标题兼容');
  assert.equal(result.data.episodes[0].vid, episode.vid);
  assert.equal(result.data.episodes[0].savePath, savePath);
  assert.equal(result.data.episodes[0].status, complete ? 'completed' : 'missing');
  const [task] = await h.handlers['get-download-tasks']();
  assert.equal(task.title, expected === title ? oldTaskTitle : `《${seriesTitle}》第001集`, '旧下载任务只改变显示标题');
  assert.equal(task.filename, 'unchanged.mp4');
  assert.equal(task.savePath, savePath);
  assert.equal(task.status, complete ? 'completed' : 'failed', '保留文件丢失的既有错误状态');
  const after = JSON.stringify({ seriesRegistry, downloadTasks: downloadTasks.map(({ fileIdentity, ...item }) => item) });
  assert.equal(after, before, '读取不得改写旧档案、任务、路径或文件名');
}

(async () => {
  await check();
  await check({ registered: false });
  await check({ complete: false });
  for (const item of [
    { sid: 'xifan:jiuzhou:254' },
    { sid: 'xifan:huabo:253' },
    { seriesTitle: '爱归良辰' },
    { title: '天龙战神' },
    { title: '第一章：归来' },
    { title: '来源正式别名' },
  ]) await check({ ...item, expected: item.title || '爱归良辰' });
  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS 西饭旧剧库、仅任务资料及缺失文件读取修正显示且不改原资料；其他来源、别名及已纠正标题不变（9项）');
})().catch(error => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error.message);
  process.exitCode = 1;
});
