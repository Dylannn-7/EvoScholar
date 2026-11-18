# EvoScholar — guidance for Claude Code

Self-evolving personal research workbench (literature search, data processing & figures,
thesis/paper writing checks). The agent harness is a fork of aipoch/open-science's
`agent-harness`; what evolves is the **harness** (a declarative HarnessGenome plus memory,
skills and rule packs), in the agent loop itself — not kernel code.

**Read `docs/PLAN.md` first** — the v2 rebuild plan (confirmed decisions A1–A9, phases P0–P6).
In-loop evolution design: `docs/in-loop-evolution.md` (as amended by PLAN §3).
History and older architecture notes: `docs/HANDOFF.md`. Visual direction: `docs/frontend-visual-plan.md`.

The user is Chinese-speaking: reply, write UI text, prompts and skills in Chinese; code and
commit messages in English. No emoji anywhere in the UI.

## Commands

```bash
npm install && npm run build        # tsc -b for harness, core, cli, server
npm test                            # node:test suites (core + server)
(cd python && python3 -m unittest)  # Python toolkit tests (or data/pyenv-*/bin/python)
npm run setup:python                # per-platform venv: data/pyenv-<platform>-<arch>
npm start                           # web workbench at http://127.0.0.1:4317
npm run es -- <cmd>                 # CLI: chat | ask | budget | providers | genome
npm run es -- ask --category dev --yes --cwd <dir> "<prompt>"   # one-shot, auto-approve tools
npm run demo:evolution              # offline evolution demo (mock gateway, no API key)
```

Evaluation tasks (private, local only; regression guard, not the evolution driver):
`python3 evals/bench.py list | prepare <ID> <dir> | grade <dir>`.

## Hard rules

- **Never commit or publish** `evals/`, `rulepacks/*/source/`, the HUST `.docx`/`.zip`
  files, `.env`, or `data/`. They are git-ignored; keep it that way.
- **Keep `packages/harness/src` byte-identical to upstream.** Extend only via its public
  options (instructions, tools, guards, transformContext, admit, onEvent, store, delegation)
  from `packages/core`. New protocol adapters (e.g. Gemini) live in `packages/core`.
- **Development API spend is real money.** Until the user starts large-scale live testing,
  all staged live tests together stay ≤ ¥20 (baseline 2026-11-19: ¥8.5336 total recorded).
  Use `--category dev`, report spend per phase. Prefer mocked `fetch` / the local mock gateway.
- The product itself has **no money budget and no safety cap** (decision A2): it records token
  usage only. The harness per-turn step limit stays, to stop runaway loops.
- Evolution must never modify `evoscholar.config.json`, permission policy, guards, or raise
  step limits; persisting harness changes to a genome always needs the user's approval.
- Tools stay sandboxed to the session cwd (= the project folder; `inside()`, `checkCommand()`),
  validate their input, and route side effects through `env.approve` (permission modes decide).
- Model-facing child processes never receive `*_API_KEY` env vars (`childEnv`).
- Must work on macOS and Windows: use `node:path`, no shell-specific syntax in tools.
- Every change: `npm run build && npm test` green; add tests for new tools (mock network).
- Commit after the user approves each phase; messages end with the co-author trailer; push
  only when asked.
