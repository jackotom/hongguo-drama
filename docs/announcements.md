# 远程公告维护

6.0已正式发布，更新摘要已同步；`announcements/normal.json` 保持 `active: false`，未启用普通公告广播。

5.9已正式发布；`announcements/normal.json`的标题和正文已同步正式修复摘要，仍保持 `active: false`，本轮未启用普通公告广播。已有用户的关闭偏好不变。

公告文件托管于现有公共仓库 `jackotom/hongguo-drama` 的 `main` 分支。客户端只读下列固定 HTTPS 地址，无密钥、账号、设备标识或用户资料参数；不接受公告内指定新地址，不跟随重定向。

- 普通：`https://raw.githubusercontent.com/jackotom/hongguo-drama/main/announcements/normal.json`
- 紧急：`https://raw.githubusercontent.com/jackotom/hongguo-drama/main/announcements/emergency.json`

4.0 已正式发布并包含公告功能；3.9 客户端不含此功能，需升级到 4.0。之后维护远程 JSON 即可更新公告，无需每次重新安装。正式发行与验证见 [4.0 说明](release-4.0.md)，发布时间 2026-10-27 18:07（Asia/Shanghai）。

## 编辑、启用和下线

编辑 `announcements/normal.json` 或 `announcements/emergency.json`。只允许四个字段：

```json
{
  "id": "playback-notice-20261027-01",
  "title": "公告标题",
  "body": "纯文本正文，可使用换行。\n可在设置中永久关闭普通或紧急公告，软件升级后仍保持关闭；需要时可手动重新开启。",
  "active": true
}
```

`id` 长度 1–128，只允许英文字母、数字、点、下划线和连字符，首字符必须为英文字母或数字。标题 1–120、正文 1–4000 个 UTF-16 字符，去空白后不能为空；正文可含换行和制表符，标题不可。不能含尖括号（`<`、`>`）、HTML 或其他控制字符。文件须为 UTF-8 合法 JSON，响应至多 32 KiB；额外字段、错误类型、无效 JSON、过长文本都会被静默忽略。`active` 必须为布尔值，只有 `true` 会展示。

启用：填写已核实文案，设置 `active: true`，按仓库现有流程提交到 `main`。下线：设置 `active: false` 后提交。GitHub 缓存和网络会影响实际到达时间，更新文件不会撤回已显示的弹窗。

4.0 公告正文必须包含可在设置永久关闭及升级保持的说明，建议沿用上例措辞。永久关闭指保存的独立通道开关，用户可手动重开；不是仅限当天或当前版本。主控已在 `announcements/normal.json` 正文补齐永久关闭、升级保持及「查看当前公告」说明，本次已读回核对，不修改公告 JSON。

每条新紧急公告必须使用从未发布过的新 ID。改正文、跨天、重启、升级、先下线再启用，都不会重新展示已读的同一 ID。已读记录保存在本机资料中；删除该资料或换到未同步资料的设备，会失去已有已读记录。重复启用旧 ID 不能可靠触达用户；已有紧急占位文件为 `active: false`，不代表当前服务发生故障。普通公告提示可能原因，不能把空响应全部解释为风控。

## 优先级和请求规则

1. 设置页两个总开关独立控制普通、紧急公告，默认都开启，可永久关闭，跨软件升级保留，直到用户手动重新开启。关闭某通道后，自动检查不请求也不展示该通道；已发出的请求不会新增展示，读取期间关掉再打开也会丢弃原检查的迟到响应。
2. 普通公告自动检查每进程最多请求一次，失败不重试。启动前判断普通开关及免提醒状态；免提醒时不请求普通文件。当天免提醒按本机当地日期判断，隔天启动解除；更新前免提醒在相同版本持续有效。两个免提醒均在版本变化后解除，总开关保留。
3. 紧急公告启动检查，前端每 5 分钟调用一次仅紧急检查；主进程共享并发请求，对包括失败在内的尝试设置 5 分钟最小间隔。只轮询紧急通道不会初始化或请求普通通道。显式重新开启会立即发起检查，但仍遵守 5 分钟限流。
4. 紧急公告绕过普通的当天/版本免提醒，但遵守紧急总开关。未读紧急优先返回；已读 ID 永久保存，重启、跨天、升级不重复。首次拉取不会标已读，只有实际交给前端的紧急 ID 才能确认。
5. 前端展示紧急公告时确认已读。30 秒自动消失、关闭按钮只作用于当前弹窗，不写普通免提醒。当天/版本免提醒按钮只设置普通抑制，不会屏蔽未来的新紧急 ID。
6. 设置页「查看当前公告」是主动重新读取入口，紧急优先；不受自动接收开关、普通免提醒或紧急已读限制，不修改开关和免提醒偏好。手动展示紧急公告仍保存已读记录，读取失败或无有效公告显示提示。

请求使用现有 Axios 环境代理策略；启动代理配置失败进入 `proxyStartupFallback` 时不联网。预览版 `IS_PREVIEW` 静默返回无公告。单次请求及总截止时间均最多 6 秒，响应只接受 JSON 或 GitHub Raw 的 `text/plain`，内容必须能解析为上述 JSON。不会执行 HTML、携带公告认证信息、下载更新或读取其他远程地址。

