import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from '../atomic-file'
import type { HarnessGenome } from '../genome'
import type { Runtime } from '../session'
import { readSkillFile, saveSkillRevision, skillNameValid } from '../skills'
import { TOOL_FACTORIES, type ToolEnv } from '../tools'
import { mutateWorkflow, type WorkflowOperator } from '../workflow-plan'
import type { Proposal } from './reflect'

/** prompts/system@v3.md -> next free version path (never overwrites an existing file). */
export function nextVersionPath(root: string, ref: string): string {
  const m = /^(.*)@v(\d+)\.md$/.exec(ref)
  const stem = m ? m[1] : ref.replace(/\.md$/, '')
  const dir = dirname(join(root, stem))
  const base = stem.split('/').pop()!
  let max = m ? Number(m[2]) : 0
  if (existsSync(dir)) for (const f of readdirSync(dir)) { const k = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@v(\\d+)\\.md$`).exec(f); if (k) max = Math.max(max, Number(k[1])) }
  return `${stem}@v${max + 1}.md`
}

/** Insert bullets into the "## 经验手册" section (created if missing), deduplicated. */
export function addLessons(prompt: string, bullets: string[]): string {
  const lines = bullets.map((b) => `- ${b.replace(/^[-*]\s*/, '')}`)
  const m = /## 经验手册\n([\s\S]*?)(?=\n## |$)/.exec(prompt)
  if (!m) return `${prompt.trimEnd()}\n\n## 经验手册\n${lines.join('\n')}\n`
  const existing = m[1].trimEnd()
  const fresh = lines.filter((l) => !existing.includes(l.slice(2)))
  return prompt.replace(m[0], `## 经验手册\n${existing}${existing ? '\n' : ''}${fresh.join('\n')}\n`)
}

function toolDescription(rt: Runtime, g: HarnessGenome, name: string): string {
  const o = g.tools.overrides?.[name]?.description
  if (o) return rt.genomes.text(o)
  const f = TOOL_FACTORIES[name]
  return f ? f({} as ToolEnv).description : ''
}

/** Build a candidate genome (status: candidate) that applies exactly one proposal. */
export function mutate(rt: Runtime, base: HarnessGenome, p: Proposal, runId: string): HarnessGenome {
  const g: HarnessGenome = JSON.parse(JSON.stringify(base))
  g.id = rt.genomes.nextId()
  g.parent = base.id
  g.createdBy = `evolution/${runId}`
  g.createdAt = new Date().toISOString()
  g.status = 'candidate'
  g.note = `${p.target}：${p.diagnosis}`.slice(0, 200)
  const write = (ref: string, text: string) => {
    const file = join(rt.ws.root, ref)
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteFile(file, text)
  }
  if (p.target === 'instructions') {
    const ref = nextVersionPath(rt.ws.root, g.instructions.system)
    write(ref, addLessons(rt.genomes.text(base.instructions.system), p.bullets))
    g.instructions.system = ref
  } else if (p.target.startsWith('tool:')) {
    const tool = p.target.slice(5)
    if (!g.tools.enabled.includes(tool)) throw new Error(`工具未启用：${tool}`)
    const prev = base.tools.overrides?.[tool]?.description ?? `prompts/tools/${tool}@v0.md`
    const ref = nextVersionPath(rt.ws.root, prev)
    write(ref, `${toolDescription(rt, base, tool).trimEnd()}\n使用注意：\n${p.bullets.map((b) => `- ${b}`).join('\n')}\n`)
    g.tools.overrides = { ...(g.tools.overrides ?? {}), [tool]: { ...(g.tools.overrides?.[tool] ?? {}), description: ref } }
  } else if (p.target.startsWith('skill:')) {
    const name = p.target.slice(6)
    const existing = g.skills?.find((skill) => skill.name === name)
    if (!skillNameValid(name) || (!existing && !name.startsWith('distilled-')) ||
        !g.tools.enabled.includes('read_skill') || !p.description?.trim() || !p.bullets.length)
      throw new Error(`无效的技能蒸馏建议：${p.target}`)
    const previous = existing && readSkillFile(rt.ws.root, name, existing.version)
    if (existing && !previous) throw new Error(`缺少技能 ${name} v${existing.version}`)
    const body = addLessons(previous?.body ?? `# ${name}`, p.bullets)
    const revision = saveSkillRevision(rt.ws.root, name, p.description, body)
    g.skills = existing ? g.skills!.map((skill) => skill.name === name ? revision : skill) : [...(g.skills ?? []), revision]
  } else if (p.target.startsWith('workflow:')) {
    g.workflows = mutateWorkflow(g.workflows, p.target.slice(9) as WorkflowOperator, g.tools.enabled)
  } else {
    throw new Error(`不支持的变异目标：${p.target}`)
  }
  // Protected fields must be untouched by construction; double-check before saving.
  if (JSON.stringify(g.budgets) !== JSON.stringify(base.budgets) ||
      JSON.stringify(g.routing) !== JSON.stringify(base.routing) ||
      JSON.stringify(g.tools.enabled) !== JSON.stringify(base.tools.enabled))
    throw new Error('变异不得修改受保护字段')
  rt.genomes.save(g)
  return g
}
