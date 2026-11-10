#!/usr/bin/env python3
"""Build with an installed Android SDK/JDK; no Gradle or remote build service."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / 'build'

def run(args, env=None):
    result = subprocess.run([str(a) for a in args], cwd=ROOT, env=env, text=True, capture_output=True)
    if result.returncode:
        print(result.stdout[-4000:] + result.stderr[-6000:], file=sys.stderr)
        raise SystemExit(result.returncode)
    return result.stdout

def main():
    global BUILD
    tv = '--tv' in sys.argv
    if tv: BUILD = BUILD / 'tv'
    desktop_version = json.loads((ROOT.parent/'package.json').read_text())['version']
    version = desktop_version.removesuffix('.0') if tv else '1.1'
    version_code = int(desktop_version.split('.')[0]) * 10000 + int(desktop_version.split('.')[1]) * 100 if tv else 2
    package_name = 'io.github.hongguo.tv' if tv else 'io.github.hongguo.personal'
    sdk = Path(os.environ.get('ANDROID_HOME', '/opt/homebrew/share/android-commandlinetools'))
    java = Path(os.environ.get('JAVA_HOME', '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home'))
    tools = sdk / 'build-tools' / '36.0.0'
    platform = sdk / 'platforms/android-36/android.jar'
    for file in [java/'bin/javac', tools/'aapt2', tools/'d8', tools/'apksigner', platform]:
        if not file.is_file():
            raise SystemExit(f'缺少构建工具：{file.name}；请设置 ANDROID_HOME／JAVA_HOME，并安装SDK 36与build-tools 36.0.0')
    if not (ROOT/'node_modules/buffer').exists():
        raise SystemExit('先在 android 目录执行 npm ci --ignore-scripts')
    env = {**os.environ, 'JAVA_HOME':str(java)}
    BUILD.mkdir(parents=True,exist_ok=True)
    classes, dex = BUILD/'classes', BUILD/'dex'
    for directory in [classes,dex]:
        if directory.exists(): shutil.rmtree(directory)
        directory.mkdir()
    assets = BUILD/'assets' if tv else BUILD/'mobile-assets'
    resources = BUILD/'res' if tv else ROOT/'app/src/main/res'
    manifest = BUILD/'AndroidManifest.xml' if tv else ROOT/'app/src/main/AndroidManifest.xml'
    if tv:
        shutil.copytree(ROOT/'app/src/main/assets',assets,dirs_exist_ok=True)
        shutil.copytree(ROOT/'app/src/main/res',resources,dirs_exist_ok=True)
        html = (ROOT/'web/index.html').read_text().replace('红果·自用','红果短剧 TV').replace('个人版 1.1',f'TV候选版 {version}').replace('手机实播兼容性待真机验收','电视实播兼容性待真机验收')
        html = html.replace('红果<span class="brand-dot">·</span>自用','红果<span class="brand-dot">·</span>TV')
        html = html.replace('src="app.js"', 'src="tv-startup.js"')
        (assets/'index.html').write_text(html)
        (assets/'style.css').write_text((assets/'style.css').read_text() + '\n' + (ROOT/'tv.css').read_text())
        xml = (ROOT/'app/src/main/AndroidManifest.xml').read_text()
        xml = xml.replace('package="io.github.hongguo.personal"',f'package="{package_name}"').replace('android:versionCode="2"',f'android:versionCode="{version_code}"').replace('android:versionName="1.1"',f'android:versionName="{version}"')
        xml = xml.replace('<application ', '<uses-feature android:name="android.software.leanback" android:required="true" /><uses-feature android:name="android.hardware.touchscreen" android:required="false" /><application android:banner="@drawable/tv_banner" ')
        xml = xml.replace('android:label="红果·自用"','android:label="红果短剧 TV"').replace('android:name=".MainActivity"','android:name="io.github.hongguo.personal.MainActivity" android:screenOrientation="landscape"')
        xml = xml.replace('android.intent.category.LAUNCHER','android.intent.category.LEANBACK_LAUNCHER')
        xml = xml.replace('<application ', '<queries><intent><action android:name="android.intent.action.VIEW" /><data android:mimeType="video/mp4" /></intent></queries><application ')
        manifest.write_text(xml)
        (resources/'drawable/tv_banner.xml').write_text('<layer-list xmlns:android="http://schemas.android.com/apk/res/android"><item android:width="320dp" android:height="180dp"><shape><solid android:color="#171b25" /></shape></item><item android:width="120dp" android:height="120dp" android:gravity="center" android:drawable="@drawable/icon" /></layer-list>')
    run(['node',ROOT/'bundle.cjs',*(['--tv'] if tv else [])],env)
    if not tv: run(['node',ROOT/'mobile/bundle.cjs'],env)
    shutil.copy2(ROOT.parent/'build/icon.png',resources/'drawable/icon.png')
    for name in ['LICENSE','NOTICE','THIRD-PARTY-NOTICES.md']:
        shutil.copy2(ROOT.parent/name,assets/name)
    notices = []
    for dependency in ['buffer','base64-js','ieee754',*(['react','react-dom','scheduler'] if not tv else [])]:
        package_dir = (ROOT.parent if dependency in ['react','react-dom','scheduler'] else ROOT)/'node_modules'/dependency
        dependency_version = json.loads((package_dir/'package.json').read_text())['version']
        notices.append(f'{dependency} {dependency_version}\n' + (package_dir/'LICENSE').read_text())
    (assets/'ANDROID-DEPENDENCIES.txt').write_text('\n\n'.join(notices))
    run([tools/'aapt2','compile','--dir',resources,'-o',BUILD/'resources.zip'],env)
    unsigned = BUILD/'unsigned.apk'
    run([tools/'aapt2','link','-o',unsigned,'-I',platform,'--manifest',manifest,'-A',assets,BUILD/'resources.zip'],env)
    sources = list((ROOT/'app/src/main/java').rglob('*.java'))
    boot = str(platform) + os.pathsep + str(tools/'core-lambda-stubs.jar')
    run([java/'bin/javac','-encoding','UTF-8','-g:none','-source','8','-target','8','-bootclasspath',boot,'-d',classes,*sources],env)
    run([tools/'d8','--min-api','29','--lib',platform,'--output',dex,*classes.rglob('*.class')],env)
    with zipfile.ZipFile(unsigned,'a',compression=zipfile.ZIP_DEFLATED) as apk:
        for file in dex.glob('*.dex'): apk.write(file,file.name)
    aligned = BUILD/'aligned.apk'
    run([tools/'zipalign','-f','4',unsigned,aligned],env)
    private = ROOT/'.private'/('tv' if tv else ''); private.mkdir(mode=0o700,parents=True,exist_ok=True)
    password = private/'password'; keystore = private/'install.p12'
    if not keystore.exists():
        if password.exists(): raise SystemExit('已有签名密码但密钥缺失，停止；请恢复原密钥以保留升级能力')
        password.write_text(secrets.token_hex(32)); password.chmod(0o600)
        run([java/'bin/keytool','-genkeypair','-alias','personal','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=Personal Android','-storetype','PKCS12','-keystore',keystore,'-storepass:file',password,'-keypass:file',password],env)
        keystore.chmod(0o600)
    output = BUILD/(f'hongguo-downloader-{version}-android-tv-dev.apk' if tv else 'hongguo-personal-1.1.apk')
    run([tools/'apksigner','sign','--ks',keystore,'--ks-key-alias','personal','--ks-pass',f'file:{password}','--out',output,aligned],env)
    signature = run([tools/'apksigner','verify','--verbose','--print-certs',output],env)
    package = run([tools/'aapt','dump','badging',output],env)
    expected = f"package: name='{package_name}' versionCode='{version_code}' versionName='{version}'"
    if expected not in package or "sdkVersion:'29'" not in package or "targetSdkVersion:'34'" not in package:
        raise SystemExit('APK包信息不符合预期')
    checksum = hashlib.sha256(output.read_bytes()).hexdigest()
    if tv and ("leanback-launchable-activity:" not in package or "uses-feature-not-required: name='android.hardware.touchscreen'" not in package):
        raise SystemExit('TV入口或无触屏声明缺失')
    (BUILD/'verification.json').write_text(json.dumps({'file':output.name,'sha256':checksum,'bytes':output.stat().st_size,'package':package_name,'version':version,'minSdk':29,'targetSdk':34,'signature_verified':True,'device_tested':False,'source_version':desktop_version,'candidate':tv},ensure_ascii=False,indent=2)+'\n')
    (BUILD/'signature.txt').write_text(signature)
    print(f'APK构建与签名校验通过：{output.name} ({output.stat().st_size} bytes)')
    print(f'SHA256 {checksum}')

if __name__ == '__main__': main()
