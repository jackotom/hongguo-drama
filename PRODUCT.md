<!-- 7.2 published; frozen application source remains unchanged. -->

7.2 TV开发补充包已于2026-11-13 16:08:18（Asia/Shanghai）追加公开，版本7.2／code70200，沿用公开6.6 TV签名证书；TV源码冻结`2aa068f496f78114389d94c41b83dde877b174ce`。新增APK、精确TV源码和独立SHA256清单三份附件，现共28份正式附件；原25份桌面／Docker附件与原v7.2标签不变。构建、签名连续性、Manifest／包内容、定向源码检查及三附件匿名完整下载摘要核对通过。**TV实机未测试，请用户自行测试；安装、启动、实际遥控、播放和覆盖升级均未验证。** 手机保持独立，本机正式应用未替换。见[TV补充回执](docs/release-7.2-tv.md)。以下保留原五平台首发记录。

7.2已于2026-11-13 15:32:56（Asia/Shanghai）正式公开并设Latest，内部7.2.0、桌面构建7.2.1，冻结源码`26a926f03f5038257e14b932b4762aab2f537ee9`。双Mac、Windows x64、Linux x64 AppImage、Docker amd64五类共25份正式附件，远端大小／SHA256、三份清单与10个匿名下载入口已核对；113个实际上传分段已清理。双Mac本轮新签名、公证、装订；Windows EXE未签名，Intel仅Rosetta。#150与#153修复保留文件安全校验；#151中文字幕未实现。定向检查与必要平台验收通过，通用全量源码CI未全绿，具体失败及平台实测边界见发行回执。未替换本机正式安装；TV与手机独立。完整回执见[7.2说明](docs/release-7.2.md)。

<!-- 7.1 published release; frozen application source remains unchanged. -->
<!-- Earlier published release records are retained below. -->
# 红果短剧

7.1已于2026-11-12 14:10:02（Asia/Shanghai）正式公开并设Latest，内部7.1.0、桌面构建7.1.2，冻结源码`bdab9d6158e07524f234f88c1168f20baa2cd507`。双Mac、Windows x64、Linux x64 AppImage、Docker amd64五类共25份正式附件，远端大小／SHA256、三份清单及匿名下载入口已核对；119个临时分段已清理。双Mac新签名、公证、装订；Windows EXE未签名，Intel仅Rosetta，NVIDIA实体未验。高性能模式功能通过，M5本轮样本未提速且文件更大。未替换本机正式安装；TV与手机独立。完整回执见[7.1说明](docs/release-7.1.md)。

7.0已于2026-11-11 21:41:46（Asia/Shanghai）正式公开并设Latest，内部7.0.0、桌面构建7.0.1，冻结源码`3f5927d0d605ff7742fde8cbd1bb92ffe951b080`。双Mac、Windows x64、Linux x64 AppImage、Docker amd64五类共25份正式附件；双Mac已签名、公证、装订，Windows EXE未签名且App真实下载队列未测，Intel仅Rosetta。未运行通用全量测试，未替换本机正式安装；TV与手机独立。见[7.0正式回执](docs/release-7.0.md)。

6.8已于2026-11-11 10:17:07（Asia/Shanghai）正式公开并设Latest，内部6.8.0、桌面构建6.8.2，冻结源码`e06828f0c81392fb572a5feda6cec54dba643251`。双Mac、Windows x64、Linux x64 AppImage、Docker amd64统一共25附件，远端大小／SHA256与更新及总校验清单已回读核对。双Mac本轮新签名、公证、装订；Windows EXE未签名，Intel仅Rosetta。未替换本机正式安装。 验证范围见[6.8说明](docs/release-6.8.md)。

6.6已于2026-11-10 21:06:07（Asia/Shanghai）公开并设Latest，内部6.6.0、桌面构建6.6.1，冻结源码`d0410c8ef7b02a087f5c16eb026e0ece61454115`。双Mac、Windows、Linux、Docker与TV共26附件；双Mac新签名/公证/装订，Windows EXE未签名。本轮按用户要求未进行新的功能、界面、播放、安装升级、单元或设备测试；**TV版未测试，请用户自行测试**。不把构建成功或此前开发检查当作实播恢复证明，未替换本机正式安装。 见[6.6说明](docs/release-6.6.md)。

