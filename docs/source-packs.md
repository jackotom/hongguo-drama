# 动态取源策略包

## 目标

红果官方入口、版本字段或可用签名族发生变化时，应用可通过签名策略包更新取源顺序、官方 HTTPS 地址、请求字段、启停状态和签名族，无需重新发布安装包。

策略包不是插件系统：

- 不执行远端 JavaScript、Python、原生程序或表达式。
- 不能访问任意主机，只允许 `fqnovel.com` 和 `snssdk.com` 的 HTTPS 地址。
- 不能修改 Cookie、Authorization、Host、Content-Length 等敏感请求头。
- 只允许现有已验证入口：`preload_current`、`video_tab`、`player_b`、`player_a`、`model_0`、`model_1`、`legacy`。
- 不包含账号 Cookie、媒体地址、密钥或下载内容。

## 文件

- `source-packs/hongguo-playback.payload.json`：便于审查的明文策略。
- `source-packs/hongguo-playback.pack.json`：Ed25519 签名的发布包。
- `scripts/source-pack-sign.cjs`：签名工具。
- `src/native/source-pack.js`：验签、版本、持久化和回滚。
- `src/native/source-policy.js`：字段白名单、域名限制和入口排序。
- 客户端持久化原始签名信封，并在每次启动时重新验签；不信任可被本地改写的明文策略缓存。
- 内置包与本地缓存按 `revision` 取较新者；同版本时以内置包为准，确保新版安装包可纠正旧缓存。
- 下载地址按 GitHub Raw、jsDelivr、Fastly jsDelivr 顺序回退；镜像内容仍须通过签名校验。

## 贡献流程

1. 修改 `hongguo-playback.payload.json`。
2. 提升 `revision`，更新时间 `issuedAt`。
3. PR 阶段只要求明文策略通过结构测试和单元测试，贡献者不需要访问签名私钥。
4. 合并前由项目维护者审查并补齐签名包。使用离线私钥执行：

   ```bash
   node scripts/source-pack-sign.cjs
   ```

5. 提交明文、签名包和测试变更；签名包内 payload 必须与明文完全一致。
6. 合并到 `main` 后，客户端在启动或每 6 小时检查一次并验签更新。

私钥不得进入仓库、日志、聊天记录或发布附件。开发者 PR 只提交明文策略和代码；签名由维护者完成。

需要切换备用私钥时，把 payload 的签名内 `keyId` 改为 `standby-2026-11`，并执行：

```bash
SOURCE_PACK_KEY_ID=standby-2026-11 node scripts/source-pack-sign.cjs \
  source-packs/hongguo-playback.payload.json \
  source-packs/hongguo-playback.pack.json \
  "$HOME/Library/Application Support/Hongguo-SourcePack-Signing/standby-private.pem"
```

维护者在合并前运行：

```bash
npm run test:source-pack
```

普通 PR 和分支推送只校验明文结构；`main` 推送会强制校验签名包与明文完全一致，避免维护者漏签。

当前客户端内置主签名公钥和一把离线备用公钥。`keyId` 位于已签名 payload 内并与信封一致，未知密钥或密钥不一致都会拒绝。主私钥和备用私钥必须分别加密离线备份，不得放在同一位置。

回滚会把刚回滚掉的 revision 标记为“禁止自动重装”。后续自动检查不会立即装回；用户手动点击“立即检查”可明确恢复更新。

## 当前支持的字段

- `order`：入口顺序，`0..1000`。
- `enabled`：是否启用。
- `auth`：`v5`、`player` 或 `none`。
- `url`：受支持官方域名下的 HTTPS 地址。
- `values`：最终签名 query 中的受控字符串、数字或布尔字段。
- `body`：请求正文覆盖字段；支持 `biz_param.device_level` 这样的嵌套路径。
- `headers`：仅允许修改 `User-Agent` 和 `Accept`。
- `field21`：V5 签名所需的受控数值字段。

如果上游需要全新算法，而现有 `v5`、`player` 无法表达，必须通过代码审查新增受限签名实现；不得用远端任意代码绕过这一边界。
