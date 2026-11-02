// Safe, read-only source diagnosis. Does not download media or print credentials, keys or media URLs.
const catalog = require('../src/native/catalog');
const hongguo = require('../src/native/hongguo');
const allowedCodes = new Set(['SOURCE_UNAVAILABLE','PREVIEW_ONLY','EMPTY_RESPONSE','NETWORK_ERROR','TIMEOUT','HTTP_ERROR','DEVICE_REGISTRATION_FAILED','BUSINESS_REJECTED','INVALID_RESPONSE','MISSING_MODEL','SECURITY_BLOCKED','NO_PLAYABLE_SOURCE','QUALITY_UNAVAILABLE','NO_COMPATIBLE_SOURCE']);
const safeCode = value => allowedCodes.has(value) ? value : 'UNKNOWN';
(async () => {
  let seriesId = process.argv[2];
  if (seriesId && !/^\d{1,30}$/.test(seriesId)) throw new Error('请传入数字剧号，或省略剧号从当前目录随机选择');
  const report = { version: require('../package.json').version, platform: process.platform, architecture: process.arch, at: new Date().toISOString() };
  if (!seriesId) {
    const result = await catalog.browseList({ forceRefresh: true });
    report.catalog = result.success ? 'ok' : 'failed';
    if (!result.success || !result.results?.length) { console.log(JSON.stringify(report,null,2)); return; }
    seriesId = String(result.results[Math.floor(Math.random()*result.results.length)].series_id);
  }
  report.seriesId = seriesId;
  const detail = await hongguo.fetchEpisodeList(seriesId);
  report.title = String(detail.series_title || '').slice(0,100);
  report.episodes = detail.episodes.length;
  const episode = detail.episodes[0];
  if (episode) {
    report.episodeIndex = episode.vid_index;
    const started = Date.now();
    const result = await hongguo.fetchPlayUrlSingle(episode.vid,seriesId,{force:true});
    report.elapsedMs = Date.now()-started;
    report.sourceAvailable = !!result.url;
    report.code = result.url ? 'OK' : safeCode(result.code);
    report.routes = (result.sources || []).map(item=>({source:['app','api','web'].includes(item.source)?item.source:'unknown',code:safeCode(item.code)}));
  }
  console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(JSON.stringify({status:'failed',code:safeCode(error.code)}));process.exitCode=1;});
