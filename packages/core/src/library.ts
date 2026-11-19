// Library ("资料空间"): an index over every file sessions produced or the user uploaded.
// Files stay where they are (inside the project / session folder); we only keep pointers.
import { existsSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import type { Db } from './db'
import { inside } from './tools/sandbox'

export type LibraryKind = 'output' | 'upload'
export type LibraryEntry = {
  id: number
  project_id: string | null
  session_id: string | null
  root: string
  path: string
  kind: LibraryKind
  size: number
  created_at: string
  updated_at: string
  deliverable: number
}

const IGNORE = /(^|\/)(\.evoscholar|\.git|node_modules|__pycache__)(\/|$)|\.preview\.png$|\.pyc$/

export const FILE_TYPES: Record<string, string[]> = {
  figure: ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.tif', '.tiff', '.eps'],
  document: ['.pdf', '.docx', '.doc', '.md', '.txt', '.tex', '.bib', '.html', '.rtf'],
  data: ['.csv', '.tsv', '.xlsx', '.xls', '.json', '.npy', '.npz', '.mat', '.h5', '.parquet', '.txt'],
  code: ['.py', '.ipynb', '.m', '.r', '.js', '.ts', '.sh', '.ps1', '.yaml', '.yml']
}
export function fileType(path: string): string {
  const ext = extname(path).toLowerCase()
  for (const [t, exts] of Object.entries(FILE_TYPES)) if (exts.includes(ext)) return t
  return 'other'
}

/** Record (or refresh) files; paths are relative to `root`. Missing files are skipped. */
export function indexFiles(db: Db, ref: { root: string; projectId?: string | null; sessionId?: string | null }, paths: string[], kind: LibraryKind): number {
  const now = new Date().toISOString()
  const stmt = db.prepare(`INSERT INTO library (project_id, session_id, root, path, kind, size, created_at, updated_at, deliverable)
    VALUES (?,?,?,?,?,?,?,?,0)
    ON CONFLICT(root, path) DO UPDATE SET size = excluded.size, updated_at = excluded.updated_at,
      session_id = COALESCE(library.session_id, excluded.session_id)`)
  let n = 0
  for (const raw of paths) {
    const rel = raw.split(sep).join('/')
    if (!rel || IGNORE.test(rel)) continue
    let st
    try { st = statSync(inside(ref.root, rel)) } catch { continue }
    if (!st.isFile()) continue
    stmt.run(ref.projectId ?? null, ref.sessionId ?? null, ref.root, rel, kind, st.size, now, now)
    n++
  }
  return n
}

export function listLibrary(db: Db, f: { projectId?: string; sessionId?: string; kind?: string; type?: string; q?: string; deliverable?: boolean; limit?: number } = {}) {
  const where: string[] = []
  const args: (string | number)[] = []
  if (f.projectId === 'drafts') where.push('l.project_id IS NULL')
  else if (f.projectId) { where.push('l.project_id = ?'); args.push(f.projectId) }
  if (f.sessionId) { where.push('l.session_id = ?'); args.push(f.sessionId) }
  if (f.kind) { where.push('l.kind = ?'); args.push(f.kind) }
  if (f.deliverable) where.push('l.deliverable = 1')
  if (f.q) { where.push('l.path LIKE ?'); args.push(`%${f.q.replace(/[%_]/g, '')}%`) }
  const rows = db.prepare(`SELECT l.*, s.title AS session_title, p.name AS project_name FROM library l
      LEFT JOIN sessions s ON s.id = l.session_id LEFT JOIN projects p ON p.id = l.project_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.deliverable DESC, l.updated_at DESC LIMIT ?`)
    .all(...args, Math.min(f.limit ?? 500, 2000)) as (LibraryEntry & { session_title: string | null; project_name: string | null })[]
  return rows
    .map((r) => ({ ...r, type: fileType(r.path), exists: existsSync(join(r.root, r.path)) }))
    .filter((r) => !f.type || r.type === f.type)
}

/** Counts for the library sidebar over every indexed file, independent of the listing limit. */
export function libraryCounts(db: Db) {
  const t = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(deliverable), 0) AS deliverable,
      COALESCE(SUM(CASE WHEN kind = 'upload' THEN 1 ELSE 0 END), 0) AS upload,
      COALESCE(SUM(CASE WHEN project_id IS NULL THEN 1 ELSE 0 END), 0) AS drafts FROM library`).get() as Record<string, number>
  const projects = Object.fromEntries((db.prepare(`SELECT project_id AS id, COUNT(*) AS n FROM library
      WHERE project_id IS NOT NULL GROUP BY project_id`).all() as { id: string; n: number }[]).map((r) => [r.id, Number(r.n)]))
  return { total: Number(t.total), deliverable: Number(t.deliverable), upload: Number(t.upload), drafts: Number(t.drafts), projects }
}

export function setDeliverable(db: Db, id: number, on: boolean): void {
  db.prepare('UPDATE library SET deliverable = ? WHERE id = ?').run(on ? 1 : 0, id)
}

export function libraryPath(db: Db, id: number): string | undefined {
  const r = db.prepare('SELECT root, path FROM library WHERE id = ?').get(id) as { root: string; path: string } | undefined
  return r ? inside(r.root, r.path) : undefined
}

export function forgetLibraryEntry(db: Db, id: number): void {
  db.prepare('DELETE FROM library WHERE id = ?').run(id)
}
