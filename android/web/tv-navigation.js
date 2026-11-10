function nextFocus(rects, current, key) {
  if (!rects.length) return -1;
  if (current < 0 || !rects[current]) return 0;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const origin = rects[current];
  const cx = (origin.left + origin.right) / 2, cy = (origin.top + origin.bottom) / 2;
  let best = current, score = Infinity;
  rects.forEach((rect, index) => {
    const dx = (rect.left + rect.right) / 2 - cx, dy = (rect.top + rect.bottom) / 2 - cy;
    const forward = (horizontal ? dx : dy) * sign;
    if (forward <= 1) return;
    const overlap = horizontal
      ? rect.top < origin.bottom && rect.bottom > origin.top
      : rect.left < origin.right && rect.right > origin.left;
    const distance = forward + Math.abs(horizontal ? dy : dx) * 3 + (overlap ? 0 : 10000);
    if (distance < score) { best = index; score = distance; }
  });
  return best;
}

function handleMediaKey(video, key, repeat) {
  if (!video || !['MediaPlayPause','MediaPlay','MediaPause','MediaFastForward','MediaRewind'].includes(key)) return false;
  if (repeat && !['MediaFastForward','MediaRewind'].includes(key)) return true;
  if (key === 'MediaPause' || (key === 'MediaPlayPause' && !video.paused)) video.pause();
  else if (key === 'MediaPlay' || key === 'MediaPlayPause') video.play().catch(() => {});
  else if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + (key === 'MediaFastForward' ? 10 : -10)));
  return true;
}

function focusIdentity(el, seriesId = '') {
  if (!el) return '';
  const data = el.dataset || {};
  if (data.vid) return `episode:${seriesId}:${data.vid}`;
  if (data.series) return `series:${data.series}`;
  if (data.tab) return `tab:${data.tab}`;
  if (data.category) return `category:${data.category}`;
  return el.id ? `id:${el.id}` : '';
}

function restoreFocusIndex(keys, wanted, previous = []) {
  const exact = keys.indexOf(wanted);
  if (exact >= 0) return exact;
  const old = previous.indexOf(wanted);
  if (old >= 0) for (let offset = 1; offset < previous.length; offset++) {
    for (const neighbor of [previous[old + offset],previous[old - offset]]) {
      const index = keys.indexOf(neighbor);
      if (index >= 0) return index;
    }
  }
  return keys.length ? 0 : -1;
}

function keepsInputKey(active, key, composing, keyCode) {
  const tag = active?.tagName?.toUpperCase();
  return Boolean(composing || keyCode === 229 || (tag === 'SELECT' && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter',' ','Escape'].includes(key)) ||
    (['INPUT','TEXTAREA'].includes(tag) && ['ArrowLeft','ArrowRight'].includes(key)));
}

function currentVideo(stage) {
  if (!stage?.isConnected || !stage.dataset.playbackId || !stage.dataset.vid ||
      !['decoding','playing','paused','ended'].includes(stage.dataset.playbackState)) return null;
  const video = stage.querySelector('video');
  return video?.isConnected && video.dataset.playbackId === stage.dataset.playbackId &&
    video.dataset.vid === stage.dataset.vid ? video : null;
}

function routeMediaKey(stage, key, repeat, pausePlayback) {
  if (!stage?.isConnected || !stage.dataset.playbackId || !stage.dataset.vid ||
      !['preparing','decoding','playing','paused','ended'].includes(stage.dataset.playbackState) ||
      !['MediaPlayPause','MediaPlay','MediaPause','MediaFastForward','MediaRewind'].includes(key)) return false;
  if (repeat && !['MediaFastForward','MediaRewind'].includes(key)) return true;
  const video = currentVideo(stage);
  // Pause intent must survive preparation even before a video can emit pause.
  if (key === 'MediaPause' || (!video && key === 'MediaPlayPause')) pausePlayback();
  else if (video) handleMediaKey(video,key,repeat);
  return true;
}

module.exports = {nextFocus, handleMediaKey, focusIdentity, restoreFocusIndex, keepsInputKey, currentVideo, routeMediaKey};
