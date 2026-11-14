const axios = require('axios');
const { isPublicMediaUrl } = require('./web-media-guard');

const ORIGIN = 'https://www.kuaikaw.cn';
const ID = /^\d{1,30}$/;
let genreCache;

function plainText(value) {
  return String(value || '').replace(/<[^>]*>/g, '').trim();
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && isPublicMediaUrl(url.href) ? url.href : '';
  } catch (_) { return ''; }
}

function parseId(value, episode = false) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'hema' || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every(part => ID.test(part))) {
    throw new Error('河马剧集编号无效');
  }
  return { bookId: parts[1], chapterId: parts[2], seriesId: parts.slice(0, 2).join(':') };
}

async function request(apiPath, body, options = {}) {
  const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 10000;
  if (remaining <= 0) throw new Error('河马加载超时，请重试');
  const timeout = Math.min(10000, remaining);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const requestOptions = {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: body ? 'application/json' : 'text/html',
      'Content-Type': 'application/json', pname: 'www.kuaikaw.cn', Origin: ORIGIN, Referer: `${ORIGIN}/` },
    timeout, signal: controller.signal, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024,
    responseType: body ? 'json' : 'text',
  };
  try {
    const response = body ? await axios.post(ORIGIN + apiPath, body, requestOptions) : await axios.get(ORIGIN + apiPath, requestOptions);
    return response.data;
  } catch (error) {
    throw new Error(controller.signal.aborted || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
      ? '河马加载超时，请重试' : '河马来源暂不可用，请稍后重试');
  } finally { clearTimeout(timer); }
}

function normalizeBooks(books) {
  const seen = new Set();
  const results = books.filter(item => item && ID.test(String(item.bookId || '')) && plainText(item.bookName))
    .map(item => ({ series_id: `hema:${item.bookId}`, series_title: plainText(item.bookName), cover: httpsUrl(item.coverWap),
      episode_count: Number(item.totalChapterNum) || 0,
      tags: Array.isArray(item.bookTypeThree) ? item.bookTypeThree.map(tag => plainText(tag?.name)).filter(Boolean).slice(0, 4) : [],
      source: 'hema', url: `${ORIGIN}/drama/${item.bookId}` }))
    .filter(item => { if (seen.has(item.series_id)) return false; seen.add(item.series_id); return true; });
  return results;
}

function pageData(html) {
  const match = typeof html === 'string' && html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  try {
    const data = JSON.parse(match?.[1]).props.pageProps;
    if (!data || typeof data !== 'object') throw new Error('invalid page');
    return data;
  } catch (_) { throw new Error('河马目录数据异常，请稍后重试'); }
}

async function browseList(options = {}) {
  try {
    const { genre = '', page = 1, forceRefresh = false } = options || {};
    const pg = Number(page);
    const slug = String(genre || '0');
    if (!Number.isSafeInteger(pg) || pg < 1 || !/^\d{1,30}(?:-\d{1,30}){0,15}$/.test(slug)) {
      throw new Error('河马题材或页码无效，请重新选择');
    }
    let firstHtml;
    if (forceRefresh || !genreCache || genreCache.expires <= Date.now()) {
      firstHtml = await request('/browse');
      const directory = pageData(firstHtml);
      if (!Array.isArray(directory.typeThreeList)) throw new Error('河马没有返回可用题材，请重试');
      const seen = new Set();
      const items = directory.typeThreeList.filter(item => Array.isArray(item?.typeThreeIds)
        && item.typeThreeIds.length > 0 && item.typeThreeIds.length <= 16
        && item.typeThreeIds.every(id => ID.test(String(id))) && plainText(item.name))
        .map(item => ({ slug: item.typeThreeIds.join('-'), label: plainText(item.name) }))
        .filter(item => { if (item.slug === '0' || seen.has(item.slug)) return false; seen.add(item.slug); return true; });
      if (!items.length) throw new Error('河马没有返回可用题材，请重试');
      genreCache = { items, expires: Date.now() + 300000 };
    }
    if (slug !== '0' && !genreCache.items.some(item => item.slug === slug)) throw new Error('河马题材无效，请重新选择');
    const apiPath = slug === '0' && pg === 1 ? '/browse' : `/browse/${slug}${pg > 1 ? `/${pg}` : ''}`;
    const html = apiPath === '/browse' && firstHtml ? firstHtml : await request(apiPath);
    const data = pageData(html);
    if (!Array.isArray(data.bookList) || Number(data.page) !== pg || String(data.typeThreeId || '0') !== slug) {
      throw new Error('河马返回的目录与请求不一致，请重试');
    }
    const results = normalizeBooks(data.bookList);
    // shortcut: genre totals are unverified; follow observed next links until accurate totals are confirmed.
    const hasMore = results.length > 0 && new RegExp(`<a\\b[^>]*\\shref=["']/browse/${slug}/${pg + 1}["']`).test(html);
    return { success: true, results, page: pg, total: 0, totalPages: 0, hasMore,
      nextPage: hasMore ? pg + 1 : null, genres: genreCache.items,
      pageTitle: '河马短剧', sourceUrl: ORIGIN + apiPath };
  } catch (error) { return { success: false, error: error.message }; }
}

