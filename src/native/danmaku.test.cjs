// Adapted from dawei233/hongguo-drama (GPL-3.0), commit c884fab6c6e36ad38173e251738b9b35f958383f.
// https://github.com/dawei233/hongguo-drama/tree/c884fab6c6e36ad38173e251738b9b35f958383f
'use strict';

/**
 * 官方弹幕抓取层测试。全部离线：传输层是注入的假实现，不打网络。
 *
 * 这里最要紧的一组断言是"失败语义"：源不可用与"本集真的没有弹幕"是两件事，
 * 任何情况下都不能互相冒充 —— 包括缓存命中的路径。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let danmaku;
try { danmaku = require('./danmaku.js'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
assert.equal(typeof danmaku, 'object', 'danmaku module must exist');

const SERIES = '7503745441910017049';
const VID = '7503780574541122622';

const comment = (overrides = {}) => ({
  comment: {
    common: { group_id: VID, status: '1', content: { text: '好家伙' }, ...(overrides.common || {}) },
    expand: { offset_time: 1200, ...(overrides.expand || {}) },
    ...(overrides.comment || {}),
  },
});

const page = ({ rows = [], extra, info } = {}) => ({
  code: 0,
  data: {
    data_list: rows,
    ...(extra ? { extra } : {}),
    ...(info ? { common_list_info: info } : {}),
  },
});

/** 固定时钟与 nonce，让测试完全确定。 */
const fixedOptions = transport => ({
  transport,
  now: () => 1760000000000,
  random: () => Buffer.from('000102030405060708090a', 'hex'),
});

test.beforeEach(() => {
  danmaku.setDeviceIdentityFile?.(null);
  danmaku.resetDanmakuCache();
  danmaku.setDeviceIdentity({ deviceId: '1000000000000000001', installId: '1000000000000000002' });
});

test('重启后复用本机匿名标识，避免上游重新分配少量弹幕子集', async t => {
  assert.equal(typeof danmaku.setDeviceIdentityFile, 'function');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-client-'));
  const file = path.join(folder, 'client.json');
  const requests = [];
  const logs = [];
  for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args.map(String).join(' ')));
  const transport = async url => {
    const query = new URL(url).searchParams;
    requests.push([query.get('device_id'), query.get('iid')]);
    return { data: JSON.stringify(page({ rows: [comment()] })) };
  };
  try {
    for (let restart = 0; restart < 2; restart++) {
      danmaku.resetDanmakuCache();
      danmaku.setDeviceIdentityFile(file);
      assert.equal((await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) })).success, true);
    }
    assert.ok(requests[0].every((value, i) => value === requests[1][i]), '重启不能更换匿名标识');
    assert.ok(fs.statSync(file).isFile());
    assert.ok(logs.every(line => requests[0].every(value => !line.includes(value))), '日志不得包含本机匿名标识');
    // Windows does not expose POSIX permission bits through stat/chmod.
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { danmaku.setDeviceIdentityFile(null); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('本机标识损坏时保留文件并报告配置问题，不静默重新生成', async () => {
  assert.equal(typeof danmaku.setDeviceIdentityFile, 'function');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-client-'));
  const file = path.join(folder, 'client.json');
  fs.writeFileSync(file, '{broken', { mode: 0o600 });
  let calls = 0;
  try {
    danmaku.setDeviceIdentityFile(file);
    const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(async () => { calls++; }) });
    assert.equal(result.success, false);
    assert.match(result.error, /本机配置/);
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { danmaku.setDeviceIdentityFile(null); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('非红果编号直接拒绝，且不打网络', async () => {
  let calls = 0;
  const result = await danmaku.fetchDanmaku({ seriesId: 'hema:123', vid: '1', ...fixedOptions(async () => { calls++; }) });
  assert.equal(result.success, false);
  assert.equal(calls, 0);
  assert.match(result.error, /仅红果来源/);
});

test('把毫秒偏移换算成秒，并按时间升序返回', async () => {
  const transport = async () => ({
    data: JSON.stringify(page({ rows: [comment({ expand: { offset_time: 3000 } }), comment({ expand: { offset_time: 1000 } }), comment({ expand: { offset_time: 2000 } })] })),
  });
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(result.success, true);
  assert.deepEqual(result.items.map(item => item.time), [1, 2, 3]);
  assert.equal(result.items[0].text, '好家伙');
  assert.equal(result.items[0].mode, 'scroll');
});

test('分页信号之一：extra.next_query_danmaku_list_time 推进游标', async () => {
  const calls = [];
  const transport = async (url, body) => {
    calls.push(JSON.parse(body).business_param.start_offset_time);
    return calls.length === 1
      ? { data: JSON.stringify(page({ rows: [comment({ expand: { offset_time: 1000 } })], extra: { next_query_danmaku_list_time: 5000 } })) }
      : { data: JSON.stringify(page({ rows: [comment({ expand: { offset_time: 6000 }, common: { content: { text: '第二页' } } })] })) };
  };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.deepEqual(calls, [0, 5000]);
  assert.deepEqual(result.items.map(item => item.text), ['好家伙', '第二页']);
});

test('分页信号之二：common_list_info 的 has_more 与 cursor 同样能推进（extra 为空时唯一来源）', async () => {
  const calls = [];
  const transport = async (url, body) => {
    calls.push(JSON.parse(body).business_param.start_offset_time);
    return calls.length === 1
      ? { data: JSON.stringify(page({ rows: [comment()], info: { has_more: true, cursor: { end_offset_time: 9000 } } })) }
      : { data: JSON.stringify(page({ rows: [comment({ expand: { offset_time: 9000 }, common: { content: { text: '末页' } } })] })) };
  };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.deepEqual(calls, [0, 9000]);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].text, '末页');
});

test('has_more=false 时即便带 cursor 也必须停止（避免把"没有了"翻成多页空转）', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return { data: JSON.stringify(page({ rows: [comment()], info: { has_more: false, cursor: { end_offset_time: 900000 } } })) };
  };
  await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(calls, 1);
});

