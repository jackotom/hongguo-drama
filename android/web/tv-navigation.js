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

module.exports = {nextFocus, handleMediaKey};
