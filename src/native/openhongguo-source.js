// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const os = require('node:os');
const path = require('node:path');
const axios = require('axios');
const { throwIfAborted, withAbort } = require('./request-signal');
const { normalizeDownloadQuality } = require('./download-quality');
const { isPublicMediaUrl } = require('./web-media-guard');

const ANONYMOUS_LIMIT_COOLDOWN_MS = 60_000;

function isSafeHttpsMediaUrl(value) {
  if (!isPublicMediaUrl(value)) return false;
  try { return new URL(String(value)).protocol === 'https:'; } catch { return false; }
}

function profilePath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'openhongguo', 'anonymous.json');
  } catch {
    const home = os.homedir() || '';
    const base = process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
      : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(base, 'openhongguo', 'anonymous.json');
  }
}

function createLazyClient({
  loadSdk = () => import('openhongguo'),
  createTransport = axiosTransport,
  getProfilePath = profilePath,
} = {}) {
  let pending = null;
  return async () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(loadSdk)
        .then(({ createClient, fileProfileStore }) => createClient({
          profile: fileProfileStore(getProfilePath()),
          transport: createTransport(),
          retryAttempts: 1,
          deviceResets: 0,
          timeoutMs: 15000,
        }))
        .catch(error => {
          pending = null;
          throw error;
        });
    }
    return pending;
  };
}

const defaultClient = createLazyClient();

