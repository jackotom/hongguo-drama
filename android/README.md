# 红果短剧 Android TV候选

本发行目录仅提供TV移植，版本跟随根package.json。手机个人版与iOS开发留在独立工作区，不作为TV交付。

在根目录npm ci后，android目录执行npm ci --ignore-scripts，npm test，再执行python3 build.py --tv。需要Android SDK 36、build-tools36.0.0、JDK21；可通过ANDROID_HOME与JAVA_HOME指定。APK位于build/tv/。

共享桌面取源、签名与解密模块；仅红果来源。Android10起、系统WebView100起，单集64MB限制，不支持ByteVC2转换。TV入口、横屏、方向键/确认/返回、媒体按键已实现；必须完成真机遥控器、真实静音播放/切集/后台/缓存验收才能宣称可正式使用。当前无TV连接，device_tested=false。

升级签名材料只存android/.private/tv，保持同一证书；不得提交密钥或密码。原型APK不能替代6.3重建及实机验收。详细状态见../docs/android-tv.md。
