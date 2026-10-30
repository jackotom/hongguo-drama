import { useEffect, useRef, useState } from 'react';

export default function useStealthWindow() {
  const [stealthMode, setStealthMode] = useState(false);
  const [stealthError, setStealthError] = useState('');
  const resume = useRef(null);
  const concealed = useRef(false);
  const busy = useRef(false);
  useEffect(() => window.electronAPI.onBossKeyState?.(() => { resume.current = null; }), []);
  const toggleStealth = async enabled => {
    if (busy.current) return;
    busy.current = true;
    setStealthError('');
    try {
      if (enabled && document.fullscreenElement) await document.exitFullscreen();
      if (enabled && document.pictureInPictureElement) await document.exitPictureInPicture?.();
      const result = await window.electronAPI.setStealthMode(enabled);
      if (!result?.success) throw new Error(result?.error || '小窗切换失败，请重试');
    } catch (error) { setStealthError(error.message); }
    finally { busy.current = false; }
  };
  useEffect(() => window.electronAPI.onStealthState(state => {
    setStealthMode(state.enabled);
    concealed.current = state.concealed;
    const video = document.querySelector('main[data-page="player"] video');
    if (state.concealed) {
      resume.current = video && !video.paused && !video.ended ? { video, source: video.currentSrc } : null;
      video?.pause();
    } else {
      const saved = resume.current;
      resume.current = null;
      if (saved && saved.video === video && saved.source === video.currentSrc && video.isConnected) {
        video.play().catch(() => setStealthError('已恢复窗口，请点击播放继续'));
      }
    }
  }), []);
  useEffect(() => {
    const guardPlayback = event => {
      const video = event.target;
      if (!concealed.current || !video.matches?.('main[data-page="player"] video')) return;
      resume.current = { video, source: video.currentSrc };
      video.pause();
    };
    document.addEventListener('play', guardPlayback, true);
    return () => document.removeEventListener('play', guardPlayback, true);
  }, []);
  useEffect(() => {
    if (!stealthMode) return;
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation();
      void toggleStealth(false);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [stealthMode]);
  return { stealthMode, toggleStealth, stealthError };
}
