import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  Bench,
  BudgetError,
  PROTECTED_LIMITS,
  VERDICTS,
  candidateDetail,
  evolveRound,
  feedbackEvents,
  getCapabilities,
  inside,
  isDeepSeekPeak,
  lineage,
  listCandidates,
  listProviders,
  modelInfo,
  openResearchSession,
  promote,
  readCheckReport,
  recordCheckFeedback,
  refreshProviderModels,
  reject,
  rollback,
  textOf,
  type CheckVerdict,
  type ResearchSession,
  type Role,
  type Runtime
} from '@evoscholar/core'
import { createJournalAgentStore, type AgentEvent, type AgentMessage, type ContentBlock } from '@evoscholar/harness'

type ApprovalEntry = { id: string; tool: string; summary: string; resolve: (ok: boolean) => void }

type Live = {
  rs: ResearchSession
  clients: Set<ServerResponse>
  busy: boolean
  approvals: Map<string, ApprovalEntry>
  seenTool: Set<string>
}

const SKILL_MODE: Record<string, string> = {
  'literature-review': 'literature',
  'writing-check': 'writing',
  'research-integrity': 'writing',
  'figure-style': 'figure',
  'figure-composer': 'figure',
  'tikz-diagram': 'figure',
  'data-tables': 'data',
  'ml-results': 'data',
  'ml-curves': 'data',
  'optics-spectra': 'data',
  'optics-fields': 'data',
  'device-curves': 'data'
}

const IMG = /\.(png|jpe?g|gif|webp|svg)$/i
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.tex': 'text/plain; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8'
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function serveFile(res: ServerResponse, file: string) {
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
}

async function body(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > limit) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function displayMessages(messages: readonly AgentMessage[]) {
  return messages
    .filter((m) => m.role !== 'summary')
    .map((m) => ({
      id: m.id,
      role: m.role,
      text: m.role === 'tool' ? textOf(m.content).slice(0, 3000) : textOf(m.content),
      images: m.content.filter((b) => b.type === 'image').length,
      calls: (m.calls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      isError: !!m.isError
    }))
}

/** Newest image the session produced (not an uploaded input), for optional card previews. */
function latestImage(cwd: string): string | undefined {
  let best: { rel: string; t: number } | undefined
  const walk = (d: string, depth: number) => {
    let names: string[] = []
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      if (n.startsWith('.') || n === 'inputs' || n === 'node_modules') continue
      const f = join(d, n)
      let st
      try { st = statSync(f) } catch { continue }
      if (st.isDirectory()) {
        if (depth > 0) walk(f, depth - 1)
      } else if (IMG.test(n) && !/\.preview\.png$/.test(n) && (!best || st.mtimeMs > best.t)) {
        best = { rel: relative(cwd, f), t: st.mtimeMs }
      }
    }
  }
  walk(cwd, 2)
  return best?.rel
}

function listCwd(cwd: string) {
  const out: { path: string; size: number; mtimeMs: number }[] = []
  const walk = (d: string, depth: number) => {
    let names: string[] = []
    try { names = readdirSync(d).sort() } catch { return }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules') continue
      const f = join(d, n)
      let st
      try { st = statSync(f) } catch { continue }
      if (st.isDirectory()) {
        if (depth > 0) walk(f, depth - 1)
      } else {
        out.push({ path: relative(cwd, f), size: st.size, mtimeMs: Math.round(st.mtimeMs) })
      }
      if (out.length > 300) return
    }
  }
  walk(cwd, 3)
  return out
}

function setEnvKey(root: string, name: string, value: string) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('无效的环境变量名')
  const file = join(root, '.env')
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
  const i = lines.findIndex((l) => l.startsWith(`${name}=`) || l.startsWith(`# ${name}=`))
  const line = `${name}=${value}`
  if (i >= 0) lines[i] = line
  else lines.push(line)
  writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 })
  if (value) process.env[name] = value
  else delete process.env[name]
}

