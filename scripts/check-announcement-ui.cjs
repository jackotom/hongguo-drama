const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { createAnnouncementService } = require('../src/native/app-announcements');

function mount({ notice = null, fullscreen = null, hidden = false, openExternal = async () => ({ success: true }), writeClipboard = async () => {}, clipboardAvailable = true, preferences = {} } = {}) {
  let clock = 0, state = { preferences }, cursor = 0, timerId = 0, tree;
  const slots = [], effects = [], cleanups = [], timers = new Map(), listeners = new Map(), windowListeners = new Map();
  const requests = [], acknowledgements = [], opened = [], copied = [];
  const body = {};
  const document = { body, hidden, fullscreenElement: fullscreen,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef: initial => { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect: (fn, deps) => {
      const index = cursor++;
      if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index][i]))) {
        slots[index] = deps;
        effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); });
      }
    },
  };
  const service = createAnnouncementService({
    version: '3.9.0', now: () => clock,
    store: { getAnnouncementState: () => structuredClone(state), saveAnnouncementState: patch => { state = { ...state, ...patch }; } },
    request: async url => {
      requests.push({ url, at: clock });
      return { status: 200, headers: { 'content-type': 'text/plain' },
        data: JSON.stringify({ id: 'inactive', title: 'Test', body: 'Test', active: false }) };
    },
  });
  let preferenceListener;
  const api = {
    checkAnnouncements: notice ? async () => ({ announcement: notice }) : service.checkAnnouncements,
    getAnnouncementPreferences: async () => service.getAnnouncementPreferences(),
    onAnnouncementPreferences: fn => { preferenceListener = fn; return () => { preferenceListener = null; }; },
    acknowledgeAnnouncement: async value => { acknowledgements.push(value.id); return { success: true }; },
    openExternalUrl: async url => { opened.push(url); return openExternal(url); },
  };
  const schedule = (fn, delay, repeat) => { timers.set(++timerId, { fn, delay, repeat, next: clock + delay }); return timerId; };
  const module = { exports: {} };
  const file = path.join(__dirname, '../src/components/AnnouncementNotice.jsx');
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
    module, exports: module.exports,
    navigator: clipboardAvailable ? { clipboard: { writeText: async text => { copied.push(text); return writeClipboard(text); } } } : {},
    require: name => name === '../i18n' ? { t: require('../src/i18n/translator.mjs').formatMessage, useLanguage() {} } : name === 'react' ? react : name === 'react-dom' ? { createPortal: (node, root) => ({ node, root }) }
      : name === './useDialogKeyboard' ? () => {} : {},
    window: { electronAPI: api, addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name) }, document,
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => timers.delete(id),
    setTimeout: (fn, delay) => schedule(fn, delay, false), clearTimeout: id => timers.delete(id),
  });
  const render = () => { cursor = 0; tree = module.exports.default(); effects.splice(0).forEach(fn => fn()); };
  const flush = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); render(); } };
  render();
  return {
    document, requests, acknowledgements, opened, copied, timers, flush,
    get tree() { return tree; },
    emit: name => listeners.get(name)?.(),
    showManual: item => windowListeners.get('hongguo-show-current-announcement')?.({ detail: item }),
    getPreferences: service.getAnnouncementPreferences,
    setPreferences: patch => preferenceListener(service.setAnnouncementPreferences(patch).preferences),
    advance: async time => {
      clock = time;
      for (const [id, timer] of [...timers]) if (timer.next <= clock) {
        if (timer.repeat) timer.next += timer.delay; else timers.delete(id);
        timer.fn();
      }
      await flush();
    },
    unmount: () => cleanups.forEach(fn => fn?.()),
  };
}

