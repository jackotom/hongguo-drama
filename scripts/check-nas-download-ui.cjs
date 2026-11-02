// In-memory renderer checks only: no files, network, native bridge, or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { transformSync } = require('esbuild');

const root = path.join(__dirname, '..');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function mountNas(overrides = {}) {
  const file = path.join(root, 'src/components/NasDownload.jsx');
  assert.ok(fs.existsSync(file), 'NasDownload component is missing');
  const source = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const slots = [], effects = [], cleanups = [], calls = [], listeners = [];
  let cursor = 0, tree, mounted = true, writesAfterUnmount = 0;
  const props = { seriesId: 'A', quality: '1080p', disabled: false, ...overrides.props };
  const api = {
    downloadSeriesToNas: async (seriesId, quality) => {
      calls.push([seriesId, quality]);
      return { success: true, canceled: false, count: 2, copied: 3, warnings: [], directory: '/nas/show' };
    },
    onNasExportDone: callback => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    ...overrides.api,
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useId: () => 'nas-description',
    useState: initial => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {
        if (!mounted) {
          writesAfterUnmount++;
          return;
        }
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      }];
    },
    useRef: initial => {
      const index = cursor++;
      return slots[index] ||= { current: initial };
    },
    useEffect: (fn, deps = []) => {
      const index = cursor++;
      if (!slots[index] || deps.some((value, position) => !Object.is(value, slots[index][position]))) {
        slots[index] = deps;
        effects.push(() => {
          cleanups[index]?.();
          cleanups[index] = fn();
        });
      }
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: name => name === 'react' ? react : name === './icons' ? { Download: () => null } : {},
    window: { electronAPI: api },
  });
  const nodes = () => {
    const result = [];
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      result.push(node);
      node.children?.forEach(walk);
    };
    walk(tree);
    return result;
  };
  const textOf = node => typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : node?.children?.map(textOf).join('') || '';
  const render = () => {
    cursor = 0;
    tree = module.exports.default(props);
    effects.splice(0).forEach(fn => fn());
  };
  const flush = async () => {
    for (let index = 0; index < 12; index++) {
      await Promise.resolve();
      render();
    }
  };
  render();
  return {
    api,
    calls,
    listeners,
    props,
    render,
    flush,
    nodes,
    text: () => textOf(tree),
    button: () => nodes().find(node => node.type === 'button'
      && (textOf(node).includes('下载到 NAS') || node.props['aria-label'] === '下载到 NAS')),
    alert: () => nodes().find(node => node.props.role === 'alert'),
    unmount: () => {
      cleanups.forEach(cleanup => cleanup?.());
      mounted = false;
    },
    writesAfterUnmount: () => writesAfterUnmount,
  };
}

test('NAS folder creation defaults on and can be disabled for an existing series directory', async () => {
  const options = [];
  const ui = mountNas({ api: { downloadSeriesToNas: async (_id, _quality, value) => {
    options.push(value); return { success: true, directory: '/nas/show', warnings: [] };
  } } });
  await ui.button().props.onClick(); await ui.flush();
  assert.equal(options[0].createFolder, true);
  ui.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: false } });
  ui.render();
  await ui.button().props.onClick(); await ui.flush();
  assert.equal(options[1].createFolder, false);
  ui.unmount();
});

