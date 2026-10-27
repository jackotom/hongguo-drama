const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportSeriesText } = require('./text-export');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hg-export-'));
const SID = '7240000000000000001'; // 合法红果数字 ID（守卫只认这个形态）
const episodes = [
  { vid: '7503780574541122622', vid_index: 1, stem: '测试剧_第001集' },
  { vid: '7503780577347128382', vid_index: 2, stem: '测试剧_第002集' },
];
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

const okFetchers = () => ({
  fetchDanmaku: async () => ({ success: true, source: 'official', series_id: 'S', episode_id: 'V',
    items: [{ time: 1.5, text: '冲', color: '#fff', mode: 'scroll' }], total: 1, truncated: false, notice: '' }),
  fetchEpisodeComments: async () => ({ success: true, series_id: 'S', episode_id: 'V',
    items: [{ id: 'a1', content: '好看' }], total: 15536, source_limited: true, notice: '部分评论' }),
  fetchPublicDetails: async () => ({ success: true, series_id: 'S',
    reviews: { total: 999, items: [{ author: 'u', avatar: '', content: '剧评', created_at: 1, likes: 2, rating: 5 }] } }),
});

test('三类各写一份 JSON，schema 正确，目录与 mp4 同名前缀', async () => {
  const dir = tmp();
  const res = await exportSeriesText({ seriesId: SID, seriesTitle: '测试剧', episodes,
    kinds: { danmaku: true, comments: true, reviews: true }, downloadDir: dir,
    reviewsBaseName: '测试剧', fetchers: okFetchers(), now: () => 1700000000000 });
  assert.deepEqual(res.danmaku, { ok: 2, fail: 0, skipped: 0 });
  assert.deepEqual(res.comments, { ok: 2, fail: 0, skipped: 0 });
  assert.deepEqual(res.reviews, { ok: 1, fail: 0, skipped: 0 });
  const d = read(dir, '测试剧_第001集.danmaku.json');
  assert.equal(d.kind, 'danmaku'); assert.equal(d.truncated, false);
  assert.equal(d.fetched_at, 1700000000000); assert.deepEqual(d.items[0], { time: 1.5, text: '冲', color: '#fff', mode: 'scroll' });
  const c = read(dir, '测试剧_第001集.comments.json');
  assert.equal(c.source_limited, true); assert.equal(c.total, 15536); assert.deepEqual(c.items[0], { id: 'a1', content: '好看' });
  const r = read(dir, '测试剧.reviews.json');
  assert.equal(r.total, 999); assert.equal(r.items[0].content, '剧评');
  assert.equal(res.files.length, 5);
});

test('非红果来源整体跳过、不取数', async () => {
  const dir = tmp();
  let touched = 0;
  const fetchers = { fetchDanmaku: async () => { touched++; return { success: true, items: [] }; },
    fetchEpisodeComments: async () => { touched++; return { success: true, items: [] }; },
    fetchPublicDetails: async () => { touched++; return { success: true, reviews: { items: [] } }; } };
  const res = await exportSeriesText({ seriesId: 'xifan:1', seriesTitle: 'T', episodes,
    kinds: { danmaku: true, comments: true, reviews: true }, downloadDir: dir,
    reviewsBaseName: 'T', fetchers });
  assert.equal(touched, 0, 'xifan/hema/custom 不发任何取数请求');
  assert.deepEqual(res.files, []);
  assert.ok(res.danmaku.skipped > 0);
});

test('评论 source_limited/零条仍落盘，不算失败', async () => {
  const dir = tmp();
  const fetchers = okFetchers();
  fetchers.fetchEpisodeComments = async () => ({ success: true, series_id: 'S', episode_id: 'V',
    items: [], total: 0, source_limited: true, notice: '本集暂无可显示的公开评论' });
  const res = await exportSeriesText({ seriesId: SID, seriesTitle: 'T', episodes: [episodes[0]],
    kinds: { comments: true }, downloadDir: dir, reviewsBaseName: 'T', fetchers });
  assert.equal(res.comments.ok, 1); assert.equal(res.comments.fail, 0);
  assert.deepEqual(read(dir, '测试剧_第001集.comments.json').items, []);
});

