// Real-source integration check; no player or audio device is opened.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { browseList } = require('../src/native/catalog');
const { safeError } = require('./storage.cjs');
async function main() {
  const base = process.env.HONGGUO_URL || 'http://127.0.0.1:3000';
  const token = process.env.HONGGUO_TOKEN;
  if (!token) throw new Error('HONGGUO_TOKEN required');
  const receipt = { startedAt: new Date().toISOString(), source: 'hongguo', audio: 'No audio playback; decode-only checks', steps: [] };
  const api = async (route, payload) => {
    const response = await fetch(base + route, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(65000) });
    const value = await response.json(); if (!response.ok || !value.success) throw new Error(value.error || `HTTP ${response.status}`); return value;
  };
  try {
    receipt.version = (await api('/api/status')).version;
    const catalog = await browseList({ category: 'real-drama', page: 1 + crypto.randomInt(3), allowTrustedDns: true });
    if (!catalog.success || !catalog.results?.length) throw new Error(catalog.error || '目录为空');
    const candidates = catalog.results.filter(item => /^\d{1,30}$/.test(String(item.series_id)));
    if (!candidates.length) throw new Error('目录没有红果剧集');
    receipt.quality = '1080p';
    const wait = async ids => {
      const deadline = Date.now() + 5 * 60000;
      while (Date.now() < deadline) {
        const tasks = (await api('/api/tasks')).tasks.filter(task => ids.includes(task.id));
        if (tasks.some(task => ['failed', 'cancelled', 'interrupted'].includes(task.status))) throw new Error(tasks.find(task => task.error)?.error || '任务停止');
        if (tasks.length === ids.length && tasks.every(task => task.status === 'completed')) return tasks;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error('真实素材任务超时');
    };
    let candidate, series, selected, downloads, lastError;
    const randomCandidates = [...candidates].sort(() => Math.random() - 0.5).slice(0, 4);
    for (const item of randomCandidates) {
      try {
        const search = await api(`/api/search?q=${encodeURIComponent(item.series_title)}`);
        if (!search.results.some(result => result.series_id === String(item.series_id))) throw new Error('搜索未找到随机选择的目录剧集');
        const detail = await api(`/api/series/${item.series_id}`);
        if (detail.series.episodes.length < 2) throw new Error('随机剧集少于两集');
        const offset = crypto.randomInt(Math.min(10, detail.series.episodes.length - 1));
        const pair = detail.series.episodes.slice(offset, offset + 2);
        const added = await api('/api/downloads', { seriesId: detail.series.series_id,
          episodeIds: pair.map(episode => episode.vid), quality: receipt.quality });
        const tasks = await wait(added.tasks.map(task => task.id));
        candidate = item; series = detail.series; selected = pair; downloads = tasks;
        break;
      } catch (error) {
        lastError = error;
        receipt.attempts = [...(receipt.attempts || []), safeError(error)];
      }
    }
    if (!downloads) throw lastError || new Error('四个随机剧集均未取得两集可下载素材');
    receipt.catalogSelection = { seriesId: String(candidate.series_id), title: candidate.series_title, random: true };
    receipt.episodes = selected.map(item => ({ vid: item.vid, index: item.vid_index }));
    receipt.steps.push('search', 'two-real-downloads');
    const { task } = await api('/api/merge', { taskIds: downloads.map(item => item.id) });
    const [merged] = await wait([task.id]); receipt.steps.push('merge');
    receipt.tasks = [];
    for (const item of [...downloads, merged]) {
      const response = await fetch(base + `/api/files/${item.id}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error('完成文件读取失败');
      const hash = crypto.createHash('sha256'); let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; hash.update(chunk); }
      receipt.tasks.push({ id: item.id, type: item.type, file: item.file, bytes, sha256: hash.digest('hex') });
    }
    receipt.steps.push('authenticated-file-read'); receipt.success = true;
  } catch (error) { receipt.success = false; receipt.error = safeError(error); process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString();
  if (process.env.HONGGUO_RECEIPT) fs.writeFileSync(path.resolve(process.env.HONGGUO_RECEIPT), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
