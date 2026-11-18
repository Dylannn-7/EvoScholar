import type { AgentEvent, AgentMessage, ContentBlock } from '@evoscholar/harness'
import type { BudgetCategory } from './config'
import type { Db } from './db'

const now = () => new Date().toISOString()
const clip = (s: string, n = 20000) => (s.length > n ? s.slice(0, n) + '…' : s)

export function textOf(blocks: readonly ContentBlock[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
}

/**
 * Persists a compact, evolution-friendly trajectory: one row per turn plus the
 * model-finish / tool / compaction events that matter for attribution. Streaming
 * deltas are not stored (the harness journal keeps full checkpoints).
 */
export class TrajectoryRecorder {
  private turnId?: number
  private agg = { steps: 0, toolCalls: 0, toolErrors: 0, input: 0, output: 0 }
  constructor(
    private db: Db,
    readonly sessionId: string,
    readonly genomeId: string,
    opts: { category: BudgetCategory; title?: string; stage?: string }
  ) {
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, created_at, genome_id, title, stage, category) VALUES (?,?,?,?,?,?)`
    ).run(sessionId, now(), genomeId, opts.title ?? null, opts.stage ?? null, opts.category)
  }

  private event(type: string, payload: unknown, runId?: string) {
    this.db
      .prepare(`INSERT INTO events (session_id, ts, genome_id, run_id, type, payload) VALUES (?,?,?,?,?,?)`)
      .run(this.sessionId, now(), this.genomeId, runId ?? null, type, JSON.stringify(payload))
  }

  /** Id of the turn in progress (or the last one). */
  get turn(): number | undefined { return this.turnId }

  beginTurn(prompt: string): number {
    this.agg = { steps: 0, toolCalls: 0, toolErrors: 0, input: 0, output: 0 }
    const r = this.db
      .prepare(`INSERT INTO turns (session_id, genome_id, ts_start, prompt) VALUES (?,?,?,?)`)
      .run(this.sessionId, this.genomeId, now(), clip(prompt))
    this.turnId = Number(r.lastInsertRowid)
    return this.turnId
  }

  onEvent = (e: AgentEvent): void => {
    if (e.type === 'model' && e.event.type === 'finish') {
      this.agg.steps++
      this.agg.input += e.event.usage?.inputTokens ?? 0
      this.agg.output += e.event.usage?.outputTokens ?? 0
      this.event('model.finish', {
        purpose: e.purpose ?? 'turn',
        reason: e.event.reason,
        usage: e.event.usage ?? null,
        calls: (e.event.calls ?? []).map((c) => ({ name: c.name, arguments: c.arguments }))
      }, e.runId)
    } else if (e.type === 'compaction' && e.status !== 'started') {
      this.event('compaction', { status: e.status }, e.runId)
    } else if (e.type === 'checkpoint') {
      // Tool results land in checkpoints as role:'tool' messages; record new ones once.
      for (const m of e.checkpoint.messages.slice(-4)) this.noteToolMessage(m, e.checkpoint.run?.id)
    }
  }

  private seenTools = new Set<string>()
  private noteToolMessage(m: AgentMessage, runId?: string) {
    if (m.role !== 'tool' || this.seenTools.has(m.id)) return
    this.seenTools.add(m.id)
    this.agg.toolCalls++
    if (m.isError) this.agg.toolErrors++
    this.event('tool.result', { invocationId: m.invocationId, isError: !!m.isError, preview: clip(textOf(m.content), 1500) }, runId)
  }

  /** Host-side trace events (file writes, processes, local HTTP) for evaluation and attribution. */
  hostEvent(e: Record<string, unknown>): void {
    this.event(`host.${String(e.kind ?? 'event')}`, e)
  }

  endTurn(outcome: string, answer: string): void {
    if (this.turnId === undefined) return
    const cost = this.db
      .prepare(`SELECT COALESCE(SUM(cost_cny),0) AS c FROM ledger WHERE session_id = ? AND ts >= (SELECT ts_start FROM turns WHERE id = ?)`)
      .get(this.sessionId, this.turnId) as { c: number }
    this.db
      .prepare(
        `UPDATE turns SET ts_end=?, outcome=?, steps=?, tool_calls=?, tool_errors=?, input_tokens=?, output_tokens=?, cost_cny=?, answer=? WHERE id=?`
      )
      .run(now(), outcome, this.agg.steps, this.agg.toolCalls, this.agg.toolErrors, this.agg.input, this.agg.output, cost.c, clip(answer), this.turnId)
  }

  feedback(kind: string, value: number | null, note?: string): void {
    this.db
      .prepare(`INSERT INTO feedback (session_id, turn_id, ts, kind, value, note) VALUES (?,?,?,?,?,?)`)
      .run(this.sessionId, this.turnId ?? null, now(), kind, value, note ?? null)
  }
}
