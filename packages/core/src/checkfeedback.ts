import { readFileSync } from 'node:fs'
import type { Runtime } from './session'

/** User verdicts on manuscript-check findings ("有效 / 误报"): the signal for tuning writing rules. */
export type CheckVerdict = 'valid' | 'false_positive' | 'unsure'
export const VERDICTS: Record<string, CheckVerdict> = { valid: 'valid', ok: 'valid', 有效: 'valid', fp: 'false_positive', false_positive: 'false_positive', 误报: 'false_positive', unsure: 'unsure', 不确定: 'unsure' }

type Finding = { id: string; rule: string; pack?: string; loc: string; message: string; evidence?: string }
type Report = { summary: { file: string; packs?: string[]; variant?: string | null }; findings: Finding[] }

export function readCheckReport(file: string): Report {
  const r = JSON.parse(readFileSync(file, 'utf8')) as Report
  if (!r?.summary || !Array.isArray(r.findings)) throw new Error(`${file} 不是稿件检查报告（report.json）`)
  return r
}

/** One trace-style event per marked finding; unknown ids are reported back, not silently ignored. */
export function feedbackEvents(report: Report, ids: string[], verdict: CheckVerdict, note?: string): { events: Record<string, unknown>[]; missing: string[] } {
  const byId = new Map(report.findings.map((f) => [f.id, f]))
  const missing = ids.filter((id) => !byId.has(id))
  const events = ids.filter((id) => byId.has(id)).map((id) => {
    const f = byId.get(id)!
    return { kind: 'check.feedback', file: report.summary.file, packs: report.summary.packs ?? [], variant: report.summary.variant ?? null,
      finding: id, rule: f.rule, pack: f.pack ?? null, loc: f.loc, message: f.message, verdict, note: note ?? null }
  })
  return { events, missing }
}

/** Store verdicts given outside an agent session (CLI). Same event type the check_feedback tool emits. */
export function recordCheckFeedback(rt: Runtime, events: Record<string, unknown>[], sessionId = 'cli'): void {
  const ins = rt.db.prepare(`INSERT INTO events (session_id, ts, genome_id, run_id, type, payload) VALUES (?,?,?,?,?,?)`)
  const genome = rt.genomes.activeId()
  for (const e of events) ins.run(sessionId, new Date().toISOString(), genome, null, 'host.check.feedback', JSON.stringify(e))
}

export type RuleStats = { rule: string; pack: string | null; valid: number; false_positive: number; unsure: number; fp_rate: number | null }

/** Per-rule verdict counts; the latest verdict per (file, finding) wins. */
export function checkFeedbackStats(rt: Runtime): RuleStats[] {
  const rows = rt.db.prepare(`SELECT payload FROM events WHERE type = 'host.check.feedback' ORDER BY id`).all() as { payload: string }[]
  const latest = new Map<string, { rule: string; pack: string | null; verdict: CheckVerdict }>()
  for (const r of rows) {
    const p = JSON.parse(r.payload)
    latest.set(`${p.file}#${p.finding}#${p.rule}`, { rule: p.rule, pack: p.pack ?? null, verdict: p.verdict })
  }
  const agg = new Map<string, RuleStats>()
  for (const v of latest.values()) {
    const s = agg.get(v.rule) ?? { rule: v.rule, pack: v.pack, valid: 0, false_positive: 0, unsure: 0, fp_rate: null }
    s[v.verdict]++
    agg.set(v.rule, s)
  }
  return [...agg.values()].map((s) => ({ ...s, fp_rate: s.valid + s.false_positive ? s.false_positive / (s.valid + s.false_positive) : null }))
    .sort((a, b) => (b.fp_rate ?? -1) - (a.fp_rate ?? -1) || b.false_positive - a.false_positive)
}
