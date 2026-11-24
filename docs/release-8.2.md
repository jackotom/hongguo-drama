# 8.2 四平台正式发行

状态：已于 2026-11-24 14:05:26（Asia/Shanghai）正式公开并设 Latest。公开版本 `8.2`，内部版本 `8.2.0`，桌面构建 `8.2.1`，冻结源码 `2303f85b589417eee16e260ff341429656729617`，标签 `v8.2`，Release ID `456354972`。

发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK 与手机 APK 不在本轮附件或验收范围。

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 本轮改动

- **Windows x64 SDK v5 播放取源接入**：
  - `scripts/sdk-playback/resolve_cli.py` 兼容 Windows `msvcrt.locking` 缓存锁，并在启动时检测 Control Flow Guard。
  - `src/native/sdk-playback.js` 支持 `win32-x64/hongguo-sdk-playback.exe` 路径解析，与 macOS 共用 3 进程并发上限、前台播放优先、超时与取消清理。
  - Windows helper 使用 `PYINSTALLER_COMPILE_BOOTLOADER=1`、`PYINSTALLER_BOOTLOADER_WAF_ARGS=--no-cfg` 重建 bootloader；规避 Unicorn `longjmp` 与 Windows CFG 冲突导致的 `0xC0000409`。
- **下载与片源策略**：
  - 数字分集下载恢复为 SDK 优先、最多 3 个 SDK 子进程有界并行；SDK 失败后回退当前官方入口和网页公开片源。
  - 下载任务记录实际 `sourceProvider`；Windows 最终验收强制两集均为 `sdk`，官方兜底不能冒充 SDK 通过。
- **创作者合集与当前 App V5 兜底**：
  - 支持创作者合集详情与分集播放恢复。
  - SDK 失败后的官方兜底优先请求当前 App V5 `preload/v1`，失败时保留原有有界链路与官网公开兜底。
- **构建隔离与签名**：
  - Android／TV 构建将原生 `sdk-playback` 隔离为空实现，不改变桌面端 SDK 逻辑。
  - 构建中间产物写入 `build/sdk-playback-work/`，随包目录仅保留执行文件。
  - `scripts/sign-mac-app.sh` 自底向上签名嵌套二进制与框架；双 Mac App／DMG重新 Developer ID 签名、公证、装订。

## 验证

- **Test**：`45332740306` 成功。
- **Windows**：`45332740222` 成功。最终便携包随机真实两集均为 1080P HEVC，`sourceProvider=sdk`；暂停／恢复、逆序重试、静音播放、切集、新装、同版重装及真实 1.80 → 8.2 升级资料保留通过。EXE 未签名，GitHub Windows 虚拟机验收不等同实体电脑。
- **Linux**：`45332752156` 成功。AppImage 启动、三份媒体工具与 HEVC Wasm 加载，真实第 1、3 集静音播放通过。
- **macOS arm64**：最终签名包真实下载第 1、2 集，均为 1080P、`sourceProvider=sdk`，静音播放到约 10.1 秒。当前主机虚拟内存 CodeRange 不足，测试进程使用 `--js-flags=--jitless`；不是发布包默认参数。
- **macOS x64**：最终签名包经 Rosetta 启动并显示 8.2.0；实体 Intel Mac 未验。
- 四份 Apple 公证均为 Accepted：
  - arm64 App 压缩包：`886aa408-0197-45c5-a49c-43b9dc7f5c70`
  - x64 App 压缩包：`d8cf09cc-e185-4bf7-8fb8-ea3d1ad22681`
  - arm64 DMG：`d63626ef-9215-45e1-9d78-226d85d9ea20`
  - x64 DMG：`c0d7b4e5-a96c-4f24-96f5-b17b6731b32f`

## 正式回执

- 23 份正式附件全部为 `uploaded`，总 1,880,606,208 字节；本地与 GitHub 远端名称、大小和 SHA256 逐项一致。
- `SHA256SUMS.txt` 自身 SHA256 为 `9857bdd552b026389febf34cebc2b8a98ef1f1a73d614805e3ae1de1cb55b12a`。
- 23 个匿名 Range 入口均返回 HTTP 206；`SHA256SUMS.txt`、两份更新清单和两份源码 ZIP 已匿名完整下载并逐字节核对。
- 标签 `v8.2` 指向 `2303f85b589417eee16e260ff341429656729617`；`/releases/latest` 已跳转 `v8.2`。

## 平台边界

- Windows EXE 未配置 Authenticode 签名；不能把 GitHub 虚拟机结果外推为实体 Windows、独显或长期稳定性。
- Intel Mac 只完成 Rosetta 启动，不等同实体 Intel 播放验收。
- Linux x64 本轮仍未构建 SDK 执行文件，继续使用官方接口和公开片源回退。
- 上游片源仍可能因 404、空响应、拒绝、CDN 超时或权益变化而不可用，不承诺所有内容永久可播。
