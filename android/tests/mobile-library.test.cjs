const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Reuse the existing hook/event harness without running its unrelated checks.
const harness = path.resolve(__dirname, '../../src/components/check-ui-state.cjs');
const source = fs.readFileSync(harness, 'utf8')
  .replace('[base, `${base}.js`,', '[base, path.join(base, "index.js"), `${base}.js`,')
  .replace("loader: ext === '.mjs'", "loader: ext === '.json' ? 'json' : ext === '.mjs'")
  .replace("userAgent: 'test'", "userAgent: 'test', language: 'zh-CN'");
const { mount } = new Function('require', '__dirname', source.slice(0, source.indexOf('(async () => {')) + '\nreturn { mount };')(createRequire(harness), path.dirname(harness));

test('Android library: details before episode playback, download selection and deletion confirmation', async () => {
  const played = [], submitted = [];
  const detail = { series_id: '123456789', series_title: '测试剧目', total: 3, description: '测试简介', episodes: [
    { vid: '111111', vid_index: 1, status: 'missing' },
    { vid: '222222', vid_index: 2, status: 'completed' },
    { vid: '333333', vid_index: 3, status: 'missing', locked: true },
  ] };
  const browse = await mount('Browse', {
    platform: 'android', getSeriesList: async () => [], browseCategories: async () => [{ slug: 'real-drama', label: '真人剧' }],
    browseList: async () => ({ success: true, results: [{ series_id: detail.series_id, series_title: detail.series_title }], page: 1, hasMore: true }),
    searchResolve: async () => ({ success: true, data: detail }), getSeriesEpisodes: async () => ({ success: true, data: detail }),
    playSeries: async payload => { played.push(payload); return { success: true }; },
    hongguoDownloadBatch: async payload => { submitted.push(payload); return { success: true, count: payload.episodes.length }; },
  });
  await browse.flush();
  await browse.find(node => node.props['aria-label'] === '详情与下载：测试剧目').props.onClick(); await browse.flush();
  assert.equal(played.length, 0, 'card opens details without starting playback');
  assert.equal(browse.find(node => node.type === 'button' && node.props.title === '需在来源平台解锁').props.disabled, true);
  await browse.find(node => node.type === 'button' && node.props.title === '第 2 集').props.onClick(); await browse.flush();
  assert.equal(played[0].seriesId, detail.series_id);
  assert.equal(played[0].vidIndex, 2);
  await browse.find(node => node.props['aria-label'] === '详情与下载：测试剧目').props.onClick(); await browse.flush();
  await browse.button('选集下载').props.onClick(); await browse.flush();
  browse.find(node => node.type === 'button' && node.props.title === '第 1 集').props.onClick(); await browse.flush();
  await browse.button('下载选中 (1)').props.onClick(); await browse.flush();
  assert.equal(submitted[0].episodes.length, 1);
  assert.equal(submitted[0].episodes[0].vid_index, 1);
  browse.unmount();

  const info = { series_id: detail.series_id, series_title: detail.series_title };
  const stopped = [], removed = [];
  const tasks = [
    { id: 'active', title: '测试剧目 第1集', status: 'downloading', progress: 45, videoInfo: { cover: 'https://example.invalid/poster.jpg' }, hongguoInfo: { ...info, vid_index: 1 } },
    { id: 'done', title: '测试剧目 第2集', status: 'completed', fileSize: 1024, videoInfo: { cover: 'https://example.invalid/poster.jpg' }, hongguoInfo: { ...info, vid_index: 2 } },
  ];
  const downloads = await mount('DownloadManager', {
    platform: 'android', getDownloadTasks: async () => tasks,
    getSeriesList: async options => {
      assert(options === undefined || options.downloadedOnly === true);
      return [{ ...detail, cover: 'https://example.invalid/poster.jpg' }];
    }, getMergeTasks: async () => [],
    getQueueStatus: async () => ({ active: 1, queued: 0, maxConcurrent: 1 }),
    stopDownload: async id => { stopped.push(id); return { success: true }; },
    playSeries: async payload => { played.push(payload); return { success: true }; },
    deleteTaskWithFiles: async (...args) => { removed.push(args); return { success: true }; },
  });
  await downloads.flush();
  assert(downloads.find(node => node.type === 'img' && node.props.src === 'https://example.invalid/poster.jpg'));
  assert.equal(downloads.nodes().filter(node => String(node.props.className || '').startsWith('dm-task ')).length, 2);
  await downloads.find(node => node.props.title === '停止').props.onClick(); await downloads.flush();
  assert.deepEqual(stopped, ['active']);
  downloads.button('已完成').props.onClick(); await downloads.flush();
  downloads.find(node => node.props.title === '删除任务（可选是否同时删除本地文件）').props.onClick(); await downloads.flush();
  assert(downloads.find(node => node.props.role === 'dialog'));
  assert.equal(removed.length, 0, 'opening confirmation cannot delete data');
  downloads.unmount();
});