function axiosTransport({ request = axios, timeout = 15000 } = {}) {
  return async req => {
    const requestHeaders = { ...(req.headers || {}) };
    for (const name of Object.keys(requestHeaders)) {
      if (name.toLowerCase() === 'accept-encoding') delete requestHeaders[name];
    }
    requestHeaders['Accept-Encoding'] = 'gzip';
    const response = await request({
      method: req.method || 'GET',
      url: req.url,
      headers: requestHeaders,
      ...(req.body?.length ? { data: Buffer.from(req.body) } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      responseType: 'arraybuffer',
      responseEncoding: null,
      transformResponse: [data => data],
      decompress: false,
      maxContentLength: 8 * 1024 * 1024,
      maxRedirects: 5,
      beforeRedirect: (options, response, request) => {
        const target = response?.headers?.location
          ? new URL(response.headers.location, request?.url || req.url).href
          : `${options.protocol || ''}//${options.hostname || ''}${options.port ? `:${options.port}` : ''}${options.path || '/'}`;
        if (!isPublicMediaUrl(target)) throw Object.assign(new Error('openhongguo 重定向地址不安全'), { code: 'SECURITY_BLOCKED' });
      },
      timeout,
      validateStatus: () => true,
    });
    const headers = {};
    const cookies = {};
    for (const [name, raw] of Object.entries(response.headers || {})) {
      if (name === 'set-cookie') {
        for (const line of Array.isArray(raw) ? raw : [raw]) {
          const pair = String(line || '').split(';', 1)[0];
          const index = pair.indexOf('=');
          if (index > 0) cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
        }
      } else if (name !== 'cookie' && raw !== undefined) {
        headers[name] = Array.isArray(raw) ? String(raw[0]) : String(raw);
      }
    }
    return {
      status: Number(response.status) || 0,
      headers,
      cookies,
      body: new Uint8Array(Buffer.from(response.data || [])),
    };
  };
}

function streamPixels(stream) {
  const pair = [stream?.width, stream?.height].map(Number);
  return pair.every(value => Number.isFinite(value) && value > 0) ? Math.min(...pair) : 0;
}

function selectStreams(playback, quality, allowLowerQuality) {
  const requested = normalizeDownloadQuality(quality);
  const target = requested === 'auto' ? 0 : Number(String(requested).replace(/\D/g, '')) || 0;
  const rows = (Array.isArray(playback?.streams) ? playback.streams : [])
    .filter(stream => stream && (stream.url || stream.backup_url) && !stream.dash)
    .map(stream => {
      const codec = String(stream.codec || '').toLowerCase();
      return {
        stream,
        pixels: streamPixels(stream),
        codec,
        safeUrls: [stream.url, stream.backup_url].filter(url => isSafeHttpsMediaUrl(url)),
        codecRank: ['h264', 'avc', 'avc1'].includes(codec) ? 0
          : ['bytevc1', 'hvc1', 'hev1', 'hevc', 'h265'].includes(codec) ? 1 : 9,
      };
    })
    .filter(row => row.codecRank < 9 && row.safeUrls.length > 0)
    .filter(row => requested === 'auto' || allowLowerQuality || !target || row.pixels >= target)
    .sort((a, b) => {
      if (requested === 'auto') {
        return a.codecRank - b.codecRank || b.pixels - a.pixels || (a.stream.hls ? 1 : 0) - (b.stream.hls ? 1 : 0);
      }
      const aMeets = !target || a.pixels >= target;
      const bMeets = !target || b.pixels >= target;
      if (aMeets !== bMeets) return Number(bMeets) - Number(aMeets);
      return (aMeets ? a.pixels - b.pixels : b.pixels - a.pixels)
        || a.codecRank - b.codecRank
        || (a.stream.hls ? 1 : 0) - (b.stream.hls ? 1 : 0);
    });
  if (!rows.length && requested !== 'auto' && !allowLowerQuality) {
    throw Object.assign(new Error(`本集暂无满足 ${requested} 的 openhongguo 片源，未降级`), {
      code: 'QUALITY_UNAVAILABLE', quality: requested,
    });
  }
  if (requested === 'auto' && !allowLowerQuality) {
    const best = rows[0]?.pixels || 0;
    return rows.filter(row => row.pixels === best);
  }
  return rows;
}

function candidateFrom(stream, playback, contentKey, vid) {
  const urls = [stream.url, stream.backup_url].filter(url => isSafeHttpsMediaUrl(url));
  const codec = String(stream.codec || '').toLowerCase();
  return urls.map(url => ({
    url,
    source: 'openhongguo',
    sourceProvider: 'openhongguo',
    vid: String(playback.episode_id || vid),
    codec: ['bytevc1', 'hvc1', 'hev1', 'hevc', 'h265'].includes(codec) ? 'hevc' : codec || '',
    format: stream.hls ? 'hls' : 'mp4',
    quality: stream.definition || stream.quality || '',
    width: Number(stream.width) || undefined,
    height: Number(stream.height) || undefined,
    duration: Number(playback.duration_seconds) || 0,
    contentKey,
    userAgent: 'okhttp/4.12.0',
  }));
}

function episodeContentType(value, fallback = '1004') {
  const normalized = String(value ?? '');
  return ['1001', '1004'].includes(normalized) ? normalized : fallback;
}

function safeCoverUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function createOpenhongguoSource({
  getClient = defaultClient,
  now = Date.now,
  anonymousLimitCooldownMs = ANONYMOUS_LIMIT_COOLDOWN_MS,
} = {}) {
  let anonymousLimitedUntil = 0;
  let resettingDevice = null;
  const noteFailure = error => {
    if (error?.code === 'ANONYMOUS_LIMITED') anonymousLimitedUntil = now() + anonymousLimitCooldownMs;
    return error;
  };
  const resetDeviceOnce = client => {
    if (!resettingDevice) {
      resettingDevice = Promise.resolve().then(() => client.resetDevice()).finally(() => {
        resettingDevice = null;
      });
    }
    return resettingDevice;
  };
  async function resolve(vid, options = {}) {
    throwIfAborted(options.signal);
    if (now() < anonymousLimitedUntil) {
      throw Object.assign(new Error('openhongguo 匿名设备暂时受限，已跳过本次请求'), {
        code: 'ANONYMOUS_LIMITED',
        cooldown: true,
      });
    }
    const client = await withAbort(getClient(), options.signal);
    let result;
    try {
      result = await withAbort(client.resolvePlayback(String(vid)), options.signal);
    } catch (error) {
      throwIfAborted(options.signal);
      noteFailure(error);
      if (error?.code === 'DEVICE_REJECTED' && typeof client.resetDevice === 'function') {
        await withAbort(resetDeviceOnce(client), options.signal).catch(() => {});
        throwIfAborted(options.signal);
        try {
          result = await withAbort(client.resolvePlayback(String(vid)), options.signal);
        } catch (retryError) {
          throw noteFailure(retryError);
        }
      } else throw error;
    }
    const playback = result?.playback;
    if (!playback || !Array.isArray(playback.streams) || !playback.streams.length) {
      throw Object.assign(new Error('openhongguo 未返回可播放片源'), { code: 'MISSING_MODEL' });
    }
    const contentKey = result.contentKey?.key || '';
    if (playback.protected && !/^[a-f0-9]{32}$/i.test(contentKey)) {
      throw Object.assign(new Error('openhongguo 未返回有效内容密钥'), { code: 'INVALID_RESPONSE' });
    }
    const rows = selectStreams(playback, options.quality, options.allowLowerQuality === true);
    const candidates = rows.flatMap(row => candidateFrom(row.stream, playback, contentKey || null, vid));
    if (!candidates.length) throw Object.assign(new Error('openhongguo 未返回有效视频地址'), { code: 'MISSING_MODEL' });
    return { ...candidates[0], candidates };
  }

  async function list(seriesId, options = {}) {
    throwIfAborted(options.signal);
    const sid = String(seriesId);
    if (!/^\d{1,30}$/.test(sid)) throw Object.assign(new Error('红果剧集编号无效'), { code: 'INVALID_OPTIONS' });
    const client = await withAbort(getClient(), options.signal);
    let details;
    try {
      details = await withAbort(client.getSeriesBatch([sid]), options.signal);
    } catch (error) {
      throwIfAborted(options.signal);
      if (error?.code === 'DEVICE_REJECTED' && typeof client.resetDevice === 'function') {
        await withAbort(resetDeviceOnce(client), options.signal).catch(() => {});
        throwIfAborted(options.signal);
        details = await withAbort(client.getSeriesBatch([sid]), options.signal);
      } else {
        throw error;
      }
    }
    const detail = Array.isArray(details) ? details[0] : null;
    const series = detail?.series;
    const rows = Array.isArray(detail?.episodes) ? detail.episodes : [];
    if (String(series?.id || '') !== sid || !rows.length) {
      throw Object.assign(new Error('openhongguo 未返回完整分集'), { code: 'INVALID_RESPONSE' });
    }
    const requestedContentType = episodeContentType(options.content_type || options.contentType, '');
    const seriesContentType = episodeContentType(series?.content_type, '');
    const seriesCover = safeCoverUrl(series.cover_url);
    const episodes = rows.map((item, index) => {
      const vid = String(item?.id || '');
      if (!/^\d{1,30}$/.test(vid) || String(item?.series_id || '') !== sid) {
        throw Object.assign(new Error('openhongguo 分集数据异常'), { code: 'INVALID_RESPONSE' });
      }
      const contentType = requestedContentType || episodeContentType(item?.content_type, seriesContentType || '1004');
      return {
        vid,
        vid_index: Number(item.number) > 0 ? Number(item.number) : index + 1,
        title: item.title || '',
        series_id: sid,
        series_title: series.title || '未命名短剧',
        cover: safeCoverUrl(item.cover_url) || seriesCover,
        content_type: contentType,
        web_available: null,
        locked: item.playable === false,
      };
    }).sort((a, b) => a.vid_index - b.vid_index);
    if (new Set(episodes.map(item => item.vid)).size !== episodes.length
        || Number(series.episode_count) > episodes.length) {
      throw Object.assign(new Error('openhongguo 分集列表不完整'), { code: 'INVALID_RESPONSE' });
    }
    const topContentType = requestedContentType || seriesContentType || episodes[0]?.content_type || '1004';
    return {
      series_id: sid,
      series_title: series.title || '未命名短剧',
      cover: seriesCover || (episodes[0] && episodes[0].cover) || '',
      description: series.description || '',
      content_type: topContentType,
      total: episodes.length,
      web_accessible_episodes: null,
      episodes,
      source: 'openhongguo',
    };
  }

  return { resolve, list };
}

const provider = createOpenhongguoSource();
module.exports = {
  profilePath,
  axiosTransport,
  createLazyClient,
  selectStreams,
  candidateFrom,
  createOpenhongguoSource,
  fetchEpisodeList: (...args) => provider.list(...args),
  fetchPlayUrlSingle: (...args) => provider.resolve(...args),
};
