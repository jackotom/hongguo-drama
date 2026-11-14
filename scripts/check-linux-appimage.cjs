// Launch the actual AppImage in a disposable directory (run under xvfb-run in CI).
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { connect, sleep } = require('./fixtures/cdp.cjs');
const pkg = require('../package.json');
const { safeError } = require('../server/storage.cjs');

function safeDownloadFailure(value) {
  if (!value || typeof value !== 'object') return null;
  const clean = text => safeError({ message: String(text ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:(?:\/\/|\\\/\\\/)[^\s"'<>）]+/gi, '[来源地址]')
    .replace(/(?:[a-z]:[\\/]|\\\\|\/)[^\s"'<>）]+/gi, '[路径]')
    .replace(/\b(?:authorization|cookie|set-cookie)\b["']?\s*[:=][^\r\n]*/gi, '[凭据]')
    .replace(/\b(?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|account(?:[_-]?id)?|user(?:[_-]?(?:id|name))?|uid|email|phone|device[_-]?id|install[_-]?id|iid|did|session[_-]?id|decryption[_-]?key)\b["']?\s*[:=]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s;,}\]]+)/gi, '[凭据]')
    .replace(/\b(?:Basic\s+\S+|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|gh[pousr]_[a-z0-9]+|github_pat_[a-z0-9_]+|sk-[a-z0-9_-]+|\d{8,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/gi, '[凭据]') });
  return { seriesId: /^\d{1,30}$/.test(String(value.seriesId)) ? String(value.seriesId) : null,
    title: clean(value.title), episode: Number.isInteger(value.episode) && value.episode > 0 ? value.episode : null,
    status: ['failed', 'stopped'].includes(value.status) ? value.status : 'unknown', error: clean(value.error) };
}

(async () => {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const dist = path.resolve(__dirname, '../dist');
  const images = fs.readdirSync(dist).filter(name => name.endsWith('.AppImage'));
  assert.equal(images.length, 1, 'Keep one AppImage candidate in dist');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-linux-'));
  const output = path.join(dist, 'linux-verification'); fs.mkdirSync(output, { recursive: true });
  const result = { version: pkg.version, sourceCommit: process.env.GITHUB_SHA, passed: false, checks: [] };
  let child, cdp;
  try {
    const image = path.join(dist, images[0]);
    assert.equal(fs.readFileSync(image).readUInt16LE(18), 62, 'AppImage runtime must also be x86_64');
    const emulated = process.argv.includes('--emulated-appimage');
    // shortcut: ARM Docker binfmt does not recognize AppImage's AI2 ELF padding; explicitly run the unchanged image in QEMU.
    execFileSync(emulated ? '/usr/bin/qemu-x86_64-static' : image,
      emulated ? [image, '--appimage-extract'] : ['--appimage-extract'], { cwd: temp, stdio: 'pipe', timeout: 60000 });
    result.execution = emulated ? 'Linux x64 under QEMU on ARM host' : 'Linux x64';
    const folder = path.join(temp, 'squashfs-root');
    const launcher = fs.readFileSync(path.join(folder, 'AppRun'), 'utf8');
    assert.match(launcher, /exec "\$APPDIR\/hongguo-drama" "\$@"/);
    assert.doesNotMatch(launcher, /NO_SANDBOX|NO_SANDBOX=\(/);
    const desktop = fs.readdirSync(folder).find(name => name.endsWith('.desktop'));
    assert.doesNotMatch(fs.readFileSync(path.join(folder, desktop), 'utf8'), /^Exec=.*--no-sandbox/m);
    for (const tool of ['ffmpeg', 'ffprobe', 'librempeg']) execFileSync(path.join(folder, 'resources/bin', tool), ['-version'], { stdio: 'pipe', timeout: 15000 });
    result.checks.push('Actual AppImage extraction and all three bundled media executables');
    const net = require('node:net'), server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const log = fs.openSync(path.join(output, 'launch.log'), 'w');
    child = spawn(path.join(folder, 'AppRun'), ['--mute-audio', '--user-data-dir=' + path.join(temp, 'profile'),
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
      ...(emulated ? ['--disable-gpu', '--in-process-gpu', '--no-zygote', '--single-process'] : []),
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])], { cwd: folder, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    cdp = await connect(port);
    await cdp.evaluate(`(async()=>{const deadline=Date.now()+15000;while(!document.querySelector('.sidebar-item')){if(Date.now()>deadline)throw Error('AppImage interface initialization timed out');await new Promise(resolve=>setTimeout(resolve,50));}})()`);
    const info = await cdp.evaluate('window.electronAPI.getAppInfo()');
    assert.equal(info.version, pkg.version);
    assert.equal(await cdp.evaluate('document.title'), /^zh/i.test(info.systemLocale) ? '红果短剧' : 'Hongguo Drama');
    await cdp.evaluate(`(async () => {
    localStorage.setItem('hongguo:language', 'zh-CN');
    window.dispatchEvent(new StorageEvent('storage', { key: 'hongguo:language' }));
    const deadline = Date.now() + 5000;
    while (document.documentElement.lang !== 'zh-CN') {
      if (Date.now() > deadline) throw Error('Interface language did not switch');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
    const assets = await cdp.evaluate(`(async()=>{
      const module=await import(new URL('software/avplayer/avplayer.js',document.baseURI).href);
      const bytes=await (await fetch(new URL('software/decode/hevc-simd.wasm',document.baseURI))).arrayBuffer();
      return {player:typeof module.default,wasm:WebAssembly.validate(bytes)};
    })()`);
    assert.equal(assets.player, 'function'); assert.equal(assets.wasm, true);
    result.checks.push(`AppImage launches its UI and reports ${pkg.version}; packaged CPU player and HEVC Wasm load`);
    // Keep all real downloads inside this disposable profile's media directory.
    assert.equal((await cdp.evaluate(`(async()=>{const settings=await window.electronAPI.getSettings();
      return window.electronAPI.saveSettings({...settings,root:${JSON.stringify(path.join(temp,'media'))}});})()`)).success,true);
    result.realPlayback = await cdp.evaluate(`(async()=>{
      window.__hongguoRealDownloadFailure=null;
      const api=window.electronAPI;
      const catalog=await api.browseList({source:'hongguo',category:'hot-real-drama'});
      if(!catalog.success||!catalog.results?.length)throw Error('Real Hongguo catalog unavailable');
      localStorage.setItem('hongguo:online-quality','compat');
      localStorage.setItem('hongguo:software-decode','true');
      let lastFailure='no playable pair';
      const dramas=[...catalog.results].sort(()=>Math.random()-0.5).slice(0,6);
      for(const drama of dramas){
        const resolved=await api.searchResolve(drama.series_id);
        if(!resolved.success||String(resolved.data?.series_id)!==String(drama.series_id)){lastFailure='Real drama registration failed';continue}
        const unlocked=resolved.data.episodes.filter(ep=>!ep.locked);
        if(unlocked.length<2)continue;
        const start=Math.floor(Math.random()*unlocked.length);
        const episodes=[...unlocked.slice(start),...unlocked.slice(0,start)].slice(0,10);
        const states=[];
        for(const episode of episodes){
          if(states.length===2)break;
          try{
            const queued=await api.downloadSingleEpisode(drama.series_id,episode.vid_index,'auto');
            if(!queued.success)throw Error('Real Hongguo download submission failed');
            const deadline=performance.now()+120000;
            let downloaded;
            while(performance.now()<deadline){
              const tasks=await api.getDownloadTasks();
              const task=tasks.find(item=>String(item.hongguoInfo?.vid)===String(episode.vid));
              if(task?.status==='completed'&&task.receivedBytes>0){downloaded=task;break;}
              if(task&&['failed','stopped'].includes(task.status)){
                window.__hongguoRealDownloadFailure={seriesId:String(drama.series_id),title:drama.series_title,
                  episode:episode.vid_index,status:task.status,error:String(task.error||'')};
                throw Error('Real download failed or stopped');
              }
              await new Promise(resolve=>setTimeout(resolve,200));
            }
            if(!downloaded)throw Error('Real complete download timed out');
            const previous=document.querySelector('.player-video')?.currentSrc;
            const opened=await api.playSeries({seriesId:drama.series_id,vidIndex:episode.vid_index});
            if(!opened.success)throw Error('Real episode could not open');
            const playDeadline=performance.now()+60000;
            let requested=false,played=false;
            while(performance.now()<playDeadline){
              const video=document.querySelector('.player-video');
              if(video){
                video.muted=true;video.volume=0;
                if(video.currentSrc&&video.currentSrc!==previous&&video.readyState>=2){
                  if(!requested){requested=true;await video.play();}
                  if(video.currentTime>=10){
                    video.pause();
                    const state={episode:episode.vid_index,vid:episode.vid,bytes:downloaded.receivedBytes,
                      actualQuality:downloaded.actualQuality,time:video.currentTime,width:video.videoWidth,height:video.videoHeight,
                      muted:video.muted,volume:video.volume,paused:video.paused,error:video.error?.code||null,
                      frames:video.getVideoPlaybackQuality().totalVideoFrames,decoder:document.querySelector('select[aria-label="解码方式"]')?.value};
                    if(!state.width||!state.height||!state.frames||state.error||!state.muted||state.volume!==0)throw Error('Real playback validation failed');
                    states.push(state);played=true;break;
                  }
                }
              }
              await new Promise(resolve=>setTimeout(resolve,100));
            }
            if(!played){
              const video=document.querySelector('.player-video');video?.pause();
              throw Error('Real local playback did not advance to ten seconds: '+JSON.stringify({episode:episode.vid_index,
                time:video?.currentTime,width:video?.videoWidth,readyState:video?.readyState,paused:video?.paused,error:video?.error?.code,
                decoder:document.querySelector('select[aria-label="解码方式"]')?.value,visibility:document.visibilityState}));
            }
          }catch(error){
            lastFailure=error.message;
          }
        }
        if(states.length===2){
          return {seriesId:drama.series_id,title:drama.series_title,completeDownloads:true,downloadedFromOfficialSource:true,states};
        }
      }
      throw Error('No two playable real episodes in six dramas: '+lastFailure);
    })()`, 420000);
    assert.equal(result.realPlayback.states.length, 2);
    result.checks.push('Fresh random Hongguo episodes 1 and 2: real source preparation and ten seconds muted playback each');
    result.passed = true;
    console.log('PASS actual Linux AppImage: media tools, launch, software assets and two real muted episodes');
  } catch (error) {
    result.error = error.message;
    if (cdp) try {
      const failure = safeDownloadFailure(await cdp.evaluate('window.__hongguoRealDownloadFailure || null', 5000));
      if (failure) result.realDownloadFailure = failure;
    } catch {}
    throw error;
  }
  finally {
    cdp?.close(); child?.kill('SIGTERM'); await sleep(250);
    fs.writeFileSync(path.join(output, 'appimage-result.json'), JSON.stringify(result, null, 2) + '\n');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
