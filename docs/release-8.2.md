# 8.2 四平台正式发行

状态：已于 2026-11-24 15:56:30（Asia/Shanghai）正式公开并设 Latest。公开版本 `8.2`，内部版本 `8.2.0`，桌面构建 `8.2.1`，运行代码冻结 `4ef6b05f43f9345a5d0c98ddc0472870be541c79`，最终源码/标签 `ea5a852f65acdc4c5b11265ca13b03d115096dc7`，Release ID `456354972`。

发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK 与手机 APK 不在本轮附件或验收范围。

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 取源架构

默认顺序：

1. V8/当前 App 官方入口：`preload/v1`、`video_tab`、player/model 及既有有界官方链路。
2. V8/当前 App 失败后进入 SDK v5。
3. SDK 失败后才使用官网公开片源、旧接口或其他既有回退。

下载任务继续记录真实 `sourceProvider`。V8 成功为 `official`，SDK 成功为 `sdk`。

## 本轮变化

- 合入 PR #189：Windows x64 SDK v5 helper、跨平台文件锁、`--serve` JSONL 会话复用及会话失效重引导。
- 合入 PR #190：同一数字下载队列最多 8 集批量 SDK 取源、2 分钟缓存、取消等待者、旧 helper 单集回退。
- `--serve` 返回 `ok:false` 时立即回调并保留 worker；批量超时或失败直接返回原因，不再重复启动同一分集的单集请求。
- 创作者合集 `1001` 与普通分集 `1004` 分开缓存和批量，不混用内容类型。
- Electron 升级到 `44.11.5`；macOS 主程序、Renderer/GPU/Plugin Helper 与 SDK helper 均配置 hardened runtime 所需 entitlements。
- Windows helper 使用无 CFG 的 PyInstaller bootloader，避免 Unicorn `longjmp` 与 Windows Control Flow Guard 冲突。

## 验证

- **macOS arm64**：普通 LaunchServices 启动、最终 DMG 内直接启动均成功；打包应用真实下载 2 集，均为 1080P、`sourceProvider=official`，静音播放到约 10.1 秒，无播放错误。
- **macOS x64**：最终包经 Rosetta 启动，报告 8.2.0 且 SDK helper 可用；实体 Intel Mac 未验。
- **Windows x64**：CI `45344065084` 成功。真实两集均记录 `sourceProvider=official`；下载队列、暂停恢复、逆序重试、静音播放、切集、新装、同版重装和真实 1.80 → 8.2 升级资料保留通过。
- **Linux x64**：CI `45344697217` 成功。最终 AppImage 启动、媒体组件与 HEVC Wasm 加载，真实两集 1080P 静音播放通过。
- **SDK helper**：arm64/x64 均识别 `--videos`、`--serve`、`--content-type`；arm64 对 2 个真实分集批量取源成功返回 2 个模型。
- **本地回归**：`npm test` 的 604 个单元用例和 118 项平台检查通过；SDK 会话、批量、取消、旧 helper 回退及定时器清理通过。
- **公开入口**：23 份附件全部为 `uploaded`，总 1,881,618,697 字节；远端名称、大小和 SHA256 与本地一致；23 个匿名 Range 入口返回 HTTP 206，五份小文件匿名完整下载逐字节一致。
- `/releases/latest` 已跳转 `v8.2`。
- 用户已在自己的 Windows 和 Mac 电脑上实测正常使用。GitHub Test 补跑两次被 Ubuntu `apt-get` 软件源下载卡住并取消，未进入 npm 测试；本地同一源码的 604 单元用例和 118 平台检查全部通过。该基础设施失败不改变已核对附件字节。

## 公证回执

- arm64 App 压缩包：`cf61873c-4a0c-44fa-9516-5deb2945303c`
- x64 App 压缩包：`af1fcbaf-0caa-4978-8180-66001973377a`
- arm64 DMG：`bf3dbb0b-01cf-442d-a7c1-d21529f73f63`
- x64 DMG：`dc421b4e-f169-4fc5-9edd-2e6df8df84ab`

## 平台边界

- Windows EXE 未配置 Authenticode 签名；GitHub Windows 虚拟机验收不等同实体 Windows、独显或长期稳定性。
- Intel Mac 仅完成 Rosetta 启动，不等同实体 Intel 播放验收。
- Linux 没有 SDK helper，继续使用 V8/当前 App 官方入口和公开片源回退。
- 上游片源仍可能因 404、空响应、拒绝、CDN 超时或权益变化而不可用。
- 依赖告警均不在生产依赖中；`npm audit --omit=dev` 为 0。未执行会把 electron-builder 降级或将 Vite/esbuild 跨 major 升级的 `--force` 修复。
