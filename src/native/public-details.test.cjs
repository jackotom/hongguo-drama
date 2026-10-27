const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { fetchPublicDetails, parsePublicDetails } = require('./public-details');

const seriesId = '7503745441910017049';
const manyReviews = Array.from({ length: 120 }, (_, i) => ({ content: `评${i}`, user_name: `u${i}`, create_time: '123', rating: 5 }));
const html = (count) => `window._ROUTER_DATA=${JSON.stringify({ loaderData: { detail: {
  seriesDetail: { series_id: seriesId, series_title: '测试剧' },
  seriesSocialInfo: { reviews: { total_count: '15536', reviews: manyReviews } },
} } })};`;

test('parsePublicDetails 默认截断到 50 条剧评', () => {
  const parsed = parsePublicDetails(html(), seriesId);
  assert.equal(parsed.reviews.total, 15536);
  assert.equal(parsed.reviews.items.length, 50);
});

test('parsePublicDetails 按 reviewsLimit 放宽剧评条数', () => {
  const parsed = parsePublicDetails(html(), seriesId, '', { reviewsLimit: 1000 });
  assert.equal(parsed.reviews.items.length, 120, '页面给了多少就取多少');
});

test('fetchPublicDetails 透传 reviewsLimit，并按上限区分缓存', async () => {
  let calls = 0;
  axios.get = async () => { calls++; return { data: html() }; };
  const small = await fetchPublicDetails(seriesId);
  assert.equal(small.reviews.items.length, 50);
  const big = await fetchPublicDetails(seriesId, '', { reviewsLimit: 1000 });
  assert.equal(big.reviews.items.length, 120);
  assert.equal(calls, 2, '不同上限不得共用同一份缓存');
});
