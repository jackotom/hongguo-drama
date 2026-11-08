# Android TV源码移植

用户于2026-11-06要求直接使用项目源码移植Android TV，今后与双Mac、Windows、Linux共用版本一次发行。

## 实现范围

在已有`android/`工程增加TV构建口味；共享`src/native/`取源、签名、匿名设备、目录／搜索与MP4解密，复用安卓HTTPS／密码／缓存桥和现有页面业务，不另建取源协议。TV专用文件为`android/web/tv.js`、`android/web/tv-navigation.js`和`android/tv.css`。

TV构建入口：`python3 android/build.py --tv`，或`npm --prefix android run build:tv`。从根`package.json`读取公开版本；TV的versionCode由主版本和次版本计算，手机个人版不改版本。独立包名`io.github.hongguo.tv`，与个人手机版资料隔离；Leanback启动入口、声明不需要触屏、固定横屏。构建暂沿用最低Android10及系统WebView要求，不承诺更老电视兼容。

方向键按控件几何位置移动，确认键打开按钮；输入框保留左右编辑，倍速选择保留系统操作。支持独立播放／暂停、前后10秒、页面内全屏及返回退出全屏／说明／详情。后台仍暂停，收藏与观看记录仅在本机。TV原生媒体按键桥仅在TV包启用，手机版行为保持原入口。

构建中间文件、APK及回执在`android/build/tv/`，签名材料在已忽略的`android/.private/tv/`，不上传私钥／密码。当前是本地开发签名候选，不代表已经完成正式发行签名管理。保持同包升级须保留签名材料；正式发布前明确并固定发行证书。

## 完成边界

本轮验证：`npm --prefix android test`共8项通过（6项共享核心、2项TV焦点／媒体按键）；`python3 android/build.py --tv`完成Java编译、DEX、资源打包、APK对齐及开发签名校验，核对独立包名、6.0版本、Android10最低版本、TV入口与不需要触屏声明。首次构建的版本校验拦住了依赖版本覆盖应用版本的变量问题，修复后重建通过。

当前产物：`android/build/tv/hongguo-downloader-6.0-android-tv-dev.apk`，136165字节，SHA256 `d197e4a790dc55984885d244945165b8654006982f2ec9d41968ffccda4da966`。回执`android/build/tv/verification.json`保留`device_tested=false`。自动测试验证算法和桥接边界，未证明实际电视上的方向键、系统倍速选择、输入法、播放解码或缓存清理全流程。

当前工作区为6.0，TV候选文件名含`android-tv-dev`。远端6.1已发布，正式TV发行前必须先整合最新冻结源码，不能把当前候选标成6.1或回填已发布6.0。未发布或推送本轮修改，未更换任何正式安装。

继承安卓现有限制：完整单集准备后播放、64MB上限、H.264／HEVC依赖设备解码；没有ByteVC2转换、账号云收藏／预约、NAS或离线下载库。桌面原生能力不能仅靠共享JavaScript自动移植，后续必须逐项完成并按平台说明。

验收路线：TV启动器 → 遥控器发现／搜索／分页 → 详情 → 选集 → 真实下载 → 静音播放／暂停／快进／倍速／全屏 → 返回 → 连播 → 后台暂停 → 返回续播 → 离开清缓存。按项目规则独立测试资料、随机真实红果素材、先确认静音。未连接TV、未执行上述实机流程前，必须标为待TV真机验收，手机／桌面结果不能替代。
