# 7.3 正式发行回执

7.3已于2026-11-15 12:16:01（Asia/Shanghai）正式公开并设Latest，内部版本7.3.0、桌面构建7.3.1，标签`v7.3`，冻结源码`782fb21cbddf1be46f88e97af5e788c99e30beae`，Release ID `445601123`。标准范围是macOS arm64、macOS x64、Windows x64、Linux x64 AppImage、Docker amd64；TV和手机独立，不随本轮发行。

## 本轮变化

- #156采用解决方案1：设置项定名「S / D 倍速调节」，位于老板键右侧、全屏快捷键下方；可选0.25、0.5、0.75或1倍，默认0.25。标签随当前减速／加速绑定动态显示。实际应用静音验证：按D从1倍到2倍，按S回到1倍。
- 下载完成记录绑定设备号、文件号、大小与纳秒时间；删除、播放和复用前复查身份。同名替换文件、消失文件、零字节文件和截断视频不会被误认、误删或发布为完成。
- 同剧未登记但符合精确命名模板的文件才允许识别；裸数字文件名不再单独作为剧集归属证据。
- Hongguo、西饭、河马、DramaBox与其他外部媒体统一执行公网 DNS、地址与重定向检查；回环、局域网、非预期协议和跳转被拒绝。
- NAS根目录及目标目录保存身份并复查；挂载变化、目录替换和路径冲突停止写入，不删除无法确认的文件。
- Android设置保存改为事务式；保存失败回滚运行时设置。“全部暂停”后立即恢复会等待取消完成并重新排队，不再永久停住。
- Docker遇到挂载变化返回安全409并中断剩余队列；CDN 403/429、非2xx媒体流停止后续请求；完成记录复查文件身份，被替换或消失时隔离无效临时产物并转为可重试。启动清理只处理符合精确格式的自有临时目录。

## 已验证

- `node scripts/check-download-safety.cjs`
- `node scripts/check-streaming.cjs`
- `node scripts/check-web-media-guard.cjs`：18/18
- `node scripts/check-series-cache.cjs`
- `node --test src/native/nas-export.test.cjs`：8/8
- `node --test src/native/download-temporary.test.cjs`
- `node --test server/server.test.cjs server/media.test.cjs`：25/25
- `node --test src/components/__tests__/player-behavior.test.mjs android/tests/mobile.test.cjs server/server.test.cjs server/media.test.cjs`：40/40
- `npm --prefix android test`：98/98
- `node scripts/check-download-quality-integration.cjs`：56/56；真实上游媒体经 Fake-IP 公共 DNS 回退完成下载、解码和损坏恢复校验。
- `npm test`：单元测试和116项平台检查全部通过。
- `npm run build:react`：通过，软件播放器 Wasm 资源24项校验通过。

## 发布门槛

- 提交冻结源码，推送`main`，由同一提交构建Windows、Linux、Docker；Mac本机构建并本轮新签名、公证、装订。不得沿用7.2包、签名或公证回执。
- 汇总25份标准附件：双Mac DMG／更新ZIP／`latest-mac.yml`、Windows安装／便携／源码与媒体源码／`latest.yml`、Linux AppImage与媒体源码、Docker镜像／部署包／源码、精确应用源码及`SHA256SUMS.txt`。
- Draft先核对版本、文件名、大小、SHA256和更新清单SHA512；五类齐备后一次公开`v7.3`并设Latest。缺任一类则保留Draft并记录缺口。

## 边界

- Windows EXE未签名；实体Intel Mac和实体NVIDIA未验时如实记录。
- Docker为linux/amd64，不冒称ARM64或fnOS硬件验收。
- TV和手机不包含在本轮Release；本次Android回归不等同手机正式包或TV实机验收。
- 不替换本机正式安装，不回复或关闭Issue／PR。实际冻结提交、平台证据、Release ID和附件摘要在本文件后置回执中补齐。

## 正式发行回执

- 五类共25份附件已公开，远端状态25/25为`uploaded`，大小和SHA256逐项匹配本地`asset-manifest.json`；`SHA256SUMS.txt`、`latest-mac.yml`、`latest.yml`公开可读，10个程序／源码匿名下载入口均返回可读数据。
- 源码CI [43641704078](https://github.com/jackotom/hongguo-drama/actions/runs/43641704078)、Windows [43641733984](https://github.com/jackotom/hongguo-drama/actions/runs/43641733984)、Linux [43641732820](https://github.com/jackotom/hongguo-drama/actions/runs/43641732820)、Docker [43641733956](https://github.com/jackotom/hongguo-drama/actions/runs/43641733956)均成功并绑定冻结提交。
- 双Mac App及DMG本轮四份Apple公证Accepted，回执ID为`c5e30e89-f847-4cd8-8af3-8ec5ad413ecb`、`4c45cd3f-c019-4d04-bb96-1c3c25d837aa`、`dc028133-e028-47d6-8765-f1db169b7ba2`、`373eafa2-0402-4039-9fc3-ba17dbc32a68`。最终App／DMG严格签名、票据、包内90份源码、61份前端文件和更新ZIP恢复核对通过。
- arm64最终App实测「S / D 倍速调节」名称、位置、四档选项与持久化，真实两集1080P静音播放10.04／10.08秒，D/S实测1→2→1倍；x64仅Rosetta启动，不是实体Intel验收。
- Windows最终便携包真实两集App队列暂停恢复与逆序重试、完成分集回绑、两段640×1138兼容样本各约10秒静音播放、新装、重装和真实1.80升级通过；EXE未签名。
- Linux原生AppImage真实两集1080P静音软件解码播放10.176／10.106秒；Docker amd64认证、真实下载合并和重启持久化通过。
- 本机未替换正式安装；TV／手机不随本轮发行。后置文档提交不移动`v7.3`标签，不改变已发布安装包或附件字节。
