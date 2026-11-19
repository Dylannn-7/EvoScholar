// Startup reconciliation for cross-file crash recovery (genome candidates, ACTIVE pointer,
// stale budget reservations, and interrupted skill replacements).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { atomicWriteFile } from './atomic-file'
import { withTransaction } from './db'
import type { HarnessGenome } from './genome'
import type { Runtime } from './session'
import { inside } from './tools/sandbox'

export type ReconcileReport = {
  orphanCandidates: string[]
  invalidCandidates: string[]
  activeRecoveredFrom?: string
  activeRecoveredTo?: string
  releasedReservations: number
  releasedCny: number
  skillActions: string[]
  logs: string[]
}

/** Files younger than this may belong to a write still in progress in another process. */
const ORPHAN_MIN_AGE_MS = 60_000

function moveToQuarantine(src: string, dst: string): void {
  try {
    renameSync(src, dst)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw error
    copyFileSync(src, dst)
    rmSync(src, { force: true })
  }
}

function logReconcile(rt: Runtime, kind: string, detail: string): void {
  rt.db.prepare(`INSERT INTO reconcile_log (ts, kind, detail) VALUES (?, ?, ?)`)
    .run(new Date().toISOString(), kind, detail)
}

function archiveOtherActiveGenomes(rt: Runtime, activeId: string): void {
  for (const id of rt.genomes.list()) {
    if (id === activeId) continue
    try {
      const g = rt.genomes.load(id)
      if (g.status === 'active') {
        g.status = 'archived'
        rt.genomes.save(g)
      }
    } catch { /* skip unreadable files */ }
  }
}

