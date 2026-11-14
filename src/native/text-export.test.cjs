const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportSeriesText } = require('./text-export');

const SID = '7503745441910017049';
const VID = '7503780574541122622';
const tally = (ok = 0, fail = 0, skipped = 0, partial = 0, items = ok, empty = 0, unavailable = 0) => ({ ok, fail, skipped, partial, items, empty, unavailable });
const read = target => JSON.parse(fs.readFileSync(target, 'utf8'));
const danmaku = (overrides = {}) => ({ success: true, source: 'official', series_id: SID, episode_id: VID,
  items: [{ time: 1.5, text: '冲', color: '#FFFFFF', mode: 'scroll' }], total: 1, truncated: false,
  partial: false, error: '', notice: '', ...overrides });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-text-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const savePath = path.join(dir, '旧目录', '自定前缀_冲突修复.MP4');
  const target = savePath.replace(/\.mp4$/i, '.danmaku.json');
  const fetchers = {
    fetchDanmaku: async () => danmaku(),
    fetchEpisodeComments: async () => ({ success: true, series_id: SID, episode_id: VID,
      items: [{ id: 'a', content: '好看' }], total: 10, source_limited: true, notice: '部分评论' }),
    fetchPublicDetails: async () => ({ success: true, series_id: SID,
      reviews: { total: 20, items: [{ author: 'u', content: '剧评', created_at: 123, likes: 2, rating: 5 }] } }),
  };
  const options = { seriesId: SID, seriesTitle: '测试剧', episodes: [{ vid: VID, vid_index: 1, savePath }],
    kinds: { danmaku: true, comments: true, reviews: true }, reviewsPath: path.join(dir, '整剧.reviews.json'),
    fetchers, now: () => 123456789 };
  return { dir, target, fetchers, options };
}

