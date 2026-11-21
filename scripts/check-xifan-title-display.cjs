const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

async function check({ sid = 'xifan:jiuzhou:253', seriesTitle = '天龙战神', title = '爱归良辰',
  expected = '', registered = true, complete = true } = {}) {
  const episode = { vid: `${sid}:65863`, vid_index: 1, title, locked: false };
  const seriesRegistry = registered ? [{ series_id: sid, series_title: seriesTitle, episodes: [episode] }] : [];
  const oldTaskTitle = `《${seriesTitle}》第001集 ${title}`;
  const downloadTasks = [{ id: 'existing', title: oldTaskTitle, filename: 'unchanged.mp4', savePath: '/fixture/unchanged.mp4',
    status: 'completed', hongguoInfo: { series_id: sid, series_title: seriesTitle, vid: episode.vid, vid_index: 1, ep_title: title } }];
  const before = JSON.stringify({ seriesRegistry, downloadTasks });
  const handlers = {};
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, seriesRegistry, downloadTasks,
    require: name => require(path.join(__dirname, '..', name)),
    downloadTaskView: require('../src/native/download-task-view').downloadTaskView,
    pathConflicts: require('../src/native/download-task-view').pathConflicts,
    episodeDisplayTitle: require('../src/native/xifan').episodeDisplayTitle,
    fs: { existsSync: () => complete, statSync: () => ({ size: 200000 }) },
    collectSeriesEpisodeFiles: () => ({ dir: '/fixture', ordered: [] }),
    hasCompleteTaskFile: () => complete, localPlayUrl: () => 'local-media://fixture', console, setTimeout,
  };
  const viewStart = main.indexOf('async function currentDownloadTaskView');
  const handlerStart = main.indexOf("ipcMain.handle('get-download-tasks'");
  assert.ok(viewStart >= 0 && handlerStart > viewStart);
  vm.runInNewContext(main.slice(viewStart, handlerStart), context);
  for (const name of ['get-series-episodes', 'get-download-tasks']) {
    const start = main.indexOf(`ipcMain.handle('${name}'`);
    assert.ok(start >= 0);
    vm.runInNewContext(main.slice(start, main.indexOf('\n});', start) + 4), context);
  }
  const result = await handlers['get-series-episodes']({}, sid);
  assert.equal(result.success, true);
  assert.equal(result.data.series_title, seriesTitle);
  assert.equal(result.data.episodes[0].title, expected, '旧剧库或任务回退显示应使用同一标题兼容');
  assert.equal(result.data.episodes[0].vid, episode.vid);
  assert.equal(result.data.episodes[0].savePath, downloadTasks[0].savePath);
  assert.equal(result.data.episodes[0].status, complete ? 'completed' : 'missing');
  const [task] = await handlers['get-download-tasks']();
  assert.equal(task.title, expected === title ? oldTaskTitle : `《${seriesTitle}》第001集`, '旧下载任务只改变显示标题');
  assert.equal(task.filename, downloadTasks[0].filename);
  assert.equal(task.savePath, downloadTasks[0].savePath);
  assert.equal(task.status, complete ? 'completed' : 'failed', '保留文件丢失的既有错误状态');
  assert.equal(JSON.stringify({ seriesRegistry, downloadTasks }), before, '读取不得改写旧档案、任务、路径或文件名');
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
  console.log('PASS 西饭旧剧库、仅任务资料及缺失文件读取修正显示且不改原资料；其他来源、别名及已纠正标题不变（9项）');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