export function createServerApp(rt: Runtime, opts: { webDir: string; alerts?: string[] }) {
  const ws = rt.ws
  const WEB = resolve(opts.webDir)
  const alerts = opts.alerts ?? []
  const live = new Map<string, Live>()
  const evo = { running: false, log: [] as string[], runId: '' as string, ctrl: undefined as AbortController | undefined }

  const broadcast = (l: Live, e: Record<string, unknown>) => {
    const line = `data: ${JSON.stringify(e)}\n\n`
    for (const c of l.clients) c.write(line)
  }
  const broadcastAll = (e: Record<string, unknown>) => {
    for (const l of live.values()) broadcast(l, e)
  }
  const resetIdleSessions = async () => {
    for (const l of live.values()) {
      if (!l.busy) {
        await l.rs.dispose()
        live.delete(l.rs.id)
      }
    }
  }

  const requireSessionRow = (id: string) => {
    if (!/^[\w-]+$/.test(id)) throw Object.assign(new Error('无效的会话 ID'), { status: 400 })
    const row = rt.db.prepare('SELECT id, title, created_at, genome_id, COALESCE(pinned, 0) AS pinned, COALESCE(archived, 0) AS archived FROM sessions WHERE id = ?').get(id) as
      | { id: string; title: string | null; created_at: string; genome_id: string; pinned: number; archived: number }
      | undefined
    if (!row) throw Object.assign(new Error('会话不存在'), { status: 404 })
    return row
  }

  async function getLive(id: string, create?: { title?: string; cwd?: string }): Promise<Live> {
    if (!/^[\w-]+$/.test(id)) throw Object.assign(new Error('无效的会话 ID'), { status: 400 })
    const existing = live.get(id)
    if (existing) return existing
    const row = rt.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as { title?: string } | undefined
    if (!row && !create) throw Object.assign(new Error('会话不存在'), { status: 404 })
    const l = { clients: new Set(), busy: false, approvals: new Map(), seenTool: new Set() } as unknown as Live
    const onEvent = (e: AgentEvent) => {
      if (e.type === 'model' && e.purpose !== 'compaction') {
        const ev = e.event
        if (ev.type === 'text-delta') broadcast(l, { type: 'text', text: ev.text })
        else if (ev.type === 'reasoning-delta') broadcast(l, { type: 'reasoning', text: ev.text })
        else if (ev.type === 'finish' && ev.calls?.length)
          for (const c of ev.calls) broadcast(l, { type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments })
      } else if (e.type === 'checkpoint') {
        for (const m of e.checkpoint.messages.slice(-6))
          if (m.role === 'tool' && !l.seenTool.has(m.id)) {
            l.seenTool.add(m.id)
            broadcast(l, { type: 'tool-result', invocationId: m.invocationId, isError: !!m.isError, preview: textOf(m.content).slice(0, 1500) })
          }
      } else if (e.type === 'compaction') broadcast(l, { type: 'compaction', status: e.status })
    }
    l.rs = await openResearchSession(rt, {
      sessionId: id,
      title: create?.title ?? row?.title,
      cwd: create?.cwd,
      category: 'usage',
      onEvent,
      onWarning: (m) => broadcast(l, { type: 'warning', message: m }),
      approve: (tool, summary) =>
        new Promise<boolean>((resolveApproval) => {
          const aid = randomUUID().slice(0, 8)
          l.approvals.set(aid, { id: aid, tool, summary, resolve: resolveApproval })
          broadcast(l, { type: 'approval', id: aid, tool, summary })
        })
    })
    const snap = await l.rs.session.snapshot()
    for (const m of snap.messages) if (m.role === 'tool') l.seenTool.add(m.id)
    live.set(id, l)
    return l
  }

  function listSessions(archived = false) {
    const rows = rt.db
      .prepare(
        `SELECT s.id, s.title, s.created_at, s.genome_id, COALESCE(s.pinned, 0) AS pinned, COALESCE(s.archived, 0) AS archived,
                COUNT(t.id) AS turns, COALESCE(SUM(t.cost_cny),0) AS cost,
                MAX(t.ts_start) AS last,
                (SELECT prompt FROM turns WHERE session_id = s.id ORDER BY id LIMIT 1) AS preview,
                (SELECT group_concat(type || ':' || COALESCE(json_extract(payload, '$.name'), ''), ',') FROM events
                   WHERE session_id = s.id AND type IN ('host.skill.read', 'host.manuscript.check', 'host.figure.check')) AS signals
           FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
          WHERE s.category = 'usage' AND COALESCE(s.archived, 0) = ? GROUP BY s.id ORDER BY COALESCE(s.pinned, 0) DESC, COALESCE(MAX(t.ts_start), s.created_at) DESC LIMIT 200`
      )
      .all(archived ? 1 : 0) as Record<string, unknown>[]
    return rows.map((r, i) => {
      const id = String(r.id)
      const sig = String(r.signals ?? '')
      const modes = new Set<string>()
      for (const part of sig.split(',').filter(Boolean)) {
        const [type, name] = part.split(':')
        if (type === 'host.manuscript.check') modes.add('writing')
        else if (type === 'host.figure.check') modes.add('figure')
        else if (SKILL_MODE[name]) modes.add(SKILL_MODE[name])
      }
      const mode = ['writing', 'figure', 'literature', 'data'].find((m) => modes.has(m)) ?? 'chat'
      const thumb = !archived && i < 60 ? latestImage(join(ws.dataDir, 'projects', id)) : undefined
      const l = live.get(id)
      const { signals: _s, ...rest } = r
      return {
        ...rest,
        pinned: !!r.pinned,
        archived: !!r.archived,
        running: !!l?.busy,
        pendingApprovals: l?.approvals.size ?? 0,
        preview: r.preview ? String(r.preview).slice(0, 240) : null,
        mode,
        thumb: thumb ?? null
      }
    })
  }

  function sessionSummary(id: string) {
    const row = requireSessionRow(id)
    const cwd = live.get(id)?.rs.cwd ?? join(ws.dataDir, 'projects', id)
    const stats = rt.db
      .prepare(
        `SELECT COUNT(*) AS turns, COALESCE(SUM(steps),0) AS steps, COALESCE(SUM(tool_calls),0) AS toolCalls,
                COALESCE(SUM(tool_errors),0) AS toolErrors, COALESCE(SUM(input_tokens),0) AS inputTokens,
                COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cost_cny),0) AS costCny
           FROM turns WHERE session_id = ?`
      )
      .get(id) as Record<string, number>

    const evRows = rt.db
      .prepare(`SELECT type, payload, ts FROM events WHERE session_id = ? AND type IN ('host.skill.read', 'host.manuscript.check', 'host.figure.check') ORDER BY id`)
      .all(id) as { type: string; payload: string; ts: string }[]

    const usedSkillsMap = new Map<string, { name: string; version?: number; ts: string }>()
    const checks: { kind: string; file?: string; venue?: string | null; packs?: string[]; ok?: boolean; issues?: number; ts: string }[] = []
    for (const r of evRows) {
      let p: Record<string, any> = {}
      try { p = JSON.parse(r.payload) } catch { continue }
      if (r.type === 'host.skill.read' && p.name) {
        usedSkillsMap.set(String(p.name), { name: String(p.name), version: p.version, ts: r.ts })
      } else if (r.type === 'host.manuscript.check' || r.type === 'host.figure.check') {
        checks.push({ kind: r.type === 'host.manuscript.check' ? 'manuscript' : 'figure', file: p.file, venue: p.venue, packs: p.packs, ok: p.ok, issues: p.issues, ts: r.ts })
      }
    }

    // Load latest feedback verdicts keyed by file#finding#rule across all sessions
    const fbRows = rt.db.prepare(`SELECT payload FROM events WHERE type = 'host.check.feedback' ORDER BY id`).all() as { payload: string }[]
    const verdicts = new Map<string, CheckVerdict>()
    for (const r of fbRows) {
      try {
        const p = JSON.parse(r.payload)
        if (p.file && p.finding && p.rule && p.verdict) verdicts.set(`${p.file}#${p.finding}#${p.rule}`, p.verdict as CheckVerdict)
      } catch {}
    }

    const checksDir = join(cwd, '.evoscholar', 'checks')
    const reports: unknown[] = []
    if (existsSync(checksDir)) {
      const dirs = readdirSync(checksDir)
        .map((name) => ({ name, jsonPath: join(checksDir, name, 'report.json') }))
        .filter((x) => existsSync(x.jsonPath))
        .sort((a, b) => statSync(b.jsonPath).mtimeMs - statSync(a.jsonPath).mtimeMs)
      for (const d of dirs.slice(0, 10)) {
        try {
          const rep = JSON.parse(readFileSync(d.jsonPath, 'utf8')) as {
            summary: { file: string; packs?: string[]; variant?: string | null; stage?: string }
            counts: Record<string, number>
            findings: { id: string; rule: string; severity: string; loc: string; message: string; evidence?: string; source?: string; pack?: string }[]
            verify?: string[]
          }
          const findings = (rep.findings ?? []).slice(0, 200).map((f) => ({
            ...f,
            verdict: verdicts.get(`${rep.summary?.file}#${f.id}#${f.rule}`) ?? null
          }))
          reports.push({
            dir: d.name,
            summary: rep.summary,
            counts: rep.counts,
            findings,
            truncated: (rep.findings ?? []).length > 200,
            verify: (rep.verify ?? []).slice(0, 30)
          })
        } catch {}
      }
    }

    return {
      id: row.id,
      title: row.title,
      pinned: !!row.pinned,
      genomeId: row.genome_id,
      cwd,
      stats,
      usedSkills: [...usedSkillsMap.values()],
      checks,
      reports
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname
    const m = (re: RegExp) => re.exec(p)
    // Mutations require a custom header, which browsers cannot send cross-site without CORS approval.
    if (req.method !== 'GET' && req.headers['x-evoscholar'] !== '1') return send(res, 403, { error: 'missing x-evoscholar header' })

    if (p === '/api/state' && req.method === 'GET') {
      const g = rt.genomes.load()
      return send(res, 200, {
        genome: { id: g.id, note: g.note, roles: g.routing.roles, tools: g.tools.enabled, budgets: g.budgets, parent: g.parent },
        genomes: rt.genomes.list(),
        providers: listProviders(ws.config),
        reasoningEffort: ws.config.reasoningEffort ?? {},
        budget: rt.ledger.summary(),
        protectedLimits: PROTECTED_LIMITS,
        evolutionConfig: ws.config.evolution,
        peak: isDeepSeekPeak(),
        sessions: listSessions(),
        pending: (rt.db.prepare(`SELECT COUNT(*) n FROM candidates WHERE status = 'pending'`).get() as { n: number }).n,
        alerts
      })
    }
    if (p === '/api/budget' && req.method === 'GET') {
      return send(res, 200, {
        summary: rt.ledger.summary(),
        peak: isDeepSeekPeak(),
        recent: rt.db.prepare('SELECT ts, category, kind, model, input_tokens, cache_read_tokens, output_tokens, peak, cost_cny, estimated FROM ledger ORDER BY id DESC LIMIT 50').all()
      })
    }
    if (p === '/api/capabilities' && req.method === 'GET') {
      return send(res, 200, getCapabilities(rt))
    }
    if (p === '/api/sessions' && req.method === 'GET') {
      const archived = url.searchParams.get('archived') === '1'
      return send(res, 200, { sessions: listSessions(archived) })
    }
    if (p === '/api/sessions' && req.method === 'POST') {
      const b = await body(req)
      const id = `s-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
      const l = await getLive(id, { title: String(b.title ?? '新会话').slice(0, 80) })
      return send(res, 200, { id, cwd: l.rs.cwd })
    }

    let mm = m(/^\/api\/sessions\/([\w-]+)$/)
    if (mm && req.method === 'GET') {
      const row = requireSessionRow(mm[1])
      const l = await getLive(mm[1])
      const snap = await l.rs.session.snapshot()
      return send(res, 200, {
        id: mm[1],
        title: row.title,
        pinned: !!row.pinned,
        archived: !!row.archived,
        cwd: l.rs.cwd,
        busy: l.busy,
        genome: l.rs.genome.id,
        messages: displayMessages(snap.messages),
        pendingApprovals: [...l.approvals.values()].map(({ id, tool, summary }) => ({ id, tool, summary }))
      })
    }
    if (mm && req.method === 'PATCH') {
      const id = mm[1]
      const row = requireSessionRow(id)
      const b = await body(req)
      const nextTitle = b.title !== undefined ? String(b.title).trim().slice(0, 80) || row.title || id : row.title
      const nextPinned = b.pinned !== undefined ? (b.pinned ? 1 : 0) : row.pinned
      const nextArchived = b.archived !== undefined ? (b.archived ? 1 : 0) : row.archived
      rt.db.prepare('UPDATE sessions SET title = ?, pinned = ?, archived = ? WHERE id = ?').run(nextTitle, nextPinned, nextArchived, id)
      return send(res, 200, { ok: true, id, title: nextTitle, pinned: !!nextPinned, archived: !!nextArchived })
    }
    if (mm && req.method === 'DELETE') {
      const id = mm[1]
      requireSessionRow(id)
      const existing = live.get(id)
      if (existing?.busy) return send(res, 409, { error: '会话正在运行中，请先停止后再删除' })
      if (existing) {
        await existing.rs.dispose().catch(() => {})
        live.delete(id)
      }
      rt.db.exec('BEGIN IMMEDIATE')
      try {
        rt.db.prepare('DELETE FROM events WHERE session_id = ?').run(id)
        rt.db.prepare('DELETE FROM turns WHERE session_id = ?').run(id)
        rt.db.prepare('DELETE FROM feedback WHERE session_id = ?').run(id)
        rt.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
        rt.db.exec('COMMIT')
      } catch (err) {
        rt.db.exec('ROLLBACK')
        throw err
      }
      const projectsRoot = join(ws.dataDir, 'projects')
      const projDir = inside(projectsRoot, id)
      if (existsSync(projDir)) rmSync(projDir, { recursive: true, force: true })
      const store = createJournalAgentStore({ directory: join(ws.dataDir, 'sessions') })
      await store.delete(id).catch(() => {})
      return send(res, 200, { ok: true })
    }

    mm = m(/^\/api\/sessions\/([\w-]+)\/fork$/)
    if (mm && req.method === 'POST') {
      const srcId = mm[1]
      const row = requireSessionRow(srcId)
      const newId = `s-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
      const newTitle = `${(row.title || srcId).slice(0, 72)} (分支)`
      const store = createJournalAgentStore({ directory: join(ws.dataDir, 'sessions') })
      const srcState = await store.load(srcId)
      if (srcState) {
        await store.commit(newId, null, {
          version: srcState.version,
          sessionId: newId,
          revision: 0,
          messages: structuredClone(srcState.messages),
          compactions: structuredClone(srcState.compactions ?? []),
          requests: [],
          pending: []
        })
      }
      rt.db
        .prepare(`INSERT INTO sessions (id, created_at, genome_id, title, stage, category, pinned, archived) VALUES (?,?,?,?,?,?,0,0)`)
        .run(newId, new Date().toISOString(), rt.genomes.activeId(), newTitle, null, 'usage')
      const srcProj = join(ws.dataDir, 'projects', srcId)
      const dstProj = join(ws.dataDir, 'projects', newId)
      mkdirSync(join(dstProj, '.evoscholar'), { recursive: true })
      if (existsSync(join(srcProj, 'inputs'))) cpSync(join(srcProj, 'inputs'), join(dstProj, 'inputs'), { recursive: true })
      return send(res, 200, { id: newId, title: newTitle })
    }

    mm = m(/^\/api\/sessions\/([\w-]+)\/summary$/)
    if (mm && req.method === 'GET') {
      return send(res, 200, sessionSummary(mm[1]))
    }

    mm = m(/^\/api\/sessions\/([\w-]+)\/check-feedback$/)
    if (mm && req.method === 'POST') {
      const id = mm[1]
      requireSessionRow(id)
      const b = await body(req)
      const verdict = VERDICTS[String(b.verdict ?? '')]
      if (!verdict) return send(res, 400, { error: 'verdict 只能是 valid、false_positive 或 unsure' })
      const ids = Array.isArray(b.ids) ? b.ids.map(String).filter((x: string) => /^F\d{3,4}$/.test(x)) : []
      if (!ids.length || ids.length > 200) return send(res, 400, { error: '请提供合法的问题编号列表（如 F001）' })
      const cwd = live.get(id)?.rs.cwd ?? join(ws.dataDir, 'projects', id)
      const checksDir = join(cwd, '.evoscholar', 'checks')
      let reportPath: string | undefined
      if (b.reportDir) {
        reportPath = inside(checksDir, join(String(b.reportDir), 'report.json'))
      } else if (existsSync(checksDir)) {
        reportPath = readdirSync(checksDir)
          .map((d) => join(checksDir, d, 'report.json'))
          .filter((f) => existsSync(f))
          .sort((a, c) => statSync(c).mtimeMs - statSync(a).mtimeMs)[0]
      }
      if (!reportPath || !existsSync(reportPath)) return send(res, 404, { error: '未找到稿件检查报告' })
      const report = readCheckReport(reportPath)
      const note = b.note ? String(b.note).slice(0, 500) : undefined
      const { events, missing } = feedbackEvents(report, ids, verdict, note)
      if (!events.length) return send(res, 400, { error: `报告中未找到编号：${missing.join('、')}` })
      recordCheckFeedback(rt, events, id)
      return send(res, 200, { ok: true, recorded: events.length, missing, verdict })
    }

    mm = m(/^\/api\/sessions\/([\w-]+)\/events$/)
    if (mm && req.method === 'GET') {
      const l = await getLive(mm[1])
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify({ type: 'hello', busy: l.busy })}\n\n`)
      l.clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 20000)
      req.on('close', () => { clearInterval(ping); l.clients.delete(res) })
      return
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/ask$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      if (l.busy) return send(res, 409, { error: '上一轮还在运行' })
      const b = await body(req)
      const blocks: ContentBlock[] = [{ type: 'text', text: String(b.text ?? '') }]
      for (const img of (b.images ?? []) as { mimeType: string; data: string }[])
        if (/^image\/(png|jpeg|gif|webp)$/.test(img.mimeType)) blocks.push({ type: 'image', mimeType: img.mimeType, source: `data:${img.mimeType};base64,${img.data}` })
      l.busy = true
      broadcast(l, { type: 'status', status: 'running' })
      send(res, 202, { ok: true })
      l.rs
        .ask(blocks)
        .then(({ status }) => broadcast(l, { type: 'status', status }))
        .catch((e) => broadcast(l, { type: 'error', message: (e instanceof BudgetError ? '预算拦截：' : '') + (e as Error).message }))
        .finally(() => {
          l.busy = false
          for (const entry of l.approvals.values()) entry.resolve(false)
          l.approvals.clear()
          broadcast(l, { type: 'done', budget: rt.ledger.summary() })
        })
      return
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/cancel$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      l.rs.session.cancel()
      return send(res, 200, { ok: true })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/approve\/(\w+)$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      const entry = l.approvals.get(mm[2])
      if (!entry) return send(res, 404, { error: '审批已失效' })
      const b = await body(req)
      l.approvals.delete(mm[2])
      entry.resolve(!!b.allow)
      broadcast(l, { type: 'approval-resolved', id: mm[2], allow: !!b.allow })
      return send(res, 200, { ok: true })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/feedback$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      const b = await body(req)
      if (!['thumb', 'rating', 'comment', 'accept', 'rerun'].includes(b.kind)) return send(res, 400, { error: 'kind' })
      l.rs.recorder.feedback(b.kind, typeof b.value === 'number' ? b.value : null, b.note ? String(b.note).slice(0, 2000) : undefined)
      return send(res, 200, { ok: true })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/files$/)
    if (mm && req.method === 'GET') {
      requireSessionRow(mm[1])
      const cwd = live.get(mm[1])?.rs.cwd ?? join(ws.dataDir, 'projects', mm[1])
      return send(res, 200, { cwd, files: existsSync(cwd) ? listCwd(cwd) : [] })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/file$/)
    if (mm && req.method === 'GET') {
      requireSessionRow(mm[1])
      const cwd = live.get(mm[1])?.rs.cwd ?? join(ws.dataDir, 'projects', mm[1])
      const f = inside(cwd, url.searchParams.get('path') ?? '')
      if (!existsSync(f) || statSync(f).isDirectory()) return send(res, 404, { error: 'not found' })
      return serveFile(res, f)
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/upload$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      const b = await body(req)
      const name = basename(String(b.name ?? '').replace(/[\\/]/g, '_'))
      if (!name || name === '.' || name === '..') return send(res, 400, { error: 'name' })
      const f = inside(l.rs.cwd, join('inputs', name))
      mkdirSync(join(l.rs.cwd, 'inputs'), { recursive: true })
      writeFileSync(f, Buffer.from(String(b.data ?? ''), 'base64'))
      return send(res, 200, { path: relative(l.rs.cwd, f) })
    }
    if (p === '/api/keys' && req.method === 'POST') {
      const b = await body(req)
      const prov = listProviders(ws.config).find((x) => x.id === b.provider)
      if (!prov) return send(res, 404, { error: '未知厂商' })
      setEnvKey(ws.root, prov.apiKeyEnv, String(b.key ?? '').trim())
      if (process.env[prov.apiKeyEnv] && prov.modelsListUrl) {
        await refreshProviderModels(ws.config, prov.id).catch(() => {})
      }
      return send(res, 200, { ok: true, hasKey: !!process.env[prov.apiKeyEnv] })
    }
    if (p === '/api/providers/refresh' && req.method === 'POST') {
      const b = await body(req)
      const targets = b.provider
        ? [String(b.provider)]
        : listProviders(ws.config).filter((x) => x.hasKey && x.modelsListUrl).map((x) => x.id)
      const results: Record<string, unknown> = {}
      for (const id of targets) results[id] = await refreshProviderModels(ws.config, id)
      return send(res, 200, { ok: true, results, providers: listProviders(ws.config) })
    }
    if (p === '/api/providers/effort' && req.method === 'POST') {
      const b = await body(req)
      const model = String(b.model ?? '')
      const effort = String(b.effort ?? '').trim()
      const known = new Set(listProviders(ws.config).flatMap((pv) => pv.models.map((md) => `${pv.id}/${md.id}`)))
      if (!known.has(model)) return send(res, 400, { error: `未知模型 ${model}` })
      const cap = modelInfo(ws.config, model).reasoningEffort
      if (effort && effort !== 'default') {
        if (!cap?.supported) return send(res, 400, { error: `模型 ${model} 不支持思考程度设置` })
        if (cap.values?.length && !cap.values.includes(effort)) return send(res, 400, { error: `不支持的思考程度：${effort}` })
      }
      const cfgFile = join(ws.root, 'evoscholar.config.json')
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
      cfg.reasoningEffort = cfg.reasoningEffort ?? {}
      if (!effort || effort === 'default') delete cfg.reasoningEffort[model]
      else cfg.reasoningEffort[model] = effort
      writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n')
      ws.config.reasoningEffort = cfg.reasoningEffort
      await resetIdleSessions()
      return send(res, 200, { ok: true, reasoningEffort: ws.config.reasoningEffort })
    }
    if (p === '/api/providers/custom' && req.method === 'POST') {
      const b = await body(req)
      const id = String(b.id ?? '').toLowerCase()
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) return send(res, 400, { error: 'id 只能用小写字母、数字和 -' })
      const endpoint = new URL(String(b.endpoint))
      if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
        return send(res, 400, { error: '远程网关必须使用 https' })
      const protocol = ['chat-completions', 'messages', 'responses'].includes(b.protocol) ? b.protocol : 'chat-completions'
      const models = String(b.models ?? '').split(/[\s,]+/).filter(Boolean).map((x: string) => ({ id: x }))
      const cfgFile = join(ws.root, 'evoscholar.config.json')
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
      cfg.providers = cfg.providers ?? {}
      cfg.providers[id] = { label: String(b.label || id), endpoint: endpoint.toString(), protocol, apiKeyEnv: `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`, models }
      writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n')
      ws.config.providers = cfg.providers
      if (b.key) setEnvKey(ws.root, cfg.providers[id].apiKeyEnv, String(b.key).trim())
      return send(res, 200, { ok: true })
    }
    if (p === '/api/genome/roles' && req.method === 'POST') {
      const b = await body(req)
      const roles = b.roles as Partial<Record<Role, string>>
      const known = new Set(listProviders(ws.config).flatMap((pv) => pv.models.map((md) => `${pv.id}/${md.id}`)))
      for (const v of Object.values(roles ?? {})) if (!known.has(String(v))) return send(res, 400, { error: `未知模型 ${v}` })
      const changed = Object.entries(roles).map(([k, v]) => `${k}=${v}`).join(', ')
      const g = rt.genomes.deriveManual((x) => Object.assign(x.routing.roles, roles), `手动切换模型：${changed}`)
      await resetIdleSessions()
      return send(res, 200, { genome: g.id })
    }

    if (p === '/api/evolution' && req.method === 'GET') {
      const g = rt.genomes.load()
      const bench = new Bench(rt.ws.root)
      return send(res, 200, {
        active: { id: g.id, parent: g.parent ?? null, note: g.note ?? '' },
        benchmark: bench.label,
        peak: isDeepSeekPeak(),
        candidates: listCandidates(rt),
        lineage: lineage(rt),
        runs: rt.db.prepare('SELECT id, ts_start, ts_end, base_genome, status, cost_cny FROM evolution_runs ORDER BY ts_start DESC LIMIT 20').all(),
        running: { active: evo.running, runId: evo.runId, log: evo.log.slice(-200) }
      })
    }
    if (p === '/api/evolution/run' && req.method === 'POST') {
      if (evo.running) return send(res, 409, { error: '已经有一轮进化在运行' })
      const b = await body(req)
      evo.running = true
      evo.log = []
      evo.runId = ''
      evo.ctrl = new AbortController()
      const stamp = () => new Date().toTimeString().slice(0, 8)
      evolveRound(rt, { dryRun: !!b.dryRun, force: !!b.force, signal: evo.ctrl.signal, onProgress: (msg) => evo.log.push(`${stamp()} ${msg}`) })
        .then((rep) => {
          evo.runId = rep.runId
          evo.log.push(`${stamp()} 本轮 ${rep.runId} 结束：${rep.status}，花费 ¥${rep.costCny.toFixed(3)}`)
        })
        .catch((e) => evo.log.push(`${stamp()} 未能启动：${(e as Error).message}`))
        .finally(() => {
          evo.running = false
          evo.ctrl = undefined
        })
      return send(res, 202, { ok: true })
    }
    mm = m(/^\/api\/evolution\/(g-[\w-]+)$/)
    if (mm && req.method === 'GET') {
      const d = candidateDetail(rt, mm[1])
      const brief = (g?: { id: string; status: string; parent?: string | null; note?: string; createdBy: string }) =>
        g && { id: g.id, status: g.status, parent: g.parent ?? null, note: g.note ?? '', createdBy: g.createdBy }
      return send(res, 200, { ...d, genome: brief(d.genome), parent: brief(d.parent) })
    }
    mm = m(/^\/api\/evolution\/(g-[\w-]+)\/(promote|reject)$/)
    if (mm && req.method === 'POST') {
      const b = await body(req)
      if (mm[2] === 'promote') promote(rt, mm[1])
      else reject(rt, mm[1], b.reason ? String(b.reason).slice(0, 300) : undefined)
      await resetIdleSessions()
      return send(res, 200, { ok: true, active: rt.genomes.activeId() })
    }
    if (p === '/api/genome/rollback' && req.method === 'POST') {
      const b = await body(req)
      const g = rollback(rt, b.to ? String(b.to) : undefined)
      await resetIdleSessions()
      return send(res, 200, { ok: true, active: g.id })
    }

    if (req.method === 'GET' && !p.startsWith('/api/')) {
      const f = resolve(WEB, '.' + (p === '/' ? '/index.html' : p))
      if (f.startsWith(WEB) && existsSync(f) && statSync(f).isFile()) return serveFile(res, f)
      return serveFile(res, join(WEB, 'index.html'))
    }
    send(res, 404, { error: 'not found' })
  }

  return {
    broadcastAll,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      route(req, res).catch((e) => {
        const status = (e as { status?: number }).status ?? 500
        if (!res.headersSent) send(res, status, { error: (e as Error).message })
        else res.end()
      })
    },
    async dispose() {
      for (const l of live.values()) await l.rs.dispose().catch(() => {})
      live.clear()
    }
  }
}
