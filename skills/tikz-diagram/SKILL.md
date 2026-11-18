---
name: tikz-diagram
version: 1
description: 用 TikZ 画示意图（实验装置、器件结构、流程图、网络结构），编译成 PDF/SVG 并看预览。需要画非数据的示意图时先读本技能；不做 AI 生图。
---

# TikZ 示意图

## 1. 流程
```python
import evoscholar_fig as F
r = F.compile_tikz(r'''
\begin{tikzpicture}[node distance=12mm, >=Stealth]
  \node[draw, rounded corners] (laser) {Laser};
  \node[draw, right=of laser] (mod) {MZM};
  \draw[->] (laser) -- (mod);
\end{tikzpicture}''', 'setup')
print(r)            # ok、pdf、svg、preview、size_mm；失败时看 errors / log_tail
```
- 成功后 `read_file` 打开 `setup.preview.png` 检查。
- 只给 `tikzpicture` 时会自动套 `standalone` 文档（含 amsmath、arrows.meta、positioning、calc、shapes 库）；需要别的宏包用 `preamble=r'\usepackage{...}'`，或直接给完整文档。
- 引擎按 xelatex → lualatex → pdflatex → tectonic 自动选择；中文标签用 xelatex 并加 `\usepackage{xeCJK}`。

## 2. 规范
- 尺寸按目标版面宽度控制（`\resizebox` 会缩放字号，尽量直接用合适的坐标和 `node distance`）。
- 字号与正文图一致；字体保持可编辑（PDF 里是文本）。
- 示意图里的物理量写单位；箭头方向和图注描述一致。
- 把 `.tex` 源文件和 PDF 一起交付，方便以后修改。

## 3. 排错
- `! Undefined control sequence`：缺宏包或库，加到 preamble。
- `! Package tikz Error: Giving up on this path`：坐标或库名拼错。
- 超时：图太复杂或死循环（如 `foreach` 写错），先简化再加细节。
