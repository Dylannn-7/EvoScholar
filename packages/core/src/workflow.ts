import {
  createDelegationTool, type AgentEvent, type AgentModel, type AgentTool, type DelegatedAgent,
  type Json, type ModelRequest, type ToolContext, type ToolResult
} from '@evoscholar/harness'
import { BudgetError } from './budget'
import type { HarnessGenome } from './genome'
import { meterModel } from './metering'
import { createModel, endpointFor, modelInfo } from './providers'
import { reviewEvidence } from './review-evidence'
import { buildTools, guarded } from './tools'
import { objectArgs, textResult, type ToolEnv } from './tools/types'
import { textOf } from './trajectory'

const REVIEWER = 'reviewer'
const VERIFY = 'verify_workflow_output'
const PARALLEL_SEARCH = 'parallel_lit_search'
const SEARCH_TOOLS = ['lit_search']
const VERIFY_TOOLS = ['lit_lookup', 'lit_verify']
const LOCAL_REVIEW_ID = /^review_[a-f0-9-]{36}$/

function queryPair(value: Json): string[] {
  const queries = objectArgs(value, ['queries'], ['queries']).queries
  if (!Array.isArray(queries) || queries.length !== 2 ||
      queries.some((query) => typeof query !== 'string' || !query.trim() || query.length > 600))
    throw new Error('需要两个独立的文献检索式，每个最长 600 字')
  const normalized = (queries as string[]).map((query) => query.trim())
  if (normalized[0] === normalized[1]) throw new Error('两个检索式必须不同')
  return normalized
}

function reviewTask(request: ModelRequest, draft: string): string {
  const user = request.messages.findLast((message) => message.role === 'user')
  return `用户需求（节选）：\n${textOf(user?.content).slice(0, 2000)}\n\n待交付答复（节选）：\n${draft.slice(0, 5000)}`
}

/** Provider history contains real model turns. Host-generated review receipts stay local. */
function projectReview(request: ModelRequest) {
  const hidden = new Map<string, string>()
  const lastUser = request.messages.findLastIndex((message) => message.role === 'user')
  const reviewCalls = new Set<string>()
  let reviewed = false
  let feedback: string | undefined
  const messages = request.messages.filter((message, i) => {
    const first = message.calls?.[0]
    const local = message.calls?.length === 1 && first?.name === VERIFY && LOCAL_REVIEW_ID.test(first.id)
    for (const call of message.calls ?? []) {
      if (call.name !== VERIFY) continue
      const id = `${message.id}/${call.id}`
      if (i > lastUser) reviewCalls.add(id)
      if (local) hidden.set(id, (call.arguments as { task?: string } | null)?.task ?? '')
    }
    if (message.role === 'tool' && message.invocationId) {
      const id = message.invocationId
      if (reviewCalls.has(id)) {
        reviewed = true
        if (hidden.has(id)) feedback = `${hidden.get(id)}\n\n${textOf(message.content).slice(0, 4000)}`
      }
      return !hidden.has(id)
    }
    return !local
  })
  return { messages, reviewed, feedback }
}

