import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BudgetError } from '../budget'
import { withTransaction } from '../db'
import { modelFor, type HarnessGenome } from '../genome'
import { isDeepSeekPeak } from '../pricing'
import { endpointFor, parseModelRef } from '../providers'
import type { Runtime } from '../session'
import { Bench, type BenchCase } from './bench'
import { mutate } from './mutate'
import { reflect, type Proposal } from './reflect'
import { candidateVerification } from './review'
import { passCount, runSuite, type CaseResult } from './runner'

export type EvolveOptions = {
  maxCandidates?: number
  capCny?: number
  force?: boolean
  /** Resume the baseline of an interrupted round with the same ledger and cache. */
  resumeBaselineRunId?: string
  /** Compare one candidate even if every development case already passes. */
  testCandidateOnPerfectBaseline?: boolean
  concurrency?: number
  dryRun?: boolean
  /** Re-run flipped cases once more on both genomes before judging (default true). */
  confirmFlips?: boolean
  onProgress?: (msg: string) => void
  signal?: AbortSignal
}

export type CandidateSummary = {
  genome: string
  target: string
  diagnosis: string
  bullets: string[]
  devPass: number
  basePass: number
  devTotal: number
  regressions: string[]
  fixes: string[]
  accPass?: number
  baseAccPass?: number
  accTotal?: number
  status: 'pending' | 'discarded'
  reason: string
}

export type EvolveReport = {
  runId: string
  base: string
  status: 'done' | 'budget' | 'failed' | 'nothing-to-do'
  baseline: CaseResult[]
  candidates: CandidateSummary[]
  costCny: number
  reportPath: string
}

const now = () => new Date().toISOString()

export function roundsToday(rt: Runtime): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return (rt.db.prepare(`SELECT COUNT(*) n FROM evolution_runs WHERE ts_start >= ? AND status != 'failed'`).get(d.toISOString()) as { n: number }).n
}

/** Per-case pass rate over all samples (a case may have been run more than once). */
export function passRates(rs: CaseResult[]): Map<string, number> {
  const n = new Map<string, [number, number]>()
  for (const r of rs) { const v = n.get(r.caseId) ?? [0, 0]; v[0] += r.pass ? 1 : 0; v[1]++; n.set(r.caseId, v) }
  return new Map([...n].map(([k, [p, t]]) => [k, p / t]))
}

/**
 * Compare candidate vs. base on the same cases, using per-case pass rates so that repeated
 * samples of noisy cases count fractionally. Accept a net gain of at least one whole case
 * with at most one regressed case.
 */
export function judge(base: CaseResult[], cand: CaseResult[]): { better: boolean; fixes: string[]; regressions: string[]; gain: number; reason: string } {
  const b = passRates(base)
  const c = passRates(cand)
  const ids = [...c.keys()].filter((id) => b.has(id))
  const fixes = ids.filter((id) => c.get(id)! > b.get(id)!)
  const regressions = ids.filter((id) => c.get(id)! < b.get(id)!)
  const gain = Math.round(ids.reduce((s, id) => s + c.get(id)! - b.get(id)!, 0) * 100) / 100
  const sum = (m: Map<string, number>) => Math.round(ids.reduce((s, id) => s + m.get(id)!, 0) * 100) / 100
  const tally = `${sum(b)} → ${sum(c)}`
  if (gain < 1) return { better: false, fixes, regressions, gain, reason: `通过数没有实质提高（${tally}）` }
  if (regressions.length > 1) return { better: false, fixes, regressions, gain, reason: `退步任务过多：${regressions.join(', ')}` }
  return { better: true, fixes, regressions, gain, reason: `通过数 ${tally}` }
}

