# 7.1 发行目标

状态：源码／发行目标，尚未公开。内部7.1.0、桌面构建7.1.2；基于正式7.0。双Mac、Windows x64、Linux x64 AppImage、Docker amd64同源一次发行，不替换本机正式安装。

## 修复与贡献

- [#149](https://github.com/jackotom/hongguo-drama/issues/149)，感谢huihui278：桌面解码菜单新增「高性能显卡快速解码（老电脑请勿使用）」，默认关闭，后台保存`fast_conversion`偏好。该模式优先加速H.264格式转换，不承诺ByteVC2显卡硬解或所有独显支持；实体NVIDIA尚未实跑。
- 高性能模式下ByteVC2仍由CPU解码，解码4线程、转换单队列；Mac尝试VideoToolbox，Windows／Linux尝试NVIDIA NVENC编码。先用当前真实输入试编码并确认出帧；不支持或硬件失败时明确提示并有界回退CPU，取消、输入或存储错误不盲重试。自动／软件解码保留原行为。
- 设置保存失败保留原选择与播放器，自动／高性能互切不重载当前有效媒体；CPU软件／原生互切沿用进度、暂停和音量恢复。偏好仅影响后续准备／转换，不重启正在运行的转换或使有效缓存失效。
- #148：恢复、手动／自动重试只在同剧已有队列槽位内按集号升序，跨剧优先顺序不变。
- #147：临时文件dev／ino／birthtimeNs精确持久化，BigInt不流入JSON；旧安全Number收据兼容，旧不安全身份和替换文件继续保留，下载空间统计不变。
- 采纳anupam-orbis的[#140](https://github.com/jackotom/hongguo-drama/pull/140)实际依赖锁更新：follow-redirects 1.16.1升至1.16.3。新增本项目回环HTTP重定向回归，旧依赖先失败、新依赖通过；不能据此宣称本项目已发生凭据泄漏，Axios 1.20.0组合未复现该漏洞。
- #92、#143和#129已有等价／独立覆盖，保留当前签名、受检备用取源与显式选择本地文件语义，不整块复制旧方案。见[PR审查](pr-review-7.1-2026-11-12.md)。
- README、CONTRIBUTORS.md与打包native数据完整致谢历史提交作者、PR提交者和Issue作者；GitHub右侧Contributors仍按真实提交自动生成，不伪造作者。

## 现有验证

加入#149前，下载队列9项、临时身份集成16项、ByteVC2转换器30项、重启／NAS保护16项，共71项定向检查及当时前端生产构建通过。#149改变了转换器和前端，先前相关结果不能替代新实现的定向验证或新包验收。源码及开发Electron窗口真实下载／静音播放证据见[#147／#148记录](issue-147-148-7.1.md)，不替代本轮最终包验收。

升级依赖通过官方包完整性核对、跨域凭据剥离／同源保留与Axios集成；共享旧依赖不用于正式构建。Windows验收新增最终App真实下载队列，实际平台结果待冻结后CI。

高性能菜单8组内存UI定向检查通过，覆盖保存失败、偏好重读、切换恢复、并发保存、迟到读取和重复转换提示；音量／静音／倍速记忆检查通过。这些结果不等于真实GPU或最终安装包验收。此前候选冻结已废弃，三条CI已取消；旧冻结没有完成Mac App签名、公证，旧结果不作为新构建验收。

## 新媒体输入与许可

Windows／Linux的FFmpeg及Librempeg新增官方`nv-codec-headers 12.1.14.0`，固定提交`1889e62e2d35ff7aa9baca2bceb14f053785e6f1`、源码归档SHA256 `e30d4791fd386de8b5c9f88dec781e546ec148b8808440dd421da5f26c2700ae`。MIT完整声明随包及对应源码保留；不捆绑NVIDIA驱动或运行库，依赖用户已安装的可用驱动。

上述平台对应源码增加固定头文件源码归档、`prepare-nv-codec-headers.sh`和`NV-CODEC-HEADERS-LICENSE.txt`三个成员。双Mac Librempeg本轮重建并绑定新构建脚本，不能按旧输入未变复用；其它媒体只在输入／二进制／对应源码摘要核对后复用。许可与构建范围见[Librempeg声明](../build/ffmpeg/LIBREMPEG-NOTICE.txt)和[第三方许可](../THIRD-PARTY-NOTICES.md)。

## 尚待发行门

唯一冻结源码、本轮五类构建／验收、双Mac新Developer ID签名及App／DMG Apple Accepted和装订、最终更新ZIP恢复、Windows安装升级及App真实下载队列、Linux真实静音播放、Docker认证下载合并与重启持久化。25份正式附件、精确源码、9份媒体对应源码、两份更新清单与总SHA先在Draft核对，再统一公开Latest。未完成不写通过。

Windows EXE未签名；Intel Mac仅按本轮实际Rosetta覆盖记录；实体硬件、其它Linux／GPU／FUSE、Docker ARM64、上游长期稳定性及人工听音不外推。TV和手机独立；不额外回复或关闭Issue／PR。
