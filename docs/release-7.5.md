# 7.5 发行准备：构建7.5.2待冻结、待验

2026-11-16最新授权：本轮只发行macOS arm64、macOS x64、Windows x64，共20件产物。不包含Linux、Docker、TV或手机。公开版本7.5，内部版本保持7.5.0，桌面构建改为7.5.2。本文最新范围优先于旧候选和AGENTS/RELEASING中的五平台历史描述；本次未修改后两份文件。

**新v5签名、生产请求与合成回归已迁入。51项签名／请求及31项取消／预算定向检查通过；独立下载主流程真实完成4集1080P，含反馈中的第146集，临时目录清零、成品身份和FFprobe校验通过。7.5.2尚待冻结、构建、签名、公证及最终App验收；源码验证和下载结果不作为最终包验播。旧验收不得计入新候选。** 未替换正式安装，未提交、push、修改远端附件或新增Issue/PR评论。

## 当前绑定与目录

- package.json的version为7.5.0，build.buildVersion为7.5.2。electron-builder使用后者写Mac CFBundleVersion及Windows文件版本；应用版本/更新清单仍是7.5.0。Windows ProductVersion另走应用版本与数字buildNumber，不能据此断言全部Windows版本字段均为7.5.2。package-lock.json仍为7.5.0，无需改动。
- 新freeze.json的sourceCommit及各runId均为null，acceptance-gate.json保持publishAllowed=false，全部新候选验收为待处理。主控必须先迁入源码并完成自己的授权范围内修改，再填真实冻结SHA。
- 新输入/输出统一使用忽略目录.planning/release-7.5/candidate-7.5.2/。旧大产物和原始回执保持原位，小型控制文件/脚本/旧交接备份至legacy-7.5.1/；不得将根目录旧assets、notary、build-output-freeze或成功回执当作7.5.2输入。
- 现有Draft ID 446852363及其25件旧附件未改变；本地旧v7.5标签仍指向c5cc9bcc。新冻结之前未移动标签或更新远端状态。新的20件产物尚未生成。

## 主控后续填写与执行

1. 迁入v5签名/请求/测试源码，保留文件安全、取消、明确拒绝和重试保护。scripts/check-release-version.cjs仍硬编码7.5.1，是必须由主控同步的已知旧断言，本次按边界未改、未运行。
2. 冻结包含7.5.0/7.5.2的源码；填freeze.json.sourceCommit、门禁sourceCommit、新源码CI和Windows构建/验收runId。旧标签不参与新源码归档，assemble按新冻结SHA归档；后续正式标签由主控核对，不为绕过校验自动移动。
3. 新Mac输出放candidate-7.5.2/build-output-freeze/mac-arm64及mac。独立本机依赖，不复用旧漏包符号链接候选。脚本会核对新冻结、App版本及CFBundleVersion后才继续。重新签名/公证/装订、生成DMG及从最终App重做更新ZIP；新回执只写candidate目录。
4. Windows新构建artifact解包/规范化后放candidate-7.5.2/windows/，包括SOURCE-SHA.txt；填写新artifactId、archiveSha256和精确缓存绑定。不允许套用7.5.1工作流中旧SHA、artifact或缓存。build_only/skip_playback不能替代最终真实队列和播放验收。新Windows文件版本及安装/重装/升级需重新记录，EXE当前无签名证书。
5. 填candidate-7.5.2/real-acceptance.json的同一新冻结SHA和本轮随机真实样本tests；它只是选片输入。最终App完成真实下载、完成回绑、两集各约10秒静音播放，Windows另验队列暂停恢复及逆序重试。Mac x64的Rosetta启动与实体Intel播放分开记，不外推长期稳定性。
6. 新Mac/Windows产物及7份准确媒体对应源码齐备后汇总20件，重新核对源码、两份更新清单和总SHA256。核对旧Draft中的范围外附件及替换方案，再由主控按授权执行远端变更；本次没有上传/删除/公开。

新冻结缺失时适配后的本地脚本拒绝继续。脚本此次仅做文本适配，未执行或测试。完整输入路径和待填字段见candidate-7.5.2/README.md。

---

## 历史候选7.5.1：以下成功与失败仅属于旧包


2026-11-16：内部7.5.0、桌面构建7.5.1；冻结应用源码`c5cc9bcc33d5bca18f096056f4c9a51f51e5a2b5`。双Mac、Windows x64、Linux x64 AppImage、Docker amd64五类共25附件已汇总到Release ID `446852363`，名称、大小、uploaded状态及SHA256逐项回读一致，两份更新清单SHA512及精确源码已核对。

**仍为Draft，未公开、未设Latest。Windows及Linux最终包真实下载／播放验收未通过，不能统一正式发行。** 当前Latest仍是7.4。未替换本机正式安装，未回复或关闭Issue／PR，TV和手机独立。

