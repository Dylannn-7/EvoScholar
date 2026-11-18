import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import type { Json } from '@evoscholar/harness'
import { objectArgs, textResult, type ToolFactory } from './tools/types'

export type SkillMeta = { name: string; version: number; description: string; path: string }

export function readSkillFile(root: string, name: string): { meta: SkillMeta; body: string } | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null
  const path = join(root, 'skills', name, 'SKILL.md')
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
  const fm = (m ? YAML.parse(m[1]) : {}) as Partial<SkillMeta>
  return { meta: { name: fm.name ?? name, version: Number(fm.version ?? 1), description: fm.description ?? '', path }, body: m ? m[2] : raw }
}

export function listSkills(root: string): SkillMeta[] {
  const dir = join(root, 'skills')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((n) => readSkillFile(root, n)?.meta).filter((x): x is SkillMeta => !!x)
}

/** Section appended to the system instructions listing the genome's enabled skills. */
export function skillIndex(root: string, enabled: { name: string }[] = []): string {
  const metas = enabled.map((s) => readSkillFile(root, s.name)?.meta).filter((x): x is SkillMeta => !!x)
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
    const s = readSkillFile(env.ws.root, (args as { name: string }).name)
    if (!s) return textResult(`没有技能 ${(args as { name: string }).name}`, true)
    env.trace?.({ kind: 'skill.read', name: s.meta.name, version: s.meta.version })
    return textResult(`# 技能 ${s.meta.name} v${s.meta.version}\n${s.body}`)
  }
})
