import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import YAML from 'yaml'
import type { Json } from '@evoscholar/harness'
import { atomicWriteFile } from './atomic-file'
import { inside } from './tools/sandbox'
import { objectArgs, textResult, type ToolFactory } from './tools/types'

export type SkillMeta = { name: string; version: number; description: string; path: string }
export type SkillRef = Pick<SkillMeta, 'name' | 'version'>
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

export function skillNameValid(name: string): boolean {
  return SKILL_NAME.test(name)
}

function readSkillPath(path: string, name: string): { meta: SkillMeta; body: string; raw: string } | null {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/.exec(raw)
  const fm = (m ? YAML.parse(m[1]) : {}) as Partial<SkillMeta>
  return { meta: { name: fm.name ?? name, version: Number(fm.version ?? 1), description: fm.description ?? '', path }, body: m ? m[2] : raw, raw }
}

/** SKILL.md is the legacy revision. A pinned request only opens a matching revision. */
export function readSkillFile(root: string, name: string, version?: number) {
  if (!skillNameValid(name)) return null
  const dir = inside(root, join('skills', name))
  const legacy = () => readSkillPath(inside(root, join(dir, 'SKILL.md')), name)
  if (version === undefined) return legacy()
  if (!Number.isSafeInteger(version) || version < 1) return null
  const skill = readSkillPath(inside(root, join(dir, `SKILL@v${version}.md`)), name) ?? legacy()
  return skill?.meta.name === name && skill.meta.version === version ? skill : null
}

export function saveSkillRevision(root: string, name: string, description: string, body: string): SkillRef {
  if (!skillNameValid(name)) throw new Error(`技能名无效：${name}`)
  const dir = inside(root, join('skills', name))
  mkdirSync(dir, { recursive: true })
  let last = readSkillFile(root, name)?.meta.version ?? 0
  for (const file of readdirSync(dir)) {
    const match = /^SKILL@v(\d+)\.md$/.exec(file)
    if (match) last = Math.max(last, Number(match[1]))
  }
  const version = last + 1
  const header = YAML.stringify({ name, version, description })
  writeFileSync(join(dir, `SKILL@v${version}.md`), `---\n${header}---\n\n${body.trim()}\n`, { flag: 'wx' })
  return { name, version }
}

export function listSkills(root: string, enabled: readonly SkillRef[] = []): SkillMeta[] {
  const dir = join(root, 'skills')
  if (!existsSync(dir)) return []
  const versions = new Map(enabled.map(({ name, version }) => [name, version]))
  return readdirSync(dir).map((n) => readSkillFile(root, n, versions.get(n))?.meta).filter((x): x is SkillMeta => !!x)
}

/** Section appended to the system instructions listing the genome's enabled skills. */
export function skillIndex(root: string, enabled: SkillRef[] = []): string {
  const metas = enabled.map((s) => {
    const skill = readSkillFile(root, s.name, s.version)
    if (!skill) throw new Error(`缺少已启用的技能 ${s.name} v${s.version}`)
    return skill.meta
  })
  if (!metas.length) return ''
  return `\n\n## 可用技能\n遇到下列任务时，先用 read_skill 读取对应技能的完整说明再动手：\n${metas.map((m) => `- ${m.name}：${m.description}`).join('\n')}`
}

export const readSkill: ToolFactory = (env) => ({
  name: 'read_skill',
  version: '1',
  description: '读取一个技能（SKILL.md）的完整说明；file 可读取该技能附带的参考文档或脚本（如 references/xxx.md、scripts/yyy.py）。技能列表见系统指令的「可用技能」。',
  parameters: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string', description: '技能目录内的相对路径，可选' }, version: { type: 'integer', minimum: 1, description: '可执行技能的版本号' } }, required: ['name'], additionalProperties: false },
  scheduling: 'parallel',
  validate: (i) => objectArgs(i, ['name', 'file', 'version'], ['name']) as Json,
  authorize: async () => true,
  async execute(args) {
    const { name, file, version } = args as { name: string; file?: string; version?: number }
    const src = skillSource(env.ws.root, name)
    const pinned = src.type === 'forged'
      ? visibleKernelRevisions(src, kernelProject(env)).find((r) => version === undefined || r.version === version) : undefined
    const ref = src.type === 'forged' ? undefined : env.skills?.find((skill) => skill.name === name)
    const s = pinned ? readKernelSkill(env.ws.root, name, src, pinned.version) : ref && readSkillFile(env.ws.root, ref.name, ref.version)
    if (!s) return textResult(`没有技能 ${name}`, true)
    const dir = inside(env.ws.root, pinned ? kernelRevisionPath(name, src, pinned.version) : join('skills', name))
    if (file) {
      if (/(^|[\\/])\./.test(file)) return textResult('只能读取技能目录里的文件', true)
      const f = inside(dir, file)
      if (!existsSync(f) || !statSync(f).isFile()) return textResult(`技能 ${name} 里没有 ${file}`, true)
      if (statSync(f).size > 80_000) return textResult(`${file} 太大（超过 80 KB），请只读需要的部分`, true)
      env.trace?.({ kind: 'skill.read', name, file, ...(pinned ? { version: pinned.version } : {}) })
      return textResult(readFileSync(f, 'utf8'))
    }
    env.trace?.({ kind: 'skill.read', name: s.meta.name, version: s.meta.version })
    const extras = pinned ? ['kernel.py', 'test_kernel.py'].filter((f) => existsSync(join(dir, f))) : listSkillFiles(dir)
    return textResult(`# 技能 ${s.meta.name} v${s.meta.version}\n${s.body}${extras.length ? `\n\n---\n本技能附带文件（用 read_skill 的 file 参数读取）：${extras.join('、')}` : ''}`)
  }
})

