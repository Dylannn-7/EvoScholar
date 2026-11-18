import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Resolve a model-supplied path inside `root`; throws if it escapes (including via symlinks). */
export function inside(root: string, p: string): string {
  const base = realpathSync(root)
  const target = isAbsolute(p) ? resolve(p) : resolve(base, p)
  const within = (x: string) => x === base || x.startsWith(base + sep)
  if (!within(target)) throw new Error(`路径不在工作目录内：${p}`)
  let probe = target
  while (!existsSync(probe)) probe = dirname(probe)
  if (!within(realpathSync(probe))) throw new Error(`路径不在工作目录内：${p}`)
  const rel = relative(base, target)
  if (rel.startsWith('..')) throw new Error(`路径不在工作目录内：${p}`)
  return target
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
