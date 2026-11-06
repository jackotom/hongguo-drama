# 红果短剧 6.1

6.1 已于 2026-11-06 13:26（Asia/Shanghai）正式发布，内部 `6.1.0`，标签 `v6.1` 并设为 Latest。冻结源码 `a93793dea2f13864e8a56771bb6bea05ea6ddbb6`；后续文档提交不改变冻结标签和安装包。23份附件远端大小与SHA256逐项一致。

## 功能

- #108：播放器加入「从本集下载至末集」，包含当前集，跳过有效已完成文件、已排队和锁定集，保留权限、画质、持久化与上游拒绝保护。
- #90：加入内置「软件解码（CPU）」，使用本地WebAssembly播放H.264/H.265，保留进度、暂停、音量、倍速与控制条。ByteVC2仍走兼容转换。失败保留断点、隔离迟到回调，切换解码方式保留状态。
- #109：新增Linux x64 AppImage与对应媒体工具。手动更新；默认不关闭Chromium沙箱。当前没有Linux ARM包。
- #110：容器滚动或窗口调整时关闭原生搜索联想弹层，保留输入与原生键盘操作，卸载清理监听。
- libmedia 1.3.1和24个本地Wasm资源固定提交与SHA256。运行时不依赖外部解码CDN；仍禁止JavaScript inline/eval，保留渲染沙箱与媒体地址校验。

## 本轮构建与验证

- 冻结提交源码CI `42164191234`：329单元、110项平台检查通过。#110定向回归先失败后修复；旧搜索详情夹具补齐EventTarget后通过。
- 双Mac成品核对68后端源码、42运行依赖、61前端资源。Developer ID签名、App和DMG四份公证Accepted、装订、DMG只读挂载与最终更新ZIP恢复核对通过。
- Windows CI `42164192351`：便携11项、安装/重装及真实1.80升级资料保留9项通过。安装和便携包分别核对68后端/42依赖/61前端；只有源码、HTML及LGPL许可文本的CRLF差异。Windows源码ZIP原始摘要和423文件已核，再按冻结Git内容统一换行归档，EXE未改。EXE未签名。
- Linux CI `42164191198`：原生Ubuntu22.04从源码构建AppImage，提取后运行三个随包媒体工具，Xvfb启动界面并读取6.1版本、本地播放器及有效HEVC Wasm。这不等于实际视频播放或FUSE/GPU验收。
- 隐私检查423个受跟踪文件无匹配；普通公告保持关闭。GitHub根目录23项最新提交说明均含6.1，远端DOM与截图核对另记回执。

| 公证对象 | Submission ID | 状态 |
|---|---|---|
| Hongguo-6.1-mac-arm64.dmg | `4516de6d-2ba1-4258-8cef-c700b9931c86` | Accepted |
| Hongguo-6.1-mac-x64.dmg | `040cf0dc-9d17-4323-9802-01d17a70c790` | Accepted |
| Hongguo-6.1-notary-arm64.zip | `cc99b6cf-f18d-4f2b-aba2-630954edb1f1` | Accepted |
| Hongguo-6.1-notary-x64.zip | `9b42ffcf-b315-4e67-b726-d3e1dc9a024e` | Accepted |

## 本轮真实素材

- Mac最终签名包：红果实时真人剧目录随机选择《十八岁太奶奶驾到，重整家族荣耀第五部》，seriesId `7701935931787316286`；真实下载第1集vid `7701937936731737112`、约174.196秒，第2集vid `7701937814501346328`、约103.445秒，均1080×1920 HEVC/AAC。
- CPU软解第1集10.44秒、264帧，第2集10.04秒、254帧后暂停。进程带 `--mute-audio`，播放前muted=true、volume=0，全程静音，播放时长与素材相符；未人工听音。x64最终包经Rosetta隔离静音启动，报告6.1.0后退出，不是实体Intel验收。
- Windows随机真实下载《一江春水》，seriesId `7702724487975799832`，第1/2集vid `7702726326347631640`、`7702726300477180952`；FFmpeg生成15秒H.264/AAC片段，实际便携播放器静音播放、暂停、全屏、快捷键切集及自然连播通过。未用彩条或测试图。
- Mac首次尝试遇预览片源，随后CDN因本机VPN的198.18.* FakeIP被公网校验拒绝。最终仅在独立测试下载进程为选定CDN使用可信HTTPS DNS，保留原公网socket校验与TLS，未改应用或系统网络。
- 开发阶段另验过在线播放CPU软解、拖动、倍速、连播和第70集至末集下载去重，详见本文件Git历史。原开发目录曾被外部移除；本次发行素材和成品回执均重新准备，不冒称旧附件仍可读取。

## 正式附件与回执

[6.1发行页](https://github.com/jackotom/hongguo-drama/releases/tag/v6.1)共23项：双Mac DMG/最终App更新ZIP、Windows安装/便携EXE和便携ZIP、Linux AppImage、Mac/Windows更新清单、Windows blockmap、精确应用与Windows源码ZIP、八份媒体工具对应源码、libmedia固定版本及精确cheap/common子模块源码、SHA256SUMS。远端大小和GitHub服务端SHA256逐项核对；更新清单的文件名/大小/SHA512对应最终成品。匿名下载核对另记回执。

本地证据 `.planning/release-6.1/`：`asset-manifest.json`、`publish-verification.json`、`anonymous-download-verification.json`、三端CI回执、`mac-mount-verification.json`、`windows-packaged-source-verification.json`、`windows-source-normalization.json`、`test-media.json`、`mac-real-result.json`、`x64-startup.json`及根目录浏览器核对。测试资料、视频、账号、凭据和签名媒体地址不上传。

## 保留边界

未替换本机正式安装。实体老Windows CPU软解性能、Linux实际视频播放/GPU/FUSE/沙箱组合、实体Intel、干净Gatekeeper、长期弱网、原生搜索联想弹层视觉及完整6.0到6.1应用内自动更新未验。Linux首次提供包，当前证据限构建和启动；不承诺解除上游百集限制或确定恢复窗口。
