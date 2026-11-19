import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/** Resolve a model-supplied path inside `root`; throws if it escapes (including via symlinks). */
export function inside(root: string, p: string): string {
  if (typeof p !== 'string' || p.includes('\0')) throw new Error('无效的文件路径')
  if (process.platform === 'win32') {
    const path = p.replace(/^[A-Za-z]:[\\/]/, '/')
    if (path.split(/[\\/]/).some((part) => part.includes(':') ||
      (part !== '.' && part !== '..' && (/[ .]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))))
      throw new Error('无效的 Windows 文件路径')
  }
  const base = realpathSync(root)
  // Absolute paths may be spelled via the symlinked form of root (macOS: /var → /private/var).
  const logical = resolve(root)
  const abs = isAbsolute(p) ? resolve(p) : undefined
  const target = abs === undefined ? resolve(base, p)
    : within(logical, abs) ? join(base, relative(logical, abs))
    : abs
  if (!within(base, target)) throw new Error(`路径不在工作目录内：${p}`)
  let probe = target
  // lstat sees a dangling link. A failed realpath on that link must fail closed.
  while (!lstatSync(probe, { throwIfNoEntry: false })) probe = dirname(probe)
  const canonical = realpathSync(probe)
  if (!within(base, canonical)) throw new Error(`路径不在工作目录内：${p}`)
  return join(canonical, relative(probe, target))
}

/** Real path of p, resolving the nearest existing ancestor when p itself does not exist yet. */
const real = (p: string): string => {
  const abs = resolve(p)
  try { return realpathSync(abs) } catch {}
  const parent = dirname(abs)
  return parent === abs ? abs : join(real(parent), relative(parent, abs))
}

/**
 * App-owned paths: code, config, credentials, genomes and state under the app root or data dir.
 * Session work areas are the exception: drafts (data/projects/<session>) and offline evaluation
 * runs (data/runs/<run>). This matters when a project folder contains the app, e.g. the user's
 * home or the source checkout itself.
 */
export function appPrivate(ws: { root: string; dataDir: string }, input: string): boolean {
  const path = real(input)
  for (const area of ['projects', 'runs']) if (within(real(join(ws.dataDir, area)), path)) return false
  return within(real(ws.root), path) || within(real(ws.dataDir), path)
}

/** inside() for model-facing tools: also refuses app-private paths. */
export function modelPath(env: { cwd: string; ws: { root: string; dataDir: string } }, p: string): string {
  const path = inside(env.cwd, p)
  if (appPrivate(env.ws, path)) throw new Error(`该路径属于 EvoScholar 自身的代码、配置或数据，模型工具不能访问：${p}`)
  return path
}

const DENY: [RegExp, string][] = [
  [/\bsudo\b/, 'sudo'],
  [/\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|~|\$HOME)(\s|$|\/\*)/, '删除根目录或主目录'],
  [/\b(mkfs|shutdown|reboot|diskutil)\b|\bdd\s+if=/, '系统级命令'],
  [/(curl|wget)[^|]*\|\s*(sh|bash|zsh|python3?)\b/, '下载后直接执行'],
  [/>\s*\/(etc|usr|bin|sbin|System|Library)\//, '写入系统目录'],
  [/(^|[\s;&|(])cd\s+(\/|~|\.\.)/, '切换到工作目录之外'],
  [/(^|[\s'"=:])\.\.\//, '引用上级目录'],
  [/\b(ssh|scp|rsync)\b/, '远程连接'],
  [/\bgit\s+push\b/, '推送代码']
]

/** Guard against obviously destructive or escaping shell commands. A policy check, not a sandbox. */
export function checkCommand(cmd: string): void {
  for (const [re, why] of DENY) if (re.test(cmd)) throw new Error(`命令被拒绝（${why}）：${cmd}`)
}
