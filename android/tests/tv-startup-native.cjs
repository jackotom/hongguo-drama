// Run unchanged production Java methods on a small host fixture, without an APK.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

module.exports = function nativeStartupRegression(root, scenario = 'all') {
  const source = fs.readFileSync(path.join(root, 'app/src/main/java/io/github/hongguo/personal/MainActivity.java'), 'utf8');
  function method(signature, indent = 4) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`Missing production method: ${signature}`);
    const end = source.indexOf('\n' + ' '.repeat(indent) + '}', start);
    if (end < 0) throw new Error(`Missing method end: ${signature}`);
    return source.slice(start, end + indent + 2);
  }
  const fields = source.split('\n').filter(line => /^    private /.test(line) &&
    /\b(workers|connections|requests|networkTraces|resourceStreams|random|closed|tvStartupFinished|tvStartupFailed|requestLock)\b/.test(line) && !line.includes('(' + ') {')).join('\n');
  const native = [
    'private void failTvStartup(', 'private static String tvFailureReason(',
    'private void reply(', 'private void progress(', '@Override public void onBackPressed(',
    '@Override protected void onPause(', '@Override protected void onDestroy(',
    'private WebResourceResponse resource(', 'private static WebResourceResponse response(',
    'private static URL checked(', 'private File privateFile(', 'private synchronized SecretKey accountKey(',
    'private String store(',
  ].map(s => method(s)).join('\n');
  const helpers = ['private void requireBusinessOpen(', 'private InputStream trackResource(',
    'private void closeResourceStreams(', 'private WebResourceResponse imageResource(']
    .filter(s => source.includes(s)).map(s => method(s)).join('\n');
  const reads = source.split('\n').filter(line => /private (?:static )?byte\[\] read\(/.test(line))
    .map(line => method(line.trim())).join('\n');
  const fixture = fs.readFileSync(path.join(__dirname, 'tv-startup-native.java.txt'), 'utf8')
    .replace('/* PRODUCTION_FIELDS */', fields + (source.includes('private final Object requestLock') ? '' : '\nprivate final Object requestLock = new Object();') + (source.includes('private final Set<InputStream> resourceStreams') ? '' : '\nprivate final Set<InputStream> resourceStreams = ConcurrentHashMap.newKeySet();'))
    .replace('/* PRODUCTION_METHODS */', native + '\n' + helpers + '\n' + reads)
    .replace('/* PRODUCTION_BRIDGE */', source.slice(source.indexOf('public class Bridge {'), source.lastIndexOf('\n}')))
    .replace('/* PRODUCTION_RESUME */', source.split('\n').find(line => line.includes('@Override protected void onResume()')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-tv-startup-'));
  const java = process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
  function run(binary, args) {
    const result = spawnSync(path.join(java, 'bin', binary), args, {encoding: 'utf8', timeout: 20000});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${binary} failed:\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  }
  try {
    fs.writeFileSync(path.join(dir, 'NativeStartupHarness.java'), fixture);
    fs.mkdirSync(path.join(dir, 'android/util'), {recursive: true});
    fs.mkdirSync(path.join(dir, 'android/os'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'android/util/Log.java'), 'package android.util; public class Log { public static int i(String t,String m){return 0;} public static int w(String t,String m){return 0;} }');
    fs.writeFileSync(path.join(dir, 'android/os/SystemClock.java'), 'package android.os; public class SystemClock { public static long elapsedRealtime(){return System.nanoTime()/1000000;} }');
    run('javac', ['-encoding', 'UTF-8', '-d', dir, path.join(dir, 'NativeStartupHarness.java'), path.join(dir, 'android/util/Log.java'), path.join(dir, 'android/os/SystemClock.java')]);
    return run('java', ['-ea', '-Dt1fixture.dir=' + dir, '-cp', dir, 'NativeStartupHarness', scenario]);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
};
