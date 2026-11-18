// Token usage statistics (decision A2: no money, only tokens).
import type { Db } from './db'

export type UsageGroup = 'day' | 'model' | 'session' | 'project'
export type UsageRow = {
  key: string
  label: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

const GROUP_SQL: Record<UsageGroup, { key: string; label: string }> = {
  day: { key: "substr(datetime(l.ts, 'localtime'), 1, 10)", label: "substr(datetime(l.ts, 'localtime'), 1, 10)" },
  model: { key: "COALESCE(l.model, l.provider)", label: "COALESCE(l.model, l.provider)" },
  session: { key: "COALESCE(l.session_id, '')", label: "COALESCE(s.title, l.session_id, '（无会话）')" },
  project: { key: "COALESCE(s.project_id, 'drafts')", label: "COALESCE(p.name, '草稿')" }
}

/** Aggregate model requests from the ledger table over the last `days` days. */
export function usageBy(db: Db, group: UsageGroup, opts: { days?: number; sessionId?: string; projectId?: string } = {}): UsageRow[] {
  const g = GROUP_SQL[group]
  const where = ["l.kind = 'model'", "s.category IS NOT 'dev'", "l.category IN ('usage', 'evolution')"]
  const args: (string | number)[] = []
  if (opts.days) { where.push('l.ts >= ?'); args.push(new Date(Date.now() - opts.days * 86_400_000).toISOString()) }
  if (opts.sessionId) { where.push('l.session_id = ?'); args.push(opts.sessionId) }
  if (opts.projectId === 'drafts') where.push('s.project_id IS NULL')
  else if (opts.projectId) { where.push('s.project_id = ?'); args.push(opts.projectId) }
  const rows = db.prepare(`SELECT ${g.key} AS key, ${g.label} AS label, COUNT(*) AS requests,
        COALESCE(SUM(l.input_tokens), 0) AS inputTokens, COALESCE(SUM(l.output_tokens), 0) AS outputTokens,
        COALESCE(SUM(l.cache_read_tokens), 0) AS cacheReadTokens
      FROM ledger l LEFT JOIN sessions s ON s.id = l.session_id LEFT JOIN projects p ON p.id = s.project_id
      WHERE ${where.join(' AND ')} GROUP BY ${g.key} ORDER BY ${group === 'day' ? 'key' : 'inputTokens + outputTokens DESC'} LIMIT 400`)
    .all(...args) as UsageRow[]
  return rows.map((r) => ({ ...r, key: String(r.key), label: String(r.label) }))
}

export function usageTotals(db: Db, days?: number) {
  const rows = usageBy(db, 'model', { days })
  const sum = (k: keyof UsageRow) => rows.reduce((a, r) => a + Number(r[k]), 0)
  const turns = db.prepare(`SELECT COUNT(*) AS turns, COALESCE(SUM(tool_calls), 0) AS toolCalls, COALESCE(SUM(tool_errors), 0) AS toolErrors
      FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.category = 'usage' ${days ? 'AND t.ts_start >= ?' : ''}`)
    .get(...(days ? [new Date(Date.now() - days * 86_400_000).toISOString()] : [])) as { turns: number; toolCalls: number; toolErrors: number }
  const input = sum('inputTokens')
  const cache = sum('cacheReadTokens')
  return {
    requests: sum('requests'),
    inputTokens: input,
    outputTokens: sum('outputTokens'),
    cacheReadTokens: cache,
    cacheHitRate: input ? cache / input : 0,
    ...turns
  }
}
