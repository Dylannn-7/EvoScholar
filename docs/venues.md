# 目标期刊与会议（已确认，2026-11-18）

用途：稿件规范检查（`manuscript_check`）使用的写作规则包清单。

规则包按「出版方模板族」组织：同一出版方的期刊共用一套基础规则（参考文献格式、图表、结构），每个期刊再覆盖自己的差异（字数、摘要长度、页数、图数、匿名要求）。

| 规则包 | 覆盖的期刊 / 会议 | 依据 |
| --- | --- | --- |
| `optica` | Optica、Optics Express、Optics Letters、Photonics Research | Optica Publishing Group 作者指南与模板 |
| `advanced-photonics` | Advanced Photonics | SPIE 与中国激光杂志社联合出版，单独核对格式 |
| `springer-nature` | Nature Photonics、Light: Science & Applications、Nature Communications、Nature Machine Intelligence | Nature 系列作者指南 |
| `wiley` | Laser & Photonics Reviews | Wiley 作者指南 |
| `acs` | ACS Photonics | ACS 作者指南（ACS 参考文献格式） |
| `science` | Science Advances | AAAS 作者指南 |
| `ieee-journal` | IEEE JSTQE、Journal of Lightwave Technology、IEEE TPAMI、IEEE TNNLS、IEEE TIP | IEEEtran 模板与 IEEE 作者指南 |
| `springer-journal` | IJCV | Springer 期刊模板（sn-jnl） |
| `ml-conference` | NeurIPS、ICML、ICLR | 各会议当年投稿说明与 LaTeX 模板（页数、匿名、checklist） |
| `cvf` | CVPR、ICCV | CVF 投稿说明与模板 |
| `eccv` | ECCV | Springer LNCS 模板与 ECCV 投稿说明 |
| `aaai` | AAAI | AAAI 作者工具包 |
| `ijcai` | IJCAI | IJCAI 作者工具包 |
| `acl` | ACL、EMNLP | ACL Rolling Review 模板与投稿说明 |
| `cn-optics` | 光学学报、中国激光、红外与激光工程、光子学报 | 各刊投稿须知（中国激光杂志社等） |
| `cn-physics` | 物理学报 | 中国物理学会投稿须知 |
| `cn-computing` | 计算机学报、软件学报、自动化学报、电子学报 | 各刊投稿须知 |
| `hust-thesis` | 华中科技大学本科 / 硕士 / 博士学位论文 | rulepacks/hust/source/（校研〔2009〕39 号 + 模板 + 本科办法附件） |
| `gbt7714` | 所有中文期刊与学位论文的参考文献 | GB/T 7714（按学校 / 期刊指定版本） |

## 实施顺序

1. 先做所有包共用的引擎和通用规则（参考文献完整性、图表编号与引用、缩写首次定义、单位与数字、中英文标点、引用真实性）。
2. 再做每个包的基础规则；期刊级差异（字数、页数、摘要长度）用数据表填，不写代码。
3. 优先保证 `hust-thesis`、`gbt7714`、`optica`、`ieee-journal`、`ml-conference`（最常用）完整；其余包至少有参考文献格式与结构规则，缺的条目在报告里提示「请核对目标期刊最新要求」。

## 规则来源要求

- 每条规则注明出处（作者指南网址或模板文件名 + 访问日期）；作者指南每年会变，按年份分版本。
- 拿不到官方说明的条目不写规则，只在报告里提示核对。
