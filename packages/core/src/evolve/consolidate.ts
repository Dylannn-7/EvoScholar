// Consolidation (docs/in-loop-evolution.md §7.4, simplified per PLAN §3.6): session overlays that held up
// and high-scoring lessons become ONE genome candidate. It never goes live by itself: the user approves it
// in 轨迹 → 版本, and can roll back. Verification against the private eval suite is optional (dev only).
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessGenome } from '../genome'
import type { Runtime } from '../session'
import { betaScore } from './store'

export function consolidate(rt: Runtime, sel: { overlayIds?: string[]; memoryIds?: string[]; note?: string }): { genome: string; changes: string[] } {
  const base = rt.genomes.load()
  const overlays = rt.evolve.overlays(undefined, true).filter((o) => sel.overlayIds?.includes(o.id) && (o.status === 'trial' || o.status === 'kept'))
  const memory = (sel.memoryIds ?? []).map((id) => rt.evolve.get(id)).filter((m): m is NonNullable<typeof m> => !!m && m.status !== 'retired' && m.trust === 'trusted')
  if (!overlays.length && !memory.length) throw new Error('请选择至少一项表现良好的会话调整或经验')
  const g: HarnessGenome = JSON.parse(JSON.stringify(base))
  g.id = rt.genomes.nextId()
  g.parent = base.id
  g.createdBy = 'consolidate/manual'
  g.createdAt = new Date().toISOString()
  g.status = 'candidate'
  const changes: string[] = []
  const notes = overlays.filter((o) => o.op === 'prompt.note').map((o) => o.value)
  const lessons = memory.map((m) => `${m.trigger} → ${m.content}`)
  if (notes.length || lessons.length) {
    const text = rt.genomes.text(base.instructions.system).trimEnd() +
      `\n\n## 沉淀的工作方式（${g.id}，经用户批准）\n${[...notes, ...lessons].map((x) => `- ${x}`).join('\n')}\n`
    mkdirSync(join(rt.ws.root, 'prompts'), { recursive: true })
    const ref = `prompts/system@${g.id}.md`
    writeFileSync(join(rt.ws.root, ref), text)
    g.instructions = { ...g.instructions, system: ref }
    if (notes.length) changes.push(`系统指令追加 ${notes.length} 条规则`)
    if (lessons.length) changes.push(`系统指令写入 ${lessons.length} 条高分经验`)
  }
  for (const o of overlays.filter((x) => x.op === 'tool.note' && x.target)) {
    const prev = g.tools.overrides?.[o.target!]?.description
    g.tools.overrides = { ...(g.tools.overrides ?? {}), [o.target!]: { ...(g.tools.overrides?.[o.target!] ?? {}), description: `${prev ? rt.genomes.text(prev) : ''}${prev ? '\n' : ''}补充：${o.value}`.trim() } }
    changes.push(`工具 ${o.target} 的说明补充`)
  }
  for (const o of overlays.filter((x) => x.op.startsWith('skill.') && x.target)) {
    const skills = g.skills ?? []
    if (o.op === 'skill.disable') g.skills = skills.filter((s) => s.name !== o.target)
    else {
      const version = o.op === 'skill.version' ? Number(o.value) : 1
      g.skills = skills.some((s) => s.name === o.target) ? skills.map((s) => (s.name === o.target && o.op === 'skill.version' ? { ...s, version } : s)) : [...skills, { name: o.target!, version }]
    }
    changes.push(`${o.op === 'skill.disable' ? '停用' : o.op === 'skill.version' ? `更新到 v${o.value}：` : '启用'}技能 ${o.target}`)
  }
  g.note = sel.note || `沉淀：${changes.join('；')}`
  rt.genomes.save(g)
  rt.genomes.hash(g)
  const evidence = [
    ...overlays.map((o) => `${o.id}（${o.op}${o.target ? ` ${o.target}` : ''}：${o.value}；回合得分 ${o.before_score ?? '—'} → ${o.after_score ?? '—'}）`),
    ...memory.map((m) => `${m.id}（得分 ${betaScore(m).toFixed(2)}，用过 ${m.uses} 次）`)
  ]
  rt.db.prepare(`INSERT INTO candidates (genome_id, evolution_run, parent, target, diagnosis, change, status, ts) VALUES (?,?,?,?,?,?, 'pending', ?)`)
    .run(g.id, `consolidate-${Date.now()}`, base.id, 'consolidate', `来自会话的证据：${evidence.join('；')}`, JSON.stringify(changes), new Date().toISOString())
  for (const o of overlays) rt.evolve.setOverlay(o.id, 'promoted')
  rt.evolve.log({ kind: 'learned', text: `生成 genome 候选 ${g.id}，等待你批准：${changes.join('；')}`, refs: [g.id, ...overlays.map((o) => o.id), ...memory.map((m) => m.id)] })
  return { genome: g.id, changes }
}
