# EvoScholar

**一个会自我进化的个人科研工作台。** 接入你自己的模型 API，就能拥有一个会根据你的使用习惯不断改进的科研助理：文献检索、数据处理与出图、论文写作规范检查。

> A self-evolving personal research workbench. Bring your own model API; the agent harness
> (prompts, skills, tool routing, workflows) evolves from your own usage, gated by offline
> evaluation and your approval.

## 特点

- **Harness 层进化**：进化的是一份声明式的 `HarnessGenome`（指令、技能、工具路由、工作流），不改内核代码。每个候选版本先离线评测，再由你审批上线，可以一键回滚。
- **多厂商**：内置 DeepSeek（默认）、OpenAI、Anthropic、Kimi、智谱 GLM、阿里百炼（Qwen）、MiniMax、火山方舟、OpenCode Zen/Go、OpenRouter 预设；任何兼容 Chat Completions / Messages / Responses 协议的端点都可以用「URL + Key」接入。
- **预算硬上限**：每次模型和工具调用都实时记账，到达上限前就拦截请求。
- **本地优先**：数据、轨迹和 Key 都只存在你的电脑上。

## 快速开始

需要 Node.js ≥ 22.13。

```bash
git clone https://github.com/<you>/EvoScholar.git && cd EvoScholar
cp .env.example .env        # 填入 DEEPSEEK_API_KEY
npm install && npm run build
npm run es -- providers     # 查看厂商与 Key 状态
npm run chat                # 开始对话
npm run es -- budget        # 查看花费
```

## 目录

| 路径 | 内容 |
| --- | --- |
| `packages/harness` | aipoch/open-science `agent-harness` 的 fork（未修改，见 `FORK.md`） |
| `packages/core` | 模型网关、预算记账、genome、工具、轨迹记录 |
| `apps/cli` | 命令行入口 |
| `genomes/` | 各代 harness genome，`ACTIVE` 指向当前版本 |
| `prompts/` | genome 引用的提示词 |
| `evoscholar.config.json` | 你的受保护设置（预算、厂商端点），进化引擎不能修改 |

## 预算

默认总额 ¥200，分为日常使用 ¥130、进化 ¥40、开发测试 ¥20、预留 ¥10，可以在 `evoscholar.config.json` 里修改。价格表见 `packages/core/src/pricing.ts`；未知模型按保守价估算。

## 致谢与许可

Apache-2.0。`packages/harness` 来自 [aipoch/open-science](https://github.com/aipoch/open-science)（Apache-2.0），详见 `NOTICE`。
