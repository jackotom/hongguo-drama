const axios = require('axios');
const { isPublicMediaUrl } = require('./web-media-guard');

const API = 'https://xifan-api-cn.youlishipin.com';
const ID = /^[a-zA-Z0-9_-]{1,200}$/;
let genreCache;

function plainText(value) {
  return String(value || '').replace(/<[^>]*>/g, '').trim();
}

function parseId(value, episode = false) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'xifan' || parts.length !== (episode ? 4 : 3) || !parts.slice(1).every(part => ID.test(part))) {
    throw new Error('西饭剧集编号无效');
  }
  return { source: parts[1], duanjuId: parts[2], episodeId: parts[3], seriesId: parts.slice(0, 3).join(':') };
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && isPublicMediaUrl(url.href) ? url.href : '';
  } catch (_) { return ''; }
}

async function request(apiPath, params, options = {}) {
  const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 10000;
  if (remaining <= 0) throw new Error('西饭加载超时，请重试');
  const timeout = Math.min(10000, remaining);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const { data } = await axios.get(API + apiPath, {
      params: { ...params, version: 2001001, androidVersionCode: 28 },
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      timeout, signal: controller.signal, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024,
    });
    if (data?.ret !== 0 || !data.result || typeof data.result !== 'object') throw new Error('invalid result');
    return data.result;
  } catch (_) {
    throw new Error(controller.signal.aborted ? '西饭加载超时，请重试' : '西饭来源暂不可用，请稍后重试');
  } finally { clearTimeout(timer); }
}

function contents(result) {
  return (Array.isArray(result.elements) ? result.elements : []).flatMap(element => Array.isArray(element?.contents) ? element.contents : []);
}

async function genres(forceRefresh) {
  if (!forceRefresh && genreCache?.expires > Date.now()) return genreCache.items;
  const result = await request('/xifan/drama/portalPage', { reqType: 'duanjuCategory' });
  const seen = new Set();
  const items = contents(result).flatMap(item => {
    const category = item.categoryItemVo;
    return category ? (Array.isArray(category.subCategories) ? category.subCategories : [category]) : [];
  }).filter(item => Number.isSafeInteger(item.categoryId) && item.categoryId > 0 && plainText(item.oppoCategory))
    .map(item => ({ slug: `${item.categoryId}-${Buffer.from(item.oppoCategory).toString('hex')}`,
      label: plainText(item.oppoCategory), categoryId: item.categoryId, version: Number(item.version) || 1 }))
    .filter(item => { if (seen.has(item.slug)) return false; seen.add(item.slug); return true; });
  if (!items.length) throw new Error('西饭没有返回可用分类，请重试');
  genreCache = { expires: Date.now() + 300000, items };
  return items;
}

function normalizeList(result, page, categoryItems = []) {
  const seen = new Set();
  const results = contents(result).map(item => item.duanjuVo)
    .filter(item => item && ID.test(String(item.source || '')) && ID.test(String(item.duanjuId || '')) && plainText(item.title))
    .map(item => ({ series_id: `xifan:${item.source}:${item.duanjuId}`, series_title: plainText(item.title),
      cover: httpsUrl(item.coverImageUrl), episode_count: Number(item.total) || 0,
      tags: Array.isArray(item.categories) ? item.categories.map(plainText).filter(Boolean).slice(0, 4) : [], source: 'xifan', url: '' }))
    .filter(item => { if (seen.has(item.series_id)) return false; seen.add(item.series_id); return true; });
  const hasMore = result.hasMore === true && results.length > 0;
  return { success: true, results, page, total: 0, totalPages: 0, hasMore, nextPage: hasMore ? page + 1 : null,
    genres: categoryItems.map(({ slug, label }) => ({ slug, label })), pageTitle: '西饭短剧', sourceUrl: '' };
}

