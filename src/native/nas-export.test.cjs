const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareNasExport, inspectNasEpisode, copyNasEpisode } = require('./nas-export');

const seriesId = '7691228619774999999';
const episodes = [1, 2, 3].map(index => ({
  series_id: seriesId, series_title: '测试剧', vid: `76912493640978299${index}`, vid_index: index, title: `第${index}集`,
}));
const series = { series_id: seriesId, series_title: '测试剧', episodes };
const options = { metadataFetcher: async () => ({ success: false }), posterFetcher: async () => { throw new Error('none'); } };
const rootFor = t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-nas-index-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const sourceFor = (root, episode) => {
  const file = path.join(root, `source-${episode.vid_index}.mp4`);
  fs.writeFileSync(file, Buffer.alloc(120000, episode.vid_index));
  return file;
};

test('new exports keep basic TV identity, omit episode NFO and create an optional series folder', async t => {
  const root = rootFor(t);
  const { destination, warnings } = await prepareNasExport({ root, folderName: '测试剧', series, createFolder: true }, options);
  assert.equal(destination.directory, path.join(root, '测试剧'));
  assert.equal(destination.flat, true);
  assert.deepEqual(fs.readdirSync(destination.directory).sort(), ['tvshow.nfo']);
  assert.match(fs.readFileSync(path.join(destination.directory, 'tvshow.nfo'), 'utf8'), /7691228619774999999/);
  assert.ok(warnings.some(message => /简介/.test(message)));
  assert.ok(warnings.some(message => /封面/.test(message)));

  const task = { savePath: sourceFor(root, episodes[0]), hongguoInfo: episodes[0] };
  await copyNasEpisode(task, destination);
  assert.equal(fs.existsSync(path.join(destination.directory, '测试剧 S01E001.nfo')), false);
  assert.equal((await inspectNasEpisode(destination, episodes[0])).status, 'existing');
});

test('concurrent prepares for different series sharing a directory reject the loser without mixing metadata', async t => {
  const root = rootFor(t);
  const otherId = '7691228619774905370';
  const otherSeries = { ...series, series_id: otherId, series_title: '另一部剧' };
  const pending = new Map();
  let release = false;
  const metadataFetcher = id => {
    const metadata = { success: true, description: `简介 ${id}`, cover: `poster-${id}.jpg` };
    if (release) return metadata;
    return new Promise(resolve => pending.set(id, () => resolve(metadata)));
  };
  const posterFetcher = async cover => Buffer.from([0xff, 0xd8, 0xff, cover === `poster-${seriesId}.jpg` ? 1 : 2]);
  const hooks = { metadataFetcher, posterFetcher };

  const first = prepareNasExport({ root, folderName: '第一部', series }, hooks);
  while (pending.size === 0) await new Promise(setImmediate);
  const second = prepareNasExport({ root, folderName: '第二部', series: otherSeries }, hooks);
  await new Promise(setImmediate);
  release = true;
  for (const resolve of pending.values()) resolve();

  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /其他|归属/);
  assert.match(fs.readFileSync(path.join(root, 'tvshow.nfo'), 'utf8'), new RegExp(seriesId));
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'tvshow.nfo'), 'utf8'), new RegExp(otherId));
  assert.match(fs.readFileSync(path.join(root, '简介.txt'), 'utf8'), new RegExp(`简介 ${seriesId}`));
  assert.doesNotMatch(fs.readFileSync(path.join(root, '简介.txt'), 'utf8'), new RegExp(otherId));
  assert.deepEqual([...fs.readFileSync(path.join(root, 'poster.jpg')).subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.equal(fs.readFileSync(path.join(root, 'poster.jpg'))[3], 1);
});

