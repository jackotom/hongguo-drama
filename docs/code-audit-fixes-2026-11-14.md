# 本机全库审查修复（2026-11-14）

结论：本次审查的 14 项问题已完成本地源码修复及主控复核。用户指定 DeepSeek 为修复子控，主控检查补丁、调用链、原始工具证据，并直接核验 Docker、设置同步及前端构建。未打包或发行，不代表全平台实机验收。

基准：`3b31058` 加本轮开始时已有的 13 个文件未提交修改及两份下载安全文档。保留既有改动；不升版、不提交、不打包发布、不替换正式安装，不操作正式账号、下载资料或外部服务。

修复采用 DeepSeek V4 Pro / high 原生子控，按不重叠文件范围拆为桌面安全、前端、Docker、手机四组。先补行为回归并确认失败，再作最小修复。安全与公共核心允许必要的定向验证，不运行无关全量检查；预计超过两分钟的检查先说明成本并等待用户确认。

| 编号 | 场景与完成标准 | 责任范围 | 状态 |
| --- | --- | --- | --- |
| 1 | 文字导出等待后目录或挂载变化，拒绝写入并保留外来文件 | main / text-export | 修复、回归及复核通过 |
| 2 | 画中画期间关闭自动删除，设置同步且后端不再删除 | Player / Settings / main | 修复、回归及复核通过 |
| 3 | 整剧删除等待期间开始同剧合并，保留输入分集 | main | 修复、回归及复核通过 |
| 4 | 同名视频被替换，旧播放令牌失效，新文件重新授权 | main / media-access | 修复、回归及复核通过 |
| 5 | NAS 挂载变化，不把同名外来文件认作已完成视频 | main | 修复、回归及复核通过 |
| 6 | 账号登录态拒绝 Linux basic_text，Android 无该接口保持兼容 | account-session | 修复、回归及复核通过 |
| 7 | 软件解码退出页面，保存剧集逻辑时钟而非原生流时钟 | Player / SoftwareVideo | 修复、回归及复核通过 |
| 8 | 软件解码暂停换画质，加载完成后仍能用鼠标继续播放 | Player / softwareVideo | 修复、回归及复核通过 |
| 9 | Docker 完成视频确实丢失后，同集同画质可重新下载 | server | 补丁复核通过；离线回归通过 |
| 10 | Docker HTTP 错误响应流关闭，原错误与取消语义保留 | server | 补丁复核通过；离线回归通过 |
| 11 | 链接解析期间离页，返回后可重新解析 | HongguoDownload | 修复、回归及复核通过 |
| 12 | 过期下载提交响应不关闭新详情、不抢导航 | Browse | 修复、回归及复核通过 |
| 13 | 手机初始保存失败，控制器释放，存储恢复后可重试 | android/mobile | 修复、回归及复核通过 |
| 14 | 手机“全部开始”恢复失败任务，同时保护活动任务 | android/mobile | 修复、回归及复核通过 |

## 验证与交付记录

四组原生子控线程的本机元数据均为 DeepSeek V4 Pro / high；对应网关请求回执均为 `upstreamModel=deepseek-v4-pro`、HTTP 200。没有以 GPT 子控冒充 DeepSeek。

Docker 两项补丁已由主控检查生产调用链及三份测试文件。主控直接运行 `rtk proxy node --test --test-reporter=dot server/server.test.cjs server/source-cancellation.test.cjs server/media.test.cjs`，20 项通过，工具退出码 0，用时约 0.43 秒。未启动 Docker 或访问外网。

首轮复核已打回：手机重试假成功、解析页相同值仍被旧请求阻塞、软件播放器重新挂载标记、缺失组件行为回归、文字导出任务/目标文件身份与随机临时文件、播放令牌缺失文件时放行、自动清理异步等待后的开关复查、旧 NAS 副本任务兼容性。后续只记录补齐后的最终证据。

## 最终验证

以下均为本轮最终相关代码的检查。子控测试由主控核对补丁及原始工具输出；相关文件未变化时不重复运行。

| 检查 | 结果 | 验证者 |
| --- | --- | --- |
| `node --test --test-reporter=dot src/components/__tests__/*.mjs src/components/touchHoldSpeed.test.mjs` | 125 项通过，直接命令退出 0 | 前端子控；主控复核证据 |
| `node --test --test-reporter=dot android/tests/mobile.test.cjs` | 11 项通过，退出 0 | 手机子控；主控复核证据 |
| `node --test --test-reporter=dot android/tests/media-phone-bundle.test.cjs` | 2 项通过，退出 0 | 手机子控；主控复核证据 |
| Docker 三份测试，命令见上 | 20 项通过，退出 0 | 主控直接核验 |
| `node --test --test-reporter=dot src/native/text-export.test.cjs` | 16 项通过，测试退出 0 | 桌面子控；主控复核证据 |
| `node --test --test-reporter=dot src/native/account-session.test.cjs` | 12 项通过，测试退出 0 | 桌面子控；主控复核证据 |
| `node --test --test-reporter=dot scripts/check-issue43-storage.cjs` | 7 项通过，测试退出 0 | 桌面子控；主控复核证据 |
| `node --test --test-reporter=dot scripts/check-nas-export.cjs` | 16 项通过，测试退出 0 | 桌面子控；主控复核证据 |
| `node scripts/check-media-access.cjs` | 通过，脚本退出 0 | 桌面子控；主控复核证据 |
| `node scripts/check-download-safety.cjs` | 通过，脚本退出 0 | 桌面子控；主控复核证据 |
| `node src/components/check-ui-state.cjs 'settings (reactivation\|retained drafts)'` | 2 个相关场景通过，退出 0 | 主控直接核验 |
| Vite 生产前端构建，输出到独立临时目录 | 116 模块，约 0.7 秒，退出 0；临时产物已清理 | 主控直接核验 |
| `git diff --check` | 退出 0 | 主控直接核验 |

新增回归先在旧实现或隔离副本观察失败，再在修复后通过。覆盖导出期间父目录变成符号链接、任务删除、未知目标新出现、随机临时文件、旧令牌失效、自动清理等待期间关闭开关、删除期间开始合并，以及 NAS 副本任务仍保留本地完成状态。手机回归确认一次 `retryTask` 即重新进入下载，不再以成功返回但未开跑冒充恢复。

Vite 保留现有的 CJS API 弃用及大 chunk 提示；本轮未为警告增加依赖或改动打包架构。

## 已知失败和实测边界

`node scripts/check-streaming.cjs` 仍退出 1，只有以下两条 `web:` 断言失败：

- `web: stream, prefetch, download and compatibility input retain browser identity`
- `web: real provider switches cached failed episode to App for five minutes, isolates episodes and expires`

桌面子控在 `3b31058` 的独立 detached worktree 中运行相同脚本，两条均以相同断言失败。该临时 worktree 已清理，原有 worktree 保留。不能据此宣称全量回归通过；本轮相关的本地 Range/读取取消、停止与立即重试场景通过。旧测试的固定等待改为有界等待真实状态，不放松生产校验。

没有进行真实下载播放、实体外置盘/NAS、Windows/Linux/TV/手机实机验收，没有构建安装包、签名公证、替换安装或发布。路径校验依然不能完全消除其他进程在最终文件操作前抢占路径的竞争窗口；保留未知文件优先。
