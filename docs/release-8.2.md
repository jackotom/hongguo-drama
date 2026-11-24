# 8.2 四平台发行目标

状态：当前为源码／发行目标，尚未正式公开，最新公开正式版仍为 `8.1`（`v8.1`）。公开目标版本 `8.2`，内部版本 `8.2.0`，桌面构建 `8.2.1`，目标标签 `v8.2`。

发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK 与手机 APK 不在本轮附件或验收范围。

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 本轮改动

- **Windows x64 SDK v5 播放取源接入**：
  - `scripts/sdk-playback/resolve_cli.py` 兼容 Windows（使用 `msvcrt.locking` 替代 POSIX `fcntl` 缓存文件锁，跳过 Windows 不支持的 `chmod 0600`）。
  - `src/native/sdk-playback.js` 支持 `win32-x64/hongguo-sdk-playback.exe` 路径解析，与 macOS 共用 3 进程并发上限、前台播放优先、超时与取消清理。
  - 新增 `scripts/build-sdk-playback-win.ps1`，并在 `.github/workflows/windows.yml` 中接入 Python 3.11、PyInstaller 打包、缓存与 `--help` 校验。
- **创作者合集与当前 App V5 `preload/v1` 兜底**：
  - 支持创作者合集详情与分集播放恢复。
  - SDK 失败后的官方兜底优先请求当前 App V5 `preload/v1`，失败时保留原有有界链路与官网公开兜底。
- **Android 构建隔离**：
  - Android／TV 构建打包时将原生 `sdk-playback` 隔离为空实现，不改变桌面端 SDK 逻辑。

## 本地已完成的定向验证

- 版本与配置回归、Windows/Linux 配置检查、`sdk-playback` / `playback-v5` / `app-source` / `hongguo-creator-album` 单元测试、Python 语法编译检查与 `android` 单元测试（详见本轮交付记录）。

## 待完成发行门槛（需在本机终端与 GitHub Actions 执行）

- 推送源码并确认通用 `Test`、Windows x64（含 `hongguo-sdk-playback.exe` 打包、真实验收下载／播放、安装与 1.80 升级）与 Linux x64 AppImage 工作流通过。
- 在本机 macOS 终端使用 Developer ID 证书重新签名双 Mac（arm64 与 x64）App 与 DMG，提交 Apple 公证（`xcrun notarytool submit --wait`）并装订（`xcrun stapler staple`），从签名并装订后的 App 重新生成更新 ZIP 与 `latest-mac.yml`。
- 汇总四平台正式包、更新清单、精确应用源码、各平台对应媒体源码和 `SHA256SUMS.txt`，在 Draft 核对远端大小、SHA256 与匿名下载入口后一次公开并设为 Latest。

## 平台边界

- 当前尚未执行 8.2 的双 Mac 重新签名／公证、Windows CI 实机／虚拟机打包验收和 Linux CI 验收；8.1 的历史签名、公证和 CI 结果不替代 8.2 验收。
- Windows EXE 当前未配置代码签名证书，正式发行页须保持标明未签名。
- Linux x64 本轮仍未构建 SDK 执行文件，继续使用官方接口和公开片源回退。
