---
name: ml-results
version: 1
description: 机器学习实验结果汇总：解析日志、按方法/数据集聚合多随机种子结果（均值 ± 样本标准差、置信区间）、显著性检验、生成 booktabs 表格和结果图。整理实验结果、做对比表、报统计显著性时先读本技能。
---

# 实验结果汇总

## 1. 收集
- 结构化结果（CSV / JSON）直接读；日志用 `D.parse_log_metrics(text, keys=['acc', 'loss'])` 抽取 `key=value` / `key: value`。
- 记录每条结果的方法、数据集、随机种子、检查点（最后一个 / 最好的），口径要统一，并在说明里写清。

## 2. 统计
```python
import evoscholar_data as D
D.summarize(values)                    # n、mean、sample_sd（分母 n−1）、sem、ci95
D.summarize_by(df, 'method', 'score')  # 分组汇总，按组名排序
D.compare(a, b)                        # Welch t 检验 + Mann-Whitney + Cohen's d
D.compare(a, b, paired=True)           # 同一组种子 / 同一批数据：配对 t + Wilcoxon
D.holm(pvalues)                        # 多重比较校正
```
- 「±」后面写的是什么必须说明：样本标准差（SD）、标准误（SEM）还是 95% CI。默认用样本标准差并注明 n。
- 种子数 < 3 时不做显著性检验，只报原始值。
- 绝对提升和相对提升分开写：绝对 = 新 − 旧；相对 = (新 − 旧) / 旧。百分点（pp）和百分比（%）不要混用。

## 3. 表格
```python
tex = D.booktabs(rows, [('method', 'Method'), ('acc', 'Acc. (%)')], bold_best={'acc': 'max'}, caption='...', label='tab:main')
```
- 单元格传 `{'mean': m, 'sd': s}` 会排成 `m ± s`；最好的结果加粗（越小越好的指标用 `'min'`）。
- 小数位数全表一致；表头写单位。

## 4. 图
- 柱状 / 点图 + 误差棒：读 `figure-style` 技能；误差棒统计量写进图注。
- 多种子曲线：读 `ml-curves` 技能。
