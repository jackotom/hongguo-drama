// Public page routes/schema adapted from wanglinsaputra/Rest-Api-ReelShort (MIT).
// See THIRD-PARTY-NOTICES.md for the pinned source and license.
const axios = require('axios');
const { isPublicMediaUrl, webMediaRequestOptions } = require('./web-media-guard');

const ORIGIN = 'https://www.reelshort.com';
const UA = 'Mozilla/5.0';
const ID = /^[a-zA-Z0-9_]{1,100}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value) { return String(value || '').replace(/<[^>]*>/g, '').trim(); }
function slug(title) { return text(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/ +/g, '-'); }
function parseId(value, episode = false) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'reelshort' || parts.length !== (episode ? 5 : 3) || !ID.test(parts[1])
    || !SLUG.test(parts[2]) || parts[2].length > 200
    || (episode && (!/^[1-9]\d{0,3}$/.test(parts[3]) || !ID.test(parts[4])))) throw new Error('ReelShort 剧集编号无效');
  return { bookId: parts[1], slug: parts[2], number: Number(parts[3]), chapterId: parts[4], seriesId: parts.slice(0, 3).join(':') };
}

function resolveSeriesId(value) {
  if (String(value).startsWith('reelshort:')) return parseId(value).seriesId;
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('ReelShort 分享链接无效'); }
  const match = url.pathname.match(/^\/movie\/([a-z0-9-]+)-([a-zA-Z0-9_]+)\/?$/);
  if (url.origin !== ORIGIN || url.username || url.password || !match) throw new Error('请输入 ReelShort 官网剧集链接');
  return parseId(`reelshort:${match[2]}:${match[1]}`).seriesId;
}

async function request(route, params = {}, options = {}) {
  const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 10000;
  if (remaining <= 0) throw new Error('ReelShort 加载超时，请重试');
  const timeout = Math.min(10000, remaining), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const url = ORIGIN + route;
    const response = await axios.get(url, {
      ...webMediaRequestOptions(url), maxRedirects: 0, params,
      headers: { 'User-Agent': UA, Referer: ORIGIN + '/', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout, signal: controller.signal, responseType: 'text', maxContentLength: 4 * 1024 * 1024,
    });
    const json = String(response.data).match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script\s*>/i)?.[1];
    let data;
    try { data = JSON.parse(json); } catch (_) { throw new Error('ReelShort 官网数据格式已变化，请等待适配'); }
    if (!data?.props?.pageProps || typeof data.props.pageProps !== 'object') throw new Error('ReelShort 官网数据格式已变化，请等待适配');
    return data.props.pageProps;
  } catch (error) {
    const status = error.response?.status;
    if (status === 403 || status === 451) throw new Error(`ReelShort 当前地区或网络暂不可用（HTTP ${status}）`);
    if (status === 429) throw new Error('ReelShort 请求过于频繁，请稍后重试');
    if (error.message?.startsWith('ReelShort ')) throw error;
    throw new Error(controller.signal.aborted || ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)
      ? 'ReelShort 加载超时，请重试' : 'ReelShort 连接失败，请检查网络或稍后重试');
  } finally { clearTimeout(timer); }
}

function mediaUrl(value) {
  return typeof value === 'string' && value.startsWith('https://') && isPublicMediaUrl(value) ? value : '';
}
function locked(item) { return ['locked', 'is_locked', 'is_lock', 'isCharge'].some(key => [true, 1, '1'].includes(item?.[key])); }
function normalizeBook(book) {
  const id = String(book?.book_id || book?._id || ''), title = text(book?.book_title), path = slug(title);
  if (!ID.test(id) || !title || !SLUG.test(path) || path.length > 200) return null;
  return { series_id: `reelshort:${id}:${path}`, series_title: title, cover: mediaUrl(book.book_pic),
    episode_count: Number(book.chapter_count) || 0, intro: text(book.special_desc), source: 'reelshort',
    url: `${ORIGIN}/movie/${path}-${id}` };
}
function pageResult(books, page, genres = []) {
  const seen = new Set();
  const results = books.slice(0, 500).map(normalizeBook).filter(item => {
    if (!item || seen.has(item.series_id)) return false;
    seen.add(item.series_id); return true;
  });
  if (books.length && !results.length) throw new Error('ReelShort 片单缺少可用剧集编号，请等待适配');
  // shortcut: only the public website snapshot is supported; add pagination when upstream exposes a verified cursor.
  return { success: true, results, page, total: results.length, totalPages: page === 1 ? 1 : 0,
    hasMore: false, nextPage: null, genres, pageTitle: 'ReelShort（海外）', sourceUrl: ORIGIN + '/' };
}

