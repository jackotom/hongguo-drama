# Docker Web / API（6.6）

用于 fnOS / Linux x64 NAS：浏览器搜索红果短剧、选集批量下载到已挂载 NAS、合并同剧已下载分集。不是桌面 VNC。仅支持红果公开可用片源，不登录账号、不接入其他来源，不绕过锁定或上游拒绝。

## 部署

镜像仅支持 `linux/amd64`。从正式发行下载 `hongguo-drama-6.6-docker-amd64.tar.gz` 后导入（具体附件名以 Release 为准）：

```sh
docker load -i hongguo-drama-6.6-docker-amd64.tar.gz
```

使用仓库 `compose.yaml`。先选择已挂载的 NAS 目录和独立任务目录，确认运行用户对二者具有读写权限。默认 UID/GID 为 `1000:1000`，可通过 `PUID`、`PGID` 指定已有 NAS 用户。不要使用 root 规避权限问题。

在 compose 同目录新建 `.env`（仅本机保留、权限设为 `600`）：

```dotenv
# 用 openssl rand -hex 32 生成后填写，不使用示例令牌
HONGGUO_TOKEN=填写至少32字符的随机令牌
HONGGUO_DATA=/absolute/path/hongguo-data
HONGGUO_DOWNLOADS=/absolute/path/mounted-nas/hongguo
PUID=1000
PGID=1000
# 默认只监听本机。局域网直连时改成 NAS 的局域网 IP
BIND_ADDRESS=127.0.0.1
PORT=3000
```

```sh
docker compose up -d --no-build
docker compose logs --tail=30
```

浏览器打开 NAS 的对应地址，输入令牌后进入。令牌仅保存在当前页面内存，刷新需重新输入。Web 和 API 使用同一 Bearer 验证。不要把令牌放进 URL。HTTP 只适用于可信局域网；跨网络访问需自行设置 HTTPS 反向代理，代理保留原 Host，并限制访问范围。服务不自动配置公网映射。

挂载目录必须预先存在；NAS 共享中断或目录替换时停止操作，恢复原挂载后重启。建议以专用 NAS 账号运行，下载根目录不与不可信用户共享写权限。只运行一个服务实例使用同一任务目录；不支持多副本共同写任务库。

## 行为与限制

- 下载、合并共用单任务队列。固定 `720p` / `1080p` 严格校验实际尺寸；不满足即失败，不自动降档。自动画质复用原取源规则。
- 取源、签名、解密、ByteVC2 转换及合并计划复用桌面模块。Linux ByteVC2 使用独立 Librempeg 软件解码/编码组件，不宣称 Mac 硬件编码提速。
- 单集输入与 ByteVC2 转换输出上限 1 GiB。下载校验长度、视频轨、尺寸以及前 3 秒解码；有可信源时长时另校验完整时长。合并校验总时长和解码后才发布文件。
- 只允许剧集 ID、服务端目录中的分集 ID 和任务 ID；不接收任意媒体 URL、下载路径或自定义来源。媒体仅允许官方 HTTPS CDN，逐跳检查域名与公网 DNS；默认不使用环境代理，避免代理绕过媒体地址边界。
- 文件保存在 `/downloads/剧名_剧集ID/`，以集号与任务 UUID 命名。相同剧集、分集与画质的排队、运行和完成任务重复提交会复用记录。合并保留原分集；无删除 API。
- 重启后排队任务继续，原运行任务标记“中断”，需手动重试；取消先保存状态，再停止网络与子进程。明确上游拒绝会暂停后续下载，等待手动重试。
- 崩溃时可能保留 `.download-*` 或 `.merge-*` 临时目录。先停止服务、备份任务库，再由管理员核对清理这些临时目录；不要删除已完成 MP4。
- 任务库位于 `/data/tasks.json`，原子替换并同步落盘。损坏时拒绝启动；请备份后恢复，不会自动清空。最多保留 10,000 条任务。停止服务后备份整个 `/data` 和视频目录。
- 不提供在线播放、账号管理、自动删除、定时任务或 Android TV 功能。容器运行成功不等于 fnOS 硬件和公网部署验收。

## API

除 `GET /health`（仅存活状态）和静态界面，全部请求需 `Authorization: Bearer <token>`。写请求为 `Content-Type: application/json`。成功 `{success:true,...}`，失败 `{success:false,error}`。不支持跨站请求。

| 接口 | 参数与结果 |
| --- | --- |
| `GET /api/status` | 版本、下载根说明、并发数 |
| `GET /api/search?q=关键词&page=1` | `results`、`page`、`hasMore`；页码 1–50 |
| `GET /api/series/:id` | `series` 含标题与 `episodes:[{vid,vid_index,title}]` |
| `POST /api/downloads` | `{seriesId,episodeIds:["分集ID"],quality:"auto"}`；返回 `tasks` |
| `GET /api/tasks` | `tasks`；状态 queued/running/completed/failed/cancelled/interrupted |
| `POST /api/tasks/:id/retry` | `{}`；仅失败、取消、中断且资源已释放的任务 |
| `POST /api/tasks/:id/cancel` | `{}`；仅排队、运行任务；保留完成文件 |
| `POST /api/merge` | `{taskIds:["下载任务ID", "下载任务ID"]}`；同剧、集号不重复，自动按集号排序 |
| `GET /api/files/:id` | 只读取已登记的完成文件；无任意路径入口 |

## 源码构建与验证

先按 Linux 发行流程准备并核对 `build/ffmpeg/linux-x64/ffmpeg`、`ffprobe`、`librempeg` 和许可证。组件构建脚本为 `scripts/build-ffmpeg-source-linux.sh` 与 `scripts/build-librempeg-source.sh`，固定源码与对应源码归档沿用发行流程。Dockerfile 不使用发行版 FFmpeg 冒充 ByteVC2 支持。

```sh
docker build --platform linux/amd64 -t hongguo-drama:6.6 .
node --test server/server.test.cjs
```

真实素材检查（只在独立测试挂载目录运行，预计数分钟，实际受网络和软件转换速度影响）：

```sh
HONGGUO_URL=http://127.0.0.1:3000 \
HONGGUO_RECEIPT=/absolute/path/live-receipt.json \
node server/live-check.cjs
```

从环境读取 `HONGGUO_TOKEN`；脚本随机选真实目录剧集，再搜索、随机选相邻两集、下载、合并、读取成品并计算 SHA256。全程不打开播放器或音频设备；解码检查不等于人工播放验收。回执只记录剧名、公开 ID、相对文件路径和哈希，不记录令牌、签名媒体 URL 或密钥。外部来源失败会明确失败，不以固定测试图或彩条替代。

本次测试证据与正式发布状态以 `docs/release-6.6.md` 为准；本文不单独声明已发布或已完成 fnOS 实机验收。

## 本轮后端定向证据

2026-11-09：`node --test server/server.test.cjs` 12 项通过。覆盖鉴权/同源、拒绝任意 URL 与路径、目录身份与重启状态、符号链接、官方 CDN 跳转、取消持久化顺序、合并输入限制、存储失败停队列、来源明确拒绝暂停、任务目录挂载替换、同集冲突重试。

另将原生模块复制到无 Electron 可解析的临时目录，仅接入现有 axios，验证 `catalog` 和 `hongguo` 可加载；未模拟 Electron。桌面仍优先使用 Electron net，无 Electron 时走已有 axios 分支。

上述检查使用仅验证状态与元数据的夹具，未将夹具充当视频播放素材；真实下载与容器/重启检查另以发行验收回执为准。
