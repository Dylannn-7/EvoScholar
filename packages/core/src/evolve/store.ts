// Memory for in-loop evolution: lessons (situation -> what to do) and preferences (the user's taste).
// Scored with a Beta posterior over credited turn outcomes; trial -> active -> retired; untrusted
// items (derived from external content) never self-promote. See docs/in-loop-evolution.md §2, §7.
import { inside } from '../tools/sandbox'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db'

export type MemoryKind = 'lesson' | 'preference'
export type MemoryScope = 'global' | 'project' | 'stage'
export type MemoryStatus = 'trial' | 'active' | 'retired'
export type MemoryItem = {
  id: string
  kind: MemoryKind
  scope: MemoryScope
  project_id: string | null
  stage: string | null
  trigger: string
  content: string
  source: 'model' | 'user' | 'choice' | 'edit' | 'host'
  evidence: string | null
  status: MemoryStatus
  trust: 'trusted' | 'untrusted'
  pinned: number
  uses: number
  wins: number
  losses: number
  created_at: string
  updated_at: string
  last_used_at: string | null
}
export type EvolveKind = 'recall' | 'reflect' | 'adjust' | 'selfcheck' | 'learned' | 'preference' | 'observe' | 'credit' | 'revert' | 'choice'
export type EvolveEvent = { kind: EvolveKind; text: string; refs?: string[]; data?: Record<string, unknown> }

export const EVOLVE_DEFAULTS = {
  maxInjected: 6,
  maxInjectedChars: 1200,
  promoteWins: 2,
  promoteScore: 0.6,
  retireUses: 5,
  retireScore: 0.35,
  retireDays: 30,
  maxActive: 300,
  repeatFailureGuard: 3
}

const now = () => new Date().toISOString()
export const betaScore = (m: Pick<MemoryItem, 'wins' | 'losses'>) => (m.wins + 1) / (m.wins + m.losses + 2)

/** Writes that try to weaken the harness are refused (protected limits, checks, approvals). */
const FORBIDDEN = [
  /(关闭|跳过|禁用|绕过|忽略).{0,8}(检查|审批|确认|权限|沙箱|guard|限制)/i,
  /(提高|放宽|取消|去掉).{0,8}(上限|限制|预算|步数|maxSteps)/i,
  /\b(disable|skip|bypass|ignore)\b.{0,20}\b(check|approval|permission|sandbox|guard|limit)s?\b/i,
  /\bmax_?steps\b.{0,10}\d{3,}/i,
  /(api[_ ]?key|密钥|token)\s*[:=]/i
]
export function validateMemoryText(text: string): void {
  if (!text.trim()) throw new Error('内容为空')
  if (text.length > 600) throw new Error('单条经验不超过 600 字，请写成可复用的要点')
  for (const re of FORBIDDEN) if (re.test(text)) throw new Error('这条内容试图放宽受保护的限制（检查、审批、权限或上限），已拒绝写入')
}

/** Character-bigram Jaccard similarity; works for Chinese and English without a tokenizer. */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g, '')
    const g = new Set<string>()
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2))
    return g
  }
  const A = grams(a); const B = grams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** Relevance for recall: shared bigrams over the shorter text (Jaccard is too strict for short Chinese). */
export function relevance(query: string, item: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/[\s\p{P}]+/gu, '')
    const g = new Set<string>()
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2))
    return g
  }
  const A = grams(query); const B = grams(item)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of B) if (A.has(x)) inter++
  return inter / Math.min(A.size, B.size)
}

export class EvolveStore {
  constructor (private db: Db, private dataDir?: string) {}

  private nextId(kind: MemoryKind): string {
    const prefix = kind === 'lesson' ? 'L' : 'P'
    const row = this.db.prepare(`SELECT id FROM memory WHERE id LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}-%`) as { id: string } | undefined
    const n = row ? Number(row.id.slice(2)) + 1 : 1
    return `${prefix}-${String(n).padStart(4, '0')}`
  }

  get(id: string): MemoryItem | undefined {
    return this.db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as MemoryItem | undefined
  }

