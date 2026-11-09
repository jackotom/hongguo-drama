'use strict';

const $ = (id) => document.getElementById(id);
const state = { token: '', session: 0, page: 1, query: '', series: null, tasks: [], selected: new Set(), merging: new Set(), timer: null, refreshing: false, downloading: false, mergePending: false, detailRequest: 0, searchRequest: 0 };
const pending = new Set();
const statusNames = { queued: '等待中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function safeMessage(error) {
  return String(error?.message || error || '操作失败，请稍后重试').replace(/https?:\/\/[^\s<>"']+/gi, '[地址已隐藏]').slice(0, 600);
}

function notice(message, error = false) {
  $('notice').textContent = safeMessage(message);
  $('notice').className = error ? 'notice error' : 'notice';
  $('notice').hidden = !message;
}

async function api(path, body) {
  const session = state.session;
  const controller = new AbortController();
  pending.add(controller);
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${state.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    if (session !== state.session) throw new Error('连接已断开');
    if (response.status === 401 || response.status === 403) {
      disconnect('访问令牌无效或已变更，请重新输入。');
      throw new Error('访问令牌无效或已变更，请重新输入。');
    }
    const data = await response.json().catch(() => { throw new Error(`服务响应异常（HTTP ${response.status}），请检查 NAS 服务。`); });
    if (session !== state.session) throw new Error('连接已断开');
    if (!response.ok || data.success === false) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(session === state.session ? '请求超时，请检查网络后重试。' : '连接已断开');
    if (error instanceof TypeError) throw new Error('无法连接 NAS，请检查网络和服务状态后重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
    pending.delete(controller);
  }
}

function disconnect(message = '') {
  state.session += 1;
  state.token = '';
  clearTimeout(state.timer);
  for (const controller of pending) controller.abort();
  pending.clear();
  state.series = null;
  state.tasks = [];
  state.selected.clear();
  state.merging.clear();
  state.refreshing = false;
  state.downloading = false;
  state.mergePending = false;
  state.detailRequest += 1;
  state.searchRequest += 1;
  $('app').hidden = true;
  $('login').hidden = false;
  $('token').value = '';
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
  $('results').replaceChildren();
  $('tasks').replaceChildren();
  $('episodes').replaceChildren();
  $('detail-content').hidden = true;
  $('detail-empty').hidden = false;
  $('detail-empty').replaceChildren(element('h2', '选择一部短剧'), element('p', '查看分集，再选择保存到 NAS 的内容。'));
  $('search-status').textContent = '输入剧名，找到想保存的短剧。';
  $('search-status').hidden = false;
  $('previous-page').hidden = true;
  $('next-page').hidden = true;
  $('search-button').disabled = false;
  $('search-button').textContent = '搜索';
  $('page-label').textContent = '';
  $('token').focus();
}

function showView(view) {
  for (const name of ['search', 'tasks', 'api']) $('view-' + name).hidden = name !== view;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  if (view === 'tasks' && state.token) refreshTasks();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if ($('login-button').disabled) return;
  state.token = $('token').value.trim();
  $('token').value = '';
  if (!state.token) return;
  state.session += 1;
  const session = state.session;
  $('login-button').disabled = true;
  $('login-button').textContent = '正在连接…';
  $('login-error').hidden = true;
  try {
    const data = await api('/status');
    if (session !== state.session) return;
    $('version').textContent = data.version || '';
    $('download-root').textContent = `容器下载目录：${data.downloadRoot || '/downloads'}`;
    $('connection-status').textContent = '已连接';
    $('login').hidden = true;
    $('app').hidden = false;
    notice('');
    showView('search');
    $('query').focus();
    refreshTasks();
  } catch (error) {
    if (session === state.session) disconnect(safeMessage(error));
  } finally {
    $('login-button').disabled = false;
    $('login-button').textContent = '连接 NAS';
  }
});
$('logout').addEventListener('click', () => disconnect());
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); showView('search'); });

