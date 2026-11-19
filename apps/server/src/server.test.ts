import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { join, resolve } from 'node:path'
import { openRuntime, openWorkspace } from '@evoscholar/core'
import { createServerApp } from './server'
import { body, send } from './http'
import { setEnvKey } from './routes-v2'

const REPO = resolve(__dirname, '../../..')
const WEB = resolve(REPO, 'apps/web/public')

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-srv-'))
  cpSync(join(REPO, 'evoscholar.config.json'), join(dir, 'evoscholar.config.json'))
  cpSync(join(REPO, 'genomes'), join(dir, 'genomes'), { recursive: true })
  cpSync(join(REPO, 'prompts'), join(dir, 'prompts'), { recursive: true })
  cpSync(join(REPO, 'skills'), join(dir, 'skills'), { recursive: true })
  cpSync(join(REPO, 'rulepacks', 'figures'), join(dir, 'rulepacks', 'figures'), { recursive: true })
  cpSync(join(REPO, 'rulepacks', 'writing'), join(dir, 'rulepacks', 'writing'), { recursive: true })
  mkdirSync(join(dir, 'data'))
  writeFileSync(join(dir, '.env'), '')
  return dir
}

test('server endpoints: sessions CRUD, summary, check-feedback, capabilities, and static UI', async (t) => {
  const dir = tempWorkspace()
  const ws = openWorkspace(dir)
  const rt = openRuntime(ws, () => {})
  const app = createServerApp(rt, { webDir: WEB })
  const srv = createServer(app.handler)

  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()))
  const addr = srv.address() as { port: number }
  const base = `http://127.0.0.1:${addr.port}`
  const H = { 'content-type': 'application/json', 'x-evoscholar': '1' }

  t.after(async () => {
    await app.dispose()
    await new Promise<void>((res) => srv.close(() => res()))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // Static UI modules load cleanly
  for (const path of ['/', '/style.css', '/app.js', '/ui/modal.js', '/ui/markdown.js', '/ui/views.js']) {
    const res = await fetch(`${base}${path}`)
    assert.equal(res.status, 200, `GET ${path}`)
  }

  // CSRF guard blocks mutations without x-evoscholar header
  const unauth = await fetch(`${base}/api/sessions`, { method: 'POST', body: '{}' })
  assert.equal(unauth.status, 403)

  // Capabilities endpoint
  const cap = (await (await fetch(`${base}/api/capabilities`)).json()) as Record<string, any>
  assert.ok(Array.isArray(cap.skills) && cap.skills.length > 0)
  assert.ok(Array.isArray(cap.figureRulepacks) && cap.figureRulepacks.length > 0)
  assert.ok(Array.isArray(cap.writingRulepacks) && cap.writingRulepacks.length > 0)

  // Create two sessions, pin & rename the first, verify sorting puts pinned first
  const s1 = (await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'First' }) })).json()) as { id: string; cwd: string }
  const s2 = (await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Second' }) })).json()) as { id: string; cwd: string }

  const patched = (await (await fetch(`${base}/api/sessions/${s1.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ title: 'Renamed First', pinned: true }) })).json()) as { title: string; pinned: boolean }
  assert.equal(patched.title, 'Renamed First')
  assert.equal(patched.pinned, true)

  const st = (await (await fetch(`${base}/api/state`)).json()) as { sessions: { id: string; title: string; pinned: boolean }[]; protectedLimits: Record<string, number> }
  assert.equal(st.sessions[0].id, s1.id)
  assert.equal(st.sessions[0].title, 'Renamed First')
  assert.equal(st.sessions[0].pinned, true)

  writeFileSync(join(s1.cwd, 'output.html'), '<p>fixture</p>')
  const artifact = await fetch(`${base}/api/sessions/${s1.id}/file?path=output.html`)
  assert.match(artifact.headers.get('content-security-policy') ?? '', /^sandbox/)
  assert.equal(artifact.headers.get('content-disposition'), 'attachment')
  assert.equal(await artifact.text(), '<p>fixture</p>')

  // Place a mock manuscript check report and record feedback through the endpoint
  const checkDir = join(s1.cwd, '.evoscholar', 'checks', 'draft')
  mkdirSync(checkDir, { recursive: true })
  writeFileSync(
    join(checkDir, 'report.json'),
    JSON.stringify({
      summary: { file: 'draft.tex', packs: ['common', 'hust-thesis'], variant: 'doctor', stage: 'submission' },
      counts: { error: 1, warning: 0, info: 0 },
      findings: [{ id: 'F001', rule: 'common.abbreviations', severity: 'warning', loc: 'draft.tex:12', message: '未定义缩写 XYZ', pack: 'common' }],
      verify: []
    })
  )

  const fbRes = await fetch(`${base}/api/sessions/${s1.id}/check-feedback`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ reportDir: 'draft', ids: ['F001'], verdict: 'false_positive', note: '专有缩写' })
  })
  assert.equal(fbRes.status, 200)

  const sum = (await (await fetch(`${base}/api/sessions/${s1.id}/summary`)).json()) as { reports: { findings: { id: string; verdict: string }[] }[] }
  assert.equal(sum.reports.length, 1)
  assert.equal(sum.reports[0].findings[0].verdict, 'false_positive')

  // Remembered reasoning effort per model: unsupported values are ignored, supported ones persist.
  await fetch(`${base}/api/settings/defaults`, { method: 'PUT', headers: H, body: JSON.stringify({ efforts: { 'deepseek/deepseek-flash': 'ultra' } }) })
  let stEff = (await (await fetch(`${base}/api/state`)).json()) as { efforts: Record<string, string> }
  assert.equal(stEff.efforts['deepseek/deepseek-flash'], undefined)
  const okEff = await fetch(`${base}/api/settings/defaults`, { method: 'PUT', headers: H, body: JSON.stringify({ efforts: { 'deepseek/deepseek-flash': 'max' } }) })
  assert.equal(okEff.status, 200)
  stEff = (await (await fetch(`${base}/api/state`)).json()) as { efforts: Record<string, string> }
  assert.equal(stEff.efforts['deepseek/deepseek-flash'], 'max')

  // Fork s1 -> creates a new session referencing the same workspace branch
  const forkRes = await fetch(`${base}/api/sessions/${s1.id}/fork`, { method: 'POST', headers: H, body: '{}' })
  assert.equal(forkRes.status, 200)
  const forked = (await forkRes.json()) as { id: string; title: string }
  assert.ok(forked.title.includes('分支'))

  // Archive forked session -> hidden from active list, returned in archived list, and restorable
  const archRes = await fetch(`${base}/api/sessions/${forked.id}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ archived: true })
  })
  assert.equal(archRes.status, 200)
  const activeAfterArch = (await (await fetch(`${base}/api/state`)).json()) as { sessions: { id: string }[] }
  assert.equal(activeAfterArch.sessions.some((x) => x.id === forked.id), false)

  const archList = (await (await fetch(`${base}/api/sessions?archived=1`)).json()) as { sessions: { id: string; archived: boolean }[] }
  assert.ok(archList.sessions.some((x) => x.id === forked.id && x.archived === true))

  await fetch(`${base}/api/sessions/${forked.id}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ archived: false })
  })
  const activeAfterRestore = (await (await fetch(`${base}/api/state`)).json()) as { sessions: { id: string }[] }
  assert.ok(activeAfterRestore.sessions.some((x) => x.id === forked.id))
  await fetch(`${base}/api/sessions/${forked.id}`, { method: 'DELETE', headers: H })

  // Delete s2 cleanly
  const delRes = await fetch(`${base}/api/sessions/${s2.id}`, { method: 'DELETE', headers: H })
  assert.equal(delRes.status, 200)
  assert.equal(existsSync(s2.cwd), false)
  const afterGet = await fetch(`${base}/api/sessions/${s2.id}`)
  assert.equal(afterGet.status, 404)
})

test('v2 endpoints: model settings, projects, uploads into the library, usage, host guard', async (t) => {
  const dir = tempWorkspace()
  const proj = mkdtempSync(join(tmpdir(), 'evo-srv-proj-'))
  writeFileSync(join(proj, 'notes.md'), '# 笔记')
  const ws = openWorkspace(dir)
  const rt = openRuntime(ws, () => {})
  const app = createServerApp(rt, { webDir: WEB })
  const srv = createServer(app.handler)
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()))
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  const H = { 'content-type': 'application/json', 'x-evoscholar': '1' }
  const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as any })
  t.after(async () => {
    await app.dispose()
    await new Promise<void>((res) => srv.close(() => res()))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  })

  // Model settings: presets list every protocol; switching protocol prefills that protocol's URL.
  const models = await json(await fetch(`${base}/api/models`))
  assert.deepEqual(models.body.protocols.map((p: { id: string }) => p.id), ['chat-completions', 'responses', 'messages', 'gemini'])
  assert.ok(models.body.providers.some((p: { id: string }) => p.id === 'gemini'))
  const put = await json(await fetch(`${base}/api/providers/deepseek`, { method: 'PUT', headers: H, body: JSON.stringify({ protocol: 'messages', key: 'sk-test-x' }) }))
  assert.equal(put.body.provider.baseUrl, 'https://api.deepseek.com/anthropic')
  assert.equal(put.body.provider.hasKey, true)
  const bad = await fetch(`${base}/api/providers/deepseek`, { method: 'PUT', headers: H, body: JSON.stringify({ baseUrl: 'http://evil.example.com/v1' }) })
  assert.equal(bad.status, 400)
  const custom = await json(await fetch(`${base}/api/providers/lab-gw`, { method: 'PUT', headers: H, body: JSON.stringify({ custom: true, label: '实验室网关', protocol: 'responses', baseUrl: 'http://localhost:8080/v1', models: 'm-a, m-b' }) }))
  assert.equal(custom.body.provider.custom, true)
  assert.deepEqual(custom.body.provider.models.map((m: { id: string }) => m.id), ['m-a', 'm-b'])
  const defs = await json(await fetch(`${base}/api/settings/defaults`, { method: 'PUT', headers: H, body: JSON.stringify({ model: 'lab-gw/m-a', permission: 'acceptEdits' }) }))
  assert.equal(defs.body.defaults.model, 'lab-gw/m-a')
  assert.equal(openWorkspace(dir).settings.defaults.permission, 'acceptEdits', 'settings persist to data/settings.json')

  // Projects: add a folder, create a session inside it.
  const created = await json(await fetch(`${base}/api/projects`, { method: 'POST', headers: H, body: JSON.stringify({ path: proj }) }))
  const pid = created.body.project.id
  assert.ok(pid.startsWith('p-'))
  const files = await json(await fetch(`${base}/api/projects/${pid}/files?q=note`))
  assert.deepEqual(files.body.files.map((f: { path: string }) => f.path), ['notes.md'])
  const sess = await json(await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: '项目会话', projectId: pid, model: 'deepseek/deepseek-flash', permission: 'plan' }) }))
  assert.equal(sess.body.projectId, pid)
  const detail = await json(await fetch(`${base}/api/sessions/${sess.body.id}`))
  assert.equal(detail.body.cwd, created.body.project.path)
  assert.equal(detail.body.permission, 'plan')
  assert.equal(detail.body.model, 'deepseek/deepseek-flash')

  // Uploads land in evoscholar-in/ and in the library; names never collide.
  const up1 = await json(await fetch(`${base}/api/sessions/${sess.body.id}/upload`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'spec.csv', data: Buffer.from('a,b').toString('base64') }) }))
  const up2 = await json(await fetch(`${base}/api/sessions/${sess.body.id}/upload`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'spec.csv', data: Buffer.from('c,d').toString('base64') }) }))
  assert.equal(up1.body.path, 'evoscholar-in/spec.csv')
  assert.equal(up2.body.path, 'evoscholar-in/spec-2.csv')
  const lib = await json(await fetch(`${base}/api/library?project=${pid}`))
  assert.equal(lib.body.files.length, 2)
  const fileRes = await fetch(`${base}/api/library/${lib.body.files[0].id}/file`)
  assert.equal(fileRes.status, 200)
  await fetch(`${base}/api/library/${lib.body.files[0].id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ deliverable: true }) })
  assert.equal((await json(await fetch(`${base}/api/library?deliverable=1`))).body.files.length, 1)

  // Session settings switch without reopening; usage and folder picker answer.
  const sw = await json(await fetch(`${base}/api/sessions/${sess.body.id}/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ permission: 'bypass' }) }))
  assert.equal(sw.body.permission, 'bypass')
  assert.equal((await fetch(`${base}/api/usage?group=model&days=30`)).status, 200)
  assert.ok(Array.isArray((await json(await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(proj)}`))).body.dirs))

  // Deleting a project session never touches the user's folder.
  await fetch(`${base}/api/sessions/${sess.body.id}`, { method: 'DELETE', headers: H })
  assert.ok(existsSync(join(proj, 'notes.md')))
  assert.ok(existsSync(join(proj, 'evoscholar-in', 'spec.csv')))

  // DNS-rebinding guard.
  const port = (srv.address() as { port: number }).port
  const status = await new Promise<number>((res, rej) => {
    const r = request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'attacker.example' } }, (resp) => { resp.resume(); res(resp.statusCode ?? 0) })
    r.on('error', rej)
    r.end()
  })
  assert.equal(status, 403)
})

