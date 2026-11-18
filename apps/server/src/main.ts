#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  BudgetError,
  candidateDetail,
  evolveRound,
  inside,
  lineage,
  listCandidates,
  promote,
  reject,
  rollback,
  listProviders,
  openResearchSession,
  openRuntime,
  openWorkspace,
  textOf,
  type ResearchSession,
  type Role
} from '@evoscholar/core'
import type { AgentEvent, AgentMessage, ContentBlock } from '@evoscholar/harness'

const ws = openWorkspace()
const alerts: string[] = []
const rt = openRuntime(ws, (m) => { alerts.push(m); broadcastAll({ type: 'warning', message: m }) })
const PORT = Number(process.env.EVOSCHOLAR_PORT ?? 4317)
const WEB = resolve(__dirname, '../../web/public')

type Live = {
  rs: ResearchSession
  clients: Set<ServerResponse>
  busy: boolean
  approvals: Map<string, (ok: boolean) => void>
  seenTool: Set<string>
}
const live = new Map<string, Live>()

/** At most one evolution round at a time, driven from the web panel. */
const evo = { running: false, log: [] as string[], runId: '' as string, ctrl: undefined as AbortController | undefined }
async function resetIdleSessions() {
  for (const l of live.values()) if (!l.busy) { await l.rs.dispose(); live.delete(l.rs.id) }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
function broadcast(l: Live, e: Record<string, unknown>) {
  const line = `data: ${JSON.stringify(e)}\n\n`
  for (const c of l.clients) c.write(line)
}
function broadcastAll(e: Record<string, unknown>) {
  for (const l of live.values()) broadcast(l, e)
}
async function body(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > limit) throw new Error('请求体过大')
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

async function getLive(id: string, create?: { title?: string; cwd?: string }): Promise<Live> {
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
        l.approvals.set(aid, resolveApproval)
        broadcast(l, { type: 'approval', id: aid, tool, summary })
      })
  })
  const snap = await l.rs.session.snapshot()
  for (const m of snap.messages) if (m.role === 'tool') l.seenTool.add(m.id)
  live.set(id, l)
  return l
}

function listSessions() {
  return rt.db
    .prepare(
      `SELECT s.id, s.title, s.created_at, s.genome_id, COUNT(t.id) AS turns, COALESCE(SUM(t.cost_cny),0) AS cost,
              MAX(t.ts_start) AS last
         FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
        WHERE s.category = 'usage' GROUP BY s.id ORDER BY COALESCE(MAX(t.ts_start), s.created_at) DESC LIMIT 200`
    )
    .all()
}

function setEnvKey(name: string, value: string) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('无效的环境变量名')
  const file = join(ws.root, '.env')
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
  const i = lines.findIndex((l) => l.startsWith(`${name}=`) || l.startsWith(`# ${name}=`))
  const line = `${name}=${value}`
  if (i >= 0) lines[i] = line
  else lines.push(line)
  writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 })
  if (value) process.env[name] = value
  else delete process.env[name]
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8', '.tex': 'text/plain; charset=utf-8'
}
function serveFile(res: ServerResponse, file: string) {
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
}

