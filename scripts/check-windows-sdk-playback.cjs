// Resolve one real episode directly through the packaged Windows SDK helper.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.argv[2] || path.join(root,
  'build/sdk-playback/win32-x64/hongguo-sdk-playback.exe'));
const failures = [];

async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert(fs.statSync(executable).isFile());
  const native = require('../src/native/hongguo');
  const catalog = await require('../src/native/hongguo-app-catalog').browseList({ category: 'hot-real-drama' });
  assert(catalog.success && catalog.results.length, 'Real Hongguo catalog unavailable');
  const dramas = [...catalog.results].sort(() => Math.random() - 0.5).slice(0, 6);
  for (const drama of dramas) {
    const series = await native.fetchEpisodeList(drama.series_id);
    const episodes = series.episodes.filter(episode => !episode.locked).slice(0, 6);
    for (const episode of episodes) {
      const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-sdk-verify-'));
      try {
        const contentType = ['1001', '1004'].includes(String(episode.content_type || series.content_type))
          ? String(episode.content_type || series.content_type) : '1004';
        const args = ['--video', String(episode.vid), '--cache', cache];
        if (contentType !== '1004') args.push('--content-type', contentType);
        const result = spawnSync(executable, args, {
          encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
        });
        let payload;
        try { payload = JSON.parse(result.stdout); } catch {}
        if (result.status === 0 && payload?.ok === true && payload.model && typeof payload.userAgent === 'string') {
          console.log(JSON.stringify({
            passed: true, seriesId: String(drama.series_id), episode: episode.vid_index,
            vid: String(episode.vid), contentType, hasVideoList: !!payload.model.video_list,
          }));
          return;
        }
        failures.push({
          seriesId: String(drama.series_id), episode: episode.vid_index, contentType,
          status: result.status, signal: result.signal || null,
          error: payload?.error || String(result.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        });
      } finally {
        fs.rmSync(cache, { recursive: true, force: true });
      }
    }
  }
  throw new Error('Windows SDK helper resolved no real episode: ' + JSON.stringify(failures));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
