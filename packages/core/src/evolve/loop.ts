// In-loop self-evolution (docs/in-loop-evolution.md, amended by docs/PLAN.md §3).
// Recall -> think/act -> observe -> (forced) reflect -> adjust -> self-check -> score & credit,
// all through public harness options: transformContext, guards, extra tools and onEvent.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { AgentEvent, AgentMessage, AgentTool, Json, ToolGuard } from '@evoscholar/harness'
import { objectArgs, textResult, type ToolEnv } from '../tools/types'
import { kernelTools } from './kernels'
import { inside } from '../tools/sandbox'
import { skillSource, skillUntrusted } from '../skills'
import { EVOLVE_DEFAULTS, betaScore, isProjectRule, relevance, validateMemoryText, type EvolveEvent, type EvolveStore, type MemoryItem } from './store'

export type ChoiceOption = { label: string; detail?: string }
export type EvolveHooks = {
  store: EvolveStore
  sessionId: string
  projectId: string | null
  stage?: string
  cwd: string
  turnId: () => number | undefined
  /** UI + log sink for evolve steps. */
  emit?: (e: EvolveEvent & { id: number }) => void
  /** Ask the user to pick one option; undefined = unattended (first option). */
  choose?: (question: string, options: ChoiceOption[], signal?: AbortSignal) => Promise<number | null>
  /** Names that tune_harness may target. */
  toolNames: string[]
  skillNames: string[]
  /** Tool environment; enables forge_skill / run_skill / patch_skill / propose_rule. */
  env?: ToolEnv
}

const EXTERNAL_TOOLS = new Set(['web_search', 'web_fetch', 'pdf_text', 'pdf_page_image', 'lit_import', 'lit_search', 'lit_lookup'])
const UPLOADS = /^(?:\.\/)*evoscholar-in(?:\/|$)/

/**
 * Does this call bring third-party content into the context? Covers web and literature tools,
 * files the user uploaded (often other people's documents) and imported skill text or scripts.
 */
export function externalCallSource(call: { name: string; arguments: unknown }, importedSkill: (name: string) => boolean): string | undefined {
  if (EXTERNAL_TOOLS.has(call.name)) return `外部工具 ${call.name}`
  const a = (call.arguments && typeof call.arguments === 'object' ? call.arguments : {}) as Record<string, unknown>
  if ((call.name === 'read_skill' || call.name === 'run_skill') && typeof a.name === 'string' && importedSkill(a.name)) return `导入技能 ${a.name}`
  if (call.name === 'read_file' && typeof a.path === 'string' && UPLOADS.test(a.path.split('\\').join('/'))) return '用户上传的文件'
  return undefined
}

/** First external source visible in a context window: attachments and external tool calls. */
export function externalContextSource(messages: readonly AgentMessage[], importedSkill: (name: string) => boolean): string | undefined {
  for (const m of messages) {
    if (m.role === 'user' && m.content.some((b) => b.type !== 'text')) return '用户附带的文件或图片'
    for (const c of m.calls ?? []) {
      const source = externalCallSource(c, importedSkill)
      if (source) return source
    }
  }
  return undefined
}
const CHECKS: Record<string, string> = { figure: 'figure_check', manuscript: 'manuscript_check' }
const FIGURE_EXT = new Set(['.png', '.pdf', '.svg', '.eps', '.tif', '.tiff', '.jpg', '.jpeg'])
const MANUSCRIPT_EXT = new Set(['.tex', '.docx', '.doc'])
export const HARNESS_OPS = ['prompt.note', 'tool.note', 'skill.enable', 'skill.disable'] as const
type HarnessOp = typeof HARNESS_OPS[number]

const hashArgs = (name: string, args: unknown) => `${name}:${createHash('sha1').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 10)}`
const textOf = (blocks: AgentMessage['content']) => blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
const REF = /\b([LP]-\d{4})\b/g

/** Classify a tool result as a failure signal (doc §3.2). */
export function failureSignal(name: string, text: string, isError: boolean): string | undefined {
  if (/Permission denied|Host guard denied/.test(text)) return `${name} 被拦截或用户拒绝`
  if (isError) return `${name} 出错：${text.replace(/\s+/g, ' ').slice(0, 160)}`
  if (name === 'figure_check' || name === 'manuscript_check') {
    const m = /"error"\s*:\s*(\d+)|错误\s*[:：]?\s*(\d+)|(\d+)\s*个错误/.exec(text)
    const n = Number(m?.[1] ?? m?.[2] ?? m?.[3] ?? 0)
    if (n > 0) return `${name} 报告 ${n} 个错误级问题`
  }
  if (name === 'lit_verify' && /\b(not_found|mismatch|retracted)\b/.test(text)) return 'lit_verify 发现未找到、不匹配或已撤稿的引用'
  return undefined
}

