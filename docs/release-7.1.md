# 7.1 发行目标

状态：源码／发行目标，尚未公开。内部7.1.0、桌面构建7.1.1；基于正式7.0。双Mac、Windows x64、Linux x64 AppImage、Docker amd64同源一次发行，不替换本机正式安装。

## 修复与贡献

- #148：恢复、手动／自动重试只在同剧已有队列槽位内按集号升序，跨剧优先顺序不变。
- #147：临时文件dev／ino／birthtimeNs精确持久化，BigInt不流入JSON；旧安全Number收据兼容，旧不安全身份和替换文件继续保留，下载空间统计不变。
- 采纳anupam-orbis的[#140](https://github.com/jackotom/hongguo-drama/pull/140)实际依赖锁更新：follow-redirects 1.16.1升至1.16.3。新增本项目回环HTTP重定向回归，旧依赖先失败、新依赖通过；不能据此宣称本项目已发生凭据泄漏，Axios 1.20.0组合未复现该漏洞。
- #92、#143和#129已有等价／独立覆盖，保留当前签名、受检备用取源与显式选择本地文件语义，不整块复制旧方案。见[PR审查](pr-review-7.1-2026-11-12.md)。
- README、CONTRIBUTORS.md与打包native数据完整致谢历史提交作者、PR提交者和Issue作者；GitHub右侧Contributors仍按真实提交自动生成，不伪造作者。

## 现有验证

下载队列9项、临时身份集成16项、ByteVC2转换器30项、重启／NAS保护16项，共71项定向检查通过；前端生产构建通过。源码及开发Electron窗口真实下载／静音播放证据见[#147／#148记录](issue-147-148-7.1.md)，不替代本轮最终包验收。

升级依赖通过官方包完整性核对、跨域凭据剥离／同源保留与Axios集成；共享旧依赖不用于正式构建。Windows验收新增最终App真实下载队列，实际平台结果待冻结后CI。

## 尚待发行门

唯一冻结源码、本轮五类构建／验收、双Mac新Developer ID签名及App／DMG Apple Accepted和装订、最终更新ZIP恢复、Windows安装升级及App真实下载队列、Linux真实静音播放、Docker认证下载合并与重启持久化。25份正式附件、精确源码、9份媒体对应源码、两份更新清单与总SHA先在Draft核对，再统一公开Latest。未完成不写通过。

Windows EXE未签名；Intel Mac仅按本轮实际Rosetta覆盖记录；实体硬件、其它Linux／GPU／FUSE、Docker ARM64、上游长期稳定性及人工听音不外推。TV和手机独立；不额外回复或关闭Issue／PR。