test('连续空页提前停止，不会把整集翻满', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    // 一直声称"还有更多"，但一页都不给 —— 参考实现实测遇到过的上游行为
    return { data: JSON.stringify(page({ rows: [], extra: { next_query_danmaku_list_time: calls * 100000 } })) };
  };
  await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.ok(calls <= 4, `连续空页应尽快停止，实际请求 ${calls} 次`);
});

test('丢掉脏数据：非本视频、非正常状态、超长文本', async () => {
  const transport = async () => ({ data: JSON.stringify(page({ rows: [
    comment({ common: { group_id: '999' } }),
    comment({ common: { status: '2' } }),
    comment({ common: { content: { text: 'x'.repeat(300) } } }),
    comment({ common: { content: { text: '这条要留下' } } }),
  ] })) });
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.deepEqual(result.items.map(item => item.text), ['这条要留下']);
});

test('控制字符被清洗，且按（时间, 文本）去重', async () => {
  const transport = async () => ({ data: JSON.stringify(page({ rows: [
    comment({ common: { content: { text: '前\u0000后' } } }),
    comment({ common: { content: { text: '前 后' } } }),
  ] })) });
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, '前 后');
});

test('颜色归一：数字、0x 前缀与非法值', () => {
  assert.equal(danmaku.normalizeColor(16711680), '#FF0000');
  assert.equal(danmaku.normalizeColor('0xFF0000'), '#FF0000');
  assert.equal(danmaku.normalizeColor('#00ff00'), '#00FF00');
  assert.equal(danmaku.normalizeColor('乱七八糟'), '#FFFFFF');
  assert.equal(danmaku.normalizeColor(-1), '#FFFFFF');
  assert.equal(danmaku.normalizeColor(undefined), '#FFFFFF');
});

test('越界时间被丢弃（负数或超过 7 天）', () => {
  assert.equal(danmaku.toSeconds(-1), null);
  assert.equal(danmaku.toSeconds(999999999999), null);
  assert.equal(danmaku.toSeconds(1500), 1.5);
  assert.equal(danmaku.toSeconds(true), null);
});

