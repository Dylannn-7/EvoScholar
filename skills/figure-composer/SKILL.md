---
name: figure-composer
version: 1
description: 多面板组图：布局、统一配色与图例、面板标注 a/b/c 或 (a)(b)、共享坐标轴、导出可编辑矢量图并保存生成脚本。画两个及以上子图、拼版、跨面板对比时先读本技能。
---

# 多面板组图

## 1. 布局
- 先算总尺寸：`F.figsize(venue, 'double', aspect=...)`，再用 `plt.subplots(nrows, ncols, figsize=..., constrained_layout=True)` 或 `GridSpec` 分配。
- 需要不同宽度的面板用 `gridspec_kw={'width_ratios': [2, 1]}`。
- 同一量纲的面板用 `sharex` / `sharey`，减少重复刻度标签。

## 2. 跨面板一致
- **颜色按名字映射**：先建 `colors = {'方法A': '#0072B2', ...}`（任务给了调色板就照用），每个面板都按名字取色。各面板的数据行序不同也不会错色。
- 图例只放一次（放在最上方或最右侧面板外），或者每个面板直接标注曲线。
- 每个面板标题写「指标 (单位)」或用 y 轴标签说明，面板之间指标不同时尤其要写清。

## 3. 面板标注
```python
F.panel_labels(fig, venue='nature')   # Nature：8 pt 加粗小写 a, b, c；IEEE/Optica：(a), (b)
```
- 标注顺序：先行后列（从左到右、从上到下），与图注一致。

## 4. 导出与脚本
- 生成脚本保存成文件（例如 `make_figure.py`），脚本里完成读数据 → 画图 → 导出全部格式，`python make_figure.py` 一次运行即可复现。
- 先把脚本写成文件，再用 `run_python` 执行这个文件，确保交付的脚本就是实际跑过的版本。
- 导出 SVG 和 PDF 时文字保持可编辑（`apply_style` 已设置）；导出后用 `figure_check` 或 `F.save` 的报告检查，并看预览图。
- 交付前核对：每个面板都有标注、坐标轴有单位、颜色映射与给定调色板一致（十六进制大小写按任务要求）。
