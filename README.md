# EvoScholar

**一个会自我进化的个人科研工作台。** 接入你自己的模型 API，就能拥有一个会根据你的使用习惯不断改进的科研助理：文献检索、数据处理与出图、论文写作规范检查。

> A self-evolving personal research workbench. Bring your own model API; the agent harness
> (prompts, skills, tool routing, workflows) evolves from your own usage, gated by offline
> evaluation and your approval.

## 特点

- **Harness 层进化**：进化的是一份声明式的 `HarnessGenome`（指令、技能、工具路由、工作流），不改内核代码。每个候选版本先离线评测，再由你审批上线，可以一键回滚。
- **多厂商**：内置 DeepSeek（默认）、OpenAI、Anthropic、Kimi、智谱 GLM、阿里百炼（Qwen）、MiniMax、火山方舟、OpenCode Zen/Go、OpenRouter 预设；任何兼容 Chat Completions / Messages / Responses 协议的端点都可以用「URL + Key」接入。
- **预算硬上限**：付费调用发出前预留额度，并发请求共用同一本账。
- **本地优先**：数据、轨迹和 Key 都只存在你的电脑上。

## 快速开始 / Quick start

需要 Node.js ≥ 22.13 和 Python 3。Requires Node.js ≥ 22.13 and Python 3.

```bash
git clone https://github.com/Dylannn-7/EvoScholar.git
cd EvoScholar
npm ci
npm run build
npm run setup:python
npm test
npm run demo:evolution
```

演示使用本地模拟网关和临时工作区。它会运行三道公开样题，生成待审批的候选，展示改动，最后上线候选并回滚到起始版本。全程无需 API Key，实际费用为 ¥0。

The demo uses a local mock gateway and a temporary workspace. It runs three bundled cases, shows the proposed change, approves the candidate, and rolls back to the original genome. It requires no API key and incurs no API charges.

日常使用时，复制 `.env.example` 为 `.env`，填写 `DEEPSEEK_API_KEY` 后启动工作台。To use a real model, copy `.env.example` to `.env`, set `DEEPSEEK_API_KEY`, and start the workbench.

```bash
npm start                   # http://127.0.0.1:4317
npm run chat                # CLI 对话 / CLI chat
npm run es -- budget        # API 账单 / API spending
```

Web 的「设置 → 进化」与 CLI 的 `es eval`、`es evolve` 默认使用仓库里的公开样题。本地有 `evals/bench.py` 和 `evals/manifest.json` 时，优先使用该评测集。连接真实模型时，这些评测会产生 API 费用。

The web Evolution panel and the `es eval` and `es evolve` commands use the bundled cases by default. A local `evals/bench.py` and `evals/manifest.json` take precedence. Runs against a real model incur API charges.

## 目录

| 路径 | 内容 |
| --- | --- |
| `packages/harness` | aipoch/open-science `agent-harness` 的 fork（未修改，见 `FORK.md`） |
| `packages/core` | 模型网关、预算记账、genome、工具、轨迹记录 |
| `apps/cli` | 命令行入口 |
| `examples/evolution` | 公开进化样题与判分脚本 |
| `genomes/` | 各代 harness genome，`ACTIVE` 指向当前版本 |
| `prompts/` | genome 引用的提示词 |
| `evoscholar.config.json` | 你的受保护设置（预算、厂商端点），进化引擎不能修改 |

## 开发文档

- `docs/HANDOFF.md`：当前进度、架构、决策和后续计划
- `docs/frontend-visual-plan.md`：前端视觉方案
- `CLAUDE.md`：给 Claude Code 的开发约定

## 预算

默认总额 ¥200，分为日常使用 ¥130、进化 ¥40、开发测试 ¥20、预留 ¥10，可以在 `evoscholar.config.json` 里修改。付费请求按本地价格表和模型输出上限预留额度。有用量回执时按实际用量结算，可能已计费但缺少回执时标为估算。进程意外退出时，未结算的预留会继续占用额度。自定义模型费用取决于本地估价，供应商账单以供应商记录为准。

## 致谢与许可

Apache-2.0。`packages/harness` 来自 [aipoch/open-science](https://github.com/aipoch/open-science)（Apache-2.0），详见 `NOTICE`。