6.5已于2026-11-09 18:50:43（Asia/Shanghai）正式公开并设Latest，内部6.5.0、桌面构建6.5.1，冻结源码`b99555519d97065b16753cd66326eb62894ec34a`。双Mac、Windows、Linux AppImage、Docker五类产物统一发行，25附件远端大小与SHA256、更新清单和精确源码已核对。双Mac签名、公证、装订；Windows播放/安装/升级与Linux真实静音播放、Docker真实下载合并及重启持久化通过；#124实际鼠标唤醒、真实续播、手动暂停和重启记忆通过。Windows EXE未签名，x64 Mac仅Rosetta，未验飞牛硬件；未替换本机正式安装。 见[6.5说明](docs/release-6.5.md)。

6.5功能：Docker Web UI/API、NAS下载与合并，窗口内全屏、重复弹幕聚合及自定义小窗唤醒区域。Docker替代TV，五平台统一发行。状态见docs/release-6.5.md。

6.4已于2026-11-09 00:00:50（Asia/Shanghai）正式公开并设Latest，内部6.4.0、桌面构建6.4.1，冻结源码`12fa10087059be49d8f7d9895bae260130fe0e1f`。本次按明确授权发布双Mac、Windows、Linux四平台，TV继续开发、候选APK不公开；后续默认五平台规则保留。23附件远端大小/SHA256及两份更新清单已核对；双Mac签名、公证、装订与最终DMG/更新ZIP验收通过；Windows真实素材便携播放及安装升级验收通过但EXE未签名；Linux原生Ubuntu CI以CPU软件解码完成两集真实下载与静音播放。Mac两集静音播放及中英文切换、播放器保留、重载记忆通过；x64经Rosetta启动，不等于实体Intel验收。未替换本机正式安装。 详情见[6.4说明](docs/release-6.4.md)。


6.1 已于 2026-11-06 13:26（Asia/Shanghai）正式发布，内部 `6.1.0`，标签 `v6.1` 并设为 Latest。冻结源码 `a93793dea2f13864e8a56771bb6bea05ea6ddbb6`；后续文档提交不改变冻结标签和安装包。23份附件远端大小与SHA256逐项一致。 Mac签名/公证/装订，Windows安装升级通过；Linux启动通过、实际播放未验。详见 [6.1说明](docs/release-6.1.md)。

6.0 已于 2026-11-05 21:59（Asia/Shanghai）正式发布，内部 `6.0.0`，标签 `v6.0` 并设为Latest；冻结源码 `c51b9e9378c27b5e84cd201a84b2df2a7a99579f`。降低ByteVC2兼容转换并发与线程占用，当前播放优先，保留后两集预缓存、切集复用和自动连播。三端19附件远端大小/SHA256与10个匿名下载入口通过；双Mac App/DMG四份Apple Accepted、Developer ID签名与装订通过；Windows便携11项、安装/重装及真实1.80升级资料保留9项通过，EXE未签名。323单元/108平台、源码CI42030393234及Windows CI42030558184通过。本机同一真实ByteVC2片段平均核心占用降低约56%，不代表Windows整机表现；最终arm64包真实两集静音自动交接和x64 Rosetta启动退出通过。未替换本机正式安装。 详见 [6.0说明](docs/release-6.0.md)。

5.9 已于 2026-11-05 18:24（Asia/Shanghai）正式发布，标签 `v5.9` 并设为Latest；冻结源码 `6f7dc3be99bba5ad1975cd28317658a06083a696`。三端19附件远端大小/SHA256一致；双Mac App与DMG四份新Apple Accepted、Developer ID签名、装订、只读挂载和最终更新ZIP恢复通过。源码CI42006135704通过319单元/108平台；Windows CI42006238343便携11项、安装/重装及真实1.80升级资料保留9项通过，EXE未签名。最终arm64包随机真实下载两集1080P HEVC/AAC并全程静音播放，两倍速自动交接后覆盖层hidden、视频帧已提交；x64经Rosetta启动退出通过，原生截图工具超时，不是实体Intel验收。未替换本机正式安装。 详见 [5.9说明](docs/release-5.9.md)。

