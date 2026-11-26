const STORAGE_KEY = 'hongguo:public-library:v1';
const CHANGE_EVENT = 'hongguo:public-library-changed';
const MAX_TRANSIENT_SERIES = 500;
const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function emitLibraryChange(snapshot) {
  if (typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: snapshot }));
  } else {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

function pruneLibrary(items) {
  const retained = [];
  const transient = [];
  for (const item of items) {
    if (item.favorite || (item.liked_episode_ids && item.liked_episode_ids.length > 0)) retained.push(item);
    else transient.push(item);
  }
  return [...retained, ...transient.slice(-MAX_TRANSIENT_SERIES)];
}

export const validPublishedAt = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime());

const episodeLikeIds = value => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) return null;
  return [...new Set(value.map(id => id.trim()))];
};

export function readLocalLibrary() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items) || items.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || typeof item.favorite !== 'boolean' || (item.published_at !== null && !validPublishedAt(item.published_at)))) {
      throw new Error('保存的数据格式不正确');
    }
    const normalized = items.map(item => {
      const liked_episode_ids = episodeLikeIds(item.liked_episode_ids);
      if (!liked_episode_ids) throw new Error('保存的数据格式不正确');
      return { ...item, liked_episode_ids };
    });
    return { items: normalized, error: '' };
  } catch (error) {
    return { items: [], error: `无法读取本机收藏与日历：${error.message}。原有数据未改动。` };
  }
}

export function saveLocalSeries({ id, title, published_at, favorite, cover, liked_episode_ids }) {
  const current = readLocalLibrary();
  if (current.error) return current;
  const seriesId = String(id || '').trim();
  if (!seriesId || !String(title || '').trim()) return { ...current, error: '缺少剧集名称或编号，无法保存到本机。' };
  const previous = current.items.find(item => item.id === seriesId);
  const nextEpisodeLikeIds = liked_episode_ids === undefined ? previous?.liked_episode_ids || [] : episodeLikeIds(liked_episode_ids);
  if (!nextEpisodeLikeIds) return { ...current, error: '分集小红心数据格式不正确，本机记录未改动。' };
  const next = {
    id: seriesId,
    title: String(title).trim(),
    published_at: validPublishedAt(published_at) ? published_at : previous?.published_at ?? null,
    favorite: typeof favorite === 'boolean' ? favorite : previous?.favorite ?? false,
    cover: typeof cover === 'string' && /^https?:\/\//i.test(cover) ? cover : previous?.cover || '',
    liked_episode_ids: nextEpisodeLikeIds,
  };
  const items = pruneLibrary([...current.items.filter(item => item.id !== seriesId), next]);
  try {
    // Persist public metadata and local reactions, never reviews.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.map(item => ({ id: item.id, title: item.title, published_at: item.published_at, favorite: item.favorite, cover: item.cover || '', liked_episode_ids: item.liked_episode_ids }))));
    const snapshot = { items, error: '' };
    emitLibraryChange(snapshot);
    return snapshot;
  } catch (error) {
    return { ...current, error: `未能保存到本机：${error.message}。请释放存储空间后重试。` };
  }
}

export function removeLocalSeries(id) {
  const current = readLocalLibrary();
  if (current.error) return current;
  const items = current.items.filter(item => item.id !== id);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    const snapshot = { items, error: '' };
    emitLibraryChange(snapshot);
    return snapshot;
  } catch (error) {
    return { ...current, error: `未能移除本机记录：${error.message}。原有记录未改动。` };
  }
}

export function subscribeLocalLibrary(callback) {
  const refresh = event => {
    if (event.type === 'storage' && event.key !== STORAGE_KEY && event.key !== null) return;
    if (event.type === CHANGE_EVENT && event.detail && Array.isArray(event.detail.items)) {
      callback(event.detail);
      return;
    }
    callback(readLocalLibrary());
  };
  window.addEventListener(CHANGE_EVENT, refresh);
  window.addEventListener('storage', refresh);
  return () => {
    window.removeEventListener(CHANGE_EVENT, refresh);
    window.removeEventListener('storage', refresh);
  };
}

export function publicDateKey(timestamp) {
  if (!validPublishedAt(timestamp)) return '';
  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(timestamp);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
