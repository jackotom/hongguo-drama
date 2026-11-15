# 7.4 正式发行回执

7.4已于2026-11-15 20:27:56（Asia/Shanghai）正式公开并设Latest，内部版本7.4.0、桌面构建7.4.1，标签`v7.4`，冻结源码`f1f6939a7d245fd7b0075eac831ecf5084ad9647`，Release ID `446019267`。标准范围是macOS arm64、macOS x64、Windows x64、Linux x64 AppImage、Docker amd64；TV和手机独立，不随本轮发行。

## 本轮变化

- #157：下载临时文件在活跃句柄期间按实时文件身份校验；兼容 NTFS/exFAT 空文件首次写入后的文件编号或创建时间变化。替换文件、符号链接和重启后无法证明的负身份仍被拒绝。
- #158：匿名设备注册超时、播放接口空响应和明确拒绝只让失败集进入15、30、60、120、300、600秒的有界重试；其他等待集保持排队。共享冷却防止继续冲击上游，真实取源恢复后才解除；本地已有文件和缓存成功不清除退避。
- 下载管理新增按剧集查看；列表、统计、分页和批量重试可限定单剧，“全部开始／暂停”保持全局语义。
- Windows高性能转换依次探测NVIDIA NVENC、AMD AMF（VCE／VCN）与CPU。AMF固定官方v1.5.3头文件、许可、缓存键及对应源码；Linux不启用AMF。

## 已验证

- 下载临时文件与ByteVC2定向测试65/65，硬件编码和源节奏测试30/30；下载源拒绝、队列与下载管理定向检查31/31；下载工作区集成2/2。
- `npm test`：554项单元测试和117项平台检查全部通过；Windows AMF构建契约30/30，版本命名与发布配置回归通过。
- 最终源码真实红果目录、分集、取源与下载通过：#157任务成功且临时目录清零；#158注入一次注册超时后其余任务保持排队，15秒冷却后三集真实下载完成。
- 双Mac App与DMG均完成Developer ID签名、Apple公证Accepted和装订；最终arm64 App两集1080P静音播放10.02／10.06秒，临时目录0，按剧筛选显示两部真实剧；x64仅Rosetta启动。
- Windows最终便携App完成真实两集队列、暂停恢复、逆序重试、完成回绑及静音播放；新装、重装和1.80升级通过。两份媒体二进制均包含`h264_amf`，对应源码含固定AMF头文件、脚本与许可；EXE未签名。
- Linux最终AppImage在原生Ubuntu真实下载并静音播放两集1080P各约10秒，CPU软件解码。
- Docker amd64完成认证、真实搜索、两集1080P下载、合并、文件读取和容器重启持久化。

## 发布门槛

- 提交并推送冻结源码，由同一提交构建Windows、Linux、Docker；Mac本机构建并本轮新签名、公证、装订。
- 汇总25份标准附件：双Mac DMG／更新ZIP／`latest-mac.yml`、Windows安装／便携／源码与媒体源码／`latest.yml`、Linux AppImage与媒体源码、Docker镜像／部署包／源码、精确应用源码及`SHA256SUMS.txt`。
- Draft先核对版本、文件名、大小、SHA256和更新清单SHA512；五类齐备后一次公开`v7.4`并设Latest。缺任一类则保留Draft。

## 边界

- Windows EXE未签名；实体AMD AMF和实体NVIDIA外推范围以后续平台验收为准。
- 上游注册限制的触发条件仍未完全确认；本版改善逐集退避和恢复，不保证绕过长期额度或网络限制。
- Intel Mac仅以Rosetta启动记录，不等同实体Intel播放；Docker为linux/amd64，不等同ARM64或fnOS硬件验收。
- TV和手机不包含在本轮Release；不替换本机正式安装，不回复或关闭Issue／PR。

## 正式发行回执

- 五类共25份附件已公开，远端状态25/25为`uploaded`，大小和SHA256逐项匹配本地`asset-manifest.json`；`SHA256SUMS.txt`、`latest-mac.yml`、`latest.yml`公开可读且摘要一致，10个程序／源码匿名下载入口均返回可读数据。
- 源码CI [43708377299](https://github.com/jackotom/hongguo-drama/actions/runs/43708377299)、Windows [43708398208](https://github.com/jackotom/hongguo-drama/actions/runs/43708398208)、Linux [43708398024](https://github.com/jackotom/hongguo-drama/actions/runs/43708398024)、Docker [43708398113](https://github.com/jackotom/hongguo-drama/actions/runs/43708398113)均成功并绑定冻结提交。
- 双Mac App及DMG本轮四份Apple公证Accepted，回执ID为`ce0d599f-1296-41ad-899f-1f76aa1afded`、`935853d8-946a-4b65-934b-989d18fd27b8`、`8767a9f1-ab22-48b4-b755-d0ccafc3e3c9`、`44cbd021-2f02-40df-b605-775392f3dac5`。最终App严格签名、票据及包内90份源码、61份前端文件核对通过。
- 未替换本机正式安装，未回复或关闭Issue／PR；TV和手机独立。后置文档提交不移动`v7.4`标签，不改变已发布安装包或附件字节。