  list(f: { status?: MemoryStatus | 'live'; kind?: MemoryKind; projectId?: string | null } = {}): MemoryItem[] {
    const where: string[] = []
    const args: (string | null)[] = []
    if (f.status === 'live') where.push("status != 'retired'")
    else if (f.status) { where.push('status = ?'); args.push(f.status) }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
    if (f.projectId !== undefined) { where.push("(scope != 'project' OR project_id IS ?)"); args.push(f.projectId) }
    return this.db.prepare(`SELECT * FROM memory ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, updated_at DESC`).all(...args) as MemoryItem[]
  }

  /**
   * Add or merge a memory item. A near-duplicate (same kind, overlapping scope, similar trigger+content)
   * is updated instead of duplicated. User-given items start active; external-derived ones are untrusted.
   */
  upsert(input: {
    kind: MemoryKind; trigger: string; content: string; source: MemoryItem['source']
    scope?: MemoryScope; projectId?: string | null; stage?: string | null; evidence?: string; untrusted?: boolean; pinned?: boolean
  }): { item: MemoryItem; merged: boolean } {
    validateMemoryText(`${input.trigger} ${input.content}`)
    const scope = input.scope ?? (input.projectId ? 'project' : 'global')
    const userGiven = input.source === 'user' || input.source === 'choice'
    const candidates = this.list({ status: 'live', kind: input.kind, projectId: input.projectId ?? null })
    const key = `${input.trigger} ${input.content}`
    const trust = input.untrusted ? 'untrusted' : 'trusted'
    const stage = input.stage ?? null
    const projectId = input.projectId ?? null
    const dup = candidates.find((m) => m.trust === trust && m.scope === scope && m.project_id === projectId && m.stage === stage &&
      (userGiven || !['user', 'choice'].includes(m.source)) && similarity(`${m.trigger} ${m.content}`, key) >= 0.55)
    const t = now()
    if (dup) {
      this.db.prepare(`UPDATE memory SET content = ?, trigger = ?, evidence = ?, updated_at = ?, status = CASE WHEN ? THEN 'active' ELSE status END, pinned = MAX(pinned, ?) WHERE id = ?`)
        .run(input.content, input.trigger, [dup.evidence, input.evidence].filter(Boolean).join(',').slice(-400) || null, t, userGiven && !input.untrusted ? 1 : 0, userGiven && !input.untrusted && input.pinned ? 1 : 0, dup.id)
      this.mirror(input.projectId)
      return { item: this.get(dup.id)!, merged: true }
    }
    const id = this.nextId(input.kind)
    this.db.prepare(`INSERT INTO memory (id, kind, scope, project_id, stage, trigger, content, source, evidence, status, trust, pinned, uses, wins, losses, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,?)`)
      .run(id, input.kind, scope, input.projectId ?? null, input.stage ?? null, input.trigger, input.content, input.source, input.evidence ?? null,
        userGiven && !input.untrusted ? 'active' : 'trial', trust, userGiven && !input.untrusted && input.pinned ? 1 : 0, t, t)
    this.mirror(input.projectId)
    return { item: this.get(id)!, merged: false }
  }