5.8 已正式发布：修复明确未加密片源解析，取源拒绝后暂停后续队列，切集保帧、双击与可配置长按快捷键；放大详情海报并展示可折叠简介，支持已下载单集交给系统播放器。见 [5.8说明](docs/release-5.8.md)。

5.7 已正式发布：增加ByteVC2兼容转换，修复观看记录分组，记住音量与常用倍速；明确取源拒绝及批量失效验证边界。状态见 [5.7说明](docs/release-5.7.md)。

5.6 已正式发布：双击画面全屏、控制条下一集、长按快进键临时2倍速；登录确认与匿名设备注册解耦，注册失败冷却并明确提示ByteVC2不兼容。状态与边界见 [5.6说明](docs/release-5.6.md)。

5.5 发行候选：修复 NAS 删除安全、资料身份、暂停持久化、合并空间与代理密码存储；普通下载可附带整剧资料，NAS 可自动建目录，增加单集评论入口和本机分集小红心。状态见 [5.5说明](docs/release-5.5.md)。

5.4 已正式发布：恢复播放请求签名，增加官网登录、按剧缓存清理、观看记录分组与 DLNA 单集投屏。发行与验证状态见 [5.4说明](docs/release-5.4.md)。

当前正式版：**7.2**；上一正式版：**7.1**（以下保留历史发行记录）。

5.4（内部 `5.4.0`）已于 2026-11-02 18:25（Asia/Shanghai）正式发布，标签 `v5.4`，冻结源码 `e7595c040d328655212a2fb0b315286a6ee914b2`。恢复播放请求签名，增加官网登录、按剧清缓存、观看记录分组与 DLNA 单集投屏。三端16附件远端大小及SHA256匹配；双Mac App与DMG四份Apple公证Accepted、签名/装订、只读挂载与更新ZIP恢复通过。源码CI41425248571、Windows CI41425313110通过232单元及102平台检查；Windows便携11项、安装/重装/真实1.80升级资料保留9项通过，EXE未签名。最终arm64包随机真实两集1080P HEVC/AAC下载和静音约10秒播放通过；x64 Rosetta启动退出通过。

5.3（内部 `5.3.0`）已于 2026-11-01 10:07（Asia/Shanghai）正式发布，标签 `v5.3`，冻结源码 `4be719b775b4cc92233bde9e9f7790462ba87e2d`。新增下载到 NAS、同层封面/简介/NFO、规范分集命名与复用补齐。三端16附件远端大小和SHA256匹配；双Mac App与DMG四份Apple公证Accepted、签名/装订、DMG只读挂载及更新ZIP恢复通过。源码CI 41262056747、Windows CI 41262074332 通过215单元和100平台检查；Windows便携11项、安装/重装/真实1.80升级资料保留9项通过，EXE未签名。最终arm64包真实两集NAS下载、同层7文件、原生打开目录和静音约10秒播放通过；x64经Rosetta界面启动、正常退出通过。

功能与验证边界见 `docs/release-5.3.md`。

上一正式版：**5.2**。macOS 普通主窗口位置和大小恢复。

5.2（内部 `5.2.0`）已于 2026-10-31 15:32（Asia/Shanghai）正式发布，标签 `v5.2`，冻结源码 `cadd99f28b6225ff873b5b7a3c836a71a4933730`。修复 macOS 普通主窗口位置和大小恢复。三端16项附件远端SHA256与大小匹配；双Mac App及DMG四份Apple公证Accepted、签名和装订，最终DMG只读挂载与更新ZIP恢复通过；源码CI 41179681402 与Windows CI 41179708157 通过215单元及98平台检查。最终arm64包窗口恢复、随机真实两集静音播放和x64 Rosetta启动退出通过；10个匿名下载入口通过。Windows EXE未签名。