async function browseList(options = {}) {
  try {
    const { genre = '', page = 1, forceRefresh = false } = options || {};
    const pg = Math.max(1, Number.parseInt(page, 10) || 1);
    const items = await genres(forceRefresh);
    const selected = genre ? items.find(item => item.slug === genre) : items.find(item => item.label === '都市') || items[0];
    if (!selected) throw new Error('西饭题材无效，请重新选择');
    const result = await request('/xifan/drama/portalPage', { reqType: 'aggregationPage', offset: (pg - 1) * 30,
      categoryId: selected.categoryId, categoryNames: selected.label, categoryVersion: selected.version });
    return normalizeList(result, pg, items);
  } catch (error) { return { success: false, error: error.message }; }
}

async function search(keyword, page = 1, options = {}) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请输入搜索关键词');
    const pg = Math.max(1, Number.parseInt(page, 10) || 1);
    return normalizeList(await request('/xifan/search/getSearchList', { keyword: kw, pageIndex: pg }, options), pg);
  } catch (error) { return { success: false, error: error.message }; }
}

async function detail(seriesId) {
  const { source, duanjuId } = parseId(seriesId);
  const result = await request('/xifan/drama/getDuanjuInfo', { source, duanjuId });
  if (result.source !== source || String(result.duanjuId) !== duanjuId || !Array.isArray(result.episodeList)) {
    throw new Error('西饭返回的剧集与请求不一致');
  }
  return result;
}

// Only exact, verified upstream metadata conflicts. Do not infer a conflict from a
// title that merely looks like another drama; false positives hide legitimate episode names.
const VERIFIED_TITLE_CONFLICTS = new Map([
  ['xifan:jiuzhou:253\u0000天龙战神', new Set(['爱归良辰'])],
]);

function episodeDisplayTitle(seriesId, seriesTitle, title) {
  const blocked = VERIFIED_TITLE_CONFLICTS.get(`${seriesId}\u0000${seriesTitle}`);
  return blocked?.has(title) ? '' : title;
}

async function fetchEpisodeList(seriesId) {
  const result = await detail(seriesId);
  const series_title = plainText(result.title) || '未命名短剧';
  const cover = httpsUrl(result.coverImageUrl);
  const episodes = result.episodeList.filter(episode => ID.test(String(episode.episodeId || ''))).map(episode => ({
    vid: `${seriesId}:${episode.episodeId}`, vid_index: Number(episode.index) || 0,
    title: episodeDisplayTitle(seriesId, series_title, plainText(episode.title)), series_id: seriesId, series_title, cover,
    locked: episode.unlock !== true, source: 'xifan',
  })).sort((a, b) => a.vid_index - b.vid_index);
  if (!episodes.length) throw new Error('西饭分集列表为空');
  return { series_id: seriesId, series_title, cover, total: episodes.length, episodes, source: 'xifan' };
}

async function fetchPlayUrlSingle(vid, sid) {
  try {
    const id = parseId(vid, true);
    if (sid && String(sid) !== id.seriesId) throw new Error('西饭分集不属于当前剧集');
    // Always re-read access state, even when an earlier address or episode list was cached.
    const result = await detail(id.seriesId);
    const episode = result.episodeList.find(item => String(item.episodeId) === id.episodeId);
    if (!episode) throw new Error('西饭未找到该分集');
    if (episode.unlock !== true) return { url: null, spadeA: null, codec: null, source: 'xifan', locked: true,
      error: `第 ${Number(episode.index) || ''} 集当前锁定，请在西饭官方 App 确认可看范围` };
    const url = httpsUrl(episode.playUrl);
    if (!url) throw new Error('西饭未提供有效 HTTPS 播放地址');
    return { url, spadeA: null, codec: '', source: 'xifan' };
  } catch (error) { return { url: null, spadeA: null, codec: null, source: 'xifan', error: error.message }; }
}

module.exports = { browseList, search, fetchEpisodeList, fetchPlayUrlSingle, episodeDisplayTitle };