test('空弹幕明确统计为零条和空文件，JSON使用可读缩进', async t => {
  const { target, options, fetchers } = setup(t);
  fetchers.fetchDanmaku = async () => danmaku({ items: [], total: 0, notice: '本集暂无弹幕' });
  const result = await exportSeriesText({ ...options, kinds: { danmaku: true } });
  assert.equal(result.danmaku.items, 0);
  assert.equal(result.danmaku.empty, 1);
  assert.match(fs.readFileSync(target, 'utf8'), /^\{\n  "kind": "danmaku"/);
});

test('锁集评论单独统计未开放，不创建空文件或覆盖已有部分评论', async t => {
  const { target, options, fetchers } = setup(t);
  const comments = target.replace('.danmaku.json', '.comments.json');
  options.kinds = { comments: true };
  fetchers.fetchEpisodeComments = async () => ({ success: false, source_limited: true,
    code: 'EPISODE_COMMENTS_UNAVAILABLE', error: '官网未开放本集评论' });
  assert.deepEqual((await exportSeriesText(options)).comments, tally(0, 0, 0, 0, 0, 0, 1));
  assert.equal(fs.existsSync(comments), false);
  fs.mkdirSync(path.dirname(comments), { recursive: true });
  const old = JSON.stringify({ partial: true, items: [{ content: '保留' }] });
  fs.writeFileSync(comments, old);
  assert.deepEqual((await exportSeriesText(options)).comments, tally(0, 0, 0, 0, 0, 0, 1));
  assert.equal(fs.readFileSync(comments, 'utf8'), old);
  fetchers.fetchEpisodeComments = async () => ({ success: false, source_limited: true, error: '其他错误' });
  assert.equal((await exportSeriesText(options)).comments.fail, 1);
});

test('三类JSON跟随实际视频路径和reviewsPath，保留协议与受限统计', async t => {
  const { dir, target, options, fetchers } = setup(t);
  fetchers.fetchEpisodeComments = async args => {
    assert.deepEqual(args, { seriesId: SID, episodeId: VID, cursor: null, limit: 30 });
    return { success: true, episode_id: VID, items: [{ id: 'a', content: '好看' }],
      total: 10, source_limited: true, notice: '部分评论' };
  };
  fetchers.fetchPublicDetails = async (...args) => {
    assert.deepEqual(args, [SID, '', { reviewsLimit: 1000 }]);
    return { success: true, reviews: { total: 20, items: [{ author: 'u', content: '剧评' }] } };
  };
  const result = await exportSeriesText(options);
  assert.deepEqual(result.danmaku, tally(1));
  assert.deepEqual(result.comments, tally(1, 0, 0, 1));
  assert.deepEqual(result.reviews, tally(1, 0, 0, 1));
  assert.deepEqual(read(target), { kind: 'danmaku', series_id: SID, episode_id: VID, episode_index: 1,
    series_title: '测试剧', source: 'official', fetched_at: 123456789, truncated: false, partial: false,
    notice: '', items: danmaku().items });
  const comments = read(target.replace('.danmaku.json', '.comments.json'));
  assert.equal(comments.partial, true);
  assert.equal(comments.source_limited, true);
  assert.deepEqual(comments.items, [{ id: 'a', content: '好看' }]);
  assert.equal(read(options.reviewsPath).partial, true);
  assert.equal(result.files.length, 3);
  assert.ok(result.files.includes(options.reviewsPath));
  assert.deepEqual(fs.readdirSync(dir), ['旧目录', '整剧.reviews.json'].sort());
});

test('未选类型及非红果ID不请求、不落盘，跳过只计所选类型', async t => {
  const { dir, options, fetchers } = setup(t);
  let calls = 0;
  for (const key of Object.keys(fetchers)) fetchers[key] = async () => { calls++; throw new Error('不应请求'); };
  const empty = await exportSeriesText({ ...options, kinds: {} });
  assert.deepEqual(empty, { danmaku: tally(), comments: tally(), reviews: tally(), files: [] });
  for (const seriesId of ['xifan:1', 'hema:1', 'custom:1', '123', '../123456']) {
    const result = await exportSeriesText({ ...options, seriesId, kinds: { comments: true } });
    assert.deepEqual(result, { danmaku: tally(), comments: tally(0, 0, 1), reviews: tally(), files: [] });
  }
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('完整已有JSON跳过，不重复请求；兼容未带partial的旧文件', async t => {
  const { target, options, fetchers } = setup(t);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = JSON.stringify({ kind: 'danmaku', items: [{ text: '旧数据' }] });
  fs.writeFileSync(target, original);
  fetchers.fetchDanmaku = async () => { throw new Error('不应重取'); };
  const result = await exportSeriesText({ ...options, kinds: { danmaku: true } });
  assert.deepEqual(result.danmaku, tally(0, 0, 1, 0, 1));
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.deepEqual(result.files, []);
});

test('首次翻页中断标记partial并计ok；重试fresh绕过缓存并原子替换', async t => {
  const { target, options, fetchers } = setup(t);
  options.kinds = { danmaku: true };
  let calls = 0;
  fetchers.fetchDanmaku = async args => {
    calls++;
    assert.equal(args.fresh, calls > 1);
    return calls === 1 ? danmaku({ success: false, partial: true, notice: '后续弹幕加载中断' })
      : danmaku({ items: [...danmaku().items, { time: 2, text: '新数据', color: '#FFFFFF', mode: 'scroll' }] });
  };
  assert.deepEqual((await exportSeriesText(options)).danmaku, tally(1, 0, 0, 1));
  assert.equal(read(target).partial, true);
  assert.deepEqual((await exportSeriesText(options)).danmaku, tally(1, 0, 0, 0, 2));
  assert.equal(read(target).partial, false);
  assert.equal(read(target).items.length, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
});

test('partial旧文件重试返回失败、部分失败或抛异常，原文件字节不变', async t => {
  const { target, options, fetchers } = setup(t);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = JSON.stringify({ partial: true, items: [{ text: '保留' }] });
  fs.writeFileSync(target, original);
  options.kinds = { danmaku: true };
  for (const failure of [() => ({ success: false }), () => danmaku({ success: false, partial: true }), () => { throw new Error('offline'); }]) {
    fetchers.fetchDanmaku = async args => { assert.equal(args.fresh, true); return failure(); };
    const result = await exportSeriesText(options);
    assert.deepEqual(result.danmaku, tally(0, 1));
    assert.deepEqual(result.files, []);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  }
});

test('写入或rename失败保留旧文件、清理临时文件，释放目标锁供重试', async t => {
  const { target, options } = setup(t);
  options.kinds = { danmaku: true };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = JSON.stringify({ partial: true, items: [] });
  fs.writeFileSync(target, original);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('disk error'); });
  assert.deepEqual((await exportSeriesText(options)).danmaku, tally(0, 1));
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
  rename.mock.restore();
  assert.deepEqual((await exportSeriesText(options)).danmaku, tally(1));
});

test('fetch等待后写入前核验目录身份，核验失败不覆盖外来同名JSON', async t => {
  const { target, options, fetchers } = setup(t);
  options.kinds = { danmaku: true };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = JSON.stringify({ partial: true, items: [{ text: '保留' }] });
  fs.writeFileSync(target, original);
  let checked = 0;
  const result = await exportSeriesText({ ...options,
    check: () => { checked++; throw new Error('目录已被替换'); } });
  assert.deepEqual(result.danmaku, tally(0, 1));
  assert.equal(checked, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
});

test('等待期间出现外来同名target不覆盖，保留未知文件且不留随机临时文件', async t => {
  const { target, options, fetchers } = setup(t);
  options.kinds = { danmaku: true };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  fetchers.fetchDanmaku = async () => { entered = true; await gate; return danmaku(); };
  const pending = exportSeriesText(options);
  for (let i = 0; i < 100 && !entered; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, true);
  fs.writeFileSync(target, 'FOREIGN-TARGET');
  release();
  const result = await pending;
  assert.deepEqual(result.danmaku, tally(0, 1));
  assert.equal(fs.readFileSync(target, 'utf8'), 'FOREIGN-TARGET');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
});

test('写入成功时使用随机临时文件，不跟随固定.tmp符号链接', async t => {
  const { target, options, fetchers } = setup(t);
  options.kinds = { danmaku: true };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const foreign = path.join(path.dirname(target), 'foreign.json');
  fs.writeFileSync(foreign, 'FOREIGN');
  fs.symlinkSync(foreign, `${target}.tmp`);
  const result = await exportSeriesText(options);
  assert.deepEqual(result.danmaku, tally(1));
  assert.equal(read(target).kind, 'danmaku');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'FOREIGN');
  assert.deepEqual(fs.readdirSync(path.dirname(target)).sort(),
    [path.basename(target), 'foreign.json', `${path.basename(target)}.tmp`].sort());
});

test('partial旧文件在等待期间被替换，保留替换文件不覆盖', async t => {
  const { target, options, fetchers } = setup(t);
  options.kinds = { danmaku: true };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ partial: true, items: [{ text: '旧' }] }));
  let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  fetchers.fetchDanmaku = async () => { entered = true; await gate; return danmaku(); };
  const pending = exportSeriesText(options);
  for (let i = 0; i < 100 && !entered; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, true);
  fs.writeFileSync(target, 'FOREIGN-PARTIAL');
  release();
  const result = await pending;
  assert.deepEqual(result.danmaku, tally(0, 1));
  assert.equal(fs.readFileSync(target, 'utf8'), 'FOREIGN-PARTIAL');
});