async function search(keyword, page = 1, options = {}) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请输入搜索关键词');
    const pg = Math.max(1, Number.parseInt(page, 10) || 1);
    const response = await request('/seo/video/6007', { sourceType: 1, keyword: kw, index: pg }, options);
    if (response?.retCode !== 0 || !Array.isArray(response.data?.bookList)) throw new Error('河马搜索数据异常，请稍后重试');
    const data = response.data;
    const results = normalizeBooks(data.bookList);
    const hasMore = data.isMore === 1 && results.length > 0;
    return { success: true, results, page: pg, total: Number(data.totalSize) || 0, totalPages: 0,
      hasMore, nextPage: hasMore ? pg + 1 : null, genres: [], pageTitle: '河马短剧', sourceUrl: ORIGIN };
  } catch (error) { return { success: false, error: error.message }; }
}

async function detail(seriesId) {
  const { bookId } = parseId(seriesId);
  const html = await request(`/drama/${bookId}`);
  const match = typeof html === 'string' && html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  let result;
  try { result = JSON.parse(match?.[1]).props.pageProps; }
  catch (_) { throw new Error('河马详情数据异常，请稍后重试'); }
  if (String(result?.bookInfoVo?.bookId) !== bookId || !Array.isArray(result?.chapterList)) {
    throw new Error('河马返回的剧集与请求不一致');
  }
  const seen = new Set();
  for (const episode of result.chapterList) {
    const id = String(episode?.chapterId || '');
    if (!ID.test(id) || seen.has(id) || (episode.bookId != null && String(episode.bookId) !== bookId)) {
      throw new Error('河马分集数据异常，请稍后重试');
    }
    seen.add(id);
  }
  return result;
}

async function fetchEpisodeList(seriesId) {
  const result = await detail(seriesId);
  const series_title = plainText(result.bookInfoVo.bookName) || '未命名短剧';
  const cover = httpsUrl(result.bookInfoVo.coverWap);
  const episodes = result.chapterList.map((episode, index) => ({
    vid: `${seriesId}:${episode.chapterId}`, vid_index: Number(episode.chapterIndex) || index + 1,
    title: plainText(episode.chapterName), series_id: seriesId, series_title, cover,
    locked: episode.isCharge !== '0', source: 'hema',
  })).sort((a, b) => a.vid_index - b.vid_index);
  if (!episodes.length) throw new Error('河马分集列表为空');
  return { series_id: seriesId, series_title, cover, total: episodes.length, episodes, source: 'hema' };
}

async function fetchPlayUrlSingle(vid, sid) {
  try {
    const id = parseId(vid, true);
    if (sid != null && sid !== '' && parseId(sid).seriesId !== id.seriesId) throw new Error('河马分集不属于当前剧集');
    // Re-read the public detail for every request: never reuse a cached free/paid decision.
    const result = await detail(id.seriesId);
    const episode = result.chapterList.find(item => String(item.chapterId) === id.chapterId);
    if (!episode) throw new Error('河马未找到该分集');
    if (episode.isCharge !== '0') return { url: null, spadeA: null, codec: null, source: 'hema', locked: true,
      error: `第 ${Number(episode.chapterIndex) || ''} 集当前锁定，请在河马官方平台确认可看范围` };
    const url = httpsUrl(episode.chapterVideoVo?.mp4720p) || httpsUrl(episode.chapterVideoVo?.mp4);
    if (!url) throw new Error('河马未提供有效 HTTPS 播放地址');
    return { url, spadeA: null, codec: '', source: 'hema' };
  } catch (error) { return { url: null, spadeA: null, codec: null, source: 'hema', error: error.message }; }
}

module.exports = { browseList, search, fetchEpisodeList, fetchPlayUrlSingle };
