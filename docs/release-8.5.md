# 8.5 四平台正式发行

状态：已于 2026-11-27 02:13（Asia/Shanghai）正式公开并设 Latest。公开版本 `8.5`，内部版本 `8.5.0`，桌面构建 `8.5.1`，运行代码冻结 `d71d6472056969493a2aedff05d5e8662369efbe`，Release ID `459717507`。

发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK 与手机 APK 不在本轮附件或验收范围。

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 本轮变化（8.4 → 8.5）

- **全集分集读取恢复（#217）**：官网剧集页 `vid_list` 仅剩 3 集且改为混淆 `v1_...` ID 后，分集列表升级为 `openhongguo`（`getSeriesBatch`）→ 签名 App `POST /novel/player/video_detail/v1/`（保留 64 位整数精度）→ 官网（识别并拒绝预览）→ 旧 preload 兜底；固定 `openhongguo` 请求头 `Accept-Encoding: gzip` 避免 Brotli 解压失败；补齐 `DEVICE_REJECTED` 设备重置重试、独立超时预算、错误脱敏与 `content_type` 保留。
- **官网公开片源兜底恢复**：适配官网 `v1_...` 分集混淆令牌映射，恢复前 3 集在公开兜底接口的 360P MP4 回退。
- **双栈 Fake-IP 代理兼容（#215）**：将 `fc00::/18` 与 `::ffff:198.18.0.0/111` 纳入受信任 DoH 回退判断（仍严格拒绝私网直连及混合私网响应），并区分官网与非官网错误提示。
- **兼容模式防循环与产物校验（#216）**：转码后校验文件体积与 `ffprobe` H.264 视频轨，硬件编码产物异常时自动回退 `libx264`；软转码后仍无法播放时按集熔断不再跨画质重复自动转码，并透传 `contentType`。

## 验证

- 本地回归：`npm run lint`（144 份源码 + 3 份 JSON）、`openhongguo-source`（12/12）、`check-source-recovery`（22/22）、`check-web-media-guard`（18/18）、`check-compat-lifecycle`、`check-source-retry`、`check-ui-state`、`check-release-version`、`npm run build:react`、`npm audit --omit=dev`（0 漏洞）全绿。
- macOS arm64 / x64：双 App 与双 DMG 均完成 Developer ID 签名、Apple 公证 Accepted、装订与严格校验；更新 ZIP 从装订后最终 App 重新生成并校验 SHA512；双最终 DMG 只读挂载后通过 Gatekeeper（`Notarized Developer ID`）及普通 LaunchServices 启动验收（arm64 与 x64 Rosetta 均启动 3 个 Helper，实体 Intel Mac 未验）。
- Windows x64：GitHub Windows 虚拟机云端构建与验收通过（Actions `#45870333591`），含真实两集 SDK 队列、暂停恢复、逆序批量重试、静音播放、高性能转换、单文件便携版及 NSIS 新装/重装/`1.80 → 8.5` 升级资料保留；EXE 未签名。
- Linux x64：GitHub Ubuntu 云端最终 AppImage 构建与两集真实静音播放验收通过（Actions `#45870339174`）。
- Windows/Linux 产物由 GitHub Actions（`#45872258685`）直接上传至 Draft，不经本机中转；23 份附件远端摘要与匿名下载入口已核对，`/releases/latest` 已跳转 `v8.5`。

## 公证回执

- arm64 App：`ee406759-544b-4ee9-9160-9523c6b2d172`
- x64 App：`424c73c0-3020-444c-ad0e-695b03d69bed`
- arm64 DMG：`57c4e31a-8172-4df0-869d-042c79741456`
- x64 DMG：`5ce5ddc8-ce65-472b-ad8e-543005fb3d1e`

## 致谢

特别感谢 **[@beilunyang](https://github.com/beilunyang)**、**[@81199000](https://github.com/81199000)** 及社区反馈者（完整名单见 [CONTRIBUTORS.md](../CONTRIBUTORS.md)）。
