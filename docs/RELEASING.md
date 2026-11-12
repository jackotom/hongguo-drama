# 同步发行规则

7.1为本轮发行候选（内部7.1.0、桌面构建7.1.2），尚未公开，当前正式版为7.0。修复#148恢复／重试同剧原队列槽位内按集号升序、#147临时文件身份精确持久化，采纳anupam-orbis的#140依赖锁更新（follow-redirects 1.16.3），并完整致谢历史代码贡献者、PR提交者和Issue作者。新增#149默认关闭的显卡加速格式转换，ByteVC2仍由CPU解码；Mac使用VideoToolbox，Windows／Linux仅尝试NVIDIA NVENC，不支持或失败时提示并回退CPU，实体NVIDIA尚未验收。#92、#143和#129保留已有覆盖及安全边界，不整块覆盖当前实现。五类新包及本轮必要验收齐备后一次公开；双Mac新签名、公证、装订，不替换本机正式安装。状态与待验门槛见[7.1记录](release-7.1.md)。

7.1高性能模式须用本轮新媒体包验收当前真实输入探测、明确CPU回退及取消／输入／存储保护，不能沿用旧候选的三条已取消CI。双Mac Librempeg按新脚本重建；Windows／Linux的FFmpeg和Librempeg须启用NVENC，并在原9份对应源码归档中包含固定nv-codec-headers源码、准备脚本和完整MIT许可，不增加独立发行附件。实体NVIDIA未实跑时如实标明，不外推普通CI的CPU回退结果。

7.0已于2026-11-11 21:41:46（Asia/Shanghai）正式公开并设Latest，内部7.0.0、桌面构建7.0.1，冻结源码`3f5927d0d605ff7742fde8cbd1bb92ffe951b080`。双Mac、Windows x64、Linux x64 AppImage、Docker amd64五类共25份正式附件；双Mac已签名、公证、装订，Windows EXE未签名且App真实下载队列未测，Intel仅Rosetta。未运行通用全量测试，未替换本机正式安装；TV与手机独立。完整回执见[7.0记录](release-7.0.md)。

6.9已于2026-11-11 19:04:15（Asia/Shanghai）正式公开并设Latest，内部6.9.0、桌面构建6.9.4，冻结源码`b364419c2b81da3a7e28fd637011aaff9b8acf2c`。双Mac、Windows x64、Linux x64 AppImage、Docker amd64五类共25份正式附件，远端大小／SHA256、两份更新清单及总校验清单已回读核对；119个本轮临时分段已全部清理，10个匿名下载入口及完整总清单核对通过。双Mac已签名、公证、装订；Windows EXE未签名、App真实下载队列未测，Intel仅Rosetta；保留两项基线断言失败。未替换本机正式安装，TV与手机独立。 详见[6.9记录](release-6.9.md)。

6.8已于2026-11-11 10:17:07（Asia/Shanghai）正式公开并设Latest，内部6.8.0、桌面构建6.8.2，冻结源码`e06828f0c81392fb572a5feda6cec54dba643251`。双Mac、Windows x64、Linux x64 AppImage、Docker amd64统一共25附件，远端大小／SHA256与更新及总校验清单已回读核对。双Mac本轮新签名、公证、装订；Windows EXE未签名，Intel仅Rosetta。未替换本机正式安装。 详见[6.8记录](release-6.8.md)。

6.7已于2026-11-11 00:03:04（Asia/Shanghai）正式公开并设Latest，内部6.7.0、桌面构建6.7.1，冻结源码`43c7b4c8fa98df3b1b7902713788641f9d325e2b`。双Mac、Windows x64、Linux x64 AppImage、Docker amd64五类共25附件，远端大小与SHA256及更新清单已核对。双Mac签名、公证、装订；Windows两集各10秒静音实播及安装/重装/升级资料保留、Linux两集CPU静音播放、Docker两集1080P下载合并/认证/重启持久化通过。Windows EXE未签名，Intel Mac仅Rosetta；未替换本机正式安装，TV和手机不随本次发行。 详见[6.7记录](release-6.7.md)。

6.6已于2026-11-10 21:06:07（Asia/Shanghai）公开并设Latest，内部6.6.0、桌面构建6.6.1，冻结源码`d0410c8ef7b02a087f5c16eb026e0ece61454115`。双Mac、Windows、Linux、Docker与TV共26附件；双Mac新签名/公证/装订，Windows EXE未签名。本轮按用户要求未进行新的功能、界面、播放、安装升级、单元或设备测试；**TV版未测试，请用户自行测试**。不把构建成功或此前开发检查当作实播恢复证明，未替换本机正式安装。 详见[6.6记录](release-6.6.md)。

## 6.6本轮授权例外

2026-11-10用户明确：先修播放问题，再将双Mac、Windows、Linux、Docker与TV同一版本公开；不进行新功能/界面/安装/播放/真机测试，TV版未测试，请用户自行测试。新包仍须同一冻结源码构建，签名、公证、源码和摘要如实核对；旧开发检查不是最终包验收。此前不包含TV和必须实播的门槛在本轮依此明确指令处理，未获豁免的发布完整性要求保留。

