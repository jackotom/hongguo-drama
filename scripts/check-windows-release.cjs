// Run the 4.4 portable EXE on disposable Windows CI with isolated, real Hongguo footage and muted audio.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const pkg = require('../package.json');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist/windows-verification');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-windows-'));
const packaged = path.join(root, 'dist/win-unpacked');
const profile = path.join(temp, 'profile');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(profile);
const skipPlayback = process.argv.includes('--skip-playback');
const result = { version: pkg.version, hostPlatform: process.platform, hostArch: process.arch, signed: false, playbackTested: false, checks: [] };
let child, socket, seq = 0;
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function pe64(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.toString('ascii', 0, 2), 'MZ');
  const pe = data.readUInt32LE(0x3c);
  assert.equal(data.readUInt32LE(pe), 0x4550);
  assert.equal(data.readUInt16LE(pe + 4), 0x8664, path.basename(file));
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method + (result.stage ? ' [' + result.stage + ']' : ''))); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const reply = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}
function attachCdpResponses(ws) {
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (call) message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
  });
}
async function clickControl(label) {
  result.stage = 'pointer-control-' + label;
  const point = await evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
    button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  delete result.stage;
}
async function keyHandoff(key, code, expectedSource) {
  result.stage = 'shortcut-handoff-' + key;
  await cdp('Page.bringToFront');
  assert(await evaluate('!document.querySelector("video").paused && getComputedStyle(document.querySelector(".player-controls")).opacity === "0"'), 'Key handoff must begin during hidden-controls playback');
  await evaluate(`(() => {
    const video = document.querySelector('video');
    const originalSource = video.currentSrc;
    window.__keyHandoff = { key: ${JSON.stringify(key)}, trusted: false, ended: false, sourceChanged: false, nextPlaying: false, frames: 0, visibleFrames: 0, fullscreenLost: false };
    const result = window.__keyHandoff;
    const keydown = event => { if (event.key === result.key) result.trusted = event.isTrusted; };
    const ended = () => { result.ended = true; };
    window.addEventListener('keydown', keydown, true);
    video.addEventListener('ended', ended);
    window.__keyHandoffDone = (async () => {
      const deadline = performance.now() + 8000;
      try {
        while (performance.now() < deadline) {
          if (await window.__verificationNextFrame()) result.frames++;
          const controls = getComputedStyle(document.querySelector('.player-controls'));
          if (Number(controls.opacity) > 0 || controls.pointerEvents !== 'none') result.visibleFrames++;
          if (document.fullscreenElement !== document.querySelector('.player-stage')) result.fullscreenLost = true;
          result.sourceChanged ||= !!video.currentSrc && video.currentSrc !== originalSource;
          result.nextPlaying = result.sourceChanged && !video.paused && video.readyState >= 2 && video.currentTime > 0.7;
          if (result.nextPlaying) break;
        }
        result.source = video.currentSrc;
        result.visibility = document.visibilityState;
        return result;
      } finally {
        window.removeEventListener('keydown', keydown, true);
        video.removeEventListener('ended', ended);
      }
    })();
    return true;
  })()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
  const state = await evaluate('window.__keyHandoffDone');
  assert(state.trusted && !state.ended && state.sourceChanged && state.nextPlaying, 'Real shortcut must switch without natural ended: ' + JSON.stringify(state));
  assert(state.frames > 0 && state.visibleFrames === 0 && !state.fullscreenLost, 'Shortcut must retain hidden controls/fullscreen every sampled frame: ' + JSON.stringify(state));
  if (expectedSource) assert.equal(state.source, expectedSource, key + ' must select the expected episode');
  delete result.stage;
  return state;
}

async function realFootage(mediaDir, ffmpeg) {
  const native = require('../src/native/hongguo');
  const catalog = await require('../src/native/hongguo-app-catalog').browseList({ category: 'hot-real-drama' });
  assert(catalog.success && catalog.results.length, 'Real Hongguo catalog unavailable; do not substitute footage');
  const drama = catalog.results[Math.floor(Math.random() * catalog.results.length)];
  const series = await native.fetchEpisodeList(drama.series_id);
  assert(series.episodes.length >= 2, 'Real acceptance drama needs two episodes');
  const start = Math.floor(Math.random() * Math.min(10, series.episodes.length - 1));
  const episodes = series.episodes.slice(start, start + 2), samples = [];
  for (const [index, episode] of episodes.entries()) {
    const info = await native.fetchPlayUrlSingle(episode.vid, series.series_id, { force: true, quality: '1080p' });
    assert(info.url, 'Real Hongguo episode source unavailable: ' + JSON.stringify(info.sources?.map(({source,code}) => ({source,code}))));
    const encrypted = path.join(mediaDir, `original-${index}.mp4`);
    try {
      const config = {
        ...(info.source === 'web' ? require('../src/native/web-media-guard').webMediaRequestOptions(info.url) : {}),
        headers: { 'User-Agent': info.userAgent || native.UA, 'Accept-Encoding': 'identity',
          ...((info.referer || info.source === 'web') ? { Referer: info.referer || native.WEB_REFERER } : {}) },
        responseType: 'arraybuffer', timeout: 60000, maxContentLength: 128 * 1024 * 1024,
      };
      let response;
      try { response = await require('axios').get(info.url, config); }
      catch (error) {
        if (info.source !== 'app' || error.response?.status !== 403) throw error;
        // Match the application's bounded CDN Referer fallback.
        config.headers.Referer = native.VIDEO_REFERER;
        response = await require('axios').get(info.url, config);
      }
      assert(response.data.byteLength > 0);
      fs.writeFileSync(encrypted, response.data);
    } catch (error) { throw new Error('Real Hongguo acceptance download failed (' + (Number(error.response?.status) || error.code || 'unknown') + '); no media URL logged'); }
    const sample = path.join(mediaDir, `windows-sample-${index + 1}.mp4`);
    const key = info.contentKey || (info.spadeA ? native.deriveKey(info.spadeA)?.toString('hex') : '');
    const decoded = spawnSync(ffmpeg, ['-y', '-v', 'error', ...(key ? ['-decryption_key', key] : []),
      '-i', encrypted, '-t', '15', '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=640:-2,setsar=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sample],
      { timeout: 60000, windowsHide: true, stdio: 'pipe' });
    assert.equal(decoded.status, 0, 'Real Hongguo acceptance video could not be decoded');
    fs.unlinkSync(encrypted);
    samples.push(sample);
  }
  result.realMedia = { seriesId: series.series_id, title: series.series_title,
    episodes: episodes.map(episode => ({ vid: episode.vid, index: episode.vid_index })),
    downloadedFromOfficialSource: true, muted: true, durationPerSampleSeconds: 15 };
  return samples;
}
(async () => {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  const portable = path.join(root, `dist/${pkg.build.productName}-${pkg.version.replace(/^(\d+\.\d+)\.0$/, '$1')}-便携版.exe`);
  result.authenticode = execFileSync('pwsh.exe', ['-NoProfile', '-Command', '(Get-AuthenticodeSignature -LiteralPath $env:HONGGUO_VERIFY_EXE).Status.ToString()'], { encoding: 'utf8', env: { ...process.env, HONGGUO_VERIFY_EXE: portable } }).trim();
  assert.equal(result.authenticode, 'NotSigned');
  const exe = path.join(packaged, pkg.build.productName + '.exe');
  const ffmpeg = path.join(packaged, 'resources/bin/ffmpeg.exe');
  const ffprobe = path.join(packaged, 'resources/bin/ffprobe.exe');
  for (const file of [exe, ffmpeg, ffprobe]) pe64(file);
  result.checks.push('Portable payload: Electron/FFmpeg/FFprobe are PE x64');
  // Real portable startup: copy the single-file EXE elsewhere, launch it without
  // --user-data-dir, then verify the running app reports the program-relative
  // configMode/dataDir and actually persists a setting into data/data.json.
  const portableDataRoot = path.join(temp, 'portable-data');
  fs.mkdirSync(portableDataRoot, { recursive: true });
  const portableCopy = path.join(portableDataRoot, path.basename(portable));
  fs.copyFileSync(portable, portableCopy);
  const portablePort = 9438;
  const isolatedAppData = path.join(temp, 'portable-appdata');
  fs.mkdirSync(isolatedAppData, { recursive: true });
  const portableChild = spawn(portableCopy, ['--mute-audio', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + portablePort], { stdio: 'ignore', env: { ...process.env, APPDATA: isolatedAppData } });
  try {
    let target;
    for (let i = 0; i < 150; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${portablePort}/json`)).json()).find(t => t.type === 'page' && t.url.startsWith('file:')); } catch {}
      if (target) break;
      await delay(200);
    }
    assert(target, 'Portable EXE without --user-data-dir did not open its renderer');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    attachCdpResponses(socket);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    for (let i = 0; i < 100; i++) {
      if (await evaluate('Boolean(window.electronAPI && document.querySelector("#root")?.children.length)')) break;
      await delay(100);
    }
    const info = await evaluate('window.electronAPI.getAppInfo()');
    const expectedDataDir = path.resolve(path.join(portableDataRoot, 'data')).toLowerCase();
    assert.equal(info.configMode, 'portable', 'Portable app must report configMode=portable');
    assert.equal(path.resolve(info.dataDir).toLowerCase(), expectedDataDir, 'Portable app must use the program-relative data directory');
    const saved = await evaluate(`(async () => {
      const settings = await window.electronAPI.getSettings();
      const next = Number(settings.max_concurrent) === 5 ? 6 : 5;
      settings.max_concurrent = next;
      settings.proxy_enabled = false;
      settings.app_updates_enabled = false;
      const result = await window.electronAPI.saveSettings(settings);
      return { result, expected: next };
    })()`);
    assert(saved?.result?.success !== false, 'Portable settings save must succeed');
    const expectedFile = path.join(portableDataRoot, 'data', 'data.json');
    for (let i = 0; i < 50 && !fs.existsSync(expectedFile); i++) await delay(100);
    assert(fs.existsSync(expectedFile), 'Portable save must create data/data.json next to the program');
    assert.equal(JSON.parse(fs.readFileSync(expectedFile, 'utf8')).settings.max_concurrent, saved.expected, 'Portable save must persist the requested setting');
    result.checks.push('Portable EXE without --user-data-dir reports program-relative config and persists settings there');
  } finally {
    try { socket?.close(); } catch {}
    socket = null;
    try { execFileSync('taskkill', ['/PID', String(portableChild.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
  await delay(800);

  for (const file of ['LICENSE.txt', 'NOTICE.txt', 'THIRD-PARTY-NOTICES.md', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources/bin/WINDOWS-NOTICE.txt', 'resources/bin/WINDOWS-X264-LICENSE.txt', 'resources/bin/WINDOWS-MINGW-LICENSE.txt', 'resources/bin/WINDOWS-GCC-LICENSE.txt', 'resources/bin/COPYING.GPLv3']) assert(fs.statSync(path.join(packaged, file)).size > 20, file);
  result.checks.push('Application, Electron, Chromium, FFmpeg and x264 notices present');
  result.ffmpeg = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0];
  const mediaDir = path.join(temp, 'media');
  fs.mkdirSync(mediaDir);
  const sid = 'windows-smoke';
  let fixtureEpisodes = [];
  if (!skipPlayback) {
    const samples = await realFootage(mediaDir, ffmpeg);
    result.realMedia.samples = [];
    for (const sample of samples) {
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', sample], { encoding: 'utf8', windowsHide: true }));
      assert(probe.streams.some(s => s.codec_name === 'h264'));
      assert(probe.streams.some(s => s.codec_name === 'aac'));
      const video = probe.streams.find(s => s.codec_type === 'video');
      assert(video.width === 640 && video.height > 0);
      result.realMedia.samples.push({ width: video.width, height: video.height });
    }
    result.checks.push('Bundled FFmpeg decodes two real downloaded Hongguo episodes to H.264/AAC; FFprobe reads output');
    fixtureEpisodes = samples.map((savePath, index) => ({ id: `fixture-${index + 1}`, status: 'completed', savePath, hongguoInfo: { series_id: sid, series_title: 'Windows verification', vid: `fixture-${index + 1}`, vid_index: index + 1 } }));
  }
  // Keep remote notices from covering trusted pointer playback checks in this disposable profile.
  fs.writeFileSync(path.join(profile, 'data.json'), JSON.stringify({ announcement: { preferences: { normalEnabled: false, emergencyEnabled: false } }, settings: { root: mediaDir, watch_updates_enabled: false, watch_sequels_enabled: false, cache_next_episode: false }, tasks: fixtureEpisodes, series: skipPlayback ? [] : [{ series_id: sid, series_title: 'Windows verification', episodes: fixtureEpisodes.map(task => ({ ...task.hongguoInfo, title: 'Real Hongguo acceptance footage' })) }] }));
  child = spawn(portable, ['--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--user-data-dir=' + profile, '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9439', '--autoplay-policy=no-user-gesture-required'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 150; i++) {
    try { target = (await (await fetch('http://127.0.0.1:9439/json')).json()).find(t => t.type === 'page' && t.url.startsWith('file:')); } catch {}
    if (target) break;
    await delay(200);
  }
  assert(target, 'Packaged application did not open its renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  attachCdpResponses(socket);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  await cdp('Page.bringToFront');
  await evaluate(`(() => {
    window.__verificationNextFrame = () => new Promise(resolve => {
      const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, 100);
      const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(true); });
    });
    return true;
  })()`);
  for (let i = 0; i < 50; i++) {
    if (await evaluate('Boolean(window.electronAPI && document.querySelector("#root")?.children.length)')) break;
    await delay(100);
  }
  const info = await evaluate('window.electronAPI.getAppInfo()');
  assert.equal(info.version, pkg.version); assert.equal(info.platform, 'win32');
  assert.equal(await evaluate('document.title'), /^zh/i.test(info.systemLocale) ? '红果短剧' : 'Hongguo Drama');
  await evaluate(`(async () => {
    localStorage.setItem('hongguo:language', 'zh-CN');
    window.dispatchEvent(new StorageEvent('storage', { key: 'hongguo:language' }));
    const deadline = Date.now() + 5000;
    while (document.documentElement.lang !== 'zh-CN') {
      if (Date.now() > deadline) throw Error('Interface language did not switch');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
  const settings = await evaluate('window.electronAPI.getSettings()');
  assert.equal(settings.root, mediaDir, 'Temporary profile must isolate all user state');
  assert.deepEqual(await evaluate('window.electronAPI.getAnnouncementPreferences()'), { normalEnabled: false, emergencyEnabled: false }, 'Disposable playback profile must opt out of remote notices');
  assert(await evaluate('!document.querySelector(".announcement-dialog")'), 'Remote notice must not cover playback controls');
  assert(await evaluate('document.querySelector("#root").children.length > 0'));
  const media = await evaluate('window.electronAPI.getFfmpegStatus()');
  assert(media.available);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(hash(media.ffmpeg), hash(ffmpeg)); assert.equal(hash(media.ffprobe), hash(ffprobe));
  assert.notEqual(media.ffmpeg, ffmpeg, 'Must run the self-extracted portable EXE, not win-unpacked');
  result.checks.push('Single-file portable EXE opens; matching version; isolated profile; extracted media matches payload');
  if (skipPlayback) {
    assert(await evaluate('Array.from(document.querySelectorAll("video")).every(video => video.paused && !video.currentSrc)'), 'Playback skip must leave all video elements unloaded and paused');
    result.skipReason = 'Playback verification explicitly skipped because the required user fixture is unavailable; no substitute footage was used.';
    result.passed = true;
    console.log('Windows release startup smoke: PASS (' + result.checks.length + ' checks; playback NOT TESTED)');
    return;
  }
  const qualityUi = await evaluate(`(async () => {
    const waitFor = async (check) => {
      for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
      throw new Error('Download quality settings UI did not reach the expected state');
    };
    [...document.querySelectorAll('.sidebar-item')].find(b => b.textContent.trim() === '设置').click();
    await waitFor(() => document.querySelector('#default-download-quality'));
    const select = document.querySelector('#default-download-quality');
    const initial = select.value;
    const options = [...select.options].map(o => ({ value: o.value, label: o.textContent }));
    select.value = '1080p'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelector('.settings-footer [role="status"]'));
    document.querySelector('.settings-footer button').click();
    await waitFor(() => document.querySelector('.settings-footer button').textContent.includes('已保存'));
    const saved = (await window.electronAPI.getSettings()).download_quality;
    return { initial, options, saved };
  })()`);
  assert.deepEqual(qualityUi, { initial: 'auto', options: [
    { value: 'auto', label: '自动（兼容优先）' }, { value: '1080p', label: '1080P' }, { value: '720p', label: '720P' },
  ], saved: '1080p' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'data.json'), 'utf8')).settings.download_quality, '1080p');
  const qualityScreenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'portable-windows-download-quality.png'), Buffer.from(qualityScreenshot.data, 'base64'));
  assert.equal((await evaluate(`(async () => {
    const current = await window.electronAPI.getSettings();
    return window.electronAPI.saveSettings({ ...current, download_quality: 'auto' });
  })()`)).success, true);
  result.downloadQuality = { ...qualityUi, persistedToIsolatedProfile: true, restoredDefault: 'auto', realPlatformDownloadTested: false };
  result.checks.push('Actual single-file EXE: download quality settings offer auto/1080p/720p; UI saves 1080p to isolated profile; default restored without platform download');
  assert.equal((await evaluate('window.electronAPI.setWindowLayout("portrait")')).success, true);
  assert.equal(await evaluate('window.electronAPI.getWindowLayout()'), 'portrait');
  assert.equal(await evaluate('window.electronAPI.setAlwaysOnTop(true)'), true);
  assert.equal(await evaluate('window.electronAPI.setAlwaysOnTop(false)'), false);
  assert((await evaluate('window.electronAPI.setEpisodePanelOpen(true)')) >= 0);
  await evaluate('window.electronAPI.setEpisodePanelOpen(false)');
  assert.equal((await evaluate('window.electronAPI.setWindowLayout("landscape")')).success, true);
  result.checks.push('Portrait/landscape, always-on-top and integrated episode panel');
  const episodes = await evaluate(`window.electronAPI.getSeriesEpisodes(${JSON.stringify(sid)})`);
  assert(episodes.success && episodes.data.episodes[0].fileUrl);
  for (const episode of episodes.data.episodes) {
    assert.match(episode.fileUrl, /^hongguo-local:\/\/f\/[0-9a-f-]{36}$/i, 'IPC must issue opaque media capabilities');
  }
  const rangeRead = await evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(episodes.data.episodes[0].fileUrl)}, { headers: { Range: 'bytes=0-31' } });
    return { status: response.status, length: (await response.arrayBuffer()).byteLength };
  })()`);
  assert.deepEqual(rangeRead, { status: 206, length: 32 }, 'Packaged renderer must read media Range through CORS using the IPC-issued URL');
  result.mediaCapability = { opaque: true, rendererRangeRead: rangeRead };
  result.stage = 'play-series-request';
  result.playSeries = await evaluate(`window.electronAPI.playSeries({seriesId:${JSON.stringify(sid)}, vidIndex:1})`);
  assert.equal(result.playSeries.success, true);
  result.stage = 'playback-readiness-and-progress';
  const played = await evaluate(`(async () => {
    const deadline = performance.now() + 12000;
    let playRequested = false;
    while (performance.now() < deadline) {
      const v = document.querySelector('video');
      window.__windowsPlaybackProbe = { present: !!v, time: v?.currentTime, width: v?.videoWidth, height: v?.videoHeight,
        readyState: v?.readyState, networkState: v?.networkState, paused: v?.paused, error: v?.error?.message,
        visibility: document.visibilityState, remainingMs: Math.max(0, deadline - performance.now()) };
      if (v?.readyState >= 2) {
        v.muted = true;
        if (v.paused && !playRequested) {
          const button = document.querySelector('[aria-label="播放"]');
          if (button) { button.click(); playRequested = true; }
        }
        if (v.currentTime > 0.5) return { time: v.currentTime, width: v.videoWidth, height: v.videoHeight, error: v.error?.message };
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Player did not advance past 0.5s within 12s: ' + JSON.stringify(window.__windowsPlaybackProbe));
  })()`);
  assert(played.time > 0.5 && played.width === result.realMedia.samples[0].width
    && played.height === result.realMedia.samples[0].height, JSON.stringify(played));
  result.playback = played;
  delete result.stage;
  const canvasRead = await evaluate(`(() => {
    const video = document.querySelector('video');
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 2, 2);
    return { crossOrigin: video.crossOrigin, bytes: context.getImageData(0, 0, 2, 2).data.length };
  })()`);
  assert.deepEqual(canvasRead, { crossOrigin: 'anonymous', bytes: 16 }, 'CORS video must remain origin-clean for visual enhancements');
  result.mediaCapability.originCleanCanvas = true;
  const paused = await evaluate(`(async () => { document.querySelector('[aria-label="暂停"]').click(); await new Promise(r=>setTimeout(r,100)); return document.querySelector('video').paused; })()`);
  assert.equal(paused, true);
  result.checks.push('Actual application player plays real Hongguo H.264/AAC through local protocol with forced mute; pause control works');
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'portable-windows-playback.png'), Buffer.from(screenshot.data, 'base64'));
  await clickControl('全屏');
  await delay(500);
  assert(await evaluate('document.fullscreenElement === document.querySelector(".player-stage")'), 'Player must enter native fullscreen');
  await clickControl('播放');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
  await delay(2400);
  const hidden = await evaluate('getComputedStyle(document.querySelector(".player-controls")).opacity === "0" && getComputedStyle(document.querySelector(".player-controls")).pointerEvents === "none" && !document.querySelector("video").paused');
  assert(hidden, 'Fullscreen playback must hide idle controls');
  const fullscreenScreenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'portable-windows-fullscreen-hidden.png'), Buffer.from(fullscreenScreenshot.data, 'base64'));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 120 });
  await delay(250);
  assert(await evaluate('getComputedStyle(document.querySelector(".player-controls")).opacity === "1"'), 'Pointer movement must restore fullscreen controls');
  await clickControl('暂停');
  await delay(2400);
  assert(await evaluate('document.querySelector("video").paused && getComputedStyle(document.querySelector(".player-controls")).opacity === "1"'), 'Paused fullscreen controls must stay visible');
  await clickControl('播放');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
  await delay(2400);
  assert(await evaluate('getComputedStyle(document.querySelector(".player-controls")).opacity === "0"'), 'Resumed fullscreen playback must hide idle controls again');
  const firstSource = await evaluate('document.querySelector("video").currentSrc');
  result.shortcutHandoffs = [];
  const down = await keyHandoff('ArrowDown', 'ArrowDown');
  result.shortcutHandoffs.push(down);
  result.shortcutHandoffs.push(await keyHandoff('ArrowUp', 'ArrowUp', firstSource));
  await evaluate(`(() => {
    localStorage.setItem('hongguo:preview:playback-shortcuts:v1', JSON.stringify({ play: 'space', backward: 'arrowleft', forward: 'arrowright', previous: 'k', next: 'j', autoNext: 'a', slower: 's', faster: 'd', fullscreen: 'f' }));
    window.dispatchEvent(new Event('hongguo:playback-shortcuts-changed'));
    return true;
  })()`);
  await delay(100);
  result.shortcutHandoffs.push(await keyHandoff('j', 'KeyJ', down.source));
  result.shortcutHandoffs.push(await keyHandoff('k', 'KeyK', firstSource));
  await evaluate(`(() => {
    localStorage.removeItem('hongguo:preview:playback-shortcuts:v1');
    window.dispatchEvent(new Event('hongguo:playback-shortcuts-changed'));
    return true;
  })()`);
  result.shortcutHandoffs.push(await keyHandoff('ArrowDown', 'ArrowDown', down.source));
  result.shortcutHandoffs.push(await keyHandoff('ArrowUp', 'ArrowUp', firstSource));
  const shortcutScreenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'portable-windows-shortcut-hidden.png'), Buffer.from(shortcutScreenshot.data, 'base64'));
  result.checks.push('Actual single-file EXE: trusted default ArrowDown/ArrowUp and custom J/K switch episodes without ended; expected episode returns; every sampled frame retains hidden controls and fullscreen');
  result.stage = 'automatic-handoff-frame-sampling';
  const automaticHandoff = await evaluate(`(async () => {
    const video = document.querySelector('video');
    const originalSource = video.currentSrc;
    const result = { ended: false, sourceChanged: false, nextPlaying: false, frames: 0, visibleFrames: 0, fullscreenLost: false };
    const ended = () => { result.ended = true; };
    video.addEventListener('ended', ended, { once: true });
    // Seeking near the end lets the real media ended event drive Player's automatic next-episode path.
    video.currentTime = video.duration - 0.3;
    const deadline = performance.now() + 8000;
    try {
      while (performance.now() < deadline) {
        if (await window.__verificationNextFrame()) result.frames++;
        const controls = getComputedStyle(document.querySelector('.player-controls'));
        if (Number(controls.opacity) > 0 || controls.pointerEvents !== 'none') result.visibleFrames++;
        if (document.fullscreenElement !== document.querySelector('.player-stage')) result.fullscreenLost = true;
        result.sourceChanged ||= !!video.currentSrc && video.currentSrc !== originalSource;
        result.nextPlaying = result.sourceChanged && !video.paused && video.readyState >= 2 && video.currentTime > 0.7;
        if (result.nextPlaying) break;
      }
      result.source = video.currentSrc;
      return result;
    } finally { video.removeEventListener('ended', ended); }
  })()`);
  assert(automaticHandoff.ended && automaticHandoff.sourceChanged && automaticHandoff.nextPlaying, JSON.stringify(automaticHandoff));
  assert(automaticHandoff.frames > 0 && automaticHandoff.visibleFrames === 0 && !automaticHandoff.fullscreenLost, 'Automatic next episode must keep fullscreen controls hidden: ' + JSON.stringify(automaticHandoff));
  assert.equal(automaticHandoff.source, down.source, 'Automatic next after default ArrowUp must select the following episode');
  result.automaticHandoff = automaticHandoff;
  delete result.stage;
  const handoffScreenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'portable-windows-auto-next-hidden.png'), Buffer.from(handoffScreenshot.data, 'base64'));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 120 });
  await delay(250);
  assert(await evaluate('getComputedStyle(document.querySelector(".player-controls")).opacity === "1"'), 'Pointer movement after automatic next episode must restore controls');
  result.checks.push('Actual single-file EXE: after default ArrowUp returns to the previous episode, natural ended advances through Player to the expected second real Hongguo episode; every sampled frame retains hidden controls and fullscreen; pointer movement restores controls');
  await clickControl('退出全屏');
  await delay(2400);
  assert(await evaluate('!document.fullscreenElement && !document.querySelector("video").paused && getComputedStyle(document.querySelector(".player-controls")).opacity === "0"'), 'Ordinary landscape must hide idle controls after exiting fullscreen');
  const pointerPoints = await evaluate(`(() => {
    const rect = document.querySelector('.player-stage').getBoundingClientRect();
    const inside = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const outside = [{ x: 2, y: 2 }, { x: innerWidth - 2, y: 2 }, { x: 2, y: innerHeight - 2 }]
      .find(p => p.x < rect.left || p.x > rect.right || p.y < rect.top || p.y > rect.bottom);
    return { inside, outside };
  })()`);
  assert(pointerPoints.outside, 'Ordinary landscape must expose a point outside the player');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointerPoints.inside });
  await delay(250);
  assert(await evaluate('getComputedStyle(document.querySelector(".player-controls")).opacity === "1"'), 'Ordinary landscape controls must be visible before pointer leave');
  await evaluate('window.__pointerLeaveStarted = performance.now()');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointerPoints.outside });
  const pointerLeave = await evaluate(`(async () => {
    await new Promise(resolve => setTimeout(resolve, 250));
    const style = getComputedStyle(document.querySelector('.player-controls'));
    return { elapsedMs: performance.now() - window.__pointerLeaveStarted, hidden: style.opacity === '0' && style.pointerEvents === 'none', playing: !document.querySelector('video').paused };
  })()`);
  assert(pointerLeave.elapsedMs < 1000 && pointerLeave.hidden && pointerLeave.playing, 'Leaving the player must finish hiding within one second while playback continues: ' + JSON.stringify(pointerLeave));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointerPoints.inside });
  await delay(250);
  assert(await evaluate('getComputedStyle(document.querySelector(".player-controls")).opacity === "1"'), 'Returning to the ordinary landscape player must restore controls');
  result.fullscreenControls = { idleHidden: true, pointerRestores: true, pausedVisible: true, resumedHidden: true, landscapeIdleHidden: true, landscapePointerLeave: pointerLeave, landscapePointerReturnRestores: true };
  result.checks.push('Actual single-file EXE: fullscreen and ordinary landscape idle hide controls; landscape pointer leave hides within one second and return restores; pause keeps visible; resume hides');
  result.playbackTested = true;
  result.passed = true;
  console.log('Windows release smoke: PASS (' + result.checks.length + ' checks)');
})().catch(error => { result.passed = false; result.error = error.stack; console.error(error.stack); process.exitCode = 1; })
  .finally(() => {
    socket?.close();
    if (child?.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  });
