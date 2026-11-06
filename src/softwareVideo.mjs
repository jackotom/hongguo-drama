// Feed decoded frames/audio to a real video element, so fullscreen, PiP and frame capture still work.
export function attachSoftwareVideo(video, loadPlayer, wasmBaseUrl) {
  const nativePlay = video.play.bind(video), nativePause = video.pause.bind(video);
  const removeAttribute = video.removeAttribute.bind(video);
  let session, source = '', rate = video.playbackRate || 1, seeking = false, ended = false, error = null;
  let destroyed = false, desiredPlayback = false, playPromise, playIntent = 0;
  const emit = name => video.dispatchEvent(new Event(name));
  const current = state => !destroyed && session === state && !state?.failed;
  const bounded = promise => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('软件解码启动超时，请重试或切回自动解码')), 20000);
    })]).finally(() => clearTimeout(timer));
  };
  // AVPlayer's seek/pause/play are asynchronous; keep the native element's synchronous controls ordered.
  const enqueue = (state, action) => {
    const pending = (state?.operations || state?.ready || Promise.resolve()).then(() => {
      if (!current(state) || !state?.loaded) throw new DOMException('Playback cancelled', 'AbortError');
      return bounded(action());
    });
    if (state) state.operations = pending.catch(() => {});
    return pending;
  };
  const fail = (state, reason) => {
    if (!current(state)) return;
    state.position = video.currentTime;
    state.failed = true;
    desiredPlayback = false; playIntent++; nativePause();
    release(state);
    error = { code: 3, message: reason?.message || '软件解码失败，请切回自动解码或尝试转码播放' };
    emit('error');
  };
  const release = state => {
    if (!state) return;
    if (state.released) return state.released;
    state.stream?.getTracks().forEach(track => track.stop());
    state.released = state.player ? bounded(state.player.destroy()).catch(() => {}) : Promise.resolve();
    return state.released;
  };
  const load = nextSource => {
    source = nextSource || '';
    desiredPlayback = false; playIntent++; ended = false; error = null; seeking = false; playPromise = null;
    nativePause(); video.srcObject = null;
    const previous = session;
    const state = session = { source, player: null, stream: null };
    const released = release(previous);
    emit('emptied');
    state.ready = bounded((async () => {
      await released;
      if (!state.source || !current(state)) return;
      const AVPlayer = await loadPlayer();
      if (!current(state)) return;
      state.stream = new MediaStream();
      const player = state.player = new AVPlayer({ container: state.stream, wasmBaseUrl,
        enableHardware: false, enableWebCodecs: false, enableWebGPU: false,
        enableWorker: true, checkUseMSE: () => false });
      player.on('time', () => {
        if (!current(state)) return;
        if (desiredPlayback && !video.paused && !seeking) state.position = null;
        emit('timeupdate');
      });
      player.on('seeking', () => { if (current(state)) { seeking = true; emit('seeking'); } });
      player.on('seeked', () => { if (current(state)) { seeking = false; emit('seeked'); emit('timeupdate'); } });
      player.on('ended', () => {
        if (!current(state)) return;
        ended = true; desiredPlayback = false; playIntent++; nativePause(); emit('timeupdate'); emit('ended');
      });
      player.on('error', reason => fail(state, reason));
      player.setVolume(1);
      player.setPlaybackRate(rate);
      await player.load(state.source, { ext: 'mp4', isLive: false });
      if (!current(state)) return;
      state.duration = Number(player.getDuration()) / 1000;
      state.loaded = true;
      emit('durationchange'); emit('loadedmetadata');
    })());
    state.ready.catch(reason => fail(state, reason));
  };
  const descriptors = {
    src: { get: () => source, set: value => { source = value || ''; } },
    currentSrc: { get: () => session?.source || '' },
    duration: { get: () => session?.duration || 0 },
    currentTime: { get: () => session?.position ?? (session?.loaded ? Number(session.player.currentTime) / 1000 : 0), set: value => {
      if (!Number.isFinite(value) || value < 0) return;
      const state = session;
      if (state) state.position = value;
      if (state) state.resumeAt = null;
      ended = false;
      enqueue(state, () => state.player.seek(BigInt(Math.round(value * 1000)))).catch(reason => fail(state, reason));
    } },
    playbackRate: { get: () => rate, set: value => {
      if (!Number.isFinite(value) || value < 0.25 || value > 4) return;
      rate = value; session?.player?.setPlaybackRate(value); emit('ratechange');
    } },
    seeking: { get: () => seeking },
    ended: { get: () => ended },
    error: { get: () => error },
    load: { value: () => load(source) },
    play: { value: () => {
      desiredPlayback = true;
      if (playPromise?.intent === playIntent) return playPromise.pending;
      const state = session;
      const intent = playIntent;
      const pending = enqueue(state, async () => {
        if (!desiredPlayback || intent !== playIntent) throw new DOMException('Playback cancelled', 'AbortError');
        if (ended) { ended = false; await state.player.seek(0n); }
        else if (state.resumeAt != null) {
          const position = state.resumeAt; state.resumeAt = null;
          await state.player.seek(BigInt(Math.round(position * 1000)));
        }
        // Tracks are added by play(); attach the stream first to consume the first generated frame.
        if (video.srcObject !== state.stream) video.srcObject = state.stream;
        await bounded(state.player.play());
        if (!current(state) || !desiredPlayback || intent !== playIntent) { await state.player.pause(); throw new DOMException('Playback cancelled', 'AbortError'); }
        return nativePlay();
      });
      playPromise = { pending, intent };
      pending.catch(reason => { if (reason.name !== 'AbortError') fail(state, reason); });
      pending.finally(() => { if (playPromise?.pending === pending) playPromise = null; }).catch(() => {});
      return pending;
    } },
    pause: { value: () => {
      const position = video.currentTime;
      desiredPlayback = false; playIntent++; nativePause();
      const state = session;
      if (state?.loaded) { state.position = position; state.resumeAt = position; }
      if (state) enqueue(state, () => state.player.pause()).catch(() => {});
    } },
    removeAttribute: { value: name => { if (name === 'src') source = ''; removeAttribute(name); } },
  };
  for (const descriptor of Object.values(descriptors)) descriptor.configurable = true;
  Object.defineProperties(video, descriptors);
  return { load, destroy() {
    destroyed = true; desiredPlayback = false;
    nativePause(); video.srcObject = null;
    release(session);
    for (const name of Object.keys(descriptors)) delete video[name];
  } };
}
