const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function assertOrder(events, tasks, expected, kind) {
  const order = events.filter(event => event.kind === kind).map(event => tasks.find(task => task.id === event.id)?.hongguoInfo.vid_index);
  assert.deepEqual(order, expected, kind + ' must follow episode order');
  return order;
}

function inspectReceipt(record, task, downloadRoot) {
  assert.equal(record.owner.taskId, task.id);
  assert.equal(record.owner.vid, String(task.hongguoInfo.vid));
  assert.equal(record.owner.vidIndex, task.hongguoInfo.vid_index);
  assert.equal(record.owner.savePath, task.savePath);
  assert.equal(record.owner.seriesId, String(task.hongguoInfo.series_id));
  const relative = path.relative(downloadRoot, record.directory);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Receipt must stay inside the isolated download root');
  const observed = [];
  for (const [name, identity] of [['', record.identity], ...Object.entries(record.files)]) {
    for (const key of ['dev', 'ino', 'birthtimeNs']) assert.match(identity[key], /^\d+$/, 'Exact file identity must persist as decimal strings');
    const file = path.join(record.directory, name);
    let stat;
    try { stat = fs.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.equal(name ? stat.isFile() : stat.isDirectory(), true);
    for (const key of ['dev', 'ino', 'birthtimeNs']) assert.equal(identity[key], String(stat[key]), 'Persisted identity must match the actual Windows file');
    observed.push({ name: name || 'directory', ...identity, exceedsSafeInteger: BigInt(identity.ino) > BigInt(Number.MAX_SAFE_INTEGER) });
  }
  return observed;
}

function assertFastTrial(metadata, notices) {
  assert.equal(metadata.success, true, 'The actual App fast conversion must succeed');
  assert.equal(metadata.fastConversion, true, 'The actual conversion must use the enabled high-performance setting');
  assert.notEqual(metadata.cached, true, 'A previous cache cannot prove a new fast conversion');
  assert(['h264_nvenc', 'libx264'].includes(metadata.encoder), 'Windows must report the actual NVIDIA or software encoder');
  const hardwareUsed = metadata.encoder === 'h264_nvenc';
  if (hardwareUsed) assert(!metadata.hardwareFallbackReason, 'Successful GPU encoding must not claim software fallback');
  else assert(['unavailable', 'encoder-failed'].includes(metadata.hardwareFallbackReason), 'CPU encoding must explicitly explain hardware fallback');
  const expectedNotice = hardwareUsed ? '正在使用显卡加速转换'
    : metadata.hardwareFallbackReason === 'unavailable' ? '显卡加速不可用，已回退CPU转换' : '显卡加速失败，已回退CPU转换';
  assert.equal(notices.at(-1), expectedNotice, 'Progress must honestly report GPU use or the actual CPU fallback');
  return { hardwareUsed, notice: expectedNotice };
}

module.exports = async function checkDownloads({ evaluate, result, dataFile, mediaDir, series, episodes, ffprobe, ffmpeg, delay }) {
  const api = expression => evaluate(expression);
  const expected = episodes.map(episode => episode.vid_index);
  const receipt = result.appDownloadQueue = { tested: false, seriesId: series.series_id, episodes: expected, maxConcurrent: 1, phases: [], temporaryIdentities: [], media: [] };
  const appInfo = await api('window.electronAPI.getAppInfo()');
  assert.equal(appInfo.configMode, 'portable');
  assert.equal(path.resolve(appInfo.dataDir).toLowerCase(), path.resolve(path.dirname(dataFile)).toLowerCase());
  const staleTasks = await api('window.electronAPI.getDownloadTasks()');
  await api('window.electronAPI.pauseAll()');
  if (staleTasks.length) await api(`window.electronAPI.deleteTasks(${JSON.stringify(staleTasks.map(task => task.id))})`);
  assert.equal((await api('window.electronAPI.getDownloadTasks()')).length, 0, 'Each real queue attempt must start from the disposable profile only');
  receipt.staleTasksRemoved = staleTasks.length;
  const snapshot = () => JSON.parse(fs.readFileSync(dataFile, 'utf8')).tasks.filter(task => String(task.hongguoInfo?.series_id) === String(series.series_id));
  const settle = async predicate => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const tasks = snapshot();
      assert(!tasks.some(task => task.status === 'failed'), 'App download failed; no media URL logged');
      for (const task of tasks) for (const temporary of task.temporaryDownloads || []) {
        const identities = inspectReceipt(temporary, task, mediaDir);
        if (identities.some(item => item.name === 'input.enc.tmp') && !receipt.temporaryIdentities.some(item => item.taskId === task.id)) {
          receipt.temporaryIdentities.push({ taskId: task.id, index: task.hongguoInfo.vid_index, identities });
        }
      }
      const queue = await api('window.electronAPI.getQueueStatus()');
      if (predicate(tasks, queue)) return tasks;
      await delay(50);
    }
    throw new Error('App download queue acceptance timed out; no media URL logged');
  };
  const beginPhase = async pauseFirst => api(`(() => {
    const api = window.electronAPI;
    window.__downloadAcceptance?.dispose.forEach(remove => remove());
    const state = window.__downloadAcceptance = { events: [], started: [], pause: null, dispose: [] };
    state.dispose.push(api.onDownloadProgress(event => {
      if (state.started.includes(event.id)) return;
      state.started.push(event.id);
      state.events.push({ kind: 'started', id: event.id, at: Date.now() });
      if (${pauseFirst} && state.started.length === 1) state.pause = api.pauseAll();
    }));
    state.dispose.push(api.onDownloadCompleted(event => state.events.push({ kind: 'completed', id: event.id, at: Date.now() })));
    return true;
  })()`);
  result.stage = 'app-download-submit-and-pause';
  await beginPhase(false);
  const submitted = await api(`(async () => {
    const submission = await window.electronAPI.hongguoDownloadBatch(${JSON.stringify({ seriesId: series.series_id, seriesTitle: series.series_title, episodes, quality: '1080p' })});
    const pause = await window.electronAPI.pauseAll();
    return { submission, pause };
  })()`);
  assert.equal(submitted.submission.success, true, 'App must accept the real two-episode batch');
  assert.equal(submitted.submission.count, 2);
  assert.equal(submitted.pause.count, 2, 'Both real tasks must pause before completion');
  let tasks = await settle((tasks, queue) => tasks.length === 2 && tasks.every(task => task.status === 'stopped') && queue.active === 0 && queue.queued === 0);
  assert.deepEqual(tasks.map(task => task.hongguoInfo.vid_index), [...expected].reverse(), 'Persisted insertion order must exercise the reversed resume regression');
  const ids = tasks.map(task => task.id);
  receipt.phases.push({ action: 'submit-pause', count: 2, persistedOrder: tasks.map(task => task.hongguoInfo.vid_index) });

  result.stage = 'app-download-resume-and-pause';
  await beginPhase(true);
  assert.equal((await api('window.electronAPI.resumeAll()')).count, 2);
  tasks = await settle((tasks, queue) => tasks.every(task => task.status === 'stopped') && queue.active === 0 && queue.queued === 0);
  assert.equal((await api('window.__downloadAcceptance.pause')).count, 2);
  let events = await api('window.__downloadAcceptance.events');
  receipt.phases.push({ action: 'resume-pause', started: assertOrder(events, tasks, [expected[0]], 'started'), completed: assertOrder(events, tasks, [], 'completed') });

  result.stage = 'app-download-retry-reversed';
  await beginPhase(false);
  const retried = await api(`window.electronAPI.retryTasks(${JSON.stringify(ids)})`);
  assert.equal(retried.success, true);
  assert.equal(retried.count, 2);
  tasks = await settle((tasks, queue) => tasks.every(task => task.status === 'completed' && !task.temporaryDownloads?.length) && queue.active === 0 && queue.queued === 0);
  events = await api('window.__downloadAcceptance.events');
  receipt.phases.push({ action: 'retry-reversed', requested: [...expected].reverse(), started: assertOrder(events, tasks, expected, 'started'), completed: assertOrder(events, tasks, expected, 'completed'), events });
  assert.equal(receipt.temporaryIdentities.length, 2, 'Both real tasks must expose exact persisted temporary-file identities');
  assert.deepEqual(tasks.map(task => task.id), ids, 'Pause/resume/retry must reuse the original persistent task IDs');
  const seriesEpisodes = await api(`window.electronAPI.getSeriesEpisodes(${JSON.stringify(series.series_id)})`);
  assert.equal(seriesEpisodes.success, true);
  for (const index of expected) {
    const episode = seriesEpisodes.data.episodes.find(item => item.vid_index === index);
    assert.equal(episode?.status, 'completed', 'Completed App queue task must return a playable episode');
    assert.match(episode.fileUrl, /^hongguo-local:\/\/f\/[0-9a-f-]{36}$/i, 'Completed App queue task must return an opaque media capability');
  }
  receipt.seriesEpisodes = seriesEpisodes.data.episodes
    .filter(episode => expected.includes(episode.vid_index))
    .map(episode => ({ index: episode.vid_index, status: episode.status, fileUrl: episode.fileUrl }));
  const files = [];
  for (const episode of episodes) {
    const task = tasks.find(task => task.hongguoInfo.vid === episode.vid);
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', task.savePath], { encoding: 'utf8', windowsHide: true }));
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    assert(video && video.width > 0 && video.height > 0 && Number(probe.format.duration) > 15, 'App must produce a full real episode');
    assert(probe.streams.some(stream => stream.codec_type === 'audio'));
    execFileSync(ffmpeg, ['-v', 'error', '-i', task.savePath, '-t', '3', '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
    assert(!fs.readdirSync(path.dirname(task.savePath)).some(name => name.startsWith('.hongguo-download-')), 'Completed App downloads must clean their temporary directories');
    receipt.media.push({ taskId: task.id, index: episode.vid_index, actualQuality: task.actualQuality, bytes: fs.statSync(task.savePath).size,
      sha256: createHash('sha256').update(fs.readFileSync(task.savePath)).digest('hex'), width: video.width, height: video.height, duration: Number(probe.format.duration), videoCodec: video.codec_name });
    files.push(task.savePath);
  }
  await api('window.__downloadAcceptance.dispose.forEach(remove => remove())');
  result.stage = 'app-fast-conversion-real-input';
  const original = tasks.find(task => task.hongguoInfo.vid_index === expected[0]);
  const originalMedia = receipt.media.find(media => media.taskId === original.id);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const request = { requestId: 'windows-fast-conversion-' + original.id, filePath: original.savePath,
    seriesId: original.hongguoInfo.series_id, vid: original.hongguoInfo.vid,
    vidIndex: original.hongguoInfo.vid_index, force: false, quality: 'auto' };
  const trial = receipt.fastConversionTrial = { tested: false, index: request.vidIndex, originalSha256: originalMedia.sha256 };
  try {
    const enabled = await api(`window.electronAPI.saveSettings({ fast_conversion: true })`);
    assert.equal(enabled.success, true);
    assert.equal((await api('window.electronAPI.getSettings()')).fast_conversion, true, 'High-performance setting must read back as boolean true');
    await api(`(() => {
      const request = ${JSON.stringify(request)};
      const state = window.__fastConversionTrial = { done: false, result: null, notices: [] };
      state.remove = window.electronAPI.onTranscodeProgress(event => {
        if (event.requestId === request.requestId && event.notice && state.notices.at(-1) !== event.notice) state.notices.push(event.notice);
      });
      window.electronAPI.transcodeForPlayback(request).then(result => {
        state.result = { success: result.success, cached: result.cached, fastConversion: result.fastConversion,
          encoder: result.encoder, hardwareFallbackReason: result.hardwareFallbackReason, size: result.size };
      }).catch(() => { state.result = { success: false }; }).finally(() => { state.done = true; });
      return true;
    })()`);
    let state;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      state = await api('({ done: window.__fastConversionTrial.done, result: window.__fastConversionTrial.result, notices: window.__fastConversionTrial.notices })');
      if (state.done) break;
      await delay(200);
    }
    if (!state?.done) {
      await api(`(() => { window.electronAPI.cancelTranscodeForPlayback(${JSON.stringify(request)}).catch(() => {}); return true; })()`);
      throw new Error('Actual App high-performance conversion exceeded 180 seconds; cancellation requested');
    }
    const actual = assertFastTrial(state.result, state.notices);
    const converted = path.join(path.dirname(dataFile), 'compat-cache', `${request.seriesId}_${String(request.vidIndex).padStart(3, '0')}.mp4`);
    assert.notEqual(path.resolve(converted), path.resolve(original.savePath));
    assert.equal(fs.statSync(converted).size, state.result.size, 'Probed output must match the App conversion result');
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', converted], { encoding: 'utf8', windowsHide: true, timeout: 30000 }));
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video?.codec_name, 'h264');
    assert.equal(video.width, originalMedia.width); assert.equal(video.height, originalMedia.height);
    assert(Math.abs(Number(probe.format.duration) - originalMedia.duration) < 1, 'App conversion must preserve the full episode duration');
    assert(probe.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    execFileSync(ffmpeg, ['-v', 'error', '-i', converted, '-t', '3', '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
    assert.equal(hash(original.savePath), originalMedia.sha256, 'High-performance conversion must preserve the original App download');
    Object.assign(trial, { tested: true, encoder: state.result.encoder, hardwareFallbackReason: state.result.hardwareFallbackReason || null,
      ...actual, notices: state.notices, size: state.result.size, sha256: hash(converted), width: video.width, height: video.height,
      duration: Number(probe.format.duration), decodedSeconds: 3, originalUnchanged: true });
    result.checks.push('Final portable EXE high-performance setting: one registered real download converts through native IPC, reports actual GPU/CPU fallback, produces full H.264/AAC media, decodes three seconds and preserves the original');
  } finally {
    await api('window.__fastConversionTrial?.remove?.()');
    const restored = await api('window.electronAPI.saveSettings({ fast_conversion: false })');
    assert.equal(restored.success, true);
    assert.equal((await api('window.electronAPI.getSettings()')).fast_conversion, false, 'High-performance setting must return to its original disabled state');
    trial.settingRestored = true;
  }
  receipt.tested = true;
  result.checks.push('Final portable EXE native IPC: real two-episode queue, persistent pause/resume and reversed batch retry start/complete in episode order; completed tasks rebind to playable episode capabilities; exact temporary identities match disk, full media probes/decodes and cleans up');
  delete result.stage;
  return files;
};

if (require.main === module) {
  const tasks = [1, 2].map(index => ({ id: String(index), hongguoInfo: { vid_index: index } }));
  const events = [1, 2].map(index => ({ id: String(index), kind: 'started' }));
  assert.deepEqual(assertOrder(events, tasks, [1, 2], 'started'), [1, 2]);
  assert.throws(() => assertOrder([...events].reverse(), tasks, [1, 2], 'started'), /must follow episode order/);
  assert.throws(() => assertOrder([...events, events[0]], tasks, [1, 2], 'started'), /must follow episode order/);
  assert.equal(assertFastTrial({ success: true, fastConversion: true, encoder: 'h264_nvenc' }, ['正在使用显卡加速转换']).hardwareUsed, true);
  assert.equal(assertFastTrial({ success: true, fastConversion: true, encoder: 'libx264', hardwareFallbackReason: 'unavailable' }, ['显卡加速不可用，已回退CPU转换']).hardwareUsed, false);
  assert.equal(assertFastTrial({ success: true, fastConversion: true, encoder: 'libx264', hardwareFallbackReason: 'encoder-failed' }, ['正在使用显卡加速转换', '显卡加速失败，已回退CPU转换']).hardwareUsed, false);
  assert.throws(() => assertFastTrial({ success: true, fastConversion: true, encoder: 'libx264' }, []), /explicitly explain/);
  assert.throws(() => assertFastTrial({ success: true, fastConversion: true, encoder: 'h264_nvenc' }, []), /honestly report/);
  assert.throws(() => assertFastTrial({ success: true, fastConversion: true, encoder: 'h264_nvenc', cached: true }, ['正在使用显卡加速转换']), /previous cache/);
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hongguo-receipt-check-'));
  try {
    const directory = fs.mkdtempSync(path.join(root, '.hongguo-download-'));
    const input = path.join(directory, 'input.enc.tmp');
    fs.writeFileSync(input, 'identity check only, no media');
    const identity = file => {
      const stat = fs.lstatSync(file, { bigint: true });
      return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
    };
    const task = { id: 'task', savePath: path.join(root, 'episode.mp4'), hongguoInfo: { series_id: 'series', vid: 'vid', vid_index: 1 } };
    const record = { owner: { taskId: 'task', seriesId: 'series', vid: 'vid', vidIndex: 1, savePath: task.savePath }, directory,
      identity: identity(directory), files: { 'input.enc.tmp': identity(input) } };
    assert.equal(inspectReceipt(record, task, root).length, 2);
    assert.throws(() => inspectReceipt({ ...record, identity: { ...record.identity, ino: Number(record.identity.ino) } }, task, root), /string/);
    assert.throws(() => inspectReceipt({ ...record, files: { 'input.enc.tmp': { ...record.files['input.enc.tmp'], ino: '9007199254740993' } } }, task, root), /must match/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('Windows download acceptance self-check: PASS (order/identity guards; GPU/CPU notice and metadata consistency; rejects silent fallback and cached proof)');
}
