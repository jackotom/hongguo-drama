import { BUILTIN_MEDIA_SOURCES, CUSTOM_SOURCE_ID, normalizeMediaSources } from './mediaSourcesModel.mjs';

export const RANDOM_SOURCES = [['all', '全部来源'], ['hongguo', '红果'], ['xifan', '西饭'], ['hema', '河马']];
const SOURCE_IDS = {
  hongguo: /^\d{6,30}$/,
  xifan: /^xifan:[a-zA-Z0-9_-]{1,200}:[a-zA-Z0-9_-]{1,200}$/,
  hema: /^hema:\d{1,30}$/,
  dramabox: /^dramabox:\d{1,24}$/,
  reelshort: /^reelshort:[a-zA-Z0-9_]{1,100}:[a-z0-9]+(?:-[a-z0-9]+)*$/,
};

// IPC requests cannot be aborted in transit; cancellation stops waiting and all subsequent UI/player work.
export async function waitForRequest(promise, { signal, timeoutMs = 25_000, message = '加载超时，请重试' } = {}) {
  signal?.throwIfAborted();
  let timer, abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      abort = () => reject(signal.reason || new DOMException('已取消', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function loadRandomPool(browseList, { source = 'all', forceRefresh = false, signal, timeoutMs, sources: available = BUILTIN_MEDIA_SOURCES } = {}) {
  const ids = normalizeMediaSources(available).map(item => item.id);
  const sources = source === 'all' ? ids : ids.includes(source) ? [source] : [];
  if (!sources.length) throw new Error('请选择有效来源');
  const pages = await Promise.all(sources.map(async source => {
    try {
      signal?.throwIfAborted();
      const result = await waitForRequest(browseList({ source, category: 'real-drama', page: 1, forceRefresh }), { signal, timeoutMs });
      if (!result?.success) return [];
      const seen = new Set();
      return (Array.isArray(result.results) ? result.results : []).filter(item => {
        const id = String(item?.series_id || '');
        const validId = SOURCE_IDS[source]?.test(id) || (CUSTOM_SOURCE_ID.test(source) && id.startsWith(`${source}:`) && /^\d{1,30}$/.test(id.slice(source.length + 1)));
        if (!validId || typeof item.series_title !== 'string' || !item.series_title.trim() || item.locked || seen.has(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, 60).map(item => ({ ...item, series_id: String(item.series_id), series_title: item.series_title.trim(), source }));
    } catch (error) {
      if (signal?.aborted) throw error;
      return [];
    }
  }));
  signal?.throwIfAborted();
  return { items: pages.flat(), unavailable: sources.filter((_, index) => !pages[index].length) };
}

export function pickRandomDrama(items, previous, random = Math.random) {
  const candidates = items.filter(item => item.series_id !== previous?.series_id && (!previous || item.series_title !== previous.series_title));
  return candidates.length ? candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))] : null;
}

export async function playRecommendedDrama(api, item, { signal, resume = true } = {}) {
  signal?.throwIfAborted();
  const result = await waitForRequest(api.searchResolve(item.series_id), { signal, message: '分集加载超时，请重试本剧' });
  signal?.throwIfAborted();
  if (!result?.success) throw new Error(result?.error || '暂时无法加载这部剧');
  if (String(result.data?.series_id) !== String(item.series_id)) throw new Error('来源返回的剧集不匹配，请重试');
  const playable = result.data.episodes?.filter(episode => !episode.locked && Number.isSafeInteger(episode.vid_index) && episode.vid_index > 0) || [];
  const first = playable[0];
  if (!first) throw new Error('这部剧暂时没有可免费播放的分集，请换一部');
  let saved = null;
  if (resume && typeof api.getPlaybackPosition === 'function') {
    try { saved = await waitForRequest(api.getPlaybackPosition(String(item.series_id)), { signal, message: '读取播放进度超时，请重试本剧' }); }
    catch (error) { if (signal?.aborted) throw error; }
  }
  const savedIndex = Number(saved?.vid_index);
  const target = savedIndex > 0 ? playable.find(episode => episode.vid_index === savedIndex) : null;
  const episode = target || first;
  const playback = await waitForRequest(api.playSeries({ seriesId: String(item.series_id), vidIndex: episode.vid_index, resume: !!target }), { signal, message: '打开剧库超时，请重试' });
  if (!playback?.success) throw new Error(playback?.error || '打开剧库失败，请重试');
}
