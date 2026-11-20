# 7.7 四平台发行目标

状态：源码／发行目标，尚未公开。公开版本 `7.7`，内部版本 `7.7.0`，桌面构建 `7.7.1`。

发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK与手机APK不在本轮附件或验收范围。

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 本轮修复

- `video_tab` 恢复请求改用播放器签名族的无正文 V5 GET，携带 `x-khronos`、`x-helios`、`x-medusa`，正文摘要按空内容计算。
- 不再向该 GET 发送 `Content-Type`、`Content-Encoding`、`x-ss-stub`、`x-ss-req-ticket` 或旧 Argus/Ladon 头。
- 保留匿名身份轮换上限、12 秒模型预算、取消、明确拒绝、精确分集、画质、地址、加密和备用片源校验。
- 参考 `ch6vip/novel-sound` 公开的 GPL-3.0-only 实现并复用项目现有签名代码；许可说明已同步。

## 当前候选验证

- 取源定向测试 103/103 通过，覆盖正文摘要、嵌套分集、身份轮换、超时、业务码 110001、取消和地址校验。
- 隔离测试包与当前 `app-source.js`、`playback-v5.js` 源码逐字节一致。
- 2026-11-20 使用当前隔离包从官方来源真实下载《一把杀猪刀，供出女状元》第 62、63 集；两集均为 1080×1920、1080P，分别播放到 10.012、10.063 秒后暂停。全程 `muted=true`、`volume=0`、无媒体错误，各提交 306 帧。
- Windows、Linux 与最终签名包的冻结源码验收尚未在本节宣称通过。

## 发行门槛

- 冻结源码通过全量 `npm test`。
- 双 Mac 从同一冻结源码构建，App 与 DMG重新 Developer ID 签名、Apple 公证 Accepted 并装订；更新 ZIP 从最终签名 App 重新生成。
- Windows 由冻结源码工作流生成安装版、便携 EXE、便携 ZIP、更新清单和对应媒体源码；EXE 保持未签名，并完成真实 App 下载队列与静音播放。
- Linux 由原生 Ubuntu x64 工作流生成 AppImage、对应媒体源码和摘要，并完成启动与两集真实静音播放。
- Draft 汇总四平台应用包、必要更新清单、精确源码、对应媒体源码和 SHA256；远端状态、大小和摘要全部回读后才公开并设 Latest。

## 依赖审计

- `npm audit --omit=dev`：0。
- 执行不带 `--force` 的 `npm audit fix` 后，开发/构建链剩余 8 个受影响节点（7 moderate、1 high）；来源为 Vite、esbuild、electron-builder/minimatch。生产运行依赖未受影响，不采用会把 electron-builder 降级并把 Vite 升到 8 的 `--force` 方案。
