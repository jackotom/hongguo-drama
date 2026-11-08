# 6.3 海外短剧平台调研与接入

调研日期：2026-11-08。需求来源：[Issue #116](https://github.com/jackotom/hongguo-drama/issues/116)。用户确认优先本机直连，接受部分地区不可用。没有授权购买、部署中转、发布版本或回复 Issue。

## 最新结论

已找到并验证 **DramaBox 官方公开SSR**，实现于 `src/native/dramabox.js`，复用MIT `zuomeizuoyang/shortdrama-player` 固定提交 `081e7ee796372f9029724352f769c286052b9007`。真实搜索、完整49集、免费整集下载及静音播放／拖动通过；生产模块亦已实网复验。完整证据与边界见 [真实验收记录](overseas-live-2026-11-08.md)。

此前受阻的根因已定位到QX分流：QX已开启，DramaBox命中兜底DIRECT；单请求指定既有代理策略后正常。未改全局规则、未切节点。ReelShort仍保留实验适配器，其他平台不因官网200就标成可用。

以下仓库表和ReelShort接入说明保留初次调研记录；DramaBox当前状态以验收记录及 `release-6.3.md` 为准。

## 平台与现有轮子

以下为本轮检索发现的接入候选，不是平台排名；星标数与更新时间不作为可用性证明。

| 平台／项目 | 现成代码和教程 | 核查结果 | 6.3 处理 |
|---|---|---|---|
| ReelShort | [Rest-Api-ReelShort](https://github.com/wanglinsaputra/Rest-Api-ReelShort)，README 有搜索、分集、播放三步教程和 curl；`src/reelshort.ts` 有实现 | MIT，实际包含 TypeScript 源码；直连官网 Next.js 页面数据。固定提交 `95d04d04400bcfc4ce2c77583b1b9702d994fc19` | 复用路径／结构，增加现有安全与来源检查；默认关闭的实验源 |
| ReelShort Python 参考 | [AmmarrBN/reelshort-api](https://github.com/AmmarrBN/reelshort-api) | MIT，Flask 版本，存在安装与 Swagger 教程 | 当前 Node 项目不再引入 Python／Flask；作为协议交叉参考 |
| DramaBox | [zhadevv/dramabox](https://github.com/zhadevv/dramabox)，README 有 Node／CommonJS 使用及 API 方法列表 | MIT，有实际客户端源码；直连 `sapi.dramaboxdb.com`，本地签名、匿名身份、App 协议。网络代码关闭证书验证，不能照搬；真实取源未验收 | App协议已真实验证；生产最终采用更小的公开SSR方案，不保留App令牌／密钥，不复制关闭证书校验的处理 |
| DramaBox 旧接口 | [Sansekai/DramaBox-API](https://github.com/Sansekai/DramaBox-API) | 作者 README 明确旧源码不可用，新源码不再公开；未见 LICENSE。固定快照 `39a1d3c50537ff4026158f5effb125cf61b02972` | 不作为当前可复用取源组件 |
| Melolo | [Sansekai/Melolo-Short-Drama-API](https://github.com/Sansekai/Melolo-Short-Drama-API) | 只有 README、GIF，列出 latest／trending／search／detail／stream；完整源码另售。不是可自托管开源服务 | 保留接口说明，不购买、不依赖其免费中转 |
| ShortMax、NetShort、GoodShort、FreeReels、Melolo 等多平台 | [Sansekai/SekaiDrama](https://github.com/Sansekai/SekaiDrama)，README 有安装教程，`src/app/api/`、`src/services/` 有调用与数据归一示例 | MIT，多平台前端和代理路由，取源仍依赖 `api.sansekai.my.id`；不等于自包含的平台取源 SDK。固定快照 `93a37de5b18c5e578af3bb970c65db97a05d5757` | 参考展示／字段，不整体复制，不引入未知平台路线；尤其不导入其成人内容路由 |
| 多平台 Python 下载器 | [K07VN/DramaDownloader](https://github.com/K07VN/DramaDownloader) | 有 Python 实现与 CLI／SDK 教程，部分平台依赖聚合器。README 标 MIT，但本轮仓库树未见 LICENSE、GitHub 元数据 license=null | 许可与依赖待确认，不直接合入 |
| 标名“Free”的 Melolo／FreeReels 仓库 | [Melolo-API-Free](https://github.com/beranalpa/Melolo-API-Free)、[FreeReels-API-Free](https://github.com/beranalpa/FreeReels-API-Free) | 仓库只有多语言 README 与 LICENSE；文案要求购买完整源码。名字、MIT 徽章不代表仓库内有实现 | 不当作免费源码，不采购 |

## 接入方法与复用范围

1. 官网 HTML 只解析 `__NEXT_DATA__` 的 JSON，不执行网页脚本。使用其 `props.pageProps`；上游 `_next/data/...json` 的根 `pageProps` 与网页 HTML 层级不同。
2. 搜索读取 `/search?keywords=...` 的 `books`；剧集读取 `/movie/{slug}-{bookId}` 的 `data.online_base`；分集读取 `/episodes/episode-{number}-{slug}-{bookId}-{chapterId}` 的公开 `video_url`。
3. 统一映射到现有 `series_id`、`vid`、`vid_index` 契约。编号为 `reelshort:{bookId}:{slug}`、`reelshort:{bookId}:{slug}:{number}:{chapterId}`，与原来源隔离。
4. 发现读取首页 `fallback['/api/ms/hall/webInfo'].bookShelfList`，保留官网顺序。首页条目缺少 ID 时，按完整标题搜索并要求唯一精确匹配；同标题不重复请求。每类最多 12 部，总请求预算 10 秒。无已验证后续游标，因此 `hasMore=false`，不伪造翻页或随机换批。搜索也仅支持官网首屏。
5. 播放前重新读取剧集和分集状态。显式锁定、分集不匹配、无公开地址、非 HTTPS MP4／M3U8 均拒绝。不会调用付款、解锁、VIP、广告跳过或 DRM 绕过接口。
6. MP4 继续走现有媒体传输，M3U8 走现有 `hls-media` 暂存／封装。媒体请求保留来源 Referer／User-Agent 和现有公网 DNS／跳转检查。沿用本机已有网络配置，不新增中转、代理或 API Key。
7. 用户可在设置的内置来源中手动开启。启用后进入发现、全局搜索、推荐与摇一摇；下载放入独立 `ReelShort` 剧目目录。在线播放只提供“自动”画质；下载清晰度继续由现有媒体检查把关。

实现入口：`src/native/reelshort.js`；桌面分发：`main.js` 与 `src/native/hongguo.js`；前端沿用来源模型。原有账号和其他来源不迁移。

上游示例使用 `/id` 与 `_next/data` 路由；本候选读取默认语言官网 HTML，默认语言数据结构是否完全一致仍待可访问地区确认。若官网改为其他结构，明确报格式变化，不静默返回伪空片单。

## 本机可执行的最小检查

```sh
# 不打印媒体地址、凭据或远端诊断
node - <<'JS'
const source = require('./src/native/reelshort');
source.search('love').then(r => console.log({success:r.success,count:r.results?.length||0,error:r.error||''}));
JS

# 使用官网数据契约构造的静态样例，非真实媒体测试
node --test src/native/reelshort.test.cjs src/native/media-sources.test.cjs
```

## 初次实网探测与限制（后续已定位QX分流）

- 普通 HTTP 客户端访问 ReelShort、DramaBox 官网均得到 403；Ego Lite 打开 ReelShort，页面明确写明 CloudFront 按国家屏蔽访问。未绕过此限制。
- 新适配器真实执行 `search('love')` 返回 `success=false`，提示“ReelShort 连接失败，请检查网络或稍后重试”，未得到片单。适配器启用公网地址检查；不为通过测试关闭 TLS、DNS 或地址检查。
- Melolo 官网本机观察到 503，Sansekai Melolo 中转读取超时。不能把仓库说明当成实时可用证明。
- ReelShort初次测试覆盖静态契约、锁定、身份、URL 边界、地区错误及桌面分发；不证明其官网真实目录／真实播放可用。DramaBox后续真实验证见新记录。
- 初次调研尚未下载或播放海外视频；后续DramaBox已经真实下载、完整解码和静音播放／拖动，使用独立测试目录，未使用彩条或测试图替代。兼容播放与取消等桌面完整UI仍待验收。
- 不接入海外账号、字幕翻译、自动续作识别；Android／TV／iOS 来源范围不扩大。五平台正式发行仍遵守 `RELEASING.md`，缺少平台或验收不发布。
- 本轮未发布、未安装、未升级任何应用；未购买 API、未部署服务器、未向 GitHub 写入评论。