test('成功结果进缓存：第二次调用不打网络', async () => {
  let calls = 0;
  const transport = async () => { calls++; return { data: JSON.stringify(page({ rows: [comment()] })) }; };
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(transport) };
  await danmaku.fetchDanmaku(options);
  await danmaku.fetchDanmaku(options);
  assert.equal(calls, 1);
});

test('并发调用合并在途请求（只打一次上游）', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { data: JSON.stringify(page({ rows: [comment()] })) };
  };
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(transport) };
  const [first, second] = await Promise.all([danmaku.fetchDanmaku(options), danmaku.fetchDanmaku(options)]);
  assert.equal(calls, 1);
  assert.equal(first.items.length, 1);
  assert.deepEqual(second.items, first.items);
});

test('源不可用时给出人话说明，绝不改口成"本集暂无弹幕"', async () => {
  const transport = async () => { const error = new Error('boom'); error.response = { status: 502 }; throw error; };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(result.success, false);
  assert.equal(result.items.length, 0);
  assert.match(result.notice, /HTTP 502/);
  assert.match(result.notice, /已尝试官方签名请求/);
  assert.doesNotMatch(result.notice, /暂无弹幕/);
});

test('失败结果命中缓存时，仍然如实报告失败（回归：曾被洗成"本集暂无弹幕"）', async () => {
  let calls = 0;
  const transport = async () => { calls++; const error = new Error('boom'); error.response = { status: 502 }; throw error; };
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(transport) };
  const first = await danmaku.fetchDanmaku(options);
  const second = await danmaku.fetchDanmaku(options);
  assert.equal(calls, 1, '失败结果应命中短 TTL 缓存');
  assert.equal(second.success, false);
  assert.equal(second.notice, first.notice);
  assert.doesNotMatch(second.notice, /暂无弹幕/);
});

test('部分成功后中断：保留已获取的弹幕，并注明中断', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    if (calls === 1) return { data: JSON.stringify(page({ rows: [comment()], extra: { next_query_danmaku_list_time: 5000 } })) };
    const error = new Error('net');
    throw error;
  };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(result.items.length, 1);
  assert.equal(result.partial, true);
  assert.match(result.notice, /后续弹幕加载中断/);
});

test('limit 只裁剪条数，不改变失败说明', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    if (calls === 1) {
      return { data: JSON.stringify(page({ rows: [1, 2, 3].map(index => comment({ expand: { offset_time: index * 1000 }, common: { content: { text: `第${index}条` } } })), extra: { next_query_danmaku_list_time: 9000 } })) };
    }
    throw new Error('net');
  };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, limit: 2, ...fixedOptions(transport) });
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
  assert.match(result.notice, /后续弹幕加载中断/);
});

test('请求体与签名头符合接口契约', async () => {
  let captured;
  const transport = async (url, body, config) => {
    captured = { url, body: JSON.parse(body), headers: config.headers };
    return { data: JSON.stringify(page({ rows: [] })) };
  };
  await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.match(captured.url, /^https:\/\/api5-normal-sinfonlineb\.fqnovel\.com\/novel\/commentapi\/comment\/list\/\d+\/v1\/\?/);
  assert.equal(captured.body.group_id, VID);
  assert.equal(captured.body.business_param.book_id, SERIES);
  assert.equal(captured.body.comment_source, 601);
  assert.equal(captured.body.group_type, 30);
  assert.equal(captured.body.comment_type, 20);
  assert.ok(captured.headers['X-Gorgon'] && captured.headers['X-Argus'] && captured.headers['X-Ladon']);
  assert.equal(captured.headers['X-SS-STUB'], '');
  assert.equal(captured.headers['Comment-Source'], '601');
});


