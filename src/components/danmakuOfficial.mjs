// Adapted from dawei233/hongguo-drama, commit c884fab6c6e36ad38173e251738b9b35f958383f (GPL-3.0).
// https://github.com/dawei233/hongguo-drama
// 时间轴投放与评论队列分开；两种来源共用视觉设置、轨道布局和窗口重排。

import { commentIsBlocked, danmakuLayout, retireDanmaku, takeDanmakuReplay, groupDanmaku, danmakuText } from './danmakuModel.mjs';

export const DANMAKU_SOURCES = Object.freeze(['official', 'comments']);

/** 默认走真弹幕；存储里出现任何其它值都回落到默认。 */
export const DEFAULT_DANMAKU_SOURCE = 'official';

export function normalizeDanmakuSource(value) {
  return DANMAKU_SOURCES.includes(value) ? value : DEFAULT_DANMAKU_SOURCE;
}

export const SOURCE_LABELS = Object.freeze({
  official: '时间轴弹幕',
  comments: '本集评论',
});

// 一道弹幕占满整屏所需的时间由宽度和速度决定；这里只约束"同一道里前后两条
// 至少要留出的水平间距"，避免后发的弹幕追尾前面那条。
const LANE_HEAD_GAP = 24;

// 单帧最多消费多少条待发弹幕，防止一次性涌入（例如长时间卡顿后恢复）把画面糊住。
const MAX_EMIT_PER_FRAME = 4;

// 时间轴控制出场时机；密度控制突发时的最小间隔，不限制为固定几行。
const EMIT_INTERVAL = Object.freeze({ sparse: 0.4, normal: 0.15, dense: 0.05 });

/** 严重迟到的弹幕直接丢弃：它们在时间轴上已经过去了，补发只会突兀。 */
const STALE_SECONDS = 5;

/**
 * 减少动态效果模式下每条弹幕的展示时长。
 *
 * 这个模式一次只轮播一条，所以吞吐量天生比滚动模式低一个量级。迟到阈值必须跟着
 * 放宽到同一个量级 —— 否则排队中的弹幕会在还没轮到时就全部被判"迟到"丢掉，
 * 结果是开了减少动态效果几乎看不到弹幕。
 */
const REDUCED_MOTION_READ_SECONDS = 6;

/**
 * 认定"用户跳转了进度"的条件。
 *
 * 正常播放时 `currentTime` 的增量约等于本帧的媒体时间增量；一旦出现负数增量
 * 或远超增量的正跳变，就只能是 seek。这个判断只决定要不要重建后续投放光标，
 * 判错会导致快进后把中间整段弹幕一次性倒到屏幕上。
 */
function isSeek(lastTime, currentTime, elapsed) {
  if (lastTime === undefined) return true;
  const jump = currentTime - lastTime;
  if (jump < 0) return true;
  return jump > elapsed * 3 + 1;
}

/** 找到第一条 time >= currentTime 的下标（列表按 time 升序）。 */
export function lowerBoundTime(list, currentTime) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].time < currentTime) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function createOfficialFeed(seriesId, vid) {
  return {
    source: 'official',
    seriesId: String(seriesId ?? ''),
    vid: String(vid ?? ''),
    danmaku: [],
    loaded: false,
    loading: false,
    error: '',
    notice: '',
    truncated: false,
    partial: false,
    // 动画状态与评论滚动条同名（items/nextId/cooldown），便于渲染层复用同一套
    // 绘制与设置变更处理。
    animation: { items: [], nextId: 0, cursor: 0, cooldown: 0, lastTime: undefined },
  };
}

/**
 * 写入一页官方弹幕结果。
 *
 * 上游接口每次返回的是当次抓到的子集（实测同一集在几十秒内会给出 71~104 条
 * 不同结果），因此这里只做合并与排序，**不把 `hasMore` 之类当作"已全部加载"**；
 * 状态文案统一由 `resolveDanmakuStatus` 决定。
 */
