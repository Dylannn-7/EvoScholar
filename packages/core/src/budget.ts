import type { BudgetCategory, EvoConfig } from './config'
import type { Db } from './db'

export class BudgetError extends Error {
  constructor(message: string, readonly scope: 'total' | 'category' | 'daily' | 'round' | 'web') {
    super(message)
    this.name = 'BudgetError'
  }
}

export type LedgerEntry = {
  category: BudgetCategory
  kind: 'model' | 'search' | 'fetch' | 'ocr'
  provider: string
  model?: string
  sessionId?: string
  genomeId?: string
  inputTokens?: number
  cacheReadTokens?: number
  outputTokens?: number
  units?: number
  peak?: boolean
  costUsd: number
  estimated?: boolean
}

type Settlement = Pick<LedgerEntry, 'costUsd' | 'inputTokens' | 'cacheReadTokens' | 'outputTokens' | 'peak'>

/** Local-day boundary as an ISO string (budget days follow the user's clock). */
function startOfLocalDay(now = new Date()): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export class Ledger {
  constructor(
    private db: Db,
    private config: EvoConfig,
    private onAlert: (msg: string) => void = (m) => console.warn(m),
    private round?: { id: string; capCny: number },
    private alerted = new Set<number>()
  ) {}

  forRound(id: string, capCny = this.config.budget.evolutionPerRoundCny): Ledger {
    if (!Number.isFinite(capCny) || capCny < 0) throw new Error('单轮预算必须是有限的非负金额')
    return new Ledger(this.db, this.config, this.onAlert, {
      id, capCny: Math.min(capCny, this.config.budget.evolutionPerRoundCny)
    }, this.alerted)
  }

  get rate(): number {
    return this.config.usdToCny
  }

  record(e: LedgerEntry): number {
    const cny = this.insert(e)
    if (e.category !== 'usage') this.checkAlerts()
    return cny
  }

  private insert(e: LedgerEntry): number {
    const usd = e.category === 'usage' ? 0 : e.costUsd
    const cny = usd * this.rate
    this.db
      .prepare(
        `INSERT INTO ledger (ts, category, kind, provider, model, session_id, genome_id, input_tokens,
          cache_read_tokens, output_tokens, units, peak, cost_usd, cost_cny, round_id, estimated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        new Date().toISOString(), e.category, e.kind, e.provider, e.model ?? null, e.sessionId ?? null,
        e.genomeId ?? null, e.inputTokens ?? 0, e.cacheReadTokens ?? 0, e.outputTokens ?? 0, e.units ?? 0,
        e.category !== 'usage' && e.peak ? 1 : 0, usd, cny, this.round?.id ?? null, e.estimated ? 1 : 0
      )
    return cny
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Atomically reserve against the shared ledger before sending a billable request. */
  reserve(entry: LedgerEntry) {
    const costCny = entry.costUsd * this.rate
    if (!Number.isFinite(costCny) || costCny < 0) throw new Error('无法估算调用费用')
    const web = entry.kind === 'search' || entry.kind === 'fetch'
    const { id, warnings } = this.transaction(() => {
      const warnings = this.assertCanSpend(entry.category, costCny, { web })
      const { lastInsertRowid: id } = this.db.prepare(
        'INSERT INTO budget_reservations (category, kind, round_id, cost_cny, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(entry.category, entry.kind, this.round?.id ?? null, costCny, new Date().toISOString())
      return { id, warnings }
    })
    return {
      warnings,
      // null releases a known free call. Undefined retains the estimate when usage is unavailable.
      settle: (actual?: Settlement | null) => {
        this.transaction(() => {
          const removed = this.db.prepare('DELETE FROM budget_reservations WHERE id = ?').run(id)
          if (removed.changes && actual !== null) this.insert({ ...entry, ...actual, estimated: !actual })
        })
        this.checkAlerts()
      }
    }
  }

  private sum(where = '1=1', ...args: (string | number)[]): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_cny),0) AS s FROM ledger WHERE ${where}`).get(...args) as { s: number }
    return row.s
  }

  summary() {
    const b = this.config.budget
    const byCategory = Object.fromEntries(
      (Object.keys(b.categories) as BudgetCategory[]).map((c) => [c, this.sum('category = ?', c)])
    ) as Record<BudgetCategory, number>
    const today = startOfLocalDay()
    const webToday = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM ledger WHERE kind IN ('search','fetch') AND ts >= ?`)
      .get(today) as { n: number }).n
    return {
      totalCny: this.sum(),
      reservedCny: (this.db.prepare('SELECT COALESCE(SUM(cost_cny),0) AS s FROM budget_reservations').get() as { s: number }).s,
      capCny: b.totalCny,
      byCategory,
      categoryCaps: b.categories,
      usageTodayCny: this.sum('category = ? AND ts >= ?', 'usage', today),
      dailyUsageSoftCny: b.dailyUsageSoftCny,
      webCallsToday: webToday,
      webCallsPerDay: b.webCallsPerDay,
      roundCny: this.round ? this.sum('round_id = ?', this.round.id) : 0
    }
  }

  /** Throws BudgetError when a hard limit would be crossed; returns soft warnings otherwise. */
  assertCanSpend(category: BudgetCategory, estimateCny = 0, opts: { web?: boolean } = {}): string[] {
    if (category === 'usage') return []
    const s = this.summary()
    const warnings: string[] = []
    const held = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN category = ? THEN cost_cny END),0) AS category,
      COALESCE(SUM(CASE WHEN round_id = ? THEN cost_cny END),0) AS round,
      COUNT(CASE WHEN kind IN ('search','fetch') THEN 1 END) AS web FROM budget_reservations`)
      .get(category, this.round?.id ?? null) as { category: number; round: number; web: number }
    if (s.totalCny + s.reservedCny + estimateCny > s.capCny)
      throw new BudgetError(`总预算不足（已记账 ¥${s.totalCny.toFixed(2)}，预留 ¥${s.reservedCny.toFixed(2)}，上限 ¥${s.capCny}）`, 'total')
    const cap = s.categoryCaps[category]
    if (!Number.isFinite(cap) || s.byCategory[category] + held.category + estimateCny > cap)
      throw new BudgetError(`「${category}」分类预算不足（含预留 ¥${(s.byCategory[category] + held.category).toFixed(2)}，上限 ¥${cap}）`, 'category')
    if (this.round && s.roundCny + held.round + estimateCny > this.round.capCny)
      throw new BudgetError(`本轮预算不足（含预留 ¥${(s.roundCny + held.round).toFixed(2)}，上限 ¥${this.round.capCny}）`, 'round')
    if (opts.web && s.webCallsToday + held.web >= s.webCallsPerDay)
      throw new BudgetError(`今日联网调用额度不足（含预留，上限 ${s.webCallsPerDay} 次）`, 'web')
    return warnings
  }

  /** Release stale unresolved budget reservations (e.g. after a crash) and write a reconciliation record. */
  reconcileReservations(maxAgeMs = 30 * 60_000): { released: number; releasedCny: number; detail?: string } {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
    return this.transaction(() => {
      const stale = this.db.prepare(
        `SELECT id, category, kind, round_id, cost_cny, created_at FROM budget_reservations
         WHERE created_at IS NULL OR created_at <= ?`
      ).all(cutoff) as { id: number; category: string; kind: string; round_id: string | null; cost_cny: number; created_at: string | null }[]
      if (!stale.length) return { released: 0, releasedCny: 0 }
      const releasedCny = stale.reduce((sum, row) => sum + Number(row.cost_cny || 0), 0)
      this.db.prepare(`DELETE FROM budget_reservations WHERE created_at IS NULL OR created_at <= ?`).run(cutoff)
      const detail = `释放 ${stale.length} 条超时未结算预算预留（合计 ¥${releasedCny.toFixed(4)}）`
      this.db.prepare(`INSERT INTO reconcile_log (ts, kind, detail) VALUES (?, 'budget_reservation', ?)`)
        .run(new Date().toISOString(), detail)
      return { released: stale.length, releasedCny, detail }
    })
  }

  private checkAlerts() {
    const s = this.summary()
    for (const t of this.config.budget.alertAt) {
      if (s.totalCny >= s.capCny * t && !this.alerted.has(t)) {
        this.alerted.add(t)
        this.onAlert(`预算提醒：总花费已达 ¥${s.totalCny.toFixed(2)}，超过总额的 ${Math.round(t * 100)}%`)
      }
    }
  }
}
