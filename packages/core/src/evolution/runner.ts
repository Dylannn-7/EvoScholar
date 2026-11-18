import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BudgetError } from '../budget'
import type { BudgetCategory } from '../config'
import type { HarnessGenome } from '../genome'
import { openResearchSession, type Runtime } from '../session'
import type { Bench, BenchCase } from './bench'

export const CASE_PROMPT = '请完成工作目录里 task.md 描述的任务。按要求的文件名和格式输出，完成前检查所有要求的文件都已写好。'
export const PHASE2_PROMPT = '任务进入下一阶段：task.md 已更新，inputs/ 中可能投放了新素材。请在之前工作的基础上完成新阶段的要求，并同步更新输出文件。'

export type CaseResult = {
  caseId: string
  split: string
  pass: boolean
  failures: string[]
  manualReview: string[]
  steps: number
  toolCalls: number
  toolErrors: number
  costCny: number
  durationMs: number
  sessionId: string
  runDir: string
  error?: string
  cached?: boolean
}

type Row = Record<string, unknown>
const toResult = (r: Row): CaseResult => ({
  caseId: String(r.case_id), split: String(r.split), pass: !!r.pass, failures: JSON.parse(String(r.failures)),
  manualReview: JSON.parse(String(r.manual_review ?? '[]')), steps: Number(r.steps), toolCalls: Number(r.tool_calls),
  toolErrors: Number(r.tool_errors), costCny: Number(r.cost_cny), durationMs: Number(r.duration_ms),
  sessionId: String(r.session_id), runDir: String(r.run_dir), error: (r.error as string) ?? undefined, cached: true
})

export function cachedResult(rt: Runtime, hash: string, caseId: string): CaseResult | undefined {
  const r = rt.db
    .prepare(`SELECT * FROM eval_runs WHERE genome_hash = ? AND case_id = ? AND error IS NULL ORDER BY id DESC LIMIT 1`)
    .get(hash, caseId) as Row | undefined
  return r ? toResult(r) : undefined
}

export async function runCase(
  rt: Runtime,
  bench: Bench,
  genome: HarnessGenome,
  c: BenchCase,
  opts: { evolutionRun?: string; baseDir: string; category?: BudgetCategory }
): Promise<CaseResult> {
  const hash = rt.genomes.hash(genome)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const runDir = join(opts.baseDir, genome.id, `${c.id}-${stamp}`)
  mkdirSync(join(opts.baseDir, genome.id), { recursive: true })
  const sessionId = `eval-${genome.id}-${c.id}-${stamp}`
  const t0 = Date.now()
  let error: string | undefined
  let grade = { machine_status: 'fail', failures: [] as string[], manual_review: [] as string[] }
  try {
    await bench.prepare(c.id, runDir)
    const rs = await openResearchSession(rt, { sessionId, genome, category: opts.category ?? 'evolution', cwd: runDir, stage: c.category, title: `评测 ${c.id}` })
    try {
      const r1 = await rs.ask(CASE_PROMPT)
      if (r1.status === 'failed') error = 'run failed'
      if (c.phases === 2) {
        await bench.advance(runDir)
        const r2 = await rs.ask(PHASE2_PROMPT)
        if (r2.status === 'failed') error = 'run failed (phase 2)'
      }
    } finally {
      await rs.dispose()
    }
    grade = await bench.grade(runDir)
  } catch (e) {
    error = e instanceof BudgetError ? `budget: ${e.message}` : (e as Error).message
    try { grade = await bench.grade(runDir) } catch { /* nothing to grade */ }
  }
  const agg = rt.db
    .prepare(`SELECT COALESCE(SUM(steps),0) s, COALESCE(SUM(tool_calls),0) t, COALESCE(SUM(tool_errors),0) e FROM turns WHERE session_id = ?`)
    .get(sessionId) as { s: number; t: number; e: number }
  const cost = (rt.db.prepare(`SELECT COALESCE(SUM(cost_cny),0) c FROM ledger WHERE session_id = ?`).get(sessionId) as { c: number }).c
  const result: CaseResult = {
    caseId: c.id, split: c.default_split, pass: grade.machine_status === 'pass' && !error?.startsWith('budget'),
    failures: grade.failures, manualReview: grade.manual_review, steps: agg.s, toolCalls: agg.t, toolErrors: agg.e,
    costCny: cost, durationMs: Date.now() - t0, sessionId, runDir, error
  }
  rt.db
    .prepare(
      `INSERT INTO eval_runs (evolution_run, genome_id, genome_hash, case_id, split, pass, failures, manual_review, steps, tool_calls,
        tool_errors, cost_cny, duration_ms, session_id, run_dir, error, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(opts.evolutionRun ?? null, genome.id, hash, c.id, c.default_split, result.pass ? 1 : 0, JSON.stringify(result.failures),
      JSON.stringify(result.manualReview), result.steps, result.toolCalls, result.toolErrors, result.costCny, result.durationMs,
      sessionId, runDir, error ?? null, new Date().toISOString())
  if (error?.startsWith('budget')) throw new BudgetError(error.slice(8), 'round')
  return result
}

/**
 * Evaluate a genome on a set of cases. Results for an identical genome hash are reused.
 * Stops (rethrows) on budget exhaustion so partial results are kept.
 */
export async function runSuite(
  rt: Runtime,
  bench: Bench,
  genome: HarnessGenome,
  cases: BenchCase[],
  opts: { evolutionRun?: string; baseDir: string; concurrency?: number; useCache?: boolean; category?: BudgetCategory; onCase?: (r: CaseResult) => void }
): Promise<CaseResult[]> {
  const hash = rt.genomes.hash(genome)
  const results: CaseResult[] = []
  const queue = [...cases]
  let stop: unknown
  const worker = async () => {
    for (let c = queue.shift(); c && !stop; c = queue.shift()) {
      const hit = opts.useCache !== false ? cachedResult(rt, hash, c.id) : undefined
      if (hit) { results.push(hit); opts.onCase?.(hit); continue }
      try {
        const r = await runCase(rt, bench, genome, c, opts)
        results.push(r)
        opts.onCase?.(r)
      } catch (e) {
        stop = e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker))
  if (stop) throw stop
  return results.sort((a, b) => a.caseId.localeCompare(b.caseId))
}

export const passCount = (rs: CaseResult[]) => rs.filter((r) => r.pass).length
export const costOf = (rs: CaseResult[]) => rs.reduce((s, r) => s + (r.cached ? 0 : r.costCny), 0)