async function search(page) {
  const query = $('query').value.trim();
  if (!query) return;
  const request = ++state.searchRequest;
  const session = state.session;
  $('search-button').disabled = true;
  $('previous-page').disabled = true;
  $('next-page').disabled = true;
  $('search-button').textContent = '搜索中…';
  $('search-status').textContent = '正在搜索…';
  $('search-status').hidden = false;
  notice('');
  try {
    const data = await api(`/search?q=${encodeURIComponent(query)}&page=${page}`);
    if (request !== state.searchRequest || session !== state.session) return;
    state.query = query;
    state.page = page;
    const results = Array.isArray(data.results) ? data.results : [];
    $('results').replaceChildren();
    for (const result of results) {
      const button = element('button', undefined, 'result');
      button.type = 'button';
      button.dataset.seriesId = String(result.series_id);
      button.setAttribute('aria-pressed', String(String(state.series?.series_id) === String(result.series_id)));
      try {
        const cover = new URL(result.cover);
        if (cover.protocol === 'https:' && !cover.username && !cover.password) {
          const img = element('img');
          img.src = cover.href;
          img.alt = '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.addEventListener('error', () => img.remove(), { once: true });
          button.append(img);
        }
      } catch { /* Missing covers do not block selecting a series. */ }
      const label = element('span');
      label.append(element('span', result.series_title || '未命名剧集', 'result-title'));
      label.append(element('span', result.total ? `共 ${result.total} 集 · 查看分集` : '查看分集', 'result-meta'));
      button.append(label);
      button.addEventListener('click', () => loadSeries(result.series_id));
      $('results').append(button);
    }
    $('search-status').textContent = results.length ? '' : '没有找到相关剧集，换个关键词试试。';
    $('search-status').hidden = Boolean(results.length);
    $('page-label').textContent = `第 ${page} 页`;
    $('previous-page').hidden = page <= 1;
    $('next-page').hidden = data.hasMore === false || !results.length;
  } catch (error) {
    if (request !== state.searchRequest || session !== state.session) return;
    $('search-status').textContent = '搜索失败，已保留上次结果。';
    notice(error, true);
  } finally {
    if (request === state.searchRequest) {
      $('search-button').disabled = false;
      $('search-button').textContent = '搜索';
      $('previous-page').disabled = false;
      $('next-page').disabled = false;
    }
  }
}
$('search-form').addEventListener('submit', (event) => { event.preventDefault(); search(1); });
$('previous-page').addEventListener('click', () => { $('query').value = state.query; search(state.page - 1); });
$('next-page').addEventListener('click', () => { $('query').value = state.query; search(state.page + 1); });

async function loadSeries(id) {
  const request = ++state.detailRequest;
  const session = state.session;
  state.series = null;
  state.selected.clear();
  $('detail-content').hidden = true;
  $('detail-empty').hidden = false;
  $('detail-empty').replaceChildren(element('p', '正在读取分集…'));
  notice('');
  try {
    const data = await api(`/series/${encodeURIComponent(id)}`);
    if (request !== state.detailRequest || session !== state.session) return;
    state.series = data.series;
    const episodes = Array.isArray(state.series?.episodes) ? state.series.episodes : [];
    if (!episodes.length) throw new Error('这部剧暂未提供可下载分集，请稍后重试。');
    $('detail-title').textContent = state.series.series_title || '未命名剧集';
    $('episode-total').textContent = `共 ${episodes.length} 集 · 选择需要下载的分集`;
    $('episodes').replaceChildren();
    for (const episode of episodes) {
      const label = element('label', undefined, 'episode');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.value = String(episode.vid);
      const title = episode.title || `第 ${episode.vid_index} 集`;
      checkbox.setAttribute('aria-label', title);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(checkbox.value);
        else state.selected.delete(checkbox.value);
        updateSelection();
      });
      label.title = title;
      label.append(checkbox, element('span', `第 ${episode.vid_index} 集`));
      $('episodes').append(label);
    }
    for (const button of $('results').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.seriesId === String(id)));
    $('detail-empty').hidden = true;
    $('detail-content').hidden = false;
    updateSelection();
    if (window.matchMedia('(max-width: 760px)').matches) $('detail').scrollIntoView({ block: 'start' });
    $('detail-title').focus({ preventScroll: true });
  } catch (error) {
    if (request !== state.detailRequest || session !== state.session) return;
    state.series = null;
    $('detail-empty').replaceChildren(element('p', safeMessage(error), 'error'));
    const retry = element('button', '重新读取');
    retry.type = 'button';
    retry.addEventListener('click', () => loadSeries(id));
    $('detail-empty').append(retry);
  }
}