test('拒绝无效 options、非字符串编号和无效 limit，不发起请求', async () => {
  for (const options of [null, [], 'x', 1, {}, { seriesId: Number(SERIES), vid: VID },
    { seriesId: SERIES, vid: VID, limit: 0 }, { seriesId: SERIES, vid: VID, limit: 3001 },
    { seriesId: SERIES, vid: VID, limit: '2' }, { seriesId: SERIES, vid: VID, fresh: 'true' }]) {
    const result = await danmaku.fetchDanmaku(options);
    assert.equal(result.success, false);
    assert.equal(result.source, 'official');
    assert.deepEqual(result.items, []);
  }
});

test('无效响应和错误不暴露请求签名，也不能伪装成没有弹幕', async () => {
  for (const data of ['null', '{}', JSON.stringify({code: 0, data: {}}), JSON.stringify({code: 'private-signature', data: {data_list: []}}), 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    danmaku.resetDanmakuCache();
    const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(async () => ({ data })) });
    assert.equal(result.success, false);
    assert.doesNotMatch(result.notice, /暂无弹幕|private-signature/);
  }
  danmaku.resetDanmakuCache();
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(async () => { throw new Error('https://private?device_id=secret&signature=secret'); }) });
  assert.doesNotMatch(result.notice, /device_id|signature|secret/);
});

test('请求有超时、响应上限和禁止重定向，并复用环境代理', async () => {
  await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(async (_url, _body, config) => {
    assert.equal(config.maxRedirects, 0);
    assert.equal(config.timeout, 20000);
    assert.ok(config.signal instanceof AbortSignal);
    assert.equal(config.maxContentLength, 8 * 1024 * 1024);
    assert.equal(config.proxy, undefined);
    assert.equal(config.headers.Cookie, undefined);
    return { data: JSON.stringify(page()) };
  }) });
});

test('刷新绕过失败缓存；limit 不污染缓存且分集隔离', async () => {
  let calls = 0;
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    return { data: JSON.stringify(page({ rows: [comment(), comment({ expand: {offset_time: 2000} })] })) };
  }) };
  assert.equal((await danmaku.fetchDanmaku(options)).success, false);
  assert.equal((await danmaku.fetchDanmaku({ ...options, fresh: true, limit: 1 })).items.length, 1);
  assert.equal((await danmaku.fetchDanmaku(options)).items.length, 2);
  assert.equal(calls, 2);
  const other = await danmaku.fetchDanmaku({ ...options, vid: '7503780577347128382' });
  assert.equal(calls, 3);
  assert.equal(other.items.length, 0);
});

test('最多保存3000条，单页超量也不越界', async () => {
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(async () => ({
    data: JSON.stringify(page({ rows: Array.from({ length: 3005 }, (_, i) => comment({expand: { offset_time: i * 1000 }})) }))
  })) });
  assert.equal(result.items.length, 3000);
  assert.equal(result.total, 3000);
  assert.equal(result.truncated, true);
});

test('重复游标、空页和分页上限标注截断，不谎称全部载入', async () => {
  let calls = 0;
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(async () => {
    calls++;
    return { data: JSON.stringify(page({rows: [comment()], info: {has_more: true, cursor: {end_offset_time: 1000}}})) };
  }) });
  assert.equal(calls, 2);
  assert.equal(result.truncated, true);
  danmaku.resetDanmakuCache();
  const empty = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(async () => ({data: JSON.stringify(page({info:{has_more:true}}))})) });
  assert.equal(empty.success, false);
  assert.doesNotMatch(empty.notice, /暂无弹幕|前 0 条/);
  danmaku.resetDanmakuCache();
  calls = 0;
  const capped = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(async () => {
    calls++;
    return {data: JSON.stringify(page({rows:[comment({expand:{offset_time:calls * 1000}})], info:{has_more:true, cursor:{end_offset_time:calls * 1000}}}))};
  }) });
  assert.equal(calls, 40);
  assert.equal(capped.truncated, true);
});

test('颜色与时间严格过滤，不将非法值变成合法时间轴数据', () => {
  for (const color of ['#GGG', '#<bad>', '0xffno', '12oops']) assert.equal(danmaku.normalizeColor(color), '#FFFFFF');
  assert.equal(danmaku.normalizeColor('#abc'), '#AABBCC');
  for (const time of [[], {}, '  ', '0x10']) assert.equal(danmaku.toSeconds(time), null);
});

