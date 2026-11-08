// Adapted from zuomeizuoyang/shortdrama-player, commit 081e7ee7 (MIT).
// Public English SSR only; no account, signing key, unlock API or preview fallback.
const axios = require('axios');
const { isPublicMediaUrl } = require('./web-media-guard');
const ORIGIN = 'https://www.dramabox.com', UA = 'Mozilla/5.0';
const ID = /^\d{1,24}$/;
const text = value => String(value || '').replace(/<[^>]*>/g, '').trim();

function parseId(value, episode = false) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'dramabox' || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every(part => ID.test(part))) throw new Error('DramaBox 剧集编号无效');
  return { bookId: parts[1], chapterId: parts[2], seriesId: parts.slice(0, 2).join(':') };
}
function resolveSeriesId(value) {
  if (String(value).startsWith('dramabox:')) return parseId(value).seriesId;
  let url; try { url = new URL(value); } catch (_) { throw new Error('DramaBox 分享链接无效'); }
  const id = url.pathname.match(/^\/(?:drama|movie)\/(\d{1,24})(?:\/|$)/)?.[1];
  if (url.protocol !== 'https:' || !['www.dramabox.com', 'www.dramaboxdb.com'].includes(url.hostname)
    || url.port || url.username || url.password || !id) throw new Error('请输入 DramaBox 英文官网剧集链接');
  return `dramabox:${id}`;
}
async function request(route, params = {}, options = {}) {
  const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 10000;
  if (remaining <= 0) throw new Error('DramaBox 加载超时，请重试');
  const timeout = Math.min(10000, remaining), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await axios.get(ORIGIN + route, { params, timeout, signal: controller.signal, maxRedirects: 0,
      maxContentLength: 8 * 1024 * 1024, responseType: 'text',
      headers: { 'User-Agent': UA, Referer: ORIGIN + '/', 'Accept-Language': 'en-US,en;q=0.9' } });
    const raw = String(response.data).match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script\s*>/i)?.[1];
    let data; try { data = JSON.parse(raw); } catch (_) { throw new Error('DramaBox 官网数据格式已变化，请等待适配'); }
    const props = data?.props?.pageProps;
    if (!props || typeof props !== 'object' || (props.locale ?? data.locale) !== 'en') throw new Error('DramaBox 官网数据或语言不匹配');
    return props;
  } catch (error) {
    const status = error.response?.status;
    if ([403, 451].includes(status)) throw new Error(`DramaBox 当前网络或地区受限（HTTP ${status}），请检查网络分流`);
    if (status === 429) throw new Error('DramaBox 请求过于频繁，请稍后重试');
    if (error.message?.startsWith('DramaBox ')) throw error;
    throw new Error(controller.signal.aborted || ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)
      ? 'DramaBox 加载超时，请重试' : 'DramaBox 连接失败，请检查网络分流或稍后重试');
  } finally { clearTimeout(timer); }
}
function normalizeBook(book) {
  if (!book || !ID.test(String(book.bookId)) || !text(book.bookName || book.name)) return null;
  return { series_id: `dramabox:${book.bookId}`, series_title: text(book.bookName || book.name),
    cover: isPublicMediaUrl(book.cover || book.coverWap) ? book.cover || book.coverWap : '',
    episode_count: Number(book.chapterCount ?? book.totalChapterNum) || 0, intro: text(book.introduction),
    source: 'dramabox', url: `${ORIGIN}/drama/${book.bookId}` };
}
function pageResult(props, page, pagesKey) {
  const pages = Number(props[pagesKey]);
  if (!Array.isArray(props.bookList) || props.bookList.length > 500 || Number(props.pageNo) !== page
    || !Number.isSafeInteger(pages) || pages < 0) throw new Error('DramaBox 官网分页与请求不一致');
  const seen = new Set(), results = props.bookList.map(normalizeBook).filter(item => {
    if (!item || seen.has(item.series_id)) return false;
    seen.add(item.series_id); return true;
  });
  if (props.bookList.length && !results.length) throw new Error('DramaBox 未返回有效剧集');
  const hasMore = results.length > 0 && page < pages;
  return { success: true, results, page, total: Number(props.totalNum) || 0, totalPages: pages,
    hasMore, nextPage: hasMore ? page + 1 : null, genres: [], pageTitle: 'DramaBox（海外）', sourceUrl: ORIGIN + '/browse' };
}
async function browseList({ page = 1, genre = '' } = {}) {
  try {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || genre) throw new Error('DramaBox 页码或分类无效');
    return pageResult(await request(page === 1 ? '/browse' : `/browse/0/${page}`), page, 'pages');
  } catch (error) { return { success: false, error: error.message }; }
}
async function search(keyword, page = 1, options = {}) {
  try {
    const searchValue = String(keyword || '').trim();
    if (!searchValue || searchValue.length > 200 || !Number.isSafeInteger(page) || page < 1 || page > 50) throw new Error('DramaBox 搜索词或页码无效');
    return pageResult(await request('/search', { searchValue, page }, options), page, 'totalPage');
  } catch (error) { return { success: false, error: error.message }; }
}
async function detail(seriesId, options = {}) {
  const id = parseId(seriesId), props = await request(`/drama/${id.bookId}`, {}, options);
  const book = normalizeBook(props.bookInfo), chapters = props.chapterList;
  if (book?.series_id !== seriesId || !Array.isArray(chapters) || !chapters.length || chapters.length > 10000
    || !Number.isSafeInteger(book.episode_count) || book.episode_count !== chapters.length) throw new Error('DramaBox 返回的剧集或完整分集数量不一致');
  const ids = new Set(), sorted = [...chapters].sort((a, b) => Number(a.index) - Number(b.index));
  for (const [index, chapter] of sorted.entries()) {
    const cid = String(chapter?.id || '');
    if (!ID.test(cid) || ids.has(cid) || !Number.isSafeInteger(chapter.index) || chapter.index !== index) throw new Error('DramaBox 分集编号重复或不连续');
    ids.add(cid);
  }
  return { book, chapters: sorted };
}
async function fetchEpisodeList(seriesId, options = {}) {
  const { book, chapters } = await detail(seriesId, options);
  return { ...book, total: chapters.length, episodes: chapters.map(chapter => ({
    vid: `${seriesId}:${chapter.id}`, vid_index: chapter.index + 1, title: text(chapter.name) || `第 ${chapter.index + 1} 集`,
    series_id: seriesId, series_title: book.series_title, cover: book.cover,
    duration: Number(chapter.duration) / 1000 || 0, locked: chapter.unlock !== true, source: 'dramabox',
  })) };
}
function assertMediaUrl(value) {
  let url; try { url = new URL(value); } catch (_) { throw new Error('DramaBox 片源地址无效'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !isPublicMediaUrl(value)
    || !(url.hostname === 'dramaboxdb.com' || url.hostname.endsWith('.dramaboxdb.com'))) throw new Error('DramaBox 片源必须来自官方 HTTPS CDN');
  return url;
}
function mediaRequestOptions(value) {
  assertMediaUrl(value);
  // QX may synthesize DNS addresses; pin HTTPS origins, including every redirect, instead of bypassing TLS verification.
  return { maxRedirects: 3, beforeRedirect(_options, response, request) {
    assertMediaUrl(new URL(response.headers.location, request.url).href);
  } };
}
async function fetchPlayUrlSingle(vid, seriesId, options = {}) {
  try {
    const id = parseId(vid, true);
    if (seriesId != null && seriesId !== '' && seriesId !== id.seriesId) throw new Error('DramaBox 分集不属于当前剧集');
    const { chapters } = await detail(id.seriesId, options), chapter = chapters.find(item => String(item.id) === id.chapterId);
    if (!chapter) throw new Error('DramaBox 未找到该分集');
    if (chapter.unlock !== true) return { url: null, source: 'dramabox', locked: true, error: '该集未公开解锁，请在 DramaBox 官方平台确认观看权限' };
    const url = assertMediaUrl(chapter.mp4);
    if (chapter.m3u8Flag || !/\.mp4$/i.test(url.pathname) || /encrypt/i.test(url.pathname)) throw new Error('DramaBox 当前仅支持官方公开未加密 MP4');
    return { url: url.href, source: 'dramabox', format: 'mp4', spadeA: null, codec: '', vid,
      duration: Number(chapter.duration) / 1000 || 0, userAgent: UA, referer: ORIGIN + '/' };
  } catch (error) { return { url: null, source: 'dramabox', spadeA: null, codec: null, error: error.message }; }
}
module.exports = { resolveSeriesId, browseList, search, fetchEpisodeList, fetchPlayUrlSingle, mediaRequestOptions };
