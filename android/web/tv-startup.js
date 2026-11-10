/* Keep this guard ES5: it must run even when app.js cannot be parsed. */
(function () {
  var finished = false;
  var reasons = {
    js_bigint: 'WebView 缺少 BigInt 整数能力，无法执行现有取源签名。',
    js_abort: 'WebView 缺少 AbortController／AbortSignal.timeout，无法安全取消请求。',
    js_collections: 'WebView 缺少现有程序需要的集合或字符串 API。',
    js_dom: 'WebView 缺少页面更新或遥控焦点需要的 DOM API。',
    js_dialog: 'WebView 缺少对话框 API，无法正常关闭说明层。',
    js_storage: '本机存储不可用，无法保存收藏与观看记录。',
    js_video: 'WebView 缺少 HTML 视频播放 API。',
    css_layout: 'WebView 缺少 Grid／Flex／aspect-ratio 布局能力。',
    bundle_error: '界面脚本加载或执行失败，可能需要更新系统 WebView。'
  };
  function report(code) {
    if (window.Native && typeof Native.tvStartup === 'function') Native.tvStartup(code);
  }
  function fail(code) {
    if (finished) return;
    finished = true;
    document.querySelector('#content').textContent = '红果短剧 TV 无法启动：' + reasons[code] + ' 请更新系统 WebView 后重新打开；按返回键退出。';
    report(code);
  }
  try {
    if (typeof BigInt !== 'function' || typeof BigInt.asUintN !== 'function') { fail('js_bigint'); return; }
    if (typeof AbortController !== 'function' || typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') { fail('js_abort'); return; }
    if (typeof Map !== 'function' || typeof Set !== 'function' || typeof Promise !== 'function' || typeof Promise.prototype.finally !== 'function' ||
        typeof Object.values !== 'function' || typeof Array.from !== 'function' || typeof Array.prototype.includes !== 'function' ||
        typeof Array.prototype.flat !== 'function' || typeof Array.prototype.flatMap !== 'function' || typeof String.prototype.matchAll !== 'function') { fail('js_collections'); return; }
    if (typeof globalThis === 'undefined' || typeof URL !== 'function' || typeof URLSearchParams !== 'function' ||
        typeof MutationObserver !== 'function' || typeof requestAnimationFrame !== 'function' ||
        typeof document.querySelector !== 'function' || typeof Element === 'undefined' || typeof Element.prototype.closest !== 'function' ||
        typeof Element.prototype.after !== 'function' || typeof Element.prototype.scrollIntoView !== 'function') { fail('js_dom'); return; }
    if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function' || typeof HTMLDialogElement.prototype.close !== 'function') { fail('js_dialog'); return; }
    if (!window.CSS || typeof CSS.supports !== 'function' || !CSS.supports('display', 'grid') || !CSS.supports('display', 'flex') || !CSS.supports('aspect-ratio', '3 / 4')) { fail('css_layout'); return; }
    var key = '__hg_tv_preflight__';
    var previous;
    try {
      previous = localStorage.getItem(key);
      localStorage.setItem(key, 'ok');
      if (localStorage.getItem(key) !== 'ok') throw new Error();
    } catch (ignored) { fail('js_storage'); return; }
    finally {
      if (previous !== undefined) {
        if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous);
      }
    }
    var video = document.createElement('video');
    if (typeof video.canPlayType !== 'function' || typeof HTMLMediaElement === 'undefined' ||
        typeof HTMLMediaElement.prototype.play !== 'function' || typeof HTMLMediaElement.prototype.pause !== 'function') { fail('js_video'); return; }
    // Codec claims are not proof that a real episode can be decoded.
    var script = document.createElement('script');
    var bundleFailed = function () { fail('bundle_error'); };
    window.addEventListener('error', bundleFailed);
    script.src = 'app.js';
    script.onerror = bundleFailed;
    script.onload = function () {
      window.removeEventListener('error', bundleFailed);
      if (finished) return;
      if (typeof window.tvKey !== 'function' || typeof window.appBack !== 'function') { fail('bundle_error'); return; }
      finished = true;
      report('ready');
    };
    document.head.appendChild(script);
  } catch (ignored) { fail('bundle_error'); }
}());
