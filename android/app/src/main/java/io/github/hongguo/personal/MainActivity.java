package io.github.hongguo.personal;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.media.AudioManager;
import android.os.Bundle;
import android.util.Base64;
import android.util.AtomicFile;
import android.util.Rational;
import android.webkit.*;
import android.view.View;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Button;
import android.widget.TextView;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntConsumer;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import org.json.JSONArray;

public class MainActivity extends Activity {
    private static final String ORIGIN = "https://app.local";
    private static final int MEDIA_LIMIT = 64 * 1024 * 1024;
    private WebView web;
    private FrameLayout root;
    private View fullscreen;
    private int orientationBeforeFullscreen;
    private LinearLayout loginPanel;
    private WebView loginWeb;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private final Object requestLock = new Object();
    private final ConcurrentHashMap<Object, HttpURLConnection> connections = new ConcurrentHashMap<>();
    private final Set<InputStream> resourceStreams = ConcurrentHashMap.newKeySet();
    private final Map<Integer, AtomicBoolean> requests = new ConcurrentHashMap<>();
    private final Map<Integer, NetworkTrace> networkTraces = new ConcurrentHashMap<>();
    private final Map<String, File> media = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private volatile boolean closed;
    private boolean tvStartupFinished;
    private volatile boolean tvStartupFailed;
    private String tvDiagnostics = "";
    private final Set<Integer> tvObservedKeys = new HashSet<>();
    private final Runnable tvStartupTimeout = () -> failTvStartup("startup_timeout");

    private boolean isTv() { return getPackageName().equals("io.github.hongguo.tv"); }