6.5已于2026-11-09 18:50:43（Asia/Shanghai）正式公开并设Latest，内部6.5.0、桌面构建6.5.1，冻结源码`b99555519d97065b16753cd66326eb62894ec34a`。双Mac、Windows、Linux AppImage、Docker五类产物统一发行，25附件远端大小与SHA256、更新清单和精确源码已核对。双Mac签名、公证、装订；Windows播放/安装/升级与Linux真实静音播放、Docker真实下载合并及重启持久化通过；#124实际鼠标唤醒、真实续播、手动暂停和重启记忆通过。Windows EXE未签名，x64 Mac仅Rosetta，未验飞牛硬件；未替换本机正式安装。 见[6.5说明](release-6.5.md)。

6.4已于2026-11-09 00:00:50（Asia/Shanghai）正式公开并设Latest，内部6.4.0、桌面构建6.4.1，冻结源码`12fa10087059be49d8f7d9895bae260130fe0e1f`。本次按明确授权发布双Mac、Windows、Linux四平台，TV继续开发、候选APK不公开；后续默认五平台规则保留。23附件远端大小/SHA256及两份更新清单已核对；双Mac签名、公证、装订与最终DMG/更新ZIP验收通过；Windows真实素材便携播放及安装升级验收通过但EXE未签名；Linux原生Ubuntu CI以CPU软件解码完成两集真实下载与静音播放。Mac两集静音播放及中英文切换、播放器保留、重载记忆通过；x64经Rosetta启动，不等于实体Intel验收。未替换本机正式安装。 见[6.4说明](release-6.4.md)。

6.3已于2026-11-08 19:46:30（Asia/Shanghai）正式公开并设Latest，内部6.3.0、桌面构建6.3.1，冻结源码`13a07e30f1e4ec5b4dd4fcc73871bc097d09d816`。用户明确授权本次先双Mac、Windows、Linux四平台，TV未实机验收、候选APK不公开。23附件远端大小/SHA256及两份更新清单已核对；双Mac签名/公证/装订，Windows便携11项和安装升级9项通过但EXE未签名；Linux原生Ubuntu CI提取AppImage后，以CPU软件解码播放两集新下载1080p红果素材各10秒。Mac真实两集静音播放及x64 Rosetta启动通过；未替换正式安装。 这是本轮明确例外；后续默认五平台规则保留。详见 [6.3说明](release-6.3.md)。

## 当前规则：五平台齐备后一次发布

2026-11-09用户明确更新：从6.5起，Docker服务端替换Android TV发行项。五类产物为双Mac、Windows x64、Linux x64 AppImage、Docker服务端；TV源码保留但不再构建发布。Docker须验证认证/路径隔离、真实搜索→批量下载→合并、任务持久化和容器重启，附镜像及部署说明、对应源码和SHA256。以下2026-11-06规则涉及TV部分由本条替代，其余发行门槛仍有效。

用户于2026-11-06明确要求：每个后续正式版本同时提供macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage、Android TV APK。五个平台共用公开版本、标签和一次Release，构建号独立递增。Android TV直接移植本项目源码，复用现有取源、签名与解密；手机个人版保持独立版本，不作为TV正式包。

按“冻结统一源码 → 各平台构建及验收 → Draft汇总五平台包、更新清单、对应源码、许可与SHA256 → 核对远端附件版本／大小／摘要 → 一次公开并设Latest”执行。任一平台缺包或缺少必要验收时保留Draft，记录阻碍；不得先公开部分平台、再另跳版本补齐。例外须用户明确授权。已发布的历史标签和资产保持不变。

6.4已正式发布；后续文档提交不改变冻结标签与已发布安装包。6.3历史回执保留。

6.2优化版已于2026-11-07 19:17:14（Asia/Shanghai）正式发布，四平台23附件已核对；冻结`affc81c7f885bcdbcbc06e4c205b820c61f9c0c4`。双Mac签名、公证、装订，Windows安装升级通过但EXE未签名，Linux启动通过、实际播放未验。未替换正式安装。详见[6.2说明](release-6.2.md)。

6.1 已于 2026-11-06 13:26（Asia/Shanghai）正式发布，内部 `6.1.0`，标签 `v6.1` 并设为 Latest。冻结源码 `a93793dea2f13864e8a56771bb6bea05ea6ddbb6`；后续文档提交不改变冻结标签和安装包。23份附件远端大小与SHA256逐项一致。 Mac签名/公证/装订，Windows安装升级通过；Linux启动通过、实际播放未验。详见 [6.1说明](release-6.1.md)。

