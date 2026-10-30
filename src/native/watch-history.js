function totalEpisodes(series) {
  return Math.max(Number(series?.total) || 0, series?.episodes?.length || 0);
}

function isWatched(record) {
  return record && (record.watched === true || Number(record.currentTime) > 0)
    && Number.isFinite(record.updatedAt) && Number.isInteger(record.vid_index) && record.vid_index > 0;
}

function listHistory(series, playback, showSequels = true) {
  const watched = series.filter(item => isWatched(playback[item.series_id]));
  const latestByFamily = new Map();
  for (const item of watched) {
    const key = familyKey(item);
    if (key) latestByFamily.set(key, Math.max(latestByFamily.get(key) || 0, seasonOf(item)));
  }
  return watched.map(item => {
    const record = playback[item.series_id];
    const sequels = showSequels && Array.isArray(record.sequels) ? record.sequels : [];
    const confirmedIds = new Set(sequels.map(candidate => String(candidate.series_id)));
    const seen = new Set(record.seenSequelIds || []);
    const total = Math.max(totalEpisodes(item), record.knownTotal || 0);
    const family = familyKey(item), season = seasonOf(item);
    return {
      series_id: item.series_id, series_title: item.series_title, cover: item.cover || '',
      total, completed: total > 0 && Number.isInteger(record.completedEpisode) && record.completedEpisode >= total,
      vid_index: record.vid_index, currentTime: record.currentTime, updatedAt: record.updatedAt,
      unreadEpisodes: record.unreadEpisodes || 0, sequels,
      similarSeries: showSequels ? findSimilarSeries(item, [...(Array.isArray(record.similarSeries) ? record.similarSeries : []), ...watched])
        .filter(candidate => !confirmedIds.has(candidate.series_id)) : [],
      hasUpdates: record.unreadEpisodes > 0 || sequels.some(candidate => !seen.has(candidate.series_id)),
      season, isLatestSeason: !!family && season === latestByFamily.get(family),
      hasHigherSeason: !!family && season < latestByFamily.get(family),
      lastCheckedAt: record.lastCheckedAt || 0, lastCheckError: record.lastCheckError || '',
      lastEpisodeCheckError: record.lastEpisodeCheckError || '', lastSequelCheckError: record.lastSequelCheckError || '',
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

function recordPlayback(previous, series, index, time, now = Date.now(), metadata = {}) {
  if (!Number.isInteger(index) || index < 1 || !Number.isFinite(time) || time < 0) throw new Error('无效的播放进度');
  const baseline = previous?.knownTotal ?? totalEpisodes(series);
  const duration = metadata?.duration;
  const completed = metadata?.ended === true && Number.isFinite(duration) && duration > 0
    && time >= duration - Math.min(1, duration * 0.01) && time <= duration + 1
    && index === Math.max(totalEpisodes(series), baseline);
  return { ...previous, vid_index: index, currentTime: time, updatedAt: now, watched: true,
    ...(completed ? { completedEpisode: Math.max(Number.isInteger(previous?.completedEpisode) ? previous.completedEpisode : 0, index) } : {}),
    knownTotal: baseline, acknowledgedTotal: previous?.acknowledgedTotal ?? baseline };
}

function applyEpisodeUpdate(record, oldSeries, freshSeries, now = Date.now()) {
  // Never roll back a newer cached episode list just because a slower refresh returned less.
  const baseline = Math.max(Number(record.knownTotal) || 0, totalEpisodes(oldSeries));
  const knownTotal = Math.max(baseline, totalEpisodes(freshSeries));
  const acknowledgedTotal = record.acknowledgedTotal ?? baseline;
  return { ...record, knownTotal, acknowledgedTotal,
    unreadEpisodes: Math.max(0, knownTotal - acknowledgedTotal), lastCheckedAt: now,
    lastEpisodeCheckError: '', lastCheckError: record.lastSequelCheckError || '' };
}

function seasonTitle(title) {
  const text = String(title || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const match = text.match(/^(.*?)(?:(?:第)?([一二三四五六七八九十百零两\d]+)[季部]|[（(](?:第)?([一二三四五六七八九十百零两\d]+)(?:[季部])?[）)]|season(\d+))$/i);
  if (!match) return { base: text, season: 1, explicit: false };
  const value = match[2] || match[3] || match[4];
  let season = Number(value);
  if (!Number.isFinite(season)) {
    const digits = {零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
    let n = 0, digit = 0;
    for (const char of value) {
      if (char === '十' || char === '百') { n += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
      else digit = digits[char] || 0;
    }
    season = /[十百]/.test(value) ? n + digit : Number([...value].map(char => digits[char]).join(''));
  }
  // Bare bracket numbers can be years or other title metadata; accept only modest season numbers.
  if (match[3] && season > 99) return { base: text, season: 1, explicit: false };
  if (!Number.isSafeInteger(season) || season < 1) return { base: text, season: 1, explicit: false, invalid: true };
  return { base: match[1], season, explicit: true };
}

function sourceOf(id) {
  if (/^\d{6,30}$/.test(id)) return 'hongguo';
  if (/^xifan:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(id)) return 'xifan';
  if (/^hema:\d+$/.test(id)) return 'hema';
  return null;
}

function familyKey(series) {
  const parsed = seasonTitle(series?.series_title);
  const source = sourceOf(String(series?.series_id || ''));
  if (!source || !parsed.base || parsed.invalid) return '';
  return `${source}\u0000${parsed.base}`;
}

function seasonOf(series) {
  const parsed = seasonTitle(series?.series_title);
  return parsed.invalid ? 0 : parsed.season;
}

// shortcut: independent sequels have no authoritative relation; only exact base titles with higher explicit seasons qualify.
function findSequels(series, candidates) {
  const current = seasonTitle(series.series_title);
  const source = sourceOf(String(series.series_id));
  if (!current.base || current.invalid || !source) return [];
  const seen = new Set([String(series.series_id)]);
  return candidates.filter(candidate => {
    const id = String(candidate.series_id || '');
    const next = seasonTitle(candidate.series_title);
    if (seen.has(id) || sourceOf(id) !== source || !next.explicit || next.invalid || next.base !== current.base || next.season <= current.season) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => seasonTitle(a.series_title).season - seasonTitle(b.series_title).season)
    .slice(0, 10).map(candidate => ({ series_id: String(candidate.series_id), series_title: String(candidate.series_title) }));
}

function sequelKeyword(series) { return seasonTitle(series.series_title).base; }

function similarTitles(left, right) {
  const a = Array.from(left), b = Array.from(right), length = Math.max(a.length, b.length);
  // shortcut: at most two edits and 20% of the title; broader renames need source metadata.
  const limit = Math.min(2, Math.floor(length / 5));
  if (Math.min(a.length, b.length) < 4 || length > 200 || Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...current) > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

function findSimilarSeries(series, candidates) {
  const current = seasonTitle(series?.series_title), family = familyKey(series);
  if (!family) return [];
  const normalize = title => title.replace(/[\p{P}\p{S}]/gu, '').replace(/[零〇一二三四五六七八九十百两\d]+/g, '#');
  const title = normalize(current.base), source = sourceOf(String(series.series_id));
  const seen = new Set([String(series.series_id)]), results = [];
  const latest = new Map(candidates.map(candidate => [String(candidate?.series_id || ''), candidate]));
  for (const candidate of latest.values()) {
    const id = String(candidate?.series_id || ''), next = seasonTitle(candidate?.series_title);
    if (seen.has(id) || sourceOf(id) !== source || next.invalid || familyKey(candidate) === family) continue;
    if (!similarTitles(title, normalize(next.base))) continue;
    seen.add(id);
    results.push({ series_id: id, series_title: String(candidate.series_title) });
    if (results.length === 5) break;
  }
  return results;
}

function acknowledge(record, snapshot) {
  const knownTotal = record.knownTotal || 0;
  const visibleTotal = snapshot ? Number(snapshot.total) || 0 : knownTotal;
  const acknowledgedTotal = Math.max(record.acknowledgedTotal || 0, Math.min(knownTotal, visibleTotal));
  const knownIds = new Set((record.sequels || []).map(item => item.series_id));
  const visibleIds = snapshot ? (Array.isArray(snapshot.sequelIds) ? snapshot.sequelIds : []) : [...knownIds];
  return { ...record, acknowledgedTotal, unreadEpisodes: Math.max(0, knownTotal - acknowledgedTotal),
    seenSequelIds: [...new Set([...(record.seenSequelIds || []), ...visibleIds.filter(id => knownIds.has(id))])] };
}

module.exports = { listHistory, recordPlayback, applyEpisodeUpdate, seasonTitle, sourceOf, familyKey, seasonOf, findSequels, findSimilarSeries, sequelKeyword, acknowledge };