/** Supporting files of a skill (references, scripts, assets), relative to its folder. */
export function listSkillFiles(dir: string, limit = 60): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number) => {
    let names: string[] = []
    try { names = readdirSync(d).sort() } catch { return }
    for (const n of names) {
      if (n.startsWith('.') || /^SKILL(@v\d+)?\.md$/.test(n) || n === '__pycache__' || out.length >= limit) continue
      const f = join(d, n)
      const stat = lstatSync(f, { throwIfNoEntry: false })
      if (stat?.isDirectory()) { if (depth > 0) walk(f, depth - 1) }
      else if (stat?.isFile()) out.push(relative(dir, f).split(sep).join('/'))
    }
  }
  walk(dir, 3)
  return out
}

export type KernelInputFormat = { argument: string; extension: string; header: string[] }
export type KernelReleases = {
  scope: { project: string; input: KernelInputFormat }
  trial?: number
  active?: number
  approved: number[]
}
export type SkillSource = {
  type: 'builtin' | 'github' | 'zip' | 'folder' | 'forged'; origin?: string; license?: string; importedAt?: string
  status?: 'trial' | 'active'; sessions?: string[]; reuses?: string[]; kernel?: boolean
  /** Shipped with the app (reviewed with each release): trusted and updated like built-in skills. */
  bundled?: boolean
  /** The user marked an imported skill as trusted. */
  trusted?: boolean
  /** A forged skill the user switched off: hidden from the model and refused by run_skill. */
  disabled?: boolean
  releases?: KernelReleases
}
const IMPORTED_TYPES = new Set(['github', 'zip', 'folder'])
/** Imported text the user has not vouched for; reading it marks a session's context as external. */
export function skillUntrusted(src: SkillSource): boolean {
  return IMPORTED_TYPES.has(src.type) && !src.bundled && !src.trusted
}
export function skillSource(root: string, name: string): SkillSource {
  if (!skillNameValid(name)) return { type: 'builtin' }
  try {
    const f = inside(root, join('skills', name, '.source.json'))
    if (statSync(f, { throwIfNoEntry: false })?.isFile()) return JSON.parse(readFileSync(f, 'utf8')) as SkillSource
  } catch {}
  return { type: 'builtin' }
}
export function writeSkillSource(root: string, name: string, src: SkillSource): void {
  if (!skillNameValid(name)) throw new Error('技能名无效')
  const dir = inside(root, join('skills', name))
  atomicWriteFile(inside(dir, '.source.json'), JSON.stringify(src, null, 2) + '\n')
}

export function kernelProject(env: { cwd: string; projectId?: string | null }): string {
  return env.projectId ? `project:${env.projectId}` : `directory:${createHash('sha256').update(realpathSync(env.cwd)).digest('hex')}`
}

type KernelRevision = { version: number; status: 'active' | 'trial' }

export function visibleKernelRevisions(src: SkillSource, project: string): KernelRevision[] {
  if (src.type !== 'forged' || src.disabled) return []
  const releases = src.releases
  if (!releases) return src.status === 'active' ? [{ version: 1, status: 'active' }] : []
  if (releases.scope.project !== project) return []
  const result: KernelRevision[] = []
  if (releases.active !== undefined) result.push({ version: releases.active, status: 'active' })
  if (releases.trial !== undefined) result.push({ version: releases.trial, status: 'trial' })
  return result
}

export function kernelRevisionPath(name: string, src: SkillSource, version: number): string {
  return src.releases ? join('skills', name, 'revisions', `v${version}`) : join('skills', name)
}

export function readKernelSkill(root: string, name: string, src: SkillSource, version: number) {
  return readSkillPath(inside(root, join(kernelRevisionPath(name, src, version), 'SKILL.md')), name)
}

export function extraSkills(root: string, project: string): (SkillRef & KernelRevision & { input?: KernelInputFormat; description: string })[] {
  const dir = join(root, 'skills')
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const src = skillSource(root, name)
    return visibleKernelRevisions(src, project).map((rev) => ({
      name, ...rev, input: src.releases?.scope.input, description: readKernelSkill(root, name, src, rev.version)?.meta.description ?? ''
    }))
  })
}
