import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import './DownloadManager.css';
import { Download, Trash2, RefreshCw, X, Film, Square, Folder, Zap, CheckSquare, Play, Pause, Layers } from './icons';

const STATUS_TEXT = {
  pending: '等待中',
  downloading: '下载中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_ORDER = {
  downloading: 0,
  pending: 1,
  failed: 2,
  stopped: 3,
  completed: 4,
};

const isWaitingRetry = task => task.status === 'failed' && !!task.retryAt;
const needsManualRetry = task => task.status === 'stopped' || task.status === 'failed' && !isWaitingRetry(task);

function sortTasks(list) {
  const key = task => task.hongguoInfo?.series_id != null ? `series:${task.hongguoInfo.series_id}` : `task:${task.id}`;
  const groups = new Map();
  for (const task of list) {
    const group = groups.get(key(task)) || { rank: 99, time: 0 };
    group.rank = Math.min(group.rank, STATUS_ORDER[task.status] ?? 99);
    group.time = Math.max(group.time, task.startTime || 0);
    groups.set(key(task), group);
  }
  return [...list].sort((a, b) => {
    const ka = key(a), kb = key(b), ga = groups.get(ka), gb = groups.get(kb);
    if (ka !== kb) return ga.rank - gb.rank || gb.time - ga.time || ka.localeCompare(kb, 'zh-CN', { numeric: true });
    return (Number(a.hongguoInfo?.vid_index) || 0) - (Number(b.hongguoInfo?.vid_index) || 0) || (a.startTime || 0) - (b.startTime || 0);
  });
}