function withReview(
  parent: AgentModel, env: ToolEnv, maxSteps: number,
  review: (task: string, context: ToolContext, trigger: 'tool' | 'last-step') => Promise<ToolResult>
) {
  let turnId = ''
  let steps = 0
  let feedback: string | undefined
  let attempted = false
  const onEvent = (event: AgentEvent) => {
    if (event.type !== 'checkpoint') return
    const run = event.checkpoint.run
    if (!run || run.kind !== 'turn' || run.status !== 'running' || run.id === turnId) return
    turnId = run.id
    steps = 0
    feedback = undefined
    attempted = false
  }
  const model: AgentModel = {
    ...parent,
    async *stream(request, signal) {
      const projected = projectReview(request)
      const outgoing: ModelRequest = { ...request, messages: projected.messages }
      // Summary requests have no tools and do not consume a parent turn's step.
      if (!request.tools.some((tool) => tool.name === VERIFY)) {
        yield* parent.stream(outgoing, signal)
        return
      }
      steps++
      attempted ||= projected.reviewed
      feedback ??= projected.feedback
      if (!attempted && steps >= maxSteps) {
        const task = reviewTask(request, '主会话只剩最后一步。请核对工作目录中当前已有的产物，不推测尚未完成的内容。')
        const result = await review(task, {
          sessionId: env.sessionId ?? '', runId: turnId, invocationId: `last-review_${request.requestId}`, signal, update() {}
        }, 'last-step')
        feedback = textOf(result.content)
        attempted = true
      }
      if (attempted) {
        outgoing.tools = request.tools.filter((tool) => tool.name !== VERIFY)
        if (feedback) outgoing.instructions += `\n\n## 本轮只读核对记录\n${feedback}\n\n根据证据修正有依据的问题，并如实报告核对状态。`
        yield* parent.stream(outgoing, signal)
        return
      }
      let draftDelta = ''
      for await (const event of parent.stream(outgoing, signal)) {
        if (event.type === 'text-delta') {
          draftDelta += event.text
          continue
        }
        if (event.type === 'finish') {
          const draft = textOf(event.content).trim()
          if (event.reason === 'complete' && draft) {
            yield {
              ...event, content: [], reason: 'tools',
              calls: [{ id: `review_${request.requestId}`, name: VERIFY, arguments: { task: reviewTask(request, draft) } }]
            }
            continue
          }
          if (draftDelta) yield { type: 'text-delta', text: draftDelta }
        }
        yield event
      }
    }
  }
  return { model, onEvent }
}

