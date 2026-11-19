import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  consolidate, installSkillFiles, openRuntime, openWorkspace, promote, reconcileRuntime
} from './index'

const REPO = resolve(__dirname, '../../..')

function makeWs() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-recover-'))
  for (const d of ['genomes', 'prompts', 'skills']) cpSync(join(REPO, d), join(dir, d), { recursive: true })
  cpSync(join(REPO, 'evoscholar.config.json'), join(dir, 'evoscholar.config.json'))
  mkdirSync(join(dir, 'data'))
  return dir
}

test('startup reconciliation quarantines orphan candidate files and marks missing candidate files invalid', (t) => {
  const dir = makeWs()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const rt1 = openRuntime(openWorkspace(dir), () => {})
  const active = rt1.genomes.load()
  // Simulate crash after writing candidate YAML before inserting candidates row.
  const orphanId = rt1.genomes.nextId()
  rt1.genomes.save({ ...active, id: orphanId, parent: active.id, createdBy: 'consolidate/manual', status: 'candidate' })
  const old = new Date(Date.now() - 5 * 60_000)
  utimesSync(join(dir, 'genomes', `${orphanId}.yaml`), old, old)
  // A file another host wrote a moment ago may still be on its way to the database.
  const freshId = `g-${String(Number(orphanId.slice(2)) + 1).padStart(4, '0')}`
  rt1.genomes.save({ ...active, id: freshId, parent: active.id, createdBy: 'consolidate/manual', status: 'candidate' })
  // Simulate DB candidate record whose genome file vanished.
  const missingId = 'g-0099'
  rt1.db.prepare(`INSERT INTO candidates (genome_id, evolution_run, parent, target, diagnosis, change, status, ts)
    VALUES (?, 'consolidate-1', ?, 'consolidate', 'test', '[]', 'pending', ?)`).run(missingId, active.id, new Date().toISOString())
  rt1.db.close()

  const alerts: string[] = []
  const rt2 = openRuntime(openWorkspace(dir), (m) => alerts.push(m))
  t.after(() => rt2.db.close())
  assert.equal(existsSync(join(dir, 'genomes', `${orphanId}.yaml`)), false, 'orphan candidate removed from genomes/')
  assert.ok(existsSync(join(dir, 'genomes', `${freshId}.yaml`)), 'a just-written candidate is left for its writer')
  const quarantined = readdirSync(join(dir, 'data', 'quarantine', 'genomes'))
  assert.ok(quarantined.some((f) => f.startsWith(`${orphanId}-`)), 'orphan candidate moved to quarantine')
  const row = rt2.db.prepare(`SELECT status, reason FROM candidates WHERE genome_id = ?`).get(missingId) as { status: string; reason: string }
  assert.equal(row.status, 'invalid')
  assert.match(row.reason, /缺失或损坏/)
  assert.throws(() => promote(rt2, missingId), /Genome not found|失效|invalid/)
  const logs = rt2.db.prepare(`SELECT kind FROM reconcile_log`).all() as { kind: string }[]
  assert.ok(logs.some((l) => l.kind === 'orphan_candidate'))
  assert.ok(logs.some((l) => l.kind === 'missing_candidate_file'))
  assert.ok(alerts.some((a) => a.includes(orphanId)))
})

test('startup reconciliation recovers ACTIVE from missing or unapproved genome to latest approved version', (t) => {
  const dir = makeWs()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // Case 1: ACTIVE points to a nonexistent genome.
  writeFileSync(join(dir, 'genomes', 'ACTIVE'), 'g-9999\n')
  const alerts1: string[] = []
  const rt1 = openRuntime(openWorkspace(dir), (m) => alerts1.push(m))
  const expected = rt1.genomes.activeId()
  assert.notEqual(expected, 'g-9999')
  assert.equal(rt1.genomes.load(expected).status, 'active')
  assert.ok(alerts1.some((a) => a.includes('g-9999') && a.includes(expected)))

  // Case 2: ACTIVE points to an unapproved pending candidate genome.
  const active = rt1.genomes.load()
  const oid = rt1.evolve.addOverlay({ sessionId: 's1', op: 'prompt.note', value: '测试规则', reason: 'test' })
  rt1.evolve.setOverlay(oid, 'kept', 0.9)
  const cand = consolidate(rt1, { overlayIds: [oid] })
  writeFileSync(join(dir, 'genomes', 'ACTIVE'), `${cand.genome}\n`)
  // Also corrupt genome_state so reconciliation must fall back rather than sync.
  rt1.db.prepare(`DELETE FROM genome_state`).run()
  rt1.db.close()

  const alerts2: string[] = []
  const rt2 = openRuntime(openWorkspace(dir), (m) => alerts2.push(m))
  t.after(() => rt2.db.close())
  assert.equal(rt2.genomes.activeId(), active.id)
  assert.ok(alerts2.some((a) => a.includes(cand.genome) && a.includes(active.id)))
})