## 前后端契约

```js
window.electronAPI.checkAnnouncements({ urgentOnly: false /* 或 true */ })
// => { announcement: null | { id, title, body, urgent: boolean } }

window.electronAPI.acknowledgeAnnouncement({ id })
// => { success: boolean, error?: string }

window.electronAPI.dismissAnnouncement({ mode: 'day' /* 或 'version' */ })
// => { success: boolean, error?: string }

window.electronAPI.getAnnouncementPreferences()
// => { normalEnabled: boolean, emergencyEnabled: boolean }

window.electronAPI.setAnnouncementPreferences({ normalEnabled: false /* 两字段均可单独省略 */ })
// => { success: boolean, preferences?: { normalEnabled, emergencyEnabled }, error?: string }

const unsubscribe = window.electronAPI.onAnnouncementPreferences(preferences => {})
// 主进程 announcement-preferences-changed，每次保存成功广播完整两个字段。
// 失败不广播；unsubscribe() 移除监听。
```

新 IPC 沿用现有可信主窗口与主 frame 校验。偏好、免提醒及紧急已读均存于资料文件独立顶级 `announcement` 字段，使用 `store.getAnnouncementState()` / `saveAnnouncementState(patch)` 最小增量保存；不会被设置页旧 `settings` 快照覆盖。

前端订阅偏好后应关闭对应当前弹窗：紧急总关闭时清理轮询定时器，重新开启时立即检查并恢复 5 分钟轮询；普通总开关重新开启时执行完整检查。渲染请求期间也要校验最新开关，避免主进程响应发出与开关事件到达之间的竞争。正文按纯文本渲染，不使用 `innerHTML`。紧急显示后调用确认 API，确认失败须展示其错误。

保存沿用现有临时文件、同步落盘和原子替换机制。写失败回滚缓存，保留原设置、任务及播放资料；紧急已读写失败仍在本进程防重复，API 返回错误，重启后可能再次展示。恢复写权限后可再次确认同一已收到的 ID，将内存已读保存。

## 定向验证

公告后端的定向检查命令（本次文档校准不重跑）：

```sh
node --test src/native/app-announcements.test.cjs
```

覆盖抑制前不请求、本地跨天/版本变化、紧急优先及永久去重、错误响应及文本边界、并发与失败限流、总开关持久化及迟到响应、IPC 来源验证及偏好广播、预览/代理保护、设置快照隔离、写失败回滚。网络由确定性请求替身提供，不访问 GitHub。后端 21/21 定向测试通过；真实 React 界面隔离预览已验证两种免提醒按钮、紧急公告绕过普通免提醒、同 ID 不重复、总开关停止检查、保存失败保留原设置，以及约 30 秒自动关闭（实测 29.924 秒）。宽屏和 400px 窄窗均检查过。普通公告已通过 GitHub Raw 实际读取并在本机测试包展示；4.0 正式安装包已发布；紧急公告实网发布尚未验证。

## 本轮审核修复

- 普通请求创建时绑定开关状态，关闭再开启后不接受旧请求的迟到结果；已完成的有效缓存仍可使用，保持每次启动最多一次普通网络读取。
- 公告跟随当前全屏容器，退出全屏后回到普通界面；焦点跟随弹窗，移动容器不重复确认已读，也不重置30秒展示计时。
- 普通开关变化不重置紧急公告的5分钟检查时钟。
- 维护性公告文件由真实服务解析器验证格式，不绑定正文固定措辞。
- 早期审核修复记录：`node scripts/check-announcement-ui.cjs` 当时 4 项通过；真实全屏显示、焦点迁移和不重复提醒也已验证。此数字不是当前完整回归总数。

## 购买说明链接

正文含 `vipai.pro` 的段落（标题和购买说明）整体显示为带下划线的链接，通过现有 `openExternalUrl` 在系统浏览器打开固定的 `https://vipai.pro/`。不会让 Electron 当前页面跳转，也不执行正文中的 HTML。打开失败会在公告内显示提示。GitHub 反馈行在系统浏览器打开反馈网页，邮箱行是点击复制按钮，其余内容继续按文本显示。早期购买链接回归当时 6 项通过；本机测试包原生界面已确认整块链接存在。4.0 正式客户端已发布，尚未验证网站购买流程。

## 4.0 邮箱复制

邮箱改为语义按钮，点击只复制邮箱地址，并显示“邮箱已复制”。复制失败时保留公告并提示手动选中复制；关闭或换公告清空成功状态，迟到结果不会污染新公告。系统外部打开接口仍只接受 HTTP／HTTPS，邮箱不会打开邮件应用。自动提醒、手动查看及当前网页入口保持原有规则。

已有回归记录：179 项单元测试、91 项平台检查通过。x64 包在 Rosetta 下启动并显示 4.0；本机已安装签名、公证并装订的 arm64 4.0，安装期间资料不变，包内源码匹配，已确认最新邮箱复制成功及永久关闭公告正文显示。 正式发布回执见 [4.0 说明](release-4.0.md)；未验证网站购买流程或紧急公告实网发布。