  setStatus(id: string, status: MemoryStatus): void {
    this.db.prepare('UPDATE memory SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id)
    this.mirror(this.get(id)?.project_id)
  }
  pin(id: string, on: boolean): void {
    this.db.prepare('UPDATE memory SET pinned = ?, status = CASE WHEN ? THEN \'active\' ELSE status END, updated_at = ? WHERE id = ?').run(on ? 1 : 0, on ? 1 : 0, now(), id)
  }
  edit(id: string, patch: { trigger?: string; content?: string }): void {
    const m = this.get(id)
    if (!m) throw new Error('条目不存在')
    validateMemoryText(`${patch.trigger ?? m.trigger} ${patch.content ?? m.content}`)
    this.db.prepare('UPDATE memory SET trigger = ?, content = ?, source = \'user\', trust = \'trusted\', updated_at = ? WHERE id = ?').run(patch.trigger ?? m.trigger, patch.content ?? m.content, now(), id)
    this.mirror(m.project_id)
  }
  remove(id: string): void {
    const m = this.get(id)
    this.db.prepare('DELETE FROM memory WHERE id = ?').run(id)
    this.mirror(m?.project_id)
  }

  /** Record that items were injected (present) for a turn. */
  recordUses(ids: string[], sessionId: string, turnId?: number): void {
    const t = now()
    const ins = this.db.prepare('INSERT INTO memory_uses (memory_id, session_id, turn_id, adopted, ts) VALUES (?,?,?,0,?)')
    for (const id of ids) {
      ins.run(id, sessionId, turnId ?? null, t)
      this.db.prepare('UPDATE memory SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(t, id)
    }
  }
  markAdopted(ids: string[], sessionId: string, turnId?: number): void {
    for (const id of ids) this.db.prepare('UPDATE memory_uses SET adopted = 1 WHERE memory_id = ? AND session_id = ? AND turn_id IS ?').run(id, sessionId, turnId ?? null)
  }

  /**
   * Credit a finished turn: adopted items weigh 1.0, merely present ones 0.25. Then apply
   * promotion (trial -> active) and retirement rules. Returns score deltas for the UI.
   */
  credit(sessionId: string, turnId: number | undefined, score: number, confidence: number): { id: string; before: number; after: number; status: MemoryStatus }[] {
    const rows = this.db.prepare('SELECT memory_id, MAX(adopted) AS adopted FROM memory_uses WHERE session_id = ? AND turn_id IS ? GROUP BY memory_id').all(sessionId, turnId ?? null) as { memory_id: string; adopted: number }[]
    this.db.prepare('UPDATE memory_uses SET score = ? WHERE session_id = ? AND turn_id IS ?').run(score, sessionId, turnId ?? null)
    const out: { id: string; before: number; after: number; status: MemoryStatus }[] = []
    for (const r of rows) {
      const m = this.get(r.memory_id)
      if (!m) continue
      const w = (r.adopted ? 1 : 0.25) * confidence
      const wins = m.wins + w * score
      const losses = m.losses + w * (1 - score)
      let status = m.status
      const after = betaScore({ wins, losses })
      if (status === 'trial' && m.trust === 'trusted' && r.adopted && wins >= EVOLVE_DEFAULTS.promoteWins * 0.5 && after >= EVOLVE_DEFAULTS.promoteScore) status = 'active'
      if (!m.pinned && m.uses >= EVOLVE_DEFAULTS.retireUses && after < EVOLVE_DEFAULTS.retireScore) status = 'retired'
      this.db.prepare('UPDATE memory SET wins = ?, losses = ?, status = ?, updated_at = ? WHERE id = ?').run(wins, losses, status, now(), m.id)
      out.push({ id: m.id, before: betaScore(m), after, status })
    }
    return out
  }

  /** Retire items unused for a long time (never pinned ones). */
  sweep(): number {
    const cutoff = new Date(Date.now() - EVOLVE_DEFAULTS.retireDays * 86_400_000).toISOString()
    const r = this.db.prepare(`UPDATE memory SET status = 'retired' WHERE pinned = 0 AND status != 'retired' AND COALESCE(last_used_at, created_at) < ?`).run(cutoff)
    return Number(r.changes)
  }

  log(e: EvolveEvent & { sessionId?: string; projectId?: string | null; turnId?: number }): number {
    const r = this.db.prepare('INSERT INTO evolve_log (session_id, project_id, turn_id, kind, refs, text, data, ts) VALUES (?,?,?,?,?,?,?,?)')
      .run(e.sessionId ?? null, e.projectId ?? null, e.turnId ?? null, e.kind, e.refs?.length ? e.refs.join(',') : null, e.text, e.data ? JSON.stringify(e.data) : null, now())
    return Number(r.lastInsertRowid)
  }
  /**
   * First external source recorded for a session (see installEvolveLoop). The marker is sticky:
   * compaction and cold restarts drop the original tool calls, but the context may still carry them.
   */
  externalSource(sessionId: string): string | undefined {
    const row = this.db.prepare(`SELECT json_extract(data, '$.provenance') AS p FROM evolve_log
      WHERE session_id = ? AND kind = 'observe' AND json_extract(data, '$.provenance') IS NOT NULL ORDER BY id LIMIT 1`).get(sessionId) as { p: string } | undefined
    return row?.p ?? undefined
  }
  /** A forked session starts from the same context, so it inherits the marker. */
  inheritExternalSource(fromSessionId: string, toSessionId: string): void {
    this.db.prepare(`INSERT INTO evolve_log (session_id, project_id, turn_id, kind, refs, text, data, ts)
      SELECT ?, project_id, NULL, kind, refs, text, data, ? FROM evolve_log
      WHERE session_id = ? AND kind = 'observe' AND json_extract(data, '$.provenance') IS NOT NULL ORDER BY id LIMIT 1`).run(toSessionId, now(), fromSessionId)
  }
  recentLog(f: { sessionId?: string; limit?: number } = {}) {
    return (this.db.prepare(`SELECT l.*, s.title AS session_title FROM evolve_log l LEFT JOIN sessions s ON s.id = l.session_id ${f.sessionId ? 'WHERE l.session_id = ?' : ''} ORDER BY l.id DESC LIMIT ?`)
      .all(...(f.sessionId ? [f.sessionId] : []), f.limit ?? 200) as Record<string, unknown>[])
      .map((r) => ({ ...r, refs: r.refs ? String(r.refs).split(',') : [], data: r.data ? JSON.parse(String(r.data)) : null }))
  }

  /** User-readable mirror: data/memory/memory.md (global) and <project>/.evoscholar/memory.md. */
  private mirror(projectId?: string | null): void {
    if (!this.dataDir) return
    try {
      const render = (items: MemoryItem[], title: string) => `# ${title}\n\n自动生成的只读镜像；修改请在 EvoScholar 的「轨迹 → 记忆」里进行。\n\n` +
        items.map((m) => `- [${m.id}] ${m.kind === 'lesson' ? '经验' : '偏好'}${m.pinned ? '（置顶）' : ''}${m.status === 'trial' ? '（试用）' : ''}：${m.trigger} → ${m.content}`).join('\n') + '\n'
      const dir = join(this.dataDir, 'memory')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'memory.md'), render(this.list({ status: 'live' }).filter((m) => m.scope !== 'project'), 'EvoScholar 记忆'))
      if (projectId) {
        const p = this.db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined
        if (p && existsSync(p.path)) {
          mkdirSync(inside(p.path, '.evoscholar'), { recursive: true })
          writeFileSync(inside(p.path, join('.evoscholar', 'memory.md')), render(this.list({ status: 'live' }).filter((m) => m.project_id === projectId), '项目记忆'))
        }
      }
    } catch {}
  }

