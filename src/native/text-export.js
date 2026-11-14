'use strict';
// Adapted from jayeeliu's PR #61, with path, partial-result and concurrent-write fixes (GPL-3.0).
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fetchDanmaku } = require('./danmaku');
const { fetchEpisodeComments } = require('./episode-comments');
const { fetchPublicDetails } = require('./public-details');

const HONGGUO_ID = /^\d{6,30}$/;
const pending = new Map();

function targetStamp(target) {
  try {
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true, stamp: null };
    return { exists: true, stamp: { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      birthtimeNs: stat.birthtimeNs == null ? '' : String(stat.birthtimeNs) } };
  } catch (error) { return { exists: error.code === 'ENOENT' ? false : true, stamp: null }; }
}

function sameStamp(a, b) {
  if (a === null) return b === null;
  if (b === null) return false;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

function targetUnchanged(target, initial) {
  const now = targetStamp(target);
  if (initial.exists !== now.exists) return false;
  if (!initial.exists) return true;
  if (initial.stamp === null || now.stamp === null) return false;
  return sameStamp(initial.stamp, now.stamp);
}

function writeJsonAtomic(target, obj, initial) {
  // 随机临时名 + wx：不碰可能被替换成链接的固定 .tmp，也不跟随未知文件。
  const tmp = path.join(path.dirname(target), `.hg-json-${randomUUID()}.tmp`);
  try {
    if (!targetUnchanged(target, initial)) throw new Error('导出目标已变化，未覆盖');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n', 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (!targetUnchanged(target, initial)) throw new Error('导出目标已变化，未覆盖');
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = { ok: true, value: await worker(items[index], index) }; }
      catch (error) { results[index] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

const isPartial = data => data.partial === true || data.truncated === true || data.source_limited === true ||
  (Number.isFinite(data.total) && Array.isArray(data.items) && data.total > data.items.length);

function danmakuDoc({ seriesId, seriesTitle, ep }, data, fetchedAt) {
  return { kind: 'danmaku', series_id: String(seriesId), episode_id: String(data.episode_id ?? ep.vid),
    episode_index: Number(ep.vid_index), series_title: seriesTitle, source: data.source || 'official',
    fetched_at: fetchedAt, truncated: data.truncated === true, partial: isPartial(data), notice: data.notice || '',
    items: (Array.isArray(data.items) ? data.items : []).map(it => ({ time: it.time, text: it.text, color: it.color || '', mode: it.mode || '' })) };
}

function commentsDoc({ seriesId, seriesTitle, ep }, data, fetchedAt) {
  return { kind: 'comments', series_id: String(seriesId), episode_id: String(data.episode_id ?? ep.vid),
    episode_index: Number(ep.vid_index), series_title: seriesTitle, fetched_at: fetchedAt,
    total: data.total ?? null, source_limited: data.source_limited === true, partial: isPartial(data), notice: data.notice || '',
    items: (Array.isArray(data.items) ? data.items : []).map(it => ({ id: it.id, content: it.content })) };
}

function reviewsDoc({ seriesId, seriesTitle }, reviews, fetchedAt) {
  return { kind: 'reviews', series_id: String(seriesId), series_title: seriesTitle, fetched_at: fetchedAt,
    total: reviews.total ?? null, partial: isPartial(reviews),
    items: (Array.isArray(reviews.items) ? reviews.items : []).map(it => ({ author: it.author, avatar: it.avatar || '',
      content: it.content, created_at: it.created_at ?? null, likes: it.likes ?? null, rating: it.rating ?? null })) };
}

async function writeOne(target, build, fetch, check) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return { status: 'fail' };
  target = path.resolve(target);
  if (pending.has(target)) return pending.get(target);
  const task = (async () => {
    try {
      let retry = false, initial;
      try {
        const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (previous?.partial !== true) return { status: 'skipped', itemCount: Array.isArray(previous?.items) ? previous.items.length : undefined };
        retry = true;
        initial = targetStamp(target);
      } catch (error) { if (error.code !== 'ENOENT') throw error; initial = { exists: false, stamp: null }; }
      const data = await fetch(retry);
      if (data?.success === false && data.source_limited === true && data.code === 'EPISODE_COMMENTS_UNAVAILABLE')
        return { status: 'unavailable' };
      // Failed retries preserve the original partial file, even when the retry returns some items.
      if (!data || (data.success !== true && (retry || data.partial !== true))) return { status: 'fail' };
      const doc = build(data);
      // 等待期间任务/父目录/NAS 身份可能已被替换；核验失败不覆盖外来同名文件。
      if (typeof check === 'function') check(target);
      writeJsonAtomic(target, doc, initial);
      return { status: 'ok', partial: doc.partial === true, itemCount: doc.items.length, target };
    } catch (_) { return { status: 'fail' }; }
  })();
  pending.set(target, task);
  try { return await task; }
  finally { pending.delete(target); }
}

async function exportSeriesText(options = {}) {
  const {
    seriesId, seriesTitle, episodes = [], kinds = {}, reviewsPath,
    reviewsLimit = 1000, concurrency = 4,
    check,
    fetchers = { fetchDanmaku, fetchEpisodeComments, fetchPublicDetails }, now = () => Date.now(),
  } = options;
  const tally = () => ({ ok: 0, fail: 0, skipped: 0, partial: 0, items: 0, empty: 0, unavailable: 0 });
  const out = { danmaku: tally(), comments: tally(), reviews: tally(), files: [] };
  const wantDanmaku = kinds.danmaku === true, wantComments = kinds.comments === true, wantReviews = kinds.reviews === true;
  if (!wantDanmaku && !wantComments && !wantReviews) return out;
  if (!HONGGUO_ID.test(String(seriesId))) {
    if (wantDanmaku) out.danmaku.skipped = episodes.length;
    if (wantComments) out.comments.skipped = episodes.length;
    if (wantReviews) out.reviews.skipped = 1;
    return out;
  }

  const record = (kind, result) => {
    out[kind][result.status]++;
    if (Number.isInteger(result.itemCount)) {
      out[kind].items += result.itemCount;
      if (result.itemCount === 0) out[kind].empty++;
    }
    if (result.status === 'ok') {
      if (result.partial) out[kind].partial++;
      if (!out.files.includes(result.target)) out.files.push(result.target);
    }
  };
  if (wantReviews) record('reviews', await writeOne(reviewsPath,
    d => reviewsDoc({ seriesId, seriesTitle }, d.reviews, now()),
    () => fetchers.fetchPublicDetails(String(seriesId), '', { reviewsLimit }), check));

  if (wantDanmaku || wantComments) {
    const results = await mapLimit(episodes, concurrency, async ep => {
      const stem = typeof ep?.savePath === 'string' && path.isAbsolute(ep.savePath) && /\.mp4$/i.test(ep.savePath)
        ? ep.savePath.slice(0, -4) : null;
      const cell = {};
      if (wantDanmaku) cell.danmaku = await writeOne(stem ? `${stem}.danmaku.json` : null,
        d => danmakuDoc({ seriesId, seriesTitle, ep }, d, now()),
        fresh => fetchers.fetchDanmaku({ seriesId: String(seriesId), vid: ep.vid, fresh }), check);
      if (wantComments) cell.comments = await writeOne(stem ? `${stem}.comments.json` : null,
        d => commentsDoc({ seriesId, seriesTitle, ep }, d, now()),
        () => fetchers.fetchEpisodeComments({ seriesId: String(seriesId), episodeId: ep.vid, cursor: null, limit: 30 }), check);
      return cell;
    });
    for (const r of results) {
      if (!r.ok) { if (wantDanmaku) out.danmaku.fail++; if (wantComments) out.comments.fail++; continue; }
      if (wantDanmaku) record('danmaku', r.value.danmaku);
      if (wantComments) record('comments', r.value.comments);
    }
  }
  return out;
}

module.exports = { exportSeriesText };
