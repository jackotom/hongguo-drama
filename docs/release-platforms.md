# 三端同步发布规则

从1.1.9开始，每次项目更新统一评估并构建三端：macOS Apple Silicon arm64、macOS Intel x64、Windows x64。使用同一发行版本，分别记录构建、签名、公证、安装和运行验收。

版本按整数段比较，以最近公开版本为基准，只发布严格更高版本；不能从 1.75 回到 1.8。最近一次用户确认的公开版本是 1.80，配置为 1.80.0、标签为 v1.80。源码配置现为 1.81.0，尚未打标签或发布安装包。平台构建号独立递增。未公开测试包不另计版本。具体规则见 [RELEASING.md](RELEASING.md)。

Mac使用匹配架构的Electron、FFmpeg和ffprobe；Developer ID签名、App与DMG均Apple Accepted并装订票据后发布。Windows独立验证安装/启动/媒体处理，不能用Mac或Rosetta结果代替；有任何平台未完成，发布说明必须写明，不能标记全平台完成。

发行资产统一附SHA256、应用对应源码、各平台准确媒体工具对应源码与许可。公开源码不得包含运行数据、密钥、本机路径、测试profiles或备份。不要把更新自动扩大到官网或Issue评论。

从 1.80 起，Mac 同时发布各架构 DMG 和最终签名 App ZIP，以及合并的 latest-mac.yml。Windows 同时发布 NSIS 安装版、latest.yml、便携 EXE/ZIP；安装版支持应用内更新，便携版通过下载页面更新。Windows 当前未签名，必须在发行说明中保持明确。