test('NAS download UI calls the bridge, reports results, and isolates series changes', async () => {
  const first = deferred();
  const ui = mountNas({ api: { downloadSeriesToNas: async (seriesId, quality) => {
    ui.calls.push([seriesId, quality]);
    return first.promise;
  } } });
  await ui.flush();

  const button = ui.button();
  assert.ok(button, 'NAS action must be visible');
  assert.equal(button.props['aria-label'], '下载到 NAS');
  assert.equal(button.props['aria-describedby'], 'nas-description');
  const description = ui.nodes().find(node => node.props.id === 'nas-description');
  assert.ok(description, 'button description must be addressable by id');
  const descriptionText = description.children.map(node => typeof node === 'string' ? node : node.children || '').flat(Infinity).join('');
  assert.match(descriptionText, /保存整剧封面、简介和 tvshow\.nfo/);
  assert.match(descriptionText, /先挂载 NAS/);
  assert.doesNotMatch(ui.text(), /飞牛/);

  const oldClick = button.props.onClick();
  button.props.onClick();
  ui.render();
  assert.equal(ui.button().props.disabled, true, 'submit must block a duplicate click');
  assert.equal(ui.calls.length, 1, 'a repeated synchronous click must be blocked by a ref');
  ui.props.seriesId = 'B';
  ui.render();
  first.resolve({ success: true, count: 9, copied: 8, warnings: ['旧剧警告'], directory: '/nas/a' });
  await oldClick;
  await ui.flush();
  assert.doesNotMatch(ui.text(), /旧剧警告/, 'old series response must not overwrite new series state');

  ui.api.downloadSeriesToNas = async (seriesId, quality) => {
    ui.calls.push([seriesId, quality]);
    return { success: true, count: 2, copied: 3, warnings: ['剧情简介缺失'], directory: '/nas/b' };
  };
  await ui.button().props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.at(-1), ['B', '1080p']);
  assert.match(ui.text(), /新增 2 集下载/);
  assert.match(ui.text(), /复用 3 集/);
  assert.match(ui.text(), /剧情简介缺失/);

  const raced = deferred();
  ui.api.downloadSeriesToNas = async (seriesId, quality) => {
    ui.calls.push([seriesId, quality]);
    return raced.promise;
  };
  const racedClick = ui.button().props.onClick();
  ui.listeners[0]?.({ seriesId: 'B', vidIndex: 2, success: false, error: '第 2 集复制失败' });
  await ui.flush();
  raced.resolve({ success: true, count: 9, copied: 0, warnings: [] });
  await racedClick;
  await ui.flush();
  assert.match(ui.text(), /第 2 集复制失败/, 'background failure must beat a later successful submit reply');
  assert.doesNotMatch(ui.text(), /新增 9 集下载/);

  ui.api.downloadSeriesToNas = async () => ({ success: false, canceled: true, warnings: [] });
  await ui.button().props.onClick();
  await ui.flush();
  assert.doesNotMatch(ui.text(), /新增 2 集下载|复用 3 集|剧情简介缺失/, 'cancel must leave the status silent');

  ui.api.downloadSeriesToNas = async () => ({ success: false, error: '无法写入 NAS' });
  await ui.button().props.onClick();
  await ui.flush();
  assert.equal(ui.alert()?.children.join(''), '无法写入 NAS');

  ui.props.disabled = true;
  ui.render();
  assert.equal(ui.button().props.disabled, true, 'quality loading must disable the action');

  ui.props.seriesId = 'C';
  ui.render();
  ui.listeners[0]?.({ seriesId: 'B', vidIndex: 3, success: false, error: '第 3 集失败' });
  await ui.flush();
  assert.doesNotMatch(ui.text(), /第 3 集失败/);
  ui.listeners[0]?.({ seriesId: 'C', vidIndex: 4, success: true });
  await ui.flush();
  assert.doesNotMatch(ui.text(), /已加入 NAS 下载|已整理到 NAS/, 'successful per-episode events must stay quiet');
  ui.listeners[0]?.({ seriesId: 'C', vidIndex: 4, success: false, error: '第 4 集失败' });
  await ui.flush();
  assert.match(ui.text(), /第 4 集失败/);
  ui.listeners[0]?.({ seriesId: 'C', vidIndex: 4, success: true });
  await ui.flush();
  assert.match(ui.text(), /第 4 集失败/, 'a later success event must not clear a visible failure');

  const unmountReply = deferred();
  ui.props.disabled = false;
  ui.render();
  let unmountRequested = false;
  ui.api.downloadSeriesToNas = async () => { unmountRequested = true; return unmountReply.promise; };
  const unmountClick = ui.button().props.onClick();
  assert.equal(unmountRequested, true, 'unmount check must start a real pending submission');
  ui.render();
  ui.unmount();
  assert.equal(ui.listeners.length, 0, 'subscription must be released on unmount');
  unmountReply.resolve({ success: true, count: 1, copied: 0, warnings: [] });
  await unmountClick;
  await Promise.resolve();
  assert.equal(ui.writesAfterUnmount(), 0, 'an async reply must not set state after unmount');

  const player = fs.readFileSync(path.join(root, 'src/components/Player.jsx'), 'utf8');
  assert.match(player, /trailingAction=/);
  assert.match(player, /<NasDownload[^>]*quality=\{downloadQuality\}/s);
  assert.match(player, /disabled=\{qualityLoading\}/, 'Player must inherit the quality-loading disabled state');
  const community = fs.readFileSync(path.join(root, 'src/components/CommunityPanel.jsx'), 'utf8');
  assert.match(community, /aria-controls=\{panelId\}[^>]*>.*?<\/button>\s*\{trailingAction &&/s,
    'NAS action must follow the public review button');
  const communityCss = fs.readFileSync(path.join(root, 'src/components/CommunityPanel.css'), 'utf8');
  assert.match(communityCss, /\.community-actions\s*\{[^}]*align-items:\s*flex-start/s);
});