6.0 已于 2026-11-05 21:59（Asia/Shanghai）正式发布，内部 `6.0.0`，标签 `v6.0` 并设为Latest；冻结源码 `c51b9e9378c27b5e84cd201a84b2df2a7a99579f`。降低ByteVC2兼容转换并发与线程占用，当前播放优先，保留后两集预缓存、切集复用和自动连播。三端19附件远端大小/SHA256与10个匿名下载入口通过；双Mac App/DMG四份Apple Accepted、Developer ID签名与装订通过；Windows便携11项、安装/重装及真实1.80升级资料保留9项通过，EXE未签名。323单元/108平台、源码CI42030393234及Windows CI42030558184通过。本机同一真实ByteVC2片段平均核心占用降低约56%，不代表Windows整机表现；最终arm64包真实两集静音自动交接和x64 Rosetta启动退出通过。未替换本机正式安装。 详见 [6.0说明](release-6.0.md)。

5.9 已于 2026-11-05 18:24（Asia/Shanghai）正式发布，标签 `v5.9` 并设为Latest；冻结源码 `6f7dc3be99bba5ad1975cd28317658a06083a696`。三端19附件远端大小/SHA256一致；双Mac App与DMG四份新Apple Accepted、Developer ID签名、装订、只读挂载和最终更新ZIP恢复通过。源码CI42006135704通过319单元/108平台；Windows CI42006238343便携11项、安装/重装及真实1.80升级资料保留9项通过，EXE未签名。最终arm64包随机真实下载两集1080P HEVC/AAC并全程静音播放，两倍速自动交接后覆盖层hidden、视频帧已提交；x64经Rosetta启动退出通过，原生截图工具超时，不是实体Intel验收。未替换本机正式安装。 详见 [5.9说明](release-5.9.md)。

5.8 已于 2026-11-05 12:29（Asia/Shanghai）正式发布，标签 `v5.8` 并设为Latest；冻结源码 `9b0e2db7c48e6df985e285e951e2bc6ee037d737`。三端19附件远端大小／SHA256与10匿名下载入口通过。双Mac App／DMG四份新Apple Accepted、Developer ID签名、装订、只读挂载及最终更新ZIP恢复通过。源码CI41964533949与WindowsCI41964672253成功，Windows便携11项及安装／重装／真实1.80升级资料保留9项通过，EXE未签名。最终arm64包随机真实下载两集1080P HEVC／AAC，均静音播放9.3秒暂停；详情展开收起、窄窗口、双击全屏保暂停、空格短按／长按和设置改键已验。x64经Rosetta启动退出通过，不是实体Intel验收。未替换本机正式安装。 变化与边界见 [5.8说明](release-5.8.md)。

5.7 已于 2026-11-04 20:56（Asia/Shanghai）正式发布，GitHub 标签 `v5.7`，并设为 Latest。冻结源码 `8bbb352fc17acfd183fd72b116f028b99c14bd9f`。三端19附件远端大小与SHA256一致；双Mac App／DMG四份Apple公证Accepted、Developer ID签名与装订、只读挂载及最终更新ZIP核对通过。源码CI `41824523371` 与Windows CI `41824531981` 通过；Windows便携真实素材静音播放、新安装、同版本重装及真实1.80升级资料保留通过，EXE未签名。最终arm64包随机真实下载两集1080P HEVC／AAC，分别在10.5／10.6秒暂停；x64签名组件在Rosetta下完整转换真实136.997秒ByteVC2为1080P H.264，耗时约60.7秒。未替换本机正式安装。 变化与边界见 [5.7说明](release-5.7.md)。

5.6 已于 2026-11-04 13:15（Asia/Shanghai）正式发布，GitHub 标签 `v5.6`，并设为 Latest。冻结源码 `eaae8daac496a27608d75653c86237a699c5d22c`。三端16附件远端大小与SHA256一致；双Mac App／DMG四份Apple公证Accepted、Developer ID签名与装订、最终DMG只读挂载及更新ZIP还原核对通过。Windows build-only CI `41774585813` 成功，安装和便携包源码、依赖与前端核对通过（源码及HTML仅CR/LF差异），EXE未签名、未运行安装／升级测试。最终arm64包随机真实下载两集1080P HEVC／AAC，静音播放暂停及本轮交互检查通过；第1集13.1秒、第2集38.6秒暂停，后者因工具往返超过10秒目标。未替换本机正式安装。 修复与验证边界见 [5.6说明](release-5.6.md)。

5.5（内部 `5.5.0`）已于 2026-11-03 20:59（Asia/Shanghai）正式发布，标签 `v5.5`，冻结源码 `4c0855dc9fe28d06ac09cac48f24f6a4179a6928`。修复播放身份复用与受校验备用取源、NAS 下载安全，简化下载资料并完善单集评论与本机互动。三端16附件大小/SHA256匹配；双Mac签名、四份Apple公证Accepted/装订、只读挂载和更新ZIP恢复核对通过。Windows build-only CI41637195985成功，EXE未签名；本轮按用户要求未重跑功能、单元、集成、桌面及硬件测试，旧候选测试不代表新修复。详见 [5.5说明](release-5.5.md)。

