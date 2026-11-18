const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const COMPLETED_LOW_INTERVAL = 24 * 60 * 60 * 1000;
const SEQUEL_INTERVAL = 24 * 60 * 60 * 1000;
const BATCH_BUDGET = 90 * 1000;
const ITEM_TIMEOUT = 10 * 1000;
const SEQUEL_TIMEOUT = 12 * 1000;
const GROUP_CONCURRENCY = 2;
const EPISODE_CONCURRENCY = 2;
const SEQUEL_CACHE_TTL = 30 * 60 * 1000;
const SEQUEL_FAILURE_TTL = 5 * 60 * 1000;
const SCOPES = new Set(['all', 'latest', 'unfinished', 'skip-completed-low']);

function createHistoryService({
  ipcMain,
  watchHistory,
  seriesSearch,
  store,
  hongguo,
  Notification,
  getSettings,
  getSeriesRegistry,
  upsertSeriesRegistry,
  saveSeriesRegistry,
  searchAtSource,
  send,
  safeErrorText,
  onNotificationClick,
}) {
  let refreshPromise = null;
  const itemChecks = new Map();
  const sequelPending = new Map();
  const sequelCache = new Map();

  function rows() {
    return watchHistory.listHistory(getSeriesRegistry(), store.getPlayback(), getSettings().watch_sequels_enabled !== false);
  }

  function options(value) {
    const raw = typeof value === 'boolean' ? { force: value } : (value && typeof value === 'object' ? value : {});
    return { force: raw.force === true, scope: SCOPES.has(raw.scope) ? raw.scope : 'all' };
  }

  function groups(items) {
    const result = new Map();
    for (const row of items) {
      const key = watchHistory.familyKey(row) || `series:${row.series_id}`;
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(row);
    }
    return [...result.values()];
  }

  function familyRows(allRows, row) {
    const key = watchHistory.familyKey(row);
    return key ? allRows.filter(item => watchHistory.familyKey(item) === key) : [row];
  }

  function scopeRows(items, scope) {
    if (scope === 'latest') return items.filter(row => row.isLatestSeason);
    if (scope === 'unfinished') return items.filter(row => !row.completed);
    if (scope === 'skip-completed-low') return items.filter(row => !(row.completed && !row.isLatestSeason));
    return items;
  }

  function interval(row) {
    return row.completed && !row.isLatestSeason ? COMPLETED_LOW_INTERVAL : CHECK_INTERVAL;
  }

  function priority(row) {
    if (row.hasUpdates) return 0;
    if (!row.completed) return 1;
    if (row.isLatestSeason) return 2;
    return 3;
  }

  function deadline(ms) { return Date.now() + ms; }

  function timeout(promise, ms, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms)); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function runPool(items, concurrency, worker, end = 0) {
    let cursor = 0;
    const width = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: width }, async () => {
      while (cursor < items.length) {
        if (end && Date.now() >= end) return;
        const item = items[cursor++];
        await worker(item);
      }
    }));
  }

  function sequelResult(series, end, retryFailed = false) {
    const key = watchHistory.familyKey(series) || `series:${series.series_id}`;
    const now = Date.now();
    let cached = sequelCache.get(key);
    if (retryFailed && cached && (cached.result?.success !== true || cached.result?.partial === true)) {
      sequelCache.delete(key);
      cached = null;
    }
    if (cached && cached.expires > now) return Promise.resolve(cached.result);
    if (sequelPending.has(key)) return sequelPending.get(key);
    const task = (async () => {
      const searchDeadline = Math.min(end || deadline(SEQUEL_TIMEOUT), deadline(SEQUEL_TIMEOUT));
      const registry = getSeriesRegistry().filter(item => !item.forgotten);
      const local = watchHistory.findSequels(series, registry);
      let result;
      try {
        result = await timeout(seriesSearch.findSeriesSequels(series, registry,
          (keyword, call) => searchAtSource(keyword, {
            source: watchHistory.sourceOf(String(series.series_id)), deadline: searchDeadline, ...(call || {}),
          }), { deadline: searchDeadline }), Math.max(1000, searchDeadline - Date.now()), '续作搜索超时');
      } catch (error) {
        result = { success: false, results: local, candidates: local, partial: true, error: error.message };
      }
      const ok = result?.success === true && result?.partial !== true;
      sequelCache.set(key, { result, expires: Date.now() + (ok ? SEQUEL_CACHE_TTL : SEQUEL_FAILURE_TTL) });
      if (sequelCache.size > 64) sequelCache.delete(sequelCache.keys().next().value);
      return result;
    })().finally(() => sequelPending.delete(key));
    sequelPending.set(key, task);
    return task;
  }

  function context(items, allRows, force, end, retryFailed = false) {
    const family = familyRows(allRows, items[0]);
    const latest = family.reduce((best, row) => watchHistory.seasonOf(row) > watchHistory.seasonOf(best) ? row : best, family[0]);
    const sequelDue = new Set();
    if (getSettings().watch_sequels_enabled !== false) {
      for (const row of items) {
        const previous = store.getPlayback()[String(row.series_id)];
        if (force || Date.now() - (previous?.lastSequelCheckAt || 0) >= SEQUEL_INTERVAL) sequelDue.add(String(row.series_id));
      }
    }
    const latestSeries = getSeriesRegistry().find(item => String(item.series_id) === String(latest.series_id));
    const sequelPromise = sequelDue.size && latestSeries && watchHistory.sourceOf(String(latestSeries.series_id))
      ? sequelResult(latestSeries, end, retryFailed) : null;
    return { sequelDue, sequelPromise, deadline: end, notifiedSequelIds: new Set() };
  }

  async function checkRow(row, runContext) {
    const sid = String(row.series_id);
    if (itemChecks.has(sid)) return itemChecks.get(sid);
    const task = (async () => {
      const itemDeadline = Math.min(runContext.deadline, deadline(ITEM_TIMEOUT));
      try {
        const fresh = await timeout(hongguo.fetchEpisodeList(sid, { force: true, deadline: itemDeadline }),
          Math.max(1, itemDeadline - Date.now()), '分集更新检查超时');
        if (!Array.isArray(fresh?.episodes) || !fresh.episodes.length) throw new Error('来源没有返回分集，请稍后重试');
        let sequelResponse = null;
        if (runContext.sequelPromise && runContext.sequelDue.has(sid)) sequelResponse = await runContext.sequelPromise;

        let currentSeries, next, newEpisodes = false, rowCandidates = [], unseenSequels = [], knownSequels = new Set();
        const updated = store.updatePlayback(map => {
          if (!map[sid]) return false;
          currentSeries = getSeriesRegistry().find(item => String(item.series_id) === sid);
          if (!currentSeries) return false;
          const previousRecord = map[sid];
          next = watchHistory.applyEpisodeUpdate(previousRecord, currentSeries, fresh);
          const latestSeason = sequelResponse ? familyRows(watchHistory.listHistory(getSeriesRegistry(), map, false), currentSeries)
            .reduce((latest, item) => Math.max(latest, item.season), 0) : 0;
          if (sequelResponse) {
            const candidates = watchHistory.findSequels(currentSeries, sequelResponse.candidates || sequelResponse.results || [], latestSeason);
            const combined = new Map(watchHistory.findSequels(currentSeries, previousRecord.sequels || [], latestSeason).map(item => [item.series_id, item]));
            for (const item of candidates) combined.set(item.series_id, item);
            next.sequels = [...combined.values()].slice(-20);
            next.similarSeries = watchHistory.findSimilarSeries(currentSeries,
              [...(Array.isArray(previousRecord.similarSeries) ? previousRecord.similarSeries : []), ...(sequelResponse.candidates || sequelResponse.results || [])]);
            next.lastSequelCheckError = sequelResponse.partial ? (sequelResponse.error || '请稍后重试') : '';
            if (sequelResponse.success === true && sequelResponse.partial !== true) next.lastSequelCheckAt = Date.now();
          }
          next.lastCheckError = next.lastSequelCheckError ? `续作检查未完成：${next.lastSequelCheckError}` : '';
          newEpisodes = next.knownTotal > (previousRecord.knownTotal ?? currentSeries.total ?? currentSeries.episodes?.length ?? 0);
          knownSequels = new Set((previousRecord.sequels || []).map(item => item.series_id));
          rowCandidates = sequelResponse
            ? watchHistory.findSequels(currentSeries, sequelResponse.candidates || sequelResponse.results || [], latestSeason)
            : [];
          if (fresh.episodes.length >= (currentSeries.episodes?.length || 0)) {
            const wasDismissed = currentSeries.dismissed === true;
            const wasForgotten = currentSeries.forgotten === true;
            upsertSeriesRegistry(fresh);
            if (wasDismissed) {
              Object.assign(getSeriesRegistry().find(item => String(item.series_id) === sid), { dismissed: true, forgotten: wasForgotten });
              saveSeriesRegistry();
            }
          }
          map[sid] = next;
          return true;
        });
        if (!updated) return { status: 'skipped' };
        const newSequel = sequelResponse?.success === true && rowCandidates.some(item => !knownSequels.has(item.series_id));
        const settings = getSettings();
        unseenSequels = rowCandidates.filter(item => !knownSequels.has(item.series_id) && !runContext.notifiedSequelIds.has(item.series_id));
        for (const item of unseenSequels) runContext.notifiedSequelIds.add(item.series_id);
        if ((newEpisodes || unseenSequels.length) && settings.watch_notifications_enabled === true && Notification?.isSupported()) {
          try {
            const title = currentSeries.series_title || fresh.series_title || '短剧';
            const notification = new Notification({ title: `${title} 有更新`,
              body: newEpisodes ? `已更新至 ${next.knownTotal} 集，打开观看记录继续看。` : '发现疑似新一季，打开观看记录查看。' });
            notification.on('click', onNotificationClick);
            notification.show();
          } catch (error) { console.warn('[History] 系统通知不可用:', error.message); }
        }
        return { status: 'checked', hasUpdates: newEpisodes || newSequel,
          error: next.lastEpisodeCheckError || next.lastSequelCheckError || '' };
      } catch (error) {
        const message = safeErrorText(error.message);
        try {
          store.updatePlayback(map => {
            if (!map[sid]) return;
            map[sid] = { ...map[sid], lastCheckedAt: Date.now(), lastEpisodeCheckError: message,
              lastSequelCheckError: map[sid].lastSequelCheckError || '', lastCheckError: message };
          });
        } catch {}
        return { status: 'failed', error: error.message };
      }
    })().finally(() => itemChecks.delete(sid));
    itemChecks.set(sid, task);
    return task;
  }

  async function refresh(forceOrOptions = false) {
    if (refreshPromise) return refreshPromise;
    const selected = options(forceOrOptions);
    if (!selected.force && getSettings().watch_updates_enabled === false) {
      return { success: true, checked: 0, failed: 0, remaining: 0, disabled: true };
    }
    refreshPromise = (async () => {
      const now = Date.now();
      const allRows = rows();
      const scoped = scopeRows(allRows, selected.scope);
      const eligible = scoped.filter(item => selected.force || now - item.lastCheckedAt >= interval(item));
      const grouped = groups(eligible).sort((a, b) => {
        const value = items => Math.min(...items.map(priority));
        return value(a) - value(b) || Math.max(...b.map(row => row.updatedAt)) - Math.max(...a.map(row => row.updatedAt));
      });
      const end = deadline(BATCH_BUDGET);
      const processed = new Set();
      let checked = 0, failed = 0, skipped = 0;
      send('watch-history-progress', { phase: 'start', total: eligible.length, checked, failed, current: '', remaining: eligible.length });
      await runPool(grouped, GROUP_CONCURRENCY, async group => {
        if (Date.now() >= end) return;
        const groupContext = context(group, allRows, selected.force, end, selected.force);
        await runPool(group, EPISODE_CONCURRENCY, async row => {
          const result = await checkRow(row, groupContext);
          processed.add(String(row.series_id));
          if (result.status === 'checked') { checked++; if (result.error) failed++; }
          else if (result.status === 'failed') failed++;
          else skipped++;
          const remaining = eligible.filter(item => !processed.has(String(item.series_id))).length;
          send('watch-history-progress', { phase: 'running', total: eligible.length, checked, failed, skipped, current: row.series_title, remaining });
        }, end);
      }, end);
      const remaining = eligible.filter(item => !processed.has(String(item.series_id))).length;
      send('watch-history-progress', { phase: 'done', total: eligible.length, checked, failed, skipped, current: '', remaining });
      send('watch-history-updated', {});
      return { success: true, checked, failed, skipped, remaining, total: eligible.length, scope: selected.scope };
    })().catch(error => ({ success: false, error: error.message })).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  ipcMain.handle('remove-watch-history', async (_event, seriesId) => {
    try {
      store.updatePlayback(map => { delete map[String(seriesId)]; });
      send('watch-history-updated', { removedSeriesId: String(seriesId) });
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });
  ipcMain.handle('get-watch-history', async () => ({ success: true, results: rows() }));
  ipcMain.handle('refresh-watch-history', async (_event, selected) => refresh({ force: true, scope: selected?.scope }));
  ipcMain.handle('check-watch-history-item', async (_event, seriesId) => {
    const sid = String(seriesId || '');
    const allRows = rows();
    const row = allRows.find(item => String(item.series_id) === sid);
    if (!row) return { success: false, error: '未找到这条观看记录，请刷新后重试。' };
    const result = await checkRow(row, context([row], allRows, true, deadline(ITEM_TIMEOUT + SEQUEL_TIMEOUT), true));
    send('watch-history-updated', {});
    return { success: result.status !== 'failed', checked: result.status === 'checked' ? 1 : 0,
      failed: result.status === 'failed' || result.error ? 1 : 0, status: result.status, error: result.error || '' };
  });
  ipcMain.handle('acknowledge-watch-updates', async (_event, seriesId, snapshot) => {
    try {
      const sid = String(seriesId);
      store.updatePlayback(map => {
        if (map[sid]) map[sid] = watchHistory.acknowledge(map[sid], snapshot);
      });
      send('watch-history-updated', {});
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  return { rows, refresh, sequelCache };
}

module.exports = { createHistoryService };
