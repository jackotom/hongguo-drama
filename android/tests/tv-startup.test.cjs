const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('../../node_modules/esbuild');
const nativeStartupRegression = require('./tv-startup-native.cjs');

const root = path.join(__dirname, '..');
const file = path.join(root, 'web/tv-startup.js');
test('native TV failure is terminal for queued/running/late work and released WebView callbacks', t => {
  const summary = nativeStartupRegression(root);
  assert.match(summary, /Native behavior PASS/);
  t.diagnostic(summary);
});
test('native TV image resources stop at the same terminal boundary', t => {
  const summary = nativeStartupRegression(root, 'images');
  assert.match(summary, /Native images PASS/);
  t.diagnostic(summary);
});
function boot(setup = () => {}) {
  assert(fs.existsSync(file), 'TV must preflight before loading the modern app bundle');
  const statuses = [], scripts = [], errors = {}, nodes = {};
  const context = {
    Native: {tvStartup: code => statuses.push(code)},
    console: {info() {}},
    document: {
      createElement: tag => tag === 'video' ? {canPlayType: () => 'maybe'} : {},
      head: {appendChild: script => scripts.push(script)},
      querySelector: id => nodes[id] || (nodes[id] = {}),
    },
    CSS: {supports: () => true},
    HTMLDialogElement: function() {}, HTMLMediaElement: function() {},
    Element: function() {},
    MutationObserver: function() {}, requestAnimationFrame() {},
    AbortController, AbortSignal, URL, URLSearchParams,
    localStorage: {setItem() {}, getItem: () => 'ok', removeItem() {}},
    addEventListener: (name, handler) => { errors[name] = handler; },
    removeEventListener: name => { delete errors[name]; },
  };
  context.HTMLDialogElement.prototype.showModal = () => {};
  context.Element.prototype.closest = () => {};
  context.Element.prototype.after = () => {};
  context.Element.prototype.scrollIntoView = () => {};
  context.HTMLDialogElement.prototype.close = () => {};
  context.HTMLMediaElement.prototype.play = () => {};
  context.HTMLMediaElement.prototype.pause = () => {};
  context.window = context;
  vm.createContext(context);
  setup(context);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return {context, statuses, scripts, errors, nodes};
}

test('TV preflight uses ES5 syntax, loads app once, and only marks ready after TV hooks exist', () => {
  assert(fs.existsSync(file), 'TV startup guard is required');
  esbuild.transformSync(fs.readFileSync(file, 'utf8'), {target: 'es5'});
  const b = boot();
  assert.equal(b.scripts.length, 1);
  assert.equal(b.scripts[0].src, 'app.js');
  assert.deepEqual(b.statuses, []);
  b.context.tvKey = () => {};
  b.context.appBack = () => {};
  b.scripts[0].onload();
  assert.deepEqual(b.statuses, ['ready']);
  assert.equal(b.errors.error, undefined);
});

test('missing required JS capabilities blocks app with a fixed reason', () => {
  for (const [setup, reason] of [
    [c => { c.BigInt = undefined; }, 'js_bigint'],
    [c => { c.AbortSignal = {}; }, 'js_abort'],
    [c => vm.runInContext('Array.prototype.flatMap = undefined', c), 'js_collections'],
    [c => { c.HTMLDialogElement = undefined; }, 'js_dialog'],
    [c => { c.Element.prototype.after = undefined; }, 'js_dom'],
  ]) {
    const b = boot(setup);
    assert.deepEqual(b.statuses, [reason]);
    assert.equal(b.scripts.length, 0);
  }
});

test('CSS, storage and video capability failures are readable and block startup', () => {
  for (const [setup, reason] of [
    [c => { c.CSS.supports = () => false; }, 'css_layout'],
    [c => { c.localStorage.setItem = () => { throw new Error('private storage detail'); }; }, 'js_storage'],
    [c => { c.document.createElement = () => ({}); }, 'js_video'],
  ]) {
    const b = boot(setup);
    assert.deepEqual(b.statuses, [reason]);
    assert.match(b.nodes['#content'].textContent, /无法启动/);
    assert(!b.nodes['#content'].textContent.includes('private'));
    assert.equal(b.scripts.length, 0);
  }
});

test('bundle load, parse and synchronous execution errors report once without exception data', () => {
  for (const fail of [b => b.scripts[0].onerror(), b => b.errors.error({message: 'private token'})]) {
    const b = boot();
    fail(b);
    b.scripts[0].onload();
    assert.deepEqual(b.statuses, ['bundle_error']);
    assert(!JSON.stringify(b.nodes).includes('private'));
  }
  const b = boot();
  b.scripts[0].onload();
  assert.deepEqual(b.statuses, ['bundle_error']);
});

test('diagnostic storage probe preserves existing data', () => {
  for (const saved of [null, 'saved']) {
    const values = new Map(saved === null ? [] : [['__hg_tv_preflight__', saved]]);
    boot(c => { c.localStorage = {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
    }; });
    assert.equal(values.get('__hg_tv_preflight__'), saved === null ? undefined : saved);
  }
});

test('TV wiring keeps minSdk29, chrome100 and phone entry while adding a native fallback', () => {
  const build = fs.readFileSync(path.join(root, 'build.py'), 'utf8');
  const bundle = fs.readFileSync(path.join(root, 'bundle.cjs'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  const native = fs.readFileSync(path.join(root, 'app/src/main/java/io/github/hongguo/personal/MainActivity.java'), 'utf8');
  assert.match(manifest, /minSdkVersion="29"/);
  assert.match(build, /'--min-api','29'/);
  assert.match(bundle, /target:'chrome100'/);
  assert.match(build, /src="app.js".*src="tv-startup.js"/);
  assert.match(bundle, /copyFileSync[\s\S]*web\/tv-startup.js/);
  assert.match(build, /<queries>.*android.intent.action.VIEW.*video\/mp4/);
  assert.match(native, /@JavascriptInterface public void tvStartup\(String code\)/);
  assert.match(native, /postDelayed\(tvStartupTimeout, 12000\)/);
  assert.match(native, /onReceivedError/);
  assert.match(native, /onReceivedHttpError/);
  assert.match(native, /onRenderProcessGone/);
  assert.match(native, /"\/tv-startup\.js"\.equals\(p\)/, 'asset interception must serve the guard');
  assert.match(native, /if \(web != null\)/);
  assert(!/Build\.(SERIAL|MODEL|MANUFACTURER)|getSerial\(|ANDROID_ID|getDeviceId\(/.test(native));
});