test('主进程与预加载桥接接入受信任 IPC，且不接受测试注入', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../../preload.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('get-episode-danmaku'/);
  assert.match(main, /fetchDanmaku\(\{ seriesId, vid, fresh, limit \}\)/);
  assert.match(main, /rendererSecurity\.isTrustedSender\(event, mainWindow\)/);
  assert.match(preload, /getEpisodeDanmaku: options => ipcRenderer\.invoke\('get-episode-danmaku', options\)/);
});

const flushCancellation = () => new Promise(resolve => setImmediate(resolve));
const responsePage = () => ({ data: JSON.stringify(page({ rows: [comment()] })) });

test('预取消先于缓存、身份、签名和实际窗口请求；无效signal安全拒绝', async () => {
  let calls = 0;
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(async () => { calls++; return responsePage(); }) };
  await danmaku.fetchDanmaku(options);
  const controller = new AbortController(); controller.abort();
  const result = await danmaku.fetchDanmaku({ ...options, signal: controller.signal });
  assert.equal(result.success, false); assert.match(result.notice, /取消/); assert.equal(calls, 1);
  danmaku.resetDanmakuCache(); danmaku.setDeviceIdentityFile('/not-used/danmaku.identity');
  const cancelled = await danmaku.fetchDanmaku({ ...options, signal: controller.signal, now: () => { throw Error('must not sign'); } });
  assert.match(cancelled.notice, /取消/); assert.equal(calls, 1);
  await assert.rejects(danmaku.requestWindow({ vid: VID, bookId: SERIES, signal: controller.signal,
    now: () => { throw Error('must not sign'); } }), { code: 'ERR_CANCELED' });
  for (const signal of [null, {}, { aborted: false }, true]) {
    const invalid = await danmaku.fetchDanmaku({ ...options, signal });
    assert.equal(invalid.success, false); assert.match(invalid.notice, /参数无效/);
  }
});

test('调用方abort传到真实transport signal，清监听且取消不污染缓存', async t => {
  const controller = new AbortController(), listeners = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  t.mock.method(controller.signal, 'addEventListener', (name, fn, options) => { listeners.add(fn); add(name, fn, options); });
  t.mock.method(controller.signal, 'removeEventListener', (name, fn) => { listeners.delete(fn); remove(name, fn); });
  let actual, calls = 0;
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions((_url, _body, config) => {
    calls++; actual = config.signal;
    return new Promise((resolve, reject) => actual.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {code:'ERR_CANCELED'})), {once:true}));
  }) };
  const pending = danmaku.fetchDanmaku({ ...options, signal: controller.signal });
  assert.equal(actual.aborted, false); controller.abort();
  assert.equal(actual.aborted, true); assert.match((await pending).notice, /取消/); assert.equal(listeners.size, 0);
  const retry = await danmaku.fetchDanmaku({ ...options, transport: async () => { calls++; return responsePage(); } });
  assert.equal(retry.success, true); assert.equal(calls, 2);
});

test('分页间隔可取消；取消后不发第二页，不缓存已取部分', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); let calls = 0;
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(async () => {
    calls++; return { data: JSON.stringify(page({ rows: [comment()], extra: { next_query_danmaku_list_time: 5000 } })) };
  }) };
  const pending = danmaku.fetchDanmaku({ ...options, signal: controller.signal });
  await flushCancellation(); controller.abort();
  const result = await pending;
  assert.equal(result.success, false); assert.deepEqual(result.items, []); assert.match(result.notice, /取消/);
  t.mock.timers.tick(50000); assert.equal(calls, 1);
  const retry = await danmaku.fetchDanmaku({ ...options, transport: async () => { calls++; return responsePage(); } });
  assert.equal(retry.success, true); assert.equal(calls, 2);
});

