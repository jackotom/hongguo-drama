# 8.4 四平台正式发行

状态：已于 2026-11-26 09:48（Asia/Shanghai）正式公开并设 Latest。公开版本 `8.4`，内部版本 `8.4.0`，桌面构建 `8.4.1`，运行代码冻结 `a82112521dc8cf44060b4d3a7bf272ef3a4116b1`，Release ID `458787896`。

发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK 与手机 APK 不在本轮附件或验收范围。

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 本轮变化（8.3 → 8.4）

- **取源与网络加固**：修复本地代理（Clash/VPN）环境下的重定向误判（校验真实 `Location` 目标地址而非代理地址），收紧四通道单源超时预算（`9s / 20s / 12s / 8s`，保留 Windows SDK 首集冷启动 20 秒空间），DLNA 投屏支持多网卡逐一容错发送，为代理连通性测试与官网搜索补充响应体上限及并发去重。
- **主进程性能与 I/O 优化**：解密 Worker 改为零拷贝传输，本地媒体发布与投屏文件 `stat` 改为异步 I/O，HLS 磁盘容量检测增加节流并保留每块内存配额硬校验，观看历史查询消除循环内重复深拷贝。
- **播放器与前端优化**：节流播放进度、弹幕刷新与合并进度回调，修复 React 生命周期竞态与离开搜索页时的全局滚动监听泄漏，剧库选择器支持大小写不敏感搜索，播放器确认弹窗补齐异步异常兜底与语言切换响应，拆分代理/更新 IPC 与播放器弹窗/选集器，完成打包瘦身与前端分包。
- **工程与质量保障**：新增零依赖静态代码检查（`npm run lint`），覆盖语法、单行/嵌套 JSON 重复键、残留 `debugger` 与冲突标记检查。

## 验证

- 本地全量回归：`npm run lint`（144 份源码 + 3 份 JSON）、`npm test`（全部单元测试与 119 项平台检查）、`npm run build:react`、`npm run test:source-pack`、`server/*.test.cjs`（25/25）全绿；`npm audit --omit=dev` 为 0。
- macOS arm64 / x64：两个 App 与两个 DMG 均通过 Developer ID 签名、Apple 公证 Accepted、装订和严格校验；更新 ZIP 从装订后最终 App 重新生成并校验 SHA512 元数据；双最终 DMG 只读挂载后通过 Gatekeeper（`Notarized Developer ID`）及普通 LaunchServices 启动验收（Intel 仅 Rosetta，实体 Intel Mac 未验）。
- Windows x64：GitHub Windows 虚拟机云端构建与验收通过（Actions `#45730958534`），包含真实两集 SDK 下载队列、暂停恢复、逆序批量重试、静音播放、高性能转换、单文件便携版及 NSIS 新装/重装/`1.80 → 8.4` 升级资料保留；EXE 未配置 Authenticode 签名。
- Linux x64：GitHub Ubuntu 云端最终 AppImage 构建与两集真实静音播放验收通过（Actions `#45730964429`）。
- Windows/Linux 产物由 GitHub Actions（`#45737918390`）直接上传至 Draft，不经本机中转；23 份附件远端摘要与匿名下载入口已核对，`/releases/latest` 已跳转 `v8.4`。

## 公证回执

- arm64 App：`b1569613-c57e-41a3-803e-b52cf4b3e64f`
- x64 App：`7e352186-b4ae-4a2e-8b0b-8381be1d4015`
- arm64 DMG：`6633e7e4-0068-4625-8949-2001deca4a9f`
- x64 DMG：`7263b7a0-29a6-43c2-b17d-ca06dbf5a96b`

## 致谢

特别感谢 **[@beilunyang](https://github.com/beilunyang)** 提供 [beilunyang/openhongguo](https://github.com/beilunyang/openhongguo)，以及所有代码与社区贡献者（完整名单见 [CONTRIBUTORS.md](../CONTRIBUTORS.md)）。