5.4（内部 `5.4.0`）已于 2026-11-02 18:25（Asia/Shanghai）正式发布，标签 `v5.4`，冻结源码 `e7595c040d328655212a2fb0b315286a6ee914b2`。恢复播放请求签名，增加官网登录、按剧清缓存、观看记录分组与 DLNA 单集投屏。三端16附件远端大小及SHA256匹配；双Mac App与DMG四份Apple公证Accepted、签名/装订、只读挂载与更新ZIP恢复通过。源码CI41425248571、Windows CI41425313110通过232单元及102平台检查；Windows便携11项、安装/重装/真实1.80升级资料保留9项通过，EXE未签名。最终arm64包随机真实两集1080P HEVC/AAC下载和静音约10秒播放通过；x64 Rosetta启动退出通过。 详见 [5.4说明](release-5.4.md)。

5.3（内部 `5.3.0`）已于 2026-11-01 10:07（Asia/Shanghai）正式发布，标签 `v5.3`，冻结源码 `4be719b775b4cc92233bde9e9f7790462ba87e2d`。新增下载到 NAS、同层封面/简介/NFO、规范分集命名与复用补齐。三端16附件远端大小和SHA256匹配；双Mac App与DMG四份Apple公证Accepted、签名/装订、DMG只读挂载及更新ZIP恢复通过。源码CI 41262056747、Windows CI 41262074332 通过215单元和100平台检查；Windows便携11项、安装/重装/真实1.80升级资料保留9项通过，EXE未签名。最终arm64包真实两集NAS下载、同层7文件、原生打开目录和静音约10秒播放通过；x64经Rosetta界面启动、正常退出通过。 详见 [5.3说明](release-5.3.md)。

5.2（内部 `5.2.0`）已于 2026-10-31 15:32（Asia/Shanghai）正式发布，标签 `v5.2`，冻结源码 `cadd99f28b6225ff873b5b7a3c836a71a4933730`。修复 macOS 普通主窗口位置和大小恢复。三端16项附件远端SHA256与大小匹配；双Mac App及DMG四份Apple公证Accepted、签名和装订，最终DMG只读挂载与更新ZIP恢复通过；源码CI 41179681402 与Windows CI 41179708157 通过215单元及98平台检查。最终arm64包窗口恢复、随机真实两集静音播放和x64 Rosetta启动退出通过；10个匿名下载入口通过。Windows EXE未签名。 详见 [5.2说明](release-5.2.md)。

5.1（内部 `5.1.0`）已于 2026-10-30 18:20（Asia/Shanghai）正式发布，标签 `v5.1`，冻结源码 `2f241b1dc096b089a060f01e4aca466111a5fbf8`。三端16项附件远端SHA256与大小匹配；双Mac App及DMG完成Developer ID签名、Apple公证Accepted和装订，最终DMG只读挂载与包内匹配通过；源码CI 41037730494 与Windows CI 41037730786 通过。10个匿名下载入口、最终包账号导航、真实素材静音播放与x64 Rosetta启动通过。Windows EXE未签名。 详见 [5.1说明](release-5.1.md)。

5.0（内部 `5.0.0`）已于 2026-10-30 15:21（Asia/Shanghai）正式发布，标签 `v5.0`，冻结源码 `1fa218a196478c9bd3908bea9666bc23f23b921f`。三端 16 项附件及其远端 SHA256、大小匹配；双 Mac App 与 DMG 的 Developer ID 签名、Apple 公证 Accepted、票据装订、最终 DMG 只读挂载及包内文件匹配通过；源码 CI 41016309687 与 Windows CI 41016337531 均通过；10 个匿名下载入口、Mac x64 Rosetta 启动、真实素材播放和观看记录界面验收通过。Windows EXE 未签名。 详见 [5.0说明](release-5.0.md)。

4.9（内部 `4.9.0`）已于 2026-10-30 13:17（Asia/Shanghai）正式发布，标签 `v4.9`，冻结源码 `803796d29cfcb5ac5e5efb3861f46a198e4d3dba`。三端16项附件远端SHA256与大小逐项匹配。双Mac App/DMG完成Developer ID签名、Apple公证Accepted与装订；Windows CI41005635075通过真实素材便携播放、安装、重装和1.80升级资料保留，EXE未签名。 详见 [4.9说明](release-4.9.md)。

4.8（内部 `4.8.0`）已于 2026-10-30 09:22（Asia/Shanghai）正式发布，标签 `v4.8`，冻结源码 `6f2d20f10df4892aa88a9942096545dfef489539`。三端16项附件远端SHA256和大小逐项匹配。双Mac App/DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI40983555096完成真实素材便携播放、安装、重装和1.80升级资料保留，EXE未签名。 详见 [4.8说明](release-4.8.md)。

4.7（内部 `4.7.0`）已于 2026-10-29 21:11（Asia/Shanghai）正式发布，标签 `v4.7`，冻结源码 `4aa23b0e620b51a9cc146ccf11e84e95149eb79b`。三端16项附件远端SHA256和大小逐项匹配。双Mac App/DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI40877020607完成真实素材便携播放、安装、重装和1.80升级资料保留，EXE未签名。 详见 [4.7说明](release-4.7.md)。

