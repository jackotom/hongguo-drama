<!-- 7.8 source and release target; historical credits retained. -->
# 贡献者与问题反馈致谢

7.8 延续公开贡献记录；感谢 [@xiaowangbb](https://github.com/xiaowangbb) 在 [#176](https://github.com/jackotom/hongguo-drama/issues/176) 提供近千条任务、SMB 延迟和主进程 I/O 卡顿证据。详细署名与历史致谢保留在下方。

## 7.5 播放修复特别致谢（2026-11-16）

这次播放恢复最关键的帮助，来自愿意公开代码、复现过程和验证证据的开发者：

- **[@N3urda（NANA）](https://github.com/N3urda)**：维护上游 hongguoTV，提交并组织 [PR #60](https://github.com/N3urda/hongguoTV/pull/60) 的播放恢复发行。
- **ermilylu**：上游纯 Kotlin Android v5 签名核心提交 [`18c37c2`](https://github.com/N3urda/hongguoTV/commit/18c37c2afd0567520135abcae312352542f09083) 及 PR #60 两个提交的公开 Git 作者。其签名实现、合成向量与真实播放验收，为本项目纯 JavaScript 移植提供了直接依据。按公开提交名署名，不推断 GitHub 账号，不展示邮箱。
- **[@WEP-56](https://github.com/WEP-56)**：在 [Issue #162](https://github.com/jackotom/hongguo-drama/issues/162#issuecomment-6915976249) 及时贴出上游 PR 链接，帮助排查转向有效协议。
- **[@alair-s](https://github.com/alair-s)**：提交 [#163](https://github.com/jackotom/hongguo-drama/pull/163)、[#164](https://github.com/jackotom/hongguo-drama/pull/164)，提供 v5/本地模型桥研究和恢复方案；本版采用独立纯 JavaScript 签名路径，未合并其外部 provider 或 SDK。

感谢以上各位把解决问题的过程分享出来，也感谢持续提交代码、报错截图和复现细节的每一位用户。7.5 将这些贡献随源码和安装包保留，发布页另列重点致谢。上游许可、原始作者和既有历史名单全部保留；列名不冒称 PR 原样合并或伪造共同作者。

7.4开放PR致谢：[@j2-cuong](https://github.com/j2-cuong)（[#159](https://github.com/jackotom/hongguo-drama/pull/159) 下载取源重试与剧集筛选）、[@aaaasssddfgh](https://github.com/aaaasssddfgh)（[#152](https://github.com/jackotom/hongguo-drama/pull/152) Windows AMD AMF编码）；[@roytjus](https://github.com/roytjus)（#92、#143）和[@xinbaojian](https://github.com/xinbaojian)（#129）继续列入。列名代表代码提交，不代表PR已原样合并。

7.3本轮公开反馈致谢：[@zzm-note](https://github.com/zzm-note)（[#156](https://github.com/jackotom/hongguo-drama/issues/156) S/D倍速调节建议，采用解决方案1）。以下保留7.2历史核对快照，不将反馈者伪列为代码作者。

7.2本轮公开反馈致谢：[@Zxiaoming90](https://github.com/Zxiaoming90)（#153外置盘）、[@zhangyibin8111](https://github.com/zhangyibin8111)（#150下载与删除）、[@darki2k](https://github.com/darki2k)（#151字幕建议，本轮仅核实来源，尚未实现）。以下保留7.1历史核对快照，不将反馈者伪列为代码作者。

核对日期：2026-11-16。收录本轮开发期间默认分支提交快照的作者，以及冻结时全部开放／已关闭 PR、Issue 的提交账号。历史快照含 264 个提交、10 个 PR、137 个 Issue；本轮回读当前列表返回的13个本仓PR，历史已核实但当前列表未返回的#140及作者继续保留；另列上游PR #60与核心作者。仅展示公开账号与提交编号，不收录邮箱等私人资料。

## 代码提交作者

- [@jackotom](https://github.com/jackotom)：263 个提交。
- [@ZainCheung](https://github.com/ZainCheung)：1 个提交。

## PR 提交者

感谢 11 位提交者提供代码方案（包括当前列表未返回、但已核实的历史 PR #140）。列出 PR 不代表已经合并或原样采用；具体采用情况以代码、提交历史与审查记录为准。

| 账号 | 提交的 PR |
| --- | --- |
| [@aaaasssddfgh](https://github.com/aaaasssddfgh) | [#152](https://github.com/jackotom/hongguo-drama/pull/152) |
| [@anupam-orbis](https://github.com/anupam-orbis) | [#140](https://github.com/jackotom/hongguo-drama/pull/140)（历史已核对，当前列表未返回，保留署名） |
| [@alair-s](https://github.com/alair-s) | [#163](https://github.com/jackotom/hongguo-drama/pull/163)、[#164](https://github.com/jackotom/hongguo-drama/pull/164) |
| [@ceco3000](https://github.com/ceco3000) | [#18](https://github.com/jackotom/hongguo-drama/pull/18) |
| [@j2-cuong](https://github.com/j2-cuong) | [#159](https://github.com/jackotom/hongguo-drama/pull/159) |
| [@jackotom](https://github.com/jackotom) | [#29](https://github.com/jackotom/hongguo-drama/pull/29)、[#88](https://github.com/jackotom/hongguo-drama/pull/88) |
| [@jayeeliu](https://github.com/jayeeliu) | [#61](https://github.com/jackotom/hongguo-drama/pull/61) |
| [@jjay5520](https://github.com/jjay5520) | [#87](https://github.com/jackotom/hongguo-drama/pull/87) |
| [@roytjus](https://github.com/roytjus) | [#92](https://github.com/jackotom/hongguo-drama/pull/92)、[#143](https://github.com/jackotom/hongguo-drama/pull/143) |
| [@xinbaojian](https://github.com/xinbaojian) | [#129](https://github.com/jackotom/hongguo-drama/pull/129) |
| [@ZainCheung](https://github.com/ZainCheung) | [#133](https://github.com/jackotom/hongguo-drama/pull/133) |

## 问题反馈者

感谢以下 82 位用户提交问题、复现材料与功能建议。名单包含历史已关闭的问题；列出账号不代表采纳其全部建议。

| 账号 | 提交的 Issue |
| --- | --- |
| [@96827123](https://github.com/96827123) | [#89](https://github.com/jackotom/hongguo-drama/issues/89) |
| [@adfnaa](https://github.com/adfnaa) | [#123](https://github.com/jackotom/hongguo-drama/issues/123) |
| [@AguoofAlishan](https://github.com/AguoofAlishan) | [#35](https://github.com/jackotom/hongguo-drama/issues/35) |
| [@airwenlee](https://github.com/airwenlee) | [#55](https://github.com/jackotom/hongguo-drama/issues/55) |
| [@allenyip-blip](https://github.com/allenyip-blip) | [#58](https://github.com/jackotom/hongguo-drama/issues/58) |
| [@bigbaibai-luis](https://github.com/bigbaibai-luis) | [#40](https://github.com/jackotom/hongguo-drama/issues/40) |
| [@breadxuqiqi](https://github.com/breadxuqiqi) | [#114](https://github.com/jackotom/hongguo-drama/issues/114) |
| [@buer052594](https://github.com/buer052594) | [#23](https://github.com/jackotom/hongguo-drama/issues/23)、[#116](https://github.com/jackotom/hongguo-drama/issues/116) |
| [@caolixiang](https://github.com/caolixiang) | [#102](https://github.com/jackotom/hongguo-drama/issues/102) |
| [@ccicc-ccicc](https://github.com/ccicc-ccicc) | [#65](https://github.com/jackotom/hongguo-drama/issues/65) |
| [@ceco3000](https://github.com/ceco3000) | [#17](https://github.com/jackotom/hongguo-drama/issues/17) |
| [@ceylog](https://github.com/ceylog) | [#5](https://github.com/jackotom/hongguo-drama/issues/5) |
| [@changyidong](https://github.com/changyidong) | [#127](https://github.com/jackotom/hongguo-drama/issues/127) |
| [@chenchihcu](https://github.com/chenchihcu) | [#52](https://github.com/jackotom/hongguo-drama/issues/52) |
| [@CloudPeakBAI](https://github.com/CloudPeakBAI) | [#60](https://github.com/jackotom/hongguo-drama/issues/60) |
| [@coffeefreehans](https://github.com/coffeefreehans) | [#101](https://github.com/jackotom/hongguo-drama/issues/101) |
| [@darkj2k](https://github.com/darkj2k) | [#69](https://github.com/jackotom/hongguo-drama/issues/69) |
| [@dcxa521gi](https://github.com/dcxa521gi) | [#28](https://github.com/jackotom/hongguo-drama/issues/28) |
| [@diaobugou](https://github.com/diaobugou) | [#147](https://github.com/jackotom/hongguo-drama/issues/147) |
| [@dickyluo](https://github.com/dickyluo) | [#63](https://github.com/jackotom/hongguo-drama/issues/63)、[#67](https://github.com/jackotom/hongguo-drama/issues/67)、[#138](https://github.com/jackotom/hongguo-drama/issues/138) |
| [@eq1024](https://github.com/eq1024) | [#124](https://github.com/jackotom/hongguo-drama/issues/124) |
| [@Freeze7749](https://github.com/Freeze7749) | [#53](https://github.com/jackotom/hongguo-drama/issues/53) |
| [@fzyifeng](https://github.com/fzyifeng) | [#9](https://github.com/jackotom/hongguo-drama/issues/9) |
| [@GGreyCat](https://github.com/GGreyCat) | [#90](https://github.com/jackotom/hongguo-drama/issues/90) |
| [@gugugaga-doro](https://github.com/gugugaga-doro) | [#39](https://github.com/jackotom/hongguo-drama/issues/39)、[#120](https://github.com/jackotom/hongguo-drama/issues/120) |
| [@GuoJiKaiHehe](https://github.com/GuoJiKaiHehe) | [#84](https://github.com/jackotom/hongguo-drama/issues/84)、[#95](https://github.com/jackotom/hongguo-drama/issues/95)、[#139](https://github.com/jackotom/hongguo-drama/issues/139) |
| [@hongminzheng](https://github.com/hongminzheng) | [#83](https://github.com/jackotom/hongguo-drama/issues/83) |
| [@huihui278](https://github.com/huihui278) | [#44](https://github.com/jackotom/hongguo-drama/issues/44)、[#148](https://github.com/jackotom/hongguo-drama/issues/148)、[#149](https://github.com/jackotom/hongguo-drama/issues/149) |
| [@Ifover](https://github.com/Ifover) | [#135](https://github.com/jackotom/hongguo-drama/issues/135)、[#136](https://github.com/jackotom/hongguo-drama/issues/136) |
| [@kanonso](https://github.com/kanonso) | [#79](https://github.com/jackotom/hongguo-drama/issues/79)、[#112](https://github.com/jackotom/hongguo-drama/issues/112) |
| [@ken6678831-man](https://github.com/ken6678831-man) | [#10](https://github.com/jackotom/hongguo-drama/issues/10) |
| [@kingport](https://github.com/kingport) | [#4](https://github.com/jackotom/hongguo-drama/issues/4) |
| [@leo1300177](https://github.com/leo1300177) | [#70](https://github.com/jackotom/hongguo-drama/issues/70) |
| [@licongy](https://github.com/licongy) | [#117](https://github.com/jackotom/hongguo-drama/issues/117) |
| [@lqg5522](https://github.com/lqg5522) | [#98](https://github.com/jackotom/hongguo-drama/issues/98)、[#104](https://github.com/jackotom/hongguo-drama/issues/104)、[#110](https://github.com/jackotom/hongguo-drama/issues/110)、[#111](https://github.com/jackotom/hongguo-drama/issues/111) |
| [@LTRltr](https://github.com/LTRltr) | [#106](https://github.com/jackotom/hongguo-drama/issues/106) |
| [@lzy139822](https://github.com/lzy139822) | [#73](https://github.com/jackotom/hongguo-drama/issues/73) |
| [@macvip](https://github.com/macvip) | [#22](https://github.com/jackotom/hongguo-drama/issues/22)、[#77](https://github.com/jackotom/hongguo-drama/issues/77) |
| [@MaxeWang123](https://github.com/MaxeWang123) | [#25](https://github.com/jackotom/hongguo-drama/issues/25)、[#54](https://github.com/jackotom/hongguo-drama/issues/54) |
| [@midpoint](https://github.com/midpoint) | [#103](https://github.com/jackotom/hongguo-drama/issues/103) |
| [@Mono-dev07](https://github.com/Mono-dev07) | [#119](https://github.com/jackotom/hongguo-drama/issues/119) |
| [@Mrjoker818](https://github.com/Mrjoker818) | [#105](https://github.com/jackotom/hongguo-drama/issues/105)、[#145](https://github.com/jackotom/hongguo-drama/issues/145) |
| [@mydance-wj](https://github.com/mydance-wj) | [#93](https://github.com/jackotom/hongguo-drama/issues/93) |
| [@n2ryx](https://github.com/n2ryx) | [#121](https://github.com/jackotom/hongguo-drama/issues/121) |
| [@Noisercontrollers](https://github.com/Noisercontrollers) | [#13](https://github.com/jackotom/hongguo-drama/issues/13) |
| [@perlist](https://github.com/perlist) | [#107](https://github.com/jackotom/hongguo-drama/issues/107) |
| [@ppsbbs](https://github.com/ppsbbs) | [#21](https://github.com/jackotom/hongguo-drama/issues/21) |
| [@r5kc](https://github.com/r5kc) | [#134](https://github.com/jackotom/hongguo-drama/issues/134) |
| [@RuningLittleSnail](https://github.com/RuningLittleSnail) | [#115](https://github.com/jackotom/hongguo-drama/issues/115) |
| [@Ryan-zyg](https://github.com/Ryan-zyg) | [#46](https://github.com/jackotom/hongguo-drama/issues/46)、[#96](https://github.com/jackotom/hongguo-drama/issues/96) |
| [@ryancq1982](https://github.com/ryancq1982) | [#78](https://github.com/jackotom/hongguo-drama/issues/78) |
| [@s7c6vr9hsh-pixel](https://github.com/s7c6vr9hsh-pixel) | [#42](https://github.com/jackotom/hongguo-drama/issues/42)、[#50](https://github.com/jackotom/hongguo-drama/issues/50)、[#57](https://github.com/jackotom/hongguo-drama/issues/57) |
| [@shara2006](https://github.com/shara2006) | [#14](https://github.com/jackotom/hongguo-drama/issues/14) |
| [@superterry-svg](https://github.com/superterry-svg) | [#66](https://github.com/jackotom/hongguo-drama/issues/66) |
| [@SysuJayce](https://github.com/SysuJayce) | [#31](https://github.com/jackotom/hongguo-drama/issues/31)、[#32](https://github.com/jackotom/hongguo-drama/issues/32)、[#41](https://github.com/jackotom/hongguo-drama/issues/41)、[#100](https://github.com/jackotom/hongguo-drama/issues/100)、[#108](https://github.com/jackotom/hongguo-drama/issues/108) |
| [@sza253](https://github.com/sza253) | [#142](https://github.com/jackotom/hongguo-drama/issues/142) |
| [@Tangkage](https://github.com/Tangkage) | [#49](https://github.com/jackotom/hongguo-drama/issues/49) |
| [@tt555-1](https://github.com/tt555-1) | [#109](https://github.com/jackotom/hongguo-drama/issues/109) |
| [@TTroia](https://github.com/TTroia) | [#59](https://github.com/jackotom/hongguo-drama/issues/59) |
| [@VictorLee2077](https://github.com/VictorLee2077) | [#8](https://github.com/jackotom/hongguo-drama/issues/8)、[#19](https://github.com/jackotom/hongguo-drama/issues/19)、[#26](https://github.com/jackotom/hongguo-drama/issues/26) |
| [@Wan-ZL](https://github.com/Wan-ZL) | [#1](https://github.com/jackotom/hongguo-drama/issues/1)、[#2](https://github.com/jackotom/hongguo-drama/issues/2)、[#3](https://github.com/jackotom/hongguo-drama/issues/3) |
| [@wangfujie](https://github.com/wangfujie) | [#94](https://github.com/jackotom/hongguo-drama/issues/94) |
| [@wgsjjj](https://github.com/wgsjjj) | [#62](https://github.com/jackotom/hongguo-drama/issues/62) |
| [@winddriver](https://github.com/winddriver) | [#20](https://github.com/jackotom/hongguo-drama/issues/20) |
| [@wms888](https://github.com/wms888) | [#6](https://github.com/jackotom/hongguo-drama/issues/6) |
| [@wuhai007007](https://github.com/wuhai007007) | [#33](https://github.com/jackotom/hongguo-drama/issues/33) |
| [@wwxiaoo](https://github.com/wwxiaoo) | [#118](https://github.com/jackotom/hongguo-drama/issues/118) |
| [@xiaobai-chun](https://github.com/xiaobai-chun) | [#91](https://github.com/jackotom/hongguo-drama/issues/91) |
| [@xiaobutx](https://github.com/xiaobutx) | [#132](https://github.com/jackotom/hongguo-drama/issues/132) |
| [@xinbaojian](https://github.com/xinbaojian) | [#126](https://github.com/jackotom/hongguo-drama/issues/126) |
| [@Xinran123757](https://github.com/Xinran123757) | [#75](https://github.com/jackotom/hongguo-drama/issues/75)、[#85](https://github.com/jackotom/hongguo-drama/issues/85)、[#86](https://github.com/jackotom/hongguo-drama/issues/86)、[#128](https://github.com/jackotom/hongguo-drama/issues/128)、[#146](https://github.com/jackotom/hongguo-drama/issues/146) |
| [@xutengyang](https://github.com/xutengyang) | [#11](https://github.com/jackotom/hongguo-drama/issues/11)、[#12](https://github.com/jackotom/hongguo-drama/issues/12)、[#15](https://github.com/jackotom/hongguo-drama/issues/15) |
| [@yetonggo](https://github.com/yetonggo) | [#99](https://github.com/jackotom/hongguo-drama/issues/99)、[#131](https://github.com/jackotom/hongguo-drama/issues/131)、[#137](https://github.com/jackotom/hongguo-drama/issues/137)、[#141](https://github.com/jackotom/hongguo-drama/issues/141) |
| [@yeuemfantasy](https://github.com/yeuemfantasy) | [#122](https://github.com/jackotom/hongguo-drama/issues/122)、[#144](https://github.com/jackotom/hongguo-drama/issues/144) |
| [@yidasanqian](https://github.com/yidasanqian) | [#7](https://github.com/jackotom/hongguo-drama/issues/7)、[#27](https://github.com/jackotom/hongguo-drama/issues/27)、[#30](https://github.com/jackotom/hongguo-drama/issues/30)、[#51](https://github.com/jackotom/hongguo-drama/issues/51)、[#71](https://github.com/jackotom/hongguo-drama/issues/71)、[#72](https://github.com/jackotom/hongguo-drama/issues/72)、[#74](https://github.com/jackotom/hongguo-drama/issues/74) |
| [@yujian0222](https://github.com/yujian0222) | [#113](https://github.com/jackotom/hongguo-drama/issues/113) |
| [@yyyyyy1111wq](https://github.com/yyyyyy1111wq) | [#24](https://github.com/jackotom/hongguo-drama/issues/24) |
| [@ZainCheung](https://github.com/ZainCheung) | [#130](https://github.com/jackotom/hongguo-drama/issues/130) |
| [@zhangyibin8111](https://github.com/zhangyibin8111) | [#43](https://github.com/jackotom/hongguo-drama/issues/43)、[#47](https://github.com/jackotom/hongguo-drama/issues/47)、[#64](https://github.com/jackotom/hongguo-drama/issues/64)、[#76](https://github.com/jackotom/hongguo-drama/issues/76)、[#80](https://github.com/jackotom/hongguo-drama/issues/80)、[#81](https://github.com/jackotom/hongguo-drama/issues/81)、[#97](https://github.com/jackotom/hongguo-drama/issues/97) |
| [@Zhengs2009](https://github.com/Zhengs2009) | [#82](https://github.com/jackotom/hongguo-drama/issues/82) |
| [@zouyelin](https://github.com/zouyelin) | [#16](https://github.com/jackotom/hongguo-drama/issues/16) |
| [@ZZQ2417536071](https://github.com/ZZQ2417536071) | [#36](https://github.com/jackotom/hongguo-drama/issues/36)、[#37](https://github.com/jackotom/hongguo-drama/issues/37)、[#38](https://github.com/jackotom/hongguo-drama/issues/38)、[#45](https://github.com/jackotom/hongguo-drama/issues/45)、[#48](https://github.com/jackotom/hongguo-drama/issues/48)、[#56](https://github.com/jackotom/hongguo-drama/issues/56)、[#68](https://github.com/jackotom/hongguo-drama/issues/68) |

## 历史协作账号

- [@cursoragent](https://github.com/cursoragent)：用户提供的仓库 Contributors 页面截图；当前默认分支提交作者查询未列出该账号，不计入本次代码作者统计。

## 署名说明

本轮公开查询快照随源码及桌面包保存在 `src/native/community-credits.json`；当前查询未返回的历史贡献继续在本文及NOTICE保留。既有上游、组件和算法作者的署名继续保留在 README、NOTICE、THIRD-PARTY-NOTICES.md 及相应许可文件中。

GitHub 仓库右侧 Contributors 由平台根据实际提交历史生成，无法通过这份名单指定。Issue 反馈者和未采用 PR 的作者在此公开致谢，不伪造提交作者、共同作者或合并记录。