export function appendOfficialPage(feed, data) {
  if (!data || typeof data !== 'object' || typeof data.success !== 'boolean' || !Array.isArray(data.items)) throw new Error('Invalid official danmaku page');
  if (String(data.series_id) !== feed.seriesId || String(data.episode_id) !== feed.vid) {
    throw new Error('Invalid official danmaku page');
  }
  const incoming = Array.isArray(data.items) ? data.items : [];
  const seen = new Set(feed.danmaku.map(item => `${item.time.toFixed(3)}|${item.text}`));
  for (const item of incoming) {
    if (!item || typeof item.text !== 'string' || !Number.isFinite(item.time)) continue;
    const key = `${item.time.toFixed(3)}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    feed.danmaku.push(item);
  }
  feed.danmaku.sort((a, b) => a.time - b.time);
  feed.groupedDanmaku = groupDanmaku(feed.danmaku);
  feed.loaded = true;
  feed.truncated = data.truncated === true;
  feed.partial = data.partial === true;
  feed.notice = (typeof data.notice === 'string' ? data.notice : '') || (feed.partial ? '仅取得部分弹幕，可重试加载' : feed.truncated ? '已达到本次读取限制，仅展示部分弹幕' : '');
  feed.animation.lastTime = undefined;
  feed.error = data.success === false ? (typeof data.error === 'string' && data.error ? data.error : '弹幕加载失败') : '';
  return feed;
}

/**
 * 按视频时间投放弹幕，并推进已在屏上的弹幕。
 *
 * @param {object} state    `feed.animation`
 * @param {Array}  danmaku  按 time 升序的弹幕列表
 * @param {number} currentTime 视频当前播放位置（秒）
 * @param {number} elapsed  本帧推进的**媒体**时间（秒，已乘倍速）
 * @param {object} options  `{ width, height, settings, reducedMotion, bottomInset }`
 * @returns {boolean} 是否需要重绘
 */
export function advanceTimedDanmaku(state, danmaku, currentTime, elapsed, options) {
  const { width, height, settings, reducedMotion } = options;
  if (!(width >= 40) || !(height >= 60)) return false;
  const list = Array.isArray(danmaku) ? danmaku : [];
  const delta = Math.min(Math.max(elapsed, 0), 0.25);
  let changed = false;

  const emitting = options.emitting !== false;
  if (emitting && isSeek(state.lastTime, currentTime, elapsed)) {
    // Reposition future comments without erasing comments already crossing the screen.
    state.cursor = lowerBoundTime(list, currentTime);
    state.cooldown = 0;
    // A resumed or re-enabled sparse feed has no retired comments from this session.
    if (!reducedMotion && !state.items.length && !state.replayQueue?.length) {
      state.replayQueue = [];
      for (let index = state.cursor - 1; index >= 0 && state.replayQueue.length < 6; index--) {
        const entry = list[index];
        if (!commentIsBlocked(entry.text, settings) && !state.replayQueue.some(item => item.content === entry.text)) {
          state.replayQueue.push({ entry, content: entry.text });
        }
      }
    }
  }
  if (emitting) state.lastTime = currentTime;

  const before = state.items.length;
  for (const item of state.items) {
    item.age += delta;
    if (!reducedMotion) item.x -= 85 * settings.speed * delta;
  }
  retireDanmaku(state, reducedMotion);
  if (state.items.length !== before) changed = true;
  state.cooldown = Math.max(0, state.cooldown - delta);

  const { top, lineHeight, lanes } = danmakuLayout(options);

  const laneFree = index => {
    const occupants = state.items.filter(item => item.lane === index);
    if (!occupants.length) return true;
    // 允许同一道里多发：只要最后一条已经走出足够距离，新的一条就不会追尾。
    // 上游评论滚动条用的是"这道有人就占着"，对真弹幕（一集上百条）会严重丢量。
    const newest = occupants.reduce((a, b) => (a.x > b.x ? a : b));
    return newest.x + newest.width + LANE_HEAD_GAP <= width;
  };

  let emitted = 0;
  const staleAfter = reducedMotion ? REDUCED_MOTION_READ_SECONDS : STALE_SECONDS;
  while (emitting && emitted < MAX_EMIT_PER_FRAME) {
    let entry = list[state.cursor];
    const timed = entry && entry.time <= currentTime;
    const stale = timed && currentTime - entry.time > staleAfter;
    const blocked = timed && commentIsBlocked(entry.text, settings);
    const visible = timed && state.items.some(item => item.entry === entry || entry.count && item.content === entry.text && item.entry?.time === entry.time);
    if (blocked || stale || visible) {
      state.cursor++;
      continue;
    }
    if (state.cooldown > 0) break;

    const candidates = Array.from({ length: lanes }, (_, index) => index);
    // 先复用已有行的安全空位，放不下再扩行，避免短弹幕被摊成整屏横向空档。
    const lane = candidates.find(laneFree);
    if (lane === undefined) break; // 保留 cursor，下一帧再试
    if (!timed) {
      if (!(delta > 0) || !list.length) break;
      // Nearby fresh supply takes priority; only quiet stretches need retired comments.
      const pending = lowerBoundTime(list, currentTime + 2) - state.cursor;
      entry = takeDanmakuReplay(state, options, Math.max(0, pending), currentTime)?.entry;
      if (!entry) break;
      entry = list.find(item => item.time === entry.time && item.text === entry.text) || entry;
    }

    const text = danmakuText(entry.text, entry.count);
    const textWidth = (Array.from(text).length + 1) * settings.fontSize;
    state.items.push({
      id: state.nextId++,
      text,
      content: entry.text,
      entry,
      color: entry.color,
      mode: entry.mode,
      lane,
      x: reducedMotion ? 12 : width,
      y: top + lane * lineHeight,
      width: textWidth,
      age: 0,
    });
    state.cooldown = reducedMotion ? REDUCED_MOTION_READ_SECONDS : (EMIT_INTERVAL[settings.density] ?? EMIT_INTERVAL.normal);
    if (timed) state.cursor++;
    emitted++;
    changed = true;
  }

  return changed;
}

/**
 * 唯一的结束状态出口。
 *
 * 官方弹幕有好几条失败路径（超时、HTTP 错误、部分成功、缓存命中失败结果）。
 * 只要有一条路径自己拼状态文案，就会出现"源坏了却显示本集没有弹幕"这类事故。
 * 因此所有路径都必须调用这里，不在别处拼字符串。
 */
export function resolveDanmakuStatus({ source, supported, enabled, active, visible, error, loading, notice, loaded, count }) {
  if (!supported) return source === 'official' ? '仅红果来源的剧集支持弹幕' : '仅红果来源的当前集支持评论弹幕';
  if (!enabled) return source === 'official' ? '开启后按视频时间展示时间轴弹幕' : '开启后展示本集公开评论';
  if (!active) return source === 'official' ? '播放本集后显示弹幕' : '播放本集后显示评论弹幕';
  if (!visible) return '';
  // 失败优先于一切：宁可说"没取到"，也不能说成"没有弹幕"
  if (error) return error;
  if (loading) return '正在加载弹幕…';
  if (notice && !count) return notice;
  if (!loaded) return '正在加载弹幕…';
  if (!count) return notice || '本集暂无弹幕';
  return `已载入 ${count} 条弹幕${notice ? `（${notice}）` : ''}`;
}
