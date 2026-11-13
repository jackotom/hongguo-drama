// Hongguo Drama 7.2: server entry.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Storage, fail, safeError, assertFields, numericId } = require('./storage.cjs');
const defaultMedia = require('./media.cjs');
const { search: searchHongguo } = require('./search.cjs');
const PUBLIC = path.join(__dirname, 'public');

function makeTask(fields) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), ...fields, status: 'queued', progress: 0, createdAt: now, updatedAt: now };
}
async function body(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw fail('请求必须使用 application/json', 415);
  let bytes = 0, chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw fail('请求过大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('JSON 格式无效'); }
}
function createApp({ token, dataRoot, downloadRoot, media = defaultMedia, search = searchHongguo, autoStart = true }) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || /\s/.test(token)) throw fail('必须配置 32 至 256 字符的 HONGGUO_TOKEN，不得含空白');
  const digest = crypto.createHash('sha256').update(`Bearer ${token}`).digest();
  const store = new Storage(dataRoot, downloadRoot);
  let active, stopped = false, reading = 0, shuttingDown, nextDownloadAt = 0, downloadTimer;
  const controllerById = new Map();
  const authorized = request => crypto.timingSafeEqual(digest, crypto.createHash('sha256').update(String(request.headers.authorization || '')).digest());
  function drain() {
    if (active || stopped) return;
    const task = store.tasks.find(item => item.status === 'queued');
    if (!task) return;
    if (task.type === 'download' && nextDownloadAt > Date.now()) {
      clearTimeout(downloadTimer);
      downloadTimer = setTimeout(drain, nextDownloadAt - Date.now());
      return;
    }
    const controller = new AbortController();
    controllerById.set(task.id, controller);
    try { store.update(task, { status: 'running', error: '', progress: 0 }); } catch { stopped = true; return; }
    let lastUpdate = 0, storageFailed = false;
    const update = progress => {
      if (task.status !== 'running' || Date.now() - lastUpdate < 1000 || storageFailed) return;
      lastUpdate = Date.now();
      try { store.update(task, { progress }); } catch { storageFailed = true; stopped = true; controller.abort(); }
    };
    active = (async () => {
      try {
        await media[task.type](task, store, controller.signal, update);
        if (task.status === 'running' && !storageFailed) store.update(task, { status: 'completed', progress: 100 });
      } catch (error) {
        if (task.status === 'running' && !storageFailed) store.update(task, { status: 'failed', error: safeError(error) });
        // Explicit upstream denial pauses the pending queue; never hammer the next episode.
        if (!storageFailed && (['BUSINESS_REJECTED', 'DEVICE_REGISTRATION_FAILED'].includes(error.code) || error.code === 'SOURCE_UNAVAILABLE' && error.sources?.some(item => item.source === 'app' && /^(?:BUSINESS_REJECTED|DEVICE_REGISTRATION_FAILED|HTTP_(?:403|429))$/.test(item.code)))) {
          for (const pending of store.tasks.filter(item => item.type === 'download' && item.status === 'queued')) Object.assign(pending, { status: 'interrupted', error: '来源拒绝请求，已暂停队列；请稍后手动重试' });
          store.save();
        }
      } finally {
        if (task.type === 'download') nextDownloadAt = Date.now() + 1000;
        controllerById.delete(task.id); active = null; if (!stopped) setImmediate(drain);
      }
    })().catch(() => { stopped = true; });
  }
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { if (!response.headersSent) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); } };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health' && request.method === 'GET') return send(stopped ? 503 : 200, { status: stopped ? 'stopping' : 'ok' });
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(request.method)) throw fail('方法不允许', 405);
        const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
        const file = files[url.pathname]; if (!file || !fs.existsSync(path.join(PUBLIC, file[0]))) throw fail('页面不存在', 404);
        response.setHeader('Content-Type', file[1]); return response.end(request.method === 'HEAD' ? undefined : fs.readFileSync(path.join(PUBLIC, file[0])));
      }
      if (!authorized(request)) throw fail('访问令牌无效', 401);
      if (stopped) throw fail('服务正在停止或持久化失败，请检查存储后重启', 503);
      if (request.headers.origin) {
        let origin; try { origin = new URL(request.headers.origin); } catch { throw fail('来源无效', 403); }
        if (origin.host !== request.headers.host || !['http:', 'https:'].includes(origin.protocol)) throw fail('只允许同源请求', 403);
      }
      const route = url.pathname;
      if (request.method === 'GET' && route === '/api/status') return send(200, { success: true, version: require('../package.json').version, downloadRoot: '/downloads', concurrency: 1 });
      if (request.method === 'GET' && route === '/api/tasks') return send(200, { success: true, tasks: store.tasks.map(task => store.publicTask(task)).reverse() });
      if (request.method === 'GET' && (route === '/api/search' || /^\/api\/series\/[^/]+$/.test(route))) {
        if (reading >= 2) throw fail('上游查询繁忙，请稍后重试', 429);
        reading++;
        try {
          if (route === '/api/search') {
            const q = (url.searchParams.get('q') || '').trim(), page = Number(url.searchParams.get('page') || 1);
            if (!q || q.length > 200 || !Number.isInteger(page) || page < 1 || page > 50) throw fail('搜索词或页码无效');
            const result = await search(q, { page, retries: 1, deadline: Date.now() + 20000 });
            const results = (result.results || []).filter(item => /^\d{1,30}$/.test(String(item.series_id))).map(item => ({ series_id: String(item.series_id), series_title: String(item.series_title || ''), cover: String(item.cover || ''), total: item.total }));
            return send(200, { success: true, results, page, hasMore: result.hasMore === true || result.has_more === true });
          }
          return send(200, { success: true, series: await media.series(numericId(route.split('/').pop())) });
        } finally { reading--; }
      }
      const fileRoute = /^\/api\/files\/([a-f0-9-]{36})$/.exec(route);
      if (fileRoute && request.method === 'GET') {
        const task = store.get(fileRoute[1]); if (task.status !== 'completed') throw fail('文件尚未完成', 409);
        const file = store.output(task), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), stat = fs.fstatSync(fd);
        if (!stat.isFile()) { fs.closeSync(fd); throw fail('文件不可用', 409); }
        response.setHeader('Content-Type', 'video/mp4'); response.setHeader('Content-Length', stat.size);
        response.setHeader('Content-Disposition', `attachment; filename="${task.id}.mp4"`);
        const stream = fs.createReadStream(file, { fd, autoClose: true });
        response.once('close', () => stream.destroy()); stream.on('error', () => response.destroy()); return stream.pipe(response);
      }
      if (request.method !== 'POST') throw fail('接口不存在', 404);
      const payload = await body(request);
      if (route === '/api/downloads') {
        assertFields(payload, ['seriesId', 'episodeIds', 'quality']); numericId(payload.seriesId);
        if (!Array.isArray(payload.episodeIds) || !payload.episodeIds.length || payload.episodeIds.length > 1000 || payload.episodeIds.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id)) || new Set(payload.episodeIds).size !== payload.episodeIds.length) throw fail('请选择有效且不重复的分集');
        const quality = payload.quality || 'auto'; if (!['auto', '720p', '1080p'].includes(quality)) throw fail('画质无效');
        if (reading >= 2) throw fail('上游查询繁忙，请稍后重试', 429);
        let detail; reading++; try { detail = await media.series(payload.seriesId); } finally { reading--; }
        const selected = detail.episodes.filter(item => payload.episodeIds.includes(item.vid));
        if (selected.length !== payload.episodeIds.length) throw fail('选择包含不属于本剧的分集');
        // Resolve duplicates after the awaited catalogue so concurrent submissions remain idempotent.
        const tasks = [], added = [];
        for (const episode of selected) {
          const existing = store.tasks.find(item => item.type === 'download' && item.seriesId === payload.seriesId && item.vid === episode.vid && item.quality === quality && ['queued', 'running', 'completed'].includes(item.status));
          const task = existing || makeTask({ type: 'download', seriesId: detail.series_id, seriesTitle: detail.series_title, vid: episode.vid, episodeIndex: episode.vid_index, episodeTitle: episode.title, quality });
          tasks.push(task); if (!existing) added.push(task);
        }
        if (added.length) store.add(added);
        send(202, { success: true, tasks: tasks.map(task => store.publicTask(task)) }); if (autoStart) drain(); return;
      }
      if (route === '/api/merge') {
        assertFields(payload, ['taskIds']);
        if (!Array.isArray(payload.taskIds) || payload.taskIds.length < 2 || payload.taskIds.length > 1000 || new Set(payload.taskIds).size !== payload.taskIds.length) throw fail('请至少选择两个不同的已完成分集');
        const inputs = payload.taskIds.map(id => store.get(id)).sort((a, b) => a.episodeIndex - b.episodeIndex), first = inputs[0];
        if (inputs.some(input => input.type !== 'download' || input.status !== 'completed' || input.seriesId !== first.seriesId) || new Set(inputs.map(input => input.episodeIndex)).size !== inputs.length) throw fail('只允许同剧且集号不重复的已完成分集合并');
        for (const input of inputs) if (!fs.existsSync(store.output(input))) throw fail('分集文件不存在，请重新下载');
        const task = makeTask({ type: 'merge', seriesId: first.seriesId, seriesTitle: first.seriesTitle, taskIds: inputs.map(input => input.id) });
        store.add([task]); send(202, { success: true, task: store.publicTask(task) }); if (autoStart) drain(); return;
      }
      const action = /^\/api\/tasks\/([a-f0-9-]{36})\/(retry|cancel)$/.exec(route);
      if (action) {
        assertFields(payload, []); const task = store.get(action[1]);
        if (action[2] === 'retry') {
          if (!['failed', 'cancelled', 'interrupted'].includes(task.status) || controllerById.has(task.id)) throw fail('当前任务不能重试，请等待停止完成', 409);
          if (task.type === 'download' && store.tasks.some(other => other.id !== task.id && other.type === 'download' && other.seriesId === task.seriesId && other.vid === task.vid && other.quality === task.quality && ['queued', 'running', 'completed'].includes(other.status))) throw fail('同集同画质已有有效任务，请使用现有任务', 409);
          store.update(task, { status: 'queued', progress: 0, error: '' });
        } else {
          if (!['queued', 'running'].includes(task.status)) throw fail('当前任务不能取消', 409);
          store.update(task, { status: 'cancelled', error: '已取消；已完成文件保留' }); controllerById.get(task.id)?.abort();
        }
        send(200, { success: true, task: store.publicTask(task) }); if (autoStart) drain(); return;
      }
      throw fail('接口不存在', 404);
    } catch (error) { send(error.status || 500, { success: false, error: safeError(error) }); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.maxConnections = 64;
  if (autoStart) setImmediate(drain);
  async function close() {
    if (shuttingDown) return shuttingDown;
    stopped = true;
    clearTimeout(downloadTimer);
    shuttingDown = (async () => {
      try {
        for (const task of store.tasks.filter(item => item.status === 'running')) store.update(task, { status: 'interrupted', error: '服务已停止，请手动重试' });
      } catch {} finally { for (const controller of controllerById.values()) controller.abort(); }
      const closed = new Promise(resolve => server.listening ? server.close(resolve) : resolve());
      server.closeIdleConnections();
      await active; await closed;
    })();
    return shuttingDown;
  }
  return { server, store, close, drain };
}
if (require.main === module) {
  try {
    const app = createApp({ token: process.env.HONGGUO_TOKEN, dataRoot: process.env.DATA_DIR || '/data', downloadRoot: process.env.DOWNLOAD_DIR || '/downloads' });
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('端口无效');
    app.server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Hongguo Web listening on port ${port}`));
    app.server.on('error', error => { console.error(`服务启动失败：${error.code || '未知'}`); process.exit(1); });
    for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => { app.close().then(() => process.exit(0), () => process.exit(1)); });
  } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
}
module.exports = { createApp, makeTask };
