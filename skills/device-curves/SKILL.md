---
name: device-curves
version: 1
description: 光电器件特性曲线：I-V（理想因子、串联电阻）、L-I（激光阈值、斜率效率）、光电探测器响应度与外量子效率、暗电流。处理器件测量数据时先读本技能。
---

# 器件特性曲线

## 1. 计算
```python
import evoscholar_data as D
D.li_threshold(I_A, P_W)                       # 阈值（高电流段线性外推到 P=0）、斜率效率 W/A，另给二阶导数法交叉核对
D.diode_ideality(V, I, temperature_k=300, v_range=(0.3, 0.6))   # 理想因子 n、饱和电流
D.series_resistance(V, I)                      # 大电流段 dV/dI
D.responsivity(I_ph_A, P_opt_W, dark_current_a=I_dark)          # A/W
D.quantum_efficiency(R, wavelength_nm)         # 外量子效率 η = R·hc/(qλ)
```
- 先统一单位到 SI（A、W、V）；mA、mW、µW 要换算，结果单位写清。
- 阈值：两种方法差别大时，说明拟合区间并给出两者。
- 理想因子：只在指数区拟合（避开低压漏电和高压串阻区），报告拟合电压范围。
- 响应度要扣暗电流，并写明入射光功率是在哪里测的（光纤端面 / 器件表面）。

## 2. 作图
- I-V：正向用对数 y 轴看指数区；反向漏电用 |I| 的对数。
- L-I：同时画电压（双 y 轴时两侧颜色区分并标单位），标出阈值。
- 多器件 / 多温度：颜色按温度或器件名映射，图例写单位（例如「25 °C」）。
- 出图规范见 `figure-style` 技能。