export const EVOLVE_INSTRUCTIONS = `

## 自进化协议（EvoScholar 宿主提供）
你在一个会自我改进的工作台里工作。宿主会在用户消息后附上 <经验> 块，供参考。
- 按这个顺序处理冲突：本次用户明确要求 → 用户设定的项目规则 → 模型笔记和历史交付物。用户要求沿用项目顺序时，罗列标题、字段或选项只指定名称；明确重新指定先后才会覆盖项目顺序。写入新交付物前，核对内容和顺序是否符合当前要求。
- 推理时按「计划 → 观察 → 反思 → 下一步」组织；用到某条经验时写出编号，例如「按 L-0031 直接换源」。
- 出现 <反思要求> 时，先调用 reflect 说明原因和换什么做法，再继续；同一个失败的调用不要原样重试第三次（会被宿主拦截）。没有明确失败、但觉得方向不对时，也可以主动调用 reflect。
- 值得以后复用的做法（某类数据怎么解析、某个源不可用时换什么、某种检查的坑）用 note_lesson 记下：写成「什么情况 → 怎么做」，一条一个要点，不写本次任务的具体数值。
- 遇到口味类决定（配色、图版式、引用格式、表述风格、检索范围）且用户没有说明时，用 offer_choices 给出 2–3 个方案让用户选，用户的选择会成为偏好。
- 同类处理（解析某种仪器导出格式、某个固定的统计流程）跑通后，用 forge_skill 封装成带测试的函数，以后用 run_skill 直接调用；技能文档漏掉的要点用 patch_skill 补充。
- 写作检查漏掉的问题、用户反复纠正的写法，用 propose_rule 提成规则（先试用，用户确认后生效）。
- 觉得本会话的工作方式本身需要调整（给某阶段加一条规则、给某个工具的说明补一句、启用或停用某个技能）时，用 tune_harness；它只在本会话试用，持久化需要用户批准。
- 任何时候都不要试图关闭检查、跳过审批、放宽权限或上限。`

