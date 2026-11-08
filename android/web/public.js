import request from './transport.js';
const SITE = 'https://hongguoduanju.com';
export async function website(path, signal) {
  let url = new URL(path, SITE);
  for (let hops = 0; hops < 4; hops++) {
    if (url.origin !== SITE || url.username || url.password) throw new Error('官网跳转地址不受支持');
    const response = await request({url:url.href,signal,timeout:12000});
    if ([301,302,303,307,308].includes(response.status) && response.headers?.location) {
      url = new URL(response.headers.location,url); continue;
    }
    if (response.status !== 200) throw new Error(`官网暂不可用（HTTP ${response.status}）`);
    return response.data;
  }
  throw new Error('官网跳转次数过多');
}
export function readRouter(html) {
  const match = html.match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/);
  if (!match) throw new Error('官网未返回剧集数据');
  const start = match.index + match[0].length - 1;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('官网剧集数据不完整');
}
function playerData(html, sid) {
  const loader = readRouter(html).loaderData || {};
  const data = loader['player_(series_id)/(vid)/page'] || loader['player_(series_id)/page'];
  if (!data || data.isSuccess === false || String(data.series_id) !== sid || String(data.seriesDetail?.series_id) !== sid) throw new Error('官网剧集身份不匹配');
  return data;
}
export function parseDetail(html, sid) {
  const data = playerData(html, sid), detail = data.seriesDetail;
  const vids = detail.vid_list;
  if (!Array.isArray(vids) || !vids.length || vids.length > 2000 || vids.some(id => !/^\d{1,30}$/.test(String(id))) || new Set(vids.map(String)).size !== vids.length) throw new Error('官网分集列表无效');
  return {
    series_id: sid, series_title: String(detail.series_name || '未命名短剧'),
    cover: String(detail.series_cover || ''), description: String(detail.series_intro || ''),
    episodes: vids.map((id, i) => ({vid: String(id), number: i + 1})),
  };
}
export function parsePublicPlay(html, sid, vid) {
  const data = playerData(html, sid), seo = data.publicVideoSeo;
  if (String(data.vid) !== vid || !seo || seo.available !== true || String(seo.itemId) !== vid || String(seo.seriesId) !== sid) throw new Error('官网分集信息不匹配');
  if (data.protectedPlayback === true) throw new Error('官网仅提供预览，请使用App片源');
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(script[1])) continue;
    try {
      const video = JSON.parse(script[2]);
      if (video['@type'] !== 'VideoObject') continue;
      const url = new URL(video.contentUrl), page = new URL(video.url);
      if (url.origin !== SITE || !url.pathname.startsWith(`/video/public/${vid}/`) || url.username || url.password || page.origin !== SITE || page.pathname !== `/player/${sid}/${vid}`) continue;
      return {url: url.href, contentKey: null, codec: 'h264'};
    } catch (_) { /* A different JSON-LD object is not a playable source. */ }
  }
  throw new Error('官网没有可确认的完整片源');
}
