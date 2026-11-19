import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './atomic-file'
import { inside } from './tools/sandbox'
import { createHash } from 'node:crypto'
import YAML from 'yaml'
import type { Json } from '@evoscholar/harness'
import { readSkillFile, skillNameValid, type SkillRef } from './skills'
import { validateWorkflows, type WorkflowPlan } from './workflow-plan'

export type Role = 'main' | 'fast' | 'vision' | 'reflector' | 'judge'
export type HarnessGenome = {
  id: string
  parent?: string | null
  createdBy: string
  createdAt?: string
  status: 'candidate' | 'active' | 'archived' | 'rejected'
  note?: string
  instructions: { system: string; stages?: Record<string, string>; compaction?: string }
  skills?: SkillRef[]
  routing: {
    /** Legacy: model refs per role. Since v2 models come from user settings (decision A1). */
    roles?: Partial<Record<Role, string>>
    rules?: { when: { stage?: string }; use: Role }[]
    parameters?: Record<string, Record<string, Json>>
  }
  tools: { enabled: string[]; overrides?: Record<string, { description?: string; defaults?: Record<string, Json> }> }
  workflows?: WorkflowPlan
  budgets: { maxSteps: number; maxOutputTokens: number; timeoutMs?: number; contextBudgetTokens?: number }
}

/** Protected ceilings: evolution may only move budgets downward from here. */
export const PROTECTED_LIMITS = { maxSteps: 60, maxOutputTokens: 16_384, timeoutMs: 20 * 60_000, contextBudgetTokens: 200_000 }

export class GenomeRepo {
  readonly dir: string
  constructor(readonly root: string) {
    this.dir = join(root, 'genomes')
  }
  activeId(): string {
    return readFileSync(inside(this.dir, 'ACTIVE'), 'utf8').trim()
  }
  setActive(id: string): void {
    this.load(id)
    atomicWriteFile(inside(this.dir, 'ACTIVE'), id + '\n')
  }
  list(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort()
  }
  load(id = this.activeId()): HarnessGenome {
    if (!/^g-[\w-]+$/.test(id)) throw new Error('无效的 genome 版本编号')
    const file = inside(this.dir, `${id}.yaml`)
    if (!existsSync(file)) throw new Error(`Genome not found: ${id}`)
    const g = YAML.parse(readFileSync(file, 'utf8')) as HarnessGenome
    validateGenome(g)
    if (g.id !== id) throw new Error('Genome 编号与文件名不一致')
    return g
  }
  save(g: HarnessGenome): void {
    validateGenome(g)
    atomicWriteFile(inside(this.dir, `${g.id}.yaml`), YAML.stringify(g))
  }
  nextId(): string {
    const nums = this.list().map((id) => Number(/^g-(\d+)$/.exec(id)?.[1] ?? -1))
    return `g-${String(Math.max(-1, ...nums) + 1).padStart(4, '0')}`
  }
  /** Manual edit (e.g. switching models in Settings) recorded as a child genome, then activated. */
  deriveManual(patch: (g: HarnessGenome) => void, note: string): HarnessGenome {
    const parent = this.load()
    const child: HarnessGenome = JSON.parse(JSON.stringify(parent))
    child.id = this.nextId()
    child.parent = parent.id
    child.createdBy = 'manual'
    child.createdAt = new Date().toISOString()
    child.status = 'active'
    child.note = note
    patch(child)
    this.save(child)
    parent.status = 'archived'
    this.save(parent)
    this.setActive(child.id)
    return child
  }
  /** Read a prompt reference like "prompts/system@v1.md" (or inline text). */
  text(ref: string | undefined): string {
    if (!ref) return ''
    if (!/^[\w./@-]+\.md$/.test(ref)) return ref
    return readFileSync(inside(this.root, ref), 'utf8')
  }
  /**
   * Behavioural fingerprint: everything that changes what the agent does (prompts, tool
   * descriptions, skills, routing, budgets), excluding metadata such as id/status/note.
   */
  hash(g: HarnessGenome): string {
    const h = createHash('sha256')
    const { instructions, skills, routing, tools, workflows, budgets } = g
    h.update(JSON.stringify({ instructions, skills, routing, tools, workflows, budgets }))
    if (workflows?.review === 'before-final') h.update('workflow-review:v2')
    for (const ref of [instructions.system, instructions.compaction, ...Object.values(instructions.stages ?? {}), ...Object.values(tools.overrides ?? {}).map((o) => o.description)])
      if (ref) h.update(this.text(ref))
    for (const s of skills ?? []) {
      const skill = readSkillFile(this.root, s.name, s.version)
      if (!skill) throw new Error(`缺少已启用的技能 ${s.name} v${s.version}`)
      h.update(skill.raw)
    }
    return h.digest('hex').slice(0, 12)
  }
}

