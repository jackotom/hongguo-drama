<!-- 7.1 release target. -->
# 第三方组件许可说明

适用源码版本：红果短剧 7.1（发行候选，尚未公开）；本轮 follow-redirects 升至1.16.3，Windows／Linux媒体构建增加固定nv-codec-headers 12.1.14.0；其余第三方组件保留各自的版本、作者与许可。实际发行状态见 `docs/release-7.1.md`。

7.1采纳anupam-orbis在PR #140提供的实际依赖锁更新：follow-redirects从1.16.1升至1.16.3；本项目另补重定向安全回归。当前正式版为7.0，完整协作记录见 `CONTRIBUTORS.md`。

本软件（红果短剧下载器）使用了以下第三方组件。各组件的版权归其各自作者所有，
本软件对这些组件的使用均遵循其原始许可证。

---

## 运行时依赖

开发分支新增独立 ByteVC2 解码组件 Librempeg，固定提交 `cb1f8f3eef84999e61b27e2d44664858179bc240`。其命令行程序启用 AGPLv3+；许可证、x264 许可及准确对应源码要求见 `build/ffmpeg/LIBREMPEG-NOTICE.txt`。普通编码继续使用原 FFmpeg；本地构建不代表已发行。

6.3开发候选在macOS arm64启用系统VideoToolbox H.264编码，保留x264回退；`scripts/librempeg-videotoolbox-prototype.patch`补齐固定上游版本缺失的内部函数声明，对应源码包同时包含该补丁及完整构建脚本。

7.1高性能转换候选使双Mac Librempeg均支持VideoToolbox H.264编码，Windows／Linux的FFmpeg和Librempeg支持NVIDIA NVENC H.264编码；ByteVC2解码仍在CPU，不能据此宣称GPU硬解或实体NVIDIA已验收。详见`build/ffmpeg/LIBREMPEG-NOTICE.txt`。

| 组件 | 版本 | 许可证 | 项目地址 |
|---|---|---|---|
| Electron | 44.9.1 | MIT | https://github.com/electron/electron |
| React | 18.3.1 | MIT | https://github.com/facebook/react |
| React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| axios | 1.20.0 | MIT | https://github.com/axios/axios |
| follow-redirects（axios依赖） | 1.16.3 | MIT | https://github.com/follow-redirects/follow-redirects |
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
该精简构建提供软件H.264及可选NVIDIA NVENC H.264编码，不包含旧版Gyan essentials包及其额外库。

---

### NVIDIA codec headers（MIT，仅Windows／Linux媒体构建）

- 官方来源：https://github.com/FFmpeg/nv-codec-headers ，版本12.1.14.0，固定提交`1889e62e2d35ff7aa9baca2bceb14f053785e6f1`。
- 源码归档SHA256：`e30d4791fd386de8b5c9f88dec781e546ec148b8808440dd421da5f26c2700ae`；下载和完整性校验见`scripts/prepare-nv-codec-headers.sh`。
- 头文件的每份完整版权与MIT许可保留于随包的`NV-CODEC-HEADERS-LICENSE.txt`；Windows／Linux的FFmpeg和Librempeg对应源码同时包含该许可、固定头文件源码归档及准备脚本。
- 只使用编码接口头文件，不捆绑NVIDIA驱动或运行库；运行时动态加载用户已有驱动。实际可用性须对当前输入试编码出帧，不能以编译含NVENC代替实体GPU验收。

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

6.9 的播放签名 `playback-signature.js` 改编自 N3urda/hongguoTV `7444bb01aec7b0420740103e551c45f1f66101c9` 的 `Argus.kt`（GPL-3.0-only）；其原始归属为 ch6vip/fqapp 的 `rust/src/sign/{argus,simon,ladon,protobuf}.rs`。黄金向量来自同一固定提交的 `PlayerSignTest.kt`。仅播放模型使用真实551 Argus及Ladon，按最终query、实际正文与时间签名；搜索、目录、账号签名和匿名注册协议保留。未移植上游设备持久化、轮换、更大重试预算或权益修改逻辑。详细来源与改动见上述 NOTICE。

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

## libmedia CPU software player (6.1)

- @libmedia/avplayer 1.3.1 and its @libmedia modules: LGPL-3.0-or-later.
- Upstream: https://github.com/zhaohappy/libmedia/tree/152f629d3021fd8013efa464fcb7b55f9fbe7753
- Local decoder/resampler/stretch-pitch Wasm assets come from that exact revision; their SHA256 values are in scripts/software-player-assets.json. No Wasm encoders are included.
- The complete LGPL text is bundled at software/LIBMEDIA-LGPL-3.0.txt. The upstream project contains the sources and build instructions; JavaScript/Wasm resources remain replaceable local files in the application source/build.
- ASS dependencies bundled by upstream (assjs and ass-compiler): MIT. libmedia uses FFmpeg under LGPL 2.1 or later and SoundTouch under LGPL 2.1. See upstream licensing notices and pinned sources.

6.2沿用6.1固定版本的媒体与软件解码组件；本轮仅修复观看记录更新候选和排序。


## ReelShort 公开页面接入（6.3 开发候选）

参考并改编 [wanglinsaputra/Rest-Api-ReelShort](https://github.com/wanglinsaputra/Rest-Api-ReelShort/tree/95d04d04400bcfc4ce2c77583b1b9702d994fc19)，固定提交 `95d04d04400bcfc4ce2c77583b1b9702d994fc19`。
复用搜索、剧集、分集公开页面路径与数据契约，以及首页缺失编号时的精确标题搜索方法。改为直接读取网页 `__NEXT_DATA__.props.pageProps`，避免硬编码 Next.js buildId；保留本项目的公网地址检查、超时、来源身份检查和错误脱敏。不包含 Express 服务、Swagger、解锁接口或第三方中转。

以下 MIT 许可随源码和安装包中的本文件保留。代码许可不代表影视内容的再分发授权。

MIT License

Copyright (c) 2026 Wanglin Saputra

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


## DramaBox 公开网页接入（6.3 开发）

参考并改编 [zuomeizuoyang/shortdrama-player](https://github.com/zuomeizuoyang/shortdrama-player/tree/081e7ee796372f9029724352f769c286052b9007) 的 `overseas/dramabox.py`，固定提交 `081e7ee796372f9029724352f769c286052b9007`，MIT。

使用公开英文 SSR 搜索、浏览、剧集目录及明确解锁集的 MP4 字段；移植为本项目 CommonJS 来源契约，增加完整性、连续索引、语言、来源身份与官方 HTTPS CDN／跳转验证。未复制其下载器、账号或代理配置；不使用15秒预览代替锁定集。生产实现不需要保存签名密钥或匿名令牌。

以下保留原始 MIT 许可全文；代码许可不代表影视作品再分发授权。

MIT License

Copyright (c) 2026 zuomeizuoyang

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
