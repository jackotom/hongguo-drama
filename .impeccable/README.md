<!-- 6.9 desktop/Docker release; this directory keeps its existing scope. -->
<!-- 6.7 unified release. -->
# 红果短剧 6.3 设计资料

`design.json` 保存现有配色、字体、间距和布局约定，`surfaces/` 保存页面设计记录。
本目录不定义应用版本；6.3 的运行版本由根目录 `package.json` 提供，为源码／发行目标。登录管理独立成页，APP 观看记录不混入原观看历史页，登录态和网页 Cookie 分离清理。功能与验收边界见 [6.3 说明](../docs/release-6.3.md)。

沿用现有布局：大屏片单铺满可用空间；默认100%缩放，海报大小与用户手动界面缩放独立。

6.5沿用现有设计规范；界面新增中文／English选择，不改变来源内容。

6.6沿用现有设计，增加TV轻量遥控页面；本轮发行跳过新界面测试，实际包状态见[6.6记录](../docs/release-6.6.md)。
