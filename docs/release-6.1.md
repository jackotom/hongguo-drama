# 6.1 后续下载、Linux AppImage 与内置软解

状态：本地开发候选，内部版本 `6.1.0`，基于正式 `v6.0`。尚未发布、签名、公证或替换本机正式安装。Linux x64 安装包已构建；原生 Linux GUI 验收尚待完成，不能视为 Linux 播放已验收。

## 功能与边界

- #108：在播放器下载工具中加入「从本集下载至末集」。包含当前集，跳过已完成且文件有效、已排队和锁定的分集；丢失文件可重新提交。复用原有来源权限、画质、持久化、重试和上游拒绝保护。不扩大并发或绕过上游限制。前后端均防重复提交，更新安装期间禁止新增下载。
- #109：新增 Linux x64 AppImage 配置、媒体源码构建和 Linux CI。随包提供 FFmpeg、FFprobe、ByteVC2 辅助工具、软件解码资源及许可证。保留手动更新方式。专用 AppRun 与 desktop 入口不自动添加 `--no-sandbox`；正常启动需要系统支持 Chromium 沙箱。当前未提供 Linux ARM 包。
- #90：在「我的剧库」的「解码方式」中选择「软件解码（CPU）」。本地 WebAssembly 解码 H.264/H.265，输出到真实 video 元素，复用进度、音量、倍速、键盘、全屏及画中画接口。无需先把整集 HEVC 转成 H.264；ByteVC2 仍沿用原有转换路径。选择持久保存，切换保留进度与暂停状态。
- 解码器的加载、暂停、拖动、继续操作按会话排序；失败或取消隔离迟到回调。启动等待有界，解码失败先保留当前秒数再释放资源，避免断点归零。更换视频节点后重新绑定控制条、弹幕、画质增强和保帧监听。
- 软件播放器固定为 libmedia 1.3.1，24 个本地 Wasm 资源按固定提交和 SHA256 校验；运行时不依赖外部解码 CDN。仅允许本地脚本、生成的 Blob 工作线程和 Wasm，仍禁止 JavaScript inline/eval；渲染沙箱、来源权限和媒体路径校验保留。

## 已验证

- 首次全套检查中 326 个单元测试通过；版本目标和 CSP 两项检查发现旧断言，更新后分别复测通过。之后软解代码有调整，最终 6 项适配器回归、下载范围 IPC/UI、版本、渲染安全、Linux 配置和前端构建分别通过；未重复整套检查。
- 只读独立复核抓到并复现了两项问题：超时后迟到加载可能播放、解码失败后秒数归零。修复后分别复验为不再迟到播放、`37.25 秒 → 错误 → 仍为 37.25 秒且暂停`。
- 2026-11-06 在红果真人剧实时目录随机选择《迟来的情缘，董事长的暖心妻》（series_id `7692824244719193150`），真实下载前两集；均为 1080×1920 HEVC/AAC，ffprobe 时长约 115.33 秒和 91.58 秒。
- 使用独立资料和下载目录，进程始终 `--mute-audio`；正式软解流程同时确认 video muted、volume=0。Mac 开发版实际检查了本地软解、拖动、暂停/继续、2 倍速、第一集结束自动到第二集、有效新帧后撤保帧层，以及暂停时切换系统/软件解码并保留秒数和静音。最终第二集已提交 29 帧、保帧层 hidden。后台遮挡会延后帧呈现回调，前置窗口后完成交接；不宣称所有环境秒切。
- 在线第 3 集通过 `hongguo-stream` 软解，实际提交 48 帧；运行实例确认 hardware=false、webCodecs=false、MSE=false。
- 真实界面选择第 70 集后点「从本集下载至末集」，只新增 70、71 两集并完整下载，原 1、2 集保留；重复点击提示已完成或在队列中，没有新增重复任务。
- Linux x64 三个媒体工具从固定源码编译并通过 ELF 架构、可执行和 ByteVC2 解码器检查。AppImage 成品已成功提取，核对了 AppRun、desktop 入口和三个随包工具。

## Linux 验收缺口

本机为 ARM Mac。Ubuntu x64 容器可编译、打包和执行媒体工具，但 binfmt 不识别 AppImage 的 AI2 ELF padding，直接执行报 `Exec format error`；显式 QEMU 可提取未改动的原包。提取后 Electron 在模拟环境启动时出现 `qemu: uncaught target signal 5 (Trace/breakpoint trap)`，未得到渲染页。禁用模拟环境 GPU/zygote及单进程诊断仍未通过。前端构建使用已验证的 Mac 产物；Linux x64 模拟环境的 esbuild 服务也异常退出。不能把这些模拟结果视为原生 Linux 通过。

已准备原生 Ubuntu 22.04 的 `.github/workflows/linux.yml`，可编译媒体工具、从源码构建 AppImage、Xvfb 启动成品并读取版本/本地解码模块。推送代码和触发远端 CI 属于外部写入，须取得用户明确授权。CI 通过后再更新本文件，不自动发布。

## 复验与记录

- 软解回归：`node --test src/components/__tests__/software-video.test.mjs`
- 后续下载：`node scripts/check-download-following.cjs`
- Linux 配置：`node scripts/check-linux-media.cjs --config`
- 原生 Linux 媒体工具：`scripts/build-ffmpeg-source-linux.sh`、`scripts/build-librempeg-source.sh` 的 `linux-x64` 目标；资源放入 `build/ffmpeg/linux-x64`，再执行 `npm run build:linux`。
- 原生成品启动：`xvfb-run -a node scripts/check-linux-appimage.cjs`。模拟诊断的 `--emulated-appimage` 仅用于测试，不写入正式启动参数。
- 本地详细证据：`verification/mac-flow-result.json`、`mac-online-result.json`、`material-selection.json`、`material-probe.json`、`following-real-result.json`、`ui-6.1.log`、`test-6.1.log`，以及 `verification/linux` 中的构建和失败回执。测试目录不随公开源码提交，不记录登录凭据或签名媒体地址。

实体老 Windows 的 CPU 软解性能、原生 Linux/GPU、Linux 沙箱/FUSE 组合、系统原生画中画实机、签名和跨版本安装更新，均未作为本轮通过项。上游百集限制没有宣称解决。

## GitHub 回复

用户于本轮明确授权回复当前 15 条未关闭 Issue。已逐条读取最新讨论、发送并读回确认；未关闭问题。#108/#109/#90 明确标注 6.1 正在开发验收、未发布；其他问题按实际修复及保留边界更新，没有冒称全部根治。