test('startup reconciliation releases stale budget reservations and keeps fresh ones', (t) => {
  const dir = makeWs()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const rt1 = openRuntime(openWorkspace(dir), () => {})
  const oldTs = new Date(Date.now() - 2 * 3600_000).toISOString()
  const freshTs = new Date().toISOString()
  rt1.db.prepare(`INSERT INTO budget_reservations (category, kind, round_id, cost_cny, created_at) VALUES ('dev', 'model', 'r-old', 1.25, ?)`).run(oldTs)
  rt1.db.prepare(`INSERT INTO budget_reservations (category, kind, round_id, cost_cny, created_at) VALUES ('dev', 'model', 'r-new', 0.50, ?)`).run(freshTs)
  rt1.db.close()

  const rt2 = openRuntime(openWorkspace(dir), () => {})
  t.after(() => rt2.db.close())
  const left = rt2.db.prepare(`SELECT round_id, cost_cny FROM budget_reservations`).all() as { round_id: string; cost_cny: number }[]
  assert.equal(left.length, 1)
  assert.equal(left[0].round_id, 'r-new')
  const rec = rt2.db.prepare(`SELECT kind, detail FROM reconcile_log WHERE kind = 'budget_reservation'`).all() as { kind: string; detail: string }[]
  assert.equal(rec.length, 1)
  assert.match(rec[0].detail, /1\.2500/)
})

test('compare-and-swap rejects stale active pointer switch across concurrent hosts and syncs committed state', (t) => {
  const dir = makeWs()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const hostA = openRuntime(openWorkspace(dir), () => {})
  const hostB = openRuntime(openWorkspace(dir), () => {})
  t.after(() => { hostA.db.close(); hostB.db.close() })

  const initial = hostA.genomes.activeId()
  const oid1 = hostA.evolve.addOverlay({ sessionId: 's1', op: 'prompt.note', value: '规则A', reason: 'a' })
  hostA.evolve.setOverlay(oid1, 'kept', 0.9)
  const c1 = consolidate(hostA, { overlayIds: [oid1] })
  const oid2 = hostB.evolve.addOverlay({ sessionId: 's2', op: 'prompt.note', value: '规则B', reason: 'b' })
  hostB.evolve.setOverlay(oid2, 'kept', 0.9)
  const c2 = consolidate(hostB, { overlayIds: [oid2] })

  // Host A promotes c1 successfully.
  promote(hostA, c1.genome, { confirmUnverified: true })
  assert.equal(hostA.genomes.activeId(), c1.genome)

  // Host B attempts CAS switch assuming `initial` is still active -> rejected.
  assert.throws(() => hostB.genomes.commitActiveSwitch(hostB.db, initial, c2.genome), /并发变更/)
  assert.equal(hostB.genomes.activeId(), c1.genome)

  // Simulate crash right after SQLite commit (genome_state updated, ACTIVE still stale):
  writeFileSync(join(dir, 'genomes', 'ACTIVE'), `${initial}\n`)
  const rep = reconcileRuntime(hostB)
  assert.equal(rep.activeRecoveredTo, c1.genome)
  assert.equal(hostB.genomes.activeId(), c1.genome)
})

test('interrupted skill replacement restores backup and cleans staging on startup', (t) => {
  const dir = makeWs()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const skillMd = '---\nname: swap-skill\ndescription: Swap test\nlicense: MIT\n---\n# v1\n'
  installSkillFiles(dir, new Map([['SKILL.md', Buffer.from(skillMd)]]), { type: 'zip' })
  installSkillFiles(dir, new Map([['SKILL.md', Buffer.from(skillMd.replace('# v1', '# v2'))]]), { type: 'zip' }, { replace: true })
  assert.equal(existsSync(join(dir, 'skills', 'swap-skill', '.source.json')), true)

  // Simulate crash mid-replacement: old dir moved to .backup-*, staging dir left behind, target absent.
  const backup = join(dir, 'skills', `.backup-swap-skill-${randomUUID()}`)
  const staging = join(dir, 'skills', `.import-swap-skill-${randomUUID()}`)
  mkdirSync(staging, { recursive: true })
  cpSync(join(dir, 'skills', 'swap-skill'), backup, { recursive: true })
  rmSync(join(dir, 'skills', 'swap-skill'), { recursive: true, force: true })

  const rt = openRuntime(openWorkspace(dir), () => {})
  t.after(() => rt.db.close())
  assert.equal(existsSync(join(dir, 'skills', 'swap-skill', 'SKILL.md')), true, 'backup restored')
  assert.equal(existsSync(backup), false, 'backup dir moved back')
  assert.equal(existsSync(staging), false, 'leftover staging dir removed')
})
