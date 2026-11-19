// Consolidation (docs/in-loop-evolution.md §7.4, simplified per PLAN §3.6): session overlays that held up
// and high-scoring lessons become ONE genome candidate. It never goes live by itself: the user approves it
// in 轨迹 → 版本, and can roll back. Verification against the private eval suite is optional (dev only).
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../atomic-file'
import { withTransaction } from '../db'
import type { CandidateVerificationInput } from '../evolution/evolve'
import type { HarnessGenome } from '../genome'
import type { Runtime } from '../session'
import { inside } from '../tools/sandbox'
import { betaScore } from './store'

export function consolidate(
  rt: Runtime,
  sel: { overlayIds?: string[]; memoryIds?: string[]; note?: string; scope?: string; verification?: CandidateVerificationInput }
): { genome: string; changes: string[]; scope: string } {
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
  const scopes = new Set<string>()
  let writtenPrompt: string | undefined
  const notes = overlays.filter((o) => o.op === 'prompt.note').map((o) => o.value)
  const lessons = memory.map((m) => `${m.trigger} → ${m.content}`)
  if (notes.length || lessons.length) {
    const text = rt.genomes.text(base.instructions.system).trimEnd() +
      `\n\n## 沉淀的工作方式（${g.id}，经用户批准）\n${[...notes, ...lessons].map((x) => `- ${x}`).join('\n')}\n`
    mkdirSync(join(rt.ws.root, 'prompts'), { recursive: true })
    const ref = `prompts/system@${g.id}.md`
    writtenPrompt = inside(rt.ws.root, ref)
    atomicWriteFile(writtenPrompt, text)
    g.instructions = { ...g.instructions, system: ref }
    if (notes.length) { changes.push(`系统指令追加 ${notes.length} 条规则`); scopes.add('全局系统指令') }
    if (lessons.length) { changes.push(`系统指令写入 ${lessons.length} 条高分经验`); scopes.add('全局系统指令') }
  }
  for (const o of overlays.filter((x) => x.op === 'tool.note' && x.target)) {
    const prev = g.tools.overrides?.[o.target!]?.description
    g.tools.overrides = { ...(g.tools.overrides ?? {}), [o.target!]: { ...(g.tools.overrides?.[o.target!] ?? {}), description: `${prev ? rt.genomes.text(prev) : ''}${prev ? '\n' : ''}补充：${o.value}`.trim() } }
    changes.push(`工具 ${o.target} 的说明补充`)
    scopes.add(`工具 ${o.target}`)
  }
  for (const o of overlays.filter((x) => x.op.startsWith('skill.') && x.target)) {
    const skills = g.skills ?? []
    if (o.op === 'skill.disable') g.skills = skills.filter((s) => s.name !== o.target)
    else {
      const version = o.op === 'skill.version' ? Number(o.value) : 1
      g.skills = skills.some((s) => s.name === o.target) ? skills.map((s) => (s.name === o.target && o.op === 'skill.version' ? { ...s, version } : s)) : [...skills, { name: o.target!, version }]
    }
    changes.push(`${o.op === 'skill.disable' ? '停用' : o.op === 'skill.version' ? `更新到 v${o.value}：` : '启用'}技能 ${o.target}`)
    scopes.add(`技能 ${o.target}`)
  }
  const scope = sel.scope?.trim() || [...scopes].join('、') || '全局 harness'
  const ver = sel.verification
  if (ver) {
    if (!ver.runId.trim()) throw new Error('验证运行 ID 不能为空')
    if (!Number.isSafeInteger(ver.total) || ver.total < 1 || !Number.isSafeInteger(ver.pass) || ver.pass < 0 || ver.pass > ver.total)
      throw new Error('验证通过数与总数无效')
  }
  g.note = sel.note || `沉淀：${changes.join('；')}`
  const genomeFile = inside(rt.genomes.dir, `${g.id}.yaml`)
  rt.genomes.save(g)
  rt.genomes.hash(g)
  const evidence = [
    ...overlays.map((o) => `${o.id}（${o.op}${o.target ? ` ${o.target}` : ''}：${o.value}；回合得分 ${o.before_score ?? '—'} → ${o.after_score ?? '—'}）`),
    ...memory.map((m) => `${m.id}（得分 ${betaScore(m).toFixed(2)}，用过 ${m.uses} 次）`)
  ]
  try {
    withTransaction(rt.db, () => {
      const state = rt.db.prepare(`SELECT value FROM genome_state WHERE key = 'active'`).get() as { value: string } | undefined
      const current = state?.value ?? rt.genomes.tryActiveId()
      if (current && current !== base.id) throw new Error(`生效版本已并发变更为 ${current}（预期 ${base.id}），请重试沉淀`)
      const ts = new Date().toISOString()
      rt.db.prepare(`INSERT INTO candidates (genome_id, evolution_run, parent, target, diagnosis, change, status, ts,
        verification_run, verification_pass, verification_total, verification_scope, verified_at)
        VALUES (?,?,?,?,?,?, 'pending', ?, ?,?,?,?,?)`)
        .run(
          g.id, `consolidate-${Date.now()}`, base.id, 'consolidate', `来自会话的证据：${evidence.join('；')}`,
          JSON.stringify(changes), ts,
          ver ? ver.runId.trim() : null,
          ver ? ver.pass : null,
          ver ? ver.total : null,
          ver?.scope?.trim() || scope,
          ver ? (ver.verifiedAt ?? ts) : null
        )
      for (const o of overlays) rt.evolve.setOverlay(o.id, 'promoted')
      rt.evolve.log({ kind: 'learned', text: `生成 genome 候选 ${g.id}，等待你批准：${changes.join('；')}`, refs: [g.id, ...overlays.map((o) => o.id), ...memory.map((m) => m.id)] })
    })
  } catch (error) {
    rmSync(genomeFile, { force: true })
    if (writtenPrompt) rmSync(writtenPrompt, { force: true })
    throw error
  }
  return { genome: g.id, changes, scope }
}
