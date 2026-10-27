'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fetchDanmaku } = require('./danmaku');
const { fetchEpisodeComments } = require('./episode-comments');
const { fetchPublicDetails } = require('./public-details');

const HONGGUO_ID = /^\d{6,30}$/;

// 原子写：临时文件 + rename；任何异常清理 tmp，不留半文件。
function writeJsonAtomic(target, obj) {
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

// 有界并发 map：最多 limit 个同时在跑，逐条隔离，返回每项结果数组（含错误对象）。
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

function danmakuDoc({ seriesId, seriesTitle, ep }, data, fetchedAt) {
  return { kind: 'danmaku', series_id: String(seriesId), episode_id: String(data.episode_id ?? ep.vid),
    episode_index: Number(ep.vid_index), series_title: seriesTitle, source: data.source || 'official',
    fetched_at: fetchedAt, truncated: data.truncated === true, notice: data.notice || '',
    items: (Array.isArray(data.items) ? data.items : []).map(it => ({ time: it.time, text: it.text, color: it.color || '', mode: it.mode || '' })) };
}

function commentsDoc({ seriesId, seriesTitle, ep }, data, fetchedAt) {
  return { kind: 'comments', series_id: String(seriesId), episode_id: String(data.episode_id ?? ep.vid),
    episode_index: Number(ep.vid_index), series_title: seriesTitle, fetched_at: fetchedAt,
    total: data.total ?? null, source_limited: data.source_limited === true, notice: data.notice || '',
    items: (Array.isArray(data.items) ? data.items : []).map(it => ({ id: it.id, content: it.content })) };
}

function reviewsDoc({ seriesId, seriesTitle }, reviews, fetchedAt) {
  return { kind: 'reviews', series_id: String(seriesId), series_title: seriesTitle, fetched_at: fetchedAt,
    total: reviews.total ?? null,
    items: (Array.isArray(reviews.items) ? reviews.items : []).map(it => ({ author: it.author, avatar: it.avatar || '',
      content: it.content, created_at: it.created_at ?? null, likes: it.likes ?? null, rating: it.rating ?? null })) };
}

async function exportSeriesText(options) {
  const {
    seriesId, seriesTitle, episodes = [], kinds = {}, downloadDir,
    reviewsBaseName, reviewsLimit = 1000, concurrency = 4,
    fetchers = { fetchDanmaku, fetchEpisodeComments, fetchPublicDetails },
    now = () => Date.now(),
  } = options || {};

  const tally = () => ({ ok: 0, fail: 0, skipped: 0 });
  const out = { danmaku: tally(), comments: tally(), reviews: tally(), files: [] };
  const wantDanmaku = kinds.danmaku === true, wantComments = kinds.comments === true, wantReviews = kinds.reviews === true;
  if (!wantDanmaku && !wantComments && !wantReviews) return out;

  // 仅红果数字来源支持文字；其它来源整体跳过、不发请求。
  if (!HONGGUO_ID.test(String(seriesId))) {
    if (wantDanmaku || wantComments) out.danmaku.skipped = out.comments.skipped = episodes.length;
    if (wantReviews) out.reviews.skipped = 1;
    return out;
  }

  // 目标已存在先返回 skipped（幂等）；取数返回非 success 或自身抛错均计 fail，绝不向上抛。
  const writeOne = async (filename, build, fetch) => {
    const target = path.join(downloadDir, filename);
    if (fs.existsSync(target)) return 'skipped';
    try {
      const data = await fetch();
      // 接受 success，也接受"中途失败但已保留部分"的 partial 结果（弹幕翻页中断）。
      if (!data || (data.success !== true && data.partial !== true)) return 'fail';
      writeJsonAtomic(target, build(data));
      out.files.push(target);
      return 'ok';
    } catch (_) { return 'fail'; }
  };

  // 剧评：整剧一次。
  if (wantReviews) out.reviews[await writeOne(`${reviewsBaseName}.reviews.json`,
    (d) => reviewsDoc({ seriesId, seriesTitle }, d.reviews, now()),
    () => fetchers.fetchPublicDetails(seriesId, '', { reviewsLimit }))]++;

  // 弹幕 / 评论：逐集，有界并发。worker 内部已隔离，mapLimit 的 catch 仅兜底。
  if (wantDanmaku || wantComments) {
    const results = await mapLimit(episodes, concurrency, async (ep) => {
      const cell = {};
      if (wantDanmaku) cell.danmaku = await writeOne(`${ep.stem}.danmaku.json`,
        (d) => danmakuDoc({ seriesId, seriesTitle, ep }, d, now()),
        () => fetchers.fetchDanmaku({ seriesId, vid: ep.vid }));
      if (wantComments) cell.comments = await writeOne(`${ep.stem}.comments.json`,
        (d) => commentsDoc({ seriesId, seriesTitle, ep }, d, now()),
        () => fetchers.fetchEpisodeComments({ seriesId, episodeId: ep.vid, cursor: null, limit: 30 }));
      return cell;
    });
    for (const r of results) {
      if (!r.ok) { if (wantDanmaku) out.danmaku.fail++; if (wantComments) out.comments.fail++; continue; }
      if (wantDanmaku) out.danmaku[r.value.danmaku]++;
      if (wantComments) out.comments[r.value.comments]++;
    }
  }

  return out;
}

module.exports = { exportSeriesText };
