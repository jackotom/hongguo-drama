# 红果短剧项目规则

## 8.5 正式发行（2026-11-27）

- 从公开 8.4 增加 0.1 至 8.5，内部 `8.5.0`、桌面构建 `8.5.1`，运行代码冻结 `d71d6472056969493a2aedff05d5e8662369efbe`，标签 `v8.5`，Release ID `459717507`；2026-11-27 02:13（Asia/Shanghai）正式公开并设 Latest。修复 #217（`openhongguo` + 签名 App `video_detail/v1` 全集读取与 `v1_...` 官网公开兜底）、#215（双栈 Fake-IP `fc00::/18` DoH 回退）与 #216（兼容模式产物校验及防循环熔断）。23 份附件远端摘要与匿名入口已核对通过（详见 `docs/release-8.5.md`）。

## 8.4 正式发行（2026-11-26）

- 从公开 8.3 增加 0.1 至 8.4，内部 `8.4.0`、桌面构建 `8.4.1`，运行代码冻结 `a82112521dc8cf44060b4d3a7bf272ef3a4116b1`，标签 `v8.4`，Release ID `458787896`；2026-11-26 09:48（Asia/Shanghai）正式公开并设 Latest。23 份附件远端摘要与匿名入口已核对通过。

## 发布正常可用性硬门禁（2026-11-24）

- 以后任何更新在上传 GitHub 前，必须先用最终包按用户正常入口实测“能打开发并正常使用”；不能只用构建成功、签名、公证、特殊参数启动或局部窗口检查代替。
- macOS 必须从最终 DMG／App 普通双击或 LaunchServices 启动，不得依赖 `--js-flags`、`--user-data-dir` 等测试专用参数；Windows 必须有真实下载与播放，Linux 必须有最终 AppImage 启动与播放。
- 2026-11-24 的 8.2 首个公开 Mac 包因 Electron 44.9.1 在当前 macOS 的 V8 CodeRange 初始化崩溃，普通启动即 `EXC_BREAKPOINT`。该 Release 已撤回为 Draft，Latest 恢复 8.1；最终包必须同时给 Electron 主程序、Renderer/GPU Helper 和 SDK helper 配置 JIT 所需 entitlements，再普通启动验证。

## 云端构建、上传与统一公开规则（2026-11-25）

- 用户明确当前网络不稳定；除必须在本地完成 Developer ID 签名、公证和装订的 macOS 外，Windows、Linux 及其他可云端构建的发行附件必须先由 GitHub Actions 云端虚拟机构建、验收，并从 Actions 直接上传到同一个 Draft Release。
- 禁止把云端已经能够生成的 Windows/Linux 大文件下载到本机后再上传；云端直传前必须核对冻结源码 SHA、平台 SHA256 和 Draft 状态。
- macOS 可在本机构建、签名、公证和装订，完成后及时把最终 DMG、更新 ZIP 和 `latest-mac.yml` 上传到同一 Draft，不必等待其他平台全部完成。
- 允许 Draft 分流推进和补传，但所有四平台产物、必要源码/媒体源码、更新清单和总 SHA256 齐备并核对前，不得公开 Release、更新 Latest 或发布部分平台。
- 云端构建或上传失败时保留 Draft 并修复重跑；未经用户明确授权，不得改回本机构建/上传 Windows 或 Linux 来绕过云端门禁。

## 8.3 动态取源与社区 SDK 正式发行（2026-11-25）

- 从公开 8.2 增加 0.1 至 8.3，内部 8.3.0、桌面构建 8.3.1，运行代码冻结 `f31d87437a77e9b1b3fa8dfd81c9cecee52296eb`，标签 `v8.3`，Release ID `457646713`；2026-11-25 12:50:48（Asia/Shanghai）公开并设 Latest。
- 默认取源顺序固定为 `openhongguo → SDK → App 动态策略 → 官网公开片源`；openhongguo 的 `ANONYMOUS_LIMITED` 冷却 60 秒后继续回退。
- 动态策略只接受 Ed25519 签名 JSON，不执行远程脚本；支持主备密钥、镜像回退、用户排序、手动检查和回滚。
- Windows/Linux 候选由 GitHub Actions 云端构建、验收并直接上传 Draft，不再下载到本机再上传；macOS 本机签名、公证和装订后上传。
- macOS arm64 最终 DMG 普通启动、真实 1080P 静音播放、全屏与切集通过；x64 仅 Rosetta 启动；Windows 虚拟机真实两集队列、播放、安装/重装/1.80 升级通过；Linux AppImage 两集静音播放通过。23 份附件与匿名入口核对通过。

## 对外回复方式（2026-11-07起）

- 本项目后续对外回复、GitHub Issue／PR 评论不得携带“使用 ChatGPT Codex 连接器”等连接器提示或署名。
- 发布回复时选择不会附加该标记的可用方式；无法确认时先保留草稿并说明限制，不使用会自动附加标记的连接器提交。
- 此规则不授权新增对外回复，也不要求修改或删除历史评论；对外写入仍须已有明确授权。

## 后续四平台发行与 Android／TV下载推荐（2026-11-17起）

- 用户明确要求本项目以后发布四平台附件：macOS Apple Silicon arm64、macOS Intel x64、Windows x64、Linux x64 AppImage。Docker、TV APK和手机APK不再列入后续Release附件或发布门槛。
- 四平台共用公开版本、GitHub标签与一次Release；先在Draft汇总应用包、必要更新清单、精确源码、对应媒体源码与SHA256，完成必要验收后一次公开并更新Latest。
- 每次GitHub Release正文的附件推荐区必须放置以下内容，放在附件列表前的醒目位置：
  > **Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。
- 历史Docker、TV和手机发行包及记录保留，不补发、不改写；平台门槛见 `docs/RELEASING.md`。

## 后续发行依赖审计（2026-11-18记录）

- 7.6的`npm audit`报告17个受影响包节点（7 moderate、10 high），均在开发、测试或构建工具链；`npm audit --omit=dev`为0，不为这些告警单独热修7.6。
- 下次发行前重新运行`npm audit`；先运行不带`--force`的`npm audit fix`，再逐项评估剩余Vite、Electron Builder等升级并重新构建、验证四平台产物。
- 不直接运行`npm audit fix --force`：当前锁文件会被评估为将`electron-builder`从26.15.3降到24.13.3，并把Vite升到8、esbuild升到0.28，存在peer冲突和构建回归风险。
- 不为`src/localLibrary.js`的Node模块警告在根`package.json`添加`"type": "module"`；主进程、preload和native代码仍为CommonJS。若要消除测试警告，另行按`.mjs`路径改名并跑相关测试。

## 视频测试素材与声音

- 用户于 2026-10-29 明确要求：测试视频须在红果短剧中随机选择并真实下载；禁止使用彩条视频测试。
- 播放、画中画、连播和自动删除验收必须使用上述真实下载素材，不得用彩条或测试图替代。
- 测试全程静音，不得让测试视频发出声音；开始播放前先确认静音状态。
- 使用独立测试资料和下载目录。自动删除只针对本轮测试下载，不影响正式应用的视频、账号或记录。
- 在项目内记录测试素材来源、步骤、结果和限制；不得记录登录凭据或带签名的媒体地址。

## 来源边界

- 用户明确禁止接入黄果或其他色情内容来源；#106不采纳，不进入后续接入计划。


## 历史发行归档

- 4.5 至 8.2 历次发行目标、例外与回执已归档至 `docs/release-history.md`。