功能与验证边界见 `docs/release-5.2.md`。

上一正式版：**5.1**。修复了已知问题。

5.1（内部 `5.1.0`）已于 2026-10-30 18:20（Asia/Shanghai）正式发布，标签 `v5.1`，冻结源码 `2f241b1dc096b089a060f01e4aca466111a5fbf8`。三端16项附件远端SHA256与大小匹配；双Mac App及DMG完成Developer ID签名、Apple公证Accepted和装订，最终DMG只读挂载与包内匹配通过；源码CI 41037730494 与Windows CI 41037730786 通过。10个匿名下载入口、最终包账号导航、真实素材静音播放与x64 Rosetta启动通过。Windows EXE未签名。

功能与验证边界见 `docs/release-5.1.md`。

上一正式版：**5.0**。

5.0（内部 `5.0.0`）已于 2026-10-30 15:21（Asia/Shanghai）正式发布，标签 `v5.0`，冻结源码 `1fa218a196478c9bd3908bea9666bc23f23b921f`。三端 16 项附件及其远端 SHA256、大小匹配；双 Mac App 与 DMG 的 Developer ID 签名、Apple 公证 Accepted、票据装订、最终 DMG 只读挂载及包内文件匹配通过；源码 CI 41016309687 与 Windows CI 41016337531 均通过；10 个匿名下载入口、Mac x64 Rosetta 启动、真实素材播放和观看记录界面验收通过。Windows EXE 未签名。

功能与验证边界见 `docs/release-5.0.md`。

上一正式版：**4.9**。

4.9（内部 `4.9.0`）已于 2026-10-30 13:17（Asia/Shanghai）正式发布，标签 `v4.9`，冻结源码 `803796d29cfcb5ac5e5efb3861f46a198e4d3dba`。三端16项附件远端SHA256与大小逐项匹配。双Mac App/DMG完成Developer ID签名、Apple公证Accepted与装订；Windows CI41005635075通过真实素材便携播放、安装、重装和1.80升级资料保留，EXE未签名。

功能与验证边界见 `docs/release-4.9.md`。

上一正式版：**4.8**。

4.8（内部 `4.8.0`）已于 2026-10-30 09:22（Asia/Shanghai）正式发布，标签 `v4.8`，冻结源码 `6f2d20f10df4892aa88a9942096545dfef489539`。三端16项附件远端SHA256和大小逐项匹配。双Mac App/DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI40983555096完成真实素材便携播放、安装、重装和1.80升级资料保留，EXE未签名。

自动1080P优先与换档验证边界见 `docs/release-4.8.md`。

上一正式版：**4.7**。

4.7（内部 `4.7.0`）已于 2026-10-29 21:11（Asia/Shanghai）正式发布，标签 `v4.7`，冻结源码 `4aa23b0e620b51a9cc146ccf11e84e95149eb79b`。三端16项附件远端SHA256和大小逐项匹配。双Mac App/DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI40877020607完成真实素材便携播放、安装、重装和1.80升级资料保留，EXE未签名。

修复内容与验证边界见 `docs/release-4.7.md`。

上一正式版：**4.6**。

4.6（内部 `4.6.0`）已于 2026-10-29 17:07（Asia/Shanghai）正式发布，标签 `v4.6`，冻结源码 `e2fa54725fb8d60f8982053206e43b18d83cd829`。三端16项附件的远端SHA256与大小逐项匹配。双Mac App/DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI40844214407完成便携播放、安装、重装和真实1.80升级资料保留，EXE未签名。

4.6 优化4K与宽窗口片单排版，外观设置增加海报大小、界面与字号调节；默认100%，不根据分辨率自动放大。状态见 `docs/release-4.6.md`。

