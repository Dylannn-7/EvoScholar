# EvoScholar — guidance for Claude Code

Self-evolving personal research workbench (literature search, data processing & figures,
thesis/paper writing checks). The agent harness is a fork of aipoch/open-science's
`agent-harness`; what evolves is a declarative **HarnessGenome**, not kernel code.

**Read `docs/HANDOFF.md` first** — it has the full state, architecture, decisions, and the
remaining day-by-day plan (Day 4 → Day 7). UI visual direction: `docs/frontend-visual-plan.md`.

The user is Chinese-speaking: reply, write UI text, prompts and skills in Chinese; code and
commit messages in English.

## Commands

```bash
npm install && npm run build        # tsc -b for harness, core, cli, server
npm test                            # node:test suites in packages/core/dist/*.test.js
(cd python && python3 -m unittest)  # Python literature toolkit tests
npm run setup:python                # per-platform venv: data/pyenv-<platform>-<arch>
npm start                           # web workbench at http://127.0.0.1:4317
npm run es -- <cmd>                 # CLI: chat | ask | budget | providers | genome
npm run es -- ask --category dev --yes --cwd <dir> "<prompt>"   # one-shot, auto-approve tools
```

Evaluation tasks (private, local only): `python3 evals/bench.py list | prepare <ID> <dir> | grade <dir>`.

## Hard rules

- **Never commit or publish** `evals/`, `rulepacks/*/source/`, the HUST `.docx`/`.zip`
  files, `.env`, or `data/`. They are git-ignored; keep it that way.
- **Keep `packages/harness/src` byte-identical to upstream.** Extend only via its public
  options (instructions, tools, guards, transformContext, admit, onEvent, store, delegation)
  from `packages/core`. See `packages/harness/FORK.md`.
- **API budget is real money (¥200 total for the whole project).** Any live test you run
  must use `--category dev` (cap ¥20; ~¥0.20 used so far). Prefer offline tests with a
  mocked `fetch` or a local mock gateway (see HANDOFF §7). Evolution rounds: category
  `evolution`, ≤ ¥2 per round, off-peak only (`isDeepSeekPeak()` false).
- `evoscholar.config.json` and genome fields `budgets`/guards are **protected**: the
  evolution engine must never modify them; budgets may only go down (`PROTECTED_LIMITS`).
- Tools must stay sandboxed to the session cwd (`inside()`, `checkCommand()`), validate
  their input, and route side effects through `env.approve` (undefined = unattended eval).
- Model-facing child processes never receive `*_API_KEY` env vars (`childEnv`).
- Every change: `npm run build && npm test` green; add tests for new tools (mock network).
- Commit messages end with the co-author trailer used in history; push only when asked.
