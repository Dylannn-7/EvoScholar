# 出图规则包

每个 `<venue>.yaml` 描述一个期刊或会议对图的硬性要求，供 `python/evoscholar_fig.py` 的 `apply_style` / `check_figure` / `check_file` 使用。

- **数值只来自作者指南或官方模板**，每个文件的 `sources` 写明出处 URL 和核对日期。指南没写的项留 `null`，检查器会跳过，**不要猜**。
- 规则条文属于受保护内容：进化可以改「怎么画、怎么查」（提示词、技能），不能改这里的数值。
- 单位：长度用 mm，字号用 pt。会议模板的宽度来自样式文件里的 `\textwidth` / `\columnwidth`（1 in = 25.4 mm）。

| 文件 | 适用 | 单栏 / 双栏（mm） |
| --- | --- | --- |
| nature.yaml | Nature 及 Nature 系列子刊（Nature Photonics 等） | 89 / 183 |
| ieee.yaml | IEEE 期刊（JSTQE、JLT、TPAMI 等） | 88.9 / 182 |
| optica.yaml | Optica Publishing Group（Optica、Optics Express、Optics Letters） | 版心 133.4 |
| wiley.yaml | Wiley 期刊通用（Laser & Photonics Reviews 等） | 80–180 |
| neurips.yaml / iclr.yaml | NeurIPS、ICLR（单栏） | 139.7 |
| icml.yaml / cvpr.yaml | ICML、CVPR（双栏） | 82.6 / 171.5、83.3 / 174.6 |
