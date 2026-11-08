// Launch the actual AppImage in a disposable directory (run under xvfb-run in CI).
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { connect, sleep } = require('./fixtures/cdp.cjs');
const pkg = require('../package.json');
(async () => {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const dist = path.resolve(__dirname, '../dist');
  const images = fs.readdirSync(dist).filter(name => name.endsWith('.AppImage'));
  assert.equal(images.length, 1, 'Keep one AppImage candidate in dist');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-linux-'));
  const output = path.join(dist, 'linux-verification'); fs.mkdirSync(output, { recursive: true });
  const result = { version: pkg.version, passed: false, checks: [] };
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
    assert.equal((await cdp.evaluate('window.electronAPI.getAppInfo()')).version, pkg.version);
    assert.equal(await cdp.evaluate('document.title'), '红果短剧');
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
      const api=window.electronAPI;
      const catalog=await api.browseList({source:'hongguo',category:'hot-real-drama'});
      if(!catalog.success||!catalog.results?.length)throw Error('Real Hongguo catalog unavailable');
      const drama=catalog.results[Math.floor(Math.random()*catalog.results.length)];
      const resolved=await api.searchResolve(drama.series_id);
      if(!resolved.success||String(resolved.data?.series_id)!==String(drama.series_id))throw Error('Real drama registration failed');
      const episodes=resolved.data.episodes.filter(ep=>!ep.locked).slice(0,2);
      if(episodes.length!==2)throw Error('Two unlocked real episodes required');
      const states=[];
      localStorage.setItem('hongguo:online-quality','compat');
      localStorage.setItem('hongguo:software-decode','true');
      for(const episode of episodes){
        const queued=await api.downloadSingleEpisode(drama.series_id,episode.vid_index,'auto');
        if(!queued.success)throw Error('Real Hongguo download submission failed');
        const deadline=performance.now()+120000;
        let downloaded;
        while(performance.now()<deadline){
          const tasks=await api.getDownloadTasks();
          const task=tasks.find(item=>String(item.hongguoInfo?.vid)===String(episode.vid));
          if(task?.status==='completed'&&task.receivedBytes>0){downloaded=task;break;}
          if(task&&['failed','stopped'].includes(task.status))throw Error('Real download failed or stopped');
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
      }
      return {seriesId:drama.series_id,title:drama.series_title,completeDownloads:true,downloadedFromOfficialSource:true,states};
    })()`, 420000);
    assert.equal(result.realPlayback.states.length, 2);
    result.checks.push('Fresh random Hongguo episodes 1 and 2: real source preparation and ten seconds muted playback each');
    result.passed = true;
    console.log('PASS actual Linux AppImage: media tools, launch, software assets and two real muted episodes');
  } catch (error) { result.error = error.message; throw error; }
  finally {
    cdp?.close(); child?.kill('SIGTERM'); await sleep(250);
    fs.writeFileSync(path.join(output, 'appimage-result.json'), JSON.stringify(result, null, 2) + '\n');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
