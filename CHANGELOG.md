# 更新记录 / Changelog

## 0.2.0（2026-11-19）

v2 重构：从「离线评测驱动的进化」改为「循环内自进化」，并重做了工作台。

- **循环内自进化**：经验与偏好记忆（试用 → 生效 → 淘汰，外部来源隔离）、回忆注入、失败信号与强制反思、重复失败拦截、reflect / note_lesson / recall / tune_harness / offer_choices、回答前自检、回合评分与归因；可执行技能（forge_skill / run_skill / patch_skill）、写作规则提案、把会话调整和高分经验沉淀为 genome 候选（经用户批准上线）。
- **模型接入**：四种协议（Chat Completions、Responses、Messages、Gemini），厂商预设按协议预填 Base URL，读取上游原始模型名和思考程度，测试连接；模型移出 genome，由用户设置和会话选择决定。
- **工作台**：图标栏；项目（本地文件夹）与会话；透明会话页与 Claude Code 风格的输入框（模型、思考程度、权限模式、附件、@ 引用）；轨迹、插件、资料空间、用量页面；四种权限模式；界面不使用 emoji。
- **插件**：技能导入（GitHub、zip、文件夹，Agent Skills 格式）、启用停用；26 种出图风格（SciencePlots、tueplots、aquarel、cmcrameri）；集成 K-Dense 的 scientific-visualization、matplotlib、seaborn 技能。
- **粒子背景**：形状和动态随思维链变化（文献、数据、写作、反思、进化、等待确认、交付）。
- **用量**：只统计 token，不再估算费用，不设安全上限。
- **发布**：macOS / Windows 一键安装脚本、`npm run demo` 零成本演示、GitHub Actions（Linux、macOS、Windows）。

## 0.1.0（2026-11-18）

第一版：文献模块、数据与出图、写作规范检查、离线进化（评测 → 反思 → 候选 → 审批）、网页工作台。