4.5（内部 `4.5.0`）已于 2026-10-29 15:09（Asia/Shanghai）正式发布，标签 `v4.5`，冻结源码 `1ad8701d6be0950d5f9ba6f5ce8029df22490843`。三端16项附件远端SHA256与大小逐项匹配。双Mac App/DMG已完成Developer ID签名、Apple公证Accepted和装订；Windows CI40831162089安装、重装、真实1.80升级资料保留与静音真实素材播放检查通过，EXE未签名。

分类与题材重复点击换批，四个热播榜保持热度顺序。详见 `docs/release-4.5.md`。

4.4（内部 `4.4.0`）已于 2026-10-29 13:44（Asia/Shanghai）正式发布，标签 `v4.4`，冻结源码 `23860cfde09d953a7b1f1cbe9e20b433dd4b0e18`。三端 16 项附件远端 SHA256 与大小逐项匹配。双 Mac App/DMG 已完成 Developer ID 签名、Apple 公证 Accepted 和装订；Windows CI 40822817019 的便携播放、安装、重装和真实 1.80 升级资料保留通过，EXE 未签名。

3.4（内部 `3.4.0`）已于 2026-10-26 正式发布，标签 `v3.4`。三端 16 项附件的 GitHub SHA256 与大小已核对；双 Mac 应用及 DMG 已完成 Developer ID 签名、Apple 公证和装订，Windows EXE 未签名。冻结源码 `241ada2d604ce65dc15d3c4df3686716ece61865`；后续文档提交不改变标签和已发布包。 Windows [本轮 CI](https://github.com/jackotom/hongguo-drama/actions/runs/40207906101) 的便携播放、新装、重装、1.80 升级与资料保留通过；Mac 冻结源码的随机两集下载、播放、定位、全屏及切集已检查，最终签名包完成 arm64 原生和 x64 Rosetta 隔离启动/退出。未覆盖实体 Intel/Windows、干净 Gatekeeper、长期播放、完整应用内跨版本更新；音轨解码不等于人工听感确认。

上一正式版：3.3（内部 3.3.0，已发布）。改善红果下载自动降级与 Mac 界面缩放，见 `docs/release-3.3.md`。三端 16 项资产已公开并核对远端 SHA256；双 Mac 应用与 DMG 已完成 Developer ID 签名、Apple 公证 Accepted 和装订；Windows CI 安装、重装、跨版本升级与便携媒体检查通过，EXE 未签名。 冻结源码 `1f152862ac9bc23f0a2ad2340a32ad7a62a4aaec`；后续文档提交不改变 v3.3 标签及已发布安装包、更新包和对应源码包的字节。

更早正式版：3.2（内部 3.2.0，已发布）。改善片单缓存与刷新失败恢复，更新保留选中项，错误提示不再挤走发现页海报，见 `docs/release-3.2.md`。更早正式版为 3.1。冻结源码 `fe110c68f9e2a1eceb059be222901d2d37926a5d`；后续文档提交不改变 v3.2 标签及已发布安装包、更新包和对应源码包的字节。
<!-- impeccable:product-schema 1 -->

## Platform
web

## Product Purpose
面向桌面使用者的短剧浏览、搜索、在线播放与本地下载应用。Electron 承载 React 界面，支持 M 系列 Mac、Intel Mac 与 Windows x64。

## Capabilities and Constraints
提供三来源分类浏览与搜索、当天新剧补搜、红果热播榜及链接或剧集 ID 解析、选集下载、队列管理、重试、合并导出、播放续看、后续两集预取、系统画中画、全屏与主窗口小窗、观看记录、追剧提醒、横竖布局、两种画面模式、缓存清理、网络代理和软件更新提醒。剧集与播放数据来自实际服务，不提供模拟片单或假播放。不改变现有 API 与存储格式，不引入 UI 依赖。

## Brand Commitments
产品名称为「红果短剧」；下载是功能模块。成熟 macOS 影音应用方向：浅暖中性底色、深炭文字、克制红色重点、明确字级和留白。对用户说明作用，不用内部解密技术作为广告。

## Product Principles
内容优先；常用操作直接可达；高风险删除明确确认；网络失败提供恢复路径；所有核心操作支持键盘。