export function reconcileRuntime(
  rt: Runtime,
  opts: { reservationTimeoutMs?: number; onLog?: (msg: string) => void } = {}
): ReconcileReport {
  const report: ReconcileReport = {
    orphanCandidates: [],
    invalidCandidates: [],
    releasedReservations: 0,
    releasedCny: 0,
    skillActions: [],
    logs: []
  }
  const emit = (msg: string) => {
    report.logs.push(msg)
    opts.onLog?.(msg)
  }

  const dbActiveRow = rt.db.prepare(`SELECT value FROM genome_state WHERE key = 'active'`).get() as { value: string } | undefined
  const dbActive = dbActiveRow?.value

  // 1. Clean up stray temp files and quarantine orphan candidate YAMLs with no DB record.
  if (existsSync(rt.genomes.dir)) {
    const dbCandidates = new Map(
      (rt.db.prepare(`SELECT genome_id, status FROM candidates`).all() as { genome_id: string; status: string }[])
        .map((r) => [r.genome_id, r.status])
    )
    for (const entry of readdirSync(rt.genomes.dir)) {
      // Another host (CLI next to the server) may be between writing a file and registering it.
      const fresh = Date.now() - statSync(join(rt.genomes.dir, entry)).mtimeMs < ORPHAN_MIN_AGE_MS
      if (/^\.evo-[0-9a-f-]+\.tmp$/i.test(entry)) {
        if (!fresh) rmSync(join(rt.genomes.dir, entry), { force: true })
        continue
      }
      if (!entry.endsWith('.yaml')) continue
      const id = entry.slice(0, -5)
      if (fresh || dbCandidates.has(id) || id === dbActive) continue
      const file = inside(rt.genomes.dir, entry)
      let parsed: Partial<HarnessGenome> | undefined
      try {
        parsed = YAML.parse(readFileSync(file, 'utf8')) as Partial<HarnessGenome>
      } catch {
        continue
      }
      if (parsed?.status !== 'candidate') continue
      const quarantineDir = join(rt.ws.dataDir, 'quarantine', 'genomes')
      mkdirSync(quarantineDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dst = join(quarantineDir, `${id}-${stamp}.yaml`)
      moveToQuarantine(file, dst)
      const detail = `隔离孤立候选文件 ${id}.yaml（数据库无记录）`
      logReconcile(rt, 'orphan_candidate', detail)
      report.orphanCandidates.push(id)
      emit(detail)
    }
  }

  // 2. Mark DB candidate records whose genome or referenced files are missing/corrupt as invalid.
  const openCandidates = rt.db.prepare(
    `SELECT genome_id, status FROM candidates WHERE status IN ('pending', 'evaluating')`
  ).all() as { genome_id: string; status: string }[]
  for (const row of openCandidates) {
    let ok = true
    try {
      const g = rt.genomes.load(row.genome_id)
      rt.genomes.hash(g)
    } catch {
      ok = false
    }
    if (!ok) {
      const detail = `候选 ${row.genome_id} 文件缺失或损坏，启动对账已标记为失效`
      withTransaction(rt.db, () => {
        rt.db.prepare(`UPDATE candidates SET status = 'invalid', reason = ? WHERE genome_id = ?`)
          .run(detail, row.genome_id)
        logReconcile(rt, 'missing_candidate_file', detail)
      })
      report.invalidCandidates.push(row.genome_id)
      emit(detail)
    }
  }

  // 3. Reconcile ACTIVE pointer against approved genomes and genome_state.
  if (existsSync(rt.genomes.dir)) {
    const loadApproved = (id: string | undefined, allowCommitted: boolean): HarnessGenome | undefined => {
      if (!id) return undefined
      try {
        const g = rt.genomes.load(id)
        rt.genomes.hash(g)
        const cand = rt.db.prepare(`SELECT status FROM candidates WHERE genome_id = ?`).get(id) as { status: string } | undefined
        if (cand) return cand.status === 'approved' ? g : undefined
        if (g.status === 'active' || g.status === 'archived') return g
        if (allowCommitted && g.createdBy === 'manual' && g.status === 'candidate') return g
        return undefined
      } catch {
        return undefined
      }
    }

    const fileActive = rt.genomes.tryActiveId()
    const committed = loadApproved(dbActive, true)
    const fileApproved = loadApproved(fileActive, false)

    if (committed && (fileActive !== committed.id || committed.status !== 'active')) {
      committed.status = 'active'
      rt.genomes.save(committed)
      archiveOtherActiveGenomes(rt, committed.id)
      atomicWriteFile(inside(rt.genomes.dir, 'ACTIVE'), committed.id + '\n')
      const detail = `恢复已提交的生效版本指针：ACTIVE ${fileActive ?? '（缺失）'} → ${committed.id}`
      logReconcile(rt, 'active_sync', detail)
      report.activeRecoveredFrom = fileActive
      report.activeRecoveredTo = committed.id
      emit(detail)
    } else if (!fileApproved || (dbActive && !committed)) {
      const ids = rt.genomes.list().reverse()
      let fallback: HarnessGenome | undefined
      for (const id of ids) {
        const g = loadApproved(id, false)
        if (g && g.status === 'active') { fallback = g; break }
      }
      if (!fallback) {
        for (const id of ids) {
          const g = loadApproved(id, false)
          if (g) { fallback = g; break }
        }
      }
      if (fallback) {
        const now = new Date().toISOString()
        const detail = `ACTIVE 指针指向无效或未批准版本（${fileActive ?? '缺失'}），已回退到最近已批准版本 ${fallback.id}`
        withTransaction(rt.db, () => {
          rt.db.prepare(`INSERT INTO genome_state (key, value, updated_at) VALUES ('active', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(fallback!.id, now)
          logReconcile(rt, 'active_fallback', detail)
        })
        fallback.status = 'active'
        rt.genomes.save(fallback)
        archiveOtherActiveGenomes(rt, fallback.id)
        atomicWriteFile(inside(rt.genomes.dir, 'ACTIVE'), fallback.id + '\n')
        report.activeRecoveredFrom = fileActive
        report.activeRecoveredTo = fallback.id
        emit(detail)
      }
    } else if (fileApproved && !dbActive) {
      rt.db.prepare(`INSERT OR IGNORE INTO genome_state (key, value, updated_at) VALUES ('active', ?, ?)`)
        .run(fileApproved.id, new Date().toISOString())
    }
  }

  // 4. Release stale unresolved budget reservations.
  const budget = rt.ledger.reconcileReservations(opts.reservationTimeoutMs)
  if (budget.released > 0) {
    report.releasedReservations = budget.released
    report.releasedCny = budget.releasedCny
    if (budget.detail) emit(budget.detail)
  }

  // 5. Recover interrupted skill staging / replacement directories.
  const skillsDir = join(rt.ws.root, 'skills')
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.import-')) {
        rmSync(join(skillsDir, entry.name), { recursive: true, force: true })
        const detail = `清理未完成的技能导入临时目录 ${entry.name}`
        logReconcile(rt, 'skill_staging', detail)
        report.skillActions.push(detail)
        emit(detail)
        continue
      }
      const m = /^\.backup-([a-z0-9][a-z0-9-]{0,63})-[0-9a-f-]{36}$/i.exec(entry.name)
      if (m) {
        const target = join(skillsDir, m[1])
        const backup = join(skillsDir, entry.name)
        if (!existsSync(target)) {
          renameSync(backup, target)
          const detail = `恢复中断替换的技能目录 ${m[1]}`
          logReconcile(rt, 'skill_restore', detail)
          report.skillActions.push(detail)
          emit(detail)
        } else {
          rmSync(backup, { recursive: true, force: true })
          const detail = `清理已替换技能的旧备份目录 ${entry.name}`
          logReconcile(rt, 'skill_backup_cleanup', detail)
          report.skillActions.push(detail)
          emit(detail)
        }
      }
    }
  }

  return report
}
