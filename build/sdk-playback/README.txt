macOS SDK 播放取源执行文件

该目录由 scripts/build-sdk-playback-mac.sh 生成，不属于通用 npm 依赖。
当前已验证 macOS arm64。x64、Windows 和 Linux 尚未构建或验收。

参考修复来源：
https://github.com/waligoraamodio288-rgb/hongguo-desktop-releases/releases/tag/v1.0.137

构建脚本优先使用 `scripts/sdk-playback/vendor/phone_account` 中的固定对应源码子集；
该子集来自此前已通过旧摘要校验的固定第三方源码归档。远端归档当前摘要已变化，
脚本不会再自动接受新内容。
执行文件只接收分集编号与本地缓存目录，返回播放模型和该请求使用的 User-Agent；
不读取账号 Cookie，不向应用日志写入媒体地址或解密密钥。