function updateSelection() {
  $('selection-count').textContent = `已选 ${state.selected.size} 集`;
  $('download').disabled = state.downloading || !state.selected.size || !state.series;
  $('download').textContent = state.downloading ? '正在提交…' : state.selected.size ? `下载选中 ${state.selected.size} 集` : '下载选中分集';
}
function selectEpisodes(all) {
  state.selected.clear();
  for (const checkbox of $('episodes').querySelectorAll('input')) {
    checkbox.checked = all;
    if (all) state.selected.add(checkbox.value);
  }
  updateSelection();
}
$('select-all').addEventListener('click', () => selectEpisodes(true));
$('clear-selection').addEventListener('click', () => selectEpisodes(false));
$('download').addEventListener('click', async () => {
  if (!state.series || !state.selected.size || $('download').disabled) return;
  const session = state.session;
  const series = state.series;
  state.downloading = true;
  $('download').disabled = true;
  $('download').textContent = '正在提交…';
  try {
    const data = await api('/downloads', { seriesId: String(series.series_id), episodeIds: [...state.selected], quality: $('quality').value });
    if (session !== state.session) return;
    if (state.series === series) selectEpisodes(false);
    notice(`已提交 ${data.tasks?.length || 0} 个下载任务。文件将保存到 NAS。`);
    showView('tasks');
  } catch (error) {
    if (session === state.session) notice(error, true);
  } finally {
    if (session === state.session) { state.downloading = false; updateSelection(); }
  }
});

function updateMerge() {
  $('merge').textContent = `合并已选分集（${state.merging.size}）`;
  const chosen = state.tasks.filter((task) => state.merging.has(task.id));
  $('merge').disabled = state.mergePending || chosen.length < 2 || new Set(chosen.map((task) => String(task.seriesId))).size !== 1;
}

