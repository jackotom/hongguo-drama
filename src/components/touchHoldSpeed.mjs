export function bindTouchHoldSpeed(video, changeRate, preferredRate) {
  const ownerDocument = video.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  let press = null, ignoreClickUntil = 0;
  const finish = event => {
    if (!press || event?.pointerId != null && event.pointerId !== press.id) return;
    const previous = press;
    press = null;
    clearTimeout(previous.timer);
    if (previous.active) {
      ignoreClickUntil = Date.now() + 500;
      changeRate(preferredRate(), true, false);
    }
  };
  const down = event => {
    if (!['touch', 'pen'].includes(event.pointerType)) return;
    if (event.isPrimary === false) { finish(); return; }
    if (press || event.button !== 0 || video.paused || video.ended) return;
    const current = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    press = current;
    current.timer = setTimeout(() => {
      if (press !== current || video.paused || video.ended) return;
      current.active = true;
      changeRate(2, true, false);
    }, 300);
  };
  const move = event => {
    if (press?.id === event.pointerId && (Math.abs(event.clientX - press.x) > 12 || Math.abs(event.clientY - press.y) > 12)) finish(event);
  };
  const hidden = () => { if (ownerDocument.hidden) finish(); };
  const contextMenu = event => event.preventDefault();
  const click = event => {
    if (Date.now() < ignoreClickUntil) { event.preventDefault(); event.stopPropagation(); }
  };
  video.addEventListener('pointerdown', down);
  video.addEventListener('pause', finish);
  video.addEventListener('contextmenu', contextMenu);
  video.addEventListener('click', click, true);
  video.addEventListener('dblclick', click, true);
  ownerWindow.addEventListener('pointermove', move, true);
  ownerWindow.addEventListener('pointerup', finish, true);
  ownerWindow.addEventListener('pointercancel', finish, true);
  ownerWindow.addEventListener('blur', finish);
  ownerDocument.addEventListener('visibilitychange', hidden);
  return () => {
    video.removeEventListener('pointerdown', down);
    video.removeEventListener('pause', finish);
    video.removeEventListener('contextmenu', contextMenu);
    video.removeEventListener('click', click, true);
    video.removeEventListener('dblclick', click, true);
    ownerWindow.removeEventListener('pointermove', move, true);
    ownerWindow.removeEventListener('pointerup', finish, true);
    ownerWindow.removeEventListener('pointercancel', finish, true);
    ownerWindow.removeEventListener('blur', finish);
    ownerDocument.removeEventListener('visibilitychange', hidden);
    finish();
  };
}
