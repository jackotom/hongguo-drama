const axios = require('axios');
let net;
try { ({ net } = require('electron')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const { webMediaRequestOptions } = require('./web-media-guard');

const SITE = 'https://hongguoduanju.com';
const CATEGORIES = new Set(['real-drama', 'comic-drama', 'ai-drama', 'comic']);
const RANKINGS = new Set(['hot-drama', 'hot-real-drama', 'hot-comic-drama', 'hot-ai-drama']);
const TIMEOUT_MS = 10000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
// 分类页与热播页共用同一份目录缓存；30 秒过短会让每次切页都直连来源。
const CACHE_MS = 120000;
const cache = new Map();
const pending = new Map();

function publicMetadata(item) {
  const episode_label = typeof item?.episode_right_text === 'string' ? item.episode_right_text.trim().slice(0, 80) : '';
  const completion_status = /^(?:全\s*\d+\s*集|已完结|完结)$/.test(episode_label) ? 'completed'
    : /连载|更新至\s*\d+\s*集/.test(episode_label) ? 'ongoing' : 'unknown';
  const raw = Number(item?.first_visible_time);
  const timestamp = raw < 1e12 ? raw * 1000 : raw;
  // create_time is not an established release date, and numeric series_status has no verified mapping.
  const published_at = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() ? timestamp : null;
  return { episode_label, completion_status, published_at };
}

// Read only the JSON assignment; never execute scripts received from the website.
function readRouterData(html) {
  const match = String(html).match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/);
  if (!match) throw new Error('来源页面未返回目录数据，请重试或打开来源页面');
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('来源目录数据不完整，请重试');
}

function parseCatalog(html, category, page, sourceUrl) {
  const router = readRouterData(html);
  const data = Object.values(router.loaderData || {}).find(value => value?.categoryRoute?.contentType === category);
  if (!data || data.isSuccess === false || !Array.isArray(data.recommendList)) {
    throw new Error('来源目录暂不可用，请重试或打开来源页面');
  }
  const pageTitle = data.seo?.title || '';
  if (category === 'comic') {
    return { success: true, results: [], page: 1, total: 0, totalPages: 0, genres: [], pageTitle, sourceUrl,
      unsupported: true, emptyMessage: '漫画属于图文阅读，暂不支持视频播放或下载；请切换「漫剧」或打开来源页面阅读。' };
  }
  const seen = new Set();
  const results = data.recommendList.filter(item => {
    if (!/^\d{6,}$/.test(item?.series_id) || typeof item.series_name !== 'string' || !item.series_name.trim() || seen.has(String(item.series_id))) return false;
    seen.add(String(item.series_id));
    return true;
  }).map(item => ({
    series_id: String(item.series_id), series_title: item.series_name.trim(), cover: item.series_cover || '',
    episode_count: Number(item.episode_cnt) || 0,
    tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string').slice(0, 4) : [],
    ...publicMetadata(item),
    url: `${SITE}/detail?series_id=${item.series_id}`,
  }));
  const genres = (Array.isArray(data.selectorList) ? data.selectorList : []).flatMap(row => Array.isArray(row?.items) ? row.items : [])
    .filter(item => /^[a-z0-9-]+$/.test(item?.selector_item_id) && typeof item.show_name === 'string')
    .map(item => ({ slug: item.selector_item_id, label: item.show_name }));
  return { success: true, results, page: Number(data.pagination?.pageNum) || page,
    total: Number(data.pagination?.total) || 0, totalPages: Number(data.pagination?.totalPages) || 0,
    genres, pageTitle, sourceUrl };
}

function decodeHtml(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (entity, key) => {
    if (key[0] !== '#') return ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' })[key.toLowerCase()];
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function parseRanking(html, category, page, sourceUrl) {
  const text = value => decodeHtml(String(value).replace(/<[^>]*>/g, ' ')).trim();
  let data;
  // Streaming SSR puts the public payload inside an HTML-encoded JSON argument.
  // Parse its literals only; no remote functions or scripts are ever executed.
  for (const script of String(html).matchAll(/<script\b([^>]*)>/gi)) {
    if (!/data-fn-name=["']mergeLoaderData["']/.test(script[1])) continue;
    const encoded = script[1].match(/data-fn-args=(?:"([^"]*)"|'([^']*)')/);
    if (!encoded) continue;
    try {
      const args = JSON.parse(decodeHtml(encoded[1] ?? encoded[2]));
      if (args[0] !== `rank_${category}/page` || !Array.isArray(args[1])) continue;
      const content = args[1].find(item => item.key === 'content' && item.routerDataFnName === 'p');
      if (content?.routerDataFnArgs?.[0]) data = JSON.parse(content.routerDataFnArgs[0]);
    } catch (_) { /* Some streamed responses expose only their rendered cards. */ }
  }
  const seen = new Set();
  const normalize = item => {
    const id = String(item.seriesId || '');
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const rank = Number(item.rank);
    if (!/^\d{6,}$/.test(id) || !title || !Number.isSafeInteger(rank) || rank < 1 || seen.has(id)) return null;
    seen.add(id);
    return { series_id: id, series_title: title,
      cover: typeof item.cover === 'string' && /^https?:\/\//.test(item.cover) ? item.cover : '',
      episode_count: Array.isArray(item.episodeVids) ? item.episodeVids.length : 0,
      tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string').slice(0, 4) : [],
      rank, heat: typeof item.heatText === 'string' ? item.heatText.trim() : '',
      ...publicMetadata(item),
      url: `${SITE}/detail?series_id=${id}` };
  };
  let results = data?.isSuccess !== false && Array.isArray(data?.rankList) ? data.rankList.map(normalize).filter(Boolean) : [];
  if (!results.length) {
    // Some pages omit the resolved loader. Semantic headings and detail links remain in SSR HTML.
    for (const match of String(html).matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
      const article = match[1];
      const heading = article.match(/<h2\b[^>]*\bid=["']rank-title-(\d+)["'][^>]*>([\s\S]*?)<\/h2>/i);
      if (!heading || !article.includes(`/detail?series_id=${heading[1]}`)) continue;
      const cover = article.match(/<img\b[^>]*\bsrc=(?:"([^"]*)"|'([^']*)')/i);
      const tags = article.match(/<p\b[^>]*class=["'][^"']*pc-categories-[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
      const item = normalize({ seriesId: heading[1], title: text(heading[2]),
        rank: article.match(/<span\b[^>]*>\s*(\d+)\s*<\/span>/i)?.[1],
        heatText: text(article).match(/[\d.,]+\s*[万亿]?\s*热度/)?.[0] || '',
        cover: cover ? decodeHtml(cover[1] ?? cover[2]) : '',
        tags: tags ? Array.from(tags[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi), tag => text(tag[1])) : [],
      });
      if (item) results.push(item);
    }
  }
  if (!results.length) throw new Error('来源榜单暂不可用，请重试或打开来源页面');
  const nav = String(html).match(/<nav\b[^>]*aria-label=["']榜单分页["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] || '';
  const current = Number(data?.pagination?.pageNum) || Number(nav.match(/aria-current=["']page["'][^>]*>(\d+)/)?.[1]) || page;
  const pages = Array.from(nav.matchAll(/href=["']([^"']+)["']/g), match => {
    try {
      const url = new URL(decodeHtml(match[1]), SITE);
      return url.origin === SITE && url.pathname === `/rank/${category}` ? Number(url.searchParams.get('page')) || 1 : 0;
    } catch (_) { return 0; }
  });
  return { success: true, results, page: current, total: 0,
    totalPages: Number(data?.pagination?.totalPages) || Math.max(current, ...pages),
    genres: [], pageTitle: text(String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), sourceUrl };
}

async function fetchCatalogPageWithNet(url, signal, proxyLogin) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, useSessionCookies: false, headers: { 'Cache-Control': 'no-cache' } });
    let settled = false;
    const finish = (error, html) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) { reject(error); request.abort(); }
      else resolve(html);
    };
    const abort = () => finish(new Error('目录加载超时，请重试'));
    signal.addEventListener('abort', abort, { once: true });
    request.on('error', finish);
    request.on('login', (auth, callback) => proxyLogin ? proxyLogin(auth, callback) : callback());
    request.on('response', response => {
      const status = response.statusCode;
      if (status < 200 || status >= 300) return finish(new Error(`目录请求失败（HTTP ${status}）`));
      if (Number(response.headers['content-length']) > MAX_PAGE_BYTES) return finish(new Error('目录页面过大，请稍后重试'));
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_PAGE_BYTES) return finish(new Error('目录页面过大，请稍后重试'));
        chunks.push(chunk);
      });
      response.on('error', finish);
      response.on('aborted', () => finish(new Error('目录连接被中断，请重试或切换来源')));
      response.on('end', () => { if (!settled) finish(null, Buffer.concat(chunks, size).toString('utf8')); });
    });
    if (signal.aborted) abort();
    else request.end();
  });
}

async function fetchCatalogPageWithTrustedDns(url, signal) {
  // The system resolver can return a VPN Fake-IP whose CDN route hangs.
  // Use the same trusted DoH/official-host path as media; only a public official URL is allowed.
  const response = await axios.get(url, {
    ...webMediaRequestOptions(url, { trustedOfficialDns: true }), timeout: TIMEOUT_MS, signal, responseType: 'text', maxContentLength: MAX_PAGE_BYTES,
  });
  return response.data;
}

async function fetchCatalogPage(url, signal, proxyLogin, allowTrustedDns, parse) {
  if (!net?.request) {
    const html = allowTrustedDns ? await fetchCatalogPageWithTrustedDns(url, signal) : (await axios.get(url, {
      timeout: TIMEOUT_MS, signal, responseType: 'text', maxContentLength: MAX_PAGE_BYTES,
    })).data;
    return parse(html);
  }
  if (!allowTrustedDns) return parse(await fetchCatalogPageWithNet(url, signal, proxyLogin));

  // Only a parsed page wins; a fast CDN error page must not cancel a healthy route.
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.any([
      fetchCatalogPageWithNet(url, controller.signal, proxyLogin).then(parse),
      fetchCatalogPageWithTrustedDns(url, controller.signal).then(parse),
    ]);
  } catch (aggregate) {
    throw aggregate.errors?.find(error => /HTTP \d+|超时/.test(error.message)) || aggregate.errors?.[0] || aggregate;
  } finally {
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
async function browseList(options = {}, proxyLogin) {
  const { category = 'real-drama', genre = '', page = 1, forceRefresh = false } = options || {};
  const ranking = RANKINGS.has(category);
  if ((!CATEGORIES.has(category) && !ranking) || (genre && (!/^[a-z0-9-]+$/.test(genre) || ranking))) return { success: false, error: '无效的目录分类或题材' };
  const pg = Math.max(1, Number.parseInt(page, 10) || 1);
  const url = `${SITE}/${ranking ? 'rank' : 'category'}/${category}${genre ? `/${genre}` : ''}${pg > 1 ? `?page=${pg}` : ''}`;
  if (!forceRefresh && cache.get(url)?.expires > Date.now()) return cache.get(url).data;
  if (pending.has(url)) return pending.get(url);

  // Each URL owns its request: a slow comic page cannot queue behind real drama (or vice versa).
  const task = (async () => {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('目录加载超时，请重试')); }, TIMEOUT_MS);
      });
      const data = await Promise.race([fetchCatalogPage(url, controller.signal, proxyLogin, options.allowTrustedDns === true,
        html => (ranking ? parseRanking : parseCatalog)(html, category, pg, url)), timeout]);
      cache.set(url, { expires: Date.now() + CACHE_MS, data });
      // Bound memory while retaining the latest category/filter pages.
      if (cache.size > 32) cache.delete(cache.keys().next().value);
      return data;
    } catch (error) {
      const message = controller.signal.aborted || error.code === 'ECONNABORTED' ? '目录加载超时，请重试'
        : /ECONNRESET|ERR_CONNECTION_RESET/.test(`${error.code} ${error.message}`)
          ? '红果连接被中断，请重试或切换来源（ECONNRESET）' : error.message;
      return { success: false, error: message, sourceUrl: url };
    } finally {
      clearTimeout(timer);
      pending.delete(url);
    }
  })();
  pending.set(url, task);
  return task;
}

module.exports = { browseList, readRouterData, publicMetadata };
