# 8.1 四平台发行目标

状态：已于 2026-11-23 21:33:46（Asia/Shanghai）正式公开并设 Latest。公开版本 `8.1`，内部版本 `8.1.0`，桌面构建 `8.1.1`，冻结源码 `bc02370ff519adf7a94a20688c5538ac303f4ec7`，标签 `v8.1`，Release ID `455441801`。

发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK与手机APK不在本轮附件或验收范围。

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 本轮修复

- 对应 #179／#180／#181：App 官方入口继续空响应时，macOS 通过独立 SDK v5 执行文件取得后续分集完整 1080P HEVC 模型和内容密钥，不再只依赖官网公开 360P。
- 数字分集下载统一 SDK 优先；SDK 不可用、模型无效或被取消时仍回退原官方入口和网页公开片源。
- SDK 子进程最多同时运行 3 个；取消中的排队请求立即退出。在线播放、预取和普通官方取源保留原 FIFO、1 秒间隔及 403/429 保护。
- SDK 首次初始化先锁定缓存目录，再创建匿名身份并校验固定素材，避免并行下载抢写设备缓存或重复初始化。
- 同一批四个真实分集的取源等待由约 23.36 秒降至约 2.70 秒，均取得 1080P HEVC；《小镇是非多之同床异梦》第 3～5 集由约 7／20／28 秒降至总约 2.02 秒。
- 媒体传输本身不是瓶颈：抽测首字节 297ms、8MB 用时 1.54 秒，约 43.5Mbps。

## 已完成的定向验证

- 全量 `npm test` 通过：582 项单元测试与 118 项平台检查全绿。
- SDK 首次缓存并发实测：复用两份已校验素材、无设备文件的隔离缓存运行四个分集，4.62 秒全部成功，只生成一份权限 `0600` 的设备文件。
- macOS arm64 SDK 执行文件已验证 1080P HEVC 模型；Intel x64 SDK 执行文件在 Rosetta 下验证可运行并返回完整模型。
- 双 Mac 最终 App 与 DMG 本轮重新 Developer ID 签名、Apple 公证 Accepted、装订、Gatekeeper 验证和更新 ZIP 恢复校验通过。
- arm64 最终签名包真实下载《嫌疑人的秘密2藏金生死线》第 1、2 集，均为 1080P；静音播放到 10.077 秒并暂停，画面为 1080×1920。
- x64 最终签名包经 Rosetta 启动并显示 8.1.0。
- Linux 源码 CI `45176314415` 成功：AppImage 启动、三份媒体工具和 CPU/HEVC Wasm 加载，真实第 1、3 集静音播放通过。
- Windows 验收 `45181606439` 成功：真实队列、暂停／恢复、逆序重试、两集静音播放、切集、新装、同版重装及真实 1.80 升级资料保留通过；EXE 未签名。

## 平台边界

- macOS arm64 与 x64 包含对应架构 SDK 执行文件；x64 只在本机 Rosetta 验证，不等同实体 Intel Mac 验收。
- Windows x64 和 Linux x64 本轮未构建 SDK 执行文件，继续使用 8.0 的官方入口和公开片源回退；不能宣称这两个平台已获得后续集完整 1080P SDK 修复。
- 上游同名源码归档当前 SHA256 已变化；本项目固定检查 `scripts/sdk-playback/vendor/phone_account` 中此前通过旧摘要校验的对应源码子集，并用发行附件再次提供准确源码和摘要。

## 发行门槛

- 双 Mac App／DMG 本轮重新 Developer ID 签名、Apple 公证并装订；最终更新 ZIP 从签名后 App 重新生成。
- Windows／Linux 使用冻结源码在平台 CI 构建；Windows EXE 未签名，GitHub Windows 虚拟机验收不等同实体电脑。
- 四平台包、更新清单、精确源码、对应媒体源码和总体 SHA256 齐备并完成远端回读后一次公开并设 Latest。

## 公证回执

- arm64 更新 ZIP：`afeed138-6d6f-4129-84ac-e2962e68fd76`
- x64 更新 ZIP：`e0526c71-7601-4fd5-ace9-cd548fefcd58`
- arm64 DMG：`b041abeb-5587-461e-ad70-86979f389688`
- x64 DMG：`2ba1f015-6275-4585-9aeb-c842fffacf65`

## 正式回执

- 23 份正式附件全部为 `uploaded`，本地与 GitHub 远端名称、大小和 SHA256 逐项一致；总 1,785,141,733 字节。
- `SHA256SUMS.txt` 自身 SHA256 为 `65c00a9bd262a5d58fe0fd3793993040a10cdf3d97e827e35f1b0eedbed66ca3`。
- `latest-mac.yml`、`latest.yml`、总校验文件和精确源码均以无认证请求完整下载并与本地摘要一致。
- 四个主要程序附件匿名 Range 请求均返回 HTTP 206；`/releases/latest` 已跳转 `v8.1`。
- 应用代码冻结于 `b20413b2d46a3d0e5d51e22694cb121477ce1d5d`；最终标签 `bc02370ff519adf7a94a20688c5538ac303f4ec7` 仅额外修改 Windows 验收脚本，不改变随包应用代码。
