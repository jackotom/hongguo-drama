# 8.2 四平台修复候选（Draft）

状态：**未公开发布**。2026-11-24 的 8.2 首个公开包因 macOS 普通启动崩溃已撤回为 Draft，Latest 恢复 `8.1`。当前修复候选不能从旧 Draft 附件直接下载或重新公开。

- 公开版本：`8.2`
- 内部版本：`8.2.0`
- 桌面构建：`8.2.1`
- 代码冻结：`4ef6b05`
- 原 Release ID：`456354972`，仅剩旧候选附件，等待替换
- 发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 本轮修复

### 取源顺序

当前默认顺序：

1. V8/当前 App 官方入口：`preload/v1`、`video_tab`、player/model 及有界旧入口。
2. V8/当前 App 失败后，进入 SDK v5。
3. SDK 也失败后，才使用官网公开片源、旧接口或其他既有回退。

下载任务继续记录真实 `sourceProvider`，V8 成功为 `official`，SDK 成功为 `sdk`。不得把一条来源的结果冒充另一条来源。

### SDK 会话与批量

- 合入 PR #189：Windows x64 SDK v5、跨平台文件锁、`--serve` JSONL 会话复用、会话失效后单次重新引导。
- 合入 PR #190：同一数字队列中最多 8 集批量 `multi_video_model/player/v1` 请求。
- 批量结果使用 2 分钟、最多 128 条内存缓存；恢复重试使用 `fresh` 绕过缓存。
- 部分请求取消不会终止仍有等待者的批量任务；全部取消才终止 helper。
- 旧 helper 不识别 `--videos` 时，自动回退单集 `--video`。
- `--serve` 返回 `ok:false` 时立即回调该请求并保留 worker；批量超时或失败直接返回原因，不再重复启动同一分集的单集请求。
- SDK 子进程仍最多 3 个，在线播放拥有既有前台优先级。
- 创作者合集 `1001` 与普通分集 `1004` 分开缓存和批量，不混用内容类型。

### macOS 启动崩溃

- Electron 从 `44.9.1` 升级到 `44.11.5`。
- 主 App 使用 `allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation`。
- Renderer/GPU/Plugin Helper 使用相同的继承 entitlements。
- `hongguo-sdk-playback` 位于 `Contents/Resources`，也已显式获得相同 entitlements，避免 Unicorn/PyInstaller 在 hardened runtime 下申请 JIT 内存失败。
- macOS 已不再依赖 `--js-flags=--jitless` 才能启动。

## 当前验证

### 已完成

- V8 直接取源：最近真实分集 1 次返回 1080P HEVC，当前 App 官方入口、带解密键，耗时约 1.68 秒。
- macOS arm64 最终签名候选：LaunchServices 普通启动成功，窗口出现，10 秒内无新增崩溃报告。
- macOS arm64 打包应用：真实下载 2 集，均为 1080P、`sourceProvider=official`，静音播放到约 10.1 秒，无播放错误。
- macOS SDK 批量和单集：arm64/x64 helper 均识别 `--videos`、`--serve`、`--content-type`；arm64 对 2 个真实分集执行批量取源成功返回 2 个模型。
- 定向回归：SDK 会话/批量/取消/缓存、V8 先于 SDK、下载队列、播放 pacing 通过。
- PR #189、#190 已作为真实 merge commit 合入当前分支，保留贡献者提交历史。

### 未完成

- Windows 最终源码包的真实下载、后台队列、静音播放、安装与升级。
- Linux 最终 AppImage 启动与真实播放。
- 双 Mac 最终 App/DMG 公证、装订、Gatekeeper 和更新 ZIP 回解压。
- 精确源码 ZIP、媒体对应源码、总 SHA256、23 份附件远端核对和匿名 Range 入口。
- 最终源码上的 Test/Windows/Linux CI 全部通过。

## 发布门槛

只有以下条件全部满足后，才可把原 Draft 的旧附件替换为最终候选、移动 `v8.2` 标签到冻结源码、公开 Release 并设 Latest：

1. 四平台附件全部由同一冻结源码构建。
2. macOS 最终 App/DMG 使用 Developer ID 签名、Apple 公证 Accepted、装订并通过 Gatekeeper；主程序和所有 Helper/SDK entitlements 校验通过。
3. Windows 使用最终 App 完成真实两集下载和静音播放，不能用脚本下载或旧包结果替代；安装升级另验。
4. Linux 使用最终 AppImage 启动并真实播放。
5. Test、Windows、Linux CI 绑定同一冻结 SHA。
6. 23 份附件名称、大小、GitHub SHA256、两份更新清单、精确源码及匿名完整下载全部核对。
7. 重新公开前再次确认 `/releases/latest` 当前仍为 `v8.1`。

## 已知边界

- Windows EXE 尚未配置 Authenticode 签名。
- Intel Mac 只能通过 Rosetta 启动时，不等同实体 Intel Mac 播放验收。
- Linux 没有 SDK helper，继续使用 V8/当前 App 官方入口和公开片源回退。
- 上游片源仍可能因 404、空响应、拒绝、CDN 超时或权益变化而不可用。
