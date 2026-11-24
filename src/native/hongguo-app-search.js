// Registered, signed App search; the caller chooses website/new-release fallback.
const { signedSearchRequest, parseSearchInteger, requestJson } = require('./app-source');
const { getPlaybackDevice } = require('./playback-device');

const SEARCH_TAB = 11;
const DEFAULT_TIMEOUT_MS = 8000;

function appError(message, code) {
  return Object.assign(new Error(message), { code });
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function appCover(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) return '';
  // The App returns HEIC variants that Chromium may not decode; leave them blank rather than a broken card.
  return /\.heic(?:\?|$)/i.test(url) ? '' : url;
}

async function defaultRequest(signed, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  try {
    return await requestJson(signed.url, { method: 'GET', headers: signed.headers }, deadline, AbortSignal.timeout(remaining));
  } catch (error) {
    const code = error.code === 'ETIMEDOUT' || error.name === 'AbortError' || error.name === 'TimeoutError' ? 'APP_TIMEOUT'
      : /未返回有效数据|空响应/i.test(error.message) ? 'APP_EMPTY'
      : error.code || 'APP_NETWORK';
    throw appError(code === 'APP_TIMEOUT' ? 'App 搜索超时' : 'App 搜索暂不可用', code);
  }
}

function parseSearchPayload(payload, { page = 1 } = {}) {
  page = parseSearchInteger(page);
  if (page === null || page < 1 || page > 50) throw appError('App 搜索页码需为 1 至 50 的整数', 'APP_INPUT');
  if (!payload || typeof payload !== 'object') throw appError('App 搜索返回空响应', 'APP_EMPTY');
  if (Number(payload.code ?? 0) !== 0) throw appError('App 搜索返回业务错误', 'APP_BUSINESS');
  const tabs = Array.isArray(payload.search_tabs) ? payload.search_tabs : payload.data?.search_tabs;
  if (!Array.isArray(tabs)) throw appError('App 搜索数据结构异常', 'APP_SCHEMA');
  const tab = tabs.find(item => Number(item?.tab_type) === SEARCH_TAB);
  if (!tab) throw appError('App 搜索暂未返回短剧结果', 'APP_TAB_MISSING');
  const seen = new Set(), results = [];
  const playableSeries = item => {
    const contentType = item?.content_type == null ? 1004 : Number(item.content_type);
    if (![1003, 1004].includes(contentType)) return false;
    if (contentType === 1003) {
      const albumId = String(item?.album_info?.album_id_str || item?.album_info?.album_id || '');
      return /^\d{1,30}$/.test(albumId) && albumId === String(item?.series_id || '')
        && Number(item.album_info?.episode_cnt) > 0;
    }
    return /^\d{1,30}$/.test(String(item?.series_id || ''));
  };
  for (const cell of Array.isArray(tab.data) ? tab.data : []) {
    const video = (Array.isArray(cell?.video_data) ? cell.video_data : []).find(playableSeries);
    // Header/ad/search-suggestion cells have no video_data; their book_id is not a drama.
    if (!video) continue;
    const contentType = String(video.content_type ?? 1004);
    const album = contentType === '1003' ? video.album_info || {} : {};
    const seriesId = String(contentType === '1003' ? album.album_id_str || album.album_id : video.series_id);
    const title = cleanTitle(cell?.search_high_light?.title?.text || album.title || video.title || cell?.cell_name || '');
    if (!title || seen.has(seriesId)) continue;
    seen.add(seriesId);
    results.push({
      series_id: seriesId,
      series_title: title,
      cover: appCover(album.cover || video?.cover),
      episode_count: Number(album.episode_cnt ?? video?.episode_cnt ?? video?.episode_count ?? 0) || 0,
      description: cleanTitle(album.intro || video?.series_intro || video?.video_desc || cell?.series_intro || ''),
      content_type: contentType,
      source: 'hongguo',
      url: `https://hongguoduanju.com/detail?series_id=${seriesId}`,
    });
  }
  const hasMore = tab.has_more === true && page < 50;
  return {
    success: true,
    results,
    page,
    total: 0,
    totalPages: 0,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
    channel: 'app',
    cursor: {
      search_id: String(tab.search_id || ''),
      passback: String(tab.passback || ''),
      next_offset: parseSearchInteger(tab.next_offset),
    },
  };
}

async function searchApp(keyword, { page = 1, cursor = null, deadline = 0, request = defaultRequest } = {}) {
  const kw = cleanTitle(keyword);
  if (!kw || kw.length > 80) throw appError('App 搜索词无效', 'APP_INPUT');
  const pg = parseSearchInteger(page);
  if (pg === null || pg < 1 || pg > 50) throw appError('App 搜索页码需为 1 至 50 的整数', 'APP_INPUT');
  if (pg > 1 && !cursor?.search_id && !cursor?.passback && parseSearchInteger(cursor?.next_offset) === null) {
    throw appError('App 搜索游标已失效，请重新搜索', 'APP_CURSOR');
  }
  const budget = Number(deadline) > 0 ? deadline : Date.now() + DEFAULT_TIMEOUT_MS;
  if (budget <= Date.now()) throw appError('App 搜索超时', 'APP_TIMEOUT');
  const identity = await getPlaybackDevice(requestJson);
  if (budget <= Date.now()) throw appError('App 搜索超时', 'APP_TIMEOUT');
  const signed = signedSearchRequest({ keyword: kw, page: pg, cursor, identity });
  const payload = await request(signed, budget);
  return parseSearchPayload(payload, { page: pg });
}

module.exports = { searchApp, parseSearchPayload, cleanTitle, appCover, DEFAULT_TIMEOUT_MS };
