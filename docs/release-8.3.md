# 8.3 四平台正式发行

状态：已于 2026-11-25 12:50:48（Asia/Shanghai）正式公开并设 Latest。公开版本 `8.3`，内部版本 `8.3.0`，桌面构建 `8.3.1`，运行代码冻结 `f31d87437a77e9b1b3fa8dfd81c9cecee52296eb`，Release ID `457646713`。

发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK 与手机 APK 不在本轮附件或验收范围。

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 取源架构

默认顺序改为：

1. `openhongguo` 社区 SDK：固定 `0.4.1`，本地 Go/WASM，不执行远程脚本。
2. Windows/macOS SDK helper。
3. App 官方动态签名策略包。
4. 官网公开完整片源。

用户可在设置中上下调整四条通道并恢复默认。openhongguo 遇到 `ANONYMOUS_LIMITED` 后冷却 60 秒，再继续回退到 SDK、App 或官网。

## 本轮变化

- 新增 Ed25519 签名的声明式取源策略包，可热更新官方 App 请求入口、顺序、字段和 `v5/player/none` 签名族。
- 策略由主、备用双密钥和 `keyId` 验证；支持 GitHub Raw、jsDelivr、Fastly jsDelivr 镜像回退，镜像篡改仍会被验签拒绝。
- 在线策略不会执行远程 JavaScript、Python、WASM 或任意脚本；域名、请求头和受保护身份字段均有白名单限制。
- 支持手动检查、回滚上一版，并抑制自动重装已回滚策略。
- 新增用户取源优先级、恢复默认顺序和 SDK 不可用提示。
- 固定接入 `openhongguo@0.4.1`；Axios transport 继承应用代理，媒体地址经过公网 URL 校验，编码仅放行 H.264/HEVC。
- 修复 Android 共享播放 bundle 对新增 `node:os` 依赖的跨平台打包。

## 验证

- 源码 CI 通过；`npm test` 单元、平台检查、Android bundle 与 `main` 签名包检查全绿。
- macOS arm64：从最终 DMG 普通启动，界面报告 `v8.3`；真实分集静音播放至 15 秒，当前画面 1080P，并检查全屏与切集。
- macOS x64：最终 DMG 内 App 经 Rosetta 普通启动，界面报告 `v8.3`；实体 Intel Mac 未验。
- Linux x64：云端最终 AppImage 启动，两集真实静音播放 10 秒，画质 360P。
- macOS 两个 App 与两个 DMG 均通过 Developer ID 签名、Apple 公证 Accepted、装订和严格校验；更新 ZIP 从最终签名 App 重新生成并验证签名、公证、版本及 SHA512 元数据。
- Windows x64：GitHub Windows 虚拟机云端构建与验收通过。真实两集队列均由打包 SDK 完成下载，静音播放至少 10 秒；暂停恢复、逆序批量重试、切集、全屏、高性能转换、单文件便携版及安装器均通过。
- Windows 安装器：新装、同版重装和真实 `1.80.0 → 8.3.0` 升级通过，设置、本地存储、观看历史和已有下载均保留。
- Windows/Linux 构建产物由 GitHub Actions 直接上传至 Draft，不经本机中转；上传前核对冻结源码 SHA 与平台 SHA256。

## 公证回执

- arm64 App 压缩包：`0607090a-830a-4dbc-b3d8-b2d47ca2ba0c`
- x64 App 压缩包：`a4111e6d-fbc7-4d6c-ad92-b4dbdb8f81b8`
- arm64 DMG：`1a23262d-62fc-4111-927e-b632bbeef794`
- x64 DMG：`6a72de33-9a4b-4d73-8fb3-92e9e1b85756`

## 平台边界

- Windows EXE 未配置 Authenticode 签名；GitHub Windows 虚拟机验收不等同实体 Windows、独显或长期稳定性。
- Intel Mac 仅完成 Rosetta 启动，不等同实体 Intel 播放验收。
- Linux 没有 SDK helper，继续使用 openhongguo、App 官方入口和公开片源回退。
- 上游片源仍可能因限流、404、空响应、拒绝、CDN 超时或权益变化而不可用；openhongguo 匿名限制冷却只能减少无效重试，不能保证所有内容可播。
- 23 份附件已全部上传并与本地摘要一致，23 个匿名下载入口返回 HTTP 200；`/releases/latest` 已跳转 `v8.3`。