4.6（内部 `4.6.0`）已于 2026-10-29 17:07（Asia/Shanghai）正式发布，标签 `v4.6`，冻结源码 `e2fa54725fb8d60f8982053206e43b18d83cd829`。三端16项附件的远端SHA256与大小逐项匹配。双Mac App/DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI40844214407完成便携播放、安装、重装和真实1.80升级资料保留，EXE未签名。 详见 [4.6说明](release-4.6.md)。

4.5（内部 `4.5.0`）已于 2026-10-29 15:09（Asia/Shanghai）正式发布，标签 `v4.5`，冻结源码 `1ad8701d6be0950d5f9ba6f5ce8029df22490843`。三端16项附件远端SHA256与大小逐项匹配。双Mac App/DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI40831162089安装、重装、真实1.80升级资料保留与静音真实素材播放检查通过，EXE未签名。 详见 [4.5说明](release-4.5.md)。

4.4（内部 `4.4.0`）已于 2026-10-29 13:44（Asia/Shanghai）正式发布，标签 `v4.4`，冻结源码 `23860cfde09d953a7b1f1cbe9e20b433dd4b0e18`。三端 16 项附件远端 SHA256 与大小逐项匹配。双 Mac App/DMG 已完成 Developer ID 签名、Apple 公证 Accepted 和装订；Windows CI 40822817019 的便携播放、安装、重装和真实 1.80 升级资料保留通过，EXE 未签名。 详见 [4.4说明](release-4.4.md)。

上一正式版为 **4.3**（内部 `4.3.0`）。4.3（内部 `4.3.0`）已于 2026-10-28 20:26（Asia/Shanghai）正式发布，标签 `v4.3`。冻结源码 `81f354d48e1c163eb9b5b419cd5faa855f5fd1da`；三端16项附件远端SHA256与大小逐项匹配，10个匿名入口通过。双Mac App与DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI 40672013430便携媒体、安装、重装和真实1.80升级资料保留检查通过，EXE未签名。详见 [4.3说明](release-4.3.md)。

4.2（内部 `4.2.0`）为上一正式版，发布日期 2026-10-28 10:46（Asia/Shanghai），回执保留于 [4.2说明](release-4.2.md)。

上一正式版为 **4.1**。4.1（内部 `4.1.0`）已于 2026-10-27 20:30（Asia/Shanghai）正式发布，标签 `v4.1`。冻结源码 `f210689c4adbf0986e3412cdb12a1c710c5dd611`；三端16项附件远端SHA256与大小逐项匹配。双Mac App与DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI 40501675311便携媒体、安装、重装和真实1.80升级资料保留检查通过，EXE未签名。详细功能、来源开关及验证边界见 [4.1说明](release-4.1.md)。

上一正式版为 **4.0**，原回执保留在 [4.0说明](release-4.0.md)。

上一正式版为 **3.9**（内部 `3.9.0`，标签 `v3.9`）。三端 16 项附件已发布；Mac 已签名、公证和装订，Windows CI 已通过。详细变化、回执及验证边界见 [3.9 说明](release-3.9.md)。

从 1.1.9 起，一轮更新共用一个版本：Mac Apple Silicon arm64、Mac Intel x64、Windows x64。不得按平台独立跳号。本机未公开测试版不另算发行。
当前规则（自 2.0 起）：所有面向用户的版本、GitHub 标签、发行标题及下载文件名只使用两段版本，例如 `2.0`、`2.1`，不发布第三段补丁版本。版本按整数段比较，不按小数或字符串排序；按“逢 9 进 1”，3.9 的下一版为 4.0，再下一版为 4.1，之后为 4.2。electron-builder 和更新器要求 SemVer，因此仅机器读取的包配置和更新清单保留末尾 `.0`（本分支 `7.1.0`）；这是同一版本的内部格式，不是另一个公开版本。平台构建号独立递增。版本比较及公开命名回归：`node scripts/check-release-version.cjs`，包含 3.9 → 4.0 → 4.1 → 4.2、5.8 → 5.9 → 6.0 与公开／内部相等版本场景。

历史版本曾使用每次增加 0.1 及下列指定例外；后续以以上整数段顺序为准。

1.71 为用户明确指定的例外：从 1.7 增加 0.01，三段配置使用 `1.71.0`。

1.72 同样按本次明确要求增加 0.01，三段配置使用 `1.72.0`。

1.74 按本次明确要求从公开 1.73 增加 0.01，三段配置使用 `1.74.0`。

1.75 的三段配置为 `1.75.0`，GitHub 标签为 `v1.75`。

历史正式版 1.80，三段配置为 `1.80.0`，GitHub 标签为 `v1.80`；它严格高于 1.75。