test('credentials accept one dotenv entry at a time', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evo-key-'))
  t.after(() => {
    delete process.env.EVOSCHOLAR_TEST_API_KEY
    rmSync(dir, { recursive: true, force: true })
  })
  assert.throws(() => setEnvKey(dir, 'EVOSCHOLAR_TEST_API_KEY', 'first\nsecond'))
  assert.equal(existsSync(join(dir, '.env')), false)
  setEnvKey(dir, 'EVOSCHOLAR_TEST_API_KEY', 'fixture-key')
  assert.equal(process.env.EVOSCHOLAR_TEST_API_KEY, 'fixture-key')
})

test('a session rejects a second turn and releases pending approval on cancel', async (t) => {
  const dir = tempWorkspace()
  const rt = openRuntime(openWorkspace(dir))
  const app = createServerApp(rt, { webDir: WEB })
  const srv = createServer(app.handler)
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res))
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  const network = globalThis.fetch
  let modelRequests = 0
  const oldKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'fixture-key'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(`${base}/`)) return network(input, init)
    modelRequests++
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'output.txt', content: 'fixture' }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ]
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const post = (path: string, body: object = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-evoscholar': '1' }, body: JSON.stringify(body)
  })
  const until = async (predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 80; i++) {
      if (await predicate()) return true
      await delay(20)
    }
    return false
  }
  let path = ''
  t.after(async () => {
    // Resolve a pending dialog even when testing the old cancellation behavior.
    if (path) {
      const snapshot = await (await fetch(base + path)).json() as { pendingApprovals: { id: string }[] }
      for (const pending of snapshot.pendingApprovals) await post(`${path}/approve/${pending.id}`, { allow: false })
    }
    await app.dispose()
    await new Promise<void>((res) => srv.close(() => res()))
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = oldKey
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const { id, cwd } = await (await post('/api/sessions', { permission: 'ask', model: 'deepseek/deepseek-flash' })).json() as { id: string; cwd: string }
  path = `/api/sessions/${id}`
  const snapshot = async () => await (await fetch(base + path)).json() as { busy: boolean; pendingApprovals: unknown[] }
  const turns = await Promise.all([post(path + '/ask', { text: 'first' }), post(path + '/ask', { text: 'second' })])
  assert.deepEqual(turns.map((response) => response.status).sort(), [202, 409])
  assert.ok(await until(async () => (await snapshot()).pendingApprovals.length === 1))
  assert.equal((await post(path + '/cancel')).status, 200)
  assert.ok(await until(async () => !(await snapshot()).busy), 'cancelled turn becomes idle without answering the dialog')
  assert.equal(modelRequests, 1)
  assert.equal(existsSync(join(cwd, 'output.txt')), false)
})

