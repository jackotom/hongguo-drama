# 7.7 四平台正式发行

状态：已于2026-11-20 15:08:15（Asia/Shanghai）正式公开并设Latest。公开版本 `7.7`，内部版本 `7.7.0`，桌面构建 `7.7.1`，冻结源码 `92df757ed7be8ea658ee274a6a429b77f49e54e8`，标签 `v7.7`，Release ID `452358120`。

发行范围：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK与手机APK不在本轮附件或验收范围。

> **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 本轮修复

- `video_tab` 恢复请求改用播放器签名族的无正文 V5 GET，携带 `x-khronos`、`x-helios`、`x-medusa`，正文摘要按空内容计算。
- 不再向该 GET 发送 `Content-Type`、`Content-Encoding`、`x-ss-stub`、`x-ss-req-ticket` 或旧 Argus/Ladon 头。
- 保留匿名身份轮换上限、12 秒模型预算、取消、明确拒绝、精确分集、画质、地址、加密和备用片源校验。
- 参考 `ch6vip/novel-sound` 公开的 GPL-3.0-only 实现并复用项目现有签名代码；许可说明已同步。

## 冻结源码验证

- 冻结源码全量 `npm test` 通过；取源定向测试覆盖正文摘要、嵌套分集、身份轮换、超时、业务码 110001、取消和地址校验。
- 最终签名 arm64 包从官方来源真实下载《诚信第一，我在都市找老赖们收债》第 27、28 集；两集均为 1080×1920、1080P，分别播放到 10.040、10.102 秒后暂停，全程静音、零音量、无媒体错误。
- x64 经 Rosetta 启动并显示 7.7.0。
- Windows 真实 App 队列下载《侯爷临终扶庶子上位，圣旨赐下后他慌了》第 25、26 集，分别静音播放到 10.061、10.048 秒；新装、同版重装和真实 1.80 → 7.7 升级资料保留通过。
- Linux 原生 Ubuntu x64 真实下载《她那么骄》第 70、71 集，CPU 软件解码分别静音播放到 10.338、10.440 秒。

## 发行门槛

- 冻结源码通过全量 `npm test`。
- 双 Mac 从同一冻结源码构建，App 与 DMG重新 Developer ID 签名、Apple 公证 Accepted 并装订；更新 ZIP 从最终签名 App 重新生成。
- Windows 由冻结源码工作流生成安装版、便携 EXE、便携 ZIP、更新清单和对应媒体源码；EXE 保持未签名，并完成真实 App 下载队列与静音播放。
- Linux 由原生 Ubuntu x64 工作流生成 AppImage、对应媒体源码和摘要，并完成启动与两集真实静音播放。
- Draft 汇总四平台应用包、必要更新清单、精确源码、对应媒体源码和 SHA256；远端状态、大小和摘要全部回读后才公开并设 Latest。

## 正式回执

- 双 Mac、Windows x64、Linux x64 AppImage 共 23 份正式附件，总大小 1,560,423,599 字节；22 份载荷逐项核对本地与 GitHub SHA256、远端大小，`SHA256SUMS.txt` 自身摘要也回读一致。
- 全部 23 个匿名下载入口通过 Range 请求返回 HTTP 206；GitHub 公开 Release 与 Latest 均指向 `v7.7`。
- 双 Mac App 与 DMG 本轮重新 Developer ID 签名、Apple 公证 Accepted 并装订；四份公证回执均为 Accepted，App/DMG Gatekeeper 评估通过。最终更新 ZIP 从签名后的 App 重新生成。
- Windows EXE 未签名；GitHub 虚拟机结果不是实体 Windows、独显或长期稳定性验收。Intel Mac 仅完成 Rosetta 启动，不是实体 Intel 设备验收。
- 未替换本机正式安装；Docker、TV 和手机 APK 不在本次附件或验收范围。
- 后置文档提交不移动 `v7.7` 冻结标签，不改变已发布附件字节。

## 依赖审计

- `npm audit --omit=dev`：0。
- 执行不带 `--force` 的 `npm audit fix` 后，开发/构建链剩余 8 个受影响节点（7 moderate、1 high）；来源为 Vite、esbuild、electron-builder/minimatch。生产运行依赖未受影响，不采用会把 electron-builder 降级并把 Vite 升到 8 的 `--force` 方案。
