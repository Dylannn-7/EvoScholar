import type { IncomingMessage, ServerResponse } from 'node:http'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { IMG, body, httpError, send, serveFile } from './http'
import { serveProjectFile } from './file-preview'
import { createV2Routes } from './routes-v2'
import { createLocalAuth } from './local-auth'
import {
  Bench,
  BudgetError,
  FILE_LIMITS,
  MiB_BYTES,
  PROTECTED_LIMITS,
  VERDICTS,
  base64DecodedBytes,
  candidateDetail,
  evolveRound,
  feedbackEvents,
  getCapabilities,
  inside,
  isDeepSeekPeak,
  lineage,
  listCandidates,
  listProjects,
  listProviders,
  modelInfo,
  openResearchSession,
  projectFiles,
  promote,
  readCheckReport,
  recordCheckFeedback,
  IN_DIR,
  OUT_DIR,
  PERMISSION_MODES,
  PLAN_MODE_NOTE,
  getProject,
  indexFiles,
  sessionCwd,
  type ApprovalKind,
  type PermissionMode,
  reject,
  rollback,
  textOf,
  type CheckVerdict,
  type ResearchSession,
  type Runtime
} from '@evoscholar/core'
import { createJournalAgentStore, type AgentEvent, type AgentMessage, type ContentBlock } from '@evoscholar/harness'

type ApprovalEntry = { id: string; tool: string; summary: string; kind: ApprovalKind; resolve: (ok: boolean) => void }
type ChoiceEntry = { id: string; question: string; options: { label: string; detail?: string }[]; resolve: (i: number | null) => void }

type SessionMeta = { projectId: string | null; cwd: string; model: string | null; effort: string | null; permission: PermissionMode }
type Live = {
  rs: ResearchSession
  meta: SessionMeta
  clients: Set<ServerResponse>
  busy: boolean
  approvals: Map<string, ApprovalEntry>
  choices: Map<string, ChoiceEntry>
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
      try { st = lstatSync(f) } catch { continue }
      if (st.isDirectory()) {
        if (depth > 0) walk(f, depth - 1)
      } else if (st.isFile() && IMG.test(n) && !/\.preview\.png$/.test(n) && (!best || st.mtimeMs > best.t)) {
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
      try { st = lstatSync(f) } catch { continue }
      if (st.isDirectory()) {
        if (depth > 0) walk(f, depth - 1)
      } else if (st.isFile()) {
        out.push({ path: relative(cwd, f), size: st.size, mtimeMs: Math.round(st.mtimeMs) })
      }
      if (out.length > 300) return
    }
  }
  walk(cwd, 3)
  return out
}

// The repository (or packaged app) root sits three levels above apps/server/dist.
const APP_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')).version) } catch { return '' }
})()