test('JSON body errors return 400 and oversized streams return 413', async (t) => {
  const srv = createServer(async (req, res) => {
    try { send(res, 200, await body(req, 12)) } catch (e) {
      send(res, (e as { status?: number }).status ?? 500, {})
    }
  })
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res))
  t.after(() => new Promise<void>((res) => srv.close(() => res())))
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  for (const raw of ['{invalid', '[]']) assert.equal((await fetch(url, { method: 'POST', body: raw })).status, 400)
  const upload = new ReadableStream({ start(output) { output.enqueue(new TextEncoder().encode(' '.repeat(20))); output.close() } })
  const init = { method: 'POST', body: upload, duplex: 'half' as const }
  assert.equal((await fetch(url, init)).status, 413)
})

test('project file routes work for persisted sessions without opening a live session', async (t) => {
  const dir = tempWorkspace()
  const rt = openRuntime(openWorkspace(dir))
  const app = createServerApp(rt, { webDir: WEB })
  const srv = createServer(app.handler)
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res))
  t.after(async () => {
    await app.dispose()
    await new Promise<void>((res) => srv.close(() => res()))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  const cwd = join(dir, 'paper')
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'paper.txt'), 'fixture')
  rt.db.prepare('INSERT INTO sessions (id, created_at, genome_id, category, cwd) VALUES (?, ?, ?, ?, ?)')
    .run('s-fixture', new Date().toISOString(), rt.genomes.activeId(), 'usage', cwd)
  const res = await fetch(base + '/api/sessions/s-fixture/file?path=paper.txt')
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'fixture')
})

test('disposing the app releases live event streams', async (t) => {
  const dir = tempWorkspace()
  const rt = openRuntime(openWorkspace(dir))
  const app = createServerApp(rt, { webDir: WEB })
  const srv = createServer(app.handler)
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res))
  t.after(async () => {
    srv.closeAllConnections()
    await app.dispose()
    await new Promise<void>((res) => srv.close(() => res()))
    rt.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/sessions`
  const created = await fetch(url, { method: 'POST', headers: { 'x-evoscholar': '1' }, body: '{}' })
  const { id } = await created.json() as { id: string }
  const response = await fetch(`${url}/${id}/events`, { signal: AbortSignal.timeout(2_000) })
  const reader = response.body!.getReader()
  const hello = await reader.read()
  assert.match(new TextDecoder().decode(hello.value), /"type":"hello"/)
  await app.dispose()
  assert.equal((await reader.read()).done, true)
})
