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
}

/** Local-day boundary as an ISO string (budget days follow the user's clock). */
function startOfLocalDay(now = new Date()): string {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export class Ledger {
  private alerted = new Set<number>()
  /** Optional cap for the current evolution round, in CNY. */
  roundCap?: { startedAt: string; capCny: number }
  constructor(private db: Db, private config: EvoConfig, private onAlert: (msg: string) => void = (m) => console.warn(m)) {}

  get rate(): number {
    return this.config.usdToCny
  }

  record(e: LedgerEntry): number {
    const cny = e.costUsd * this.rate
    this.db
      .prepare(
        `INSERT INTO ledger (ts, category, kind, provider, model, session_id, genome_id, input_tokens,
          cache_read_tokens, output_tokens, units, peak, cost_usd, cost_cny)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        new Date().toISOString(), e.category, e.kind, e.provider, e.model ?? null, e.sessionId ?? null,
        e.genomeId ?? null, e.inputTokens ?? 0, e.cacheReadTokens ?? 0, e.outputTokens ?? 0, e.units ?? 0,
        e.peak ? 1 : 0, e.costUsd, cny
      )
    this.checkAlerts()
    return cny
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
      capCny: b.totalCny,
      byCategory,
      categoryCaps: b.categories,
      usageTodayCny: this.sum('category = ? AND ts >= ?', 'usage', today),
      dailyUsageSoftCny: b.dailyUsageSoftCny,
      webCallsToday: webToday,
      webCallsPerDay: b.webCallsPerDay,
      roundCny: this.roundCap ? this.sum('category = ? AND ts >= ?', 'evolution', this.roundCap.startedAt) : 0
    }
  }

  /** Throws BudgetError when a hard limit would be crossed; returns soft warnings otherwise. */
  assertCanSpend(category: BudgetCategory, estimateCny = 0, opts: { web?: boolean } = {}): string[] {
    const s = this.summary()
    const warnings: string[] = []
    if (s.totalCny + estimateCny >= s.capCny)
      throw new BudgetError(`总预算已用 ¥${s.totalCny.toFixed(2)} / ¥${s.capCny}，已停止调用`, 'total')
    const cap = s.categoryCaps[category]
    if (category !== 'reserve' && s.byCategory[category] + estimateCny >= cap)
      throw new BudgetError(`「${category}」分类预算已用 ¥${s.byCategory[category].toFixed(2)} / ¥${cap}`, 'category')
    if (category === 'evolution' && this.roundCap && s.roundCny + estimateCny >= this.roundCap.capCny)
      throw new BudgetError(`本轮进化已用 ¥${s.roundCny.toFixed(2)} / ¥${this.roundCap.capCny}`, 'round')
    if (opts.web && s.webCallsToday >= s.webCallsPerDay)
      throw new BudgetError(`今日联网调用已达 ${s.webCallsPerDay} 次上限`, 'web')
    if (category === 'usage' && s.usageTodayCny >= s.dailyUsageSoftCny)
      warnings.push(`今日使用已花 ¥${s.usageTodayCny.toFixed(2)}，超过每日软上限 ¥${s.dailyUsageSoftCny}`)
    return warnings
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
