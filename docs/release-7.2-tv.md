# 7.2 Android TV 补充发行回执

7.2 TV开发补充包已于2026-11-13 16:08:18（Asia/Shanghai）追加公开，版本7.2／code70200，沿用公开6.6 TV签名证书；TV源码冻结`2aa068f496f78114389d94c41b83dde877b174ce`。新增APK、精确TV源码和独立SHA256清单三份附件，现共28份正式附件；原25份桌面／Docker附件与原v7.2标签不变。构建、签名连续性、Manifest／包内容、定向源码检查及三附件匿名完整下载摘要核对通过。**TV实机未测试，请用户自行测试；安装、启动、实际遥控、播放和覆盖升级均未验证。** 手机保持独立，本机正式应用未替换。

用户于2026-11-13明确要求制作7.2 TV版并追加到现有7.2发行页。这是本次追加TV的明确授权；不把旧版6.6的免测要求当成本轮测试结果。TV精确源码单列，原v7.2冻结桌面源码`26a926f03f5038257e14b932b4762aab2f537ee9`不移动。

## 下载与源码

- [TV APK](https://github.com/jackotom/hongguo-drama/releases/download/v7.2/hongguo-downloader-7.2-android-tv-dev.apk)：Android10／API29起；文件名`hongguo-downloader-7.2-android-tv-dev.apk`。
- [精确TV源码](https://github.com/jackotom/hongguo-drama/releases/download/v7.2/hongguo-drama-7.2-android-tv-source.zip)：冻结提交`2aa068f496f78114389d94c41b83dde877b174ce`，596个Git源码成员逐项核对，ZIP注释绑定同一提交。
- [TV独立SHA256](https://github.com/jackotom/hongguo-drama/releases/download/v7.2/SHA256SUMS-7.2-TV.txt)：列出APK与TV源码摘要；清单本身摘要见下表。

| 文件 | 字节 | SHA256 |
|---|---:|---|
| `hongguo-downloader-7.2-android-tv-dev.apk` | 173095 | `473635f07f88c4780bea0b51e72f963723b6b4a7f9c6f43bc53d48e97a0419e7` |
| `hongguo-drama-7.2-android-tv-source.zip` | 5743392 | `7acbf5738c3f45b0f1004dfaf6923b21841baa3eb2aba013533ac5874255678b` |
| `SHA256SUMS-7.2-TV.txt` | 434 | `eb392ea47f315081df3378b6590eab6f18df94a230889f104aa4e3e324545c08` |

TV源码与原桌面冻结源不同，GitHub自动生成的Source code仍对应原v7.2标签；复现TV请使用上述单列TV源码。源码附件不含密钥、密码、依赖目录、运行资料或构建残留；没有打包正式用户数据。

## 范围

- TV独立版本`7.2.0`，APK显示`7.2`，`versionCode=70200`，包名仍为`io.github.hongguo.tv`；可签名升级身份须以新旧APK证书核对为准。手机仍为`1.1`／code2，不构建或安装手机包。
- 复用当前7.2根源码的取源、签名、匿名身份、解密和官方弹幕；不移植手机独立协议，不扩大来源。桌面下载临时文件、外置盘、ByteVC2转换器不编入TV，不能把桌面#150／#153验收外推到电视。
- 共享取源的`node:timers/promises`原先无法打入浏览器。补充小型可取消定时器适配，两个Android打包入口复用；保留取源间隔、取消异常和资源清理。未修改桌面实现。
- 构建脚本显式创建图标／横幅资源目录，修复干净源码没有历史生成目录时无法写入TV横幅的问题，不依赖旧构建残留。
- 保留最低Android10／API29、target34、Leanback入口、横屏、无触屏声明、禁明文网络、官方域名及跳转校验、64MB整集准备、加密容器、UUID缓存归属、取消和迟到回执保护。没有增加ByteVC2转换；未加密媒体不具桌面同等级的ffprobe／完整时长／解码验收。


## 检查记录

- TV元数据检查通过：7.2／code70200，8组单调版本及25组无效输入；手机1.1／code2保持。
- 新定时器3项先失败、适配后通过：等待正确返回、在途取消清理、预先取消不创建定时器；实际TV bundle通过。
- TV启动、遥控、弹幕、媒体生命周期、共享媒体恢复与真实生产bundle接线首轮65项中61通过。四处失败为测试夹具入口冲突、fixture缺定时器alias、原生fixture临时父目录缺失；最小修正／补目录后仅补跑失败项，7项通过（含注册／模型／备用请求3个取消子场景）。不冒称单次全组重跑全绿，不替代真机。
- 已下载公开6.6 TV APK并与远端SHA256核对，旧APK签名验证通过；本轮使用原TV签名材料，私密文件不进入源码或附件。最终APK证书、实际Manifest和包内容已完成下列核对。


最终APK的`io.github.hongguo.tv`、versionName7.2／code70200、minSdk29／target34、Leanback入口、横屏、非必需触屏、allowBackup=false、cleartext=false均核对。APK签名与zipalign校验通过，唯一签名证书SHA256为`7e20f2d528ce35631d0d8df1c6b04e2c0874d014d5eeff028c73fde0137c7a25`，与匿名下载且核过远端SHA256的公开6.6 APK完全一致；签名连续不等同已经测试覆盖升级。

APK八份资源与构建输出逐字节一致；重新执行冻结TV打包入口，实际31个输入编出的JS与已签名APK载荷完全一致，确认包含当前共享取源、签名、身份、解密、弹幕和浏览器timer，未导入独立手机版协议或桌面主入口。APK只有Java／WebView载荷，没有原生ABI库；这不证明所有电视的WebView和解码能力可用。

公开后APK、源码ZIP、独立清单均匿名完整下载并与本地验收大小／SHA256一致。Release仍为`443870946`、v7.2 Latest；原25附件的ID、名称、大小和SHA256逐项保持，原更新与总校验清单字节不变，未覆盖或重传旧包。

## 未测边界

没有ADB电视或模拟器，未安装APK、未验证电视启动、真实遥控、真实播放、续播或覆盖升级。**TV实机未测试，请用户自行测试；兼容性尚未确认。** Android10以下不能安装，旧WebView可能被现有能力预检阻止；没有降低兼容和安全门，也没有增加ByteVC2转换。不把桌面下载、播放或媒体安全验收当作TV实测。

通用全量源码CI仍有此前披露的失败，本轮未重跑全量；上述定向检查不冒称全量回归全绿。#151中文字幕仍未实现。未替换本机正式应用，未安装手机或电视，未回复或关闭Issue。后置回执不改变冻结TV源码和已发布APK字节。
