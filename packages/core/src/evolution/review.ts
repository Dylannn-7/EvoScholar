import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import type { HarnessGenome } from '../genome'
import type { Runtime } from '../session'

export type CandidateRow = {
  genome_id: string
  evolution_run: string
  parent: string
  target: string
  diagnosis: string | null
  change: string | null
  dev_pass: number | null
  dev_total: number | null
  base_dev_pass: number | null
  acc_pass: number | null
  acc_total: number | null
  base_acc_pass: number | null
  cost_cny: number
  status: string
  reason: string | null
  ts: string
}

export type DiffLine = { op: ' ' | '+' | '-'; text: string }
export type CaseDelta = { caseId: string; split: string; base?: boolean; cand?: boolean; baseCost?: number; candCost?: number; failures: string[] }

/** Line diff (LCS); inputs are small (genome YAML, prompts), so O(n·m) is fine. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n')
  const y = b.split('\n')
  const n = x.length
  const m = y.length
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: x[i++] })
    else out.push({ op: '+', text: y[j++] })
  }
  while (i < n) out.push({ op: '-', text: x[i++] })
  while (j < m) out.push({ op: '+', text: y[j++] })
  return out
}

/** Keep only changed lines plus `context` lines around them; gaps become a "…" marker. */
export function compactDiff(d: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array(d.length).fill(false)
  d.forEach((l, k) => { if (l.op !== ' ') for (let t = Math.max(0, k - context); t <= Math.min(d.length - 1, k + context); t++) keep[t] = true })
  const out: DiffLine[] = []
  let gap = false
  d.forEach((l, k) => {
    if (keep[k]) { out.push(l); gap = false }
    else if (!gap) { out.push({ op: ' ', text: '…' }); gap = true }
  })
  return out
}

export const renderDiff = (d: DiffLine[]) => d.map((l) => `${l.op} ${l.text}`).join('\n')

export function listCandidates(rt: Runtime, status?: string): CandidateRow[] {
  const sql = `SELECT * FROM candidates ${status ? 'WHERE status = ?' : ''} ORDER BY ts DESC LIMIT 100`
  return (status ? rt.db.prepare(sql).all(status) : rt.db.prepare(sql).all()) as CandidateRow[]
}

function latestByCase(rt: Runtime, hash: string): Map<string, { pass: boolean; cost: number; split: string; failures: string[] }> {
  const rows = rt.db
    .prepare(`SELECT case_id, split, pass, cost_cny, failures FROM eval_runs WHERE genome_hash = ? AND (error IS NULL OR error NOT LIKE 'budget%') ORDER BY id`)
    .all(hash) as { case_id: string; split: string; pass: number; cost_cny: number; failures: string }[]
  const m = new Map<string, { pass: boolean; cost: number; split: string; failures: string[] }>()
  for (const r of rows) m.set(r.case_id, { pass: !!r.pass, cost: r.cost_cny, split: r.split, failures: JSON.parse(r.failures) })
  return m
}

/** Prompt references whose text a genome depends on, keyed by role ("system", "tool:web_search", …). */
function promptRefs(g: HarnessGenome): Record<string, string> {
  const r: Record<string, string> = { system: g.instructions.system }
  if (g.instructions.compaction) r.compaction = g.instructions.compaction
  for (const [k, v] of Object.entries(g.instructions.stages ?? {})) r[`stage:${k}`] = v
  for (const [k, v] of Object.entries(g.tools.overrides ?? {})) if (v.description) r[`tool:${k}`] = v.description
  return r
}

export type CandidateDetail = {
  candidate?: CandidateRow
  genome: HarnessGenome
  parent?: HarnessGenome
  genomeDiff: DiffLine[]
  promptDiffs: { key: string; from?: string; to: string; diff: DiffLine[] }[]
  cases: CaseDelta[]
  report?: string
}

/** Everything the approval panel needs: genome + prompt diffs against the parent and per-case pass changes. */
export function candidateDetail(rt: Runtime, genomeId: string): CandidateDetail {
  const genome = rt.genomes.load(genomeId)
  const parent = genome.parent ? rt.genomes.load(genome.parent) : undefined
  const candidate = rt.db.prepare(`SELECT * FROM candidates WHERE genome_id = ?`).get(genomeId) as CandidateRow | undefined
  const strip = (g?: HarnessGenome) => {
    if (!g) return ''
    const { id: _i, parent: _p, createdAt: _c, createdBy: _b, status: _s, note: _n, ...rest } = g
    return YAML.stringify(rest)
  }
  const genomeDiff = compactDiff(lineDiff(strip(parent), strip(genome)))
  const promptDiffs: CandidateDetail['promptDiffs'] = []
  const a = parent ? promptRefs(parent) : {}
  const b = promptRefs(genome)
  for (const [key, to] of Object.entries(b)) {
    const from = a[key]
    if (from === to) continue
    const before = from ? rt.genomes.text(from) : ''
    promptDiffs.push({ key, from, to, diff: compactDiff(lineDiff(before, rt.genomes.text(to))) })
  }
  const base = parent ? latestByCase(rt, rt.genomes.hash(parent)) : new Map()
  const cand = latestByCase(rt, rt.genomes.hash(genome))
  const ids = [...new Set([...base.keys(), ...cand.keys()])].sort()
  const cases: CaseDelta[] = ids.map((id) => {
    const x = base.get(id)
    const y = cand.get(id)
    return { caseId: id, split: (y ?? x)!.split, base: x?.pass, cand: y?.pass, baseCost: x?.cost, candCost: y?.cost, failures: y?.failures ?? [] }
  })
  let report: string | undefined
  if (candidate) {
    const row = rt.db.prepare(`SELECT report_path FROM evolution_runs WHERE id = ?`).get(candidate.evolution_run) as { report_path?: string } | undefined
    if (row?.report_path && existsSync(row.report_path)) report = readFileSync(row.report_path, 'utf8')
  }
  return { candidate, genome, parent, genomeDiff, promptDiffs, cases, report }
}

/** Genome lineage for the panel: id, parent, status, note. */
export function lineage(rt: Runtime): { id: string; parent: string | null; status: string; createdBy: string; note: string }[] {
  return rt.genomes.list().map((id) => {
    const g = rt.genomes.load(id)
    return { id, parent: g.parent ?? null, status: g.status, createdBy: g.createdBy, note: g.note ?? '' }
  })
}

export const reportsDir = (rt: Runtime) => join(rt.ws.dataDir, 'evolution')
