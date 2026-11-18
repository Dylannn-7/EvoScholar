---
name: optics-fields
version: 1
description: 电磁场分布数据（Lumerical FDTD / MODE、COMSOL 导出）：读取文本表、散点转网格、画 |E|² 场图、有效模场面积、限制因子。处理仿真导出的场分布、模式图时先读本技能。
---

# 场分布数据

## 1. 读取
```python
import evoscholar_data as D
t = D.read_comsol_table('field.txt')      # COMSOL「导出 > 数据」：% 开头的注释行，最后一行注释是列名
t = D.read_lumerical_table('E.csv')       # Lumerical 文本 / CSV（可带表头）
g = D.grid_from_points(x, y, value)       # 规则网格上的散点 → 二维数组；g['filled'] 是填充率
```
- 先确认坐标单位（m、µm、nm）和场量含义（|E|、|E|²、Ex 实部…）；COMSOL 列名里通常带表达式，如 `emw.normE^2`。
- `filled` 明显小于 1 说明不是规则网格，改用 `scipy.interpolate.griddata` 插值，并说明插值方法。

## 2. 计算
- 有效模场面积：`D.effective_mode_area(x, y, I)`，I = |E|²，结果单位是坐标单位的平方。
- 限制因子：`D.confinement_factor(x, y, I, mask)`，mask 是芯区的布尔网格。
- 归一化：画图前除以最大值，色标写「|E|² (norm.)」。

## 3. 作图
- `pcolormesh(x, y, z, shading='auto')` 或 `imshow(origin='lower', extent=...)`，`ax.set_aspect('equal')` 保持真实比例。
- 用感知均匀的色图（viridis、magma、inferno）；不要用 jet / rainbow。
- 叠加器件轮廓（芯区边界）用细白线或黑线。
- 色标带标签和单位；坐标轴「x (µm)」「y (µm)」。
- 出图规范见 `figure-style` 技能。
