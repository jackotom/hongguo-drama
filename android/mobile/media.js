import { Buffer } from 'buffer/';
import request from '../web/transport.js';
import { fetchAppPlayUrl } from '../../src/native/app-source.js';
import { decryptMp4Buffer } from '../build/mobile-decrypt.js';
let preparationSequence = 0;

// Match desktop requestMedia: App sources start without a website Referer.
export async function requestMedia(source, signal, onProgress) {
  const headers = { 'User-Agent': source.userAgent || 'Mozilla/5.0' };
  if (source.referer) headers.Referer = source.referer;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await request({ url: source.url, headers, signal, media: true,
        encrypted: !!source.contentKey, timeout: 30000, onProgress });
    } catch (error) {
      if (signal?.aborted || error.code !== 'HTTP_403' || attempt || !['app', 'api'].includes(source.source)) throw error;
      if (headers.Referer) delete headers.Referer;
      else headers.Referer = 'https://novelquickapp.com/';
    }
  }
}

export async function prepareMedia(vid, quality, signal, progress, playback = false) {
  const diagnosticId = ++preparationSequence, sourceStartedAt = Date.now();
  console.info(`HG:prepare:${diagnosticId}:${playback ? 'playback' : 'download'}:source_start`);
  let source;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' });
    if (attempt) progress?.('preparing');
    try {
      source = await fetchAppPlayUrl(vid, { quality, signal });
      console.info(`HG:prepare:${diagnosticId}:source_ready:${Date.now() - sourceStartedAt}`);
      break;
    } catch (error) {
      if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' });
      if (error.code === 'DEVICE_REGISTRATION_FAILED') {
        const reason = /^(HTTP_[3-5]\d\d|TIMEOUT|NETWORK_ERROR|EMPTY_RESPONSE|INVALID_RESPONSE|BUSINESS_REJECTED|SECURITY_BLOCKED|UNKNOWN)$/.test(error.registrationFailure || '') ? error.registrationFailure : 'UNKNOWN';
        console.info(`HG:prepare:${diagnosticId}:register_failed:${reason}:${Date.now() - sourceStartedAt}`);
      }
      if (attempt || error.code !== 'DEVICE_REGISTRATION_FAILED' || !['TIMEOUT', 'NETWORK_ERROR'].includes(error.registrationFailure)) throw error;
      console.info(`HG:prepare:${diagnosticId}:registration_cooldown:10000`);
      progress?.('registration-retry', { retryAfterMs: 10000 });
      // Respect the shared registration cooldown; cancellation must not start another request.
      await new Promise((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer); signal.removeEventListener('abort', cancel);
          reject(Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' }));
        };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 10000);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }
  }
  if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' });
  const variants = (source.variants || [source]).filter(item => ['h264', 'avc', 'avc1', 'hevc', 'h265', 'hvc1', 'hev1'].includes(item.codec));
  if (!variants.length) throw Object.assign(new Error('本集为 ByteVC2，安卓兼容转换尚未接入；可选择其他画质'), { code: 'UNSUPPORTED_CODEC' });
  let failure;
  // Source-provided alternates only; never alter signed URLs or encryption metadata.
  for (const item of variants.slice(0, 4)) {
    try {
      progress?.('downloading');
      const transferStarted = Date.now();
      const response = await requestMedia(item, signal, value => progress?.('downloading', {
        ...value, bytesPerSecond: value.received * 1000 / Math.max(1,Date.now()-transferStarted),
      }));
      if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' });
      let token = response.token, decoded;
      if (item.contentKey) {
        progress?.('decrypting',{ received:response.bytes,total:response.bytes });
        await new Promise(resolve => setTimeout(resolve, 0));
        if (signal.aborted) throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' });
        decoded = decryptMp4Buffer(Buffer.from(response.data, 'base64'), Buffer.from(item.contentKey, 'hex'));
        token = Native.writeMedia(decoded.toString('base64'));
      }
      if (signal.aborted) { Native.deleteMedia(token); throw Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' }); }
      if (!/^[0-9a-f-]{36}\.mp4$/.test(token || '')) throw new Error('视频准备失败');
      let url = `https://app.local/media/${token}`;
      if (playback) {
        try { url = URL.createObjectURL(new Blob([decoded || Buffer.from(Native.readMedia(token), 'base64')], { type: 'video/mp4' })); }
        catch (error) { Native.deleteMedia(token); throw error; }
      }
      return { token, codec: item.codec, quality: item.quality || quality, bytes: Number(Native.mediaSize(token)), url };
    } catch (error) {
      failure = error;
      if (signal.aborted || !['HTTP_403', 'HTTP_404', 'HTTP_410', 'MEDIA_REDIRECT_REJECTED'].includes(error.code)) throw error;
    }
  }
  throw failure;
}