async function browseList({ genre = '', page = 1 } = {}) {
  try {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('ReelShort 页码无效');
    if (page > 1) return pageResult([], page);
    const options = { deadline: Date.now() + 10000 };
    const data = await request('/', {}, options);
    const shelves = data.fallback?.['/api/ms/hall/webInfo']?.bookShelfList;
    if (!Array.isArray(shelves) || shelves.length > 100) throw new Error('ReelShort 官网片单格式已变化，请等待适配');
    const genres = shelves.map((shelf, index) => ({ slug: `shelf-${index}`, label: text(shelf.bookshelf_name) })).filter(item => item.label);
    const selected = genre ? genres.find(item => item.slug === genre) : null;
    if (genre && !selected) throw new Error('ReelShort 分类已变化，请重新选择');
    const entries = (selected ? [shelves[Number(selected.slug.slice(6))]] : shelves).flatMap(shelf => Array.isArray(shelf.books) ? shelf.books : []);
    const books = [], seen = new Set();
    // The public shelf may omit IDs; reuse upstream's exact-title search, capped at 12 books and one shared deadline.
    for (const book of entries) {
      const title = text(book?.book_title), key = title.toLowerCase();
      if (!title || seen.has(key)) continue;
      seen.add(key);
      if (normalizeBook(book)) books.push(book);
      else {
        const found = await search(title, 1, options);
        const matches = found.results?.filter(item => item.series_title.toLowerCase() === key) || [];
        if (!found.success || matches.length !== 1) throw new Error(found.error || 'ReelShort 片单缺少唯一对应的剧集编号，请按完整剧名搜索');
        books.push({ ...book, book_id: parseId(matches[0].series_id).bookId });
      }
      if (books.length >= 12) break;
    }
    return pageResult(books, page, genres);
  } catch (error) { return { success: false, error: error.message }; }
}

async function search(keyword, page = 1, options = {}) {
  try {
    const keywords = text(keyword);
    if (!keywords || keywords.length > 200 || !Number.isSafeInteger(page) || page < 1) throw new Error('ReelShort 搜索词或页码无效');
    if (page > 1) return pageResult([], page);
    const data = await request('/search', { keywords }, options);
    if (!Array.isArray(data.books)) throw new Error('ReelShort 官网搜索格式已变化，请等待适配');
    return pageResult(data.books, page);
  } catch (error) { return { success: false, error: error.message }; }
}

async function detail(seriesId) {
  const id = parseId(seriesId);
  const props = await request(`/movie/${id.slug}-${id.bookId}`), data = props.data;
  if (!data || !Array.isArray(data.online_base) || data.online_base.length > 10000
    || ((data.book_id || data._id) && String(data.book_id || data._id) !== id.bookId)) throw new Error('ReelShort 返回的剧集与请求不一致');
  return { id, data };
}

async function fetchEpisodeList(seriesId) {
  const { data } = await detail(seriesId);
  const series_title = text(data.book_title), cover = mediaUrl(data.book_pic), seen = new Map();
  if (!series_title) throw new Error('ReelShort 缺少剧集标题，请等待适配');
  const episodes = data.online_base.filter(ep => Number.isSafeInteger(Number(ep.serial_number)) && Number(ep.serial_number) > 0
    && Number(ep.serial_number) <= 9999 && ID.test(String(ep.chapter_id || ''))).map(ep => ({
    vid: `${seriesId}:${Number(ep.serial_number)}:${ep.chapter_id}`, vid_index: Number(ep.serial_number),
    title: text(ep.chapter_name) || `第 ${Number(ep.serial_number)} 集`, series_id: seriesId, series_title, cover,
    locked: locked(ep), source: 'reelshort',
  })).filter(ep => {
    if (seen.has(ep.vid_index) && seen.get(ep.vid_index) !== ep.vid) throw new Error('ReelShort 分集编号冲突，请等待适配');
    if (seen.has(ep.vid_index)) return false;
    seen.set(ep.vid_index, ep.vid); return true;
  }).sort((a, b) => a.vid_index - b.vid_index);
  if (!episodes.length) throw new Error('ReelShort 分集列表为空');
  return { series_id: seriesId, series_title, cover, intro: text(data.special_desc), total: episodes.length, episodes, source: 'reelshort' };
}

async function fetchPlayUrlSingle(vid, seriesId) {
  try {
    const id = parseId(vid, true);
    if (seriesId != null && seriesId !== '' && seriesId !== id.seriesId) throw new Error('ReelShort 分集不属于当前剧集');
    const list = await fetchEpisodeList(id.seriesId), episode = list.episodes.find(ep => ep.vid === vid);
    if (!episode) throw new Error('ReelShort 未找到该分集');
    if (episode.locked) return { url: null, source: 'reelshort', locked: true, error: '该集已锁定，请在 ReelShort 官方平台确认观看权限' };
    const props = await request(`/episodes/episode-${id.number}-${id.slug}-${id.bookId}-${id.chapterId}`, { play_time: 1 });
    const data = props.data;
    if (!data || Number(data.serial_number) !== id.number || (data.chapter_id && String(data.chapter_id) !== id.chapterId)) throw new Error('ReelShort 返回的分集与请求不一致');
    if (locked(data) || !data.video_url) return { url: null, source: 'reelshort', locked: true, error: '该集未提供公开播放地址，请在 ReelShort 官方平台确认观看权限' };
    const url = mediaUrl(data.video_url), extension = url && new URL(url).pathname.match(/\.(mp4|m3u8)$/i)?.[1].toLowerCase();
    if (!extension) throw new Error('ReelShort 未提供可直接播放的 HTTPS MP4 或 M3U8 地址');
    return { url, format: extension === 'm3u8' ? 'hls' : 'mp4', source: 'reelshort', spadeA: null, codec: '',
      vid, userAgent: UA, referer: ORIGIN + '/' };
  } catch (error) { return { url: null, source: 'reelshort', spadeA: null, codec: null, error: error.message }; }
}

module.exports = { resolveSeriesId, browseList, search, fetchEpisodeList, fetchPlayUrlSingle };