export async function evolveRound(rt: Runtime, opts: EvolveOptions = {}): Promise<EvolveReport> {
  const log = opts.onProgress ?? (() => {})
  const bench = new Bench(rt.ws.root)
  bench.checkAvailable()
  const cfg = rt.ws.config
  if (cfg.evolution?.offPeakOnly !== false && isDeepSeekPeak() && !opts.force)
    throw new Error('现在是 DeepSeek 高峰时段（北京时间工作日 9–12、14–18 点），进化只在非高峰运行')
  if (!opts.resumeBaselineRunId && roundsToday(rt) >= cfg.budget.evolutionRoundsPerDay && !opts.force)
    throw new Error(`今天已经跑过 ${cfg.budget.evolutionRoundsPerDay} 轮进化`)

  const base = rt.genomes.load()
  const startedAt = now()
  const runId = opts.resumeBaselineRunId ?? `evo-${startedAt.replace(/[-:T]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  if (!/^evo-\d{14}-[0-9a-f]{8}$/.test(runId)) throw new Error('进化轮次 ID 无效')
  rt = { ...rt, ledger: rt.ledger.forRound(runId, opts.capCny) }
  const dir = join(rt.ws.dataDir, 'evolution', runId)
  const runsDir = join(rt.ws.dataDir, 'runs', runId)
  const dev = bench.cases('development')
  const acc = bench.cases('acceptance')
  mkdirSync(dir, { recursive: true })
  if (opts.resumeBaselineRunId) {
    const cost = rt.ledger.summary().roundCny
    const updated = rt.db.prepare(`UPDATE evolution_runs SET status='running', ts_end=NULL, note=?
      WHERE id=? AND base_genome=? AND status IN ('budget','failed') AND ABS(cost_cny-?) < 0.000001
      AND NOT EXISTS (SELECT 1 FROM candidates WHERE evolution_run=?)
      AND NOT EXISTS (SELECT 1 FROM budget_reservations WHERE round_id=?)`)
      .run('从已记账的中断基线续跑', runId, base.id, cost, runId, runId)
    if (!updated.changes) throw new Error('该轮无法安全续跑基线')
    log(`续跑同一轮 ${runId}，已记账 ¥${cost.toFixed(4)}`)
  } else {
    rt.db.prepare(`INSERT INTO evolution_runs (id, ts_start, base_genome, status) VALUES (?,?,?, 'running')`).run(runId, startedAt, base.id)
  }
  const byId = new Map([...dev, ...acc].map((c) => [c.id, c]))
  const suite = (g: HarnessGenome, cases: BenchCase[], useCache = true) =>
    runSuite(rt, bench, g, cases, {
      evolutionRun: runId, baseDir: runsDir, concurrency: opts.concurrency ?? 2, useCache,
      onCase: (r) => log(`${g.id} ${r.caseId} ${r.pass ? '✓' : '✗'}${r.cached ? '（缓存）' : `  ¥${r.costCny.toFixed(3)}`}${r.error ? `  ${r.error}` : ''}`)
    })

  let status: EvolveReport['status'] = 'done'
  let baseline: CaseResult[] = []
  const candidates: CandidateSummary[] = []
  try {
    log(`${bench.label} · 基线 ${base.id}：开发集 ${dev.length} 题`)
    baseline = await suite(base, dev)
    const failed = baseline.filter((r) => !r.pass).map((r) => ({ c: byId.get(r.caseId)!, r }))
    log(`基线通过 ${passCount(baseline)}/${dev.length}`)
    if (!failed.length && !opts.testCandidateOnPerfectBaseline) status = 'nothing-to-do'
    else {
      const tried = rt.db
        .prepare(`SELECT target, diagnosis, change, reason FROM candidates WHERE parent = ? AND status IN ('discarded','rejected') ORDER BY ts DESC LIMIT 8`)
        .all(base.id) as { target: string; diagnosis: string; change: string; reason: string }[]
      const passed = baseline.filter((r) => r.pass).map((r) => ({ c: byId.get(r.caseId)!, r }))
      const proposals: Proposal[] = await reflect(rt, base, failed, opts.signal, tried, dir, passed)
      log(`反思器提出 ${proposals.length} 条建议`)
      let baseAcc: CaseResult[] | undefined
      const limit = failed.length ? opts.maxCandidates ?? 2 : 1
      for (const p of proposals.slice(0, limit)) {
        if (opts.dryRun) {
          candidates.push({ genome: '(dry-run)', target: p.target, diagnosis: p.diagnosis, bullets: p.bullets, devPass: 0, basePass: passCount(baseline), devTotal: dev.length, regressions: [], fixes: [], status: 'discarded', reason: 'dry-run 未评测' })
          continue
        }
        const g = mutate(rt, base, p, runId)
        withTransaction(rt.db, () => {
          rt.db.prepare(`INSERT INTO candidates (genome_id, evolution_run, parent, target, diagnosis, change, base_dev_pass, dev_total, status, ts) VALUES (?,?,?,?,?,?,?,?, 'evaluating', ?)`)
            .run(g.id, runId, base.id, p.target, p.diagnosis, JSON.stringify(p.bullets), passCount(baseline), dev.length, now())
        })
        log(`候选 ${g.id}（${p.target}）：${p.diagnosis}`)
        const candDev = await suite(g, dev)
        let verdict = judge(baseline, candDev)
        const flipped = [...verdict.fixes, ...verdict.regressions]
        let baseSamples = baseline
        let candSamples = candDev
        if (flipped.length && opts.confirmFlips !== false) {
          // LLM runs are noisy: a single flip can be chance. Sample flipped cases once more on both sides.
          log(`复核翻转的 ${flipped.length} 题（${flipped.join(', ')}），两边各再跑一次`)
          const fc = flipped.map((id) => byId.get(id)!)
          baseSamples = [...baseline, ...(await suite(base, fc, false))]
          candSamples = [...candDev, ...(await suite(g, fc, false))]
          verdict = judge(baseSamples, candSamples)
        }
        const summary: CandidateSummary = {
          genome: g.id, target: p.target, diagnosis: p.diagnosis, bullets: p.bullets, devPass: passCount(candDev), basePass: passCount(baseline),
          devTotal: dev.length, regressions: verdict.regressions, fixes: verdict.fixes, status: 'discarded', reason: verdict.reason
        }
        if (verdict.better) {
          baseAcc ??= await suite(base, acc)
          const candAcc = await suite(g, acc)
          summary.accPass = passCount(candAcc)
          summary.baseAccPass = passCount(baseAcc)
          summary.accTotal = acc.length
          if (summary.accPass >= summary.baseAccPass) {
            summary.status = 'pending'
            summary.reason = `${verdict.reason}；验收集 ${summary.baseAccPass} → ${summary.accPass}`
          } else summary.reason = `验收集退步（${summary.baseAccPass} → ${summary.accPass}）`
        }
        const cost = (rt.db.prepare(`SELECT COALESCE(SUM(cost_cny),0) c FROM eval_runs WHERE evolution_run = ? AND genome_id = ?`).get(runId, g.id) as { c: number }).c
        const verTotal = summary.devTotal + (summary.accTotal ?? 0)
        const verPass = summary.devPass + (summary.accPass ?? 0)
        const verScope = summary.accTotal ? '离线评测（开发集 + 验收集）' : '离线评测（开发集）'
        rt.db.prepare(`UPDATE candidates SET dev_pass=?, acc_pass=?, acc_total=?, base_acc_pass=?, cost_cny=?, status=?, reason=?,
          verification_run=?, verification_pass=?, verification_total=?, verification_scope=?, verified_at=? WHERE genome_id=?`)
          .run(summary.devPass, summary.accPass ?? null, summary.accTotal ?? null, summary.baseAccPass ?? null, cost, summary.status, summary.reason,
            runId, verPass, verTotal, verScope, now(), g.id)
        if (summary.status === 'discarded') { g.status = 'rejected'; g.note = `${g.note}（自动淘汰：${summary.reason}）`.slice(0, 300); rt.genomes.save(g) }
        candidates.push(summary)
        log(`${g.id}：${summary.status === 'pending' ? '待你审批' : '淘汰'} —— ${summary.reason}`)
        if (summary.status === 'pending') break
      }
    }
  } catch (e) {
    if (e instanceof BudgetError) { status = 'budget'; log(`预算用尽，本轮提前结束：${e.message}`) }
    else { status = 'failed'; log(`本轮失败：${(e as Error).message}`) }
  } finally {
    // A candidate interrupted mid-evaluation (budget, error) cannot be judged: discard it.
    for (const row of rt.db.prepare(`SELECT genome_id FROM candidates WHERE evolution_run = ? AND status = 'evaluating'`).all(runId) as { genome_id: string }[]) {
      const why = status === 'budget' ? '本轮预算用尽，评测未完成' : '评测中断'
      rt.db.prepare(`UPDATE candidates SET status='discarded', reason=? WHERE genome_id=?`).run(why, row.genome_id)
      try { const g = rt.genomes.load(row.genome_id); g.status = 'rejected'; g.note = `${g.note}（${why}）`.slice(0, 300); rt.genomes.save(g) } catch { /* genome file missing */ }
      candidates.push({ genome: row.genome_id, target: '', diagnosis: '', bullets: [], devPass: 0, basePass: passCount(baseline), devTotal: dev.length, regressions: [], fixes: [], status: 'discarded', reason: why })
    }
  }
  const costCny = rt.ledger.summary().roundCny
  const reportPath = join(dir, 'report.md')
  writeFileSync(reportPath, renderReport(runId, base.id, status, baseline, candidates, costCny, byId))
  rt.db.prepare(`UPDATE evolution_runs SET ts_end=?, status=?, cost_cny=?, report_path=? WHERE id=?`).run(now(), status, costCny, reportPath, runId)
  return { runId, base: base.id, status, baseline, candidates, costCny, reportPath }
}

export function renderReport(runId: string, base: string, status: string, baseline: CaseResult[], cands: CandidateSummary[], cost: number, byId: Map<string, BenchCase>): string {
  const rows = baseline.filter((r, i, a) => a.findIndex((x) => x.caseId === r.caseId) === i).map((r) => `| ${r.caseId} | ${byId.get(r.caseId)?.title ?? ''} | ${r.pass ? '✓' : '✗'} | ${r.steps} | ¥${r.costCny.toFixed(3)} | ${r.failures.slice(0, 2).join('；').replace(/\|/g, '/')} |`)
  return `# 进化报告 ${runId}

- 基线 genome：${base}
- 状态：${status}
- 本轮花费：¥${cost.toFixed(3)}
- 基线开发集通过：${passCount(baseline)}/${baseline.length}

## 候选

${cands.length ? cands.map((c) => `### ${c.genome}（${c.status === 'pending' ? '待审批' : '淘汰'}）
- 修改：${c.target}
- 诊断：${c.diagnosis}
- 新增条目：\n${c.bullets.map((b) => `  - ${b}`).join('\n')}
- 开发集：${c.basePass} → ${c.devPass} / ${c.devTotal}；修复 ${c.fixes.join(', ') || '无'}；退步 ${c.regressions.join(', ') || '无'}
${c.accTotal ? `- 验收集：${c.baseAccPass} → ${c.accPass} / ${c.accTotal}\n` : ''}- 结论：${c.reason}`).join('\n\n') : '（无）'}

## 基线逐题

| 任务 | 名称 | 通过 | 步数 | 花费 | 失败项 |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`
}

export type CandidateVerificationInput = {
  runId: string
  pass: number
  total: number
  scope?: string
  verifiedAt?: string
}

/** Attach offline replay or evaluation verification evidence to a candidate record. */
export function recordCandidateVerification(rt: Runtime, genomeId: string, evidence: CandidateVerificationInput): void {
  const runId = evidence.runId.trim()
  if (!runId) throw new Error('验证运行 ID 不能为空')
  if (!Number.isSafeInteger(evidence.total) || evidence.total < 1 || !Number.isSafeInteger(evidence.pass) || evidence.pass < 0 || evidence.pass > evidence.total)
    throw new Error('验证通过数与总数无效')
  withTransaction(rt.db, () => {
    const row = rt.db.prepare(`SELECT status, verification_scope FROM candidates WHERE genome_id = ?`).get(genomeId) as { status: string; verification_scope: string | null } | undefined
    if (!row) throw new Error(`候选记录不存在：${genomeId}`)
    if (row.status !== 'pending' && row.status !== 'evaluating') throw new Error(`候选 ${genomeId} 当前状态为 ${row.status}，无法记录验证`)
    const scope = evidence.scope?.trim() || row.verification_scope || '离线回放验证'
    rt.db.prepare(`UPDATE candidates SET verification_run=?, verification_pass=?, verification_total=?, verification_scope=?, verified_at=? WHERE genome_id=?`)
      .run(runId, evidence.pass, evidence.total, scope, evidence.verifiedAt ?? now(), genomeId)
  })
}

/** Verify a pending candidate against the local benchmark using only a loopback mock gateway. */
export async function verifyCandidateOffline(
  rt: Runtime,
  genomeId: string,
  opts: { selector?: string; scope?: string; concurrency?: number; useCache?: boolean; capCny?: number; onCase?: (r: CaseResult) => void } = {}
): Promise<{ runId: string; pass: number; total: number; scope: string; results: CaseResult[] }> {
  const g = rt.genomes.load(genomeId)
  const row = rt.db.prepare(`SELECT status, verification_scope FROM candidates WHERE genome_id = ?`).get(genomeId) as { status: string; verification_scope: string | null } | undefined
  if (!row || row.status !== 'pending') throw new Error(`候选 ${genomeId} 不是待审批状态，无法验证`)
  const ref = modelFor(g, 'main', { defaults: rt.ws.settings.defaults })
  const { url } = endpointFor(rt.ws.config, parseModelRef(ref).provider)
  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host))
    throw new Error('候选验证只能使用本机离线 mock 网关，禁止调用真实模型 API')
  const bench = new Bench(rt.ws.root)
  bench.checkAvailable()
  const selector = opts.selector ?? 'all'
  const all = bench.cases()
  const ids = selector.split(',').map((s) => s.trim()).filter(Boolean)
  const cases = selector === 'all' ? all
    : selector === 'development' || selector === 'acceptance' ? bench.cases(selector)
    : all.filter((c) => ids.includes(c.id))
  if (!cases.length) throw new Error(`没有匹配的评测任务：${selector}`)
  const runId = `verify-${now().replace(/[-:T]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  const results = await runSuite({ ...rt, ledger: rt.ledger.forRound(runId, opts.capCny) }, bench, g, cases, {
    evolutionRun: runId,
    baseDir: join(rt.ws.dataDir, 'runs', runId),
    concurrency: opts.concurrency ?? 2,
    useCache: opts.useCache ?? false,
    category: 'dev',
    onCase: opts.onCase
  })
  const pass = passCount(results)
  const total = results.length
  const scope = opts.scope?.trim() || row.verification_scope || `离线回放（${selector}，${total} 题）`
  recordCandidateVerification(rt, genomeId, { runId, pass, total, scope })
  return { runId, pass, total, scope, results }
}

/** Approve a pending candidate: it becomes the active genome; the previous one is archived. */
export function promote(rt: Runtime, genomeId: string, opts: { confirmUnverified?: boolean } = {}): HarnessGenome {
  const g = rt.genomes.load(genomeId)
  const prev = rt.genomes.load()
  if (!g.parent || g.budgets.maxSteps > Math.min(prev.budgets.maxSteps, rt.genomes.load(g.parent).budgets.maxSteps))
    throw new Error('候选版本不得提高步数上限')
  if (g.status !== 'candidate') throw new Error(`${genomeId} 不是候选版本`)
  rt.genomes.hash(g)
  rt.genomes.commitActiveSwitch(rt.db, prev.id, g.id, {
    onCommit: () => {
      const row = rt.db.prepare(
        `SELECT status, evolution_run, dev_pass, dev_total, acc_pass, acc_total,
                verification_run, verification_pass, verification_total, verification_scope, verified_at
         FROM candidates WHERE genome_id = ?`
      ).get(genomeId) as {
        status: string
        evolution_run: string
        dev_pass: number | null
        dev_total: number | null
        acc_pass: number | null
        acc_total: number | null
        verification_run: string | null
        verification_pass: number | null
        verification_total: number | null
        verification_scope: string | null
        verified_at: string | null
      } | undefined
      if (!row) throw new Error(`${genomeId} 缺少${g.createdBy.startsWith('evolution/') ? '评测' : '候选'}记录，不能上线`)
      if (row.status !== 'pending') throw new Error(`${genomeId} 当前状态为 ${row.status}，不能上线`)
      const ver = candidateVerification(row)
      if (!ver.verified && opts.confirmUnverified !== true) {
        throw Object.assign(new Error(`${genomeId} 尚未通过离线验证，批准上线需要二次确认`), { status: 400, code: 'UNVERIFIED_CANDIDATE' })
      }
      rt.db.prepare(`UPDATE candidates SET status='approved' WHERE genome_id = ?`).run(genomeId)
    },
    afterCommit: () => {
      g.status = 'active'
      rt.genomes.save(g)
      prev.status = 'archived'
      rt.genomes.save(prev)
    }
  })
  return g
}

export function reject(rt: Runtime, genomeId: string, reason = '用户拒绝'): void {
  const g = rt.genomes.load(genomeId)
  if (g.status === 'active') throw new Error('不能拒绝当前上线版本，请用回滚')
  withTransaction(rt.db, () => {
    rt.db.prepare(`UPDATE candidates SET status='rejected', reason=? WHERE genome_id = ?`).run(reason, genomeId)
  })
  g.status = 'rejected'
  rt.genomes.save(g)
}

/** Re-activate the parent of the active genome (or a given archived genome). */
export function rollback(rt: Runtime, to?: string): HarnessGenome {
  const cur = rt.genomes.load()
  const targetId = to ?? cur.parent
  if (!targetId) throw new Error('当前版本没有父版本，无法回滚')
  if (targetId === cur.id) return cur
  const target = rt.genomes.load(targetId)
  if (target.status !== 'archived') throw new Error('只能回滚到已归档的上线版本')
  rt.genomes.hash(target)
  rt.genomes.commitActiveSwitch(rt.db, cur.id, target.id, {
    afterCommit: () => {
      target.status = 'active'
      rt.genomes.save(target)
      cur.status = 'archived'
      rt.genomes.save(cur)
    }
  })
  return target
}

/** Stand-alone evaluation (CLI `es eval`): same cache and per-round cap as an evolution round. */
export async function evaluate(
  rt: Runtime,
  genome: HarnessGenome,
  selector: string,
  opts: { concurrency?: number; useCache?: boolean; capCny?: number; category?: 'evolution' | 'dev'; onCase?: (r: CaseResult) => void } = {}
): Promise<CaseResult[]> {
  const bench = new Bench(rt.ws.root)
  bench.checkAvailable()
  const all = bench.cases()
  const ids = selector.split(',').map((s) => s.trim()).filter(Boolean)
  const cases = selector === 'all' ? all
    : selector === 'development' || selector === 'acceptance' ? bench.cases(selector)
    : all.filter((c) => ids.includes(c.id))
  if (!cases.length) throw new Error(`没有匹配的评测任务：${selector}`)
  const id = `eval-${now().replace(/[-:T]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  return runSuite({ ...rt, ledger: rt.ledger.forRound(id, opts.capCny) }, bench, genome, cases, {
    baseDir: join(rt.ws.dataDir, 'runs', id),
    concurrency: opts.concurrency ?? 2, useCache: opts.useCache, category: opts.category, onCase: opts.onCase
  })
}
