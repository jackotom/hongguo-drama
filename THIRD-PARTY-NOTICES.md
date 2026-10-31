# 第三方组件许可说明

适用源码版本：红果短剧 5.2；以下第三方组件保留各自的版本、作者与许可，本轮未升级依赖。实际发行状态见 `docs/release-5.2.md`。

本软件（红果短剧下载器）使用了以下第三方组件。各组件的版权归其各自作者所有，
本软件对这些组件的使用均遵循其原始许可证。

---

## 运行时依赖

| 组件 | 版本 | 许可证 | 项目地址 |
|---|---|---|---|
| Electron | 44.9.1 | MIT | https://github.com/electron/electron |
| React | 18.3.1 | MIT | https://github.com/facebook/react |
| React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| axios | 1.20.0 | MIT | https://github.com/axios/axios |
| electron-updater | 6.8.9 | MIT | https://github.com/electron-userland/electron-builder |

Electron 打包产物中已包含 Chromium 与 Node.js 的许可声明：

- `LICENSE.electron.txt`
- `LICENSES.chromium.html`

---

## 内置可执行程序

### Windows FFmpeg / FFprobe（GPLv3-or-later）

Windows x64 内置从固定源码编译的 FFmpeg 9.0.2 与 x264 b35605ace3ddf7c1a5d67a2eb553f034aef41d55，位于 `resources/bin/`。
x264 为唯一外部编解码静态库（GPLv2-or-later）；整体构建为 GPLv3-or-later。构建验证 x64 架构与系统 DLL 依赖。
完整 FFmpeg/x264 对应源码、准确构建脚本、配置日志、工具链版本和二进制哈希随 Release 的 Windows 对应源码包提供。
许可全文与来源说明见 `COPYING.GPLv3`、`COPYING.GPLv2`、`LICENSE.md`、`WINDOWS-X264-LICENSE.txt` 和 `WINDOWS-NOTICE.txt`。
该精简构建提供软件 H.264 编码，不包含旧版 Gyan essentials 包及其额外库。

---

### Mac FFmpeg / FFprobe（GPLv3-or-later）

Apple Silicon 包内置从未修改源码编译的 FFmpeg 9.0.2 与 x264 b35605ace3ddf7c1a5d67a2eb553f034aef41d55，文件位于 `Contents/Resources/bin/`。
x264 是唯一非系统静态依赖（GPLv2-or-later），整体构建为 GPLv3-or-later；完整对应源码与准确构建脚本随 Release 提供。
准确来源、版本、构建配置及对应源码要求见 `build/ffmpeg/MACOS-NOTICE.txt`、
`MACOS-VERSIONS.txt` 和 `MACOS-LICENSE.txt`。

## 开发依赖

构建期使用以下工具（不随软件分发）：

| 组件 | 许可证 |
|---|---|
| Vite | MIT |
| electron-builder | MIT |
| @vitejs/plugin-react | MIT |
| concurrently | MIT |
| wait-on | MIT |

---

## 本软件自身

本软件基于上游项目二次开发，整体以 **GNU General Public License v3.0** 发布，
详见仓库根目录的 `LICENSE` 与 `NOTICE`。

## App 片源签名及 Spade 算法

改编自 woshishiq1/drpys，经 N3urda/hongguoTV 的 vendor 源码核对，GPL-3.0。
3.4 的实验性 App 搜索请求复用同一签名实现（GET、hash branch 0），默认关闭。
完整来源与修改说明见 `src/native/licenses/NOTICE.txt`，许可见同目录 `LICENSE.drpys.txt`。

4.0 播放恢复参考 tsukiyo-zero/hongguoTV 的 `388931852ddc614db8b00775a3dc54c5ede6307f`（GPL-3.0-only）。匿名设备注册的 ttEncrypt 和协议字段由该项目 `DeviceRegister.kt` 改编，其原始出处为 charlie901208/HGTV。身份仅存进程内存，不保留设备令牌、账号或 Cookie；当前直接播放模型的适配参考同一提交。详细来源同上。

3.6 的 App 目录复用项目已有签名实现。目录参数、返回结构与官方图片对象的 JPEG 变体参考 [aston314/hongguo-tv 公开实现](https://github.com/aston314/hongguo-tv/tree/d6a75e3d8e014d50904e24813cb23cff9aa9044c)；不使用其中的固定设备或账号身份。目录接口可访问不代表剧集获准再分发，发行包不包含测试剧集媒体。

## 西饭接口参考

独立编写适配器；接口路径核对参考 [Hululu007/drpy-node](https://github.com/Hululu007/drpy-node/tree/295f2b7047e14122d542a7736cb931e81abcf85c)（GPL-3.0）。
未复制其中的会话标识或解锁流程。公开接口可访问不代表作品获得再分发授权；安装包不包含剧集媒体。


## Anime4K-WebGPU

Package: anime4k-webgpu 1.0.0
Project: https://github.com/Anime4KWebBoost/Anime4K-WebGPU

The preview uses its CNNx2M implementation for optional on-device 2x enhancement.

Copyright (c) 2012-2023 Scott Chacon and others

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## electron-updater

The MIT License (MIT)

Copyright (c) 2015 Loopline Systems

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 时间轴弹幕实现来源：dawei233/hongguo-drama

- 项目：https://github.com/dawei233/hongguo-drama
- 固定来源提交：c884fab6c6e36ad38173e251738b9b35f958383f
- 许可：GPL-3.0，沿用来源的许可与作者说明；本项目 LICENSE 的标准 GPL-3.0 正文保持不变。
- 引用范围：分时弹幕请求与签名、分页解析和缓存、时间轴投放模型、弹幕来源切换及相应测试。文件内保留来源说明，复用本项目已有 SM3 实现。
- 2.9 在本项目现有 2.8 修复之上移植相关模块，并非用该 fork 的旧版本整体覆盖。
- 来源接口不是官方开放平台，也不代表获得平台授权；接口变动可能使获取失效。