### 修复

- 下载成功后，临时文件删除EPERM不再覆盖完成状态；按所有权凭据清理，释放句柄后重试，持续占用保留凭据和告警。
- 最终视频使用`COPYFILE_EXCL`独占复制，避免延后删除硬链接改变最终文件ctime、使完成身份失效；同名文件不覆盖。复制增加临时空间需求，慢盘仍沿用同步文件操作。
- 当前GET和旧POST仅因空响应失败时，原12秒模型预算内增加一次重新签名的当前GET，最多三次。取消、明确拒绝、地址安全校验及原逐集退避保留，不以预览替代整集。
- 截图同剧第1、9集现场复现空响应，之后恢复取源；不宣称上游空响应、404或额度问题根治。

### 验证状态

| 项目 | 本轮证据与结果 |
|---|---|
| 冻结源码 | CI `43840908597`：557项单元、117项平台、25项服务端、98项Android源码检查通过 |
| EPERM | 四条下载路径的句柄占用／持续EPERM、清理后完成身份、复制与清理同时失败保留原错误均通过；随机两部真实1080P整集注入持续EPERM后仍完成，解除占用后清零，文件身份有效 |
| 双Mac | App及DMG四份本轮Apple公证Accepted、签名与装订通过；更新ZIP恢复及SHA512通过；双DMG只读挂载各301项载荷与最终App一致 |
| Mac arm64 | 最终App真实下载《十八岁太奶奶驾到，重整家族荣耀第五部》第1、2集1080P，临时目录清零，分别静音播放10.058／10.060秒 |
| Mac x64 | Rosetta启动通过，非实体Intel播放 |
| Windows安装 | `43846011437`：便携载荷／资料位置、新装、同版重装、真实1.80升级及资料保留通过。该次跳过真实下载／播放，不能充当实播证据 |
| Windows实播 | 原运行`43841079435`多轮未取得两集可播放片源；独立成品验收`43850750510`等待自动重试后仍超时，**未通过** |
| Linux | AppImage启动、三份媒体工具、CPU播放器与HEVC Wasm加载通过；`43841076558`及独立成品验收`43850750510`真实下载／播放**未通过** |
| Docker | `43841076645`：认证、真实搜索、两集下载与合并、文件读取、重启持久化通过；amd64与revision绑定冻结源码 |
| 附件 | 25份Draft附件远端名称／大小／SHA256及清单回读一致；未公开匿名入口验收 |

Apple回执：arm64 App `9d0f5bef-32c6-49a8-a928-9c47f3d40724`、x64 App `1b2da9dc-bd9f-4f5f-b39f-cd5cffb3452a`、arm64 DMG `b4d7e54b-c74e-4a70-9bcb-6384d2771d36`、x64 DMG `8d5b8826-939d-430a-9658-6e432eb8c906`。

### 失败与边界

- 云端原抽样明确记录网页404／预览、App及旧接口空响应。后置工作流`4a57a46e9806b0b062247f74605a0b9546941231`只新增测试，冻结应用包／标签不变；校验不可变artifact和成品摘要，使用本轮Mac随机样本同剧1、2集，各平台重新真实解析、下载并等待有retryAt的正常自动重试。
- 独立验收仍失败：Windows为`Single real App episode exceeded 180 seconds including automatic retries`，Linux为`Real complete download timed out`。不以Mac、Docker、安装检查或故障注入替代这两项。
- 后置测试提交的源码CI `43850750310`也因真实片源查询失败而未全绿：下载集成64/65，失败项为真实解码恢复用例，报`Real Hongguo media lookup failed`。它不改变此前冻结提交CI通过的记录，也不能被省略为当前全部通过。
- 本机Node26初跑曾有旧两次请求断言、延后清理ctime失效及模拟崩溃夹具遗留FileHandle失败。前两项已修复；夹具在Node24复测通过但仍有回收警告。最终冻结源码Node22 CI已全绿，不宣称本机Node26全量全绿。
- 用户同意Windows使用GitHub虚拟机，**非实体Windows电脑；EXE未签名**。实体AMD／NVIDIA及实体Intel未验；Docker为linux/amd64，不外推ARM64或fnOS实体硬件。

### 后续发行条件

在可正常取得真实片源的Windows／Linux环境补齐上述冻结成品的真实App下载、完成回绑和两集静音播放；保留失败记录，回读通过证据后才可统一公开7.5、更新Latest并核对匿名下载入口。可复用已核对的不可变产物，不必先重建；不得将失败改写为通过。

完整回执及门禁保存在项目忽略目录的release-7.5工作记录。测试媒体、账号资料、签名媒体地址与本机私密路径不进入公开源码。后置文档不改变冻结标签、源码ZIP或已核对附件字节。