function fmtElapsed(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return value < 60 ? `${value} 秒` : value < 3600 ? `${Math.floor(value / 60)} 分 ${value % 60} 秒` : `${Math.floor(value / 3600)} 小时 ${Math.floor(value % 3600 / 60)} 分`;
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

const PAGE_SIZE = 100;

function DownloadManager({ onNavigate, active = true }) {
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [queue, setQueue] = useState({ active: 0, queued: 0, maxConcurrent: 3 });
  const [seriesList, setSeriesList] = useState([]);
  const [mergeSeriesId, setMergeSeriesId] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState('');
  const [mergeTasks, setMergeTasks] = useState([]);
  const [confirmAsk, setConfirmAsk] = useState(null); // 删除确认（可勾选删除本地文件）
  const [mergeAsk, setMergeAsk] = useState(false);    // 合并格式选择
  const [page, setPage] = useState(1);
  const [orderVersion, setOrderVersion] = useState(0);
  const [loadError, setLoadError] = useState('');
  const toastTimerRef = useRef(null);
  const moreActionsRef = useRef(null);
  const mergeRequestRef = useRef(false);
  const mergeDialogGenerationRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const requests = useRef({ tasks: 0, queue: 0, series: 0, merges: 0 });
  const taskIndex = useRef(new Map());
  const downloadedSeries = useRef(new Set());

  useEffect(() => {
    const menu = moreActionsRef.current;
    const close = () => { if (menu) menu.open = false; };
    if (!active) { close(); return; }
    const outside = event => { if (!menu?.contains(event.target)) close(); };
    const escape = event => {
      if (event.key !== 'Escape' || !menu?.open) return;
      event.preventDefault(); event.stopPropagation();
      close(); menu.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', close);
    };
  }, [active]);

  const refresh = useCallback(async () => {
    const request = ++requests.current.tasks;
    try {
      const list = await window.electronAPI.getDownloadTasks();
      if (!activeRef.current || request !== requests.current.tasks) return;
      if (!Array.isArray(list)) throw new Error('下载任务读取失败，请重试');
      for (const task of list) if (task.status === 'completed' && task.hongguoInfo?.series_id) downloadedSeries.current.add(String(task.hongguoInfo.series_id));
      setTasks(list);
      setOrderVersion(value => value + 1);
      const ids = new Set(list.map(task => task.id));
      setSelected(previous => new Set([...previous].filter(id => ids.has(id))));
      setLoadError('');
    } catch (error) {
      if (activeRef.current && request === requests.current.tasks) setLoadError(error.message || '下载任务读取失败，请重试');
    }
  }, []);

  const loadQueue = useCallback(async () => {
    const request = ++requests.current.queue;
    try {
      const q = await window.electronAPI.getQueueStatus();
      if (q && activeRef.current && request === requests.current.queue) setQueue(q);
    } catch (_) {}
  }, []);

  const loadSeriesList = useCallback(async (verifyFiles = true) => {
    const request = ++requests.current.series;
    try {
      let list = (await window.electronAPI.getSeriesList(verifyFiles ? { downloadedOnly: true } : undefined)) || [];
      if (!activeRef.current || request !== requests.current.series) return;
      if (verifyFiles) downloadedSeries.current = new Set(list.map(series => String(series.series_id)));
      else list = list.filter(series => downloadedSeries.current.has(String(series.series_id)));
      setSeriesList(list);
      setMergeSeriesId((prev) => list.some(item => String(item.series_id) === prev) ? prev : (list[0] ? String(list[0].series_id) : ''));
    } catch (_) {}
  }, []);

  // 列表刷新改选另一部剧时，旧确认框不能继续提交。
  useEffect(() => {
    mergeDialogGenerationRef.current += 1;
    setMergeAsk(false);
    setMergeError('');
  }, [mergeSeriesId]);

  const loadMergeTasks = useCallback(async () => {
    const request = ++requests.current.merges;
    try {
      const list = (await window.electronAPI.getMergeTasks()) || [];
      if (activeRef.current && request === requests.current.merges) setMergeTasks(list);
    } catch (_) {}
  }, []);

  const showToast = useCallback((text, type = 'success') => {
    setToast({ text, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    loadQueue();
    loadSeriesList();
    loadMergeTasks();
    const patches = new Map();
    let batchTimer = null, fullRefresh = false, reorder = false, seriesDirty = false, queueDirty = false;
    const schedule = () => {
      if (batchTimer !== null) return;
      batchTimer = setTimeout(() => {
        batchTimer = null;
        if (fullRefresh) refresh();
        else if (patches.size) {
          const updates = new Map(patches);
          setTasks(previous => previous.map(task => updates.has(task.id) ? { ...task, ...updates.get(task.id) } : task));
          if (reorder) setOrderVersion(value => value + 1);
        }
        if (seriesDirty) loadSeriesList(false);
        if (queueDirty) loadQueue();
        patches.clear();
        fullRefresh = reorder = seriesDirty = queueDirty = false;
      }, 200);
    };
    const patchTask = (data, status, affectsOrder = false) => {
      if (!data?.id) return;
      patches.set(data.id, { ...patches.get(data.id), ...data, status });
      reorder ||= affectsOrder || taskIndex.current.get(data.id)?.status !== status;
      schedule();
    };
    const cleanups = [
      window.electronAPI.onDownloadProgress((data) => {
        patchTask(data, 'downloading');
      }),
      window.electronAPI.onDownloadTaskAdded(() => { fullRefresh = seriesDirty = true; schedule(); }),
      window.electronAPI.onDownloadCompleted((data) => {
        const sid = data?.hongguoInfo?.series_id ?? taskIndex.current.get(data?.id)?.hongguoInfo?.series_id;
        if (sid) downloadedSeries.current.add(String(sid));
        seriesDirty = true;
        patchTask({ ...data, progress: 100 }, 'completed', true);
      }),
      window.electronAPI.onDownloadFailed((data) => {
        patchTask(data, 'failed', true);
      }),
      window.electronAPI.onDownloadStopped((data) => {
        patchTask(data, 'stopped', true);
      }),
      window.electronAPI.onDownloadQueueChanged(() => {
        fullRefresh = queueDirty = seriesDirty = true;
        schedule();
      }),
      window.electronAPI.onMergeTaskAdded(() => loadMergeTasks()),
      window.electronAPI.onMergeProgress((data) => {
        setMergeTasks((prev) =>
          prev.map((t) => (t.id === data.id ? { ...t, ...data } : t))
        );
      }),
      window.electronAPI.onMergeCompleted((data) => {
        loadMergeTasks();
        showToast(data.storageWarning || ('合并完成：' + (data.path ? data.path.split(/[\\/]/).pop() : '')), data.storageWarning ? 'error' : 'success');
      }),
      window.electronAPI.onMergeFailed((data) => {
        loadMergeTasks();
        showToast('合并失败：' + (data.error || '未知错误'), 'error');
      }),
    ];
    const timer = setInterval(() => {
      loadQueue();
      refresh();
      loadMergeTasks();
    }, 15000);
    return () => {
      cleanups.forEach(cleanup => cleanup());
      clearInterval(timer);
      clearTimeout(batchTimer);
      for (const key of Object.keys(requests.current)) requests.current[key]++;
    };
  }, [active, refresh, loadQueue, loadSeriesList, loadMergeTasks, showToast]);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearSelection = () => setSelected(new Set());
  const selectAll = () => setSelected(new Set(tasks.map((task) => task.id)));
  const allSelected = tasks.length > 0 && tasks.every((task) => selected.has(task.id));

  const fmtSize = (b) => {
    if (!b || b <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  };

  /** 弹删除确认：默认只删记录，可勾选同时删除本地文件 */
  const askDelete = (list, label) => {
    const items = (list || []).filter(Boolean);
    if (!items.length) return;
    // 用已下载字节数估算可释放空间（完成任务才有意义）
    const estBytes = items.reduce((s, t) => s + (t.totalBytes || t.receivedBytes || 0), 0);
    const withFile = items.filter((t) => t.status === 'completed').length;
    setConfirmAsk({
      title: label,
      count: items.length,
      withFile,
      estBytes,
      onOk: async (deleteFiles) => {
        try {
          const ids = items.map((t) => t.id);
          const res = await window.electronAPI.deleteTasksWithFiles(ids, deleteFiles);
          await Promise.all([refresh(), loadSeriesList()]);
          if (!res?.success) {
            const progress = Number.isFinite(res?.count) && Number.isFinite(res?.freed)
              ? `已移除 ${res.count} 个任务记录，已释放 ${fmtSize(res.freed)}；` : '';
            throw new Error(progress + (res?.error || '删除失败，请重试'));
          }
          showToast(deleteFiles
            ? `已删除 ${res.count} 个任务，释放 ${fmtSize(res.freed)}`
            : `已删除 ${res.count} 个任务记录（本地文件已保留）`);
        } catch (error) { showToast(error.message || '删除失败，请重试', 'error'); }
      },
    });
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    askDelete(tasks.filter((t) => selected.has(t.id)), '删除选中任务');
  };
  const retrySelected = async () => {
    if (selected.size === 0) return;
    const res = await window.electronAPI.retryTasks(Array.from(selected));
    setSelected(new Set());
    await refresh();
    if (res && res.success) {
      showToast(res.count > 0 ? `已重新加入队列：${res.count} 项` : '选中项中没有可重试的任务');
    } else {
      showToast((res && res.error) || '重试失败', 'error');
    }
  };

  // 一键合并选中的短剧
  const openMergeDialog = () => {
    mergeDialogGenerationRef.current += 1;
    setMergeError('');
    setMergeAsk(true);
  };

  const closeMergeDialog = () => {
    mergeDialogGenerationRef.current += 1;
    setMergeError('');
    setMergeAsk(false);
  };

  const doMerge = async (compatible, require1080 = false) => {
    if (mergeRequestRef.current) return;
    if (!mergeSeriesId) {
      showToast('请先选择要合并的短剧', 'error');
      return;
    }
    mergeRequestRef.current = true;
    const dialogGeneration = mergeDialogGenerationRef.current;
    setMerging(true);
    setMergeError('');
    try {
      const options = require1080 ? { compatible: false, require1080: true } : { compatible };
      const res = await window.electronAPI.mergeSeries(mergeSeriesId, '', options);
      if (dialogGeneration !== mergeDialogGenerationRef.current) return;
      if (!res || !res.success) {
        setMergeError((res && res.error) || '合并失败');
        return;
      }
      closeMergeDialog();
      await loadMergeTasks();
      const sizeGb = (res.totalBytes / 1073741824).toFixed(2);
      const duration = res.totalDuration > 0 ? ` / ${fmtElapsed(res.totalDuration)}` : ' / 时长待探测';
      showToast(compatible
        ? `开始兼容格式合并 ${res.count} 集（H.264，耗时较长）`
        : require1080
        ? `开始高质量分辨率合并 ${res.count} 集`
        : `开始合并 ${res.count} 集（约 ${sizeGb} GB${duration}）`);
      if (res.codecWarning) showToast(res.codecWarning, 'error');
    } catch (e) {
      if (dialogGeneration === mergeDialogGenerationRef.current) setMergeError('合并异常: ' + e.message);
    } finally {
      mergeRequestRef.current = false;
      setMerging(false);
    }
  };

  const cancelMerge = async (id) => {
    try {
      const result = await window.electronAPI.cancelMerge(id);
      if (!result?.success) throw new Error(result?.error || '取消请求失败，请重试');
      showToast('取消请求已发送，正在等待合并停止。');
      await loadMergeTasks();
    } catch (error) { showToast(error.message || '取消请求失败，请重试', 'error'); }
  };

  const openMergedFile = async (path) => {
    if (!path) return;
    try {
      const result = await window.electronAPI.showInFolder(path);
      if (!result?.success) throw new Error(result?.error || '无法打开文件夹');
    } catch (error) { showToast(error.message || '无法打开文件夹', 'error'); }
  };

  const openTaskFolder = async (id) => {
    try {
      const result = await window.electronAPI.openFolder(id);
      if (!result?.success) throw new Error(result?.error || '无法打开文件夹');
    } catch (error) { showToast(error.message || '无法打开文件夹', 'error'); }
  };

  // 一键暂停：取消进行中的 + 清空等待队列
  const pauseAll = async () => {
    try {
      const res = await window.electronAPI.pauseAll();
      await refresh();
      await loadQueue();
      showToast(res?.success ? `已暂停 ${res.count} 个任务` : (res?.error || '暂停失败'), res?.success ? 'success' : 'error');
    } catch (error) { showToast(error.message || '暂停失败', 'error'); }
  };

  // 一键启动：把所有已停止/失败/等待中的任务重新排队开跑
  const resumeAll = async () => {
    try {
      const res = await window.electronAPI.resumeAll();
      await refresh();
      await loadQueue();
      showToast(res?.success ? `已启动 ${res.count} 个任务` : (res?.error || '启动失败'), res?.success ? 'success' : 'error');
    } catch (error) { showToast(error.message || '启动失败', 'error'); }
  };

  // 重试失败/已停止的任务
  const retryAllFailed = async () => {
    const ids = tasks.filter(needsManualRetry).map((t) => t.id);
    if (ids.length === 0) return;
    const res = await window.electronAPI.retryTasks(ids);
    await refresh();
    if (res && res.success) {
      showToast(`已重新加入队列：${res.count} 项`);
    } else {
      showToast((res && res.error) || '重试失败', 'error');
    }
  };

  // 一键选中全部失败/已停止的任务（选中后可再点「重试选中」）
  const selectAllFailed = () => {
    const ids = tasks.filter(needsManualRetry).map((t) => t.id);
    if (ids.length === 0) {
      showToast('没有失败或已停止的任务');
      return;
    }
    setSelected(new Set(ids));
    showToast(`已选中 ${ids.length} 项，可点「重试选中」重新下载`);
  };

  const clearCompleted = async () => {
    const done = tasks.filter((t) => t.status === 'completed');
    if (done.length === 0) return;
    askDelete(done, '清空已完成任务');
  };

  // Progress updates change row values, not the established series/episode order.
  const sortedIds = useMemo(() => sortTasks(tasks).map(task => task.id), [orderVersion]);
  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  taskIndex.current = taskById;
  const pageCount = Math.max(1, Math.ceil(sortedIds.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleTasks = sortedIds.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(id => taskById.get(id)).filter(Boolean);

  const activeCount = tasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length;
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const retryingCount = tasks.filter(isWaitingRetry).length;
  const failedTasks = useMemo(
    () => tasks.filter(needsManualRetry),
    [tasks]
  );
  const failedCount = failedTasks.length;

  // 可暂停的任务：正在下载、等待中、已停止（未跑完的都算）
  const pausableCount = useMemo(
    () => tasks.filter((t) => t.status !== 'completed').length,
    [tasks]
  );

  // 已选中项里真正可重试的数量
  const retryableSelectedCount = useMemo(
    () =>
      Array.from(selected).filter((id) => {
        const t = taskById.get(id);
        return t && (t.status === 'failed' || t.status === 'stopped');
      }).length,
    [selected, taskById]
  );

  useDialogKeyboard(active && !!(confirmAsk || mergeAsk), () => { setConfirmAsk(null); closeMergeDialog(); }, '.dm-container .player-confirm');

  return (
    <div className="dm-container">
      <div className="dm-header">
        <div className="dm-title">
          <h2>下载管理</h2>
        </div>
        <div className="dm-stats">
          <span className="stat stat-active">进行中 {activeCount}</span>
          {retryingCount > 0 && <span className="stat stat-active">等待重试 {retryingCount}</span>}
          <span className="stat stat-done">已完成 {completedCount}</span>
          <span className="stat stat-fail">失败/停止 {failedCount}</span>
        </div>
      </div>

      <div className="dm-usage-notice" role="note" aria-label="下载风险与使用倡议">
        <p><strong>临时故障会自动重试。</strong>红果片源下载遇到断网、超时或传输不完整时，最多追加 3 次重试，分别等待 10、30、60 秒；取源暂不可用时等待 3、8、15 分钟。等待期间可停止或立即重试。权限限制、磁盘错误等需手动处理；重试后仍失败的任务会保留。</p>
        <p>本软件用于学习研究，建议体验后 24 小时内自行删除；请勿冒充官方或以虚假授权名义收费。开源权利义务以 GPLv3 为准。上述倡议不代表获得平台或版权方授权，也不构成免责承诺。</p>
      </div>

      <div className="dm-toolbar">
        <button
          className="btn btn-primary"
          onClick={resumeAll}
          disabled={!tasks.some(task => ['stopped', 'failed', 'pending'].includes(task.status))}
          title="把等待中 / 已停止 / 失败的任务全部排队开跑"
        >
          <Play size={15} />
          全部开始
        </button>
        <button
          className="btn btn-outline"
          onClick={pauseAll}
          disabled={pausableCount === 0}
          title="暂停全部：取消正在下载的并清空等待队列"
        >
          <Pause size={15} />
          全部暂停
        </button>
        <button
          className="btn btn-outline"
          onClick={retryAllFailed}
          disabled={failedCount === 0}
          title="把所有失败/已停止的任务一次性重新加入下载队列"
        >
          <Zap size={15} />
          {failedCount > 0 ? `重试失败 (${failedCount})` : '重试失败'}
        </button>
        <details className="dm-more-actions" ref={moreActionsRef}><summary>更多操作</summary><div className="dm-more-menu" onClick={event => { const button = event.target.closest('button'); if (button && !button.disabled) moreActionsRef.current.open = false; }}>
        <button
          className="btn btn-outline"
          onClick={selectAllFailed}
          disabled={failedCount === 0}
          title="一键勾选所有失败/已停止的任务"
        >
          <CheckSquare size={15} />
          {failedCount > 0 ? `选中失败项 (${failedCount})` : '选中失败项'}
        </button>
        <button className="btn btn-outline" onClick={retrySelected} disabled={retryableSelectedCount === 0}>
          <RefreshCw size={15} />
          重试选中 ({retryableSelectedCount})
        </button>
        <button className="btn btn-outline" onClick={clearCompleted} disabled={completedCount === 0}>
          <X size={15} />
          清空已完成
        </button>
        <button className="btn btn-outline" onClick={clearSelection} disabled={selected.size === 0}>
          取消选择
        </button>
        <button
          className="btn btn-outline"
          onClick={async () => {
            const r = await window.electronAPI.rescanDownloads();
            await refresh();
            await loadSeriesList();
            showToast(r && r.success
              ? (r.count > 0 ? `已从磁盘补回 ${r.count} 条下载记录` : '没有发现未登记的文件')
              : '扫描失败');
          }}
          title="扫描下载目录，把磁盘上已有但列表里没有的文件补登记回来"
        >
          <RefreshCw size={15} />
          扫描下载目录
        </button>
        </div></details>
        {seriesList.length > 0 && (
          <div className="merge-inline">
            <select
              className="input-field merge-select"
              value={mergeSeriesId}
              onFocus={() => loadSeriesList()}
              onChange={(e) => setMergeSeriesId(e.target.value)}
              title="选择要合并的短剧"
            >
              {seriesList.map((s) => (
                <option key={s.series_id} value={String(s.series_id)}>
                  {s.series_title}
                </option>
              ))}
            </select>
            <button className="btn btn-outline" onClick={openMergeDialog} disabled={merging} title="把该剧已下载的分集合并成单个 mp4">
              <Layers size={15} />
              {merging ? '合并中...' : '合并整部剧'}
            </button>
          </div>
        )}
        {onNavigate && (
          <button className="btn btn-primary dm-toolbar-end" onClick={() => onNavigate('download')}>
            <Film size={15} />
            添加下载
          </button>
        )}
      </div>

      {seriesList.length > 0 && <p className="settings-hint dm-merge-hint">选择剧名后点“合并整部剧”，导出该剧全部已下载分集，无需勾选任务。</p>}

      {/* 合并任务 */}
      {mergeTasks.length > 0 && (
        <div className="merge-list">
          {mergeTasks.map((m) => (
            <div key={m.id} className={`merge-card merge-${m.status}`}>
              <Layers size={16} />
              <div className="merge-body">
                <div className="merge-title">
                  合并《{m.seriesTitle}》· {m.done || 0}/{m.total} 集
                </div>
                <div className="merge-sub">
                  {m.status === 'running' && <>{m.stageText || '正在合并'}{m.method && m.method !== m.stageText ? ` · ${m.method}` : ''}</>}
                  {m.status === 'completed' && (
                    <>
                      已完成 · {m.outputName}
                      {m.outputBytes ? ` · ${fmtBytes(m.outputBytes)}` : ''}
                    </>
                  )}
                  {m.status === 'failed' && <>失败：{m.error}</>}
                  {m.status === 'stopped' && <>{m.error || '已取消'}</>}
                </div>
                <div className="merge-metrics">
                  <span>{m.stage === 'checking' ? `已检查 ${m.checked || 0}` : `已处理 ${m.done || 0}`} / {m.total} 集</span>
                  <span>用时 {fmtElapsed(m.status === 'running' ? (Date.now() - m.startTime) / 1000 : m.elapsedSeconds || ((m.endTime || m.startTime) - m.startTime) / 1000)}</span>
                  {m.status === 'running' && m.speed > 0 && <span>{m.speed.toFixed(1)} 倍速</span>}
                  {m.status === 'running' && Number.isFinite(m.etaSeconds) && <span>本阶段约剩 {fmtElapsed(m.etaSeconds)}</span>}
                </div>
                {(m.codecWarning || m.storageWarning || m.cleanupWarning) && <div className="merge-note">{m.storageWarning || m.cleanupWarning || m.codecWarning}</div>}
                {(m.status === 'running') && (
                  <div className="dm-progress">
                    <div className="dm-progress-bar" role="progressbar" aria-label="合并进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.progress || 0}>
                      <div className="dm-progress-fill" style={{ width: `${m.progress || 0}%` }} />
                    </div>
                    <span className="dm-pct">{m.progress || 0}%</span>
                  </div>
                )}
              </div>
              <div className="merge-actions">
                {m.status === 'running' && (
                  <button className="icon-btn" title="取消合并" onClick={() => cancelMerge(m.id)}>
                    <X size={16} />
                  </button>
                )}
                {m.status === 'completed' && (
                  <button className="icon-btn" title="打开所在文件夹" onClick={() => openMergedFile(m.output)}>
                    <Folder size={16} />
                  </button>
                )}
                {m.status !== 'running' && (
                  <button
                    className="icon-btn icon-btn-danger"
                    title="移除记录"
                    onClick={async () => {
                      try {
                        const result = await window.electronAPI.deleteMergeTask(m.id);
                        if (!result?.success) throw new Error(result?.error || '移除记录失败');
                        await loadMergeTasks();
                      } catch (error) { showToast(error.message || '移除记录失败，请重试', 'error'); }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {queue.active > 0 && (
        <div className="dm-queue-bar">
          <span className="dm-queue-running">
            <span className="dm-queue-pulse" />
            正在并发下载 <b>{queue.active}</b> / {queue.maxConcurrent}
            {queue.queued > 0 ? <> · 队列等待 <b>{queue.queued}</b></> : null}
          </span>
          <span className="dm-queue-hint">
            并发数可在「设置 → 最大并发下载数」调整
          </span>
        </div>
      )}

      {retryableSelectedCount > 0 && (
        <div className="dm-hint">
          已选中 <b>{retryableSelectedCount}</b> 个失败项，点
          <b>「重试选中」</b> 即会重新下载（无需重新解析）。
        </div>
      )}

      {loadError && <div className="alert alert-error" role="alert">{loadError}<button className="btn btn-outline btn-sm" onClick={refresh}>重新加载</button></div>}
      {tasks.length > 0 && <div className="dm-pagination">
        <div className="dm-selection-summary">
          <button className="btn btn-outline btn-sm" onClick={allSelected ? clearSelection : selectAll}
            title={allSelected ? '取消所有分页中的选择' : `选中全部 ${tasks.length} 项，包含其他分页`}>
            <CheckSquare size={15} />{allSelected ? '取消全选' : '全选'}
          </button>
          <button className="btn btn-outline btn-sm" onClick={deleteSelected} disabled={selected.size === 0}
            title="删除所有分页中已选的任务，确认时可选择是否同时删除本地文件">
            <Trash2 size={15} />删除已选（{selected.size}项）
          </button>
        <span>共 {tasks.length} 项 · 当前 {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, tasks.length)} 项{selected.size > 0 ? ` · 已选 ${selected.size} 项（跨页保留）` : ''}</span>
        </div>
        <nav aria-label="下载任务分页">
          <button className="btn btn-outline btn-sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
          <span>第 {currentPage} / {pageCount} 页</span>
          <button className="btn btn-outline btn-sm" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
        </nav>
      </div>}

      {tasks.length === 0 ? (
        <div className="dm-empty">
          <Download size={40} />
          <p>暂无下载任务</p>
          <p className="dm-empty-sub">搜索剧名或粘贴分享链接，选择想保存的集数。</p>
          {onNavigate && <button className="btn btn-primary" onClick={() => onNavigate('download')}>添加第一部短剧</button>}
        </div>
      ) : (
        <div className="dm-list">
          {visibleTasks.map((task) => {

            const isSel = selected.has(task.id);
            const waitingRetry = isWaitingRetry(task);
            const canStop = task.status === 'downloading' || task.status === 'pending' || waitingRetry;
            const canRetry = task.status === 'failed' || task.status === 'stopped';
            const pct = task.progress || 0;
            return (
              <div key={task.id} className={`dm-task ${isSel ? 'selected' : ''}`} onClick={() => toggleSelect(task.id)}>
                <input className="dm-task-select" type="checkbox" aria-label={`选择 ${task.title || task.filename}`} checked={isSel} onClick={(e) => e.stopPropagation()} onChange={() => toggleSelect(task.id)} />
                <div className="dm-task-cover">
                  {task.videoInfo && task.videoInfo.cover ? (
                    <img src={task.videoInfo.cover} alt="" />
                  ) : (
                    <div className="cover-placeholder"><Film size={18} /></div>
                  )}
                </div>
                <div className="dm-task-body">
                  <div className="dm-task-title">{task.title || task.filename}</div>
                  <div className="dm-task-meta">
                    <span className={`status-tag status-${waitingRetry ? 'pending' : task.status}`}>{waitingRetry ? '等待重试' : STATUS_TEXT[task.status] || task.status}</span>
                    {waitingRetry && <span className="dm-size">自动重试 {task.sourceRetries}/3 · {new Date(task.retryAt).toLocaleTimeString('zh-CN', { hour12: false })} 后排队</span>}
                    {task.status === 'downloading' && task.totalBytes > 0 && (
                      <span className="dm-size">{fmtBytes(task.receivedBytes)} / {fmtBytes(task.totalBytes)}</span>
                    )}
                    {task.status === 'failed' && task.error && <span className="dm-error">{task.error}</span>}
                  </div>
                  {['downloading', 'completed'].includes(task.status) && task.qualityNotice && <div className="dm-quality-notice">{task.qualityNotice}</div>}
                  {task.nasWarning && <div className="dm-error">{task.nasWarning}</div>}
                  {task.metadataWarning && <div className="dm-error">{task.metadataWarning}</div>}
                  {(task.status === 'downloading' || task.status === 'pending') && (
                    <div className="dm-progress">
                      <div className="dm-progress-bar">
                        <div className="dm-progress-fill" style={{ width: pct + '%' }}></div>
                      </div>
                      <span className="dm-pct">{pct}%</span>
                    </div>
                  )}
                </div>
                <div className="dm-task-actions" onClick={(e) => e.stopPropagation()}>
                  {canStop && (
                    <button className="icon-btn" title={waitingRetry ? '停止自动重试' : '停止'} onClick={async () => {
                      try {
                        const result = await window.electronAPI.stopDownload(task.id);
                        if (!result?.success) throw new Error(result?.error || '停止失败');
                        await refresh();
                      } catch (error) { showToast(error.message || '停止失败', 'error'); }
                    }}>
                      <Square size={16} />
                    </button>
                  )}
                  {canRetry && (
                    <button className="icon-btn" title={waitingRetry ? '立即重试' : '重试'} onClick={async () => {
                      try {
                        const result = await window.electronAPI.retryTask(task.id);
                        if (!result?.success) throw new Error(result?.error || '重试失败');
                      } catch (error) { showToast(error.message || '重试失败', 'error'); }
                    }}>
                      <RefreshCw size={16} />
                    </button>
                  )}
                  <button className="icon-btn" title="打开文件夹" onClick={() => openTaskFolder(task.id)}>
                    <Folder size={16} />
                  </button>
                  <button
                    className="icon-btn icon-btn-danger"
                    title="删除任务（可选是否同时删除本地文件）"
                    onClick={() => {
                      askDelete([task], `删除《${task.hongguoInfo && task.hongguoInfo.series_title ? task.hongguoInfo.series_title : ''}》第 ${task.hongguoInfo ? task.hongguoInfo.vid_index : ''} 集任务`);
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {toast && (
        <div className={`dm-toast dm-toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      {/* 合并格式选择 */}
      {mergeAsk && (
        <div className="player-confirm-mask" onClick={closeMergeDialog}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={confirmAsk ? confirmAsk.title : '合并导出'} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title" style={{ color: 'var(--accent)' }}>
              <Layers size={17} />
              合并整部剧
            </div>
            <div className="player-confirm-msg">
              <p>将《{seriesList.find((series) => String(series.series_id) === mergeSeriesId)?.series_title || '所选短剧'}》的全部已下载分集合并为一个 mp4。未下载的分集不会自动补齐。</p>
              <p><b>高质量分辨率合并</b>：逐集检查实际文件，全部达到1080P才能开始；有低清分集请选快速或兼容合并。</p>
              <p><b>快速合并</b>：优先无损拼接，保留每段原分辨率，部分设备可能不兼容。</p>
              <p><b>兼容合并</b>：必要时转为H.264/AAC，仍保留每段原分辨率，处理较慢。</p>
              <p>三种方式都保留原文件，只合并已下载分集，不自动补齐，也不会把低清变成真高清。</p>
              {mergeError && <p className="alert-error" role="alert">{mergeError}</p>}
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => doMerge(false, true)} disabled={merging}>
                高质量分辨率合并
              </button>
              <button className="btn btn-outline" onClick={closeMergeDialog}>取消</button>
              <button className="btn btn-outline" onClick={() => doMerge(true)} disabled={merging}>
                兼容合并（H.264）
              </button>
              <button className="btn btn-primary" onClick={() => doMerge(false)} disabled={merging}>
                智能快速合并
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认（可选是否连本地文件一起删） */}
      {confirmAsk && (
        <div className="player-confirm-mask" onClick={() => setConfirmAsk(null)}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={confirmAsk ? confirmAsk.title : '合并导出'} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title">
              <Trash2 size={17} />
              {confirmAsk.title}
            </div>
            <div className="player-confirm-msg">
              <p>共 {confirmAsk.count} 个任务，其中 {confirmAsk.withFile} 个已下载完成
                {confirmAsk.estBytes > 0 ? `（约 ${fmtSize(confirmAsk.estBytes)}）` : ''}。</p>
              <label className="dm-confirm-check">
                <input
                  type="checkbox"
                  checked={!!confirmAsk._del}
                  onChange={(e) => setConfirmAsk({ ...confirmAsk, _del: e.target.checked })}
                />
                <span>
                  同时删除本地文件
                  {confirmAsk.estBytes > 0 ? `（释放约 ${fmtSize(confirmAsk.estBytes)}）` : ''}
                </span>
              </label>
              <p className="dm-confirm-hint">
                不勾选则只移除任务记录，磁盘上的视频文件会保留（可在文件管理器里自行管理）。
              </p>
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => setConfirmAsk(null)}>取消</button>
              <button
                className={`btn ${confirmAsk._del ? 'btn-danger-solid' : 'btn-primary'}`}
                onClick={async () => {
                  const fn = confirmAsk.onOk;
                  const del = !!confirmAsk._del;
                  setConfirmAsk(null);
                  await fn(del);
                }}
              >
                {confirmAsk._del ? '删除任务和文件' : '仅删除记录'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DownloadManager;
