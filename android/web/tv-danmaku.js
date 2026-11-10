import { fetchDanmaku, setDeviceIdentityFile } from '../../src/native/danmaku.js';
import { createOfficialFeed, appendOfficialPage, advanceTimedDanmaku, resolveDanmakuStatus, lowerBoundTime } from '../../src/components/danmakuOfficial.mjs';
import { normalizeDanmakuSettings, resizeDanmaku } from '../../src/components/danmakuModel.mjs';
import { currentVideo } from './tv-navigation.js';

export function connectTvDanmaku() {
  setDeviceIdentityFile('danmaku.identity');
  const content = document.querySelector('#content');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let binding, disposed = false, generation = 0;
  let enabled = true, settings = normalizeDanmakuSettings({ density: 'sparse' });

  function owns(owner) {
    return !disposed && binding === owner && content.isConnected &&
      content.dataset.seriesId === owner.feed.seriesId && content.querySelector('#stage') === owner.stage &&
      currentVideo(owner.stage) === owner.video && owner.stage.dataset.playbackId === owner.id &&
      owner.stage.dataset.vid === owner.feed.vid;
  }
  function stop(owner) {
    cancelAnimationFrame(owner.frame); owner.frame = 0; owner.lastTime = undefined;
  }
  function cancelRequest(owner) {
    owner.request?.abort(); owner.request = undefined; owner.generation = ++generation; owner.feed.loading = false;
  }
  function clear(owner) {
    const state = owner.feed.animation;
    state.items = []; state.replayQueue = []; state.cooldown = 0;
    // Explicit TV seeks discard old trajectories, including the shared model's replay supply.
    state.lastTime = owner.video.currentTime;
    state.cursor = lowerBoundTime(owner.feed.groupedDanmaku || [], owner.video.currentTime);
    owner.nodes.clear(); owner.items.replaceChildren(); owner.lastTime = undefined;
  }
  function unbind() {
    if (!binding) return;
    const old = binding; binding = undefined;
    cancelRequest(old); stop(old);
    for (const [name, handler] of Object.entries(old.events)) old.video.removeEventListener(name, handler);
    old.resize.disconnect(); old.layer.remove();
  }
  function options(owner) {
    const rect = owner.stage.getBoundingClientRect();
    const controls = content.querySelector('#tv-controls');
    const controlRect = controls && !controls.hidden ? controls.getBoundingClientRect() : null;
    const bottomInset = controlRect && controlRect.top < rect.bottom && controlRect.bottom > rect.top
      ? Math.max(0, rect.bottom - controlRect.top + 8) : 0;
    return { width: rect.width, height: rect.height, settings, reducedMotion: motion.matches, bottomInset };
  }
  function paint(owner) {
    const live = new Set();
    for (const item of owner.feed.animation.items) {
      live.add(item.id);
      let node = owner.nodes.get(item.id);
      if (!node) {
        node = document.createElement('span'); node.className = 'tv-danmaku-item';
        node.textContent = item.text; node.style.color = item.color || '#FFFFFF';
        owner.nodes.set(item.id, node); owner.items.append(node);
      }
      node.style.transform = `translate(${item.x}px, ${item.y}px)`;
    }
    for (const [id, node] of owner.nodes) if (!live.has(id)) { node.remove(); owner.nodes.delete(id); }
  }
  function status(owner) {
    const feed = owner.feed;
    const value = resolveDanmakuStatus({ source: 'official', supported: true, enabled,
      active: owns(owner), visible: !document.hidden, ...feed, count: feed.danmaku.length });
    if (owner.status.textContent !== value) owner.status.textContent = value;
    const hidden = !enabled || document.hidden || owner.video.dataset.frameReady !== 'true' ||
      Boolean(feed.danmaku.length && !feed.error && !feed.partial && !feed.truncated);
    if (owner.status.hidden !== hidden) owner.status.hidden = hidden;
  }
  function canAnimate(owner) {
    return owns(owner) && enabled && !document.hidden && owner.video.dataset.frameReady === 'true' &&
      !owner.video.paused && !owner.video.ended && !owner.video.seeking && owner.video.readyState >= 2;
  }
  function start(owner) {
    if (!owner.frame && canAnimate(owner)) owner.frame = requestAnimationFrame(() => tick(owner));
  }
  function tick(owner) {
    owner.frame = 0;
    if (!owns(owner)) { sync(); return; }
    if (!canAnimate(owner)) { stop(owner); return; }
    const time = owner.video.currentTime;
    const delta = owner.lastTime === undefined ? 0 : Math.max(0, time - owner.lastTime);
    owner.lastTime = time;
    advanceTimedDanmaku(owner.feed.animation, owner.feed.groupedDanmaku || [], time, delta, options(owner));
    paint(owner); start(owner);
  }
  function resize(owner) {
    if (!owns(owner)) return;
    const next = options(owner), before = owner.layout;
    if (!before || before.width !== next.width || before.height !== next.height || before.bottomInset !== next.bottomInset ||
        before.reducedMotion !== next.reducedMotion) {
      if (before) resizeDanmaku(owner.feed.animation, before, next);
      owner.layout = next; paint(owner);
    }
  }
  async function load(owner) {
    if (!owns(owner) || !enabled || document.hidden || owner.video.dataset.frameReady !== 'true' || owner.video.ended ||
        owner.feed.loaded || owner.feed.loading) return;
    const controller = new AbortController(), version = ++generation;
    owner.request = controller; owner.generation = version; owner.feed.loading = true; status(owner);
    try {
      const data = await fetchDanmaku({ seriesId: owner.feed.seriesId, vid: owner.feed.vid, signal: controller.signal });
      if (!owns(owner) || controller.signal.aborted || version !== owner.generation) return;
      appendOfficialPage(owner.feed, data);
    } catch {
      if (!owns(owner) || controller.signal.aborted || version !== owner.generation) return;
      owner.feed.loaded = true; owner.feed.error = '弹幕加载失败，可关闭后再开启重试';
    } finally {
      if (owns(owner) && !controller.signal.aborted && version === owner.generation) {
        owner.request = undefined; owner.feed.loading = false; status(owner); start(owner);
      }
    }
  }
  function bind(stage, video, seriesId) {
    const layer = document.createElement('div'); layer.className = 'tv-danmaku';
    const items = document.createElement('div'); items.setAttribute('aria-hidden', 'true');
    const notice = document.createElement('span'); notice.className = 'tv-danmaku-status'; notice.setAttribute('role', 'status');
    layer.append(items, notice);
    const owner = binding = { stage, video, id: stage.dataset.playbackId, feed: createOfficialFeed(seriesId, stage.dataset.vid),
      layer, items, status: notice, nodes: new Map(), frame: 0 };
    const update = () => { if (!owns(owner)) { sync(); return; } status(owner); load(owner); start(owner); };
    const pause = () => { if (!owns(owner)) { sync(); return; } stop(owner); };
    const seek = () => { if (!owns(owner)) { sync(); return; } stop(owner); clear(owner); start(owner); };
    const ended = () => { if (!owns(owner)) { sync(); return; } stop(owner); cancelRequest(owner); clear(owner); };
    owner.events = { loadedmetadata: update, loadeddata: update, canplay: update, playing: update, play: update,
      timeupdate: update, pause, waiting: pause, seeking: seek, seeked: seek, ended, error: update, emptied: ended };
    for (const [name, handler] of Object.entries(owner.events)) video.addEventListener(name, handler);
    owner.resize = new ResizeObserver(() => resize(owner)); owner.resize.observe(stage);
    stage.append(layer);
    return owner;
  }
  function sync() {
    if (disposed) return;
    const stage = content.querySelector('#stage'), video = currentVideo(stage), seriesId = content.dataset.seriesId;
    if (binding && !owns(binding)) unbind();
    if (!video || !/^\d{6,30}$/.test(seriesId || '') || !/^\d{6,30}$/.test(stage.dataset.vid)) return;
    const owner = binding || bind(stage, video, seriesId);
    if (!owner.layer.isConnected) stage.append(owner.layer);
    const hidden = !enabled || document.hidden || video.dataset.frameReady !== 'true';
    if (owner.layer.hidden !== hidden) owner.layer.hidden = hidden;
    owner.items.style.opacity = settings.opacity / 100; owner.items.style.fontSize = `${settings.fontSize}px`;
    resize(owner); status(owner); load(owner);
    if (canAnimate(owner)) start(owner); else stop(owner);
  }
  const observer = new MutationObserver(sync);
  observer.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: [
    'data-series-id', 'data-playback-id', 'data-vid', 'data-playback-state', 'data-frame-ready', 'hidden', 'class',
  ] });
  const disconnect = window.tvDanmaku.connect(preferences => {
    const changed = enabled !== preferences.enabled || settings.density !== preferences.density;
    enabled = preferences.enabled;
    settings = normalizeDanmakuSettings({ density: preferences.density });
    if (binding && changed) {
      stop(binding); clear(binding);
      if (!enabled) cancelRequest(binding);
      else if (binding.feed.error || binding.feed.partial) binding.feed = createOfficialFeed(binding.feed.seriesId, binding.feed.vid);
    }
    sync();
  });
  const visibility = () => { if (document.hidden && binding) { stop(binding); cancelRequest(binding); } sync(); };
  const reducedMotion = () => { if (binding) { stop(binding); clear(binding); } sync(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('resize', sync); motion.addEventListener('change', reducedMotion);
  function dispose() {
    disposed = true; observer.disconnect(); unbind(); disconnect();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('resize', sync); window.removeEventListener('pagehide', dispose);
    motion.removeEventListener('change', reducedMotion);
  }
  window.addEventListener('pagehide', dispose);
  return dispose;
}
