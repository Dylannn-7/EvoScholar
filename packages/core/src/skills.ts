import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import type { Json } from '@evoscholar/harness'
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
  const dir = join(root, 'skills', name)
  const legacy = () => readSkillPath(join(dir, 'SKILL.md'), name)
  if (version === undefined) return legacy()
  if (!Number.isSafeInteger(version) || version < 1) return null
  const skill = readSkillPath(join(dir, `SKILL@v${version}.md`), name) ?? legacy()
  return skill?.meta.name === name && skill.meta.version === version ? skill : null
}

export function saveSkillRevision(root: string, name: string, description: string, body: string): SkillRef {
  if (!skillNameValid(name)) throw new Error(`技能名无效：${name}`)
  const dir = join(root, 'skills', name)
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
  description: '读取一个技能（SKILL.md）的完整说明。技能列表见系统指令的「可用技能」。',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  scheduling: 'parallel',
  validate: (i) => objectArgs(i, ['name'], ['name']) as Json,
  authorize: async () => true,
  async execute(args) {
    const { name } = args as { name: string }
    const ref = env.skills?.find((skill) => skill.name === name)
    const s = ref && readSkillFile(env.ws.root, ref.name, ref.version)
    if (!s) return textResult(`没有技能 ${(args as { name: string }).name}`, true)
    env.trace?.({ kind: 'skill.read', name: s.meta.name, version: s.meta.version })
    return textResult(`# 技能 ${s.meta.name} v${s.meta.version}\n${s.body}`)
  }
})
