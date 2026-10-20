# 同步发行规则

从 1.1.9 起，一轮更新共用一个版本：Mac Apple Silicon arm64、Mac Intel x64、Windows x64。不得按平台独立跳号。本机未公开测试版不另算发行。
当前规则（自 1.75 起）：版本按主版本、次版本、补丁版本三个整数依次比较，不按小数或字符串排序。以最近公开版本为基准，只发布严格更高版本；例如 `1.74 < 1.75 < 1.76 < 1.100 < 2.0`。不能从 `1.75` 回到 `1.8` 或 `1.9`。展示可省略末尾 `.0`，配置使用 `1.75.0`；平台构建号独立递增，未公开测试包不另计版本。版本比较回归：`node scripts/check-release-version.cjs`。

历史版本曾使用每次增加 0.1 及下列指定例外；后续以以上整数段顺序为准。

1.71 为用户明确指定的例外：从 1.7 增加 0.01，三段配置使用 `1.71.0`。

1.72 同样按本次明确要求增加 0.01，三段配置使用 `1.72.0`。

1.74 按本次明确要求从公开 1.73 增加 0.01，三段配置使用 `1.74.0`。

1.75 的三段配置为 `1.75.0`，GitHub 标签为 `v1.75`。

1.80 为最近一次用户确认并公开的正式版本，三段配置为 `1.80.0`，GitHub 标签为 `v1.80`；它严格高于 1.75。

1.81 的源码配置为 `1.81.0`。本轮只更新代码与校验，不打标签、不创建 GitHub Release。公开下载页仍指向 1.80，直到三端发行验收完成。

| 平台 | 构建入口 | 发布门槛 |
|---|---|---|
| macOS arm64 | npm run build:mac | 对应 arm64 媒体组件、Developer ID、Apple 公证 Accepted、装订验证 |
| macOS x64 | npm run build:mac | 对应 x64 媒体组件、Developer ID、Apple 公证 Accepted、装订验证；另记录 Intel 实机覆盖 |
| Windows x64 | Windows x64 release candidate 工作流 | NSIS 安装 EXE、latest.yml、便携 EXE/ZIP；精确 FFmpeg 对应源码；安装版安装/启动/同版本重装资料保留与便携版媒体窗口冒烟；明确签名状态 |

Windows 工作流只上传 Actions 构建资产，不创建 Release，不改 latest，不覆盖总校验文件。正式版本由统一发行会话汇总三端资产、对应源码和总 SHA256SUMS。
Windows 当前未配置代码签名证书；EXE 必须明确标为未签名。Windows CI 虚拟机验证不等于用户实体电脑、GPU/HEVC、真实平台下载与长期稳定性验收。
若某平台受阻，同版本保留，记录具体缺口及已有资产状态；不得将缺失平台写成已发布，也不得为补平台另跳版本。

## Windows 构建

Ubuntu 24.04 安装 gcc-mingw-w64-x86-64、make、pkg-config 后运行 `bash scripts/build-ffmpeg-source-win.sh BUILD_DIRECTORY 4`。
将 artifacts/bin 内容放入 build/ffmpeg。Windows x64、Node 22.12+ 执行 `npm ci`、`npm run build:portable`，再执行 `npx electron-builder --win nsis --x64 --publish never`。
`node scripts/check-windows-release.cjs` 仅用于一次性 Windows CI：便携 EXE 直接启动、临时用户资料、普通 CC0 花朵视频；不要对用户现有安装运行。
旧 `scripts/setup-ffmpeg.js` 下载 Gyan 7.1 仅保留作历史开发入口，不得用于 1.1.9 正式发行。

发布必须同时提供应用精确源码 ZIP 与 FFmpeg/x264 Windows 完整对应源码 TAR.GZ。不得遗漏 Windows 专用配置、工作流和构建脚本。

用户下载同时提供安装版 EXE、便携 EXE 与便携 ZIP。便携 ZIP 内仅同一份便携 EXE，无需安装；对应源码归档另外提供。安装版支持应用内更新，便携版保留下载页面入口，不使用 NSIS 覆盖便携文件。

## 应用内更新发行门槛

- 固定公开源为 `jackotom/hongguo-drama` GitHub Releases；客户端包不得包含发布令牌。
- Mac 两种架构使用同一份 `latest-mac.yml`，`files` 中分别列出含 `arm64`、`x64` 的 ASCII ZIP 文件名、最终文件 SHA512（base64）及大小。
- 构建产生的 ZIP 只作中间产物。正式更新 ZIP 必须从已完成 Developer ID 签名、Apple 公证与装订的最终 App 重新压缩，然后重算清单摘要；禁止沿用签名前的 ZIP、blockmap 或摘要。DMG 同样完成签名、公证、装订。
- Windows `latest.yml` 仅指向同名 NSIS 安装包，保留 builder 生成的 SHA512、大小和 blockmap；复制上传不得再改名。安装版与便携版共享同一版本和数据格式。
- Windows 尚无代码签名证书。SHA512 只验证下载与官方清单一致，不提供独立的发布者身份保证；不得主动关闭签名校验或声称已签名。
- `node scripts/check-windows-installer.cjs --config` 可本机检查发行配置；不带参数仅允许一次性 GitHub Windows CI，检查安装包元数据、安装启动与同版本重装资料保留。该检查不等于真实跨版本更新验收。
- Draft 中先汇总三端包、更新清单、准确对应源码和总校验文件，检查文件名/摘要/版本一致后统一发布为 latest。旧版 1.75 不具备下载安装能力，需要手动安装一次 1.80；后续版本才使用应用内更新。
