const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const handler = source.match(/ipcMain\.handle\('open-episode-external',[\s\S]*?\n\}\);/);
assert.ok(handler, 'downloaded episodes need an external-player entry');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-external-'));
const opened = [], handlers = {};
const context = vm.createContext({ fs, path, downloadTasks: [], mergeTasks: [],
  shell: { openPath: async file => { opened.push(file); return context.openError || ''; } },
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  pathInside: (dir, file) => { const rel = path.relative(fs.realpathSync(dir), fs.realpathSync(file)); return !rel.startsWith('..') && !path.isAbsolute(rel); },
});
vm.runInContext(source.match(/function isRecordedMediaFile\([\s\S]*?\n\}/)[0], context);
for (const name of ['readFileIdentity', 'fileIdentityMatches', 'legacyFileMatches', 'isRegularFile']) {
  vm.runInContext(source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0], context);
}
vm.runInContext(source.match(/function hasCompleteTaskFile\([\s\S]*?\n\}/)[0], context);
vm.runInContext(handler[0], context);
const open = (sid = '123456', index = 1) => handlers['open-episode-external']({}, sid, index);
(async () => {
  try {
    assert.equal((await open()).success, false);
    const file = path.join(root, 'episode.mp4'); fs.writeFileSync(file, Buffer.alloc(110000));
    const task = { status: 'completed', savePath: file, customDir: root, endTime: Date.now(), fileIdentity: context.readFileIdentity(file),
      hongguoInfo: { series_id: '123456', vid_index: 1, vid: '987654' } };
    context.downloadTasks.push(task);
    assert.equal((await open()).success, true); assert.deepEqual(opened, [file]);
    assert.equal((await open('123456', 2)).success, false);
    assert.equal((await open('../../outside', 1)).success, false);
    task.status = 'pending'; assert.equal((await open()).success, false); task.status = 'completed';
    task.pathConflict = true; assert.equal((await open()).success, false); task.pathConflict = false;
    context.openError = 'No application'; assert.equal((await open()).success, false); context.openError = '';
    fs.unlinkSync(file); assert.equal((await open()).success, false);
    const exe = path.join(root, 'episode.exe'); fs.writeFileSync(exe, Buffer.alloc(110000)); task.savePath = exe;
    assert.equal((await open()).success, false);
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    const target = path.join(outside, 'outside.mp4'); fs.writeFileSync(target, Buffer.alloc(110000));
    task.savePath = file; fs.symlinkSync(target, file); assert.equal((await open()).success, false);
    assert.equal(opened.length, 2, 'only valid registered videos may reach the OS');
    const player = fs.readFileSync(path.join(__dirname, '../src/components/Player.jsx'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
    assert.match(player, /openEpisodeExternal\(activeSeriesId, currentIndex\)/);
    assert.match(preload, /openEpisodeExternal:.*invoke\('open-episode-external'/);
    console.log('PASS external player: registered complete MP4 only; wrong episode, pending, conflicts, missing file, executable and symlink rejected; OS errors and UI bridge');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
