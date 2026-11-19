import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, statSync, writeFileSync } from 'node:fs'
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
  parameters: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string', description: '技能目录内的相对路径，可选' } }, required: ['name'], additionalProperties: false },
  scheduling: 'parallel',
  validate: (i) => objectArgs(i, ['name', 'file'], ['name']) as Json,
  authorize: async () => true,
  async execute(args) {
    const { name, file } = args as { name: string; file?: string }
    const ref = env.skills?.find((skill) => skill.name === name) ?? extraSkills(env.ws.root).find((x) => x.name === name)
    const s = ref && readSkillFile(env.ws.root, ref.name, ref.version)
    if (!s) return textResult(`没有技能 ${name}`, true)
    const dir = inside(env.ws.root, join('skills', name))
    if (file) {
      if (/(^|[\\/])\./.test(file)) return textResult('只能读取技能目录里的文件', true)
      const f = inside(dir, file)
      if (!existsSync(f) || !statSync(f).isFile()) return textResult(`技能 ${name} 里没有 ${file}`, true)
      if (statSync(f).size > 80_000) return textResult(`${file} 太大（超过 80 KB），请只读需要的部分`, true)
      env.trace?.({ kind: 'skill.read', name, file })
      return textResult(readFileSync(f, 'utf8'))
    }
    env.trace?.({ kind: 'skill.read', name: s.meta.name, version: s.meta.version })
    const extras = listSkillFiles(dir)
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

export type SkillSource = { type: 'builtin' | 'github' | 'zip' | 'folder' | 'forged'; origin?: string; license?: string; importedAt?: string; status?: 'trial' | 'active'; sessions?: string[]; reuses?: string[]; kernel?: boolean }
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

/** Host-level skills every session can read even if the genome does not list them: forged kernels. */
export function extraSkills(root: string): SkillRef[] {
  const dir = join(root, 'skills')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => skillSource(root, n).type === 'forged').map((n) => ({ name: n, version: readSkillFile(root, n)?.meta.version ?? 1 }))
}