export function installEvolveLoop(h: EvolveHooks) {
  const st = {
    block: '' as string,
    projectRules: '',
    usesProjectDefaults: false,
    injected: [] as string[],
    calls: new Map<string, { name: string; args: unknown; key: string }>(),
    seenTool: new Set<string>(),
    failures: new Map<string, number>(),
    unresolved: new Map<string, string>(), // tool name -> last failure
    signals: [] as string[],
    pendingReflect: undefined as { messageId: string; text: string } | undefined,
    reflectedSinceFailure: true,
    cited: new Set<string>(),
    toolsUsed: new Set<string>(),
    wrote: new Set<string>(),
    learned: [] as string[],
    selfChecked: false,
    outputHashes: new Map<string, string>(),
    overlaysVersion: 0
  }
  const emit = (e: EvolveEvent) => {
    const id = h.store.log({ ...e, sessionId: h.sessionId, projectId: h.projectId, turnId: h.turnId() })
    h.emit?.({ ...e, id })
  }

  // ---------------------------------------------------------------- provenance (item 23)
  // Once third-party content enters this session's context, everything the model distils
  // afterwards is untrusted: it may restate injected text from an earlier turn or a summary.
  let external = h.store.externalSource(h.sessionId)
  const importedSkill = (name: string) => {
    if (!h.env) return false
    try { return skillUntrusted(skillSource(h.env.ws.root, name)) } catch { return true }
  }
  const markExternal = (source: string | undefined) => {
    if (!source || external) return
    external = source
    emit({ kind: 'observe', text: `本会话上下文含外部内容（${source}），之后记下的经验只作试用，不会自动生效`, data: { provenance: source } })
  }

  // ---------------------------------------------------------------- recall (doc §3.1)
  function recall(query: string, limit = EVOLVE_DEFAULTS.maxInjected): MemoryItem[] {
    const items = h.store.recallable(h.projectId).filter((m) => m.scope !== 'stage' || !m.stage || m.stage === h.stage)
    const scored = items.map((m) => {
      const sim = relevance(query, `${m.trigger} ${m.content}`)
      const local = h.projectId && m.project_id === h.projectId ? 0.2 : 0
      const kindBoost = m.kind === 'preference' && m.status === 'active' ? 0.1 : 0
      return { m, s: (m.pinned ? 1 : 0) + sim * 0.7 + betaScore(m) * 0.2 + kindBoost + local - (m.status === 'trial' ? 0.05 : 0), sim: sim + local }
    }).filter((x) => x.m.pinned || x.sim >= 0.18 || (x.m.kind === 'preference' && x.m.status === 'active' && x.sim >= 0.1))
    scored.sort((a, b) => b.s - a.s)
    const out: MemoryItem[] = []
    let chars = 0
    for (const { m } of scored) {
      const line = `${m.trigger} → ${m.content}`
      if (out.length >= limit || chars + line.length > EVOLVE_DEFAULTS.maxInjectedChars) break
      out.push(m)
      chars += line.length
    }
    return out
  }
  const fmt = (m: MemoryItem) => {
    const n = Math.round(m.wins + m.losses)
    const label = isProjectRule(m) ? '用户设定的项目规则：' : m.kind === 'preference' ? '偏好记录：' : ''
    return `[${m.id}] ${label}${m.trigger} → ${m.content}${m.status === 'trial' ? '（试用）' : ''}${n ? `（得分 ${betaScore(m).toFixed(2)}，用过 ${m.uses} 次）` : ''}`
  }

  function beginTurn(userText: string) {
    Object.assign(st, { signals: [], unresolved: new Map(), failures: new Map(), cited: new Set(), toolsUsed: new Set(), wrote: new Set(), learned: [], selfChecked: false, pendingReflect: undefined, reflectedSinceFailure: true })
    // Explicit "from now on" requests become pinned preferences right away (doc §6).
    const m = /((以后|今后|之后)(都|一律|统一|就都)|每次都|一律)([^。！？\n]{3,120})/.exec(userText)
    if (m && /(用|要|别|不要|改成|写成|按|保持|放|加|去掉)/.test(m[4])) {
      try {
        const { item } = h.store.upsert({ kind: 'preference', trigger: '用户明确要求', content: m[0].slice(0, 200), source: 'user', projectId: h.projectId, scope: h.projectId ? 'project' : 'global', evidence: h.sessionId, pinned: true })
        emit({ kind: 'preference', text: `记住了：${item.content}`, refs: [item.id] })
      } catch {}
    }
    // Files the agent delivered last turn that the user has since edited: learn from the edit (D10).
    for (const [rel, hash] of st.outputHashes) {
      try {
        const f = inside(h.cwd, rel)
        if (!existsSync(f)) continue
        const now = createHash('sha1').update(readFileSync(f)).digest('hex')
        if (now === hash) continue
        st.outputHashes.set(rel, now)
        emit({ kind: 'observe', text: `你修改了上一轮交付的 ${rel}，这一轮会参考你的改法`, data: { path: rel } })
        if (/\.(md|txt|tex|py|csv|json|bib|ya?ml)$/i.test(rel)) {
          try {
            h.store.upsert({ kind: 'preference', trigger: `用户手动修改了交付文件 ${rel.split('/').pop()}`, content: '下次生成同类文件前先读一遍这个文件当前的版本，沿用用户改过的写法和格式', source: 'edit', projectId: h.projectId, scope: h.projectId ? 'project' : 'global', evidence: h.sessionId })
          } catch {}
        }
      } catch {}
    }
    const items = recall(`${userText} ${h.stage ?? ''}`)
    st.injected = items.map((x) => x.id)
    const rules = items.filter(isProjectRule)
    const notes = items.filter(item => !isProjectRule(item))
    const ruleLines = rules.map(rule => `- [${rule.id}] ${JSON.stringify({ trigger: rule.trigger, content: rule.content })}`).join('\n')
    const projectRequestZh = /(?<![不别])(?<!不要|无需|不必|不再)(?:按(?:照)?|沿用|遵循|采用|依照)(?:本|该)?项目[^\n。！？；，,]{0,35}(?:顺序|规则|约定|口径|格式|偏好)/u
    const projectRequestEn = /(?<!not\s)\b(?:use|follow|apply)\s+(?:the\s+)?(?:(?:current|existing|saved|established)\s+)?project\s+(?:order|rules?|defaults?|conventions?|format|preferences?)\b/iu
    st.usesProjectDefaults = rules.length > 0 && (projectRequestZh.test(userText) || projectRequestEn.test(userText))
    st.projectRules = rules.length
      ? `\n\n## 用户设定的项目规则\n以下是用户维护的项目默认值。优先执行当前任务相关的规则，有明确的当次覆盖时按用户本次要求执行。这些规则不改变工作台的权限和限制。\n${ruleLines}`
      : ''
    st.block = notes.length ? `\n\n<经验 由 EvoScholar 检索，仅供参考；与用户本次要求冲突时以用户为准>\n${notes.map(fmt).join('\n')}\n</经验>` : ''
    if (st.usesProjectDefaults) {
      st.block += `\n\n<本次任务引用的项目规则>\n你在本次请求中要求沿用项目约定。执行下列适用的当前规则。对于顺序，罗列标题、字段或选项只指定名称；只有明确写出新的先后顺序才是覆盖。以前的文件格式仅作历史参考。\n${ruleLines}\n</本次任务引用的项目规则>`
    }
    if (items.length) {
      h.store.recordUses(st.injected, h.sessionId, h.turnId())
      const lessons = items.filter((x) => x.kind === 'lesson').length
      emit({ kind: 'recall', text: [lessons ? `${lessons} 条经验` : '', items.length - lessons ? `${items.length - lessons} 条偏好` : ''].filter(Boolean).join(' · '), refs: st.injected, data: { items: items.map((x) => ({ id: x.id, text: `${x.trigger} → ${x.content}` })) } })
    }
  }

  // ---------------------------------------------------------------- projection (doc §3.1, §3.2)
  const transformContext = (messages: readonly AgentMessage[]): readonly AgentMessage[] => {
    if (!external) markExternal(externalContextSource(messages, importedSkill))
    if (!st.block && !st.pendingReflect) return messages
    let lastUser = -1
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUser = i; break }
    return messages.map((m, i) => {
      if (i === lastUser && st.block) return { ...m, content: [...m.content, { type: 'text', text: st.block }] }
      if (st.pendingReflect && m.id === st.pendingReflect.messageId) return { ...m, content: [...m.content, { type: 'text', text: st.pendingReflect.text }] }
      return m
    })
  }

  // ---------------------------------------------------------------- observe (doc §3.2)
  const onEvent = (e: AgentEvent) => {
    if (e.type === 'model' && e.purpose !== 'compaction') {
      const ev = e.event
      if (ev.type === 'text-delta' || ev.type === 'reasoning-delta') for (const r of ev.text.matchAll(REF)) st.cited.add(r[1])
      // Calls batched with note_lesson run before the next projection, so check them here too.
      if (ev.type === 'finish') for (const c of ev.calls ?? []) {
        st.calls.set(c.id, { name: c.name, args: c.arguments, key: hashArgs(c.name, c.arguments) })
        st.toolsUsed.add(c.name)
        if (!external) markExternal(externalCallSource(c, importedSkill))
      }
    } else if (e.type === 'checkpoint') {
      for (const m of e.checkpoint.messages.slice(-8)) {
        if (m.role !== 'tool' || st.seenTool.has(m.id)) continue
        st.seenTool.add(m.id)
        const callId = String(m.invocationId ?? '').split('/').pop() ?? ''
        const call = st.calls.get(callId)
        if (!call || ['reflect', 'note_lesson', 'recall', 'tune_harness', 'offer_choices', 'patch_skill', 'propose_rule'].includes(call.name)) continue
        const text = textOf(m.content)
        const sig = failureSignal(call.name, text, !!m.isError)
        if (sig) {
          st.signals.push(sig)
          st.unresolved.set(call.name, sig)
          st.failures.set(call.key, (st.failures.get(call.key) ?? 0) + 1)
          st.reflectedSinceFailure = false
          const repeat = (st.failures.get(call.key) ?? 0) >= 2
          // Contextual recall at the moment lessons matter most: the failure itself.
          const extra = recall(`${call.name} ${sig} ${JSON.stringify(call.args).slice(0, 200)}`, 3).filter((x) => !st.injected.includes(x.id))
          if (extra.length) {
            h.store.recordUses(extra.map((x) => x.id), h.sessionId, h.turnId())
            st.injected.push(...extra.map((x) => x.id))
            emit({ kind: 'recall', text: `失败时检索到 ${extra.length} 条相关经验`, refs: extra.map((x) => x.id), data: { items: extra.map((x) => ({ id: x.id, text: `${x.trigger} → ${x.content}` })) } })
          }
          st.pendingReflect = { messageId: m.id, text: `\n<反思要求>上一步失败：${sig}${repeat ? '（同一调用已连续失败，第三次会被拦截）' : ''}。继续之前先调用 reflect：原因 → 下一步换什么做法 → 是否需要调整（经验 / 技能 / harness）。${extra.length ? `\n可能相关的经验：\n${extra.map(fmt).join('\n')}` : ''}</反思要求>` }
        } else {
          st.unresolved.delete(call.name)
          if (call.name === 'figure_check' || call.name === 'manuscript_check') st.unresolved.delete(call.name)
        }
      }
    }
  }
  const guard: ToolGuard = (args, _ctx, def) => {
    const n = st.failures.get(hashArgs(def.name, args)) ?? 0
    if (n >= EVOLVE_DEFAULTS.repeatFailureGuard - 1 && !st.reflectedSinceFailure) {
      emit({ kind: 'observe', text: `拦截了第 ${n + 1} 次相同的失败调用 ${def.name}，要求先反思` })
      return 'deny'
    }
    return 'abstain'
  }

  // ---------------------------------------------------------------- tools (doc §3.3)
  const tool = (name: string, description: string, properties: Record<string, Json>, required: string[], run: (a: Record<string, any>, signal: AbortSignal) => Promise<string> | string, parallel = false): AgentTool => ({
    name, version: '1', description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    scheduling: parallel ? 'parallel' : 'exclusive',
    validate: (i) => objectArgs(i, Object.keys(properties), required) as Json,
    authorize: async (_args, ctx) => {
      if (name === 'note_lesson' || name === 'tune_harness')
        return h.env?.approve?.(name, name === 'note_lesson' ? '保存本回合经验' : '记录本会话的工作方式调整', 'edit', ctx.signal) ?? true
      return true
    },
    async execute(args, ctx) {
      try { return textResult(await run(args as Record<string, any>, ctx.signal)) }
      catch (e) {
        if (ctx.signal?.aborted) throw e
        return textResult(`${name} 未执行：${(e as Error).message}`, true)
      }
    }
  })
  const markRefs = (refs: unknown) => {
    const ids = (Array.isArray(refs) ? refs : []).map(String).filter((x) => /^[LP]-\d{4}$/.test(x))
    for (const id of ids) st.cited.add(id)
    return ids
  }

  const tools: AgentTool[] = [
    tool('reflect', '反思：出现失败或方向可能不对时调用。说明情况、原因和下一步换什么做法；adjust 表示是否需要接着调整（lesson=记经验，harness=调整本会话工作方式，none=只换做法）。',
      {
        situation: { type: 'string', description: '发生了什么' },
        cause: { type: 'string', description: '原因判断' },
        next_action: { type: 'string', description: '下一步具体怎么做' },
        adjust: { type: 'string', enum: ['none', 'lesson', 'harness'] },
        refs: { type: 'array', items: { type: 'string' }, description: '参考了哪些经验编号，如 L-0003' }
      }, ['situation', 'cause', 'next_action'], (a) => {
        st.pendingReflect = undefined
        st.reflectedSinceFailure = true
        st.unresolved.clear() // failures the model has reflected on count as handled for the self-check
        for (const k of st.failures.keys()) st.failures.set(k, 0)
        const refs = markRefs(a.refs)
        emit({ kind: 'reflect', text: `${String(a.cause).slice(0, 120)} → ${String(a.next_action).slice(0, 160)}`, refs, data: { situation: a.situation, cause: a.cause, next: a.next_action, adjust: a.adjust ?? 'none' } })
        return a.adjust === 'lesson' ? '已记录反思。请接着调用 note_lesson 把可复用的做法记下来，然后继续。'
          : a.adjust === 'harness' ? '已记录反思。请接着调用 tune_harness 做本会话内的调整，然后继续。'
            : '已记录反思，请按新的做法继续。'
      }),
    tool('note_lesson', '记一条新的可复用经验或偏好：「什么情况 → 怎么做」。已有用户设定的项目规则时直接执行。相似的条目会合并，新经验先试用，后续验证有效后转正。',
      {
        trigger: { type: 'string', description: '什么情况下适用（一句话）' },
        advice: { type: 'string', description: '应该怎么做（一句话，可执行）' },
        kind: { type: 'string', enum: ['lesson', 'preference'] },
        scope: { type: 'string', enum: ['global', 'project', 'stage'], description: '默认：有项目时为 project，否则 global' }
      }, ['trigger', 'advice'], (a) => {
        const untrusted = !!external
        const scope = a.scope === 'project' && !h.projectId ? 'global' : a.scope ?? (h.projectId ? 'project' : 'global')
        const note = { trigger: String(a.trigger), content: String(a.advice) }
        validateMemoryText(`${note.trigger} ${note.content}`)
        const rule = h.store.projectRuleForNote(h.projectId, note)
        if (rule) return `已有用户设定的项目规则 ${rule.id}：${rule.content}。请按规则执行。`
        const { item, merged } = h.store.upsert({ kind: a.kind === 'preference' ? 'preference' : 'lesson', ...note, source: 'model', scope, projectId: scope === 'project' ? h.projectId : null, stage: scope === 'stage' ? h.stage ?? null : null, evidence: h.sessionId, untrusted })
        st.learned.push(item.id)
        st.cited.add(item.id)
        emit({ kind: 'adjust', text: `${merged ? '更新' : '新增'}${item.kind === 'lesson' ? '经验' : '偏好'} ${item.id}（${item.status === 'active' ? '已生效' : untrusted ? '试用，来源含外部内容' : '试用'}）：${item.trigger} → ${item.content}`, refs: [item.id], data: { memory: item.id, revertable: true } })
        return `${merged ? '已合并到' : '已记录为'} ${item.id}（${item.status === 'active' ? '生效' : '试用'}）。`
      }),
    tool('recall', '主动检索过去的经验和用户偏好（宿主已自动注入最相关的几条，需要更多时再用）。',
      { query: { type: 'string' } }, ['query'], (a) => {
        const items = recall(String(a.query), 8).filter((x) => !st.injected.includes(x.id))
        if (!items.length) return '没有找到更多相关经验。'
        h.store.recordUses(items.map((x) => x.id), h.sessionId, h.turnId())
        st.injected.push(...items.map((x) => x.id))
        emit({ kind: 'recall', text: `主动检索「${String(a.query).slice(0, 40)}」：${items.length} 条`, refs: items.map((x) => x.id) })
        return items.map(fmt).join('\n')
      }, true),
    tool('tune_harness', '在本会话内试用一项工作方式调整，下一回合生效：prompt.note 给系统指令追加一条规则；tool.note 给某个工具的说明补一句（target=工具名）；skill.enable / skill.disable 启用或停用技能（target=技能名）。持久化到 genome 需要用户批准。',
      {
        op: { type: 'string', enum: [...HARNESS_OPS] },
        target: { type: 'string' },
        value: { type: 'string', description: '要追加的规则或说明（skill.* 可留空）' },
        reason: { type: 'string' }
      }, ['op', 'reason'], (a) => {
        const op = a.op as HarnessOp
        if (!HARNESS_OPS.includes(op)) throw new Error('不支持的会话调整')
        const value = String(a.value ?? '').trim()
        if (op === 'tool.note' && !h.toolNames.includes(String(a.target))) throw new Error(`未知工具 ${a.target}`)
        if (op.startsWith('skill.') && !h.skillNames.includes(String(a.target))) throw new Error(`未知技能 ${a.target}`)
        if ((op === 'prompt.note' || op === 'tool.note') && !value) throw new Error('value 不能为空')
        if (value) validateMemoryText(value)
        const id = h.store.addOverlay({ sessionId: h.sessionId, op, target: a.target ? String(a.target) : undefined, value, reason: String(a.reason), turnId: h.turnId(), beforeScore: h.store.lastScore(h.sessionId) })
        st.overlaysVersion++
        const label = op === 'prompt.note' ? `追加规则：${value}` : op === 'tool.note' ? `${a.target} 的说明补充：${value}` : `${op === 'skill.enable' ? '启用' : '停用'}技能 ${a.target}`
        emit({ kind: 'adjust', text: `本会话：${label}`, refs: [id], data: { overlay: id, revertable: true, op } })
        return `已加入本会话的覆盖层（${id}），下一回合生效。`
      }),
    tool('offer_choices', '遇到口味类决定且用户没有说明时，给出 2–3 个方案请用户选择。用户的选择会被记为偏好。',
      {
        question: { type: 'string' },
        options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string' } }, required: ['label'], additionalProperties: false } },
        topic: { type: 'string', description: '偏好的主题，如「出图配色」' }
      }, ['question', 'options'], async (a, signal) => {
        const options = (a.options as ChoiceOption[]).slice(0, 4)
        if (!h.choose) return `无人值守，按第一个方案执行：${options[0].label}`
        emit({ kind: 'choice', text: String(a.question), data: { options } })
        const idx = await h.choose(String(a.question), options, signal)
        signal?.throwIfAborted()
        if (idx === null || idx === undefined || !options[idx]) return '用户没有选择，请按最稳妥的方案继续，并在回答里说明可以改。'
        const picked = options[idx]
        const others = options.filter((_, i) => i !== idx).map((o) => o.label)
        try {
          const { item } = h.store.upsert({ kind: 'preference', trigger: String(a.topic || a.question).slice(0, 80), content: `选择「${picked.label}」${others.length ? `（没选：${others.join('、')}）` : ''}`, source: 'choice', projectId: h.projectId, scope: h.projectId ? 'project' : 'global', evidence: h.sessionId })
          st.learned.push(item.id)
          emit({ kind: 'preference', text: `选择了「${picked.label}」，记为偏好 ${item.id}`, refs: [item.id] })
        } catch {}
        return `用户选择了：${picked.label}${picked.detail ? `（${picked.detail}）` : ''}`
      })
  ]

  if (h.env) tools.push(...kernelTools({
    store: h.store, sessionId: h.sessionId, env: h.env, emit,
    addOverlay: (op, target, value, reason) => h.store.addOverlay({ sessionId: h.sessionId, op, target, value, reason, turnId: h.turnId(), beforeScore: h.store.lastScore(h.sessionId) })
  }))

  // ---------------------------------------------------------------- self-check & scoring (doc §3.4, §7)
  function noteFiles(paths: string[]) { for (const p of paths) st.wrote.add(p.split('\\').join('/')) }

  /** Returns a self-check prompt for one extra round, or undefined. At most once per turn. */
  function selfCheck(): string | undefined {
    if (st.selfChecked) return undefined
    const reasons: string[] = []
    if (st.unresolved.size) reasons.push(`本回合还有没解决的失败：${[...st.unresolved.values()].join('；')}`)
    const wrote = [...st.wrote]
    if (st.usesProjectDefaults && wrote.length) {
      reasons.push(`用 read_file 核对本轮最终交付物（${wrote.slice(0, 3).join('、')} 中用户指定的输出路径），工作副本和中间脚本无需检查。用户要求沿用项目顺序时，按规则的先后检查落盘文件。标题罗列和历史文件的排列不构成当次覆盖。有误用 edit_file 或 write_file 修正，核对后直接结束`)
    }
    const figs = wrote.filter((p) => FIGURE_EXT.has(extname(p).toLowerCase()))
    const docs = wrote.filter((p) => MANUSCRIPT_EXT.has(extname(p).toLowerCase()))
    if (figs.length && !st.toolsUsed.has(CHECKS.figure) && h.toolNames.includes(CHECKS.figure)) reasons.push(`生成了图（${figs.slice(0, 3).join('、')}），但还没有运行 figure_check`)
    if (docs.length && !st.toolsUsed.has(CHECKS.manuscript) && h.toolNames.includes(CHECKS.manuscript)) reasons.push(`改动了稿件（${docs.slice(0, 3).join('、')}），但还没有运行 manuscript_check`)
    if (!reasons.length) return undefined
    st.selfChecked = true
    emit({ kind: 'selfcheck', text: reasons.join('；') })
    return `【自检】交付前请核对：${reasons.join('；')}。需要的话补跑检查或修正；确认无误后简短说明结论。`
  }

  function finishTurn(status: string, opts: { credit?: boolean } = {}) {
    // Turns that end in a runtime error or a user stop are not evidence about memories or overlays.
    if (opts.credit === false) {
      for (const p of st.wrote) {
        try { st.outputHashes.set(p, createHash('sha1').update(readFileSync(inside(h.cwd, p))).digest('hex')) } catch {}
      }
      return { score: undefined, confidence: 0 }
    }
    const failures = st.signals.length
    const unresolved = st.unresolved.size
    let score = 0.7
    if (status !== 'complete') score = 0.2
    else if (unresolved) score = 0.35
    else if (failures) score = 0.75
    if (status === 'complete' && !unresolved && (st.toolsUsed.has('figure_check') || st.toolsUsed.has('manuscript_check'))) score = Math.min(0.9, score + 0.1)
    const confidence = 0.6
    const turnId = h.turnId()
    h.store.scoreTurn(h.sessionId, turnId, score, confidence, { status, failures, unresolved, tools: [...st.toolsUsed], wrote: [...st.wrote].slice(0, 20) })
    const adopted = [...st.cited].filter((id) => st.injected.includes(id))
    if (adopted.length) h.store.markAdopted(adopted, h.sessionId, turnId)
    const credited = h.store.credit(h.sessionId, turnId, score, confidence)
    for (const o of h.store.overlays(h.sessionId).filter((x) => x.status === 'trial')) {
      if (o.before_score !== null && score < o.before_score - 0.25) {
        h.store.setOverlay(o.id, 'reverted', score)
        st.overlaysVersion++
        emit({ kind: 'revert', text: `自动撤销本会话调整 ${o.id}：之后的回合表现变差`, refs: [o.id] })
      } else h.store.setOverlay(o.id, 'kept', score)
    }
    const promoted = credited.filter((c) => c.status === 'active' && c.before < c.after)
    if (st.learned.length || credited.length)
      emit({ kind: 'learned', text: [st.learned.length ? `新增或更新 ${st.learned.length} 条` : '', adopted.length ? `采用了 ${adopted.join('、')}` : '', promoted.length ? `${promoted.map((p) => p.id).join('、')} 得分上升` : ''].filter(Boolean).join(' · ') || '记录了本回合结果', refs: [...new Set([...st.learned, ...credited.map((c) => c.id)])], data: { score, credited } })
    for (const p of st.wrote) {
      try { st.outputHashes.set(p, createHash('sha1').update(readFileSync(inside(h.cwd, p))).digest('hex')) } catch {}
    }
    return { score, confidence }
  }

  /** Late explicit feedback from the user (thumbs) re-credits the last scored turn with full weight. */
  function userFeedback(value: number) {
    const turnId = h.turnId()
    const score = value > 0 ? 1 : 0
    h.store.scoreTurn(h.sessionId, turnId, score, 1, { user: value })
    const credited = h.store.credit(h.sessionId, turnId, score, 1)
    if (credited.length) emit({ kind: 'credit', text: `你的${value > 0 ? '好评' : '差评'}已计入 ${credited.map((c) => c.id).join('、')}`, refs: credited.map((c) => c.id) })
  }

  /** Session overlay rendered for configure(): extra instructions, tool notes, skill switches. */
  function overlay() {
    const rows = h.store.overlays(h.sessionId).filter((o) => o.status === 'trial' || o.status === 'kept')
    const notes = rows.filter((o) => o.op === 'prompt.note').map((o) => `- ${o.value}（${o.id}）`)
    const toolNotes: Record<string, string> = {}
    for (const o of rows.filter((x) => x.op === 'tool.note' && x.target)) toolNotes[o.target!] = `${toolNotes[o.target!] ?? ''} ${o.value}`.trim()
    return {
      version: rows.map((o) => o.id).join('|'),
      instructions: notes.length ? `\n\n## 本会话试用的调整\n${notes.join('\n')}` : '',
      toolNotes,
      enable: rows.filter((o) => o.op === 'skill.enable').map((o) => o.target!),
      versions: Object.fromEntries(rows.filter((o) => o.op === 'skill.version' && o.target).map((o) => [o.target!, Number(o.value)])) as Record<string, number>,
      disable: rows.filter((o) => o.op === 'skill.disable').map((o) => o.target!)
    }
  }
  const bumpOverlay = () => { st.overlaysVersion++ }

  return { instructions: EVOLVE_INSTRUCTIONS, projectRules: () => st.projectRules, tools, transformContext, guards: [guard], onEvent, beginTurn, noteFiles, selfCheck, finishTurn, userFeedback, overlay, bumpOverlay, state: st }
}
export type EvolveLoop = ReturnType<typeof installEvolveLoop>

export function memoryFile(dataDir: string) { return join(dataDir, 'memory', 'memory.md') }
