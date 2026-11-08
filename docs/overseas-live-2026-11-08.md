# 海外短剧真实搜索、分集、播放与下载验收

日期：2026-11-08。范围：6.3本地开发；不发布、不安装、不替换正式应用。

## 结果

**DramaBox真实来源链路已通过，当前Electron测试窗口的目录、详情与在线播放也已验通。** 前期仅用QX单请求策略，普通应用仍403；后续取得用户明确授权，新增两组域名的代理分流，未切换节点。分阶段证据如下，不等于所有Electron功能或其他平台验收。

## QX根因与纠正

用户的 Quantumult X VPN 原本已经连接，默认路由在 `utun8`。无本地HTTP/SOCKS监听不代表没有代理；`proxy:false`只禁用显式HTTP代理，不能绕过TUN。此前把无监听端口当成没开代理的判断不准确，已纠正。

QX网络活动明确显示 `sapi.dramaboxdb.com` 命中 `FINAL / 兜底策略 / DIRECT`。问题是域名分流为直连，并非QX没有开启。

依据QX官方 [单请求policy示例](https://github.com/crossutility/Quantumult-X/blob/master/sample-fetch-opts-policy.js) 和 [二进制bodyBytes示例](https://github.com/crossutility/Quantumult-X/blob/master/sample-bytes-rewrite.js)，在临时脚本中仅为测试请求指定现有已选节点。临时回环传输只监听127.0.0.1，用于让本机Node协议代码通过QX发请求；本轮结束后已关闭，不属于产品运行依赖。脚本未保存成任务，全局规则与节点未改变。

单请求指定策略后，DramaBox、GoodShort、NetShort、ReelShort四个官网GET均HTTP200；这只证明网络可达，不代表其他三个源已完成业务验收。

## DramaBox现场证据

首先按 [zhadevv/dramabox](https://github.com/zhadevv/dramabox/tree/a9c844c33f74061d169b19c8b5ef15cc693da542) 的MIT实现核对App签名匿名初始化：HTTP200、业务码0，拿到匿名身份。随后 `love` 真实搜索返回10条。匿名身份和媒体地址仅在进程内存，没有写入记录。

`chapterv2/batch/load`不是完整目录：曾对总数86的剧只返回6条；不得把它当作全剧列表。因此生产实现改用 [MIT公开SSR方案](https://github.com/zuomeizuoyang/shortdrama-player/blob/081e7ee796372f9029724352f769c286052b9007/overseas/dramabox.py)，无需App令牌或签名密钥。

| 验收项 | 实际结果 |
|---|---|
| 随机真实剧目 | Love You To Death，bookId `42000000481` |
| 完整分集 | 官网SSR返回49条，编号唯一且连续，和官方总数49一致 |
| 开放状态 | 6集明确 `unlock === true`；其余保留锁定，不因price=0或预览地址放行 |
| 测试素材 | 第1集，chapterId `700030540`，来自本轮真实取源并下载 |
| 完整文件 | 22,838,305字节，MP4，H.264，720×1280 |
| 时长 | 官网140.681秒；ffprobe实际140.566009秒，非15秒预览 |
| SHA256 | `9affc204bae0d077c3d4cb05ba58b47fdf4838533d0108f5d2c7c5a3a55b178c` |
| 完整解码 | FFmpeg只解码视频至null，全程无错误、不输出声音 |
| 实际播放 | Ego载入本轮完整MP4；播放前确认muted=true、volume=0；时间推进至3.022244秒 |
| 拖动后播放 | 跳至80秒，继续推进至82.005525秒；解码帧数202，media error=null，全程静音 |

## 最终生产模块实网复验

加载实际 `src/native/dramabox.js`，仅替换测试传输为上述QX单请求通道；解析、身份、完整性、锁定、分页和媒体选择均运行产品代码，未注入预制返回值。

- 搜索 `Love You To Death`：官网返回20条，含目标ID；官网报告总数500、25页，按原分页返回，不将推荐回填数解释为精确命中数。
- 浏览目录：首页12部，官网167页。
- 分集：49条，6条开放，未知／锁定集拒绝取源。
- 生产取源：公开未加密MP4，第1集，官网时长140.681秒；锁定集明确拒绝。
- 用生产取源地址请求前2048字节，HTTP206，`Content-Range: bytes 0-2047/22838305`；总大小及前缀与上方已完整下载并播放的文件一致。

## 本地验证与边界

- `node --test src/native/dramabox.test.cjs src/native/reelshort.test.cjs src/native/media-sources.test.cjs`：18项通过。
- `npm run build:react`：通过，保留原有Vite CJS弃用与大包体警告。
- 只读审查发现的顶层Next locale校验缺口已修复，补充缺语言／非英文拒绝用例；实网模块复验运行修复后的代码。
- 素材、截图、无敏感信息的机器可读回执在 `.planning/overseas-6.3/live-media/`；不入公开源码包，不含签名媒体地址或账号凭据。
- 初次验收阶段未改QX规则；后来用户明确授权新增两组域名分流，当前测试窗口已直接可用，见下方最新记录。
- 未完成Electron完整UI、所有锁定集／全部免费集、其他剧目长时连播、Windows／Linux／双Mac硬件及AndroidTV验收。Android／TV／iOS来源范围未扩大。

## 前期受阻记录

当前QX原规则下，App bootstrap的Axios、原生HTTPS、上游TLS组合均曾HTTP403，Webfic目录也403；GoodShort目录403／搜索超时，NetShort官网403，FreeReels超时或连接重置。上述记录反映当时的规则和请求方式，不能再概括为“本机所有海外来源不可用”或“没有代理”。

GoodShort／NetShort存在同一MIT仓库的直连实现，暂未移植；FreeReels现有若干仓库只售卖源码、依赖聚合器或仅为通用视频提取包装，不当作完整可用来源。

## 测试窗口403复现与待确认配置

用户在打开的最新源码窗口选择DramaBox，仍出现HTTP403。现场用实际dramabox.browseList({page:1})再次复现success=false/count=0/HTTP403；QX当前网络活动明确记录www.dramabox.com命中FINAL／兜底策略／DIRECT。测试资料中DramaBox已开启，未启用显式HTTP代理，不代表QX未运行。

此前仅单次指定QX策略验通，未将出站条件带入普通应用，因此不能交付成“打开应用就能用”。拟做的最小网络配置为host www.dramabox.com和host-suffix dramaboxdb.com走既有proxy策略；仅涉及该站点与其官方CDN族，不切节点。先准备候选，等待用户确认后才改QX规则；不扩大到全局代理。


## 最新修复：普通测试应用403已解除

用户明确授权“允许，只改这两组域名”。通过QX原生界面添加并看到保存成功回执：

```ini
host, www.dramabox.com, proxy
host-suffix, dramaboxdb.com, proxy
```

这些是持续生效的域名分流：影响本机所有应用访问所列官网与官方域名族；没有扩大为全局代理，没有切换节点，没有添加其他域名。本轮不再依赖临时脚本或回环转发。

同一反馈命令（实际dramabox.browseList({page:1})）修改前success=false/count=0/HTTP403，修改后success=true/count=12。随后在原来的Electron测试窗口点击“重新加载”，实际显示12部DramaBox剧目与167页。

当前窗口打开《Hands Off My Rolls-Royce》，取得完整50集目录，前8集开放、其余锁定。点击“立即播放”后真实视频显示画面，进度从0秒推进到14秒、30秒、39秒，总时长1:02。测试进程启动参数--mute-audio事先核对存在；播放器音量随后也明确设为0，按钮显示“取消静音”。最后已暂停在约39秒，窗口留给用户继续测试。

这次没有更改产品代码，因此不重复已通过且未变化的18项测试与构建。新增验证范围为当前网络条件下的目录反馈命令及一条真实Electron发现/详情/在线播放流程；未扩大到本轮新的下载任务、付费集、全剧连播或多平台验收。未发布、未公证、未替换正式安装。