function listCwd(cwd: string) {
  const out: { path: string; size: number }[] = []
  const walk = (d: string, depth: number) => {
    for (const n of readdirSync(d).sort()) {
      if (n.startsWith('.') || n === 'node_modules') continue
      const f = join(d, n)
      const st = statSync(f)
      if (st.isDirectory()) { if (depth > 0) walk(f, depth - 1) } else out.push({ path: relative(cwd, f), size: st.size })
      if (out.length > 300) return
    }
  }
  walk(cwd, 3)
  return out
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
      budget: rt.ledger.summary(),
      sessions: listSessions(),
      alerts
    })
  }
  if (p === '/api/budget' && req.method === 'GET')
    return send(res, 200, {
      summary: rt.ledger.summary(),
      recent: rt.db.prepare('SELECT ts, category, kind, model, input_tokens, cache_read_tokens, output_tokens, peak, cost_cny FROM ledger ORDER BY id DESC LIMIT 50').all()
    })
  if (p === '/api/sessions' && req.method === 'POST') {
    const b = await body(req)
    const id = `s-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
    const l = await getLive(id, { title: String(b.title ?? '新会话').slice(0, 80) })
    return send(res, 200, { id, cwd: l.rs.cwd })
  }
  let mm = m(/^\/api\/sessions\/([\w-]+)$/)
  if (mm && req.method === 'GET') {
    const l = await getLive(mm[1])
    const snap = await l.rs.session.snapshot()
    return send(res, 200, { id: mm[1], cwd: l.rs.cwd, busy: l.busy, genome: l.rs.genome.id, messages: displayMessages(snap.messages) })
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
        for (const r of l.approvals.values()) r(false)
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
    const r = l.approvals.get(mm[2])
    if (!r) return send(res, 404, { error: '审批已失效' })
    const b = await body(req)
    l.approvals.delete(mm[2])
    r(!!b.allow)
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
    const l = await getLive(mm[1])
    return send(res, 200, { cwd: l.rs.cwd, files: listCwd(l.rs.cwd) })
  }
  mm = m(/^\/api\/sessions\/([\w-]+)\/file$/)
  if (mm && req.method === 'GET') {
    const l = await getLive(mm[1])
    const f = inside(l.rs.cwd, url.searchParams.get('path') ?? '')
    if (!existsSync(f) || statSync(f).isDirectory()) return send(res, 404, { error: 'not found' })
    return serveFile(res, f)
  }
  mm = m(/^\/api\/sessions\/([\w-]+)\/upload$/)
  if (mm && req.method === 'POST') {
    const l = await getLive(mm[1])
    const b = await body(req)
    const name = String(b.name ?? '').replace(/[\\/]/g, '_')
    if (!name) return send(res, 400, { error: 'name' })
    const f = inside(l.rs.cwd, join('inputs', name))
    mkdirSync(join(l.rs.cwd, 'inputs'), { recursive: true })
    writeFileSync(f, Buffer.from(String(b.data ?? ''), 'base64'))
    return send(res, 200, { path: relative(l.rs.cwd, f) })
  }
  if (p === '/api/keys' && req.method === 'POST') {
    const b = await body(req)
    const prov = listProviders(ws.config).find((x) => x.id === b.provider)
    if (!prov) return send(res, 404, { error: '未知厂商' })
    setEnvKey(prov.apiKeyEnv, String(b.key ?? '').trim())
    return send(res, 200, { ok: true, hasKey: !!process.env[prov.apiKeyEnv] })
  }
  if (p === '/api/providers/custom' && req.method === 'POST') {
    const b = await body(req)
    const id = String(b.id ?? '').toLowerCase()
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) return send(res, 400, { error: 'id 只能用小写字母、数字和 -' })
    const endpoint = new URL(String(b.endpoint))
    if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) return send(res, 400, { error: '远程网关必须使用 https' })
    const protocol = ['chat-completions', 'messages', 'responses'].includes(b.protocol) ? b.protocol : 'chat-completions'
    const models = String(b.models ?? '').split(/[\s,]+/).filter(Boolean).map((m: string) => ({ id: m }))
    const cfgFile = join(ws.root, 'evoscholar.config.json')
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
    cfg.providers = cfg.providers ?? {}
    cfg.providers[id] = { label: String(b.label || id), endpoint: endpoint.toString(), protocol, apiKeyEnv: `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`, models }
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n')
    ws.config.providers = cfg.providers
    if (b.key) setEnvKey(cfg.providers[id].apiKeyEnv, String(b.key).trim())
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
    return send(res, 200, {
      active: { id: g.id, parent: g.parent ?? null, note: g.note ?? '' },
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
    evolveRound(rt, { dryRun: !!b.dryRun, force: !!b.force, signal: evo.ctrl.signal, onProgress: (m) => evo.log.push(`${stamp()} ${m}`) })
      .then((rep) => { evo.runId = rep.runId; evo.log.push(`${stamp()} 本轮 ${rep.runId} 结束：${rep.status}，花费 ¥${rep.costCny.toFixed(3)}`) })
      .catch((e) => evo.log.push(`${stamp()} 未能启动：${(e as Error).message}`))
      .finally(() => { evo.running = false; evo.ctrl = undefined })
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

  // static frontend
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const f = resolve(WEB, '.' + (p === '/' ? '/index.html' : p))
    if (f.startsWith(WEB) && existsSync(f) && statSync(f).isFile()) return serveFile(res, f)
    return serveFile(res, join(WEB, 'index.html'))
  }
  send(res, 404, { error: 'not found' })
}

const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = (e as { status?: number }).status ?? 500
    if (!res.headersSent) send(res, status, { error: (e as Error).message })
    else res.end()
  })
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`EvoScholar 工作台：http://127.0.0.1:${PORT}`)
  console.log(`当前 genome：${rt.genomes.activeId()} · 已花费 ¥${rt.ledger.summary().totalCny.toFixed(4)} / ¥${ws.config.budget.totalCny}`)
})
const shutdown = async () => {
  for (const l of live.values()) await l.rs.dispose().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
