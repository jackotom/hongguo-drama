# 7.5.2 Mac zstd delta 运输

仅在codex/transport-7.5分支，绑定Draft446852363、应用冻结4ffff289d6dd289e589a0fd0e65aa7aa5c2a7567、内部7.5.0/构建7.5.2。不调用Apple、不公开、不改tag或Latest，不处理Windows、Linux、Docker、TV或手机附件。

当前仅有release-7.5-mac-transport.example.json等待模板，status=pending-final-plan，授权标志false且ID/size/hash为空，不能执行。尚无真实最终Mac plan，也未dispatch Mac任务。主控须在App/DMG公证及最终装订/更新ZIP完成后，提供对应的最终发行字节；不能拿送审ZIP的SHA替代后续装订/重打包后的SHA。

## 主控提供的正式plan

复制模板为.github/release-7.5-mac-transport.json，填status=ready、transportAuthorized=true、finalFilesApproved=true。assets必须恰好五个固定名称：Hongguo-7.5-mac-arm64.dmg、Hongguo-7.5-mac-x64.dmg、hongguo-downloader-7.5-mac-arm64.zip、hongguo-downloader-7.5-mac-x64.zip、latest-mac.yml。

每个条目填新文件size/SHA256；base填同名旧Draft字典（latest-mac.yml则为旧清单）的asset ID、name、size、SHA256。四个大文件另填delta：临时zstd差分asset的ID/name/size/SHA256。latest-mac.yml另填input：临时新清单asset的同样四项。临时输入名必须以_hg75-4ffff28-开头，只允许ASCII字母数字、点、下划线和连字符。当前最小模式使用单个delta asset，不自动切分或重组分段。

这些旧字典、delta及临时清单必须属于指定Draft，状态uploaded。脚本先按ID/name/size/hash核对附件列表和单件元数据，再下载核对实际字节。不得提前覆盖或删除旧Mac字典；临时输入也不由本脚本清理。

## 执行保护

恢复使用zstd -d -M512MB --patch-from=old delta -o new。四份恢复文件的完整size/SHA256及新清单输入均通过后，核对latest-mac.yml的7.5.0版本、恰好两个允许的ZIP、各ZIP实际size/SHA512及顶层path/sha512。全部完成之前不进行任何Release写入。

只允许替换plan中base精确ID/size/hash仍一致的旧同名附件。已与新SHA匹配的最终附件直接下载核对并跳过上传，便于部分成功后恢复。四个大文件串行上传并逐个API回读；最新清单最后上传。任何失败先对账后停止，不循环clobber。失败时workflow尝试把transport-mac/恢复材料存入短期Actions artifact，以免失败替换后失去字典；超时/取消不保证该恢复artifact一定形成，主控仍应保留本机旧字典和新完整产物。

沿用已注册的release-7.2-upload.yml文件，仅运输分支增加显式mode。将正式plan提交到运输分支并核对其SHA256后，才能选择mode=mac-delta并填mac_plan_sha256调度。Windows选择mode=windows，仍使用原精确Windows计划，不参与Mac替换。concurrency按模式隔离；同一模式串行，不取消运行中任务。

本地可运行release-7.5-mac-cloud.py --self-check，仅用临时普通字节验证计划拒绝边界、zstd恢复、错误SHA拒绝和双ZIP更新清单，不访问网络、不使用真实剧集、不运行应用测试。运行证据放忽略的.planning/transport-7.5/；工作流回执为transport-mac-result.json。
