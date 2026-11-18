import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import YAML from 'yaml'
import type { Json } from '@evoscholar/harness'

export type Role = 'main' | 'fast' | 'vision' | 'reflector' | 'judge'
export type HarnessGenome = {
  id: string
  parent?: string | null
  createdBy: string
  createdAt?: string
  status: 'candidate' | 'active' | 'archived' | 'rejected'
  note?: string
  instructions: { system: string; stages?: Record<string, string>; compaction?: string }
  skills?: { name: string; version: number }[]
  routing: {
    roles: Record<Role, string>
    rules?: { when: { stage?: string }; use: Role }[]
    parameters?: Record<string, Record<string, Json>>
  }
  tools: { enabled: string[]; overrides?: Record<string, { description?: string; defaults?: Record<string, Json> }> }
  workflows?: Record<string, string>
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
    return readFileSync(join(this.dir, 'ACTIVE'), 'utf8').trim()
  }
  setActive(id: string): void {
    this.load(id)
    writeFileSync(join(this.dir, 'ACTIVE'), id + '\n')
  }
  list(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort()
  }
  load(id = this.activeId()): HarnessGenome {
    const file = join(this.dir, `${id}.yaml`)
    if (!existsSync(file)) throw new Error(`Genome not found: ${id}`)
    const g = YAML.parse(readFileSync(file, 'utf8')) as HarnessGenome
    validateGenome(g)
    return g
  }
  save(g: HarnessGenome): void {
    validateGenome(g)
    writeFileSync(join(this.dir, `${g.id}.yaml`), YAML.stringify(g))
  }
  /** Read a prompt reference like "prompts/system@v1.md" (or inline text). */
  text(ref: string | undefined): string {
    if (!ref) return ''
    if (!/^[\w./@-]+\.md$/.test(ref)) return ref
    const file = resolve(this.root, ref)
    if (!file.startsWith(resolve(this.root))) throw new Error('Prompt path escapes workspace')
    return readFileSync(file, 'utf8')
  }
  hash(g: HarnessGenome): string {
    const material = JSON.stringify(g) + this.text(g.instructions.system)
    return createHash('sha256').update(material).digest('hex').slice(0, 12)
  }
}

export function validateGenome(g: HarnessGenome): void {
  if (!g?.id || !/^g-[\w-]+$/.test(g.id)) throw new Error('Genome id must look like g-0001')
  if (!g.instructions?.system) throw new Error(`${g.id}: instructions.system is required`)
  if (!g.routing?.roles?.main) throw new Error(`${g.id}: routing.roles.main is required`)
  if (!Array.isArray(g.tools?.enabled)) throw new Error(`${g.id}: tools.enabled must be a list`)
  const b = g.budgets
  if (!b) throw new Error(`${g.id}: budgets missing`)
  for (const k of Object.keys(PROTECTED_LIMITS) as (keyof typeof PROTECTED_LIMITS)[]) {
    const v = b[k]
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 1 || v > PROTECTED_LIMITS[k]))
      throw new Error(`${g.id}: budgets.${k}=${v} exceeds protected limit ${PROTECTED_LIMITS[k]}`)
  }
}

export function roleFor(g: HarnessGenome, stage?: string, fallback: Role = 'main'): string {
  const rule = g.routing.rules?.find((r) => !r.when.stage || r.when.stage === stage)
  const role = rule?.use ?? fallback
  return g.routing.roles[role] ?? g.routing.roles.main
}
