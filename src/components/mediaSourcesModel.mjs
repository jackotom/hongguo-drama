export const BUILTIN_MEDIA_SOURCES = [
  { id: 'hongguo', label: '红果短剧' }, { id: 'xifan', label: '西饭短剧' }, { id: 'hema', label: '河马短剧' },
  { id: 'reelshort', label: 'ReelShort（海外）', enabled: false },
  { id: 'dramabox', label: 'DramaBox（海外）', enabled: false },
];
export const CUSTOM_SOURCE_ID = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeMediaSources(sources) {
  const seen = new Set();
  return (Array.isArray(sources) ? sources : []).filter(source => {
    if (!source || source.enabled === false || typeof source.label !== 'string' || !source.label.trim() || seen.has(source.id)
      || (!CUSTOM_SOURCE_ID.test(source.id) && !BUILTIN_MEDIA_SOURCES.some(item => item.id === source.id))) return false;
    seen.add(source.id); return true;
  }).map(source => ({ id: source.id, label: source.label.trim(), ...(CUSTOM_SOURCE_ID.test(source.id) ? { custom: true } : {}) }));
}

export function mediaSourceLabel(seriesOrSource, sources = BUILTIN_MEDIA_SOURCES) {
  const id = String(seriesOrSource || '');
  const source = id.startsWith('custom:') ? id.split(':').slice(0, 2).join(':')
    : id.startsWith('xifan:') ? 'xifan' : id.startsWith('hema:') ? 'hema' : id.startsWith('reelshort:') ? 'reelshort' : id.startsWith('dramabox:') ? 'dramabox' : /^\d+$/.test(id) ? 'hongguo' : id;
  return sources.find(item => item.id === source)?.label || BUILTIN_MEDIA_SOURCES.find(item => item.id === source)?.label
    || (source.startsWith('custom:') ? '自定义源（未启用或已移除）' : '未知来源');
}

export function createMediaSourcesStore(load) {
  let snapshot = { sources: normalizeMediaSources(BUILTIN_MEDIA_SOURCES), revision: 0, loading: true, error: '' };
  let pending = null, loaded = false;
  const listeners = new Set();
  const emit = patch => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    refresh(force = false) {
      if (!force && pending) return pending;
      if (!force && loaded) return Promise.resolve(snapshot);
      const revision = snapshot.revision + 1;
      emit({ revision, loading: true, error: '' });
      pending = (async () => {
        try {
          const result = await load();
          if (snapshot.revision !== revision) return;
          if (!result?.success || !Array.isArray(result.sources)) throw new Error(result?.error || '来源列表加载失败，请重试');
          loaded = true;
          emit({ sources: normalizeMediaSources(result.sources), loading: false });
        } catch (error) {
          if (snapshot.revision === revision) emit({ loading: false, error: error.message || '来源列表加载失败，请重试' });
        } finally { if (snapshot.revision === revision) pending = null; }
      })();
      return pending;
    },
  };
}
