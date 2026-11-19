// Projects are local folders the user adds (decision A7). Sessions inside a project use the
// folder as their working directory; outputs go to evoscholar-out/<session>/, uploads to
// evoscholar-in/. Sessions without a project live in the built-in drafts area.
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Workspace } from './config'
import type { Db } from './db'
import { appPrivate } from './tools/sandbox'

export type Project = { id: string; name: string; path: string; created_at: string; archived: number }
export const OUT_DIR = 'evoscholar-out'
export const IN_DIR = 'evoscholar-in'
const SKIP = new Set(['node_modules', '.git', '.evoscholar', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'dist', 'build'])

export function listProjects(db: Db, includeArchived = false): Project[] {
  return db.prepare(`SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY created_at`).all() as Project[]
}

export function getProject(db: Db, id: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
}

/** Register an existing local folder as a project. The folder itself is never moved or deleted. */
export function addProject(ws: Workspace, db: Db, folder: string, name?: string): Project {
  if (!folder || !isAbsolute(folder)) throw new Error('请选择一个绝对路径的文件夹')
  const path = realpathSync(resolve(folder))
  if (!statSync(path).isDirectory()) throw new Error('不是文件夹')
  const root = parse(path).root
  if (path === root || path === homedir()) throw new Error('不能把磁盘根目录或用户主目录整体作为项目，请选择具体的文件夹')
  if (appPrivate(ws, path)) throw new Error('不能选择 EvoScholar 自己的程序目录、数据目录或其中的文件夹')
  const existing = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Project | undefined
  if (existing) {
    if (existing.archived) db.prepare('UPDATE projects SET archived = 0 WHERE id = ?').run(existing.id)
    return { ...existing, archived: 0 }
  }
  const p: Project = { id: `p-${randomUUID().slice(0, 8)}`, name: (name || basename(path)).slice(0, 80), path, created_at: new Date().toISOString(), archived: 0 }
  db.prepare('INSERT INTO projects (id, name, path, created_at, archived) VALUES (?,?,?,?,0)').run(p.id, p.name, p.path, p.created_at)
  return p
}

export function updateProject(db: Db, id: string, patch: { name?: string; archived?: boolean }): void {
  const p = getProject(db, id)
  if (!p) throw Object.assign(new Error('项目不存在'), { status: 404 })
  db.prepare('UPDATE projects SET name = ?, archived = ? WHERE id = ?').run(
    patch.name !== undefined ? String(patch.name).trim().slice(0, 80) || p.name : p.name,
    patch.archived !== undefined ? (patch.archived ? 1 : 0) : p.archived,
    id
  )
}

/** Working directory for a session: the project folder, or a private drafts folder. */
export function sessionCwd(ws: Workspace, project: Project | undefined, sessionId: string): string {
  return project ? project.path : join(ws.dataDir, 'projects', sessionId)
}

/** Folder picker for the web UI: list sub-folders (Windows: drives at the top level). */
export function listDirs(path?: string): { path: string; parent: string | null; dirs: { name: string; path: string }[]; roots: string[] } {
  const roots = process.platform === 'win32'
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`).filter((d) => existsSync(d))
    : ['/']
  const target = path && isAbsolute(path) && existsSync(path) ? resolve(path) : homedir()
  let names: string[] = []
  try { names = readdirSync(target) } catch {}
  const dirs = names
    .filter((n) => !n.startsWith('.') && !SKIP.has(n))
    .map((n) => ({ name: n, path: join(target, n) }))
    .filter((d) => { try { return statSync(d.path).isDirectory() } catch { return false } })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500)
  const parent = dirname(target)
  return { path: target, parent: parent === target ? null : parent, dirs, roots: [homedir(), ...roots] }
}

/** Files under a project for @-references (bounded walk, skips build/VCS folders). */
export function projectFiles(root: string, q = '', limit = 300): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = []
  const needle = q.toLowerCase()
  const walk = (d: string, depth: number) => {
    let names: string[] = []
    try { names = readdirSync(d).sort() } catch { return }
    for (const n of names) {
      if (out.length >= limit) return
      if (n.startsWith('.') || SKIP.has(n)) continue
      const f = join(d, n)
      let st
      try { st = lstatSync(f) } catch { continue }
      if (st.isDirectory()) { if (depth > 0) walk(f, depth - 1); continue }
      const rel = relative(root, f)
      if (st.isFile() && (!needle || rel.toLowerCase().includes(needle))) out.push({ path: rel.split(sep).join('/'), size: st.size })
    }
  }
  walk(root, 6)
  return out
}