function renderTasks() {
  const focused = document.activeElement?.dataset.taskControl;
  const filter = $('task-filter').value;
  const tasks = state.tasks.filter((task) => filter === 'all' || (filter === 'active' && ['queued', 'running'].includes(task.status)) || (filter === 'completed' && task.status === 'completed') || (filter === 'failed' && ['failed', 'interrupted', 'cancelled'].includes(task.status)));
  $('tasks').replaceChildren();
  if (!tasks.length) $('tasks').append(element('p', state.tasks.length ? '当前筛选下没有任务。' : '还没有下载任务。先搜索剧集并选择分集。', 'empty'));
  for (const task of tasks) {
    const row = element('article', undefined, 'task');
    const eligible = task.type === 'download' && task.status === 'completed';
    const checkbox = element('input', undefined, 'task-check');
    checkbox.type = 'checkbox';
    checkbox.disabled = !eligible;
    checkbox.checked = state.merging.has(task.id);
    checkbox.dataset.taskControl = `select-${task.id}`;
    const episode = task.type === 'merge' ? '合并文件' : (task.episodeTitle || `第 ${task.episodeIndex} 集`);
    checkbox.setAttribute('aria-label', `选择合并：${task.seriesTitle} ${episode}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        const existing = state.tasks.find((item) => state.merging.has(item.id));
        if (existing && String(existing.seriesId) !== String(task.seriesId)) {
          checkbox.checked = false;
          notice('只能合并同一部剧的分集。请先取消已选分集。', true);
          return;
        }
        state.merging.add(task.id);
      } else state.merging.delete(task.id);
      updateMerge();
    });
    const details = element('div');
    details.append(element('div', `${task.seriesTitle || '未命名剧集'} · ${episode}`, 'task-name'));
    const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
    details.append(element('p', `${task.type === 'merge' ? '合并' : '下载'} · ${statusNames[task.status] || task.status}${task.status === 'running' ? ` · ${Math.round(progress)}%` : ''}`, `task-meta status ${Object.hasOwn(statusNames, task.status) ? task.status : ''}`));
    if (task.status === 'running') {
      const bar = element('progress');
      bar.max = 100;
      bar.value = progress;
      bar.setAttribute('aria-label', `${episode}进度`);
      details.append(bar);
    }
    if (task.error) details.append(element('p', safeMessage(task.error), 'task-meta error'));
    if (task.file && task.status === 'completed') details.append(element('p', `保存位置：${task.file}`, 'task-meta'));
    const actions = element('div', undefined, 'task-actions');
    const action = ['queued', 'running'].includes(task.status) ? 'cancel' : ['failed', 'interrupted', 'cancelled'].includes(task.status) ? 'retry' : null;
    if (action) {
      const button = element('button', action === 'cancel' ? '取消' : '重试');
      button.type = 'button';
      button.dataset.taskControl = `${action}-${task.id}`;
      button.addEventListener('click', () => taskAction(task.id, action, button));
      actions.append(button);
    }
    row.append(checkbox, details, actions);
    $('tasks').append(row);
  }
  if (focused) {
    const control = [...$('tasks').querySelectorAll('[data-task-control]')].find((node) => node.dataset.taskControl === focused);
    control?.focus({ preventScroll: true });
  }
  $('task-count').textContent = String(state.tasks.filter((task) => ['queued', 'running'].includes(task.status)).length);
  updateMerge();
}

async function refreshTasks() {
  if (!state.token || state.refreshing) return;
  state.refreshing = true;
  clearTimeout(state.timer);
  const session = state.session;
  try {
    const data = await api('/tasks');
    if (session !== state.session) return;
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    if (JSON.stringify(tasks) !== JSON.stringify(state.tasks) || !$('tasks').childElementCount) {
      state.tasks = tasks;
      for (const id of state.merging) if (!tasks.some((task) => task.id === id && task.type === 'download' && task.status === 'completed')) state.merging.delete(id);
      renderTasks();
    }
    $('tasks-status').textContent = `共 ${tasks.length} 个任务 · 每 4 秒自动刷新`;
    $('tasks-status').className = 'hint';
    $('connection-status').textContent = '已连接';
  } catch (error) {
    if (session !== state.session) return;
    $('tasks-status').textContent = `${safeMessage(error)} 已保留上次状态，将自动重试。`;
    $('tasks-status').className = 'error';
    $('connection-status').textContent = '连接暂不可用';
  } finally {
    if (session === state.session) {
      state.refreshing = false;
      if (state.token) state.timer = setTimeout(refreshTasks, 4000);
    }
  }
}
async function taskAction(id, action, button) {
  const session = state.session;
  button.disabled = true;
  try {
    await api(`/tasks/${encodeURIComponent(id)}/${action}`, {});
    if (session !== state.session) return;
    notice(action === 'cancel' ? '已请求取消任务，已完成文件保留。' : '已重新提交任务。');
    await refreshTasks();
  } catch (error) {
    if (session === state.session) notice(error, true);
  } finally { button.disabled = false; }
}
$('refresh-tasks').addEventListener('click', refreshTasks);
$('task-filter').addEventListener('change', renderTasks);
$('merge').addEventListener('click', async () => {
  if ($('merge').disabled) return;
  const session = state.session;
  state.mergePending = true;
  $('merge').disabled = true;
  try {
    await api('/merge', { taskIds: [...state.merging] });
    if (session !== state.session) return;
    state.merging.clear();
    renderTasks();
    notice('已提交合并任务，将按集号顺序合并，原分集保留。');
    await refreshTasks();
  } catch (error) {
    if (session === state.session) notice(error, true);
  } finally { if (session === state.session) { state.mergePending = false; updateMerge(); } }
});

$('api-origin').textContent = window.location.origin;
$('api-example').textContent = `# 在终端设置 HONGGUO_TOKEN 后调用；勿将真实令牌写入分享的脚本\ncurl --fail --silent --show-error \\\n  -H "Authorization: Bearer $HONGGUO_TOKEN" \\\n  '${window.location.origin}/api/status'`;
window.addEventListener('pagehide', () => { state.token = ''; for (const controller of pending) controller.abort(); clearTimeout(state.timer); });
window.addEventListener('pageshow', (event) => { if (event.persisted) disconnect(); });