(async () => {
  let failures = 0;
  const check = async (name, fn) => { try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); } };
  const urgent = { id: 'urgent-1', title: '紧急公告', body: '公告正文', urgent: true };
  const purchaseText = 'AI 服务选购\n如需开通 ChatGPT、Codex、Grok 等 AI 服务，可前往 vipai.pro 选购。支持直充自己的账号，价格实惠。';
  const purchaseNotice = { ...urgent, urgent: false, body: `功能建议\n欢迎反馈。\n\n${purchaseText}\n\n具体产品、价格及开通方式，以网站页面说明为准。` };
  const nodes = tree => {
    const out = [];
    const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; out.push(node); node.children?.forEach(walk); };
    walk(tree); return out;
  };
  const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' ? node : node?.children?.map(textOf).join('') || '';
  const feedbackNotice = { ...purchaseNotice, body: `GitHub：https://github.com/jackotom/hongguo-drama/issues\n邮箱：jaoktom@outlook.com\n\n${purchaseText}` };
  const emailButton = ui => nodes(ui.tree.node).find(node => node.type === 'button' && textOf(node).includes('jaoktom@outlook.com'));
  const statuses = ui => nodes(ui.tree?.node).filter(node => node.props?.role === 'status');
  await check('GitHub and purchase remain links; the email button copies only its address without navigation', async () => {
    let complete;
    const ui = mount({ notice: feedbackNotice, writeClipboard: () => new Promise(resolve => { complete = resolve; }) });
    try {
      await ui.flush();
      const links = nodes(ui.tree.node).filter(node => node.type === 'a');
      assert.deepEqual(links.map(node => node.props.href), ['https://github.com/jackotom/hongguo-drama/issues', 'https://vipai.pro/']);
      for (const link of links) { let prevented = false; await link.props.onClick({ preventDefault: () => { prevented = true; } }); assert.equal(prevented, true); }
      assert.deepEqual(ui.opened, links.map(node => node.props.href));
      const button = emailButton(ui);
      assert.ok(button, 'email must be a semantic button');
      assert.equal(button.props.type, 'button');
      assert.equal(button.props.href, undefined);
      assert.ok(button.props.className.split(' ').includes('announcement-link'));
      const originalTimers = [...ui.timers.keys()];
      const copying = button.props.onClick(); await ui.flush();
      assert.deepEqual(ui.copied, ['jaoktom@outlook.com']);
      assert.equal(statuses(ui).length, 0, 'pending copy must not claim success');
      complete(); await copying; await ui.flush();
      assert.equal(textOf(statuses(ui)[0]), '邮箱已复制');
      assert.deepEqual(ui.opened, ['https://github.com/jackotom/hongguo-drama/issues', 'https://vipai.pro/']);
      assert.deepEqual([...ui.timers.keys()], originalTimers, 'copying must not restart the announcement timer');
    } finally { ui.unmount(); }
  });
  await check('clipboard rejection replaces prior success with a selectable manual-copy fallback', async () => {
    let denied = false;
    const ui = mount({ notice: feedbackNotice, writeClipboard: async () => { if (denied) throw new Error('Clipboard denied'); } });
    try {
      await ui.flush();
      assert.ok(emailButton(ui), 'email must be a semantic button');
      await emailButton(ui).props.onClick(); await ui.flush();
      assert.equal(textOf(statuses(ui)[0]), '邮箱已复制');
      denied = true;
      await emailButton(ui).props.onClick(); await ui.flush();
      assert.equal(statuses(ui).length, 0, 'failed copy must clear prior success');
      const alert = nodes(ui.tree.node).find(node => node.props?.role === 'alert');
      assert.match(textOf(alert), /复制失败/);
      assert.match(textOf(alert), /手动选择复制/);
      assert.match(textOf(alert), /jaoktom@outlook\.com/);
      assert.equal(ui.opened.length, 0);
      const css = fs.readFileSync(path.join(__dirname, '../src/components/AnnouncementNotice.css'), 'utf8');
      assert.match(css, /\.announcement-error\s*\{[^}]*user-select:\s*text/);
      assert.match(css, /button\.announcement-link\s*\{[^}]*border:\s*0;[^}]*background:\s*(?:none|transparent);[^}]*padding:\s*0/);
    } finally { ui.unmount(); }
  });
  await check('missing clipboard support shows manual-copy guidance without claiming success', async () => {
    const ui = mount({ notice: feedbackNotice, clipboardAvailable: false });
    try {
      await ui.flush();
      assert.ok(emailButton(ui), 'email must remain available without clipboard support');
      await emailButton(ui).props.onClick(); await ui.flush();
      assert.equal(statuses(ui).length, 0);
      assert.ok(nodes(ui.tree.node).some(node => node.props?.role === 'alert' && /手动选择复制.*jaoktom@outlook\.com/.test(textOf(node))));
      assert.deepEqual(ui.opened, []);
    } finally { ui.unmount(); }
  });
  await check('closing and switching announcements clear copy success and ignore a late clipboard response', async () => {
    let complete, pending = false;
    const ui = mount({ notice: feedbackNotice, writeClipboard: () => pending ? new Promise(resolve => { complete = resolve; }) : Promise.resolve() });
    try {
      await ui.flush();
      assert.ok(emailButton(ui), 'email must be a semantic button');
      await emailButton(ui).props.onClick(); await ui.flush();
      assert.equal(textOf(statuses(ui)[0]), '邮箱已复制');
      nodes(ui.tree.node).find(node => node.props?.['aria-label'] === '关闭公告').props.onClick(); await ui.flush();
      assert.equal(ui.tree, null);
      ui.showManual(feedbackNotice); await ui.flush(); assert.equal(statuses(ui).length, 0);
      await emailButton(ui).props.onClick(); await ui.flush();
      assert.equal(textOf(statuses(ui)[0]), '邮箱已复制');
      ui.showManual({ ...feedbackNotice, id: 'feedback-2' }); await ui.flush(); assert.equal(statuses(ui).length, 0);
      pending = true;
      const copying = emailButton(ui).props.onClick();
      ui.showManual({ ...feedbackNotice, id: 'feedback-3' }); await ui.flush();
      complete(); await copying; await ui.flush();
      assert.equal(statuses(ui).length, 0, 'late clipboard completion must not affect another announcement');
    } finally { ui.unmount(); }
  });
  await check('manual viewing bypasses automatic switches and can reopen the same announcement without changing preferences', async () => {
    const ui = mount({ notice: purchaseNotice, preferences: { normalEnabled: false, emergencyEnabled: false } });
    try {
      await ui.flush(); assert.equal(ui.tree, null);
      ui.showManual(purchaseNotice); await ui.flush(); assert.ok(ui.tree);
      await ui.advance(30000); assert.equal(ui.tree, null);
      ui.showManual(purchaseNotice); await ui.flush(); assert.ok(ui.tree);
      assert.deepEqual(ui.getPreferences(), { normalEnabled: false, emergencyEnabled: false });
      assert.equal([...ui.timers.values()].filter(timer => timer.repeat).length, 0);
    } finally { ui.unmount(); }
  });
  await check('the whole AI service paragraph is one external purchase link', async () => {
    const ui = mount({ notice: purchaseNotice });
    try {
      await ui.flush();
      const link = nodes(ui.tree.node).find(node => node.type === 'a');
      assert.ok(link, 'AI service text must be a link');
      assert.equal(link.props.href, 'https://vipai.pro/');
      assert.equal(textOf(link), purchaseText, 'heading and full purchase description must be clickable');
      let prevented = false;
      await link.props.onClick({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true, 'the Electron page must not navigate away');
      assert.deepEqual(ui.opened, ['https://vipai.pro/']);
    } finally { ui.unmount(); }
  });
  await check('external browser failure keeps the announcement and shows a useful error', async () => {
    const ui = mount({ notice: purchaseNotice, openExternal: async () => ({ success: false, error: '浏览器打开失败' }) });
    try {
      await ui.flush();
      const link = nodes(ui.tree.node).find(node => node.type === 'a');
      assert.ok(link, 'AI service text must be a link');
      await link.props.onClick({ preventDefault() {} }); await ui.flush();
      assert.ok(ui.tree);
      assert.ok(nodes(ui.tree.node).some(node => node.props?.role === 'alert' && textOf(node).includes('浏览器打开失败')));
    } finally { ui.unmount(); }
  });
  await check('fullscreen announcement stays inside visible container, without duplicate read marks or timer reset', async () => {
    const stage = {};
    const ui = mount({ notice: urgent, fullscreen: stage });
    try {
      await ui.flush();
      assert.equal(ui.tree.root, stage, 'announcement must be inside the fullscreen element');
      assert.deepEqual(ui.acknowledgements, ['urgent-1']);
      const originalTimer = [...ui.timers.keys()];
      ui.document.fullscreenElement = null; ui.emit('fullscreenchange'); await ui.flush();
      assert.equal(ui.tree.root, ui.document.body, 'leaving fullscreen must move the announcement back');
      assert.deepEqual(ui.acknowledgements, ['urgent-1']);
      assert.deepEqual([...ui.timers.keys()], originalTimer, 'moving the portal must not restart its display time');
    } finally { ui.unmount(); }
  });
  await check('normal preference changes at 4m59s preserve the 5-minute emergency network check', async () => {
    const ui = mount();
    try {
      await ui.flush(); await ui.advance(299000);
      ui.setPreferences({ normalEnabled: false }); await ui.flush();
      await ui.advance(300000);
      assert.deepEqual(ui.requests.filter(item => item.url.endsWith('/emergency.json')).map(item => item.at), [0, 300000]);
      ui.setPreferences({ emergencyEnabled: false }); await ui.flush();
      await ui.advance(600000);
      assert.equal(ui.requests.filter(item => item.url.endsWith('/emergency.json')).length, 2);
    } finally { ui.unmount(); }
  });
  await check('announcement closes at 30 seconds', async () => {
    const ui = mount({ notice: { ...urgent, urgent: false } });
    try { await ui.flush(); await ui.advance(29999); assert.ok(ui.tree); await ui.advance(30000); assert.equal(ui.tree, null); }
    finally { ui.unmount(); }
  });
  await check('hidden windows do not consume an emergency read mark before it is displayed', async () => {
    const stage = {}, ui = mount({ notice: urgent, fullscreen: stage, hidden: true });
    try {
      await ui.flush(); assert.equal(ui.tree, null); assert.deepEqual(ui.acknowledgements, []);
      ui.document.hidden = false; ui.emit('visibilitychange'); await ui.flush();
      assert.equal(ui.tree.root, stage); assert.deepEqual(ui.acknowledgements, ['urgent-1']);
    } finally { ui.unmount(); }
  });
  if (failures) process.exitCode = 1;
})();