3.9（内部 `3.9.0`）已于 2026-10-27 14:15（Asia/Shanghai）正式发布，标签 `v3.9`。冻结源码 `4a88f2ea597101a5c2e92f2ab564afee9c5167e0`；三端 16 项附件的远端 SHA256 与大小逐项匹配。双 Mac App 与 DMG 已完成 Developer ID 签名、Apple 公证 Accepted 和装订。Windows CI 40458538824 的便携播放、安装、重装与真实 1.80 升级资料保留通过；EXE 未签名。 本版包含 App 取流恢复、搜索补搜、双集预取与窗口模式改进；见 [3.9 说明](release-3.9.md)。

3.8（内部 `3.8.0`）已于 2026-10-26 正式发布，标签 `v3.8`。三端 16 项附件的 GitHub SHA256 与大小已核对；双 Mac App 与 DMG 完成 Developer ID 签名、Apple 公证 Accepted 和装订，Windows EXE 未签名。冻结源码 `528c716a085dc4e3323ebd0aec7fb96815bc6523`；[Windows CI](https://github.com/jackotom/hongguo-drama/actions/runs/40311819587) 的便携播放、安装启动、同版本重装和真实 1.80 → 3.8 升级资料保留通过。本轮修复官网搜不到当天新剧：官网没有同名结果、接口 502 或短剧名被老剧名遮蔽时，从 App 近 7 天上新目录补搜。详见 [3.8 说明](release-3.8.md)。

上一正式版为 **3.7**（内部 `3.7.0`），已于 2026-10-26 正式发布，标签 `v3.7`。三端 16 项附件的 GitHub SHA256 与大小已核对；双 Mac App 与 DMG 完成 Developer ID 签名、Apple 公证 Accepted 和装订，Windows EXE 未签名。冻结源码 `85920561b68e0d5cc6ef10f5e6c2c33e96659f09`；[Windows CI](https://github.com/jackotom/hongguo-drama/actions/runs/40288846088) 的便携播放、安装启动、同版本重装和真实 1.80 → 3.7 升级资料保留通过。详见 [3.7 说明](release-3.7.md)。

上一正式版为 **3.6**（内部 `3.6.0`），标签 `v3.6`。三端 16 项附件的 GitHub SHA256 与大小已核对；双 Mac 应用及 DMG 已完成 Developer ID 签名、Apple 公证 Accepted 和装订，Windows EXE 未签名。冻结源码 `887862f449b87c56a01b565c849057756266d5a5`；后续文档提交不改变标签和已发布包。源码 CI 40280104020 与 [Windows CI](https://github.com/jackotom/hongguo-drama/actions/runs/40280746595) 绑定同一冻结提交；Windows 便携播放、新装、重装、1.80 升级与资料保留通过；最终签名 arm64 包下载两集 HEVC/AAC 并本地播放 15.7 秒，x64 Rosetta 包隔离启动/退出通过。未覆盖实体 Intel/Windows、干净 Gatekeeper、长期播放、完整应用内跨版本更新；音轨解码不等于人工听感确认。详见 [3.6 说明](release-3.6.md)。

上一正式版为 **3.5**（内部 `3.5.0`），标签 `v3.5`。三端 16 项附件的 GitHub SHA256 与大小已核对；双 Mac 应用及 DMG 已完成 Developer ID 签名、Apple 公证 Accepted 和装订，Windows EXE 未签名。冻结源码 `34bdc9eabdd81ce42c6ed6a23516b245fe44d93e`；后续文档提交不改变标签和已发布包。源码 CI 40266052588 与 [Windows CI](https://github.com/jackotom/hongguo-drama/actions/runs/40266211450) 绑定同一冻结提交；Windows 便携播放、新装、重装、1.80 升级与资料保留通过；最终签名 arm64 包实际播放本地与在线分集，arm64 原生和 x64 Rosetta 包均完成隔离启动/退出。详见 [3.5 说明](release-3.5.md)。

上一正式版为 **3.4**（内部 `3.4.0`），标签 `v3.4`。三端 16 项附件的 GitHub SHA256 与大小已核对；双 Mac 应用及 DMG 已完成 Developer ID 签名、Apple 公证和装订，Windows EXE 未签名。冻结源码 `241ada2d604ce65dc15d3c4df3686716ece61865`；后续文档提交不改变标签和已发布包。 Windows [本轮 CI](https://github.com/jackotom/hongguo-drama/actions/runs/40207906101) 的便携播放、新装、重装、1.80 升级与资料保留通过；Mac 冻结源码的随机两集下载、播放、定位、全屏及切集已检查，最终签名包完成 arm64 原生和 x64 Rosetta 隔离启动/退出。未覆盖实体 Intel/Windows、干净 Gatekeeper、长期播放、完整应用内跨版本更新；音轨解码不等于人工听感确认。 详见 [3.4 说明](release-3.4.md)。

上一正式版为 **3.3**（内部 `3.3.0`），标签 `v3.3`。三端 16 项资产已公开并核对远端 SHA256；双 Mac 应用与 DMG 已完成 Developer ID 签名、Apple 公证 Accepted 和装订；Windows CI 安装、重装、跨版本升级与便携媒体检查通过，EXE 未签名。 冻结源码 `1f152862ac9bc23f0a2ad2340a32ad7a62a4aaec`；后续文档提交不改变 v3.3 标签及已发布安装包、更新包和对应源码包的字节。 Windows [本轮 CI](https://github.com/jackotom/hongguo-drama/actions/runs/40156845982)；改动与验收边界见 [3.3 说明](release-3.3.md)。

更早正式版为 **3.2**（内部 `3.2.0`），标签 `v3.2`。16 项附件远端摘要已核对，双 Mac 应用与 DMG 已签名、公证及装订，Windows CI 安装和升级检查通过，EXE 未签名。冻结源码 `fe110c68f9e2a1eceb059be222901d2d37926a5d`；后续文档提交不改变 v3.2 标签及已发布安装包、更新包和对应源码包的字节。 验证范围与限制见 [3.2 说明](release-3.2.md)。

历史正式版为 **3.1**（内部 `3.1.0`），标签 `v3.1`。三端16项资产绑定源码提交 `f7a377126e626146ecca72de29cc73f7621c80c5`；双Mac应用与DMG已签名、公证及装订，Windows构建、安装和升级检查通过。验证范围见 [3.1 说明](release-3.1.md)。

历史正式版 **3.0** 已发布，标签 `v3.0`，包配置 `3.0.0`。三端 16 项资产绑定源码提交 `e53b3e626bc5c1fb935d8980f0dc4b6c3711bda3`；本次发行后文档补充不改变已发布程序与标签。验证范围见 [3.0 说明](release-3.0.md)，上一正式版为 2.9。

| 平台 | 构建入口 | 发布门槛 |
|---|---|---|
| macOS arm64 | npm run build:mac | 对应 arm64 媒体组件、Developer ID、Apple 公证 Accepted、装订验证 |
| macOS x64 | npm run build:mac | 对应 x64 媒体组件、Developer ID、Apple 公证 Accepted、装订验证；另记录 Intel 实机覆盖 |
| Windows x64 | Windows x64 release candidate 工作流 | NSIS 安装 EXE、latest.yml、便携 EXE/ZIP；精确 FFmpeg 对应源码；安装版安装/启动/同版本重装资料保留与便携版媒体窗口冒烟；明确签名状态 |
| Linux x64 | 最新源码的Linux构建入口；本分支已同步 | AppImage、匹配媒体工具和对应源码；原生Linux启动及真实素材静音播放；单独记录发行版、GPU/FUSE与更新方式 |
| Docker Linux amd64 | `docker build`，认证Web/API、镜像归档与部署ZIP | 非root、目录/来源边界、随机真实搜索下载合并、重启持久化、导出镜像身份和对应源码；不冒称fnOS硬件或ARM64验收 |

Windows 工作流只上传 Actions 构建资产，不创建 Release，不改 latest，不覆盖总校验文件。正式版本由统一发行会话汇总五平台资产、对应源码和总 SHA256SUMS。
Windows 当前未配置代码签名证书；EXE 必须明确标为未签名。Windows CI 虚拟机验证不等于用户实体电脑、GPU/HEVC、真实平台下载与长期稳定性验收。
若某平台受阻，同版本保留，记录具体缺口及已有资产状态；不得将缺失平台写成已发布，也不得为补平台另跳版本。

## 真实播放验收

从 2.7 起，进行播放验收时，在隔离测试资料目录中随机选择一部可正常下载的短剧，下载其中两集。每集实际播放约 10 秒，到时先暂停再记录结果，避免工具往返拖长播放。只顺带核对本次改动涉及的播放、快进／回退、控件隐藏或切集，不默认扩大成长时播放或完整矩阵；长时专项需用户明确授权。分别记录音轨解码与人工听音，不能互相替代。

不再依赖旧固定路径素材。下载或播放受阻时记录具体原因与待验项，不得写成通过；离线控件检查和 CI 冒烟不能替代这次真实播放验收。测试资料和视频不纳入公开源码或发行资产。

## Windows 构建

Ubuntu 24.04 安装 gcc-mingw-w64-x86-64、make、pkg-config 后运行 `bash scripts/build-ffmpeg-source-win.sh BUILD_DIRECTORY 4`。
将 artifacts/bin 内容放入 build/ffmpeg。Windows x64、Node 22.12+ 执行 `npm ci`、`npm run build:portable`，再执行 `npx electron-builder --win nsis --x64 --publish never`。
`node scripts/check-windows-release.cjs` 仅用于一次性 Windows CI：便携 EXE 直接启动、临时用户资料、本轮随机真实下载的红果两集；全程静音；不要对用户现有安装运行。
旧 `scripts/setup-ffmpeg.js` 下载 Gyan 7.1 仅保留作历史开发入口，不得用于 1.1.9 正式发行。

发布必须同时提供应用精确源码 ZIP 与 FFmpeg/x264 Windows 完整对应源码 TAR.GZ。不得遗漏 Windows 专用配置、工作流和构建脚本。

用户下载同时提供安装版 EXE、便携 EXE 与便携 ZIP。便携 ZIP 内仅同一份便携 EXE，无需安装；对应源码归档另外提供。安装版支持应用内更新，便携版保留下载页面入口，不使用 NSIS 覆盖便携文件。

## 应用内更新发行门槛

- 固定公开源为 `jackotom/hongguo-drama` GitHub Releases；客户端包不得包含发布令牌。
- Mac 两种架构使用同一份 `latest-mac.yml`，`files` 中分别列出含 `arm64`、`x64` 的 ASCII ZIP 文件名、最终文件 SHA512（base64）及大小。
- 构建产生的 ZIP 只作中间产物。正式更新 ZIP 必须从已完成 Developer ID 签名、Apple 公证与装订的最终 App 重新压缩，然后重算清单摘要；禁止沿用签名前的 ZIP、blockmap 或摘要。DMG 同样完成签名、公证、装订。
- Windows `latest.yml` 仅指向同名 NSIS 安装包，保留 builder 生成的 SHA512、大小和 blockmap；复制上传不得再改名。安装版与便携版共享同一版本和数据格式。
- Windows 尚无代码签名证书。SHA512 只验证下载与官方清单一致，不提供独立的发布者身份保证；不得主动关闭签名校验或声称已签名。
- `node scripts/check-windows-installer.cjs --config` 可本机检查发行配置；不带参数仅允许一次性 GitHub Windows CI，检查安装包元数据、安装启动、同版本重装，以及固定摘要的真实官方 1.80 安装包覆盖升级与资料保留。该检查不等于应用内自动更新端到端或实体 Windows 验收。
- Draft 中先汇总五平台包、更新清单、准确对应源码和总校验文件，检查文件名/摘要/版本一致且各平台必要验收完成后一次发布为 latest；缺平台保留Draft。旧版 1.75 不具备下载安装能力，需要手动安装一次 1.80；后续支持自动更新的平台才使用应用内更新，Linux和Docker不得冒用Mac／Windows更新清单。

## 每次更新的版本与根目录一致性

- README 的版本更新说明须同步新增本版功能摘要，并按新到旧排列；下载区、最新发行链接与更新说明三处一起核对，不得只更新下载版本号。历史版本说明保留。
- 历史 4.0 已正式发布，机器版本 `4.0.0`；其安装包、更新清单、源码包与发行标签绑定该版冻结源码。4.0 的三个 artifact 模板使用公开 4.0；依赖版本和旧版资产保留。后续文档提交不改变已发布包与标签。
- 历史正式版 4.4，机器配置 `4.4.0`，latest 为 `v4.4`。三个 artifact 模板使用公开 4.4，发行包、更新清单和源码绑定冻结提交 `23860cfde09d953a7b1f1cbe9e20b433dd4b0e18`；发布后的文档提交不改变包和标签。见 [4.4说明](release-4.4.md)。
- 用户要求 GitHub 根目录每个文件和文件夹的最近提交说明均带当前版本号。发布前从 `git ls-files` 提取第一级路径，包含隐藏根项；根文件须有实际变更，根目录须至少有一个受跟踪子文件实际变更，并进入带本轮公开版本的正常发行提交（4.2 对应 `release: 4.2 统一发行与验证`）。提交后逐项执行 `git log -1 --format=%s -- <根项>`，确认每项最近提交标题含本轮公开版本；只在文件内容写版本、只提交 README 或空提交均不能满足其他根项。推送后由主控核对 GitHub 根目录实际显示并截图，本地结果不能代替远端显示。本轮功能开发不为该发行门槛制造无关变更。
- 保留历史版本说明、历史标签、依赖版本和第三方许可正文，不为页面显示改写历史提交。LICENSE 保持标准许可正文，仅允许不影响条文的排版空白调整；批处理文件保持原编码、换行与执行逻辑，代码标识只用注释，禁止改变 CSP 或运行行为来制造提交。
- 发布前状态写“源码／发行目标”；只有实际完成发布后才写“当前正式版”。不得把版本统一检查当作构建、签名、公证、安装或实机验收。

- `LICENSE` 保持可被 GitHub 识别的标准许可正文，不添加版本前言。通过含当前版本的正常提交更新显示；必要时仅调整不影响条文的排版空白，许可条文不变。

### 4.0 根目录提交回执

冻结发行前已有 22 个根项最近提交说明包含 4.0 的回执。本次文档更新由主控另行提交，提交说明须含 4.0；脚本不执行 Git、CI 或发布操作。

## 6.7 播放修复发行目标（2026-11-10）

- 用户明确授权修复、真实播放测试后发布6.7；不沿用6.6免测。五类发行产物及门槛按当前用户AGENTS执行，TV不列本轮发行。状态见 `docs/release-6.7.md`。
