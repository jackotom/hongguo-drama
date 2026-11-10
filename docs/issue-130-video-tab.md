# #130：旧播放模型空响应的 video_tab 恢复路径

## 原因与修复

2026-11-10 在同一网络复测：旧 `POST /novel/player/multi_video_model/v1/`
返回 HTTP 200、正文 0 字节。原代码仅更新匿名身份并在另一主机重试相同路径，仍无法取源。

现在保留正常旧接口的一次请求路径，仅在 `EMPTY_RESPONSE` 后将既有的第二次模型请求
改为签名 `GET /reading/bookapi/video_tab/multi_video_model/v1/`。请求仍共用原来的
12 秒模型预算、取消信号和最多一次匿名身份更新；明确的 HTTP／业务拒绝不触发恢复。

GET 使用与注册资料一致的 7.3.9.32 版本字段和完整查询参数（包括空的
`from_video_id`）。没有正文，不发送 gzip 或 POST 正文摘要头；复用现有签名函数的
无正文模式。新响应从 `data.video_model_data[vid].video_model` 提取，兼容模型对象、
JSON 字符串和数组／对象形式的 `video_list`，始终只匹配请求的分集编号。
模型继续经过原有画质、地址、加密信息及备用片源身份／时长校验。

参数与响应结构参考 GPL-3.0-only 项目
[tsukiyo-zero/hongguoTV 的 tabVideoModel](https://github.com/tsukiyo-zero/hongguoTV/blob/49532eb2110dcbf66814ca250d43f222e7193895/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/ContentRepository.kt)。
本次沿用本项目已有签名算法，不增加账号登录或会话持久化。

## 离线验证

环境：macOS arm64，Node 22.23.1。

```sh
node --test src/native/app-source-video-tab.test.cjs src/native/app-source-inline-fallback.test.cjs src/native/github-127-diagnostics.test.cjs src/native/github-127-handoff.test.cjs src/native/github-127-transport.test.cjs src/native/hongguo-cancellation.test.cjs src/native/playback-device.test.cjs
node scripts/check-app-source.cjs
node scripts/check-app-source-recovery.cjs
node --check src/native/app-source.js
git diff --check
```

以上全部通过：取源相关单元测试 124/124，原取源脚本 13/13，恢复脚本通过。
新增 15 项用例覆盖旧接口空响应恢复、GET 参数与正文签名、嵌套精确分集匹配、
对象／字符串模型、失败有界、取消和地址／密钥校验；在未修改的旧实现上运行时
对象／字符串恢复用例均返回 `EMPTY_RESPONSE`，在修复后通过。

已运行完整 `npm test`。其 460 项单元测试中 459 项通过，ReelShort 的一项路由断言失败；
连同后续脚本，共 11 条命令失败。以下失败均在未修改的上游基线 `d0410c8`、同一环境
重新运行对应文件复现，未作为本 PR 的通过结果，也未扩大修复范围：

- `src/native/reelshort.test.cjs`
- `scripts/check-app-media.cjs`
- `scripts/check-app-update-proxy.cjs`
- `scripts/check-custom-media-integration.cjs`
- `scripts/check-download-quality-integration.cjs`（真实素材目录查询 `APP_TIMEOUT`）
- `scripts/check-media-recovery.cjs`
- `scripts/check-playback-resource-limits.cjs`
- `scripts/check-player-navigation-refresh.cjs`
- `scripts/check-player-resume.cjs`
- `scripts/check-source-recovery.cjs`
- `scripts/check-streaming.cjs`

## 真实取源、下载与静音播放

2026-11-10 20:55–21:01（Asia/Shanghai），同一网络，无需切换热点：

1. 运行 `node scripts/diagnose-playback.cjs`，从实时目录随机选中《妈咪受辱，大小姐回国掀翻全场》
   （剧号 `7699001781887437849`，57 集）。未修复时第 1 集 `sourceAvailable=false`，App 路径
   为 `EMPTY_RESPONSE`；修复后对同一剧号重跑，`sourceAvailable=true`。
2. 在该随机剧集中再随机选到第 56 集（分集号 `7699003626647194649`），通过项目
   `fetchPlayUrlSingle(..., { quality: '1080p', force: true })` 获取完整片源。
   记录到旧 POST 为 HTTP 200／0 字节，新 GET 为 HTTP 200／22,556 字节。
3. 整集真实下载到独立临时目录，通过项目 `decryptInWorker` 解密。输出 7,681,526 字节，
   ffprobe 确认 HEVC 1080×1920、AAC 音频、时长 143.986939 秒；FFmpeg 整集解码成功。
4. 使用本项目依赖的 Electron 44.9.1 创建独立资料目录，以静音 HTML video 播放该文件：
   `muted=true`、`paused=false`、`readyState=4`、播放时间推进至 1.17 秒，尺寸 1080×1920，
   无媒体错误。测试进程已退出；不读写正式应用资料。

这里验证的是修复后的原生取源／解密模块和 Electron 媒体播放，未执行打包后完整界面流程，
也未验证 Windows、Linux、Docker 或 Android 实机。上游可用性仍可能随时间和内容变化，
本次证据仅覆盖上述日期与素材。不保存登录凭据、内容密钥或带签名的媒体地址到仓库。

## 同类路径检查

桌面与 Docker 的此签名取源路径共用 `src/native/app-source.js`，均得到本次修复。
`src/native/hongguo.js` 另有独立的旧 `multi_video_model/preload/v1` 兼容路径；它在签名取源
失败后才调用，本次保留其行为。其余同名匹配为离线测试，不增加新的网络重试。