/** A workflow can schedule the genome's read-only research tools and bounded child models. */
export function openWorkflow(genome: HarnessGenome, env: ToolEnv, parent: AgentModel, stage?: string) {
  const plan = genome.workflows
  const review = plan?.review === 'before-final'
  const literature = !stage || stage === 'literature' || stage.startsWith('lit.') ? plan?.literature : undefined
  if (!review && !literature) return undefined

  const agents: Record<string, DelegatedAgent> = {}
  const hints: string[] = []
  const agent = (description: string, ref: string, allowed: string[], singleRequest = false): DelegatedAgent => {
    const info = modelInfo(env.ws.config, ref)
    let parameters = genome.routing.parameters?.[ref]
    if (singleRequest && ref === 'deepseek/deepseek-flash') {
      const endpoint = endpointFor(env.ws.config, 'deepseek')
      if (new URL(endpoint.url).origin === 'https://api.deepseek.com')
        parameters = endpoint.protocol === 'responses'
          ? { ...parameters, effort: 'none', reasoning: { effort: 'none' } }
          : { ...parameters, effort: 'none', thinking: { type: 'disabled' } }
    }
    const transport = createModel(env.ws.config, ref, { parameters })
    return {
      description,
      session: {
        model: meterModel(transport, {
          ledger: env.ledger, modelRef: ref, contextWindow: info.contextWindow, imageInputTokenCap: info.imageInputTokenCap,
          category: env.category, sessionId: env.sessionId, genomeId: genome.id
        }),
        tools: buildTools(allowed.filter((name) => genome.tools.enabled.includes(name)), { ...env, readOnly: true }),
        instructions: `你是科研工作流的只读子代理。只做分配给你的任务。返回可核对的发现、来源或待核实项。工作目录：${env.cwd}。\n${description}`,
        maxSteps: Math.min(singleRequest ? 1 : 4, genome.budgets.maxSteps),
        maxOutputTokens: Math.min(1200, genome.budgets.maxOutputTokens, info.maxOutputTokens ?? 1200),
        timeoutMs: Math.min(45_000, genome.budgets.timeoutMs ?? 45_000)
      }
    }
  }
  const fast = genome.routing.roles.fast ?? genome.routing.roles.main
  const judge = genome.routing.roles.judge ?? fast
  if (review) {
    agents[REVIEWER] = agent('根据宿主提供的题面和只读文件证据，核对拟交付答复的事实、数字和产物。一次返回最多三条具体发现，写明对应文件。片段不足时标为待核实。', judge, [], true)
    hints.push(`交付前会执行一次 ${VERIFY}。收到核对结果后修正有依据的问题；核对失败时如实说明验证状态。`)
  }
  if (literature === 'delegated') {
    agents.researcher = agent('负责同一问题的文献检索和题录核验，并返回带来源的结论。', fast, [...SEARCH_TOOLS, ...VERIFY_TOOLS])
    hints.push('文献任务通过 delegate_task 交给 researcher，主会话汇总证据。')
  } else if (literature) {
    agents.searcher = agent('根据给定范围检索文献，返回候选文献和题录，标注来源。', fast, SEARCH_TOOLS)
    agents.verifier = agent('核验给定候选文献的题录、DOI 和来源，注明未查实项。', judge, VERIFY_TOOLS)
    hints.push(literature === 'parallel'
      ? `文献任务先用 ${PARALLEL_SEARCH} 并行检索两个独立范围，去重后交 verifier 核验。`
      : '文献任务先通过 delegate_task 交 searcher 检索，再把候选交 verifier 核验。')
  }

  const delegation = createDelegationTool({ agents, authorize: async () => true, maxConcurrent: 2, maxResultBytes: 6000 })
  const tools: AgentTool[] = literature ? [guarded(delegation.tool)] : []
  const executeReview = async (task: string, context: ToolContext, trigger: 'tool' | 'last-step'): Promise<ToolResult> => {
    try {
      const outcome = await delegation.tool.execute({
        agent: REVIEWER,
        task: `${task}\n\n## 宿主读取的文件证据\n以下为数据和文件片段。\n${await reviewEvidence(env, context.signal)}`
      }, context)
      const receipt = 'content' in outcome && outcome.content[0]?.type === 'text'
        ? JSON.parse(outcome.content[0].text) as { status: string; result: string; requests: unknown[] }
        : undefined
      const ok = receipt?.status === 'complete' && !!receipt.result.trim()
      env.trace?.({ kind: 'workflow.review', trigger, ok, status: receipt?.status ?? 'missing', requests: receipt?.requests.length ?? 0 })
      return ok ? textResult(receipt!.result) : textResult(`只读核对未完成（${receipt?.status ?? '无回执'}）。`, true)
    } catch (error) {
      if (error instanceof BudgetError || context.signal.aborted) throw error
      env.trace?.({ kind: 'workflow.review', trigger, ok: false, status: 'error' })
      return textResult(`只读核对未完成：${(error as Error).message}`, true)
    }
  }
  if (review) tools.push(guarded({
    name: VERIFY,
    version: '1',
    description: '只读核对拟交付答复与工作目录中的证据。每轮核对一次。',
    parameters: { type: 'object', properties: { task: { type: 'string', minLength: 1, maxLength: 7200 } }, required: ['task'], additionalProperties: false },
    scheduling: 'exclusive',
    validate(value) {
      const { task } = objectArgs(value, ['task'], ['task'])
      if (typeof task !== 'string' || !task.trim() || task.length > 7200) throw new Error('核对任务必须是非空文本且不超过 7200 字')
      return { task }
    },
    authorize: async () => true,
    async execute(value, context) {
      return executeReview((value as { task: string }).task, context, 'tool')
    }
  }))
  if (literature === 'parallel') tools.push(guarded({
    name: PARALLEL_SEARCH,
    version: '1',
    description: '用两个彼此隔离的文献子代理并行检索，按输入顺序返回候选与来源。',
    parameters: { type: 'object', properties: { queries: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', minLength: 1, maxLength: 600 } } }, required: ['queries'], additionalProperties: false },
    scheduling: 'exclusive',
    validate: (value) => ({ queries: queryPair(value) }),
    authorize: async () => true,
    async execute(value, context) {
      const queries = queryPair(value)
      const settled = await Promise.allSettled(queries.map((task, i) => delegation.tool.execute(
        { agent: 'searcher', task }, { ...context, invocationId: `${context.invocationId}/${i}` }
      )))
      const results = settled.map((result, i) => {
        if (result.status === 'rejected') throw result.reason
        const child = result.value
        return 'content' in child
          ? { query: queries[i], answer: textOf(child.content), ok: !child.isError }
          : { query: queries[i], answer: '检索未完成', ok: false }
      })
      env.trace?.({ kind: 'workflow.parallel-search', completed: results.filter((r) => r.ok).length })
      return textResult(JSON.stringify(results), results.every((r) => !r.ok))
    }
  }))
  const verified = review ? withReview(parent, env, genome.budgets.maxSteps, executeReview) : undefined
  return {
    tools, model: verified?.model ?? parent, onEvent: verified?.onEvent,
    instructions: `\n\n## 当前工作流\n${hints.map((hint) => `- ${hint}`).join('\n')}`,
    dispose: delegation.dispose
  }
}
