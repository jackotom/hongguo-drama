const STATUS_ORDER = {
  downloading: 0,
  pending: 1,
  failed: 2,
  stopped: 3,
  completed: 4,
};

function pathConflicts(tasks) {
  const paths = new Map();
  for (const task of tasks) {
    if (!task?.savePath) continue;
    const vid = String(task.hongguoInfo?.vid);
    const rows = paths.get(task.savePath) || [];
    rows.push({ task, vid });
    paths.set(task.savePath, rows);
  }
  const conflicts = new Map();
  for (const [file, rows] of paths) {
    if (rows.length > 1 && rows.some(row => row.vid !== rows[0].vid)) {
      conflicts.set(file, new Set(rows.map(row => row.task)));
    }
  }
  return conflicts;
}

function downloadTaskView(tasks, {
  hasCompleteFile,
  xifanTitleConflict = () => false,
}) {
  const conflicts = pathConflicts(tasks);
  const sorted = tasks.slice().sort((a, b) => {
    const wa = STATUS_ORDER[a.status] ?? 99;
    const wb = STATUS_ORDER[b.status] ?? 99;
    if (wa !== wb) return wa - wb;
    if (wa <= 1) {
      return (a.hongguoInfo?.vid_index || 0) - (b.hongguoInfo?.vid_index || 0)
        || (a.startTime || 0) - (b.startTime || 0);
    }
    return (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0);
  });

  return sorted.map(task => {
    const { cancelSource, writer, ...serializableTask } = task;
    const info = task.hongguoInfo;
    if (String(info?.series_id).startsWith('xifan:') && xifanTitleConflict(info)) {
      serializableTask.title = `《${info.series_title}》第${String(info.vid_index).padStart(3, '0')}集`;
    }
    if (task.status === 'completed' && !hasCompleteFile(task, conflicts)) {
      return { ...serializableTask, status: 'failed', progress: 0, qualityNotice: '', error: '本地文件已丢失或路径冲突，请重新下载' };
    }
    return { ...serializableTask, qualityNotice: ['downloading', 'completed'].includes(task.status) ? task.qualityNotice || '' : '' };
  });
}

module.exports = { downloadTaskView, pathConflicts };