export function createServerApp(rt: Runtime, opts: { webDir: string; alerts?: string[]; auth?: ReturnType<typeof createLocalAuth> }) {
  const ws = rt.ws
  const auth = opts.auth ?? createLocalAuth()
  const WEB = resolve(opts.webDir)
  const alerts = opts.alerts ?? []
  const live = new Map<string, Live>()
  const opening = new Map<string, Promise<Live>>()
  const starting = new Set<string>()
  const lastAcceptedAsk = new Map<string, string>()
  const evo = { running: false, log: [] as string[], runId: '' as string, ctrl: undefined as AbortController | undefined }

  const broadcast = (l: Live, e: Record<string, unknown>) => {
    const line = `data: ${JSON.stringify(e)}\n\n`
    for (const c of l.clients) {
      if (c.destroyed || c.writableLength > 256 * 1024) c.destroy()
      else c.write(line)
    }
  }
  const cancelLive = (l: Live) => {
    l.rs.session.cancel()
    for (const entry of l.approvals.values()) entry.resolve(false)
    for (const entry of l.choices.values()) entry.resolve(null)
    l.approvals.clear()
    l.choices.clear()
  }
  const endClients = (l: Live) => {
    for (const client of l.clients) client.end()
    l.clients.clear()
  }
  const broadcastAll = (e: Record<string, unknown>) => {
    for (const l of live.values()) broadcast(l, e)
  }
  const resetIdleSessions = async () => {
    for (const l of [...live.values()]) {
      if (live.get(l.rs.id) === l && !l.busy && !starting.has(l.rs.id)) {
        live.delete(l.rs.id)
        endClients(l)
        await l.rs.dispose()
      }
    }
  }

  /** After a turn: index everything under the session's output folder (scripts may write files we did not see). */
  const indexOutputs = (l: Live) => {
    const outRoot = l.meta.projectId ? inside(l.rs.cwd, join(OUT_DIR, l.rs.id)) : l.rs.cwd
    if (!existsSync(outRoot)) return
    const files: string[] = []
    const walk = (d: string, depth: number) => {
      let names: string[] = []
      try { names = readdirSync(d) } catch { return }
      for (const n of names) {
        if (n.startsWith('.') || n === 'node_modules' || n === IN_DIR || files.length > 500) continue
        const f = join(d, n)
        let st
        try { st = lstatSync(f) } catch { continue }
        if (st.isDirectory()) { if (depth > 0) walk(f, depth - 1) } else if (st.isFile()) files.push(relative(l.rs.cwd, f))
      }
    }
    walk(outRoot, 4)
    indexFiles(rt.db, { root: l.meta.cwd, projectId: l.meta.projectId, sessionId: l.rs.id }, files, 'output')
  }
  const v2 = createV2Routes(rt, { resetIdleSessions: () => resetIdleSessions() })

  const requireSessionRow = (id: string) => {
    if (!/^[\w-]+$/.test(id)) throw Object.assign(new Error('无效的会话 ID'), { status: 400 })
    const row = rt.db.prepare('SELECT id, title, created_at, genome_id, COALESCE(pinned, 0) AS pinned, COALESCE(archived, 0) AS archived, cwd FROM sessions WHERE id = ?').get(id) as
      | { id: string; title: string | null; created_at: string; genome_id: string; pinned: number; archived: number; cwd: string | null }
      | undefined
    if (!row) throw Object.assign(new Error('会话不存在'), { status: 404 })
    return row
  }

  const sessionDirectory = (id: string) => {
    const row = requireSessionRow(id)
    return live.get(id)?.rs.cwd ?? row.cwd ?? join(ws.dataDir, 'projects', id)
  }

  type CreateOpts = { title?: string; projectId?: string | null; model?: string | null; effort?: string | null; permission?: PermissionMode }
  const metaFor = (id: string, row: Record<string, unknown> | undefined, create?: CreateOpts): SessionMeta => {
    const projectId = (create?.projectId ?? row?.project_id ?? null) as string | null
    const project = projectId ? getProject(rt.db, projectId) : undefined
    if (projectId && !project) throw httpError(404, '项目不存在')
    const cwd = (row?.cwd as string | null) ?? sessionCwd(ws, project, id)
    const permission = (create?.permission ?? row?.permission ?? ws.settings.defaults.permission ?? 'ask') as PermissionMode
    return {
      projectId,
      cwd,
      model: (create?.model ?? row?.model ?? null) as string | null,
      effort: (create?.effort ?? row?.effort ?? null) as string | null,
      permission: PERMISSION_MODES.includes(permission) ? permission : 'ask'
    }
  }
  const saveMeta = (id: string, m: SessionMeta) =>
    rt.db.prepare('UPDATE sessions SET project_id = ?, cwd = ?, model = ?, effort = ?, permission = ? WHERE id = ?').run(m.projectId, m.cwd, m.model, m.effort, m.permission, id)

  async function getLive(id: string, create?: CreateOpts, clients?: Live['clients']): Promise<Live> {
    if (!/^[\w-]+$/.test(id)) throw httpError(400, '无效的会话 ID')
    const existing = live.get(id)
    if (existing) return existing
    const pending = opening.get(id)
    if (pending) return pending
    const next = openLive(id, create, clients)
    opening.set(id, next)
    try { return await next } finally { opening.delete(id) }
  }

  async function openLive(id: string, create?: CreateOpts, clients?: Live['clients']): Promise<Live> {
    const row = rt.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row && !create) throw Object.assign(new Error('会话不存在'), { status: 404 })
    const l = { clients: clients ?? new Set<ServerResponse>(), busy: false, approvals: new Map(), choices: new Map(), seenTool: new Set() } as unknown as Live
    l.meta = metaFor(id, row, create)
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
    const outputDir = l.meta.projectId ? `${OUT_DIR}/${id}` : OUT_DIR
    l.rs = await openResearchSession(rt, {
      sessionId: id,
      title: create?.title ?? (row?.title as string | undefined),
      cwd: l.meta.cwd,
      model: l.meta.model ?? undefined,
      effort: l.meta.effort ?? undefined,
      permission: () => l.meta.permission,
      outputDir,
      onFiles: (paths) => indexFiles(rt.db, { root: l.meta.cwd, projectId: l.meta.projectId, sessionId: id }, paths, 'output'),
      evolve: {
        store: rt.evolve,
        projectId: l.meta.projectId,
        emit: (e) => broadcast(l, { type: 'evolve', ...e }),
        choose: (question, options, signal) =>
          new Promise<number | null>((resolveChoice) => {
            if (signal?.aborted || l.meta.permission === 'bypass') return resolveChoice(null)
            const cid = randomUUID().slice(0, 8)
            const cancel = () => {
              l.choices.delete(cid)
              resolveChoice(null)
            }
            signal?.addEventListener('abort', cancel, { once: true })
            l.choices.set(cid, { id: cid, question, options, resolve: (index) => {
              signal?.removeEventListener('abort', cancel)
              resolveChoice(index)
            } })
            broadcast(l, { type: 'choice', id: cid, question, options })
          })
      },
      category: 'usage',
      onEvent,
      onWarning: (m) => broadcast(l, { type: 'warning', message: m }),
      approve: (tool, summary, kind = 'exec', signal) =>
        new Promise<boolean>((resolveApproval) => {
          if (signal?.aborted) return resolveApproval(false)
          const aid = randomUUID().slice(0, 8)
          const cancel = () => {
            l.approvals.delete(aid)
            resolveApproval(false)
          }
          signal?.addEventListener('abort', cancel, { once: true })
          l.approvals.set(aid, { id: aid, tool, summary, kind, resolve: (ok) => {
            signal?.removeEventListener('abort', cancel)
            resolveApproval(ok)
          } })
          broadcast(l, { type: 'approval', id: aid, tool, summary, kind })
        })
    })
    saveMeta(id, { ...l.meta, model: l.meta.model ?? l.rs.model })
    const snap = await l.rs.session.snapshot()
    for (const m of snap.messages) if (m.role === 'tool') l.seenTool.add(m.id)
    live.set(id, l)
    return l
  }

  function listSessions(archived = false) {
    const rows = rt.db
      .prepare(
        `SELECT s.id, s.title, s.created_at, s.genome_id, COALESCE(s.pinned, 0) AS pinned, COALESCE(s.archived, 0) AS archived,
                s.project_id AS projectId, s.model, s.effort, s.permission,
                (SELECT root || char(1) || path FROM library WHERE session_id = s.id AND kind = 'output'
                   AND lower(path) GLOB '*.[pjsgw][npvie][gfgb]*' ORDER BY updated_at DESC LIMIT 1) AS libThumb,
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
      const lib = r.libThumb ? String(r.libThumb).split('\u0001') : undefined
      const thumb = lib && IMG.test(lib[1]) ? lib[1] : !archived && i < 60 && !r.projectId ? latestImage(join(ws.dataDir, 'projects', id)) : undefined
      const l = live.get(id)
      const { signals: _s, libThumb: _t, ...rest } = r
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
    const cwd = sessionDirectory(id)
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
    const checks: { kind: string; file?: string; venue?: string | null; packs?: string[]; ok?: boolean; status?: string; issues?: number; ts: string }[] = []
    for (const r of evRows) {
      let p: Record<string, any> = {}
      try { p = JSON.parse(r.payload) } catch { continue }
      if (r.type === 'host.skill.read' && p.name) {
        usedSkillsMap.set(String(p.name), { name: String(p.name), version: p.version, ts: r.ts })
      } else if (r.type === 'host.manuscript.check' || r.type === 'host.figure.check') {
        checks.push({ kind: r.type === 'host.manuscript.check' ? 'manuscript' : 'figure', file: p.file, venue: p.venue, packs: p.packs, ok: p.ok, status: p.status, issues: p.issues, ts: r.ts })
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

    const checksDir = existsSync(cwd) ? inside(cwd, join('.evoscholar', 'checks')) : join(cwd, '.evoscholar', 'checks')
    const reports: unknown[] = []
    if (existsSync(checksDir)) {
      const dirs = readdirSync(checksDir)
        .flatMap((name) => {
          try {
            const jsonPath = inside(cwd, join(checksDir, name, 'report.json'))
            return statSync(jsonPath, { throwIfNoEntry: false })?.isFile() ? [{ name, jsonPath }] : []
          } catch { return [] }
        })
        .sort((a, b) => statSync(b.jsonPath).mtimeMs - statSync(a.jsonPath).mtimeMs)
      for (const d of dirs.slice(0, 10)) {
        try {
          const rep = JSON.parse(readFileSync(d.jsonPath, 'utf8')) as {
            summary: { file: string; source_path?: string; packs?: string[]; variant?: string | null; stage?: string }
            counts: Record<string, number>
            findings: { id: string; rule: string; severity: string; loc: string; message: string; evidence?: string; source?: string; pack?: string }[]
            verify?: string[]
          }
          const file = rep.summary?.file
          let source = rep.summary?.source_path
          if (!source && file && /\.(tex|pdf)$/i.test(file)) {
            // Older reports recorded the source in the session trace and stored only its name in JSON.
            source = checks.findLast((item) => item.kind === 'manuscript' && item.file && basename(item.file) === file)?.file
            if (!source) {
              const matches = projectFiles(cwd, file).filter((item) => basename(item.path) === file)
              if (matches.length === 1) source = matches[0].path
            }
          }
          const existingSource = (path: string) => {
            try {
              const absolute = inside(cwd, path)
              return statSync(absolute, { throwIfNoEntry: false })?.isFile() ? absolute : undefined
            } catch { return undefined }
          }
          const sourceFile = source ? existingSource(source) : undefined
          const rel = (path: string) => relative(inside(cwd, '.'), path).split(sep).join('/')
          const locationFor = (loc: string) => {
            if (!sourceFile || typeof loc !== 'string') return undefined
            if (/\.pdf$/i.test(sourceFile)) {
              const page = Number(/^p\.([1-9]\d*)$/.exec(loc)?.[1])
              if (Number.isSafeInteger(page)) return { path: rel(sourceFile), page }
            } else if (/\.tex$/i.test(sourceFile)) {
              const match = /^(.+\.tex):([1-9]\d*)$/i.exec(loc)
              if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined
              const path = existingSource(resolve(dirname(sourceFile), match[1]))
              if (path) return { path: rel(path), line: Number(match[2]) }
            }
            return undefined
          }
          const findings = (rep.findings ?? []).slice(0, 200).map((f) => ({
            ...f,
            location: locationFor(f.loc),
            verdict: verdicts.get(`${file}#${f.id}#${f.rule}`) ?? null
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
    // DNS-rebinding guard: the API only answers to loopback host names.
    const host = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/.exec(req.headers.host ?? '')
    if (!host || Number(host[2] ?? 80) !== req.socket.localPort)
      return send(res, 403, { error: '无效的本机 Host' })
    if (p.startsWith('/api/') && (req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)))
      return send(res, 403, { error: '工作台接口仅限同源访问' })
    if (p === '/api/auth/pair' && req.method === 'POST') {
      const credentials = await body(req, 1024)
      const { status, ...result } = auth.exchange(credentials.code)
      return send(res, status, result)
    }
    let grant: string | undefined
    if (p === '/api' || p.startsWith('/api/')) {
      grant = auth.verify(req.headers.authorization)
      if (!grant) return send(res, 401, { error: '请先配对工作台' })
      ws.config.localHttpPort = req.socket.localPort
      if (await v2(req, res, url)) return
    }

    if (p === '/api/state' && req.method === 'GET') {
      const g = rt.genomes.load()
      return send(res, 200, {
        genome: { id: g.id, note: g.note, tools: g.tools.enabled, parent: g.parent },
        providers: listProviders(ws.config).map(({ models, ...pv }) => ({ ...pv, models: pv.hasKey ? models : [] })),
        defaults: ws.settings.defaults,
        efforts: ws.settings.efforts,
        projects: listProjects(rt.db),
        sessions: listSessions(),
        pending: (rt.db.prepare(`SELECT COUNT(*) n FROM candidates WHERE status = 'pending'`).get() as { n: number }).n,
        app: { version: APP_VERSION, workspace: ws.root },
        alerts
      })
    }
    if (p === '/api/workspace/reveal' && req.method === 'POST') {
      const [cmd, args] = process.platform === 'darwin' ? ['open', [ws.root]]
        : process.platform === 'win32' ? ['explorer.exe', [ws.root]] : ['xdg-open', [ws.root]]
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
      child.on('error', () => {})
      child.unref()
      return send(res, 200, { ok: true })
    }
    if (p === '/api/budget' && req.method === 'GET') {
      return send(res, 200, {
        scope: 'dev-and-history',
        notice: '开发与历史花费（日常使用只统计 token，不统计金额）',
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
      const l = await getLive(id, {
        title: String(b.title ?? '新会话').slice(0, 80),
        projectId: b.projectId ? String(b.projectId) : null,
        model: b.model ? String(b.model) : null,
        effort: b.effort ? String(b.effort) : null,
        permission: PERMISSION_MODES.includes(b.permission) ? b.permission : undefined
      })
      return send(res, 200, { id, cwd: l.rs.cwd, projectId: l.meta.projectId })
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
        projectId: l.meta.projectId,
        model: l.rs.model,
        effort: l.rs.effort ?? null,
        permission: l.meta.permission,
        busy: l.busy,
        genome: l.rs.genome.id,
        messages: displayMessages(snap.messages),
        pendingApprovals: [...l.approvals.values()].map(({ id, tool, summary, kind }) => ({ id, tool, summary, kind })),
        pendingChoices: [...l.choices.values()].map(({ id, question, options }) => ({ id, question, options })),
        evolve: rt.evolve.recentLog({ sessionId: mm[1], limit: 300 }).reverse(),
        turns: (rt.db.prepare('SELECT id FROM turns WHERE session_id = ? ORDER BY id').all(mm[1]) as { id: number }[]).map((t) => t.id)
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
      if (existing?.busy || opening.has(id) || starting.has(id)) return send(res, 409, { error: '会话正在运行中，请先停止后再删除' })
      if (existing) {
        endClients(existing)
        live.delete(id)
        await existing.rs.dispose().catch(() => {})
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
      lastAcceptedAsk.delete(id)
      rt.db.prepare('DELETE FROM library WHERE session_id = ? AND project_id IS NULL').run(id)
      rt.db.prepare('UPDATE library SET session_id = NULL WHERE session_id = ?').run(id)
      // Only the private drafts folder is removed; a project folder belongs to the user.
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
          // Unfinished calls travel with the messages that reference them; the next prompt settles them.
          pending: structuredClone(srcState.pending ?? [])
        })
      }
      rt.db
        .prepare(`INSERT INTO sessions (id, created_at, genome_id, title, stage, category, pinned, archived) VALUES (?,?,?,?,?,?,0,0)`)
        .run(newId, new Date().toISOString(), rt.genomes.activeId(), newTitle, null, 'usage')
      rt.evolve.inheritExternalSource(srcId, newId)
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
      const cwd = sessionDirectory(id)
      const checksDir = existsSync(cwd) ? inside(cwd, join('.evoscholar', 'checks')) : join(cwd, '.evoscholar', 'checks')
      let reportPath: string | undefined
      if (b.reportDir) {
        if (!existsSync(checksDir)) return send(res, 404, { error: '未找到稿件检查报告' })
        reportPath = inside(checksDir, join(String(b.reportDir), 'report.json'))
      } else if (existsSync(checksDir)) {
        reportPath = readdirSync(checksDir)
          .flatMap((d) => {
            try {
              const f = inside(cwd, join(checksDir, d, 'report.json'))
              return statSync(f, { throwIfNoEntry: false })?.isFile() ? [f] : []
            } catch { return [] }
          })
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
      if (res.destroyed || !grant || !auth.watch(grant, res)) return
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify({ type: 'hello', busy: l.busy })}\n\n`)
      l.clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 20000)
      res.once('close', () => { clearInterval(ping); l.clients.delete(res) })
      return
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/ask$/)
    if (mm && req.method === 'POST') {
      const id = mm[1]
      const b = await body(req)
      const requestId = typeof b.requestId === 'string' && /^[0-9a-f-]{36}$/.test(b.requestId) ? b.requestId : undefined
      if (requestId && lastAcceptedAsk.get(id) === requestId) return send(res, 202, { ok: true, alreadyAccepted: true })
      if (starting.has(id)) return send(res, 409, { error: '上一轮还在运行' })
      starting.add(id)
      try {
        let l = await getLive(id)
        if (l.busy) return send(res, 409, { error: '上一轮还在运行' })
        // Model / effort chosen in the composer: reopen the session (journal store keeps history).
        const wantModel = b.model ? String(b.model) : l.rs.model
        const wantEffort = b.effort !== undefined ? (String(b.effort) || null) : l.meta.effort
        if (b.permission !== undefined && PERMISSION_MODES.includes(b.permission)) l.meta.permission = b.permission
        if (wantModel !== l.rs.model || (wantEffort ?? null) !== (l.rs.effort ?? null)) {
          const meta = { ...l.meta, model: wantModel, effort: wantEffort }
          saveMeta(id, meta)
          const clients = l.clients
          await l.rs.dispose().catch(() => {})
          live.delete(id)
          try { l = await getLive(id, undefined, clients) } catch (error) {
            endClients(l)
            throw error
          }
        }
        saveMeta(id, l.meta)
        let text = String(b.text ?? '')
        const blocks: ContentBlock[] = []
        // Attachments: files already uploaded into evoscholar-in/. Images also go to the model when it can see.
        const attachments = (Array.isArray(b.attachments) ? b.attachments : []).map(String).slice(0, 20)
        const refs = (Array.isArray(b.refs) ? b.refs : []).map(String).slice(0, 20)
        const vision = modelInfo(ws.config, l.rs.model).vision
        const notes: string[] = []
        let imageCount = 0
        let imageTotalBytes = 0
        /** Referenced project images that do not fit are passed by path instead of failing the message. */
        const fitsImageLimits = (bytes: number) => bytes <= FILE_LIMITS.imageBytes &&
          imageCount < FILE_LIMITS.messageImagesMax && imageTotalBytes + bytes <= FILE_LIMITS.messageImagesTotalBytes
        const checkImageLimits = (bytes: number, label: string) => {
          if (bytes > FILE_LIMITS.imageBytes) {
            throw httpError(413, `图片 ${label} 超过单张上限 ${Math.round(FILE_LIMITS.imageBytes / MiB_BYTES)} MB（当前 ${(bytes / MiB_BYTES).toFixed(1)} MB），请先缩小后重试`)
          }
          imageCount++
          if (imageCount > FILE_LIMITS.messageImagesMax) {
            throw httpError(413, `单条消息最多附带 ${FILE_LIMITS.messageImagesMax} 张图片，请减少图片数量后重试`)
          }
          imageTotalBytes += bytes
          if (imageTotalBytes > FILE_LIMITS.messageImagesTotalBytes) {
            throw httpError(413, `单条消息图片总大小超过 ${Math.round(FILE_LIMITS.messageImagesTotalBytes / MiB_BYTES)} MB 上限，请减少或压缩图片后重试`)
          }
        }
        const attached = new Set(attachments)
        for (const rel of [...attachments, ...refs]) {
          const f = inside(l.rs.cwd, rel)
          if (!existsSync(f) || !statSync(f).isFile()) continue
          const ext = extname(f).toLowerCase()
          const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : ''
          if (mime && vision) {
            const size = statSync(f).size
            if (!attached.has(rel) && !fitsImageLimits(size)) { notes.push(rel); continue }
            checkImageLimits(size, rel)
            blocks.push({ type: 'image', mimeType: mime, source: `data:${mime};base64,${readFileSync(f).toString('base64')}`, filename: basename(f) })
            notes.push(`${rel}（图片，已附在消息里）`)
          } else notes.push(rel)
        }
        if (notes.length) text += `\n\n[${attachments.length ? '附件' : '引用文件'}] ${notes.join('；')}`
        for (const img of (Array.isArray(b.images) ? b.images : []) as { mimeType?: string; data?: string }[]) {
          const mimeType = String(img?.mimeType ?? '')
          if (/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) {
            const data = String(img?.data ?? '')
            checkImageLimits(base64DecodedBytes(data), `第 ${imageCount + 1} 张`)
            blocks.push({ type: 'image', mimeType, source: `data:${mimeType};base64,${data}` })
          }
        }
        if (l.meta.permission === 'plan') text = `${PLAN_MODE_NOTE}\n\n${text}`
        blocks.unshift({ type: 'text', text })
        const live0 = l
        live0.busy = true
        if (requestId) lastAcceptedAsk.set(id, requestId)
        broadcast(live0, { type: 'status', status: 'running', requestId, model: live0.rs.model, effort: live0.rs.effort ?? null, permission: live0.meta.permission })
        send(res, 202, { ok: true })
        live0.rs
          .ask(blocks)
          .then(({ status }) => broadcast(live0, { type: 'status', status }))
          .catch((e) => broadcast(live0, { type: 'error', message: (e as Error).message }))
          .finally(() => {
            live0.busy = false
            for (const entry of live0.approvals.values()) entry.resolve(false)
            live0.approvals.clear()
            for (const entry of live0.choices.values()) entry.resolve(null)
            live0.choices.clear()
            try { indexOutputs(live0) } catch {
              broadcast(live0, { type: 'warning', message: '部分交付文件无法建立索引' })
            }
            broadcast(live0, { type: 'done' })
          })
      } finally { starting.delete(id) }
      return
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/settings$/)
    if (mm && req.method === 'PATCH') {
      const l = await getLive(mm[1])
      const b = await body(req)
      if (b.permission !== undefined) {
        if (!PERMISSION_MODES.includes(b.permission)) throw httpError(400, '未知权限模式')
        l.meta.permission = b.permission
      }
      if (b.model !== undefined && !l.busy) l.meta.model = String(b.model) || null
      if (b.effort !== undefined && !l.busy) l.meta.effort = String(b.effort) || null
      saveMeta(mm[1], l.meta)
      return send(res, 200, { ok: true, ...l.meta })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/cancel$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      cancelLive(l)
      return send(res, 200, { ok: true })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/approve\/(\w+)$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      const b = await body(req)
      const entry = l.approvals.get(mm[2])
      if (!entry) return send(res, 404, { error: '审批已失效' })
      if (typeof b.allow !== 'boolean') throw httpError(400, '审批结果必须为布尔值')
      l.approvals.delete(mm[2])
      entry.resolve(b.allow)
      broadcast(l, { type: 'approval-resolved', id: mm[2], allow: b.allow })
      return send(res, 200, { ok: true })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/choice\/(\w+)$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      const b = await body(req)
      const entry = l.choices.get(mm[2])
      if (!entry) return send(res, 404, { error: '选项已失效' })
      l.choices.delete(mm[2])
      const idx = Number.isInteger(b.index) && b.index >= 0 && b.index < entry.options.length ? b.index : null
      entry.resolve(idx)
      broadcast(l, { type: 'choice-resolved', id: mm[2], index: idx })
      return send(res, 200, { ok: true })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/feedback$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      const b = await body(req)
      if (!['thumb', 'rating', 'comment', 'accept', 'rerun'].includes(b.kind)) return send(res, 400, { error: 'kind' })
      l.rs.recorder.feedback(b.kind, typeof b.value === 'number' ? b.value : null, b.note ? String(b.note).slice(0, 2000) : undefined)
      if (b.kind === 'thumb' && typeof b.value === 'number') l.rs.evolve?.userFeedback(b.value)
      if (b.kind === 'comment' && b.note) {
        try { rt.evolve.upsert({ kind: 'preference', trigger: '用户对回答的评价', content: String(b.note).slice(0, 300), source: 'user', projectId: l.meta.projectId, evidence: l.rs.id }) } catch {}
      }
      return send(res, 200, { ok: true })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/files$/)
    if (mm && req.method === 'GET') {
      const cwd = sessionDirectory(mm[1])
      return send(res, 200, { cwd, files: existsSync(cwd) ? listCwd(cwd) : [] })
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/file$/)
    if (mm && req.method === 'GET') {
      const cwd = sessionDirectory(mm[1])
      const f = inside(cwd, url.searchParams.get('path') ?? '')
      if (!existsSync(f) || !statSync(f).isFile()) return send(res, 404, { error: 'not found' })
      return await serveProjectFile(rt, res, f, url.searchParams)
    }
    mm = m(/^\/api\/sessions\/([\w-]+)\/upload$/)
    if (mm && req.method === 'POST') {
      const l = await getLive(mm[1])
      const b = await body(req)
      const name = basename(String(b.name ?? '').replace(/[\\/]/g, '_'))
      if (!name || name === '.' || name === '..') return send(res, 400, { error: 'name' })
      const dir = inside(l.rs.cwd, IN_DIR)
      mkdirSync(dir, { recursive: true })
      let f = inside(l.rs.cwd, join(IN_DIR, name))
      for (let i = 2; existsSync(f) && i < 100; i++) f = inside(l.rs.cwd, join(IN_DIR, name.replace(/(\.[^.]*)?$/, `-${i}$1`)))
      try { writeFileSync(f, Buffer.from(String(b.data ?? ''), 'base64'), { flag: 'wx' }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        throw httpError(409, '同名附件过多，请修改文件名后重试')
      }
      const rel = relative(l.rs.cwd, f).split(/[\\/]/).join('/')
      indexFiles(rt.db, { root: l.meta.cwd, projectId: l.meta.projectId, sessionId: l.rs.id }, [rel], 'upload')
      return send(res, 200, { path: rel, image: IMG.test(name) })
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
      const b = await body(req)
      if (evo.running) return send(res, 409, { error: '已经有一轮进化在运行' })
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
      try {
        if (mm[2] === 'promote') promote(rt, mm[1], { confirmUnverified: b.confirmUnverified === true })
        else reject(rt, mm[1], b.reason ? String(b.reason).slice(0, 300) : undefined)
      } catch (e) {
        const err = e as Error & { status?: number }
        throw httpError(err.status ?? 400, err.message)
      }
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
        if (!res.headersSent) {
          if (status === 413) res.setHeader('connection', 'close')
          send(res, status, { error: (e as Error).message })
        }
        else res.end()
      })
    },
    async dispose() {
      evo.ctrl?.abort()
      await Promise.allSettled(opening.values())
      for (const l of live.values()) {
        cancelLive(l)
        endClients(l)
        await l.rs.dispose().catch(() => {})
      }
      live.clear()
    }
  }
}
