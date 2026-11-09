import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as model from '../stealthWakeRegion.mjs';
import { createTranslator } from '../../i18n/translator.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function mount(file, props, api, app = false) {
  let cursor = 0, tree;
  const slots = [], effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }]; },
    useRef(initial) { const at = cursor++; return slots[at] ||= { current: initial }; },
    useCallback: value => value,
    useEffect(effect, deps) {
      const at = cursor++, previous = slots[at];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.(); slots[at] = { deps }; effects.push(() => { slots[at].cleanup = effect(); });
      }
    },
  };
  react.useLayoutEffect = react.useEffect;
  const module = { exports: {} };
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'jsx', format: 'cjs' }).code, {
    module, exports: module.exports,
    require(id) {
      if (id === 'react') return react;
      if (id.endsWith('/i18n')) return { t: value => value, useLanguage() {} };
      if (id.endsWith('.css')) return {};
      if (id === './stealthWakeRegion.mjs') return model;
      if (app && id === './theme') return { initializeTheme() {} };
      if (app && id === './components/useStealthWindow') return () => ({ stealthMode: true, toggleStealth() {}, stealthError: '' });
      if (app && id === './components/icons') return Object.fromEntries(['Film', 'Download', 'Settings', 'Play', 'Home', 'Search', 'Clock', 'User'].map(name => [name, name]));
      if (app && id.startsWith('./components/')) return id.split('/').at(-1);
      throw Error('Unexpected import: ' + id);
    },
    window: { electronAPI: api }, navigator: { platform: 'Mac' }, document: {}, console,
  });
  const findAll = predicate => {
    const matches = [];
    const visit = node => { if (!node || typeof node !== 'object') return; if (predicate(node)) matches.push(node); node.children?.forEach(visit); };
    visit(tree); return matches;
  };
  const render = () => {
    cursor = 0; tree = module.exports.default(props);
    for (const node of findAll(node => node.props.ref)) {
      node.props.ref.current = { getBoundingClientRect: () => ({ width: 400, height: 225 }), scrollIntoView() {}, focus() {} };
    }
    while (effects.length) effects.shift()();
  };
  render();
  return { render, find: predicate => findAll(predicate)[0], findAll };
}

test('percentage fields reject blank/nonfinite/outside/minimum values and keep exact edges valid', () => {
  for (const fields of [
    { x: '', y: '0', width: '100', height: '100' },
    { x: 'Infinity', y: '0', width: '10', height: '100' },
    { x: '91', y: '0', width: '10', height: '100' },
    { x: '0', y: '0', width: '4.9', height: '100' },
  ]) assert.equal(model.wakeRegionFromFields(fields), null);
  for (let x = 0; x <= 95; x++) {
    const region = model.wakeRegionFromFields({ x: String(x), y: '95', width: String(100 - x), height: '5' });
    assert.ok(model.validWakeRegion(region), `right/bottom edge at ${x}%`);
  }
  assert.deepEqual(model.wakeRegionFields({ x: NaN }), { x: '0', y: '0', width: '100', height: '100' });
  assert.equal(model.wakeRegionFields({ x: 0.12345, y: 0, width: 0.5, height: 1 }).x, '12.345');
});

test('drag and resize remain within the window and preserve minimum dimensions', () => {
  const region = { x: 0.2, y: 0.3, width: 0.4, height: 0.4 };
  assert.deepEqual(model.adjustWakeRegion(region, 10, -10), { ...region, x: 0.6, y: 0 });
  assert.deepEqual(model.adjustWakeRegion(region, -10, -10, true), { ...region, width: 0.05, height: 0.05 });
  assert.deepEqual(model.adjustWakeRegion(region, 10, 10, true), { ...region, width: 0.8, height: 0.7 });
  assert.equal(model.adjustWakeRegion(region, Infinity, 0), region);
});

