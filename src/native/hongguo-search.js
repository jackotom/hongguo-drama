/**
 * 红果官网搜索接口。
 *
 * 搜索页本身是前端空壳，结果由页面脚本请求
 * `https://hongguoduanju.com/api/search/result` 后渲染；直接调用该接口
 * 比在隐藏窗口里嗅探 DOM 更快，也不会因为一次页面加载失败就等到超时。
 * 接口未公开，字段或可用性可能变化：调用方应保留页面嗅探作为兜底。
 */
const axios = require('axios');

const SITE_ORIGIN = 'https://hongguoduanju.com';
const SEARCH_ENDPOINT = `${SITE_ORIGIN}/api/search/result`;
const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 400;
const CACHE_TTL_MS = 60 * 1000;
const CACHE_LIMIT = 30;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const cache = new Map();
const pending = new Map();

class HongguoSearchError extends Error {
  constructor(message, kind, { fallback = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HongguoSearchError';
    this.kind = kind; // timeout | upstream | format | input
    this.fallback = fallback;
  }
}

function normalizeKeyword(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function cleanUrl(value) {
  return String(value || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&');
}

function cleanText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function safeCover(value) {
  const url = cleanUrl(value);
  return /^https?:\/\//i.test(url) ? url : '';
}

function episodeCountOf(video) {
  const count = Number(video?.episode_cnt);
  if (Number.isInteger(count) && count > 0) return count;
  const right = String(video?.episode_right_text || '');
  const match = right.match(/(\d+)\s*集/);
  return match ? Number(match[1]) : 0;
}

function tagsOf(video) {
  const list = Array.isArray(video?.tags) ? video.tags
    : Array.isArray(video?.category_list) ? video.category_list : [];
  const tags = [];
  for (const item of list) {
    const label = typeof item === 'string' ? item : item?.name || item?.tag_name || item?.title;
    const text = String(label || '').trim();
    if (text && !tags.includes(text)) tags.push(text);
    if (tags.length >= 4) break;
  }
  return tags;
}

/** 把接口返回的 searchList 转成应用内统一的搜索结果结构。 */
function parseSearchResponse(payload) {
  if (payload == null || payload === '') {
    throw new HongguoSearchError('搜索响应为空', 'upstream');
  }
  if (typeof payload === 'string') {
    throw new HongguoSearchError('搜索返回了网页内容', 'upstream');
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HongguoSearchError('搜索返回异常数据', 'format', { fallback: true });
  }
  if (typeof payload.code === 'string') {
    throw new HongguoSearchError(`搜索服务暂不可用（${payload.message || payload.code}）`, 'upstream');
  }
  if (!Array.isArray(payload.searchList)) {
    throw new HongguoSearchError('搜索返回异常数据', 'format', { fallback: true });
  }
  const results = [];
  const seen = new Set();
  for (const item of payload.searchList) {
    const videoData = item?.video_data;
    const video = videoData && typeof videoData === 'object' && Object.keys(videoData).length ? videoData : item;
    // 有些结果把剧集编号放在 item.keyword（video_data 为空）；不能因此当成解析失败。
    const seriesId = String(video?.series_id || item?.series_id || item?.keyword || '').trim();
    const title = cleanText(video?.series_name || video?.series_title || item?.name || video?.title || '');
    if (!/^\d{6,}$/.test(seriesId) || !title || seen.has(seriesId)) continue;
    seen.add(seriesId);
    results.push({
      series_id: seriesId,
      series_title: title,
      cover: safeCover(video?.series_cover || video?.cover || ''),
      episode_count: episodeCountOf(video),
      tags: tagsOf(video),
      description: cleanText(video?.series_intro || ''),
      url: `${SITE_ORIGIN}/detail?series_id=${seriesId}`,
    });
  }
  // 有数据但一条都认不出，通常是字段改名；这是解析失败，不是“没有结果”。
  if (!results.length && payload.searchList.length > 0) {
    throw new HongguoSearchError('搜索返回的条目无法识别', 'format', { fallback: true });
  }
  const total = Number(payload.totalCount);
  const totalPages = Number(payload.totalPages);
  const page = Number(payload.pageNum);
  return {
    results,
    total: Number.isFinite(total) && total >= 0 ? total : results.length,
    totalPages: Number.isFinite(totalPages) && totalPages >= 0 ? totalPages : 0,
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    hasMore: payload.hasMore === true,
  };
}

function classifyRequestError(error) {
  const status = Number(error?.response?.status);
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || /timeout/i.test(String(error?.message || ''))) {
    return new HongguoSearchError('搜索超时，请稍后重试', 'timeout', { cause: error });
  }
  if (status === 408) {
    return new HongguoSearchError('搜索超时，请稍后重试', 'timeout', { cause: error });
  }
  if (status === 429) {
    return new HongguoSearchError('搜索请求过于频繁，请稍后重试', 'upstream', { cause: error });
  }
  if (status >= 500) {
    return new HongguoSearchError(`搜索服务暂不可用（HTTP ${status}）`, 'upstream', { cause: error });
  }
  if (status >= 400) {
    return new HongguoSearchError(`搜索接口已变化（HTTP ${status}）`, 'format', { fallback: true, cause: error });
  }
  return new HongguoSearchError(`搜索网络异常：${error?.message || '连接失败'}`, 'upstream', { cause: error });
}

async function defaultRequest(keyword, page, { timeout }) {
  let response;
  try {
    response = await axios.get(SEARCH_ENDPOINT, {
      params: { aid: '8662', query: keyword, page },
      headers: {
        'User-Agent': SEARCH_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': `${SITE_ORIGIN}/`,
      },
      timeout,
      responseType: 'json',
      maxContentLength: MAX_RESPONSE_BYTES,
      maxRedirects: 5,
    });
  } catch (error) {
    throw classifyRequestError(error);
  }
  const data = response?.data;
  if (data && typeof data === 'object' && typeof data.code === 'string') {
    throw new HongguoSearchError(`搜索服务暂不可用（${data.message || data.code}）`, 'upstream');
  }
  return data;
}

function remember(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 搜索红果官网。
 * 失败抛 HongguoSearchError；fallback 为 true 表示接口结构/地址可能变化，
 * 调用方可以退回隐藏窗口嗅探。
 */
async function searchHongguo(keyword, options = {}) {
  const kw = normalizeKeyword(keyword);
  if (!kw) throw new HongguoSearchError('请输入 1 至 200 字的搜索词', 'input');
  if (kw.length > 200) throw new HongguoSearchError('请输入 1 至 200 字的搜索词', 'input');
  const page = Math.max(1, Math.min(50, Number(options.page) || 1));
  const request = typeof options.request === 'function' ? options.request : defaultRequest;
  const timeout = Math.max(1000, Number(options.timeout) || DEFAULT_TIMEOUT_MS);
  const retries = Math.max(0, Math.min(3, options.retries ?? DEFAULT_RETRIES));
  const deadline = Math.max(0, Number(options.deadline) || 0);
  const remaining = () => deadline > 0 ? deadline - Date.now() : Infinity;
  const useCache = options.cache !== false;
  const key = `${kw}\u0000${page}`;
  const cached = useCache ? cache.get(key) : null;
  if (cached && cached.expires > Date.now()) return cached.value;
  const sharePending = useCache && request === defaultRequest;
  if (sharePending && pending.has(key)) return pending.get(key);

  const run = (async () => {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (remaining() < 1000) {
        lastError = new HongguoSearchError('搜索超时，请稍后重试', 'timeout');
        break;
      }
      try {
        const attemptTimeout = Math.min(timeout, Math.max(1000, remaining()));
        const payload = await request(kw, page, { timeout: attemptTimeout });
        const parsed = parseSearchResponse(payload);
        const value = { ...parsed, keyword: kw };
        if (useCache) remember(key, value);
        return value;
      } catch (error) {
        lastError = error instanceof HongguoSearchError
          ? error
          : new HongguoSearchError(`搜索失败：${error?.message || '未知错误'}`, 'upstream', { cause: error });
        if (lastError.fallback || attempt === retries) break;
        await delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }
    throw lastError;
  })();
  if (!sharePending) return run;
  pending.set(key, run);
  try { return await run; }
  finally { if (pending.get(key) === run) pending.delete(key); }
}

function clearSearchCache() {
  cache.clear();
  pending.clear();
}

module.exports = {
  searchHongguo,
  parseSearchResponse,
  normalizeKeyword,
  classifyRequestError,
  clearSearchCache,
  HongguoSearchError,
  SEARCH_ENDPOINT,
  CACHE_TTL_MS,
};