test('a foreign tvshow added while metadata is pending rejects without writing this series metadata', async t => {
  const root = rootFor(t);
  const otherId = '7691228619774905370';
  let releaseMetadata;
  let metadataStarted;
  const started = new Promise(resolve => { metadataStarted = resolve; });
  const metadataFetcher = () => {
    metadataStarted();
    return new Promise(resolve => {
      releaseMetadata = () => resolve({ success: true, description: '不应写入', cover: 'poster.jpg' });
    });
  };
  const pending = prepareNasExport({ root, folderName: '测试剧', series }, {
    metadataFetcher, posterFetcher: async () => Buffer.from([0xff, 0xd8, 0xff, 1]),
  });
  await started;

  const foreignNfo = `<tvshow><uniqueid type="hongguo" default="true">${otherId}</uniqueid></tvshow>\n`;
  fs.writeFileSync(path.join(root, 'tvshow.nfo'), foreignNfo);
  releaseMetadata();

  await assert.rejects(pending, /其他|归属/);
  assert.equal(fs.readFileSync(path.join(root, 'tvshow.nfo'), 'utf8'), foreignNfo);
  assert.equal(fs.existsSync(path.join(root, '简介.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'poster.jpg')), false);
});

test('wrong orphan NFO blocks the video and legacy matching NFO stays readable and untouched', async t => {
  const root = rootFor(t);
  const { destination } = await prepareNasExport({ root, folderName: '测试剧', series }, options);
  const first = path.join(destination.directory, '测试剧 S01E001');
  fs.writeFileSync(`${first}.nfo`, `<episodedetails><uniqueid type="hongguo" default="true">${episodes[1].vid}</uniqueid></episodedetails>`);
  assert.equal((await inspectNasEpisode(destination, episodes[0])).status, 'conflict');
  await assert.rejects(() => copyNasEpisode({ savePath: sourceFor(root, episodes[0]), hongguoInfo: episodes[0] }, destination), /身份冲突/);
  assert.equal(fs.existsSync(`${first}.mp4`), false);

  fs.writeFileSync(`${first}.nfo`, `<episodedetails><!-- ${episodes[0].vid} --><uniqueid type="hongguo" default="true">${episodes[1].vid}</uniqueid></episodedetails>`);
  assert.equal((await inspectNasEpisode(destination, episodes[0])).status, 'conflict');

  fs.writeFileSync(`${first}.nfo`, `<episodedetails><uniqueid type="hongguo" default="true">${episodes[0].vid}</uniqueid></episodedetails>`);
  const legacy = fs.readFileSync(`${first}.nfo`);
  await copyNasEpisode({ savePath: sourceFor(root, episodes[0]), hongguoInfo: episodes[0] }, destination);
  assert.deepEqual(fs.readFileSync(`${first}.nfo`), legacy);
  assert.equal((await inspectNasEpisode(destination, episodes[0])).status, 'existing');
});

test('same-path NAS completion adds index identity and concurrent copies retain every episode', async t => {
  const root = rootFor(t);
  const { destination } = await prepareNasExport({ root, folderName: '测试剧', series }, options);
  const firstPath = path.join(destination.directory, '测试剧 S01E001.mp4');
  fs.writeFileSync(firstPath, Buffer.alloc(120000, 1));
  await copyNasEpisode({ savePath: firstPath, hongguoInfo: episodes[0] }, destination);
  await Promise.all(episodes.slice(1).map(episode =>
    copyNasEpisode({ savePath: sourceFor(root, episode), hongguoInfo: episode }, destination)));
  const index = JSON.parse(fs.readFileSync(path.join(destination.directory, '.hongguo-nas.json'), 'utf8'));
  assert.equal(index.seriesId, seriesId);
  assert.deepEqual(index.episodes, episodes.map(({ vid_index, vid }) => ({ index: vid_index, vid })));
});

test('index ownership, links and size are validated before reuse', async t => {
  const root = rootFor(t);
  const { destination } = await prepareNasExport({ root, folderName: '测试剧', series }, options);
  const indexPath = path.join(destination.directory, '.hongguo-nas.json');
  fs.writeFileSync(indexPath, JSON.stringify({ version: 1, seriesId: 'other', episodes: [] }));
  await assert.rejects(() => inspectNasEpisode(destination, episodes[0]), /当前剧集/);

  fs.writeFileSync(indexPath, 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(() => inspectNasEpisode(destination, episodes[0]), /过大|无效/);

  fs.unlinkSync(indexPath);
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ version: 1, seriesId, episodes: [] }));
  fs.symlinkSync(outside, indexPath);
  await assert.rejects(() => inspectNasEpisode(destination, episodes[0]), /链接/);
});

test('index writes reject JSON bytes above the read limit before touching the index', async t => {
  const root = rootFor(t);
  const { destination } = await prepareNasExport({ root, folderName: '测试剧', series }, options);
  const indexPath = path.join(destination.directory, '.hongguo-nas.json');
  let low = 1, high = 10000, largest;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const value = { version: 1, seriesId, episodes: Array.from({ length: count }, (_, offset) => ({ index: offset + 1, vid: String(offset + 1) })) };
    const bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (bytes <= 256 * 1024) { largest = { value, bytes }; low = count + 1; }
    else high = count - 1;
  }
  fs.writeFileSync(indexPath, `${JSON.stringify(largest.value, null, 2)}\n`);
  const before = fs.readFileSync(indexPath);
  const nextIndex = largest.value.episodes.length + 1;
  const nextEpisode = { ...episodes[0], vid: 'new-video', vid_index: nextIndex };
  const video = path.join(destination.directory, `测试剧 S01E${String(nextIndex).padStart(3, '0')}.mp4`);
  fs.writeFileSync(video, Buffer.alloc(120000, 1));

  await assert.rejects(() => copyNasEpisode({ savePath: video, hongguoInfo: nextEpisode }, destination), /索引超过 256 KiB/);
  const unchanged = fs.readFileSync(indexPath);
  assert.equal(unchanged.length, largest.bytes);
  assert.equal(unchanged.equals(before), true);
  assert.equal(fs.readdirSync(destination.directory).some(name => name.startsWith('.nas-index-')), false);
});
