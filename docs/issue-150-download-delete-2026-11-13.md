# #150 下载与仅删除记录（2026-11-13）

## 已确认原因与改动

1. **仅删除记录被文件清理条件阻拦。** `deleteTaskRecords` 与 `dropTaskRecords` 均检查 `hasPendingTemporaries`；后者也检查同目录所有未登记的 `.hongguo-download-*` 目录，目录无法列出时同样返回待处理。因此本集文件已丢失、路径冲突，乃至残留文件属于别的任务时，仍可能无法仅移除记录。现在仅对用户明确选择的“仅删除记录”绕过临时文件条件；先停止并等待本任务结束，再持久化移除记录。不额外清理已有文件，已完成视频和未知文件保留。活动任务先正常停止，运行器仍按原有归属校验清理其自身临时产物；不承诺保留这些在途半成品。持久化失败恢复原记录。
2. **缺失／无法启动 ByteVC2 组件被当作可换源失败。** 原异常没有 `LOCAL_MEDIA_TOOL_ERROR`，允许降档下载时 `withMediaRecovery` 会再尝试候选和新一轮取源。本地故障无法靠重复下载修复。现在缺组件与进程启动错误均分类为本地工具错误；下载、在线完整媒体准备共用组件预检，在已知 ByteVC2 片源传输前确认组件。缺组件不传输；已发现组件但实际无法启动时本次只传输一次，不再通过降档或自动取源重复下载。用户手动重试仍重新检测组件。

删除文件、单集／整剧清理及自动清理仍使用原有挂载、归属、活动任务保护。未知文件保持原样；不根据文件名猜测归属。用户选择仅移除记录后，其记录内的临时文件收据也随记录移除，残留目录以后视为未登记项目，不能再自动确认归属和计入可释放空间；需要用户自行处理。该动作不会报已释放空间。

## 先红后绿证据

使用隔离临时目录和真实 `main.js` IPC；下载流与媒体探测由现有夹具隔离，无网络、无正式账号和正式下载目录。**启动失败用真实不存在的可执行路径触发操作系统 spawn 错误**，不是抛出替代字符串。所有夹具在退出时清理。

修改前：

- 仅移除记录：未知相邻目录、损坏临时收据两项均失败，返回“临时文件归属无法确认”。
- 缺 ByteVC2 组件：预期零媒体传输，实际六次。
- ByteVC2 启动失败：预期一次媒体传输，实际六次。

修改后两组定向检查通过：

```sh
NODE_PATH=<既有依赖目录>/node_modules node scripts/check-download-safety.cjs 'issue150|astra persisted temporary|astra location snapshot|NAS deletion|ordinary download records'
NODE_PATH=<既有依赖目录>/node_modules node scripts/check-download-quality-integration.cjs 'issue150|removable disk|large file ID|disk cache download|disk errors|missing probe tool|publication preserves|unsupported hard links'
```

- 安全组 **21 项通过**：单条／批量移除、文件完整保留、保存失败回滚、目录不可读、崩溃收据恢复、未知文件替换、目录／NAS 挂载变化和并发位置变化保护。
- 下载集成 **16/16 通过**：缺组件零传输，真实 spawn 启动失败一次传输、无自动定时重试、手动重试恢复；在线入口同样传输前预检。已有外置盘、64 位文件身份、磁盘缓存与排他发布定向回归保持通过。

## Windows 反馈的未证实边界

用户反馈 Windows 10 IoT 企业 LTSC 21H2、7.1 便携包哈希正确、本地盘、`librempeg.exe` 存在，同一集重启后恢复。**本次没有证据确定该机器为何偶发未找到组件；不能宣称已根治该环境问题，也不把 #153 exFAT 身份修复套用为其原因。**

`resolveFfmpeg` 每次实时扫描，没有“找不到后永久缓存”的逻辑，本次不改搜索路径。Windows 平台与正式包状态的隔离模拟验证：`resources/bin/librempeg.exe` 从缺失到出现再移除均实时反映；正式包不从开发者 PATH 执行同名文件。该检查在 macOS 上模拟路径发现，不等于 Windows 原机验收，不代表 Windows EXE 已实跑。

未进行新包安装／播放／五平台发行验收；由 7.2 主流程单独执行。未提交、推送、升版、替换正式安装或回复 Issue。
