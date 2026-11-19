import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { atomicWriteFile } from './atomic-file'
import { inside } from './tools/sandbox'

export const STAGE_LIMITS = { files: 5000, bytes: 256 * 1024 * 1024 }
// A project's own data/ folder is research input and must be staged; the app's data
// directory never reaches this point because checkProjectRoot rejects overlapping roots.
const exclude = new Set(['.git', '.hg', '.svn', '.evoscholar', '__pycache__', 'node_modules', 'venv', '.venv'])
const excluded = (name: string) => name.startsWith('.') || exclude.has(name.toLowerCase())
const contained = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

export function checkProjectRoot(root: string, app: string, data: string) {
  const project = realpathSync(root)
  const home = realpathSync(homedir())
  for (const restricted of [realpathSync(app), realpathSync(data)]) {
    if (contained(project, restricted) || contained(restricted, project))
      throw new Error('项目和 EvoScholar 应用目录或数据目录重叠，无法准备容器工作副本')
  }
  if (contained(project, home)) throw new Error('不能将用户主目录或其上级目录作为容器项目')
  return project
}

type File = { key: string; size: number; mode: number }
const fileKey = (stat: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
  `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
const pathKey = (path: string) => process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path

export function validateDeliverablePaths(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 50) throw new Error('deliverables 必须是最多 50 项的文件路径数组')
  const keys = new Set<string>()
  return value.map((entry: unknown) => {
    if (typeof entry !== 'string' || !entry.trim() || /[\0-\x1f]/.test(entry) || /^[\\/]|^[A-Za-z]:/.test(entry))
      throw new Error('交付路径必须是项目相对文件路径')
    const parts = entry.split(/[\\/]/).filter(part => part !== '.')
    if (!parts.length || parts.some(part => !part || excluded(part)) || parts[0].toLowerCase() === 'evoscholar-in')
      throw new Error(`该路径不能用于容器交付：${entry}`)
    const path = parts.join('/')
    const key = pathKey(path)
    if (keys.has(key)) throw new Error(`重复的容器交付路径：${path}`)
    keys.add(key)
    return path
  })
}

function scan(root: string, limits = STAGE_LIMITS, rejectLinks = false): Map<string, File> {
  const files = new Map<string, File>()
  let bytes = 0, entries = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 32) throw new Error('项目工作副本目录过深')
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excluded(entry.name)) continue
      if (++entries > limits.files * 2) throw new Error('项目工作副本文件数超限')
      const file = join(dir, entry.name)
      const stat = lstatSync(file)
      if (stat.isDirectory()) { walk(file, depth + 1); continue }
      if (!stat.isFile() || stat.nlink !== 1) {
        if (rejectLinks) throw new Error('容器产物包含链接或特殊文件，已拒绝回写')
        continue
      }
      if (files.size >= limits.files) throw new Error('项目工作副本文件数超限')
      bytes += stat.size
      if (bytes > limits.bytes) throw new Error('项目工作副本大小超限')
      files.set(relative(root, file), { key: fileKey(stat), size: stat.size, mode: stat.mode })
    }
  }
  walk(root, 0)
  return files
}

export function stageDirectory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'evoscholar-sandbox-')))
  const work = join(root, 'work')
  const controls = join(root, 'controls')
  mkdirSync(work, { mode: 0o777 })
  chmodSync(work, 0o777)
  mkdirSync(controls, { mode: 0o755 })
  return { root, work, controls, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

function ensureWritableDirectories(root: string, dir: string) {
  const parent = inside(root, dir)
  if (parent !== root && !lstatSync(parent, { throwIfNoEntry: false })) {
    ensureWritableDirectories(root, dirname(parent))
    mkdirSync(parent, { mode: 0o777 })
    chmodSync(parent, 0o777)
  }
}

function validateStageTarget(root: string, rel: string) {
  const target = inside(root, rel)
  if (target !== join(root, rel)) throw new Error('容器工作副本包含重定向路径')
  const existing = lstatSync(target, { throwIfNoEntry: false })
  if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error('容器工作副本目标不是普通文件')
  return target
}

export function copySkillResources(source: string, dir: string) {
  const real = realpathSync(source)
  const files = scan(real, { files: 300, bytes: 8 * 1024 * 1024 }, true)
  mkdirSync(dir, { recursive: true })
  for (const rel of files.keys()) {
    const to = join(dir, rel)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(inside(real, rel), to)
    chmodSync(to, 0o444)
  }
}

function fingerprint(file: string) {
  const st = lstatSync(file, { throwIfNoEntry: false })
  if (!st) return undefined
  if (!st.isFile() || st.nlink !== 1 || st.size > STAGE_LIMITS.bytes) throw new Error('回写目标不是受支持的普通文件')
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function existingDeliverables(root: string, paths: readonly string[]): string[] {
  return paths.map(path => {
    const rel = path.split('/').join(sep)
    if (fingerprint(validateStageTarget(root, rel)) === undefined) throw new Error(`执行成功，但未找到指定的交付文件：${path}`)
    return path
  })
}

export class StagedProject {
  private readonly imported = new Map<string, { source: string; copy: string }>()
  private readonly published = new Map<string, string>()
  private readonly seen = new Map<string, string>()
  constructor(readonly root: string, readonly work: string, private limits = STAGE_LIMITS) {}

  sync() {
    const sources = scan(this.root, this.limits)
    const oldCopies = scan(this.work, this.limits, true)
    const totalBytes = [...oldCopies.values()].reduce((sum, file) => sum + file.size, 0)
    let bytes = totalBytes, count = oldCopies.size
    const changes: [string, File][] = []
    for (const [rel, file] of sources) {
      const old = this.imported.get(rel)
      if (old?.source === file.key) continue
      const copy = oldCopies.get(rel)
      if (copy && old?.copy !== copy.key) {
        const dest = validateStageTarget(this.work, rel)
        if (fingerprint(dest) === fingerprint(inside(this.root, rel))) {
          this.imported.set(rel, { source: file.key, copy: copy.key })
          continue
        }
        throw new Error(`项目和容器同时修改了 ${rel}，请先解决覆盖冲突`)
      }
      bytes += file.size - (copy?.size ?? 0)
      count += copy ? 0 : 1
      if (bytes > this.limits.bytes || count > this.limits.files) throw new Error('项目工作副本容量超限')
      changes.push([rel, file])
    }
    for (const [rel, old] of this.imported) {
      if (sources.has(rel)) continue
      if (oldCopies.get(rel)?.key === old.copy) rmSync(validateStageTarget(this.work, rel), { force: true })
      this.imported.delete(rel)
    }
    for (const [rel, file] of changes) {
      const target = validateStageTarget(this.work, rel)
      ensureWritableDirectories(this.work, dirname(target))
      const source = inside(this.root, rel)
      atomicWriteFile(target, readFileSync(source), (file.mode & 0o111) ? 0o777 : 0o666)
      chmodSync(target, (file.mode & 0o111) ? 0o777 : 0o666)
      const st = lstatSync(target)
      this.imported.set(rel, { source: file.key, copy: fileKey(st) })
    }
    for (const [rel, file] of scan(this.work, this.limits, true)) {
      if (!this.seen.has(rel) || this.imported.get(rel)?.copy === file.key) this.seen.set(rel, file.key)
    }
  }

  /** Snapshot the destinations before running the approved container. */
  planDelivery(paths?: string[]): ReadonlyMap<string, string | undefined> {
    return new Map(validateDeliverablePaths(paths).map(path => {
      const rel = path.split('/').join(sep)
      return [rel, fingerprint(validateStageTarget(this.root, rel))]
    }))
  }

  publish(sessionId: string, delivery?: ReadonlyMap<string, string | undefined>): string[] {
    const output = join('evoscholar-out', sessionId)
    const pending: { rel: string; file: File; dest: string; target: string; source: string; old?: string; next?: string }[] = []
    const destinations = new Set<string>()
    const files = scan(this.work, this.limits, true)
    for (const rel of delivery?.keys() ?? []) {
      if (!files.has(rel)) throw new Error(`执行成功，但未找到指定的交付文件：${rel}`)
    }
    for (const [rel, file] of files) {
      const explicit = delivery?.has(rel)
      if (!explicit && this.seen.get(rel) === file.key) continue
      const dest = explicit || contained(output, rel) ? rel : join(output, rel)
      const target = validateStageTarget(this.root, dest)
      const source = validateStageTarget(this.work, rel)
      const key = pathKey(dest)
      if (destinations.has(key)) throw new Error(`多个容器文件对应同一交付路径：${dest}`)
      destinations.add(key)
      const old = fingerprint(target)
      const next = fingerprint(source)
      if (explicit && old !== delivery?.get(rel)) throw new Error(`交付文件在容器运行期间已被修改：${dest}`)
      if (!explicit && old !== next && old && old !== this.published.get(dest))
        throw new Error(`交付路径已有不同内容：${dest}`)
      pending.push({ rel, file, dest, target, source, old, next })
    }
    const published: string[] = []
    for (const { rel, file, dest, target, source, old, next } of pending) {
      if (old !== next) {
        if (fingerprint(validateStageTarget(this.root, dest)) !== old) throw new Error(`交付文件在回写前已被修改：${dest}`)
        mkdirSync(dirname(target), { recursive: true })
        atomicWriteFile(target, readFileSync(source))
      }
      if (old !== next || delivery?.has(rel)) published.push(dest)
      if (delivery?.has(rel)) this.imported.set(rel, { source: fileKey(lstatSync(target)), copy: file.key })
      if (next) this.published.set(dest, next)
      this.seen.set(rel, file.key)
    }
    return published
  }
}