export function validateGenome(g: HarnessGenome): void {
  if (!g?.id || !/^g-[\w-]+$/.test(g.id)) throw new Error('Genome id must look like g-0001')
  if (!g.instructions?.system) throw new Error(`${g.id}: instructions.system is required`)
  if (!g.routing || typeof g.routing !== 'object') throw new Error(`${g.id}: routing is required`)
  if (!Array.isArray(g.tools?.enabled)) throw new Error(`${g.id}: tools.enabled must be a list`)
  if (g.skills && (!Array.isArray(g.skills) || g.skills.some((s) =>
    !s || typeof s.name !== 'string' || !skillNameValid(s.name) || !Number.isSafeInteger(s.version) || s.version < 1
  ) || new Set(g.skills.map((s) => s.name)).size !== g.skills.length)) throw new Error(`${g.id}: invalid skill references`)
  validateWorkflows(g.workflows, g.tools.enabled)
  const b = g.budgets
  if (!b || !Number.isSafeInteger(b.maxSteps) || !Number.isSafeInteger(b.maxOutputTokens)) throw new Error(`${g.id}: budgets missing`)
  for (const k of Object.keys(PROTECTED_LIMITS) as (keyof typeof PROTECTED_LIMITS)[]) {
    const v = b[k]
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 1 || v > PROTECTED_LIMITS[k]))
      throw new Error(`${g.id}: budgets.${k}=${v} exceeds protected limit ${PROTECTED_LIMITS[k]}`)
  }
}

/** Which role a stage uses (genome routing rules). */
export function stageRole(g: HarnessGenome, stage?: string, fallback: Role = 'main'): Role {
  const rule = g.routing.rules?.find((r) => !r.when.stage || r.when.stage === stage)
  return rule?.use ?? fallback
}

export type ModelChoice = {
  /** User settings defaults (settings.json). */
  defaults?: { model?: string; fast?: string; vision?: string }
  /** Model picked for this session in the composer. */
  session?: string
  /** Last resort when nothing is configured. */
  fallback?: string
}

/** Resolve a role to a concrete model ref: session choice → user defaults → legacy genome roles. */
export function modelFor(g: HarnessGenome, role: Role, c: ModelChoice = {}): string {
  const legacy = g.routing.roles ?? {}
  const main = c.session ?? c.defaults?.model ?? legacy.main ?? c.fallback
  if (!main) throw new Error('还没有选择模型：请先在「设置 → 模型与密钥」里接入厂商并选择默认模型')
  if (role === 'main') return main
  if (role === 'vision') return c.defaults?.vision ?? (c.session ? main : legacy.vision ?? main)
  return c.defaults?.fast ?? (c.session ? main : legacy[role] ?? legacy.fast ?? main)
}

/** Legacy helper: model ref for a stage. */
export function roleFor(g: HarnessGenome, stage?: string, fallback: Role = 'main', c: ModelChoice = {}): string {
  return modelFor(g, stageRole(g, stage, fallback), c)
}
