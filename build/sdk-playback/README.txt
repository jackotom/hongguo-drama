macOS 与 Windows x64 SDK 播放取源执行文件

该目录由 `scripts/build-sdk-playback-mac.sh`（macOS arm64 / x64）或
`scripts/build-sdk-playback-win.ps1`（Windows x64）生成，不属于通用 npm 依赖；构建中间目录
（虚拟环境、PyInstaller 工作目录、源码归档）写入 `build/sdk-playback-work/`，本目录只保留
随包发布的执行文件。
8.1 已验证 macOS arm64 与 x64；8.2 源码目标补充 Windows x64 构建脚本与工作流
（`win32-x64/hongguo-sdk-playback.exe`，待 Windows CI 构建与真实验收）。Linux 尚未构建执行文件，继续使用官方接口与公开片源回退。

参考修复来源：
https://github.com/waligoraamodio288-rgb/hongguo-desktop-releases/releases/tag/v1.0.137

构建脚本优先使用 `scripts/sdk-playback/vendor/phone_account` 中的固定对应源码子集；
该子集来自此前已通过旧摘要校验的固定第三方源码归档。远端归档当前摘要已变化，
脚本不会再自动接受新内容。
执行文件只接收分集编号与本地缓存目录，返回播放模型和该请求使用的 User-Agent；
不读取账号 Cookie，不向应用日志写入媒体地址或解密密钥。
