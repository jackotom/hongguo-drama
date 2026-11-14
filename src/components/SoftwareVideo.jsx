import React, { useLayoutEffect, useRef } from 'react';
import { attachSoftwareVideo } from '../softwareVideo.mjs';

let playerModule;
const loadPlayer = async () => {
  playerModule ||= import(/* @vite-ignore */ new URL('software/avplayer/avplayer.js', document.baseURI).href);
  return (await playerModule).default;
};

export default function SoftwareVideo({ videoRef, src, onBeforeDestroy, ...props }) {
  const elementRef = useRef(null);
  const controller = useRef(null);
  const onBeforeDestroyRef = useRef(onBeforeDestroy);
  onBeforeDestroyRef.current = onBeforeDestroy;
  useLayoutEffect(() => {
    const video = elementRef.current;
    videoRef.current = video;
    controller.current = attachSoftwareVideo(video, loadPlayer, new URL('software', document.baseURI).href.replace(/\/$/, ''));
    return () => {
      // Save the decoder-clock position before destroy removes the currentTime accessor.
      onBeforeDestroyRef.current?.();
      controller.current.destroy();
      controller.current = null;
      if (videoRef.current === video) videoRef.current = null;
    };
  }, [videoRef]);
  useLayoutEffect(() => { controller.current.load(src); }, [src]);
  return <video {...props} ref={elementRef} />;
}
