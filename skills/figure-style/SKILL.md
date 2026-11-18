---
name: figure-style
version: 1
description: 科研数据图的出图规范：按目标期刊/会议规则包设置尺寸、字号、字体、配色，坐标轴带单位，矢量导出，出图后自动检查并看预览。凡是画图、改图、按期刊要求出图时先读本技能。
---

# 出图规范

## 1. 先定目标
- 任务或用户指定了期刊 / 会议：用对应规则包。可用：`nature`（含 Nature 子刊）、`ieee`、`optica`、`wiley`、`neurips`、`iclr`、`icml`、`cvpr`。
- 没指定：按通用规范画（下面第 3 节），不要套用某个期刊的数值；需要时问用户投哪里。
- 规则包数值来自作者指南（`rulepacks/figures/<venue>.yaml` 里有出处），不要自己改。

## 2. 标准流程（在 run_python 里）
```python
import matplotlib.pyplot as plt
import evoscholar_fig as F
F.apply_style('nature')                                   # 字体、字号、配色、可编辑文字
fig, ax = plt.subplots(figsize=F.figsize('nature', 'single', aspect=0.75))
...                                                       # 画图
ax.set_xlabel('Wavelength (nm)'); ax.set_ylabel('Transmission (dB)')
fig.tight_layout()
report = F.save(fig, 'fig1', venue='nature')              # 导出 PDF/SVG/PNG + 检查 + 预览
print(F.format_report(report))
```
- 看 `format_report` 的错误和提醒，逐条修正后重新导出。
- **一定要看预览图**：`read_file` 打开 `fig1.preview.png`，检查文字重叠、裁切、图例遮挡数据、刻度过密。
- 已经存在的图文件（别人给的、或用其他程序画的）用 `figure_check` 工具检查，它会返回问题列表和渲染图。
- 任务只要求某种格式时，`formats=('svg',)` 之类只导出要求的格式；默认会多出 PNG 和预览图，不需要时删掉。

## 3. 通用规范（任何期刊都适用）
- 图宽按最终版面宽度画（单栏 / 双栏），不要画大图再缩小，否则字号会变。
- 坐标轴：数值轴必须有标签，写成「量 (单位)」，无量纲量写 (a.u.) 或比例；分类轴可以只写类别。
- 文字：同一张图字号一致，不小于规则包的最小值；文字保持可编辑（PDF 用 TrueType：`pdf.fonttype=42`；SVG 用 `svg.fonttype='none'`），`apply_style` 已设好。
- 配色：用色盲友好配色（默认 Wong 配色），不要红绿对比；多条曲线同时用线型或标记区分，不能只靠颜色；颜色按「类别 → 颜色」的映射指定，不要依赖绘图顺序。
- 去掉背景网格、阴影、3D 效果和装饰元素；保留刻度线。
- 数据图交矢量格式（PDF / SVG / EPS）；照片、显微图像等位图按规则包的 dpi 要求导出。
- 误差棒、阴影带要在图注或图例里写清是什么统计量（样本标准差 SD、标准误 SEM、95% 置信区间），以及 n。
- 图注写在 SVG / PDF 里时，用 `fig.text` 或 `ax.set_title`，内容和数据保持一致。

## 4. 常见坑
- `savefig(bbox_inches='tight')` 会改变图的实际尺寸，按版面宽度出图时不要用；用 `fig.tight_layout()` 或 `constrained_layout=True`。
- 中文标签需要中文字体（例如 `Songti SC`、`Noto Sans CJK SC`），期刊英文图不要混中文。
- 对数坐标的标签写清底数和单位；dB 本身就是单位。