test('忽略abort的迟到成功不解析、不翻页、不覆盖新缓存', async () => {
  const controller = new AbortController(); let release;
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(() => new Promise(resolve => { release = resolve; })) };
  const old = danmaku.fetchDanmaku({ ...options, signal: controller.signal }); controller.abort();
  const fresh = await danmaku.fetchDanmaku({ ...options, fresh: true, transport: async () => responsePage() });
  let parsed = false;
  release({ get data() { parsed = true; throw Error('late body must not be parsed'); } });
  assert.match((await old).notice, /取消/); assert.equal(parsed, false);
  const hit = await danmaku.fetchDanmaku({ ...options, transport: () => { throw Error('must hit newer cache'); } });
  assert.deepEqual(hit, fresh);
});

test('带signal独立在途与取消；无signal仍合并，独立finally不删共享pending', async () => {
  let sharedRelease, firstRelease, secondRelease, calls = 0;
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(() => { calls++; return new Promise(resolve => { sharedRelease = resolve; }); }) };
  const shared = danmaku.fetchDanmaku(options);
  const a = new AbortController(), b = new AbortController();
  const first = danmaku.fetchDanmaku({ ...options, signal: a.signal, transport: () => { calls++; return new Promise(resolve => { firstRelease = resolve; }); } });
  const second = danmaku.fetchDanmaku({ ...options, signal: b.signal, transport: () => { calls++; return new Promise(resolve => { secondRelease = resolve; }); } });
  assert.equal(calls, 3); a.abort(); firstRelease(responsePage()); assert.match((await first).notice, /取消/);
  const joined = danmaku.fetchDanmaku(options); assert.equal(calls, 3);
  assert.equal(b.signal.aborted, false); secondRelease(responsePage()); assert.equal((await second).success, true);
  sharedRelease(responsePage()); assert.deepEqual(await joined, await shared); assert.equal(calls, 3);
});

test('成功窗口移除调用方监听；内部20秒超时仍中止transport且不是调用方取消', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); let signal;
  await danmaku.requestWindow({ vid: VID, bookId: SERIES, signal: controller.signal, ...fixedOptions(async (_url, _body, config) => {
    signal = config.signal; return responsePage();
  }) });
  controller.abort(); t.mock.timers.tick(20000); assert.equal(signal.aborted, false, 'completed window listener/timer must be gone');
  const active = new AbortController();
  const task = danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, signal: active.signal, ...fixedOptions((_url, _body, config) =>
    new Promise((resolve, reject) => config.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), {code:'ERR_CANCELED'})), {once:true}))) });
  t.mock.timers.tick(20000);
  const result = await task; assert.equal(active.signal.aborted, false); assert.match(result.notice, /超时/); assert.doesNotMatch(result.notice, /暂无弹幕|已取消/);
});

test('T4-R1：完成任务写缓存后、外层await交接前取消返回安全结果并保留好缓存', async () => {
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const controller = new AbortController();
  let writes = 0, calls = 0;
  class HandoffMap extends Map {
    set(key, value) {
      super.set(key, value);
      if (key === `${SERIES}:${VID}` && value?.result?.success === true) {
        writes++;
        // Put abort ahead of the outer await continuation, after the good cache is complete.
        queueMicrotask(() => controller.abort());
      }
      return this;
    }
  }
  const module = { exports: {} }, file = path.join(__dirname, 'danmaku.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, require: createRequire(file), Buffer, Map: HandoffMap,
    AbortController, setTimeout, clearTimeout,
  }, { filename: file });
  const api = module.exports;
  api.setDeviceIdentity({ deviceId: '1000000000000000001', installId: '1000000000000000002' });
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(async () => { calls++; return responsePage(); }) };
  const result = await api.fetchDanmaku({ ...options, signal: controller.signal });
  assert.equal(writes, 1); assert.equal(controller.signal.aborted, true);
  assert.equal(result.success, false); assert.equal(result.items.length, 0);
  assert.match(result.notice, /已取消/); assert.doesNotMatch(result.notice, /超时|暂无弹幕/);
  const cached = await api.fetchDanmaku(options);
  assert.equal(cached.success, true); assert.equal(cached.items.length, 1);
  assert.equal(calls, 1); assert.equal(writes, 1);
});
