import { useCallback, useEffect, useRef, useState } from 'react';

export default function useFloatingPlayer(title, onChange, onBeforeMove) {
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'player-floating-host';
    return element;
  });
  const [floating, setFloating] = useState(false);
  const slot = useRef(null);
  const popup = useRef(null);
  const latestTitle = useRef(title);
  latestTitle.current = title;
  const disposing = useRef(false);
  const pendingRestore = useRef(null);
  const lastAspectRatio = useRef(null);

  const syncAspectRatio = useCallback(event => {
    if (!popup.current || popup.current.closed) return;
    const video = host.querySelector('video');
    if (!video || (event && event.target !== video) || video.readyState === 0) return;
    const { videoWidth: width, videoHeight: height } = video;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const ratio = width / height;
    const send = window.electronAPI?.setFloatingPlayerAspectRatio;
    if (typeof send === 'function' && ratio !== lastAspectRatio.current) {
      send(width, height);
      lastAspectRatio.current = ratio;
    }
  }, [host]);

  useEffect(() => {
    host.addEventListener('loadedmetadata', syncAspectRatio, true);
    host.addEventListener('resize', syncAspectRatio, true);
    return () => {
      host.removeEventListener('loadedmetadata', syncAspectRatio, true);
      host.removeEventListener('resize', syncAspectRatio, true);
    };
  }, [host, syncAspectRatio]);

  const moveHost = useCallback(destination => {
    const video = host.querySelector('video');
    const snapshot = video ? { currentTime: video.currentTime, paused: video.paused, muted: video.muted,
      volume: video.volume, rate: video.playbackRate, source: video.currentSrc || video.src } : null;
    pendingRestore.current?.();
    if (snapshot) {
      onBeforeMove?.(snapshot);
      video.pause();
      const restore = () => {
        if (video.src !== snapshot.source && video.currentSrc !== snapshot.source) return;
        video.muted = snapshot.muted;
        video.volume = snapshot.volume;
        video.playbackRate = snapshot.rate;
        if (video.readyState > 0) {
          try { video.currentTime = snapshot.currentTime; } catch (_) {}
          if (!snapshot.paused) video.play().catch(() => {});
        }
      };
      video.addEventListener('loadedmetadata', restore, { once: true });
      pendingRestore.current = () => video.removeEventListener('loadedmetadata', restore);
      destination.appendChild(host);
      restore();
    } else destination.appendChild(host);
  }, [host, onBeforeMove]);

  const attachSlot = useCallback(element => {
    slot.current = element;
    if (element && !popup.current) element.appendChild(host);
  }, [host]);

  const toggle = useCallback(() => {
    if (popup.current && !popup.current.closed) { popup.current.close(); return; }
    const child = window.open('about:blank', 'hongguo-floating-player', 'popup,width=420,height=740');
    if (!child) throw new Error('无法打开悬浮窗，请重试');
    popup.current = child;
    const restore = () => {
      if (popup.current !== child) return;
      popup.current = null;
      lastAspectRatio.current = null;
      if (slot.current) moveHost(slot.current);
      if (!disposing.current) { setFloating(false); onChange?.(false); }
    };
    child.addEventListener('beforeunload', restore);
    child.addEventListener('pagehide', restore);
    try {
      child.document.title = latestTitle.current;
      child.document.documentElement.dataset.theme = document.documentElement.dataset.theme || 'light';
      for (const stylesheet of document.querySelectorAll('link[rel="stylesheet"], style')) {
        const copy = stylesheet.cloneNode(true);
        if (stylesheet.href) copy.href = stylesheet.href;
        child.document.head.appendChild(copy);
      }
      const style = child.document.createElement('style');
      style.textContent = 'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}.player-floating-host{display:block;width:100%;height:100%}.player-floating-host>.player-stage{position:relative;inset:auto;width:100%;height:100%;min-width:0;min-height:0;max-height:none;aspect-ratio:auto;border-radius:0;margin:0}.player-controls-row{flex-wrap:wrap;gap:4px}.player-controls-volume input{width:48px}';
      child.document.head.appendChild(style);
      moveHost(child.document.body);
      setFloating(true);
      onChange?.(true);
      syncAspectRatio();
      child.focus();
    } catch (error) {
      restore(); child.close();
      throw new Error('悬浮窗初始化失败，请重试', { cause: error });
    }
  }, [host, onChange, moveHost, syncAspectRatio]);

  useEffect(() => {
    if (popup.current && !popup.current.closed) popup.current.document.title = title;
  }, [title]);

  useEffect(() => {
    disposing.current = false;
    return () => {
      disposing.current = true;
      popup.current?.close();
      pendingRestore.current?.();
    };
  }, []);

  return { host, attachSlot, floating, toggle };
}
