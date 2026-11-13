# #151 官方中文字幕来源核实（2026-11-13）

## 结论

本轮未取得 DramaBox 或 ReelShort 可独立加载、与当前分集身份及时间轴绑定的公开中文字幕轨道。不能把中文界面、中文剧名、另一语言版本的视频或 `book_sub_title` 当作字幕文件，也不能编造字幕字段或使用 AI 翻译代替。

## 实际访问

所有请求均只读、无需账号，未调用解锁接口或付费接口。浏览器使用 Ego Lite TaskSpace 10；只取官网公开 HTML、`__NEXT_DATA__` 与已经引用的公开脚本。媒体地址未写入本文。

### DramaBox

`www.dramabox.com` 首页、`/browse`、`/drama/42000000481` 与 `www.dramaboxdb.com/drama/42000000481` 本轮均返回 CloudFront HTTP 403。公开剧目为之前已验的 Love You To Death，但本轮未取得其数据；2026-11-08 的通过记录不能代替本轮字幕来源验证。

未修改 QX 规则或节点。不能据此断言官网不存在中文字幕，也不能断言本机未开启网络工具。

### ReelShort

| 公开页面 | 剧集身份 | 分集 | 语言 | 官网时长 | 字幕检查 |
|---|---|---|---|---|---|
| Crowned in Silver Blood | `6a73e8221ba18f8dcb0e84b9` | `18e05db7ku`，第 1 集 | `en` | 145 秒 | 分集 SSR 无独立字幕字段；`book_sub_title: []`；DOM 无 `track` |
| 我的小救星 | `6a71439fb020f89d5f09ecdd` | `68b4fqhl1m`，第 1 集 | `zh-TW` | 223 秒 | 分集 SSR 无独立字幕字段；`book_sub_title: []`；DOM 无 `track`，资源列表无 SRT/VTT |
| 轉角遇見愛：戀上我的命定狼王 | `687f01320286ec55d50a79d2` | `sjm8k8otag`，第 1 集 | `zh-TW` | 166 秒 | 整剧 `original_lang: en`；分集 SSR 无独立字幕字段；`book_sub_title: []`；DOM 无 `track` |

公开视频域名为 `v-mps.crazymaplestudios.com`。此处只记录 SSR 提供的时长和域名；没有下载完整视频、解码或播放验收，不能据此宣称画面已含中文字幕。

可复查的官方公开页面（不含签名参数）：

- [Crowned in Silver Blood，第 1 集](https://www.reelshort.com/episodes/episode-1-crowned-in-silver-blood-6a73e8221ba18f8dcb0e84b9-18e05db7ku)
- [我的小救星，第 1 集](https://www.reelshort.com/zh-TW/episodes/episode-1-%E6%88%91%E7%9A%84%E5%B0%8F%E6%95%91%E6%98%9F-6a71439fb020f89d5f09ecdd-68b4fqhl1m)
- [轉角遇見愛：戀上我的命定狼王，整剧](https://www.reelshort.com/zh-TW/movie/%E8%BD%89%E8%A7%92%E9%81%87%E8%A6%8B%E6%84%9B-%E6%88%80%E4%B8%8A%E6%88%91%E7%9A%84%E5%91%BD%E5%AE%9A%E7%8B%BC%E7%8E%8B-687f01320286ec55d50a79d2)
- [轉角遇見愛：戀上我的命定狼王，第 1 集](https://www.reelshort.com/zh-TW/episodes/episode-1-%E8%BD%89%E8%A7%92%E9%81%87%E8%A6%8B%E6%84%9B-%E6%88%80%E4%B8%8A%E6%88%91%E7%9A%84%E5%91%BD%E5%AE%9A%E7%8B%BC%E7%8E%8B-687f01320286ec55d50a79d2-sjm8k8otag)
- [ReelShort 繁体中文首页](https://www.reelshort.com/zh-TW)

站点 `__NEXT_DATA__` 明确有 `zh-TW` locale。`/zh-TW` 首页能取得中文片单；给上述英文 Crowned in Silver Blood 的同一分集地址加 `/zh-TW` 会跳回英文 locale。它不能证明同一分集具有中文字幕。

公开 episodes 页面脚本中，`book_sub_title` 用于 `movie:episodes-other-movies-desc` 文案拼接，与可按时间显示的字幕轨道无关。没有按这个字段臆造加载器。

agent-reach 网页路由的 Jina Reader 对两官网均返回 HTTP 401，随后改用 Ego 直接访问官网；未把 Reader 失败当官网结论。网页检索未找到能够证明 DramaBox 独立中文字幕格式的一手页面。ReelShort 官方文章介绍英文字幕，也不能证明同分集有公开中文字幕文件。

## 保留边界

不绕过锁定、付费、区域限制；不调用私有接口；不把预告或短预览当完整正片；不把另一本剧的分集绑定当前视频；不返回任意 URL 给渲染层；不放松现有 HTTPS、官方 CDN、TLS 和逐跳来源校验。

真实中文字幕验收仍未完成。若后续官网提供可核实轨道，需要补齐真实 schema、精确分集关联、语言、授权状态与字幕响应验证后才可接入。
