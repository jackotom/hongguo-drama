/**
 * Windows 便携版资料目录。
 *
 * electron-builder 的 portable 目标会设置 PORTABLE_EXECUTABLE_DIR。便携版
 * 把数据放在程序目录的 data 子目录，移动程序时一起带走；只复制缺失的
 * 资料文件，不删除系统目录里的旧数据。程序目录不可写时回退系统目录。
 */
const fs = require('fs');
const path = require('path');

const DATA_FILES = Object.freeze(['data.json', 'data.playback.json', 'danmaku-client.json']);
const PORTABLE_DATA_FOLDER = 'data';
const PORTABLE_MARKER = 'portable.marker';
const MIGRATION_SENTINEL = '.migration-incomplete';

function getPortableDirectory({ env = process.env, platform = process.platform, execPath = '' } = {}) {
  if (platform !== 'win32') return '';
  const configured = String(env.PORTABLE_EXECUTABLE_DIR || '').trim();
  if (configured) return path.resolve(configured);
  if (execPath && fs.existsSync(path.join(path.dirname(execPath), PORTABLE_MARKER))) return path.dirname(execPath);
  return '';
}

function isWritableDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

function recoverIncompleteMigration(toDir) {
  const sentinel = path.join(toDir, MIGRATION_SENTINEL);
  if (!fs.existsSync(sentinel)) return { ok: true };
  let names = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
    if (Array.isArray(parsed?.files)) names = parsed.files;
  } catch (_) { names = null; }
  if (!names) return { ok: false };
  const stuck = [];
  for (const name of names) {
    if (!DATA_FILES.includes(name)) continue;
    const file = path.join(toDir, name);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {
      stuck.push(name);
    }
  }
  if (stuck.length) return { ok: false, stuck };
  try { fs.unlinkSync(sentinel); } catch (_) { return { ok: false, stuck: ['sentinel'] }; }
  return { ok: true };
}

function migrateDataFiles(fromDir, toDir) {
  const copied = [];
  if (!fromDir || !toDir || path.resolve(fromDir) === path.resolve(toDir)) return { copied, failed: false };
  const pending = [];
  // 先完整暂存：全部复制成功之前不碰正式文件。
  try {
    for (const name of DATA_FILES) {
      const source = path.join(fromDir, name);
      const target = path.join(toDir, name);
      const temporary = `${target}.importing`;
      if (!fs.existsSync(source) || fs.existsSync(target)) continue;
      try { fs.unlinkSync(temporary); } catch (_) { /* 没有残留临时文件 */ }
      fs.copyFileSync(source, temporary);
      pending.push({ name, target, temporary });
    }
  } catch (_) {
    for (const item of pending) { try { fs.unlinkSync(item.temporary); } catch (_) { /* 已不存在 */ } }
    return { copied: [], failed: true };
  }
  if (!pending.length) return { copied, failed: false };

  const sentinel = path.join(toDir, MIGRATION_SENTINEL);
  // 提交前写标记：提交中途崩溃或回滚失败时，下次启动一定知道不能直接用这套资料。
  try {
    fs.writeFileSync(sentinel, JSON.stringify({ files: pending.map(item => item.name) }));
  } catch (_) {
    for (const item of pending) { try { fs.unlinkSync(item.temporary); } catch (_) { /* 已不存在 */ } }
    return { copied: [], failed: true };
  }

  const committed = [];
  try {
    for (const item of pending) {
      fs.renameSync(item.temporary, item.target);
      committed.push(item);
      copied.push(item.name);
    }
  } catch (_) {
    for (const item of committed) { try { fs.unlinkSync(item.target); } catch (_) { /* 删不掉时由 sentinel 兜底 */ } }
    for (const item of pending) { try { fs.unlinkSync(item.temporary); } catch (_) { /* 已重命名或不存在 */ } }
    // 保留 sentinel；调用方会回退系统目录，下次启动再清理/重试。
    return { copied: [], failed: true };
  }

  try {
    fs.unlinkSync(sentinel);
  } catch (_) {
    // 已提交但标记删不掉：同样回退旧目录，避免下次启动误把残留当完整资料。
    return { copied: [], failed: true };
  }
  return { copied, failed: false };
}

/**
 * 解析便携版资料目录。不直接调用 app.setPath，便于单元测试。
 * @returns {{ mode: 'default'|'portable', dir: string, reason: string, copied: string[], portableDir: string }}
 */
function resolvePortableDataDir({
  env = process.env,
  platform = process.platform,
  defaultUserData,
  execPath,
} = {}) {
  const fallback = { mode: 'default', dir: defaultUserData || '', reason: '', copied: [], portableDir: '' };
  if (platform !== 'win32') return fallback;
  // 单文件便携 EXE 由 electron-builder 设置环境变量；便携 ZIP 用标记文件识别。
  const portableDir = getPortableDirectory({ env, platform, execPath });
  if (!portableDir) return fallback;
  const target = path.join(portableDir, PORTABLE_DATA_FOLDER);
  if (!isWritableDirectory(target)) {
    return {
      ...fallback,
      portableDir,
      reason: '便携版程序目录不可写，已继续使用系统配置目录；请把程序放到有写入权限的位置，或改用安装版。',
    };
  }
  const recovered = recoverIncompleteMigration(target);
  if (!recovered.ok) {
    return {
      ...fallback,
      portableDir,
      reason: '上次便携资料迁移未完成，已继续使用系统配置目录；请检查程序目录的 data 文件夹后重试。',
      copied: [],
    };
  }
  const migration = migrateDataFiles(defaultUserData, target);
  if (migration.failed) {
    return {
      ...fallback,
      portableDir,
      reason: '旧资料复制失败，已继续使用系统配置目录；请检查程序目录权限后重启。原文件未删除。',
      copied: [],
    };
  }
  return { mode: 'portable', dir: target, reason: '', copied: migration.copied, portableDir };
}

/**
 * 把解析结果实际应用到 Electron app：便携版同时切换 userData 与 sessionData。
 * 单独导出便于用假 app 覆盖启动接线，不必启动 Electron。
 */
function applyPortableDataDir({ app, env, platform, execPath, defaultUserData } = {}) {
  const resolved = resolvePortableDataDir({ env, platform, execPath, defaultUserData });
  if (resolved.mode === 'portable') {
    app.setPath('userData', resolved.dir);
    try { app.setPath('sessionData', resolved.dir); }
    catch (_) {
      resolved.reason = '便携版会话目录设置失败，界面数据可能仍保存在系统目录；设置与下载记录已使用程序目录。';
    }
  }
  return resolved;
}

module.exports = {
  DATA_FILES,
  PORTABLE_DATA_FOLDER,
  PORTABLE_MARKER,
  MIGRATION_SENTINEL,
  getPortableDirectory,
  isWritableDirectory,
  migrateDataFiles,
  resolvePortableDataDir,
  applyPortableDataDir,
};