    private static String tvKeyName(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: return "up";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "down";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "left";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "right";
            case KeyEvent.KEYCODE_DPAD_CENTER: return "center";
            case KeyEvent.KEYCODE_ENTER: return "enter";
            case KeyEvent.KEYCODE_BACK: return "back";
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return "play_pause";
            case KeyEvent.KEYCODE_MEDIA_PLAY: return "play";
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return "pause";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return "forward";
            case KeyEvent.KEYCODE_MEDIA_REWIND: return "rewind";
            default: return null;
        }
    }

    private void collectTvDiagnostics() {
        String abis = String.join(",", android.os.Build.SUPPORTED_ABIS).replaceAll("[^A-Za-z0-9_,.-]", "");
        tvDiagnostics = "Android API " + android.os.Build.VERSION.SDK_INT + " · ABI " + abis;
        android.util.Log.i("HongguoTv", "HG:tv:api:" + android.os.Build.VERSION.SDK_INT);
        android.util.Log.i("HongguoTv", "HG:tv:abis:" + abis);
        android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
        String version = provider == null ? "unavailable" : provider.versionName;
        if (version == null || (!"unavailable".equals(version) && !version.matches("[0-9.]{1,60}"))) version = "unknown";
        tvDiagnostics += "\nWebView " + version;
        android.util.Log.i("HongguoTv", "HG:tv:webview:" + version);
        int[] keys = {KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_REWIND};
        for (int key : keys) android.util.Log.i("HongguoTv", "HG:tv:key_declared:" + tvKeyName(key) + ":" + (android.view.KeyCharacterMap.deviceHasKey(key) ? 1 : 0));
        try {
            boolean h264 = false, hevc = false;
            for (android.media.MediaCodecInfo codec : new android.media.MediaCodecList(android.media.MediaCodecList.ALL_CODECS).getCodecInfos()) {
                if (codec.isEncoder()) continue;
                for (String mime : codec.getSupportedTypes()) {
                    if (mime.equalsIgnoreCase("video/avc")) h264 = true;
                    if (mime.equalsIgnoreCase("video/hevc")) hevc = true;
                }
            }
            android.util.Log.i("HongguoTv", "HG:tv:decoder_h264:" + (h264 ? 1 : 0));
            android.util.Log.i("HongguoTv", "HG:tv:decoder_hevc:" + (hevc ? 1 : 0));
            android.content.Intent player = new android.content.Intent(android.content.Intent.ACTION_VIEW)
                .setDataAndType(Uri.parse(ORIGIN + "/diagnostic.mp4"), "video/mp4");
            android.util.Log.i("HongguoTv", "HG:tv:system_player:" + (player.resolveActivity(getPackageManager()) != null ? 1 : 0));
        } catch (RuntimeException ignored) {
            android.util.Log.i("HongguoTv", "HG:tv:media_capability:unknown");
        }
    }

    private static String tvFailureReason(String code) {
        switch (code) {
            case "api_level": return "需要 Android API 29（Android 10）及以上。";
            case "webview_init": return "系统 WebView 无法初始化。请启用或更新系统 WebView。";
            case "js_bigint": return "WebView 缺少 BigInt，现有取源签名无法运行。";
            case "js_abort": return "WebView 缺少 AbortController／AbortSignal.timeout，无法安全取消请求。";
            case "js_collections": return "WebView 缺少现有程序需要的集合或字符串 API。";
            case "js_dom": return "WebView 缺少页面更新或遥控焦点需要的 DOM API。";
            case "js_dialog": return "WebView 缺少对话框 API。";
            case "js_storage": return "本机存储不可用，无法保存收藏与观看记录。";
            case "js_video": return "WebView 缺少 HTML 视频播放 API。";
            case "css_layout": return "WebView 缺少 Grid／Flex／aspect-ratio 布局能力。";
            case "bundle_error": return "界面脚本加载或执行失败。请更新系统 WebView 后重新打开。";
            case "page_error": return "本地启动页面无法加载。请重新安装完整候选包。";
            case "renderer_gone": return "系统 WebView 页面进程已退出。请重新打开应用。";
            case "startup_timeout": return "启动预检超过12秒，未收到界面就绪回执。请检查系统 WebView 后重新打开。";
            default: return null;
        }
    }

    private void failTvStartup(String code) {
        String reason = tvFailureReason(code);
        if (!isTv() || reason == null) return;
        synchronized (requestLock) {
            if (closed || tvStartupFailed) return;
            tvStartupFailed = true; closed = true;
            for (AtomicBoolean flag : requests.values()) flag.set(true);
            workers.shutdownNow();
        }
        root.removeCallbacks(tvStartupTimeout);
        for (HttpURLConnection connection : connections.values()) connection.disconnect();
        connections.clear(); requests.clear(); networkTraces.clear();
        closeResourceStreams();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        closeLogin(); leaveFullscreen();
        WebView business = web; web = null;
        if (business != null) {
            business.removeJavascriptInterface("Native"); business.stopLoading();
            root.removeView(business); business.destroy();
        }
        android.util.Log.i("HongguoTv", "HG:tv:startup:" + code);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(48,36,48,36);
        panel.setBackgroundColor(Color.rgb(23,27,37));
        TextView message = new TextView(this); message.setTextColor(Color.WHITE); message.setTextSize(22);
        message.setText("红果短剧 TV 无法启动\n\n" + reason + "\n\n" + tvDiagnostics + "\n\n请反馈以上能力信息；无需提供设备序列号或账号。按返回键退出。");
        panel.addView(message, new LinearLayout.LayoutParams(-1,0,1));
        Button exit = new Button(this); exit.setText("退出"); exit.setOnClickListener(view -> finish());
        panel.addView(exit); root.addView(panel, new FrameLayout.LayoutParams(-1,-1)); exit.requestFocus();
    }

    // Only local counters, durations and fixed stages enter diagnostic logs.
    private static final class NetworkTrace {
        final int id;
        final long queuedAt = android.os.SystemClock.elapsedRealtime();
        volatile String phase = "queued";
        NetworkTrace(int id) { this.id = id; }
        void log(String event, long millis) {
            android.util.Log.i("HongguoNetwork", "HG:net:" + id + ":" + event + ":" + Math.max(0,millis));
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        File cache = new File(getCacheDir(), "episodes");
        cache.mkdirs();
        File[] old = cache.listFiles();
        if (old != null) for (File f : old) f.delete();
        File downloads = new File(getFilesDir(), "downloads"); downloads.mkdirs();
        File[] saved = downloads.listFiles();
        if (saved != null) for (File f : saved) if (f.getName().matches("[0-9a-f-]{36}\\.mp4")) media.put(f.getName(), f);
        root = new FrameLayout(this);
        setContentView(root);
        if (isTv() && android.os.Build.VERSION.SDK_INT < 29) { failTvStartup("api_level"); return; }
        try {
            if (isTv()) collectTvDiagnostics();
            web = new WebView(this);
            web.setBackgroundColor(Color.rgb(23,27,37));
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setSupportMultipleWindows(false);
            settings.setSafeBrowsingEnabled(true);
            web.addJavascriptInterface(new Bridge(), "Native");
            web.setWebViewClient(new WebViewClient() {
                @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
                    if (isTv() && req.isForMainFrame()) failTvStartup("page_error");
                }
                @Override public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse response) {
                    if (isTv() && req.isForMainFrame()) failTvStartup("page_error");
                }
                @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    if (!isTv()) return false;
                    if (closed || view != web) return true;
                    root.removeView(view); view.destroy(); web = null;
                    failTvStartup("renderer_gone"); return true;
                }
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) { return true; }
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                    try { return resource(req); }
                    catch (Exception ignored) { return response(404, "Not Found", "text/plain", new ByteArrayInputStream(new byte[0]), null); }
                }
            });
            web.setWebChromeClient(new WebChromeClient() {
                @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                    if (closed || fullscreen != null || tvStartupFailed || web == null) { callback.onCustomViewHidden(); return; }
                    fullscreen = view; fullscreenCallback = callback;
                    orientationBeforeFullscreen = getRequestedOrientation();
                    if (!getPackageName().equals("io.github.hongguo.tv"))
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                    web.setVisibility(View.GONE); root.addView(view, new FrameLayout.LayoutParams(-1,-1));
                    getWindow().getDecorView().setSystemUiVisibility(5894);
                }
                @Override public void onHideCustomView() { if (!closed) leaveFullscreen(); }
                @Override public boolean onConsoleMessage(ConsoleMessage message) {
                    if (message.message().matches("HG:[A-Za-z0-9_:.-]{1,100}")) android.util.Log.i("HongguoPlayback",message.message());
                    return true;
                }
            });
            root.addView(web, new FrameLayout.LayoutParams(-1,-1));
            if (isTv()) root.postDelayed(tvStartupTimeout, 12000);
            web.loadUrl(ORIGIN + "/index.html");
        } catch (RuntimeException | LinkageError error) {
            if (!isTv()) throw error;
            failTvStartup("webview_init");
        }
    }

    private void leaveFullscreen() {
        if (fullscreen == null) return;
        root.removeView(fullscreen); fullscreen = null;
        if (web != null && !tvStartupFailed) web.setVisibility(View.VISIBLE);
        getWindow().getDecorView().setSystemUiVisibility(0);
        setRequestedOrientation(orientationBeforeFullscreen);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (isTv()) {
            String name = tvKeyName(event.getKeyCode());
            if (name != null && event.getAction() == KeyEvent.ACTION_DOWN && tvObservedKeys.add(event.getKeyCode()))
                android.util.Log.i("HongguoTv", "HG:tv:key_observed:" + name);
            if (tvStartupFailed || web == null) return super.dispatchKeyEvent(event);
        }
        // WebView consumes fullscreen Back before Activity.onBackPressed.
        if (fullscreen != null && !getPackageName().equals("io.github.hongguo.tv") && event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            android.view.WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
            boolean keyboard = android.os.Build.VERSION.SDK_INT >= 30 && insets != null && insets.isVisible(android.view.WindowInsets.Type.ime());
            if (!keyboard) {
                if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) onBackPressed();
                return true;
            }
        }
        if (getPackageName().equals("io.github.hongguo.tv")) {
            String key;
            switch (event.getKeyCode()) {
                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: key = "MediaPlayPause"; break;
                case KeyEvent.KEYCODE_MEDIA_PLAY: key = "MediaPlay"; break;
                case KeyEvent.KEYCODE_MEDIA_PAUSE: key = "MediaPause"; break;
                case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: key = "MediaFastForward"; break;
                case KeyEvent.KEYCODE_MEDIA_REWIND: key = "MediaRewind"; break;
                default: return super.dispatchKeyEvent(event);
            }
            if (event.getAction() == KeyEvent.ACTION_DOWN) web.evaluateJavascript("window.tvKey && window.tvKey(" + JSONObject.quote(key) + "," + (event.getRepeatCount() > 0) + ")", null);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
    @Override public void onBackPressed() {
        if (web == null || tvStartupFailed) { finish(); return; }
        if (loginPanel != null) { closeLogin(); return; }
        if (fullscreen != null && getPackageName().equals("io.github.hongguo.tv")) { leaveFullscreen(); return; }
        web.evaluateJavascript("window.appBack ? window.appBack() : false", result -> {
            if (closed) return;
            if ("true".equals(result)) return;
            if (fullscreen != null) leaveFullscreen(); else finish();
        });
    }
    @Override protected void onPause() {
        if (!closed && web != null && !isInPictureInPictureMode()) {
            web.evaluateJavascript("window.pausePlayback && window.pausePlayback()", null);
            web.onPause();
        }
        super.onPause();
    }
    @Override public void onPictureInPictureModeChanged(boolean inPip, Configuration config) {
        super.onPictureInPictureModeChanged(inPip,config);
        if (closed || web == null) return;
        web.evaluateJavascript("window.__nativePip && window.__nativePip(" + inPip + ")",null);
        if (!inPip && !hasWindowFocus()) web.evaluateJavascript("window.pausePlayback && window.pausePlayback()",null);
    }
    @Override protected void onResume() { super.onResume(); if (!closed && web != null) web.onResume(); }
    @Override protected void onDestroy() {
        closeLogin();
        synchronized (requestLock) { closed = true; workers.shutdownNow(); }
        for (HttpURLConnection c : connections.values()) c.disconnect();
        closeResourceStreams();
        if (isTv()) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (root != null) root.removeCallbacks(tvStartupTimeout);
        if (web != null) { web.removeJavascriptInterface("Native"); web.destroy(); web = null; }
        for (File file : media.values()) if (file.getParentFile().equals(new File(getCacheDir(), "episodes"))) file.delete(); media.clear();
        super.onDestroy();
    }

    private static WebResourceResponse response(int code, String reason, String mime, InputStream stream, Map<String,String> extra) {
        Map<String,String> headers = new HashMap<>(); headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'none'; base-uri 'none'; form-action 'none'");
        if (extra != null) headers.putAll(extra);
        return new WebResourceResponse(mime, null, code, reason, headers, stream);
    }
    private void requireBusinessOpen() {
        if (closed) throw new IllegalStateException("页面业务已结束");
    }
    private InputStream trackResource(InputStream input) throws IOException {
        synchronized (requestLock) {
            if (!closed) {
                InputStream stream = new FilterInputStream(input) {
                    @Override public int read() throws IOException {
                        if (closed) throw new IOException("页面业务已结束");
                        int value = in.read();
                        if (closed) throw new IOException("页面业务已结束");
                        return value;
                    }
                    @Override public int read(byte[] bytes,int offset,int length) throws IOException {
                        if (closed) throw new IOException("页面业务已结束");
                        int count = in.read(bytes,offset,length);
                        if (closed) throw new IOException("页面业务已结束");
                        return count;
                    }
                    @Override public void close() throws IOException { resourceStreams.remove(this); super.close(); }
                };
                resourceStreams.add(stream); return stream;
            }
        }
        input.close(); throw new IOException("页面业务已结束");
    }
    private void closeResourceStreams() {
        for (InputStream input : resourceStreams) try { input.close(); } catch (IOException ignored) { }
        resourceStreams.clear();
    }
    private WebResourceResponse imageResource(URL image) throws Exception {
        HttpURLConnection c;
        synchronized (requestLock) {
            requireBusinessOpen();
            c = open(image,10000); connections.put(c,c);
        }
        try {
            requireBusinessOpen();
            if (c.getResponseCode() != 200) throw new IOException();
            String type = c.getContentType();
            if (type == null || !type.toLowerCase(Locale.ROOT).startsWith("image/")) throw new IOException();
            byte[] data = read(c,2*1024*1024);
            synchronized (requestLock) {
                requireBusinessOpen();
                return response(200,"OK",type.split(";")[0],trackResource(new ByteArrayInputStream(data)),null);
            }
        } finally { c.disconnect(); connections.remove(c); }
    }
    private WebResourceResponse resource(WebResourceRequest req) throws Exception {
        requireBusinessOpen();
        Uri uri = req.getUrl();
        if (!"app.local".equals(uri.getHost())) {
            return imageResource(checked(uri.toString(),true));
        }
        if (!"https".equals(uri.getScheme()) || !"app.local".equals(uri.getHost()) || uri.getPort() != -1) throw new IOException();
        String p = uri.getPath();
        if (p != null && p.startsWith("/media/")) {
            File f = media.get(p.substring(7));
            if (f == null || !f.isFile()) throw new IOException();
            long length = f.length(), start = 0, end = length - 1;
            String range = req.getRequestHeaders().get("Range");
            if (range == null) range = req.getRequestHeaders().get("range");
            boolean partial = range != null;
            if (partial) {
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("bytes=(\\d+)-(\\d*)").matcher(range);
                if (!m.matches()) return response(416,"Range Not Satisfiable","video/mp4", new ByteArrayInputStream(new byte[0]), Collections.singletonMap("Content-Range","bytes */" + length));
                start = Long.parseLong(m.group(1));
                if (!m.group(2).isEmpty()) end = Math.min(end,Long.parseLong(m.group(2)));
                if (start > end) return response(416,"Range Not Satisfiable","video/mp4",new ByteArrayInputStream(new byte[0]), Collections.singletonMap("Content-Range","bytes */" + length));
            }
            InputStream input;
            synchronized (requestLock) {
                requireBusinessOpen();
                FileInputStream file = new FileInputStream(f);
                try { file.getChannel().position(start); input = trackResource(file); }
                catch (Exception error) { file.close(); throw error; }
            }
            final long count = end - start + 1;
            InputStream bounded = new FilterInputStream(input) {
                long left = count;
                @Override public int read() throws IOException { if (left <= 0) return -1; int n = super.read(); if (n >= 0) left--; return n; }
                @Override public int read(byte[] b, int off, int len) throws IOException { if (left <= 0) return -1; int n = in.read(b,off,(int)Math.min(left,len)); if (n > 0) left -= n; return n; }
            };
            Map<String,String> headers = new HashMap<>(); headers.put("Accept-Ranges","bytes"); headers.put("Content-Length",String.valueOf(count));
            if (partial) headers.put("Content-Range","bytes " + start + "-" + end + "/" + length);
            return response(partial ? 206 : 200, partial ? "Partial Content" : "OK","video/mp4",bounded,headers);
        }
        if ("/image".equals(p)) {
            return imageResource(checked(uri.getQueryParameter("url"),true));
        }
        String asset = "/index.html".equals(p) ? "index.html" : "/app.js".equals(p) ? "app.js" : "/style.css".equals(p) ? "style.css" : "/app.css".equals(p) ? "app.css" : "/boot.js".equals(p) ? "boot.js" : isTv() && "/tv-startup.js".equals(p) ? "tv-startup.js" : null;
        if (asset == null) throw new IOException();
        synchronized (requestLock) {
            requireBusinessOpen();
            return response(200,"OK",asset.endsWith("js") ? "application/javascript" : asset.endsWith("css") ? "text/css" : "text/html",trackResource(getAssets().open(asset)),null);
        }
    }

    private static URL checked(String raw, boolean image) throws Exception {
        URI uri = new URI(raw);
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getRawUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) throw new IOException("片源地址不受支持");
        String[] domains = image
            ? new String[]{"fqnovelpic.com","byteimg.com","douyinpic.com","pstatp.com","ibyteimg.com","hongguoduanju.com"}
            : new String[]{"fqnovel.com","snssdk.com","hongguoduanju.com","qznovelvod.com","fqnovelvod.com","douyinvod.com"};
        for (String d : domains) if (host.equalsIgnoreCase(d) || host.toLowerCase(Locale.ROOT).endsWith("." + d)) return uri.toURL();
        throw new IOException("片源地址不受支持");
    }
    private static HttpURLConnection open(URL url, int timeout) throws IOException {
        HttpURLConnection c = (HttpURLConnection)url.openConnection();
        c.setInstanceFollowRedirects(false); c.setConnectTimeout(Math.min(timeout,15000)); c.setReadTimeout(timeout);
        c.setRequestProperty("Accept-Encoding","identity");
        c.setRequestProperty("User-Agent","Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36");
        return c;
    }
    private byte[] read(HttpURLConnection c, int limit) throws IOException {
        return read(c,limit,null);
    }
    private byte[] read(HttpURLConnection c, int limit, IntConsumer progress) throws IOException {
        requireBusinessOpen();
        if (c.getContentLengthLong() > limit) throw new IOException("文件超过本机处理上限");
        try (InputStream raw = trackResource(c.getInputStream()); InputStream in = "gzip".equalsIgnoreCase(c.getContentEncoding()) ? new GZIPInputStream(raw) : raw;
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[32768]; int n, total = 0; long reported = 0;
            while ((n = in.read(buf)) != -1) {
                requireBusinessOpen();
                total += n; if (total > limit) throw new IOException("文件超过本机处理上限"); out.write(buf,0,n);
                long now = android.os.SystemClock.elapsedRealtime();
                if (progress != null && now-reported >= 250) { progress.accept(total); reported = now; }
            }
            if (progress != null) progress.accept(total);
            return out.toByteArray();
        }
    }
    private void reply(int id, JSONObject object) {
        if (!closed) runOnUiThread(() -> { if (!closed && web != null && !tvStartupFailed) web.evaluateJavascript("window.__nativeResponse(" + id + "," + JSONObject.quote(object.toString()) + ")", null); });
    }
    private void progress(int id,int received,long total) {
        if (!closed) runOnUiThread(() -> { if (!closed && web != null && !tvStartupFailed) web.evaluateJavascript("window.__nativeProgress && window.__nativeProgress(" + id + "," + received + "," + Math.max(0,total) + ")",null); });
    }
    private String store(byte[] data, AtomicBoolean flag) throws IOException {
        synchronized (requestLock) {
            requireBusinessOpen();
            synchronized (media) {
                if (closed || (flag != null && flag.get())) throw new IOException("已取消");
                if (data.length < 12 || data.length > MEDIA_LIMIT || data[4] != 'f' || data[5] != 't' || data[6] != 'y' || data[7] != 'p') throw new IOException("视频容器格式不受支持");
                String token = UUID.randomUUID().toString() + ".mp4";
                File file = new File(new File(getCacheDir(),"episodes"),token);
                try (FileOutputStream out = new FileOutputStream(file)) { out.write(data); }
                catch (IOException e) { file.delete(); throw e; }
                media.put(token,file); return token;
            }
        }
    }
    private File privateFile(String name) throws IOException {
        if (!Arrays.asList("account.session", "account.session.tmp", "danmaku.identity").contains(name)) throw new IOException("私有资料名称无效");
        return new File(getFilesDir(),name);
    }
    private void closeLogin() {
        if (loginPanel == null) return;
        android.webkit.CookieManager.getInstance().removeAllCookies(null);
        root.removeView(loginPanel); loginPanel = null;
        if (loginWeb != null) { loginWeb.stopLoading(); loginWeb.destroy(); loginWeb = null; }
    }
    @SuppressLint("SetJavaScriptEnabled")
    private void showLogin() {
        if (closed || loginPanel != null) return;
        loginPanel = new LinearLayout(this); loginPanel.setOrientation(LinearLayout.VERTICAL); loginPanel.setBackgroundColor(Color.WHITE);
        LinearLayout actions = new LinearLayout(this);
        Button cancel = new Button(this); cancel.setText("取消"); cancel.setOnClickListener(view -> closeLogin());
        Button done = new Button(this); done.setText("已完成官网登录"); done.setOnClickListener(view -> {
            if (closed || web == null) return;
            String cookie = android.webkit.CookieManager.getInstance().getCookie("https://hongguoduanju.com");
            android.webkit.CookieManager.getInstance().removeAllCookies(null);
            closeLogin();
            web.evaluateJavascript("window.__nativeAccountCookie && window.__nativeAccountCookie(" + JSONObject.quote(cookie == null ? "" : cookie) + ")",null);
        });
        actions.addView(cancel,new LinearLayout.LayoutParams(0,-2,1)); actions.addView(done,new LinearLayout.LayoutParams(0,-2,2));
        loginPanel.addView(actions);
        loginWeb = new WebView(this);
        WebSettings settings = loginWeb.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        loginWeb.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
                Uri uri = request.getUrl(); String host = uri.getHost();
                return closed || !"https".equals(uri.getScheme()) || host == null || !(host.equals("hongguoduanju.com") || host.endsWith(".hongguoduanju.com"));
            }
        });
        loginPanel.addView(loginWeb,new LinearLayout.LayoutParams(-1,0,1)); root.addView(loginPanel,new FrameLayout.LayoutParams(-1,-1));
        loginWeb.loadUrl("https://hongguoduanju.com/");
    }
    private synchronized SecretKey accountKey() throws Exception {
        synchronized (requestLock) {
            requireBusinessOpen();
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            String alias = "hongguo-personal-account-v1";
            if (!store.containsAlias(alias)) {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
                generator.generateKey();
            }
            return (SecretKey)store.getKey(alias,null);
        }
    }
    public class Bridge {
        @JavascriptInterface public void tvStartup(String code) {
            if (closed || !isTv() || (!"ready".equals(code) && tvFailureReason(code == null ? "" : code) == null)) return;
            runOnUiThread(() -> {
                if (closed || tvStartupFailed || tvStartupFinished) return;
                if (!"ready".equals(code)) { failTvStartup(code); return; }
                tvStartupFinished = true; root.removeCallbacks(tvStartupTimeout);
                android.util.Log.i("HongguoTv", "HG:tv:startup:ready");
            });
        }
        @JavascriptInterface public boolean enterPip(int width,int height) {
            if (closed) return false;
            FutureTask<Boolean> task = new FutureTask<>(() -> {
                if (closed) return false;
                if (isInPictureInPictureMode()) return false;
                if (!getPackageManager().hasSystemFeature("android.software.picture_in_picture")) return false;
                int w = Math.max(1,Math.min(8192,width)), h = Math.max(1,Math.min(8192,height));
                float ratio = (float)w / h;
                Rational aspect = ratio < 0.42f ? new Rational(9,21) : ratio > 2.38f ? new Rational(21,9) : new Rational(w,h);
                return enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(aspect).build());
            });
            runOnUiThread(task);
            try { return task.get(2,TimeUnit.SECONDS); } catch (Exception error) { return false; }
        }
        @JavascriptInterface public void openAccountLogin() {
            if (closed) return;
            runOnUiThread(() -> { synchronized (requestLock) { if (!closed) showLogin(); } });
        }
        @JavascriptInterface public boolean secureStorageAvailable() { if (closed) return false; try { return accountKey() != null; } catch (Exception error) { return false; } }
        @JavascriptInterface public String seal(String text) throws Exception {
            requireBusinessOpen();
            if (text.length() > 512*1024) throw new IOException("账号资料过大");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,accountKey());
            byte[] encrypted = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8)), iv = cipher.getIV();
            byte[] packed = new byte[iv.length + encrypted.length]; System.arraycopy(iv,0,packed,0,iv.length); System.arraycopy(encrypted,0,packed,iv.length,encrypted.length);
            return Base64.encodeToString(packed,Base64.NO_WRAP);
        }
        @JavascriptInterface public String unseal(String text) throws Exception {
            requireBusinessOpen();
            byte[] packed = Base64.decode(text,Base64.DEFAULT);
            if (packed.length < 28 || packed.length > 1024*1024) throw new IOException("账号资料无效");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE,accountKey(),new GCMParameterSpec(128,Arrays.copyOfRange(packed,0,12)));
            return new String(cipher.doFinal(packed,12,packed.length-12),StandardCharsets.UTF_8);
        }
        @JavascriptInterface public String readPrivate(String name) throws Exception {
            synchronized (requestLock) {
                requireBusinessOpen();
                AtomicFile file = new AtomicFile(privateFile(name));
                if (!file.getBaseFile().exists()) return "";
                return Base64.encodeToString(file.readFully(),Base64.NO_WRAP);
            }
        }
        @JavascriptInterface public void writePrivate(String name,String data) throws Exception {
            synchronized (requestLock) {
                requireBusinessOpen();
                if (data.length() > 2*1024*1024) throw new IOException("私有资料过大");
                AtomicFile file = new AtomicFile(privateFile(name)); FileOutputStream out = null;
                try { out = file.startWrite(); out.write(Base64.decode(data,Base64.DEFAULT)); file.finishWrite(out); }
                catch (Exception error) { if (out != null) file.failWrite(out); throw error; }
            }
        }
        @JavascriptInterface public void deletePrivate(String name) throws Exception {
            synchronized (requestLock) {
                requireBusinessOpen();
                File file = privateFile(name); if (file.exists() && !file.delete()) throw new IOException("私有资料删除失败");
            }
        }
        @JavascriptInterface public String random(int n) {
            requireBusinessOpen();
            if (n < 0 || n > 1024) throw new IllegalArgumentException();
            byte[] b = new byte[n]; random.nextBytes(b); return Base64.encodeToString(b,Base64.NO_WRAP);
        }
        @JavascriptInterface public String digest(String algorithm, String data) throws Exception {
            requireBusinessOpen();
            if (!algorithm.equals("md5") && !algorithm.equals("sha512") && !algorithm.equals("sha256")) throw new IllegalArgumentException();
            return Base64.encodeToString(MessageDigest.getInstance(algorithm).digest(Base64.decode(data,Base64.DEFAULT)),Base64.NO_WRAP);
        }
        @JavascriptInterface public String crypt(boolean decrypt, String algorithm, String key, String iv, boolean padding, String data) throws Exception {
            requireBusinessOpen();
            if (!algorithm.equals("aes-128-cbc") && !algorithm.equals("aes-128-ecb") && !algorithm.equals("aes-128-ctr")) throw new IllegalArgumentException();
            boolean cbc = algorithm.endsWith("cbc"), ctr = algorithm.endsWith("ctr");
            if (ctr && padding) throw new IllegalArgumentException();
            Cipher c = Cipher.getInstance("AES/" + (ctr ? "CTR" : cbc ? "CBC" : "ECB") + "/" + (padding ? "PKCS5Padding" : "NoPadding"));
            SecretKeySpec k = new SecretKeySpec(Base64.decode(key,Base64.DEFAULT),"AES");
            if (cbc || ctr) c.init(decrypt ? Cipher.DECRYPT_MODE : Cipher.ENCRYPT_MODE,k,new IvParameterSpec(Base64.decode(iv,Base64.DEFAULT)));
            else c.init(decrypt ? Cipher.DECRYPT_MODE : Cipher.ENCRYPT_MODE,k);
            return Base64.encodeToString(c.doFinal(Base64.decode(data,Base64.DEFAULT)),Base64.NO_WRAP);
        }
        @JavascriptInterface public String gzip(String data) throws IOException {
            requireBusinessOpen();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (GZIPOutputStream gzip = new GZIPOutputStream(out)) { gzip.write(Base64.decode(data,Base64.DEFAULT)); }
            return Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP);
        }
        @JavascriptInterface public void cancel(int id) {
            HttpURLConnection c;
            synchronized (requestLock) {
                if (closed) return;
                AtomicBoolean flag = requests.get(id); if (flag != null) flag.set(true);
                NetworkTrace trace = networkTraces.get(id);
                if (trace != null) trace.log("cancel_" + trace.phase, android.os.SystemClock.elapsedRealtime() - trace.queuedAt);
                c = connections.get(id);
            }
            if (c != null) { c.disconnect(); connections.remove(id,c); }
        }
        @JavascriptInterface public String writeMedia(String data) throws IOException {
            requireBusinessOpen();
            return store(Base64.decode(data,Base64.DEFAULT),null);
        }
        @JavascriptInterface public String decryptSamples(String raw,String rawKey,String rawJobs) throws Exception {
            requireBusinessOpen();
            if (raw.length() > (MEDIA_LIMIT + 2L) / 3 * 4 || rawJobs.length() > 16*1024*1024) throw new IOException("视频处理数据过大");
            byte[] data = Base64.decode(raw,Base64.DEFAULT), key = Base64.decode(rawKey,Base64.DEFAULT);
            if (data.length > MEDIA_LIMIT || key.length != 16) throw new IOException("视频处理数据无效");
            JSONArray jobs = new JSONArray(rawJobs);
            if (jobs.length() > 200000) throw new IOException("视频采样过多");
            long end = 0;
            for (int i=0;i<jobs.length();i++) {
                requireBusinessOpen();
                JSONArray job = jobs.getJSONArray(i);
                long offset = job.getLong(0), size = job.getLong(1);
                if (job.length() != 3 || offset < end || size < 0 || offset > data.length || size > data.length-offset || Base64.decode(job.getString(2),Base64.DEFAULT).length != 8) throw new IOException("视频采样范围无效");
                end = offset + size;
            }
            Cipher cipher = Cipher.getInstance("AES/CTR/NoPadding");
            SecretKeySpec secret = new SecretKeySpec(key,"AES");
            for (int i=0;i<jobs.length();i++) {
                requireBusinessOpen();
                JSONArray job = jobs.getJSONArray(i);
                int offset = job.getInt(0), size = job.getInt(1);
                byte[] iv = new byte[16]; System.arraycopy(Base64.decode(job.getString(2),Base64.DEFAULT),0,iv,0,8);
                cipher.init(Cipher.DECRYPT_MODE,secret,new IvParameterSpec(iv));
                if (cipher.doFinal(data,offset,size,data,offset) != size) throw new IOException("视频采样处理不完整");
            }
            return Base64.encodeToString(data,Base64.NO_WRAP);
        }
        @JavascriptInterface public String readMedia(String token) throws IOException {
            requireBusinessOpen();
            File file = token == null ? null : media.get(token);
            if (file == null || !file.isFile() || file.length() <= 0 || file.length() > MEDIA_LIMIT) throw new IOException("视频文件无效或过大");
            InputStream source;
            synchronized (requestLock) { requireBusinessOpen(); source = trackResource(new FileInputStream(file)); }
            try (InputStream input = source; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[65536]; int count;
                while ((count = input.read(chunk)) >= 0) {
                    requireBusinessOpen();
                    if (output.size() + count > MEDIA_LIMIT) throw new IOException("视频超过大小上限");
                    output.write(chunk,0,count);
                }
                return Base64.encodeToString(output.toByteArray(),Base64.NO_WRAP);
            }
        }
        @JavascriptInterface public long mediaSize(String token) {
            synchronized (requestLock) {
                requireBusinessOpen();
                File file = token == null ? null : media.get(token);
                return file != null && file.isFile() ? file.length() : 0;
            }
        }
        @JavascriptInterface public void deleteMedia(String token) throws IOException {
            synchronized (requestLock) {
                requireBusinessOpen();
                synchronized (media) {
                    File file = token == null ? null : media.get(token);
                    if (file != null && file.exists() && !file.delete()) throw new IOException("视频文件删除失败");
                    if (token != null) media.remove(token);
                }
            }
        }
        @JavascriptInterface public void persistMedia(String token) throws IOException {
            synchronized (requestLock) {
                requireBusinessOpen();
                synchronized (media) {
                    File file = media.get(token);
                    if (file == null || !file.isFile()) throw new IOException("视频缓存已失效");
                    File target = new File(new File(getFilesDir(), "downloads"), token);
                    if (file.equals(target)) return;
                    if (target.exists() || !file.renameTo(target)) throw new IOException("视频保存失败");
                    media.put(token, target);
                }
            }
        }
        @JavascriptInterface public String readState() throws IOException {
            synchronized (requestLock) {
                requireBusinessOpen();
                AtomicFile file = new AtomicFile(new File(getFilesDir(), "mobile-state.json"));
                if (!file.getBaseFile().exists()) return "";
                return new String(file.readFully(), StandardCharsets.UTF_8);
            }
        }
        @JavascriptInterface public void writeState(String value) throws Exception {
            synchronized (requestLock) {
                requireBusinessOpen();
                if (value.length() > 8 * 1024 * 1024) throw new IOException("本机资料超过保存上限");
                JSONObject data = new JSONObject(value);
                if (!data.has("series") || !data.has("tasks") || !data.has("settings") || !data.has("playback")) throw new IOException("资料格式无效");
                AtomicFile file = new AtomicFile(new File(getFilesDir(), "mobile-state.json"));
                FileOutputStream out = null;
                try { out = file.startWrite(); out.write(value.getBytes(StandardCharsets.UTF_8)); file.finishWrite(out); }
                catch (Exception error) { if (out != null) file.failWrite(out); throw error; }
            }
        }
        @JavascriptInterface public void clearMedia() {
            synchronized (requestLock) {
                requireBusinessOpen();
                synchronized (media) {
                    for (Map.Entry<String,File> entry : new ArrayList<>(media.entrySet())) {
                        if (entry.getValue().getParentFile().equals(new File(getCacheDir(), "episodes"))) { entry.getValue().delete(); media.remove(entry.getKey()); }
                    }
                }
            }
        }
        @JavascriptInterface public void awake(boolean value) {
            if (closed) return;
            runOnUiThread(() -> { synchronized (requestLock) {
                if (closed) return;
                if (value) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } });
        }
        @JavascriptInterface public void request(int id, String raw) {
            if (closed || raw.length() > 2 * 1024 * 1024) return;
            final AtomicBoolean flag = new AtomicBoolean(false);
            final NetworkTrace trace = new NetworkTrace(id);
            Runnable task = () -> {
                HttpURLConnection c = null;
                boolean mediaRedirectRejected = false;
                final long startedAt = android.os.SystemClock.elapsedRealtime();
                trace.phase = "starting"; trace.log("start_queue_ms",startedAt - trace.queuedAt);
                try {
                    if (flag.get() || closed) return;
                    JSONObject options = new JSONObject(raw);
                    boolean isMedia = options.optBoolean("media");
                    URL url = checked(options.getString("url"),false);
                    String method = options.optString("method","GET");
                    if (!method.equals("GET") && !method.equals("POST")) throw new IOException("请求方式不受支持");
                    if (isMedia && !method.equals("GET")) throw new IOException();
                    int timeout = Math.max(500, Math.min(isMedia ? 30000 : 15000, options.optInt("timeout",15000)));
                    for (int hops = 0; hops < 4; hops++) {
                        if (flag.get() || closed) return;
                        final long headersStartedAt = android.os.SystemClock.elapsedRealtime();
                        trace.phase = "connecting"; trace.log("connect",headersStartedAt - startedAt);
                        synchronized (requestLock) {
                            if (flag.get() || closed) return;
                            c = open(url,timeout); c.setRequestMethod(method); connections.put(id,c);
                        }
                        if (flag.get() || closed) return;
                        JSONObject headers = options.optJSONObject("headers");
                        if (headers != null) for (Iterator<String> it = headers.keys(); it.hasNext();) {
                            String name = it.next();
                            boolean accountHost = url.getHost().equals("hongguoduanju.com") || url.getHost().endsWith(".fqnovel.com");
                            if (!name.equalsIgnoreCase("Host") && !name.equalsIgnoreCase("Connection") && (!name.equalsIgnoreCase("Cookie") || accountHost && !isMedia) && !name.equalsIgnoreCase("Accept-Encoding")) c.setRequestProperty(name,headers.getString(name));
                        }
                        if (flag.get() || closed) return;
                        if (method.equals("POST")) { c.setDoOutput(true); byte[] body = Base64.decode(options.optString("body",""),Base64.DEFAULT); if (body.length > 1024*1024) throw new IOException(); try(OutputStream out = c.getOutputStream()) { out.write(body); } }
                        if (flag.get() || closed) return;
                        int status = c.getResponseCode();
                        trace.phase = "headers"; trace.log("http_" + status + "_headers_ms",android.os.SystemClock.elapsedRealtime() - headersStartedAt);
                        if (isMedia) android.util.Log.i("HongguoPlayback", "media:" + url.getHost() + ":" + status);
                        if (status >= 300 && status <= 399 && isMedia) {
                            if (!method.equals("GET")) throw new IOException("片源跳转不受支持");
                            String location = c.getHeaderField("Location");
                            URL redirected = null;
                            try {
                                redirected = new URL(url,location);
                                String scheme = "https".equalsIgnoreCase(redirected.getProtocol()) ? "https" : "http".equalsIgnoreCase(redirected.getProtocol()) ? "http" : "other";
                                boolean sameHost = url.getHost().equalsIgnoreCase(redirected.getHost());
                                trace.log("redirect_" + scheme + "_sameHost_" + sameHost,hops + 1);
                                url = checked(redirected.toString(),false);
                            } catch (Exception redirectError) {
                                mediaRedirectRejected = true;
                                String reason = location == null || location.isEmpty() ? "missing_location" : redirected == null ? "invalid_location"
                                    : !"https".equalsIgnoreCase(redirected.getProtocol()) ? "scheme"
                                    : redirected.getUserInfo() != null ? "userinfo"
                                    : redirected.getPort() != -1 && redirected.getPort() != 443 ? "port"
                                    : redirectError instanceof java.net.URISyntaxException ? "invalid_uri" : "host";
                                trace.log("redirect_rejected_" + reason,hops + 1);
                                throw redirectError;
                            }
                            c.disconnect(); continue;
                        }
                        JSONObject result = new JSONObject(); result.put("status",status);
                        JSONObject responseHeaders = new JSONObject();
                        if (c.getHeaderField("Location") != null) responseHeaders.put("location",c.getHeaderField("Location"));
                        if (!isMedia) for (Map.Entry<String,List<String>> entry : c.getHeaderFields().entrySet()) {
                            if (entry.getKey() != null && entry.getKey().equalsIgnoreCase("Set-Cookie")) responseHeaders.put("set-cookie",new JSONArray(entry.getValue()));
                        }
                        result.put("headers",responseHeaders);
                        final long bodyStartedAt = android.os.SystemClock.elapsedRealtime();
                        trace.phase = "reading";
                        if (isMedia) {
                            if (status != 200) {
                                reply(id,new JSONObject().put("error","视频下载失败（HTTP " + status + "）").put("code","HTTP_" + status));
                                return;
                            }
                            final long length = c.getContentLengthLong();
                            byte[] bytes = read(c,MEDIA_LIMIT,received -> progress(id,received,length));
                            if (flag.get() || closed) return;
                            result.put("bytes",bytes.length);
                            if (options.optBoolean("encrypted")) result.put("data",Base64.encodeToString(bytes,Base64.NO_WRAP));
                            else result.put("token",store(bytes,flag));
                        } else {
                            result.put("data", status >= 200 && status < 300 ? new String(read(c,8*1024*1024),StandardCharsets.UTF_8) : "");
                        }
                        trace.log("body_ms",android.os.SystemClock.elapsedRealtime() - bodyStartedAt);
                        trace.phase = "delivering";
                        if (!flag.get()) reply(id,result);
                        return;
                    }
                    throw new IOException("片源跳转次数过多");
                } catch (Exception error) {
                    trace.log("error_" + trace.phase + "_" + error.getClass().getSimpleName(),android.os.SystemClock.elapsedRealtime() - startedAt);
                    android.util.Log.w("HongguoNetwork", error.getClass().getSimpleName());
                    if (!flag.get() && !closed) try {
                        boolean timed = error instanceof java.net.SocketTimeoutException;
                        String category = error instanceof java.net.UnknownHostException ? "DNS" : error instanceof javax.net.ssl.SSLException ? "TLS" : error instanceof java.net.ConnectException ? "CONNECT" : error instanceof SecurityException ? "PERMISSION" : "NETWORK";
                        String message = error instanceof IOException && error.getMessage() != null && (error.getMessage().startsWith("视频") || error.getMessage().startsWith("文件") || error.getMessage().startsWith("片源")) ? error.getMessage() : timed ? "网络超时，请重试" : "网络请求失败（" + category + "），请检查网络后重试";
                        reply(id,new JSONObject().put("error",message).put("code",mediaRedirectRejected && (getPackageName().equals("io.github.hongguo.personal") || isTv()) ? "MEDIA_REDIRECT_REJECTED" : timed ? "ETIMEDOUT" : "ERR_NETWORK"));
                    } catch (Exception ignored) { }
                } finally {
                    trace.log(flag.get() ? "cancelled_total_ms" : "done_total_ms",android.os.SystemClock.elapsedRealtime() - trace.queuedAt);
                    networkTraces.remove(id);
                    if (c != null) c.disconnect(); connections.remove(id); requests.remove(id);
                }
            };
            synchronized (requestLock) {
                if (closed) return;
                networkTraces.put(id,trace); trace.log("queued",0);
                requests.put(id,flag);
                workers.execute(task);
            }
        }
    }
}