test('wake area saves only its own setting; failure retains the draft without a saved notice', async () => {
  const requests = [];
  let succeed = false;
  const component = mount('../StealthWakeRegion.jsx', {}, {
    getSettings: async () => ({ stealth_wake_region: model.FULL_WAKE_REGION }),
    saveSettings: async value => { requests.push(value); return succeed ? { success: true } : { success: false, error: 'disk full' }; },
  });
  await tick(); component.render();
  const button = text => component.find(node => node.type === 'button' && node.children.includes(text));
  assert.equal(button('保存唤醒区域').props.disabled, true);
  button('右侧窄条（10%）').props.onClick(); component.render();
  await button('保存唤醒区域').props.onClick(); component.render();
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), { stealth_wake_region: model.RIGHT_WAKE_REGION });
  assert.ok(component.find(node => node.props.role === 'alert' && node.children.includes('disk full')));
  assert.equal(component.find(node => node.children.includes('唤醒区域已保存')), undefined);
  assert.equal(component.find(node => node.props.id === 'stealth-wake-x').props.value, '90');
  succeed = true;
  await button('保存唤醒区域').props.onClick(); component.render();
  assert.ok(component.find(node => node.children.includes('唤醒区域已保存')));
  assert.equal(button('保存唤醒区域').props.disabled, true);
  component.find(node => node.props.id === 'stealth-wake-width').props.onChange({ target: { value: '99' } }); component.render();
  assert.equal(button('保存唤醒区域').props.disabled, true);
  assert.equal(component.find(node => node.children.includes('唤醒区域已保存')), undefined);
});

test('pointer move and resize update preview; save pending blocks a second change and submission', async () => {
  let resolveSave, calls = 0;
  const component = mount('../StealthWakeRegion.jsx', {}, {
    getSettings: async () => ({ stealth_wake_region: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } }),
    saveSettings: () => { calls++; return new Promise(resolve => { resolveSave = resolve; }); },
  });
  await tick(); component.render();
  const move = () => component.find(node => node.props.className === 'stealth-wake-move');
  const target = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  move().props.onPointerDown({ button: 0, pointerId: 1, clientX: 100, clientY: 50, preventDefault() {}, currentTarget: target });
  move().props.onPointerMove({ pointerId: 1, clientX: 140, clientY: 50 }); component.render();
  assert.equal(component.find(node => node.props.id === 'stealth-wake-x').props.value, '30');
  move().props.onPointerUp({ pointerId: 1, currentTarget: target });
  const resize = component.find(node => node.props.className === 'stealth-wake-resize');
  resize.props.onKeyDown({ key: 'ArrowRight', shiftKey: false, preventDefault() {} }); component.render();
  assert.equal(component.find(node => node.props.id === 'stealth-wake-width').props.value, '41');
  const save = component.find(node => node.type === 'button' && node.children.includes('保存唤醒区域')).props.onClick;
  const pending = save(); component.render();
  component.find(node => node.type === 'button' && node.children.includes('恢复全窗')).props.onClick();
  await save(); component.render();
  assert.equal(calls, 1);
  assert.equal(component.find(node => node.props.id === 'stealth-wake-x').props.value, '30');
  resolveSave({ success: true }); await pending; component.render();
  assert.ok(component.find(node => node.children.includes('唤醒区域已保存')));
});

test('toolbar navigates to wake settings only after a successful native exit', async () => {
  let succeed = false, calls = 0;
  const component = mount('../../App.jsx', {}, {
    getAppInfo: async () => ({ platform: 'darwin' }),
    setStealthMode: async enabled => { calls++; assert.equal(enabled, false); return succeed ? { success: true } : { success: false, error: 'exit failed' }; },
  }, true);
  await tick(); component.render();
  const open = () => component.find(node => node.type === 'button' && node.children.includes('设置唤醒区域')).props.onClick();
  await open(); component.render();
  assert.equal(component.find(node => node.type === 'Settings' && node.props.active === true), undefined);
  assert.ok(component.find(node => node.type === 'span' && node.children.includes('exit failed')));
  succeed = true; await open(); component.render();
  const settings = component.find(node => node.type === 'Settings' && node.props.active === true);
  assert.ok(settings);
  assert.equal(settings.props.wakeRegionFocus, 1);
  assert.equal(calls, 2);
});

test('wake region labels and native validation error have English translations', () => {
  const dictionary = JSON.parse(fs.readFileSync(new URL('../../i18n/en.json', import.meta.url)));
  const translate = createTranslator(dictionary, []);
  for (const key of ['小窗模式：隐藏后唤醒区域', '保存唤醒区域', '设置唤醒区域', '唤醒区域未保存，请重试',
    '小窗唤醒区域无效：区域须在窗口内，宽高至少为 5%']) assert.doesNotMatch(translate(key), /[\u4e00-\u9fff]/);
});