  // ---------------------------------------------------------------- overlays
  addOverlay(o: { sessionId: string; op: string; target?: string; value: string; reason?: string; turnId?: number; beforeScore?: number }): string {
    const id = `O-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    this.db.prepare('INSERT INTO overlays (id, session_id, op, target, value, reason, status, turn_id, before_score, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, o.sessionId, o.op, o.target ?? null, o.value, o.reason ?? null, 'trial', o.turnId ?? null, o.beforeScore ?? null, now())
    return id
  }
  overlays(sessionId?: string, all = false) {
    return this.db.prepare(`SELECT * FROM overlays ${sessionId ? 'WHERE session_id = ?' : ''} ${all ? '' : sessionId ? "AND status IN ('trial','kept')" : "WHERE status IN ('trial','kept')"} ORDER BY created_at`)
      .all(...(sessionId ? [sessionId] : [])) as { id: string; session_id: string; op: string; target: string | null; value: string; reason: string | null; status: string; before_score: number | null; after_score: number | null; created_at: string }[]
  }
  setOverlay(id: string, status: 'kept' | 'reverted' | 'promoted', afterScore?: number): void {
    this.db.prepare('UPDATE overlays SET status = ?, after_score = COALESCE(?, after_score) WHERE id = ?').run(status, afterScore ?? null, id)
  }

  scoreTurn(sessionId: string, turnId: number | undefined, score: number, confidence: number, signals: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO turn_scores (session_id, turn_id, score, confidence, signals, ts) VALUES (?,?,?,?,?,?)').run(sessionId, turnId ?? null, score, confidence, JSON.stringify(signals), now())
  }
  lastScore(sessionId: string): number | undefined {
    return (this.db.prepare('SELECT score FROM turn_scores WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as { score: number } | undefined)?.score
  }
}
