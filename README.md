> [!IMPORTANT]
> **📢 暂停更新公告 / Maintenance Paused**
>
> 本项目（`hongguo-drama`）自 **v8.5** 起暂停更新与维护，归期未定——维护者暂别键盘，携女友远赴新加坡度假去啦 🇸🇬🌴。
> 现版本可继续正常使用，代码遵循 GPL-3.0 协议完全开源，欢迎社区自由 Fork 延续。详情请参阅 👉 [完整多语公告 (#222)](https://github.com/jackotom/hongguo-drama/issues/222)。
>
> *Development is temporarily paused as the maintainer heads to Singapore with his girlfriend. Return date TBD. v8.5 remains available under GPL-3.0.*

<p align="center">
  <img src="build/icon.png" alt="红果短剧桌面版图标" width="112" height="112">
</p>

<h1 align="center">红果短剧 · 桌面与NAS</h1>

<p align="center">发现好剧，接着上次看。搜索、播放、下载、追剧与合并导出，在一个桌面应用里完成。</p>

<p align="center">
  <a href="https://github.com/jackotom/hongguo-drama/releases/latest"><img alt="最新公开版本" src="https://img.shields.io/github/v/release/jackotom/hongguo-drama?style=flat-square"></a>
  <img alt="macOS 13 或更新版本" src="https://img.shields.io/badge/macOS-13%2B-555555?style=flat-square">
  <img alt="Apple 芯片 Mac、Intel Mac、Windows x64 与 Linux x64" src="https://img.shields.io/badge/platforms-Mac_arm64_%2F_x64_%C2%B7_Windows_x64_%C2%B7_Linux_x64-55746b?style=flat-square">
  <a href="LICENSE"><img alt="GPL-3.0 许可证" src="https://img.shields.io/badge/license-GPL--3.0-555555?style=flat-square"></a>
</p>

<p align="center">
  <a href="#下载与安装"><strong>下载与安装</strong></a> ·
  <a href="#完整功能">完整功能</a> ·
  <a href="#界面与演示">界面与演示</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="#贡献者">贡献与致谢</a> ·
  <a href="https://github.com/jackotom/hongguo-drama/issues">反馈问题</a>
</p>

## 下载与安装

**当前正式版：8.5**（内部`8.5.0`，桌面构建`8.5.1`）。

8.5 修复官网剧集页 `vid_list` 缩水与混淆 `v1_...` ID 导致的缺集与公开兜底失效（#217），分集读取升级为 `openhongguo → 签名 App video_detail/v1 → 官网 → 旧 preload` 四路链路并支持 `v1_...` 公开兜底映射；修复双栈代理/VPN Fake-IP（`fc00::/18`、`::ffff:198.18.0.0/111`）触发的安全校验误判（#215）；修复兼容模式跨画质反复自动转码循环并补齐转码产物 H.264 校验（#216）。实际状态与验收回执见[8.5记录](docs/release-8.5.md)。

| 平台 | 8.5 正式附件 | 验收状态 |
|---|---|---|
| Apple芯片Mac，macOS 13+ | [DMG](https://github.com/jackotom/hongguo-drama/releases/download/v8.5/Hongguo-8.5-mac-arm64.dmg) | 签名、公证装订、Gatekeeper 与普通启动通过 |
| Intel Mac，macOS 13+ | [DMG](https://github.com/jackotom/hongguo-drama/releases/download/v8.5/Hongguo-8.5-mac-x64.dmg) | Rosetta 普通启动与公证通过；实体 Intel 未验 |
| Windows x64 | [安装版](https://github.com/jackotom/hongguo-drama/releases/download/v8.5/hongguo-downloader-8.5-win-x64-setup.exe) · [便携EXE](https://github.com/jackotom/hongguo-drama/releases/download/v8.5/hongguo-downloader-8.5-win-x64.exe) · [便携ZIP](https://github.com/jackotom/hongguo-drama/releases/download/v8.5/hongguo-downloader-8.5-win-x64.zip) | 云端构建与最终 SDK 队列、播放、安装升级验收；EXE 未签名 |
| Linux x64 | [AppImage](https://github.com/jackotom/hongguo-drama/releases/download/v8.5/hongguo-downloader-8.5-linux-x64.AppImage) | 云端最终 AppImage 两集真实静音播放通过 |

[8.5发行页](https://github.com/jackotom/hongguo-drama/releases/tag/v8.5) · [SHA256](https://github.com/jackotom/hongguo-drama/releases/download/v8.5/SHA256SUMS.txt) · [精确源码](https://github.com/jackotom/hongguo-drama/releases/download/v8.5/hongguo-drama-8.5-source.zip)。上游部分片源仍可能限流、404、仅预览、空响应或 CDN 超时，不保证所有内容永久可播。

**Android手机APK／Android TV版：** 请前往 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) 下载。该项目独立维护；版本、兼容性与测试状态以该项目发布页为准，不计入本项目的四平台附件或验收。

## 开始使用

1. 打开「设置」，选择下载目录并保存。
2. 在「发现短剧」浏览，或在「搜索与下载」输入剧名、红果分享链接或剧集 ID。
3. 打开详情点「立即播放」，也可选择集数与清晰度加入下载队列。
4. 下次从「我的剧库」或「观看记录」接着看；下载进度、失败重试和整剧合并在「下载管理」。

## 完整功能

| 想做什么 | 主要功能 |
|---|---|
| 找剧 | 红果、西饭、河马统一搜索，分类、热播榜、分享链接解析 |
| 连续观看 | 在线与本地播放、断点续播、自动连播、倍速、后续两集预取与系统画中画 |
| 下载与导出 | 清晰度选择、批量下载、失败重试、合并 MP4 |
| 管理剧库 | 观看记录、本机收藏、新集提醒、下载文件与缓存清理 |
| 调整观看体验 | 横竖布局、置顶、小窗模式、系统画中画、主题、快捷键与画质增强 |
| 阅读评论 | 公开剧评、本集评论弹幕与本机屏蔽词 |

<details>
<summary>展开功能详情与使用限制</summary>

### 1. 找剧：三个来源，一次搜索

- **全部来源搜索**：默认同时查询红果、西饭和河马，结果标明来源；也可切换单一来源。某个来源失败时，仍显示其他来源的结果。
- **发现目录**：海报、剧名、集数、题材筛选、分页浏览和刷新片单；详情展示完整分集及下载状态。
- **红果分类与热播榜**：真人剧、漫剧、AI 剧；综合、真人、漫剧、AI 四类榜单，显示来源提供的排名与热度。
- **红果链接 / ID 解析**：粘贴分享链接或输入剧集 ID，获取详情后播放或选集下载。
- **详情直接播放**：无需先下载整部剧；未下载的可用分集尝试在线播放。
- **选集更灵活**：单选、多选、全选、反选、取消全选；快捷选前 10 集、前 30 集、后 30 集；支持 `1-30`、`1,3,5`、`1,5,10-20` 等范围。

| 来源 | 已实现 | 当前边界 |
|---|---|---|
| 红果 | 目录、题材、四类热播榜、搜索、分享链接 / ID 解析、可用分集播放下载 | 网页未提供片源时尝试补充取址，结果仍以来源实际返回为准。 |
| 西饭 | 独立目录、题材、分页、搜索、已开放分集播放下载 | 热播榜尚未接入；锁定分集保留标记并跳过。 |
| 河马 | 官网目录、题材、前后翻页、搜索、完整分集列表、明确免费分集播放下载 | 收费或状态不明的分集锁定，不提供解锁。 |

三个来源的文件按来源与剧名分目录保存。“漫画”是图文阅读内容；要播放视频请选“漫剧”。片源、清晰度及可用分集取决于平台，软件不承诺固定 1080p 或全集可用。

### 2. 播放：在线、本地与连续观看

- **本地优先**：已下载分集直接播放本地文件，未下载且未锁定分集尝试在线播放；双击未下载分集可加入下载队列。
- **基本控制**：点击画面或按钮播放 / 暂停，拖动进度条，查看时间，调整音量与静音。
- **缓存后续 2 集**：在「我的剧库」连播按钮左侧开关，默认开启并记住选择；当前集开始播放就最多预缓存后续两集可在线播放的内容，跳过已下载和锁定分集。切到下一集时会保留更后一集的预取结果；预取失败会释放名额并在 15 秒后重试。会提前使用网络流量，关闭开关可取消全部后台预缓存。
- **自动连播**：默认开启，可随时关闭；自动切换下一集，跳过锁定分集，本地与在线分集可衔接播放。
- **断点续播**：按剧保存集数和播放位置，从剧库或观看记录接着看；切换到应用内其他页面，仍可继续播放并保存进度。
- **0.25×–4× 倍速**：共 16 档。右下角倍速数字是独立按钮，每点增加 0.25×，4× 后回到 1×；三点菜单可直接选档，切集与连播保持当前倍速。`S` / `D` 每次调节的幅度可在「设置 → 播放快捷键」中选择 0.25×、0.5×、0.75× 或 1×。
- **兼容播放**：默认开启兼容模式；解码失败、黑屏有声时尝试转为 H.264，也可手动「转码后播放」。显示转码进度，支持取消和清理缓存。
- **高性能转换（7.1）**：桌面「解码方式 → 高性能显卡快速解码（老电脑请勿使用）」默认关闭。开启后优先用显卡编码H.264；ByteVC2仍由CPU解码，4线程、单队列。Mac尝试VideoToolbox，Windows依次尝试NVIDIA NVENC与AMD AMF（VCE／VCN），Linux尝试NVIDIA NVENC；实际输入试编码出帧，不支持或失败时明确提示并回退CPU。不是所有格式的GPU硬解，也不保证所有独显支持；实体NVIDIA和AMD尚未在本项目发行验收中实跑。本轮M5样本未提速且文件更大，见[性能与验收记录](docs/release-7.1.md)。
- **失败恢复**：可取消准备、重试本集、重新连接片源或尝试兼容转码。地址过期或传输中断时有限次刷新取址，不无限重试；硬件转码失败时尝试软件转码。

优先选择兼容性较好的 H.264 片源，同编码内再优先清晰度；可能低于 HEVC 片源的最高分辨率。软件转码可能更慢，来源服务异常仍可能导致播放失败。

在线播放不保存到下载目录，但部分片源会先准备临时媒体文件并在使用后清理；兼容转码另有磁盘缓存。因此“在线”不代表完全不占磁盘。

### 3. 画面与窗口：横屏、竖屏和专注观看

- **横屏版 / 竖屏版**：从顶部切换布局；切回横屏时恢复此前窗口尺寸与位置。
- **窗口置顶**：一键置顶 / 取消置顶，方便边工作边看。
- **系统画中画**：播放控制条一键弹出原生悬浮小窗；小窗继续使用当前播放元素，可拖动、置顶、暂停与关闭，自动连播和切换清晰度时保持小窗，切换虚拟桌面后继续播放。小窗位置与跨桌面行为由系统管理。
- **小窗模式**：顶部「小窗模式」把主窗口缩为 400×600 的置顶窗口并保持播放；在 Electron 支持工作区 API 的平台上设为所有虚拟桌面可见。鼠标移开时暂停并隐藏，移回继续，Esc、Dock 或窗口菜单可恢复。
- **右侧一体选集**：竖屏模式下，选集栏随窗口展开或收起，减少对视频的遮挡。
- **隐藏管理按钮**：收起不常用操作，让播放区更简洁。
- **去掉播放器边框**：竖屏下去掉播放区周围留白与圆角；这是播放器布局效果，不是移除系统窗口边框。
- **全屏**：横屏使用视频全屏；竖屏填满当前窗口，`Esc` 退出。全屏或竖屏播放时，控制条闲置约 2 秒自动隐藏，移动鼠标或操作非切集快捷键后重新显示；暂停、拖动进度条、打开菜单或键盘焦点停在控件上时保持可见。自动连播及上一集、下一集快捷键切集时，已隐藏的控制条保持隐藏，不再短暂弹出。
- **画面模式**：在播放器三点菜单切换，**每部剧独立记忆**，切换保留播放进度。

| 画面模式 | 效果 | 适合场景 |
|---|---|---|
| 适应窗口（默认） | 按可用宽高等比缩放，完整显示画面 | 希望人物、字幕和画面边缘都能看全。 |
| 保持宽度 | 按可用宽度等比缩放；只缩短窗口高度时，画面不跟着变小，上下超出部分居中裁剪 | 希望调整窗口高度时保持画面大小；注意边缘字幕或人物可能被裁掉。 |

### 4. 观看记录与追剧提醒

- 独立「观看记录」页，真正开始播放后才计入，按最近观看排序。
- 显示封面、剧名、集数、播放时间点及最近观看时间，点击继续观看。
- 支持手动「检查更新」；应用运行期间每部剧约 6 小时检查一次新集，列表较多时分批处理，以红点和新增集数提醒。
- 约每天检查同来源、同名且季数更高的**疑似续作**，并直接打开；该功能可单独关闭，名称匹配可能误报或漏报。
- 系统通知默认关闭，可在设置中开启；仍需系统允许通知。

追剧检查仅在应用运行时执行，不承诺退出后提醒或实时推送。观看记录保存在本机，不提供跨设备同步。

### 5. 下载队列：批量保存与失败恢复

- **下载清晰度**：自动（兼容优先）、1080P、720P，可保存默认值。按视频实际尺寸选源，保存前再次检查。红果片源所选画质不可用或下载失败时尝试更低清晰度，并显示提示。不会放大冒充高清；只有更高分辨率时保留原分辨率，不降采样。
- **任务独立保存选择**：修改默认清晰度不改变已有任务的普通重试；已有低清文件保留，不自动覆盖。清晰度选项仅影响下载，不改变在线播放策略。
- 单集或批量加入队列，显示等待中、下载中、已完成、失败、已停止状态，以及下载进度、已接收 / 总字节数和失败原因。
- 支持全部开始、全部暂停、单任务停止、重试失败、选中失败项及重试选中；停止的任务可重新排队。
- **1–10 个并发下载**，默认 3，在设置保存后生效；较高并发可能触发来源限流。
- 下载列表按剧组织并分页；**跨页全选、取消全选、选择保留与批量删除**。
- 删除前确认：默认仅删除任务记录，可勾选同时删除本地文件；可清空已完成记录。
- 一键打开任务文件夹；**扫描下载目录**，补登记符合应用目录与命名规则的已有文件。

片源的“1080P”标签可能与实际尺寸不符，也不代表上游母版质量；不保证每部剧或每一集都有 1080P。“重新排队 / 重试”不等于从已下载字节续传，锁定集不能加入下载队列。

### 6. 合并导出：多集合成一个 MP4

在「下载管理」选择剧名后点「合并整部剧」，无需勾选任务；「我的剧库」也提供合并入口。候选列表只显示仍有本地可合并分集的剧，在线播放记录不会混入；仅删除任务记录但保留文件时，仍可合并。

| 模式 | 处理方式 |
|---|---|
| 智能快速合并 | 编码参数一致时直接拼接；不一致时按需要处理音视频，混合编码可能需要转码。 |
| 兼容合并（H.264） | 导出 H.264/AAC；已兼容分集尽量直接拼接，仅处理不匹配部分。 |

显示阶段、进度、耗时及可用的处理速度 / 预计剩余时间，支持取消、打开输出所在文件夹和移除合并记录。两种方式都保留原始分集；**仅合并已下载分集，不会自动补齐缺集**。转码并非无损，用时取决于内容和设备。

### 7. 我的剧库与空间清理

- 搜索、切换已登记短剧，查看集数、下载数量和文件占用，下载尚未完成的可用分集。
- 从剧库列表移除但保留文件；恢复已移除的剧；批量清理没有本地下载的剧。
- 删除单部剧或全部已下载文件，保留剧集信息，之后仍可尝试在线播放或重新下载。
- 分别清理在线播放缓存与兼容转码缓存。
- 可选「看完自动删」：一集播放结束后删除该集本地文件，默认关闭。**需要长期保留视频时不要开启。**

### 8. 设置、网络与软件更新

- **下载位置**：选择文件夹或手动填写目录。
- **命名规则**：支持「剧名」「集数」「标题」变量，以及“剧名_第N集”“剧名_第N集_标题”预设；保留独立集号以避免覆盖。
- **代理配置**：开关、跟随系统 / 环境变量、手动 HTTP/HTTPS 代理、强制直连；支持地址端口、常见端口预设及可选认证信息。
- **代理测试**：可在保存前测试草稿配置，保存后生效。当前“跟随系统”主进程读取 `HTTP_PROXY` / `HTTPS_PROXY` 等环境变量，不保证识别所有系统代理或 PAC；一次测试成功不代表全部片源可访问。
- **提醒开关**：分别控制新集检查、疑似续作、系统通知和自动检测软件更新。
- **软件更新提示**：默认开启；启动及运行期间每 6 小时检查 GitHub 正式新版。右上角提醒可关闭，也可取消自动检测并保存；网络失败不阻止使用旧版。
- Mac 与 Windows 安装版可从更新提醒下载新版，查看进度，下载完成后点击重启安装；也可从设置中检查更新。不经点击，不自动下载或在退出时安装。
- Windows 便携版使用官方下载页入口，退出后手动替换；更新失败不会要求清空原资料。所有版本均保留发行页入口，不强制升级。

### 9. 外观、收藏与评论

- **外观与窗口**：浅色、深色或跟随系统；小窗模式在鼠标移开时暂停并隐藏，移回继续，可通过 Esc、Dock 或窗口菜单恢复主窗口；系统画中画用于跨应用和虚拟桌面继续观看。
- **找剧辅助**：本机搜索历史联想、公开热播榜、已完结或更新中筛选；未知状态不冒充已完结，热播榜不是账号个性化推荐。
- **公开剧评与本集弹幕**：查看来源提供的评分、整剧剧评和单集评论节选。弹幕可调不透明度、字号、速度、区域和密度，也可隐藏入口；默认开启常见敏感词过滤，可添加本机屏蔽词，无法识别所有变体。
- **本机收藏与上新**：收藏仅保存在本机；「收藏与上新」按已浏览剧集的首次公开日期整理，不是完整的未来上新排期。
- **画质增强**：原画、可调锐化、Anime4K CNNx2M 2× 增强。Anime4K 面向动漫，支持不高于 1080p 的输入；真人画面可能偏平滑，不兼容或处理持续过慢时恢复原画，不改变下载文件。
- **分享链接**：用户主动点击后读取分享链接；公开剧集可复制官方分享页链接。

公开评论仅供阅读，弹幕通常只有公开网页首屏约 15 条，读完不会循环。当前不提供手机号登录、手机账号收藏／点赞／历史同步、弹幕发送或回复。

</details>

## 播放快捷键

| 按键 | 操作 |
|---|---|
| `空格` | 播放 / 暂停 |
| `←` / `→` | 后退 / 前进 5 秒 |
| `↑` / `↓` | 上一集 / 下一集 |
| `A` | 开启 / 关闭连播 |
| `S` / `D` | 按设置步长降低 / 提高倍速（默认 0.25×） |
| `F` | 切换全屏 |
| `Esc` | 退出竖屏填满窗口状态，或关闭当前菜单 / 弹窗 |

以上为默认键位，可在「设置」中点击修改，支持单键或 Shift 组合，并检查冲突、恢复默认；`S` / `D` 的调速步长也在同一区域设置。输入框、菜单和弹窗操作不会误触播放器快捷键。

## 界面与演示

![红果短剧 1.6：热播推荐与公开榜单](docs/screenshots/macos-v1.6-hot.jpg)

<p align="center"><sub>macOS 1.6 正式版实拍：热播推荐页面。截图中的片单与热度为截取时的公开榜单内容，会随来源更新。</sub></p>

<details>
<summary>观看 3 分钟功能介绍（基于 1.3，未包含后续更新）</summary>

https://github.com/user-attachments/assets/b95f4f60-b57c-495f-a30e-62ac2b0bda11

3 分钟，从三来源搜索、链接解析讲到播放续看、下载合并、横竖屏与画面模式，再展示 1.3 的主题、快捷键、隐身小窗、热播推荐、公开剧评、本机收藏与日历、画质增强和更新提醒。

视频使用 1.3 正式前端和隔离的演示资料；播放器画面为短剧封面演示，集数、榜单、评分、评论与日期不代表真实平台数据。

[下载三分钟介绍视频（1080p，约6 MB）](https://github.com/jackotom/hongguo-drama/releases/download/v1.3/Hongguo-1.3-Complete-Intro-3min.mp4)

</details>

## 常见问题

### 为什么有些分集锁定、加载失败或清晰度不同？

片源和可用范围由来源服务决定；西饭锁定集、河马收费或状态不明集会保留锁定。应用不提供解锁或广告奖励接口，不承诺付费内容可用。来源接口可能变化，过去能用不保证一直可用。

### 下载失败、目录加载不出来怎么办？

先检查网络与来源平台，再检查代理开关和模式，适当降低并发，使用「重试失败」或重新加载目录。黑屏有声可尝试兼容模式。

### 视频、设置和记录存在哪里？

视频保存在设置中的下载目录，按来源与剧名组织。设置、任务及观看记录默认位于：

- macOS：`~/Library/Application Support/hongguo-downloader/`
- Windows 安装版：`%APPDATA%\hongguo-downloader\`
- Windows 便携版（3.4 起）：程序所在目录的 `data\`（单文件便携 EXE 和解压即用版相同）

自行指定用户资料目录时以指定位置为准。移除剧库条目、删除任务记录、删除视频和清理缓存是不同操作，请核对确认框。

### 怎样在应用内更新？

先手动安装一次最新版。之后，Mac 与 Windows 安装版发现新版时可点击下载，完成后再点击重启安装；Windows 便携版仍通过发行页手动下载。软件不会强制更新，也不会因为普通退出而自动安装已下载的版本。关闭提醒或自动检测后，旧版仍可继续使用；来源服务变化仍可能影响功能。

### Windows 下载新版后，为什么仍显示旧版本？

先退出所有正在运行的红果短剧，再运行最新版文件名以 `-setup.exe` 结尾的安装包，完成后从安装程序生成的快捷方式启动。不要继续使用指向旧便携版的桌面或任务栏入口。设置页显示的版本号才是当前运行版本。

继续使用便携版时：单文件便携 EXE 请放回原文件夹，保留同目录的 `data` 文件夹后再运行；ZIP 版解压到新文件夹后，先把旧文件夹的 `data` 复制过去，或直接覆盖原文件夹中的程序文件。只运行新文件夹里的 EXE 而丢掉 `data`，会显示空记录或回退到系统目录里的旧记录。确认版本正确后，再更新自己的快捷方式。无需清空整个系统 Temp、应用资料目录或下载的视频。若仍显示旧版，请反馈实际启动文件名和设置页版本号，隐去个人路径。

### 自行构建也有签名和公证吗？

源码默认 Mac 构建使用 ad-hoc 签名，不会自动使用开发者证书或提交公证。正式 Mac 包的 Developer ID 签名与公证是独立发行步骤；Windows 包当前未签名。无需为本应用全局关闭 Gatekeeper。

### 如何反馈问题？

到 [Issues](https://github.com/jackotom/hongguo-drama/issues) 提供应用版本、操作系统与芯片类型、来源、复现步骤和错误提示。截图与日志请移除账号信息、Cookie、代理凭据及个人文件路径。

## 从源码构建 Mac 版

<details>
<summary>展开构建步骤、产物位置与 FFmpeg 对应源码说明</summary>

应用使用 **Electron + React + Node.js**。构建需要 Node.js **22.12 或更新版本**、npm、Apple Command Line Tools、`pkg-config`，以及可用的 `make`、`git`、`curl`。构建脚本不会自动安装这些系统依赖。

```sh
git clone https://github.com/jackotom/hongguo-drama.git
cd hongguo-drama
npm ci
npm run build:mac
```

上述默认命令在 Apple Silicon 上构建两种 Mac 架构。Intel 构建机请先运行 `node scripts/setup-ffmpeg-mac.js x64` 和 `npm run build:react`，再运行 `npx electron-builder --mac dmg zip --x64 --publish never`。

构建会验证已有 FFmpeg / FFprobe 缓存；缺少匹配缓存时，从固定且经过 SHA256 校验的 FFmpeg/x264 源码编译，然后生成前端、指定架构应用、DMG 和 ZIP。首次构建需联网获取依赖和源码，编译可能耗时数分钟。默认 ZIP 只是构建产物，不能直接作为官方签名更新包发布；正式发行需在签名、公证和装订后重新生成 ZIP 与更新清单。

| 用途 | 命令或产物 |
|---|---|
| 开发模式 | `npm run dev` |
| 仅生成 Mac 应用 | `npm run build:mac:dir` |
| 应用产物 | `dist/mac-arm64/红果短剧.app`、`dist/mac/红果短剧.app` |
| DMG / ZIP | `dist/hongguo-downloader-<版本>-mac-<架构>.dmg` 与 `.zip`；公开版本使用两段，内部格式见 `package.json`。正式 DMG 另以发行页中的名称提供 |

### FFmpeg 的准确对应源码

Mac 包内置的 FFmpeg / FFprobe 基于 **FFmpeg 9.0.2** 与 **x264 `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`** 的未修改源码编译。此构建为 **GPLv3-or-later**，仅静态链接 x264，保留 VideoToolbox，未启用 `nonfree`；动态依赖仅为 macOS 系统库，不依赖使用者的 Homebrew 环境。

[各版本的 Release](https://github.com/jackotom/hongguo-drama/releases) 附有**应用源码 ZIP**以及独立的 **FFmpeg/x264 完整对应源码包**，后者包含准确源码归档、构建脚本、清单与许可文本。请按需要的应用版本与平台选择对应附件。只下载 GitHub 自动生成的项目源码归档，不能代替这一媒体工具对应源码包。

- [FFmpeg 来源、源码校验值与构建说明](build/ffmpeg/MACOS-NOTICE.txt)
- [准确版本与构建配置](build/ffmpeg/MACOS-VERSIONS.txt)
- [FFmpeg 源码构建脚本](scripts/build-ffmpeg-source-mac.sh)
- [FFmpeg GPLv3 许可全文](build/ffmpeg/MACOS-LICENSE.txt) · [x264 许可全文](build/ffmpeg/MACOS-X264-LICENSE.txt)

FFmpeg 二进制不提交到 Git。重新分发编译包时，请按 GPL 要求同时提供完整对应源码及构建材料。

</details>

## 从源码构建 Windows 版

在 Windows x64 上构建安装版或便携 EXE，需准备匹配的 FFmpeg / FFprobe；完整依赖、媒体工具源码与构建命令见 [三平台发行与 Windows 构建说明](docs/RELEASING.md)。云端工作流同时生成 NSIS 安装版、更新清单与便携版。自行构建不会自动获得代码签名。

## 贡献者

感谢所有代码贡献者与问题反馈者。[完整贡献记录与问题编号](CONTRIBUTORS.md)已核对至 2026-11-15，包含历史开放／已关闭的全部 12 个 PR 和 137 个 Issue。

### 7.5 播放恢复特别鸣谢

| 贡献者 | 实际贡献 |
| --- | --- |
| [N3urda（NANA）](https://github.com/N3urda) | 维护上游 hongguoTV，提交并组织 [PR #60](https://github.com/N3urda/hongguoTV/pull/60) 的播放恢复发行。 |
| [ermilylu](https://github.com/N3urda/hongguoTV/commit/18c37c2afd0567520135abcae312352542f09083) | 纯 Kotlin Android v5 签名核心、合成向量及上游播放验证的公开 Git 作者；本项目 7.5 据此移植纯 JavaScript 实现。账号尚未关联，保留原始署名。 |
| [WEP-56](https://github.com/WEP-56) | 在 [Issue #162](https://github.com/jackotom/hongguo-drama/issues/162#issuecomment-6915976249) 提供上游 PR 线索，帮助定位播放恢复方案。 |

以上按实际贡献致谢。GitHub 右侧 Contributors 由提交历史与账号关联自动生成，此名单不改变提交作者或统计。

**代码提交作者：** [@jackotom](https://github.com/jackotom)、[@ZainCheung](https://github.com/ZainCheung)。

**PR 提交者（10 位）：** [@aaaasssddfgh](https://github.com/aaaasssddfgh)、[@anupam-orbis](https://github.com/anupam-orbis)、[@ceco3000](https://github.com/ceco3000)、[@jackotom](https://github.com/jackotom)、[@jayeeliu](https://github.com/jayeeliu)、[@j2-cuong](https://github.com/j2-cuong)、[@jjay5520](https://github.com/jjay5520)、[@roytjus](https://github.com/roytjus)、[@xinbaojian](https://github.com/xinbaojian)、[@ZainCheung](https://github.com/ZainCheung)。未合并的方案也保留提交致谢，不代表已经采用。

<details>
<summary>展开全部 82 位问题反馈者</summary>

[@96827123](https://github.com/96827123) · [@adfnaa](https://github.com/adfnaa) · [@AguoofAlishan](https://github.com/AguoofAlishan) · [@airwenlee](https://github.com/airwenlee) · [@allenyip-blip](https://github.com/allenyip-blip) · [@bigbaibai-luis](https://github.com/bigbaibai-luis) · [@breadxuqiqi](https://github.com/breadxuqiqi) · [@buer052594](https://github.com/buer052594) · [@caolixiang](https://github.com/caolixiang) · [@ccicc-ccicc](https://github.com/ccicc-ccicc) · [@ceco3000](https://github.com/ceco3000) · [@ceylog](https://github.com/ceylog) · [@changyidong](https://github.com/changyidong) · [@chenchihcu](https://github.com/chenchihcu) · [@CloudPeakBAI](https://github.com/CloudPeakBAI) · [@coffeefreehans](https://github.com/coffeefreehans) · [@darkj2k](https://github.com/darkj2k) · [@dcxa521gi](https://github.com/dcxa521gi) · [@diaobugou](https://github.com/diaobugou) · [@dickyluo](https://github.com/dickyluo) · [@eq1024](https://github.com/eq1024) · [@Freeze7749](https://github.com/Freeze7749) · [@fzyifeng](https://github.com/fzyifeng) · [@GGreyCat](https://github.com/GGreyCat) · [@gugugaga-doro](https://github.com/gugugaga-doro) · [@GuoJiKaiHehe](https://github.com/GuoJiKaiHehe) · [@hongminzheng](https://github.com/hongminzheng) · [@huihui278](https://github.com/huihui278) · [@Ifover](https://github.com/Ifover) · [@kanonso](https://github.com/kanonso) · [@ken6678831-man](https://github.com/ken6678831-man) · [@kingport](https://github.com/kingport) · [@leo1300177](https://github.com/leo1300177) · [@licongy](https://github.com/licongy) · [@lqg5522](https://github.com/lqg5522) · [@LTRltr](https://github.com/LTRltr) · [@lzy139822](https://github.com/lzy139822) · [@macvip](https://github.com/macvip) · [@MaxeWang123](https://github.com/MaxeWang123) · [@midpoint](https://github.com/midpoint) · [@Mono-dev07](https://github.com/Mono-dev07) · [@Mrjoker818](https://github.com/Mrjoker818) · [@mydance-wj](https://github.com/mydance-wj) · [@n2ryx](https://github.com/n2ryx) · [@Noisercontrollers](https://github.com/Noisercontrollers) · [@perlist](https://github.com/perlist) · [@ppsbbs](https://github.com/ppsbbs) · [@r5kc](https://github.com/r5kc) · [@RuningLittleSnail](https://github.com/RuningLittleSnail) · [@Ryan-zyg](https://github.com/Ryan-zyg) · [@ryancq1982](https://github.com/ryancq1982) · [@s7c6vr9hsh-pixel](https://github.com/s7c6vr9hsh-pixel) · [@shara2006](https://github.com/shara2006) · [@superterry-svg](https://github.com/superterry-svg) · [@SysuJayce](https://github.com/SysuJayce) · [@sza253](https://github.com/sza253) · [@Tangkage](https://github.com/Tangkage) · [@tt555-1](https://github.com/tt555-1) · [@TTroia](https://github.com/TTroia) · [@VictorLee2077](https://github.com/VictorLee2077) · [@Wan-ZL](https://github.com/Wan-ZL) · [@wangfujie](https://github.com/wangfujie) · [@wgsjjj](https://github.com/wgsjjj) · [@winddriver](https://github.com/winddriver) · [@wms888](https://github.com/wms888) · [@wuhai007007](https://github.com/wuhai007007) · [@wwxiaoo](https://github.com/wwxiaoo) · [@xiaobai-chun](https://github.com/xiaobai-chun) · [@xiaobutx](https://github.com/xiaobutx) · [@xinbaojian](https://github.com/xinbaojian) · [@Xinran123757](https://github.com/Xinran123757) · [@xutengyang](https://github.com/xutengyang) · [@yetonggo](https://github.com/yetonggo) · [@yeuemfantasy](https://github.com/yeuemfantasy) · [@yidasanqian](https://github.com/yidasanqian) · [@yujian0222](https://github.com/yujian0222) · [@yyyyyy1111wq](https://github.com/yyyyyy1111wq) · [@ZainCheung](https://github.com/ZainCheung) · [@zhangyibin8111](https://github.com/zhangyibin8111) · [@Zhengs2009](https://github.com/Zhengs2009) · [@zouyelin](https://github.com/zouyelin) · [@ZZQ2417536071](https://github.com/ZZQ2417536071)

</details>

**页面列示的历史协作账号：** [@cursoragent](https://github.com/cursoragent)。来源与统计边界见完整名单。

GitHub 右侧 Contributors 按真实提交历史自动生成；本节单独向 PR 提交者和问题反馈者致谢。


### 7.1

- **[anupam-orbis](https://github.com/anupam-orbis)**：通过[PR #140](https://github.com/jackotom/hongguo-drama/pull/140)提供follow-redirects依赖锁更新，7.1采纳实际版本1.16.3；本项目另补重定向安全回归。

### 4.1

- **[jayeeliu](https://github.com/jayeeliu)**：通过 [PR #61](https://github.com/jackotom/hongguo-drama/pull/61) 提出并提供随批量下载导出弹幕、评论、剧评 JSON 的初始实现。4.1 在审查基础上重新接入实际视频任务路径，修复异步结果与部分弹幕重试问题；原 PR 未直接合并，保留其功能贡献署名。

## 上游、许可证与使用边界

本项目延续上游的 **[GPL-3.0](LICENSE)** 许可，并保留修改与来源声明。Mac 分支自 2026-10-07 开始适配，详细变更见 [NOTICE](NOTICE)，组件许可见 [第三方声明](THIRD-PARTY-NOTICES.md)。

感谢以下项目提供的基础工作与参考：

- **[327044572/hongguo-downloader](https://github.com/327044572/hongguo-downloader)**：原始上游项目。
- **[zhenyong97/hongguo-downloader](https://github.com/zhenyong97/hongguo-downloader)**：本次 Mac 移植的直接基础。
- **[woshishiq1/drpys](https://github.com/woshishiq1/drpys)** 与 **[N3urda/hongguoTV](https://github.com/N3urda/hongguoTV)**：App 片源相关算法来源；准确提交与修改说明见 [算法来源声明](src/native/licenses/NOTICE.txt)。
- **[Hululu007/drpy-node](https://github.com/Hululu007/drpy-node/tree/295f2b7047e14122d542a7736cb931e81abcf85c)**：西饭接口路径与返回结构参考；本项目独立编写适配器。
- **Electron、React、FFmpeg 与 x264**：桌面运行、界面和媒体处理组件，许可详情见上述声明。

开源许可适用于软件，不授予剧集内容的再分发权。安装包不包含剧集媒体；作品版权归原平台及创作者所有。请仅处理你有权访问、下载或备份的内容，遵守平台条款与相关法律，勿用于未经授权的传播或商业盗版。平台接口可能调整，某次验证通过不保证后续片源持续可用。
