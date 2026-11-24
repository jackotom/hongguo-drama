const { signedMetadataRequest, requestJson } = require('./app-source');

const ALBUM_API = '/novel/player/album_detail/v1/';
const MAX_EPISODES = 2000;

function albumError(message, code) {
  return Object.assign(new Error(message), { code });
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function safeCover(value) {
  const url = text(value);
  return /^https?:\/\//i.test(url) && !/\.heic(?:\?|$)/i.test(url) ? url : '';
}

function parseCreatorAlbum(payload, albumId) {
  if (Number(payload?.code) !== 0) throw albumError('云端未确认合集请求成功', 'ALBUM_REJECTED');
  const album = payload?.data?.album_data;
  const reported = text(album?.album_id_str || album?.album_id);
  if (!album || reported !== String(albumId)) throw albumError('合集详情与请求不一致', 'ALBUM_IDENTITY');
  const rows = Array.isArray(album.video_detail_list) ? album.video_detail_list : [];
  const expected = Number(album.episode_cnt) || 0;
  if (!rows.length || rows.length > MAX_EPISODES || payload?.data?.has_more === true || album.has_more === true
    || expected > 0 && expected !== rows.length) {
    throw albumError('合集目录不完整，请重试', 'ALBUM_INCOMPLETE');
  }
  const seen = new Set();
  const episodes = rows.map((row, index) => {
    const vid = text(row?.series_id_str || row?.series_id);
    if (!/^\d{1,30}$/.test(vid) || !/[1-9]/.test(vid) || Number(row?.content_type) !== 1001 || seen.has(vid)) {
      throw albumError('合集视频数据无效，请重试', 'ALBUM_INVALID');
    }
    seen.add(vid);
    return {
      vid,
      vid_index: index + 1,
      title: text(row.series_title) || `第${index + 1}集`,
      series_id: String(albumId),
      series_title: text(album.title) || '未命名合集',
      cover: safeCover(album.cover),
      content_type: '1001',
      web_available: true,
      locked: false,
    };
  });
  return {
    series_id: String(albumId),
    series_title: text(album.title) || '未命名合集',
    cover: safeCover(album.cover),
    description: text(album.intro),
    content_type: '1003',
    source: 'app-album',
    total: episodes.length,
    web_accessible_episodes: episodes.length,
    episodes,
  };
}

async function fetchCreatorAlbum(albumId, {
  deadline = 0, request = signedMetadataRequest, send = requestJson, signal,
} = {}) {
  albumId = String(albumId || '');
  if (!/^\d{1,30}$/.test(albumId) || !/[1-9]/.test(albumId)) {
    throw albumError('合集编号无效', 'ALBUM_INPUT');
  }
  const budget = Number(deadline) || Date.now() + 15000;
  if (budget <= Date.now()) throw albumError('合集详情请求超时', 'ALBUM_TIMEOUT');
  const body = {
    album_id: albumId,
    series_ids: [],
    need_video_detail_info: true,
    biz_param: { video_platform: 3 },
  };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (budget <= Date.now()) break;
    const signed = request(ALBUM_API, {}, body);
    try {
      const payload = await send(signed.url, {
        method: 'POST',
        headers: signed.headers,
        data: signed.body,
        preserveLargeIntegerFields: ['album_id', 'album_id_str', 'series_id', 'series_id_str'],
      }, budget, signal);
      return parseCreatorAlbum(payload, albumId);
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EMPTY_RESPONSE') throw error;
    }
  }
  throw lastError || albumError('合集详情请求超时', 'ALBUM_TIMEOUT');
}

module.exports = { fetchCreatorAlbum, parseCreatorAlbum, ALBUM_API };
