# 7.1 候选与开放 PR 的覆盖核对

> 以下为开发／审查阶段快照；7.1已正式发布，最终范围、包身份与验收见[正式回执](release-7.1.md)。

日期：2026-11-12。对照当前 `codex/fix-7.1-downloads` 工作区。读取四个开放 PR 的真实差异、正文和相关讨论，再跟踪当前源码调用链；本轮只读审查，没有合并 PR、修改依赖或对外回复。现有测试仅核对用例内容，未重复运行，不将旧测试结果当成本轮新增实测。

| PR | 作者 | 当前覆盖情况 |
| --- | --- | --- |
| [#143](https://github.com/jackotom/hongguo-drama/pull/143) | roytjus | Argus551／Ladon 核心修复已等价覆盖，毫秒票据细节不同，尚无证据证明该差异导致故障 |
| [#140](https://github.com/jackotom/hongguo-drama/pull/140) | anupam-orbis | 未覆盖，锁文件仍使用 follow-redirects 1.16.1 |
| [#129](https://github.com/jackotom/hongguo-drama/pull/129) | xinbaojian | 有替代实现：显式选择完整本地文件，不自动降低固定画质 |
| [#92](https://github.com/jackotom/hongguo-drama/pull/92) | roytjus | 缺失内联加密信息时的受约束备用解析已等价覆盖 |

## #140：依赖修补尚未包含

- `package-lock.json:3468` 唯一的 `node_modules/follow-redirects` 锁定为 1.16.1。父依赖为 Axios 1.20.0，声明范围为 `^1.16.0`（约 2314～2320 行）。根锁与 Android 锁均已检查，Android 不含此包，也未发现另一嵌套副本。
- PR 标题写升级 1.16.2，实际差异升级到 1.16.3。不能仅看标题认定当前已升级。
- [官方 GHSA-mrwp-f3q8-3g9p](https://github.com/follow-redirects/follow-redirects/security/advisories/GHSA-mrwp-f3q8-3g9p) 确认 CVE-2026-116689 影响 1.16.0～1.16.1，1.16.2 修复跨 JavaScript realm 的 `sensitiveHeaders` 数组识别问题。
- 同一公告明确：Axios 1.20.0 会规范化数组，其组合未复现该漏洞。本项目未发现直接调用 follow-redirects 或传递 sensitiveHeaders 的代码。因此确认的是“依赖补丁缺失”，不是已经证明本项目发生凭据泄漏。后续仍应单独更新锁文件并检查重定向行为。

## #129：已有完整本地文件的出口存在

- `src/components/Player.jsx:400` 起区分本地画质不足、画质未知、加载失败；`446`、`664` 附近保留具体失败原因。
- `chooseLocalPlayback`（约 1100 行）提供“播放已有本地文件”，先刷新详情，再核对同剧、同集、登记文件、完成状态、未锁定与版本有效性；保留进度和暂停状态，仅授权当前文件，不改变固定画质偏好。
- 按钮位于错误面板约 2075 行。主进程约 `main.js:2685` 及 `src/native/media-access.js` 仍检查并登记本地路径，不接受任意路径。
- 现有 `scripts/check-player-online-quality.cjs:268` 起包含已有／等待完成的低画质和未知画质、暂停进度、身份变化、过期授权、坏文件等用例。
- PR 的“自动回退”没有原样采用；当前方案需用户多点一次。不能写成 PR 已合并，也不能写成用户仍完全无法使用已有文件。

## #92：内联元数据缺失恢复已覆盖

- `src/native/app-source.js:470` 起，完整内联模型直接解析；仅缺少加密信息时，才允许一次备用解析。
- 备用模型必须保持相同字符串视频 ID、正时长且误差不超过 0.5 秒、明确加密状态、实际尺寸不低于原要求，并保留期限、取消、域名和密钥校验。
- `src/native/app-source-inline-fallback.test.cjs` 已有相关接受／拒绝用例；`docs/inline-playback-metadata-fallback.md` 已保留 roytjus／#92 的贡献署名。
- 当前解析器还支持顶层未加密标记和 ByteVC2，不应整块替换回 PR 较旧实现。该修复不处理空正文、注册拒绝或批量限流。

## #143：签名主体已覆盖，保留细节差异

- `src/native/playback-signature.js` 已有真实 Argus551／Ladon，来源和固定版本见既有算法许可声明。
- `src/native/app-source.js:149` 起按最终 query、实际 gzip 正文字节、时间和身份生成签名；GET 不附正文 stub，换路后重新签名。当前播放请求不再使用旧 Gorgon／Helios／Medusa 组合。
- PR 令 `x-ss-req-ticket` 与 query `_rticket` 使用同一原始毫秒值；当前 `signPlayer`（约 137 行）使用整秒乘 1000，query 则保留原毫秒，相差 0～999 毫秒。
- 当前 `src/native/app-source-video-tab.test.cjs:55` 起明确允许该差异；`src/native/playback-signature.test.cjs` 另有固定密文向量和输入绑定用例。本轮没有证据表明票据差异导致实际故障，不能据此重复替换当前签名实现。
- 当前 551 实现来自独立固定来源，不应写成已合并 #143；局部样本成功亦不能外推所有设备、剧集和长期上游恢复。

## 边界

以上核对不改变四个 PR 的开放状态。7.1 尚未打包或发布；本轮没有运行 PR 分支、增加真实网络请求或执行跨平台验收。贡献致谢包含所有 PR 提交者，和是否合并、是否原样采用分开记录。
