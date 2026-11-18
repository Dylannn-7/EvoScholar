---
name: literature-review
version: 1
description: 文献检索、筛选、合并去重、全文证据提取与引用核验的标准流程。凡是找论文、做综述、整理文献库、核对引用时先读本技能。
---

# 文献工作流

## 1. 先定检索方案再动手
- 把需求拆成：主题词（含英文同义词）、年份范围、文献类型、纳入/排除标准。
- 在 `search_log.md` 里记下每条检索式、来源、日期和命中数；任务要求输出检索日志时必须写。

## 2. 检索
- 英文：`lit_search`，默认多源合并；光电期刊（IEEE、Optica、SPIE）经 crossref 覆盖；会议论文（NeurIPS、ICLR、CVPR）用 dblp / openreview。
- 中文：`web_search` 加 `site:cnki.net` 或 `site:wanfangdata.com.cn`；能拿到用户导出的题录时，优先用 `lit_import`，更可靠。
- 某个来源报 429 或失败：按任务允许的次数重试一次，然后换来源，并在日志里写明「主源限流 → 改用备用源」。
- 只用任务给的本地快照时，不要联网；记录 `source` 为实际使用的文件名。

## 3. 合并去重
- 在 `run_python` 里 `import evoscholar_lit as lit`，用 `lit.merge_records(records)`：按规范化 DOI、arXiv 号（忽略版本）、显式「正式发表版本」字段合并，题名完全一致且第一作者一致、年份相差 ≤1 也视为同一篇。
- DOI 统一用 `lit.normalize_doi`（小写、去掉 https://doi.org/ 前缀和尾部标点）。正式发表 DOI 优先于 arXiv 的 10.48550 DOI。
- 每组保留所有原始记录 ID。

## 4. 筛选
- 逐条对照纳入标准，给出一句理由；证据不足时标「待全文确认」，不要猜。
- 「真实设备 / 现场测量」类标准要看方法部分，仿真研究不算。

## 5. 全文证据
- `pdf_text` 读取带页码的文字；扫描页用 `pdf_page_image` 看图。
- 记录每个数值的出处：`文件名.pdf#page=N`。只有摘要时标 `abstract_only`，相关字段写 null，不要补猜。
- 单位统一后再比较（如 s → ms），并写清指标口径（mean 还是 p95），口径不同的不能直接比较。

## 6. 引用核验（硬约束）
- 写进答案或论文的每一条文献都要能核验：`lit_verify` 结果为 not_found 的条目不得使用；mismatch 要改正字段；retracted 要告知用户。
- 绝不编造 DOI、页码、作者。

## 7. 增量更新
- 合并新旧文献库时，以 DOI 为键；已有条目保留原 id、tags、notes，只更新元数据字段；分别统计新增、更新、未变的条目。
