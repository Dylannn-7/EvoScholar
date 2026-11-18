import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessGenome } from '../genome'
import type { Runtime } from '../session'
import { skillNameValid } from '../skills'
import { workflowOperators, type WorkflowOperator } from '../workflow-plan'
import type { BenchCase } from './bench'
import { complete, extractJson } from './complete'
import type { CaseResult } from './runner'

export type Proposal = {
  /** A prompt, tool description, versioned skill, or declared workflow operator. */
  target: string
  diagnosis: string
  bullets: string[]
  cases: string[]
  description?: string
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/** Compact, answer-free evidence about one failed case for the reflector. */
export function dossier(rt: Runtime, c: BenchCase, r: CaseResult): string {
  const task = existsSync(join(r.runDir, 'task.md')) ? readFileSync(join(r.runDir, 'task.md'), 'utf8') : ''
  const events = rt.db
    .prepare(`SELECT type, payload FROM events WHERE session_id = ? AND type IN ('model.finish','tool.result') ORDER BY id`)
    .all(r.sessionId) as { type: string; payload: string }[]
  const steps: string[] = []
  for (const e of events) {
    const p = JSON.parse(e.payload)
    if (e.type === 'model.finish') for (const call of p.calls ?? []) steps.push(`→ ${call.name} ${clip(JSON.stringify(call.arguments), 160)}`)
    else if (p.isError) steps.push(`  ✗ ${clip(String(p.preview ?? ''), 240)}`)
  }
  // Evidence without answers: what the agent actually wrote for each failed file, and the input headers.
  const peek = (f: string, lines = 4) => { try { return clip(readFileSync(f, 'utf8').split('\n').slice(0, lines).join('\n'), 400) } catch { return '（文件不存在）' } }
  const failedFiles = [...new Set(r.failures.map((f) => /^([\w./-]+\.(?:csv|json|md|txt|tex|bib))\b/.exec(f)?.[1]).filter((x): x is string => !!x))]
  const produced = failedFiles.map((f) => `${f}（智能体写出的开头）：\n${peek(join(r.runDir, f))}`).join('\n')
  const inputsDir = join(r.runDir, 'inputs')
  const inputs = existsSync(inputsDir)
    ? readdirSync(inputsDir).filter((f) => /\.(csv|tsv)$/i.test(f)).slice(0, 6).map((f) => `inputs/${f} 表头：${peek(join(inputsDir, f), 1)}`).join('\n')
    : ''
  const answer = (rt.db.prepare(`SELECT answer FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1`).get(r.sessionId) as { answer?: string } | undefined)?.answer ?? ''
  return [
    `### ${c.id}（${c.category}）${c.title}`,
    `任务说明：\n${clip(task, 1800)}`,
    `判分失败项：\n${r.failures.map((f) => `- ${f}`).join('\n') || '（无）'}${r.error ? `\n运行错误：${r.error}` : ''}`,
    ...(produced ? [`相关产物：\n${produced}`] : []),
    ...(inputs ? [`输入数据：\n${inputs}`] : []),
    `工具调用（${r.steps} 步，${r.toolErrors} 次出错）：\n${clip(steps.join('\n'), 2500)}`,
    `最终回复摘要：\n${clip(answer, 600)}`
  ].join('\n\n')
}

const REFLECTOR = `你是 EvoScholar 的「反思器」。EvoScholar 是一个科研智能体，它的行为由一份 harness genome（系统指令、工具描述、技能、路由、工作流）决定。
你会看到它在若干评测任务上失败的证据：任务说明、判分失败项、它实际写出的产物开头、输入数据的表头、工具调用序列和最终回复。你看不到标准答案。
注意：任务说明可能没有逐字规定列名或字段写法，判分却要求与「最自然的写法」一致；对比产物与输入，找出智能体在这类空白处的习惯性偏差（例如自创列名、加多余列）。

请找出**可以推广到同类任务**的失败原因，并提出修改建议。要求：
- 每条建议只改一处。target 可以是 "instructions"（补充经验手册）、"tool:<工具名>"（补充工具说明）、"skill:<技能名>"（蒸馏技能）或 "workflow:<算子>"（改变工作流）。
- 只有提供了已通过的开发集轨迹摘要时，才提出 skill 建议。从成功的工具顺序和检查步骤提炼通用做法，指定已启用技能，或为新技能起一个以 distilled- 开头的英文短名。用 description 说明何时使用该技能。
- workflow 只能选用本轮列出的算子。verify-output 在交付前核对；split-research 让检索和核验分别由两个子代理负责；merge-research 合并成一个子代理；parallel-search 让两个检索分支同时运行。用 diagnosis 说明适用原因。
- bullets 是要加入的条目，1–3 条，每条不超过 80 字，写成可执行的通用规则（例如「输出 JSON 时数值用数字类型，不要加引号」）。
- 禁止出现具体任务编号、具体文件名、具体数值或猜测的答案；禁止建议放宽权限、预算或修改评测。
- 不要重复「当前经验手册」里已有的条目。
- 按预计受益任务数从多到少排序，最多给 3 条建议。

只输出 JSON：{"proposals":[{"target":"instructions","diagnosis":"一句话诊断","description":"技能触发条件（仅技能建议需要）","bullets":["…"],"cases":["受影响任务编号"]}]}`

export function currentPlaybook(text: string): string {
  const m = /## 经验手册\n([\s\S]*?)(\n## |$)/.exec(text)
  return m ? m[1].trim() : ''
}

const CASE_ID = /\b[LDW]\d{2}\b/
export function sanitizeProposals(
  raw: Proposal[], toolNames: string[], knownCases: string[],
  options: { skills?: readonly { name: string }[]; workflows?: readonly WorkflowOperator[] } = {}
): Proposal[] {
  if (!Array.isArray(raw)) return []
  const allowed = (target: string) => {
    const [kind, name, extra] = target.split(':')
    if (extra !== undefined) return false
    if (target === 'instructions') return true
    if (kind === 'tool') return toolNames.includes(name)
    if (kind === 'workflow') return !!options.workflows?.includes(name as WorkflowOperator)
    return kind === 'skill' && !!name && !!options.skills && toolNames.includes('read_skill') && skillNameValid(name) &&
      (options.skills.some((skill) => skill.name === name) || name.startsWith('distilled-'))
  }
  return raw
    .filter((p) => p && typeof p.target === 'string' && allowed(p.target))
    .map((p) => ({
      target: p.target,
      diagnosis: String(p.diagnosis ?? '').slice(0, 300),
      bullets: (Array.isArray(p.bullets) ? p.bullets : []).filter((b) => typeof b === 'string')
        .map((b) => b.trim().replace(/\s+/g, ' ')).filter((b) => b && b.length <= 120 && !CASE_ID.test(b)).slice(0, 3),
      cases: (Array.isArray(p.cases) ? p.cases : []).filter((c) => knownCases.includes(c)),
      ...(p.target.startsWith('skill:') ? { description: typeof p.description === 'string' ? p.description.trim().replace(/\s+/g, ' ').slice(0, 120) : '' } : {})
    }))
    .filter((p) => p.target.startsWith('workflow:') || (p.bullets.length && (!p.target.startsWith('skill:') || (p.description && !CASE_ID.test(p.description)))))
    .slice(0, 3)
}

/** Summarize successful development trajectories without task texts, tool arguments or answers. */
export function distillationEvidence(rt: Runtime, passed: { c: BenchCase; r: CaseResult }[]): string[] {
  const events = rt.db.prepare(`SELECT type, payload FROM events WHERE session_id = ?
    AND type IN ('model.finish','host.skill.read') ORDER BY id`)
  const evidence: string[] = []
  for (const { c, r } of passed) {
    if (c.default_split !== 'development' || !r.pass || r.error || r.toolErrors || r.manualReview.length) continue
    const steps: string[] = []
    for (const row of events.all(r.sessionId) as { type: string; payload: string }[]) {
      const payload = JSON.parse(row.payload)
      const names = row.type === 'host.skill.read' ? [`read_skill(${payload.name})`] : (payload.calls ?? []).map((call: { name: string }) => call.name)
      steps.push(...names.filter((name: string) => /^[\w()-]{1,80}$/.test(name)))
    }
    if (steps.length) evidence.push(`${c.category} · ${r.steps} 步 · ${steps.slice(0, 16).join(' → ')}`)
    if (evidence.length >= 4) break
  }
  return evidence
}

export async function reflect(
  rt: Runtime,
  genome: HarnessGenome,
  failed: { c: BenchCase; r: CaseResult }[],
  signal?: AbortSignal,
  tried: { target: string; diagnosis: string; change: string; reason: string }[] = [],
  dumpDir?: string,
  passed: { c: BenchCase; r: CaseResult }[] = []
): Promise<Proposal[]> {
  const playbook = currentPlaybook(rt.genomes.text(genome.instructions.system))
  const history = tried.length
    ? `\n\n已经试过但没有带来提升的修改（不要重复这些思路，换个角度）：\n${tried.map((t) => `- [${t.target}] ${t.diagnosis}\n  条目：${(JSON.parse(t.change || '[]') as string[]).join('；')}\n  结果：${t.reason}`).join('\n')}`
    : ''
  const evidence = distillationEvidence(rt, passed)
  const workflows = workflowOperators(genome.workflows, genome.tools.enabled)
  const user = `当前经验手册：\n${playbook || '（空）'}${history}

可用工具：${genome.tools.enabled.join(', ')}
已启用技能：${(genome.skills ?? []).map((s) => `${s.name}@v${s.version}`).join(', ') || '无'}
本轮可用工作流算子：${workflows.join(', ') || '无'}
已通过的开发集轨迹（仅工具顺序）：\n${evidence.join('\n') || '无'}

失败任务（${failed.length} 个）：

${failed.map(({ c, r }) => dossier(rt, c, r)).join('\n\n---\n\n')}`
  const ref = genome.routing.roles.reflector ?? genome.routing.roles.main
  const call = (extra = '') => complete(rt, ref, REFLECTOR + extra, user, { category: 'evolution', genomeId: genome.id, signal, maxOutputTokens: 8000 })
  let text = await call()
  if (dumpDir) writeFileSync(join(dumpDir, 'reflector.txt'), text)
  let parsed: { proposals?: Proposal[] }
  try {
    parsed = extractJson(text)
  } catch {
    // Thinking models can spend the output budget on reasoning; ask again, tersely.
    text = await call('\n\n上一次没有输出 JSON。这次少思考，直接输出 JSON。')
    if (dumpDir) writeFileSync(join(dumpDir, 'reflector-retry.txt'), text)
    parsed = extractJson(text)
  }
  return sanitizeProposals(parsed?.proposals ?? [], genome.tools.enabled, failed.map((f) => f.c.id), {
    skills: evidence.length ? genome.skills ?? [] : undefined, workflows
  })
}
