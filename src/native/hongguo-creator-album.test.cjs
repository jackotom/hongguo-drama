const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseCreatorAlbum, fetchCreatorAlbum } = require('./hongguo-creator-album');

const albumId = '7676321126145854488';
const rows = [
  { series_id_str: '7676320005595614232', series_title: '第一集《进城》', content_type: 1001 },
  { series_id_str: '7676320005595614233', series_title: '第二集《秘密》', content_type: 1001 },
];
const payload = {
  code: 0,
  data: { album_data: {
    album_id_str: albumId, album_id: 7676321126145854000, title: '《最后生还的猫》第二季',
    intro: '合集简介', cover: 'https://img.example/album.jpg', episode_cnt: 2, video_detail_list: rows,
  } },
};

test('creator album response maps ordered uploads to the existing episode contract', () => {
  const result = parseCreatorAlbum(payload, albumId);
  assert.equal(result.series_id, albumId);
  assert.equal(result.content_type, '1003');
  assert.equal(result.series_title, '《最后生还的猫》第二季');
  assert.equal(result.total, 2);
  assert.deepEqual(result.episodes.map(item => [item.vid_index, item.vid, item.title]), [
    [1, rows[0].series_id_str, rows[0].series_title],
    [2, rows[1].series_id_str, rows[1].series_title],
  ]);
  assert.ok(result.episodes.every(item => item.series_id === albumId && item.web_available === true));
});

test('creator album response fails closed on incomplete or mismatched identity', () => {
  assert.throws(() => parseCreatorAlbum({ ...payload, code: 7 }, albumId), /未确认合集请求成功/);
  assert.throws(() => parseCreatorAlbum({ ...payload, data: { album_data: { ...payload.data.album_data, album_id_str: '1' } } }, albumId), /与请求不一致/);
  assert.throws(() => parseCreatorAlbum({ ...payload, data: { album_data: { ...payload.data.album_data, episode_cnt: 3 } } }, albumId), /目录不完整/);
  assert.throws(() => parseCreatorAlbum({ ...payload, data: { album_data: { ...payload.data.album_data,
    episode_cnt: 3, video_detail_list: [...rows, rows[0]] } } }, albumId), /视频数据无效/);
  assert.throws(() => parseCreatorAlbum({ ...payload, data: { album_data: { ...payload.data.album_data, video_detail_list: [rows[0], { ...rows[1], content_type: 1003 }] } } }, albumId), /视频数据无效/);
});

test('creator album request uses the signed album endpoint and retries only empty responses', async () => {
  const requests = [], sends = [];
  let calls = 0;
  const result = await fetchCreatorAlbum(albumId, {
    request(apiPath, values, body) {
      requests.push({ apiPath, values, body });
      return { url: 'https://api5-normal-sinfonlineb.fqnovel.com/album', headers: {}, body: Buffer.from('{}') };
    },
    async send(url, options) {
      sends.push({ url, options });
      if (++calls === 1) throw Object.assign(new Error('empty'), { code: 'EMPTY_RESPONSE' });
      return payload;
    },
  });
  assert.equal(result.total, 2);
  assert.equal(calls, 2);
  assert.equal(requests[0].apiPath, '/novel/player/album_detail/v1/');
  assert.deepEqual(requests[0].body, {
    album_id: albumId, series_ids: [], need_video_detail_info: true, biz_param: { video_platform: 3 },
  });
  assert.equal(sends[0].options.method, 'POST');
  assert.deepEqual(sends[0].options.preserveLargeIntegerFields, ['album_id', 'album_id_str', 'series_id', 'series_id_str']);
});
