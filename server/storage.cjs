const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = /^[a-f0-9-]{36}$/;
const SERIES = /^\d{1,30}$/;
const statuses = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
function fail(message, status = 400, code) { const error = Object.assign(new Error(message), { status }); if (code) error.code = code; return error; }
function safeError(error) {
  if (error?.code === 'ENOSPC') return '存储空间不足';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return '存储目录不可写，请检查挂载权限';
  if (['ENOENT', 'ENOTDIR', 'ESTALE'].includes(error?.code)) return '存储路径不可用，请检查挂载';
  return String(error?.message || '操作失败').replace(/https?:\/\/[^\s"'）]+/gi, '[来源地址]').replace(/(?:Bearer\s+|decryption_key\s+)\S+/gi, '[已隐藏]').slice(0, 300);
}
function mountChanged(message) { return fail(message, 409, 'MOUNT_CHANGED'); }
function invalidArtifact() { return fail('已完成视频不可用，请重新下载', 409, 'ARTIFACT_INVALID'); }
function assertFields(value, allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key))) throw fail('请求字段无效');
}
function numericId(value) { if (typeof value !== 'string' || !SERIES.test(value)) throw fail('只支持红果剧集标识'); return value; }
function safeTitle(value) { return String(value || '未命名短剧').normalize('NFKC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 60) || '未命名短剧'; }

class Storage {
  constructor(dataRoot, downloadRoot) {
    this.dataRoot = path.resolve(dataRoot); this.root = path.resolve(downloadRoot);
    for (const dir of [this.dataRoot, this.root]) {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.lstatSync(dir).isSymbolicLink()) throw fail('挂载目录不可是符号链接');
    }
    this.dataRoot = fs.realpathSync(this.dataRoot); this.root = fs.realpathSync(this.root);
    this.rootStat = fs.statSync(this.root); this.dataStat = fs.statSync(this.dataRoot);
    this.stateFile = path.join(this.dataRoot, 'tasks.json');
    this.tasks = [];
    if (fs.existsSync(this.stateFile)) {
      if (!fs.lstatSync(this.stateFile).isFile() || fs.lstatSync(this.stateFile).isSymbolicLink() || fs.statSync(this.stateFile).size > 32 * 1024 * 1024) throw fail('任务记录文件无效');
      let state; try { state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { throw fail('任务记录损坏，已停止启动以保护记录'); }
      if (state.version !== 1 || !Array.isArray(state.tasks) || state.tasks.length > 10000) throw fail('任务记录损坏，已停止启动以保护记录');
      const seen = new Set();
      for (const task of state.tasks) {
        if (!ID.test(task.id) || seen.has(task.id) || !SERIES.test(task.seriesId) || !['download', 'merge'].includes(task.type) || !statuses.has(task.status)) throw fail('任务记录损坏');
        if (task.type === 'download' && (!SERIES.test(task.vid) || !Number.isInteger(task.episodeIndex) || task.episodeIndex < 1 || !['auto', '720p', '1080p'].includes(task.quality))) throw fail('下载记录损坏');
        if (task.type === 'merge' && (!Array.isArray(task.taskIds) || task.taskIds.some(id => !ID.test(id)))) throw fail('合并记录损坏');
        seen.add(task.id);
        if (task.status === 'running') { task.status = 'interrupted'; task.error = '服务已重启，请手动重试'; }
        this.tasks.push(task);
      }
    }
    this.cleanupTemporary();
    this.reconcileCompleted();
    this.save();
  }
  checkRoot() {
    try {
      const stat = fs.lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.rootStat.dev || stat.ino !== this.rootStat.ino || fs.realpathSync(this.root) !== this.root) throw mountChanged('下载挂载已变化，请恢复原挂载后重启服务');
    } catch (error) {
      if (error.code === 'MOUNT_CHANGED') throw error;
      throw mountChanged('下载挂载已变化，请恢复原挂载后重启服务');
    }
  }
  cleanupTemporary() {
    this.checkRoot();
    let entries;
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); }
    catch { throw mountChanged('下载挂载已变化，请恢复原挂载后重启服务'); }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/_\d{1,30}$/.test(entry.name)) continue;
      const directory = path.join(this.root, entry.name);
      let children;
      try { children = fs.readdirSync(directory, { withFileTypes: true }); }
      catch { continue; }
      for (const child of children) {
        if (!/^\.download-[A-Za-z0-9]{6}$/.test(child.name)) continue;
        const temporary = path.join(directory, child.name);
        try {
          const stat = fs.lstatSync(temporary);
          if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 2 });
        } catch {}
      }
    }
  }
  directory(task) {
    this.checkRoot();
    const dir = path.join(this.root, `${safeTitle(task.seriesTitle)}_${numericId(task.seriesId)}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o750 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw fail('剧集目录不可是符号链接', 409);
    return dir;
  }
  artifactPath(task) {
    if (!ID.test(task.id)) throw fail('任务标识无效');
    const name = task.type === 'merge' ? `合并_${task.id}.mp4` : `第${String(task.episodeIndex).padStart(3, '0')}集_${task.id}.mp4`;
    return path.join(this.directory(task), name);
  }
  output(task) {
    const file = this.artifactPath(task);
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw fail('目标文件不是普通文件', 409, 'ARTIFACT_INVALID');
    return file;
  }
  artifact(task) {
    this.checkRoot();
    const file = this.output(task);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') throw invalidArtifact();
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw invalidArtifact();
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (task.artifact && task.artifact !== fingerprint) throw invalidArtifact();
    return { file, stat, fingerprint };
  }
  complete(task) {
    const { fingerprint } = this.artifact(task);
    this.update(task, { status: 'completed', progress: 100, artifact: fingerprint });
  }
  quarantineArtifact(task) {
    const file = this.artifactPath(task);
    if (!fs.existsSync(file)) return null;
    const target = path.join(path.dirname(file), `.invalid-${task.id}-${Date.now()}-${crypto.randomUUID()}.mp4`);
    fs.renameSync(file, target);
    return target;
  }
  reconcileCompleted() {
    const before = [], failed = [];
    for (const task of this.tasks) {
      if (task.status !== 'completed') continue;
      try {
        const { fingerprint } = this.artifact(task);
        if (!task.artifact) { before.push([task, { ...task }]); task.artifact = fingerprint; }
      } catch (error) {
        if (error.code === 'MOUNT_CHANGED') throw error;
        if (error.code !== 'ARTIFACT_INVALID') throw error;
        before.push([task, { ...task }]); failed.push(task);
        try { this.quarantineArtifact(task); } catch {}
        Object.assign(task, { status: 'interrupted', progress: 0, error: '已完成视频不可用，请重新下载' });
        delete task.artifact;
      }
    }
    if (!before.length) return;
    try { this.save(); } catch (error) {
      for (const [task, old] of before) { for (const key of Object.keys(task)) delete task[key]; Object.assign(task, old); }
      throw error;
    }
    return failed;
  }
  interruptQueued(message) {
    const queued = this.tasks.filter(task => task.type === 'download' && task.status === 'queued');
    if (!queued.length) return 0;
    const before = queued.map(task => [task, { ...task }]);
    for (const task of queued) Object.assign(task, { status: 'interrupted', progress: 0, error: message, updatedAt: new Date().toISOString() });
    try { this.save(); } catch (error) {
      for (const [task, old] of before) { for (const key of Object.keys(task)) delete task[key]; Object.assign(task, old); }
      throw error;
    }
    return queued.length;
  }
  publicTask(task) {
    const { id, type, seriesId, seriesTitle, episodeTitle, episodeIndex, status, progress, error, createdAt, updatedAt, quality } = task;
    return { id, type, seriesId, seriesTitle, episodeTitle, episodeIndex, status, progress, error, createdAt, updatedAt, quality,
      ...(status === 'completed' ? { file: path.relative(this.root, this.artifact(task).file) } : {}) };
  }
  save() {
    let stat;
    try {
      stat = fs.lstatSync(this.dataRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.dataStat.dev || stat.ino !== this.dataStat.ino || fs.realpathSync(this.dataRoot) !== this.dataRoot) throw mountChanged('任务目录挂载已变化，请恢复原挂载后重启服务');
    } catch (error) {
      if (error.code === 'MOUNT_CHANGED') throw error;
      throw mountChanged('任务目录挂载已变化，请恢复原挂载后重启服务');
    }
    const temporary = `${this.stateFile}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, tasks: this.tasks })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.stateFile);
    const dir = fs.openSync(this.dataRoot, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  add(tasks) { if (this.tasks.length + tasks.length > 10000) throw fail('任务已达上限，请备份后维护任务库', 409); this.tasks.push(...tasks); try { this.save(); } catch (error) { this.tasks.splice(-tasks.length); throw error; } }
  update(task, changes) { const old = { ...task }; Object.assign(task, changes, { updatedAt: new Date().toISOString() }); try { this.save(); } catch (error) { Object.assign(task, old); throw error; } }
  get(id) { const task = this.tasks.find(item => item.id === id); if (!task) throw fail('任务不存在', 404); return task; }
}
module.exports = { Storage, fail, safeError, assertFields, numericId, safeTitle };