test('弹幕 truncated 如实写入 JSON', async () => {
  const dir = tmp();
  const fetchers = okFetchers();
  fetchers.fetchDanmaku = async () => ({ success: true, source: 'official', series_id: 'S', episode_id: 'V',
    items: Array.from({ length: 3 }, (_, i) => ({ time: i, text: `t${i}`, color: '', mode: '' })), total: 3, truncated: true, notice: '弹幕较多' });
  await exportSeriesText({ seriesId: SID, seriesTitle: 'T', episodes: [episodes[0]],
    kinds: { danmaku: true }, downloadDir: dir, reviewsBaseName: 'T', fetchers });
  const d = read(dir, '测试剧_第001集.danmaku.json');
  assert.equal(d.truncated, true); assert.equal(d.notice, '弹幕较多');
});

test('目标已存在则跳过、不覆盖、不重复取数', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '测试剧_第001集.danmaku.json'), 'OLD', 'utf8');
  let calls = 0;
  const fetchers = { ...okFetchers(), fetchDanmaku: async () => { calls++; return okFetchers().fetchDanmaku(); } };
  const res = await exportSeriesText({ seriesId: SID, seriesTitle: 'T', episodes: [episodes[0]],
    kinds: { danmaku: true }, downloadDir: dir, reviewsBaseName: 'T', fetchers });
  assert.equal(calls, 0, '已存在不再发请求');
  assert.equal(fs.readFileSync(path.join(dir, '测试剧_第001集.danmaku.json'), 'utf8'), 'OLD', '旧文件不被覆盖');
  assert.deepEqual(res.danmaku, { ok: 0, fail: 0, skipped: 1 });
});

test('单集取数抛异常被隔离，其余照常', async () => {
  const dir = tmp();
  const fetchers = okFetchers();
  fetchers.fetchDanmaku = async ({ vid }) => { if (vid === episodes[0].vid) throw new Error('网络炸了');
    return { success: true, source: 'official', series_id: 'S', episode_id: vid, items: [], total: 0, truncated: false, notice: '' }; };
  const res = await exportSeriesText({ seriesId: SID, seriesTitle: 'T', episodes,
    kinds: { danmaku: true }, downloadDir: dir, reviewsBaseName: 'T', fetchers });
  assert.deepEqual(res.danmaku, { ok: 1, fail: 1, skipped: 0 });
  assert.ok(fs.existsSync(path.join(dir, '测试剧_第002集.danmaku.json')), '坏的那集不影响好集');
  assert.ok(!fs.existsSync(path.join(dir, '测试剧_第001集.danmaku.json')), '失败不写半文件');
});

test('弹幕 partial（翻页中断但保留已获取部分）仍导出，不判失败', async () => {
  const dir = tmp();
  const fetchers = okFetchers();
  fetchers.fetchDanmaku = async () => ({ success: false, partial: true, source: 'official', series_id: SID, episode_id: 'V',
    items: [{ time: 1, text: 'a', color: '', mode: '' }], total: 1, truncated: false, notice: '后续弹幕加载中断，已保留已获取的部分' });
  const res = await exportSeriesText({ seriesId: SID, seriesTitle: '测试剧', episodes: [episodes[0]],
    kinds: { danmaku: true }, downloadDir: dir, reviewsBaseName: '测试剧', fetchers });
  assert.equal(res.danmaku.ok, 1);
  assert.deepEqual(read(dir, '测试剧_第001集.danmaku.json').items, [{ time: 1, text: 'a', color: '', mode: '' }]);
});

test('success:false 视为失败，不写文件', async () => {
  const dir = tmp();
  const fetchers = okFetchers();
  fetchers.fetchDanmaku = async () => ({ success: false, error: '仅红果来源的剧集支持弹幕', items: [] });
  const res = await exportSeriesText({ seriesId: SID, seriesTitle: 'T', episodes: [episodes[0]],
    kinds: { danmaku: true }, downloadDir: dir, reviewsBaseName: 'T', fetchers });
  assert.equal(res.danmaku.fail, 1);
  assert.ok(!fs.existsSync(path.join(dir, '测试剧_第001集.danmaku.json')));
});
