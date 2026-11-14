const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('原生全屏横屏、重复进入、退出恢复方向，保留TV方向且不重载播放器', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/src/main/java/io/github/hongguo/personal/MainActivity.java'), 'utf8');
  const enter = source.slice(source.indexOf('@Override public void onShowCustomView('), source.indexOf('@Override public void onHideCustomView('));
  const leave = source.slice(source.indexOf('private void leaveFullscreen()'), source.indexOf('@Override public boolean dispatchKeyEvent('));
  const back = source.slice(source.indexOf('@Override public void onBackPressed()'), source.indexOf('@Override protected void onPause()')).replace('@Override ', '');
  const dispatchStart = source.indexOf('@Override public boolean dispatchKeyEvent(KeyEvent event) {') + '@Override public boolean dispatchKeyEvent(KeyEvent event) {'.length;
  const phoneBack = source.slice(dispatchStart, source.indexOf('        if (getPackageName().equals("io.github.hongguo.tv")) {', dispatchStart));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-fullscreen-'));
  const java = process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
  try {
    // Execute the real native callback bodies with only Android platform objects stubbed.
    fs.writeFileSync(path.join(directory, 'FullscreenCheck.java'), `
import java.util.*;
class Parent {
  boolean dispatchKeyEvent(Object event) { return false; }
}
class FullscreenCheck extends Parent {
  static class ActivityInfo { static final int SCREEN_ORIENTATION_SENSOR_LANDSCAPE = 6; }
  static class View { static final int GONE = 8, VISIBLE = 0; String result = "false"; int backCalls; void setVisibility(int value) {} void evaluateJavascript(String script, java.util.function.Consumer<String> callback) { backCalls++; callback.accept(result); } }
  static class FrameLayout { static class LayoutParams { LayoutParams(int w, int h) {} }
    void addView(View v, LayoutParams p) {} void removeView(View v) {} }
  static class WebChromeClient { interface CustomViewCallback { void onCustomViewHidden(); } }
  interface CustomViewCallback extends WebChromeClient.CustomViewCallback {}
  static class android {
    static class os { static class Build { static class VERSION { static int SDK_INT = 36; } } }
    static class view { static class WindowInsets { boolean keyboard; boolean isVisible(int type) { return keyboard; } static class Type { static int ime() { return 1; } } } }
    static class util { static class Log { static int i(String tag, String message) { return 0; } } }
  }
  static class KeyEvent { static final int KEYCODE_BACK = 4, KEYCODE_MEDIA_PLAY_PAUSE = 85, KEYCODE_MEDIA_PLAY = 126,
    KEYCODE_MEDIA_PAUSE = 127, KEYCODE_MEDIA_FAST_FORWARD = 90, KEYCODE_MEDIA_REWIND = 89, ACTION_DOWN = 0, ACTION_UP = 1;
    int action; boolean cancelled; KeyEvent(int a, boolean c) { action = a; cancelled = c; } int getKeyCode() { return KEYCODE_BACK; }
    int getAction() { return action; } boolean isCanceled() { return cancelled; } int getRepeatCount() { return 0; } }
  static class Decor { static android.view.WindowInsets insets = new android.view.WindowInsets(); void setSystemUiVisibility(int value) {} android.view.WindowInsets getRootWindowInsets() { return insets; } }
  static class Window { Decor getDecorView() { return new Decor(); } }
  static class Chrome { public void onShowCustomView(View view, CustomViewCallback callback) {} }
  View fullscreen, web = new View(); FrameLayout root = new FrameLayout();
  WebChromeClient.CustomViewCallback fullscreenCallback;
  ${source.match(/private int orientationBeforeFullscreen[^;]*;/)?.[0] || ''}
  boolean closed, tvStartupFailed; Set<Integer> tvObservedKeys = new HashSet<>();
  int orientation = -1, hidden; String packageName = "io.github.hongguo.personal";
  boolean isTv() { return packageName.equals("io.github.hongguo.tv"); }
  String tvKeyName(int code) { return null; }
  int getRequestedOrientation() { return orientation; }
  void setRequestedOrientation(int value) { orientation = value; }
  String getPackageName() { return packageName; }
  Window getWindow() { return new Window(); }
  Chrome chrome = new Chrome() { ${enter} };
  ${leave}
  Object loginPanel; int finished, loginClosed;
  void closeLogin() { loginPanel = null; loginClosed++; }
  void finish() { finished++; }
  ${back}
  boolean dispatchPhoneBack(KeyEvent event) { ${phoneBack} return false; }
  static void check(boolean result, String message) { if (!result) throw new AssertionError(message); }
  public static void main(String[] args) {
    FullscreenCheck activity = new FullscreenCheck();
    for (int previous : new int[]{-1, 1, 4}) {
      activity.orientation = previous;
      activity.chrome.onShowCustomView(new View(), () -> activity.hidden++);
      check(activity.orientation == 6, "fullscreen must request sensor landscape even with portrait lock");
      int beforeDuplicate = activity.hidden;
      activity.chrome.onShowCustomView(new View(), () -> activity.hidden++);
      check(activity.hidden == beforeDuplicate + 1, "duplicate fullscreen must reject its callback");
      activity.leaveFullscreen();
      check(activity.orientation == previous, "exit must restore the previous orientation policy");
      int hidden = activity.hidden;
      activity.leaveFullscreen();
      check(activity.hidden == hidden, "repeated exit must do nothing");
    }
    activity.chrome.onShowCustomView(new View(), () -> activity.hidden++);
    activity.web.result = "true";
    int beforeKey = activity.web.backCalls;
    check(activity.dispatchPhoneBack(new KeyEvent(0, false)), "fullscreen back down must not reach WebView");
    check(activity.web.backCalls == beforeKey, "back only dispatches on release");
    activity.dispatchPhoneBack(new KeyEvent(1, true));
    check(activity.web.backCalls == beforeKey, "cancelled back must not navigate");
    Decor.insets.keyboard = true;
    check(!activity.dispatchPhoneBack(new KeyEvent(1, false)), "keyboard gets first back");
    Decor.insets.keyboard = false;
    activity.dispatchPhoneBack(new KeyEvent(1, false));
    check(activity.fullscreen != null && activity.finished == 0, "dialog back must not leave fullscreen");
    activity.web.result = "false";
    activity.onBackPressed();
    check(activity.fullscreen == null && activity.finished == 0, "unhandled back must leave fullscreen first");
    activity.onBackPressed();
    check(activity.finished == 1, "unhandled root back must finish");
    activity.loginPanel = new Object(); int calls = activity.web.backCalls;
    activity.onBackPressed();
    check(activity.loginClosed == 1 && activity.web.backCalls == calls, "login back must stay isolated");
    activity.packageName = "io.github.hongguo.tv"; activity.orientation = 0;
    activity.chrome.onShowCustomView(new View(), () -> activity.hidden++);
    check(activity.orientation == 0, "TV must keep its manifest landscape policy");
    activity.web.result = "true";
    int tvCalls = activity.web.backCalls;
    activity.onBackPressed();
    check(activity.fullscreen == null && activity.web.backCalls == tvCalls, "TV back retains native fullscreen behavior");
    activity.leaveFullscreen();
    check(activity.orientation == 0, "TV exit must stay landscape");
  }
}
`);
    for (const [command, args] of [
      ['javac', ['-encoding', 'UTF-8', path.join(directory, 'FullscreenCheck.java')]],
      ['java', ['-cp', directory, 'FullscreenCheck']],
    ]) {
      const result = spawnSync(path.join(java, 'bin', command), args, { encoding: 'utf8' });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
    }
    const manifest = fs.readFileSync(path.join(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8');
    assert.match(manifest, /android:configChanges="[^"]*orientation\|screenSize/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
