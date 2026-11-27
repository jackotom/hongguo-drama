import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { formatMessage } from '../../i18n/translator.mjs';

// SeriesDrawer 是账号页复用的分集抽屉。这里用最小的 React 桩渲染，
// 验证它只依赖通用 IPC、默认选集策略正确、区间解析不越界。

const i18n = { t: formatMessage, useLanguage: () => 'zh-CN:zh-CN', getLanguage: () => 'zh-CN' };
const code = transformSync(
  fs.readFileSync(new URL('../SeriesDrawer.jsx', import.meta.url), 'utf8'),
  { loader: 'jsx', format: 'cjs' },
).code;
const tick = () => new Promise(resolve => setImmediate(resolve));

function mount(api, props = {}) {
  let cursor = 0;
  const slots = [];
  const effects = [];
  let tree;
  const react = {
    createElement: (type, attrs, ...children) => ({ type, props: attrs || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }];
    },
    useRef(initial) { const at = cursor++; return (slots[at] ||= { current: initial }); },
    useEffect(effect, deps) {
      const at = cursor++;
      const previous = slots[at];
      if (!previous || !deps || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        slots[at] = { deps };
        effects.push(() => { slots[at].cleanup = effect(); });
      }
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: id => (id === '../i18n' ? i18n : id === './icons' ? { Play: 'Play', Download: 'Download', Check: 'Check', X: 'X' } : react),
    window: { electronAPI: api, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout },
    process: { env: {} },
    console,
  });
  // 渲染：先渲染树，再执行挂起 effect（effect 内会 setState），
  // 然后必然再渲染一次以反映新 state。最小桩没有调度器，这一步要手动做。
  const paint = () => {
    cursor = 0;
    tree = module.exports.default({ seriesId: '7700000000000000001', seriesTitle: 'Fixture', onClose() {}, onToast() {}, ...props });
  };
  const render = async () => {
    paint();                                   // 首帧：触发 effect 注册
    const pending = effects.splice(0);
    for (const run of pending) run();          // 执行 effect（含 setState）
    await tick();                              // 等异步 IPC resolve
    paint();                                   // 按最新 state 重绘
    // 异步回来后可能又注册了新 effect（如再次 load），再收一轮。
    const more = effects.splice(0);
    if (more.length) {
      for (const run of more) run();
      await tick();
      paint();
    }
  };
  const collect = (predicate, found = []) => {
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (predicate(node)) found.push(node);
      node.children?.forEach(visit);
    };
    visit(tree);
    return found;
  };
  const buttons = () => collect(node => node.type === 'button');
  return { render, paint, collect, buttons, slots, module };
}

const episodes = [
  { vid_index: 1, locked: false },
  { vid_index: 2, locked: false },
  { vid_index: 3, locked: true },
  { vid_index: 4, locked: false },
];

function apiWith(overrides = {}) {
  const calls = [];
  return {
    calls,
    searchResolve: async seriesId => { calls.push(['resolve', seriesId]); return { success: true, data: { series_id: seriesId, series_title: 'Fixture', episodes } }; },
    getSeriesEpisodes: async seriesId => { calls.push(['episodes', seriesId]); return { success: true, data: { episodes: [{ vid_index: 1, status: 'completed' }] } }; },
    playSeries: async payload => { calls.push(['play', payload]); return { success: true }; },
    hongguoDownloadBatch: async payload => { calls.push(['batch', payload]); return { success: true, count: payload.episodes.length }; },
    ...overrides,
  };
}

test('抽屉只调用通用 IPC，且先解析分集再读下载状态', async () => {
  const api = apiWith();
  const view = mount(api);
  await view.render();
  const names = api.calls.map(call => call[0]);
  assert.deepEqual(names, ['resolve', 'episodes']);
  assert.equal(api.calls[0][1], '7700000000000000001');
});

test('默认选集跳过已下载与锁定集', async () => {
  const api = apiWith();
  const view = mount(api);
  await view.render();
  // slots[3] 是 selected（Set）
  const selected = [...view.slots[3]];
  assert.deepEqual(selected.sort((a, b) => a - b), [2, 4], '第 1 集已下载、第 3 集锁定，都应排除');
});

test('批量下载只提交选中的未锁定分集', async () => {
  const api = apiWith();
  const view = mount(api);
  await view.render();
  // 文件尾部的下载按钮是唯一同时含 btn 与 btn-primary 的按钮。
  const buttons = view.buttons().filter(button => /\bbtn-primary\b/.test(button.props?.className || ''));
  assert.equal(buttons.length, 1, '应只有一个下载按钮');
  await buttons[0].props.onClick();
  const batch = api.calls.find(call => call[0] === 'batch');
  assert.ok(batch, '必须调用 hongguoDownloadBatch');
  const indexes = batch[1].episodes.map(episode => episode.vid_index).sort((a, b) => a - b);
  assert.deepEqual(indexes, [2, 4], '不能提交已下载或锁定的集');
  assert.equal(batch[1].seriesId, '7700000000000000001');
});

test('区间应用只接受未锁定且存在的集数', async () => {
  const api = apiWith();
  const view = mount(api);
  await view.render();
  const input = view.collect(node => node.type === 'input')[0];
  assert.ok(input, '应有区间输入框');
  input.props.onChange({ target: { value: '1-3' } });
  view.paint(); // onChange 只改 state，需重绘后再取按钮（闭包要拿到新值）
  const apply = view.buttons().find(button => (button.children || []).includes('应用'));
  assert.ok(apply, '应有应用按钮');
  apply.props.onClick();
  const selected = [...view.slots[3]];
  // 1 已下载但未锁定，区间内应可选中；3 锁定排除；4 在区间外。
  assert.deepEqual(selected.sort((a, b) => a - b), [1, 2]);
});

test('分集解析失败时给出可重试的错误，不渲染集数格子', async () => {
  const api = apiWith({ searchResolve: async () => ({ success: false, error: '来源暂不可用' }) });
  const view = mount(api);
  await view.render();
  const alert = view.collect(node => /\bsd-error\b/.test(node.props?.className || ''))[0];
  assert.ok(alert, '必须显示错误态');
  const chips = view.collect(node => /\bep-chip\b/.test(node.props?.className || ''));
  assert.equal(chips.length, 0, '失败时不应渲染任何集数格子');
});