test('同目标跨批并发只取写一次，不能被迟到请求覆盖', async t => {
  const { target, options, fetchers } = setup(t);
  options.kinds = { danmaku: true };
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  fetchers.fetchDanmaku = async () => { calls++; await blocked; return danmaku(); };
  const first = exportSeriesText(options);
  const second = exportSeriesText({ ...options, fetchers: { ...fetchers,
    fetchDanmaku: async () => { calls++; return danmaku({ items: [] }); } } });
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(read(target).items.length, 1);
  assert.ok(results.every(result => result.danmaku.fail === 0));
});

test('默认每批最多四集并发，单集及剧评异常不影响其余文件', async t => {
  const { dir, options, fetchers } = setup(t);
  options.episodes = Array.from({ length: 9 }, (_, i) => ({ vid: String(BigInt(VID) + BigInt(i)),
    vid_index: i + 1, savePath: path.join(dir, `集${i}.mp4`) }));
  let active = 0, peak = 0;
  fetchers.fetchDanmaku = async ({ vid }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (vid === VID) throw new Error('单集offline');
    return danmaku({ episode_id: vid });
  };
  fetchers.fetchPublicDetails = async () => { throw new Error('剧评offline'); };
  const result = await exportSeriesText(options);
  assert.equal(peak, 4);
  assert.deepEqual(result.danmaku, tally(8, 1));
  assert.deepEqual(result.comments, tally(9, 0, 0, 9));
  assert.deepEqual(result.reviews, tally(0, 1));
  assert.equal(result.files.length, 17);
});

test('截断弹幕也标记partial；真实零条成功仍生成JSON', async t => {
  const { target, options, fetchers } = setup(t);
  fetchers.fetchDanmaku = async () => danmaku({ truncated: true, notice: '条数受限' });
  fetchers.fetchEpisodeComments = async () => ({ success: true, items: [], total: 0, source_limited: false });
  fetchers.fetchPublicDetails = async () => ({ success: true, reviews: { total: 0, items: [] } });
  const result = await exportSeriesText(options);
  assert.deepEqual(result.danmaku, tally(1, 0, 0, 1));
  assert.equal(read(target).partial, true);
  assert.deepEqual(result.comments, tally(1, 0, 0, 0, 0, 1));
  assert.deepEqual(result.reviews, tally(1, 0, 0, 0, 0, 1));
  assert.deepEqual(read(options.reviewsPath).items, []);
});

test('无效目标路径单项失败，不覆盖其他文件或写相对路径', async t => {
  const { dir, options } = setup(t);
  options.episodes = [{ vid: VID, vid_index: 1, savePath: 'relative.mp4' },
    { vid: VID, vid_index: 2, savePath: path.join(dir, '错误.txt') }, options.episodes[0]];
  options.reviewsPath = undefined;
  const result = await exportSeriesText(options);
  assert.deepEqual(result.danmaku, tally(1, 2));
  assert.deepEqual(result.comments, tally(1, 2, 0, 1));
  assert.deepEqual(result.reviews, tally(0, 1));
  assert.equal(result.files.length, 2);
});
