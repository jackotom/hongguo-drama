import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { rankSearchResults } from '../searchRanking.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

function mount(file, props, api) {
  let cursor = 0, tree;
  const slots = [], effects = [];
  const sources = { sources: [{ id: 'hongguo', label: '红果' }], revision: 0 };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }];
    },
    useRef(initial) { const at = cursor++; return slots[at] ||= { current: initial }; },
    useEffect(effect, deps) {
      const at = cursor++, previous = slots[at];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        slots[at] = { deps };
        effects.push(() => { slots[at].cleanup = effect(); });
      }
    },
  };
  const modules = {
    react, './HongguoDownload.css': {}, './SearchPanel': 'SearchPanel',
    './icons': Object.fromEntries(['Film', 'Download', 'CheckSquare', 'Square', 'RefreshCw', 'Folder', 'Link2', 'Search', 'Play', 'ExternalLink'].map(name => [name, name])),
    './useMediaSources': () => sources,
    './mediaSourcesModel.mjs': { mediaSourceLabel: () => '红果' },
    './searchRanking.mjs': { rankSearchResults },
    './episodeRange': {},
    '../searchHistory': { readSearchHistory: () => [], saveSearchTerm: () => [], rememberCatalogTitles() {}, getSearchSuggestions: () => [] },
  };
  const module = { exports: {} };
  const code = transformSync(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  vm.runInNewContext(code, {
    module, exports: module.exports, require: id => {
      assert.ok(id in modules, `Unexpected import: ${id}`);
      return modules[id];
    },
    window: Object.assign(new EventTarget(), { electronAPI: api }), document: { querySelector: () => null }, setTimeout, clearTimeout,
  });
  const render = () => {
    cursor = 0;
    tree = module.exports.default(props);
    while (effects.length) effects.shift()();
  };
  const find = predicate => {
    let match;
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (!match && predicate(node)) match = node;
      node.children?.forEach(visit);
    };
    visit(tree);
    return match;
  };
  render();
  render();
  return { render, find };
}

test('search details preserve real metadata, fold long intros, and ignore stale or failed public details', async () => {
  const intro = '女主回到家乡，带领村民重新开始。'.repeat(12);
  const result = { series_id: '12345678', series_title: '回家', cover: 'https://example.invalid/search-cover.jpg', description: intro };
  let resolved = { series_id: result.series_id, series_title: result.series_title, cover: 'https://example.invalid/detail-cover.jpg', total: 1, episodes: [{ vid: '87654321', vid_index: 1 }] };
  let selected;
  const requests = [];
  const api = {
    searchSeries: async () => ({ success: true, results: [result] }),
    searchResolve: async () => ({ success: true, data: resolved }),
    getSettings: async () => ({}),
    getPublicDetails: id => new Promise((resolve, reject) => requests.push({ id, resolve, reject })),
  };
  const search = mount('SearchPanel.jsx', { onSelectSeries: data => { selected = data; } }, api);
  search.find(node => node.type === 'input').props.onChange({ target: { value: '回家' } });
  search.render();
  await search.find(node => node.type === 'button' && node.props.className === 'btn btn-primary').props.onClick();
  search.render();
  const pick = () => search.find(node => node.props.className?.trim() === 'search-card').props.onClick();
  await pick();
  assert.equal(selected.description, intro);
  assert.equal(selected.cover, resolved.cover, 'use the resolved detail image ahead of the search thumbnail');
  resolved = { ...resolved, cover: '', description: '详情接口提供的真实简介' };
  search.render();
  await pick();
  assert.equal(selected.description, resolved.description, 'resolved metadata takes priority');
  assert.equal(selected.cover, result.cover, 'retain the search image if detail has none');
  resolved = { ...resolved, description: ' ' };
  search.render();
  await pick();

  const detail = mount('HongguoDownload.jsx', {}, api);
  const open = data => {
    detail.find(node => node.type === 'SearchPanel').props.onSelectSeries(data);
    detail.render();
    detail.render();
  };
  const paragraph = () => detail.find(node => node.props.id === 'series-description-text');
  const toggle = () => detail.find(node => node.type === 'button' && node.props['aria-controls'] === 'series-description-text');
  open(selected);
  await tick(); detail.render();
  assert.equal(requests.length, 0, 'provided intros need no extra request');
  assert.equal(paragraph().children[0], `${intro.slice(0, 120)}…`);
  assert.equal(toggle().props['aria-expanded'], false);
  toggle().props.onClick(); detail.render();
  assert.equal(paragraph().children[0], intro);
  assert.equal(toggle().props['aria-expanded'], true);
  assert.ok(toggle().children.includes('收起简介'));
  toggle().props.onClick(); detail.render();
  assert.equal(toggle().props['aria-expanded'], false);
  toggle().props.onClick(); detail.render();
  open({ ...selected, series_id: '12345679' });
  assert.equal(toggle().props['aria-expanded'], false, 'another series starts collapsed');

  open({ ...selected, series_id: '12345680', description: '' });
  await tick();
  assert.equal(requests[0].id, '12345680');
  open({ ...selected, series_id: '12345681', description: '' });
  await tick();
  requests[0].resolve({ success: true, series_id: '12345680', description: '旧剧简介不可串入新剧' });
  await tick(); detail.render();
  assert.equal(paragraph(), undefined);
  requests[1].resolve({ success: true, series_id: '12345681', description: '从现有公开接口补齐的真实简介' });
  await tick(); detail.render();
  assert.equal(paragraph().children[0], '从现有公开接口补齐的真实简介');
  assert.equal(toggle(), undefined, 'short intros stay fully visible');

  open({ ...selected, series_id: '12345682', description: '' });
  await tick(); requests[2].reject(new Error('offline'));
  await tick(); detail.render();
  assert.ok(detail.find(node => node.type === 'p' && node.children.includes('简介暂未获取，请稍后重新打开剧集。')));
  open({ ...selected, series_id: 'custom:fixture:1', description: '' });
  await tick(); detail.render();
  assert.equal(requests.length, 3, 'other sources never use the Hongguo public API');
  assert.ok(detail.find(node => node.type === 'p' && node.children.includes('当前来源暂无剧情简介')));
});
