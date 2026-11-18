import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openRuntime, openWorkspace } from '@evoscholar/core'
import { createServerApp } from './server'

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
  assert.ok(st.protectedLimits.maxSteps > 0)

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

  // Provider reasoning effort endpoint: valid effort vs unsupported effort
  const badEff = await fetch(`${base}/api/providers/effort`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ model: 'deepseek/deepseek-flash', effort: 'ultra' })
  })
  assert.equal(badEff.status, 400)

  const okEff = await fetch(`${base}/api/providers/effort`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ model: 'deepseek/deepseek-flash', effort: 'max' })
  })
  assert.equal(okEff.status, 200)
  const stEff = (await (await fetch(`${base}/api/state`)).json()) as { reasoningEffort: Record<string, string> }
  assert.equal(stEff.reasoningEffort['deepseek/deepseek-flash'], 'max')

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
