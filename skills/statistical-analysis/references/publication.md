# 定稿数据图

1. 以 `raw_data/` 为只读输入。写可直接执行的 Python 脚本到 `processed/plot_figX.py`。以项目相对路径读取数据，以参数控制目标期刊或栏宽。需要缓存时写入 `processed/`，按原始输入和影响计算的参数校验缓存，确保清空缓存也能重跑。
2. 用 `evoscholar_styles.use(样式, venue=规则包)` 配置样式，再用 `evoscholar_fig.figsize(规则包, 栏数)` 建图。只有区间或未指定期刊时用实际排版宽度，换算成英寸。用 `layout='constrained'` 为图例、子图和色标留空间。曲线用不同线型或标记编码，热图用亮度有序的色图。
3. 在脚本内准备可序列化的分析记录。必填 `inputs`（项目相对路径）和 `processing`（滤波、归一化、排除、插值等实际步骤及参数，原样使用也注明）。按需增加 `sampling_unit`、`uncertainty`、`n`、`statistics`、`fit` 与随机种子。记录值应来自本次运行，无法估计的量用 JSON `null`。
4. 调用 `F.save_publication(fig, 'figures/figX', script=__file__, analysis=log, venue='nature', columns='single')`。有自定义排版宽度时用 `target_width_mm` 代替 `columns`。助手可用 `F.format_report` 查看问题。这个方法检查实际 PDF，再导出同一文件的 PNG 预览、脚本副本和 JSON 分析日志。检查报错时修正脚本后重跑。
5. 用 `run_python` 执行保存好的脚本，传 `publication: true`，在 `deliverables` 里列出 `figures/figX.pdf`、`figures/figX.preview.png`、`figures/plot_figX.py`、`figures/figX.analysis.json`，以及需要保留的缓存。这条路径要求 Linux 容器，原始数据挂载为只读，仅回写所列文件。使用更新后的沙箱镜像。
6. 对 PDF 运行 `figure_check` 并带同一规则包及栏宽，查看实际渲染中的裁切、图例遮挡、子图对齐、色标和刻度。发现问题时改脚本并重跑。当前模型无法看图时，将视觉检查标为待核对。交付时给出从项目根目录重跑脚本的命令与所需 EvoScholar Python 环境。
