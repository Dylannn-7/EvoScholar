---
name: ml-curves
version: 1
description: 训练 / 验证曲线：多随机种子对齐与均值 ± 标准差阴影带、平滑、对数坐标、多方法对比。画 loss / accuracy / learning curve 时先读本技能。
---

# 训练曲线

## 1. 对齐与聚合
```python
import evoscholar_data as D
agg = D.aggregate_curves([(steps_seed1, vals1), (steps_seed2, vals2)])   # 公共步数网格上的 mean、sample_sd、n
smooth = D.ema(values, alpha=0.1)                                         # 指数平滑（带偏差校正）
```
- 不同种子的记录步数不一致时，插值到公共网格，不外推。
- 平滑只用于展示：图上同时画浅色原始曲线，或在图注写明平滑系数；数值结论用未平滑的数据。

## 2. 画法
- 均值画实线，阴影带写明是 ±SD 还是 ±SEM，并标 n（种子数）。
- 损失跨数量级时用对数 y 轴；横轴写「Step」或「Epoch」，与日志口径一致。
- 多方法对比：颜色按方法名映射，同时用线型区分；图例放在不遮挡曲线的位置。
- 标出最终选用的检查点（例如验证集最优），并说明选择规则。
- 出图规范见 `figure-style` 技能。
