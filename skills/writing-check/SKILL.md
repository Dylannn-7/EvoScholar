---
name: writing-check
version: 1
description: 稿件写作规范检查：LaTeX / Word / Markdown / PDF 稿件按学校或期刊规则包（华科学位论文、Optica、IEEE、NeurIPS/ICML/ICLR 等）检查结构、编号、引用、格式、页数、匿名，给出带定位的问题清单和批注。检查论文格式、投稿前自查、复查修订稿时先读本技能。
---

# 稿件规范检查

## 1. 先确定检查什么
- 稿件入口：LaTeX 用**主文件**（含 `\documentclass`），工具会沿 `\input` / `\include` 追踪；没被主文件引入的 .tex（旧稿、草稿）不检查，报告里会列出来。Word 用 .docx；页数和 PDF 元数据要用编译后的 PDF。
- 规则包：
  - 华科学位论文 `hust-thesis`，类型 `master` / `doctor` / `undergrad`；
  - 机器学习会议 `ml-conference`，类型 `neurips2026` / `neurips2025` / `icml2026` / `iclr2026`；
  - 期刊 `optica`、`ieee-journal`；其他期刊包目前只有「请核对」提示。
  - 任务给了自己的规则文件（如 venue_rules.md、checklist.json）时，**以任务给的规则为准**，规则包只作补充。
- 不确定投哪里、是什么学位类型时，问用户；不要猜。

## 2. 运行
```
manuscript_check(path='paper/main.tex', packs=['ml-conference'], variant='neurips2026', annotate=true)
```
- 返回问题清单：编号 Fxxx、级别（错误 / 提醒 / 提示）、定位（`文件:行`、`段落 N`、`p.N`）、依据（规则出处和核对日期）。
- 完整结果在 `.evoscholar/checks/<文件名>/report.json`；需要按任务格式输出时，从 JSON 里取字段，不要从文字里猜。
- Python 里也可以直接用：`import evoscholar_write as Wr; doc = Wr.load('main.tex'); rep = Wr.run('main.tex', ['common'])`，`doc.labels / doc.refs / doc.cites / doc.floats / doc.sections / doc.bib` 是解析出的结构，带定位。

## 3. 读报告
- 「错误」基本可以直接采纳；「提醒」「提示」要回到原文看上下文确认，**有疑问就标「待人工确认」，不要硬改**。
- 「请核对」部分是规则包没能核实的要求（例如期刊篇幅、GB/T 7714—2025 细则），原样告诉用户，不要自己编数值。
- 用户说某条有效或是误报，用 `check_feedback(ids=['F003'], verdict='false_positive', note='原因')` 记录（valid / false_positive / unsure）；这些标记会统计成各规则的误报率，用于改进规则。

## 4. 常见任务做法
- **结构检查（LaTeX）**：重复标签报告**后一次**定义的位置；未定义引用报告引用处；图形文件按 `\graphicspath` 和常见扩展名查找。行号从 1 开始，路径相对任务给定的根目录。
- **术语与缩写一致**：以首次定义（「全称 (缩写)」或术语表）为准，找后文用法冲突的句子；报告冲突句和首次定义的位置。
- **页数**：按编译后 PDF 计算各部分起止页（`Wr.pdf_section_pages(pdf, ['References', 'Appendix'])`），正文页数 = 第一个不计页部分开始前的页数；某部分从页面中间开始时，按任务或会议规则的口径计数，没有说明时在结果里写明你的计数口径。
- **匿名检查**：署名、致谢、PDF 元数据作者、可暴露身份的自引表述；只检查实际编译的入口文件。
- **修订稿复查**：以修订稿为准逐条判断旧问题是否已修复；新问题用规则里的编号；定位写修订稿里的标题。
- **披露清单**：逐条在正文、附录、配置文件中找证据；空值、占位符、「见附录」但附录里没有，都算缺失。

## 5. 写回
- `annotate=true`：Word 生成 `*.checked.docx`（批注挂在对应段落），LaTeX 生成带 `% EVO[Fxxx]` 行尾注释的副本；**原稿不改**。
- 用户要求直接修改时，先列出改动清单征得同意，再改副本。
