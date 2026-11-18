import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createJournalAgentStore,
  openAgentSession,
  type AgentEvent,
  type AgentSession,
  type ContentBlock,
  type ModelRequest,
  type RunStatus
} from '@evoscholar/harness'
import { Ledger } from './budget'
import type { BudgetCategory, Workspace } from './config'
import { openDb, type Db } from './db'
import { GenomeRepo, PROTECTED_LIMITS, modelFor, stageRole, type HarnessGenome } from './genome'
import { meterModel } from './metering'
import { createModel, defaultModelRef, modelInfo } from './providers'
import { permissionGate } from './permissions'
import type { PermissionMode } from './config'
import { buildTools, stopAllProcesses, type ToolEnv } from './tools'
import { TrajectoryRecorder, textOf } from './trajectory'
import { skillIndex } from './skills'
import { openWorkflow } from './workflow'

export type Runtime = { ws: Workspace; db: Db; ledger: Ledger; genomes: GenomeRepo }

export function openRuntime(ws: Workspace, onAlert?: (m: string) => void): Runtime {
  const db = openDb(ws.dataDir)
  return { ws, db, ledger: new Ledger(db, ws.config, onAlert), genomes: new GenomeRepo(ws.root) }
}

export type ResearchSession = {
  id: string
  cwd: string
  /** Model ref and effort the session was opened with. */
  model: string
  effort?: string
  genome: HarnessGenome
  session: AgentSession
  recorder: TrajectoryRecorder
  /** Send a user message; resolves with the run status and final assistant text. */
  ask(blocks: ContentBlock[] | string): Promise<{ status: RunStatus; answer: string }>
  dispose(): Promise<void>
}

const measure = (r: ModelRequest) => Math.ceil(JSON.stringify(r).length / 3)

export async function openResearchSession(
  rt: Runtime,
  opts: {
    sessionId?: string
    genome?: HarnessGenome
    category?: BudgetCategory
    stage?: string
    title?: string
    onEvent?: (e: AgentEvent) => void
    onWarning?: (m: string) => void
    approve?: ToolEnv['approve']
    /** Working directory for file/process tools. Defaults to data/projects/<sessionId>. */
    cwd?: string
    /** Model ref chosen in the composer; overrides the user's default model. */
    model?: string
    /** Raw reasoning effort value for `model`. */
    effort?: string
    /** Permission mode, read on every approval (can change between turns). */
    permission?: () => PermissionMode
    /** Folder (relative to cwd) where deliverables should be written. */
    outputDir?: string
    /** Files a tool created or modified (relative to cwd). */
    onFiles?: (paths: string[]) => void
  } = {}
): Promise<ResearchSession> {
  const genome = opts.genome ?? rt.genomes.load()
  const sessionId = opts.sessionId ?? `s-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
  const category = opts.category ?? 'usage'
  const ref = modelFor(genome, stageRole(genome, opts.stage), {
    defaults: rt.ws.settings?.defaults,
    session: opts.model,
    fallback: defaultModelRef(rt.ws.config)
  })
  const recorder = new TrajectoryRecorder(rt.db, sessionId, genome.id, { category, title: opts.title, stage: opts.stage })
  const info = modelInfo(rt.ws.config, ref)
  const enforceCap = category !== 'usage' || !!rt.ws.config.budget.enforceUsageCap
  const model = meterModel(
    createModel(rt.ws.config, ref, { parameters: genome.routing.parameters?.[ref], effort: opts.effort }),
    { ledger: rt.ledger, modelRef: ref, contextWindow: info.contextWindow, imageInputTokenCap: info.imageInputTokenCap,
      enforceCap, category: () => category, sessionId, genomeId: genome.id, onWarning: opts.onWarning }
  )
  const cwd = resolve(opts.cwd ?? join(rt.ws.dataDir, 'projects', sessionId))
  mkdirSync(join(cwd, '.evoscholar'), { recursive: true })
  const traceFile = join(cwd, '.evoscholar', 'trace.jsonl')
  const trace = (e: Record<string, unknown>) => {
    const row = { ts: new Date().toISOString(), session: sessionId, genome: genome.id, ...e }
    appendFileSync(traceFile, JSON.stringify(row) + '\n')
    recorder.hostEvent(row)
  }
  const approve = permissionGate(opts.permission ?? (() => 'ask'), opts.approve)
  const env: ToolEnv = { ws: rt.ws, cwd, ledger: rt.ledger, category: () => category, sessionId, genomeId: genome.id, skills: genome.skills, approve, trace, model: ref, onFiles: opts.onFiles }
  const platform = process.platform === 'win32' ? 'Windows（命令用 PowerShell 语法）' : process.platform === 'darwin' ? 'macOS' : 'Linux'
  const outputNote = opts.outputDir ? `\n- 交付文件（图、表、文稿、数据结果）写到 ${opts.outputDir}/ 下；用户上传的文件在 evoscholar-in/ 下；不要改动项目里其他已有文件，除非用户明确要求` : ''
  const tools = buildTools(genome.tools.enabled, env, genome.tools.overrides, (s) => rt.genomes.text(s))
  const workflow = openWorkflow(genome, env, model, opts.stage)
  const b = genome.budgets
  const maxOutputTokens = enforceCap
    ? Math.min(b.maxOutputTokens, info.maxOutputTokens ?? b.maxOutputTokens)
    : (info.maxOutputTokens ?? b.maxOutputTokens)
  const inputBudget = enforceCap
    ? Math.min(b.contextBudgetTokens ?? 120_000, PROTECTED_LIMITS.contextBudgetTokens, info.contextWindow - maxOutputTokens)
    : Math.max(16_384, info.contextWindow - Math.min(maxOutputTokens, Math.floor(info.contextWindow * 0.4)))
  const session = await openAgentSession({
    sessionId,
    model: workflow?.model ?? model,
    tools: [...tools, ...(workflow?.tools ?? [])],
    instructions: rt.genomes.text(genome.instructions.system) + skillIndex(rt.ws.root, genome.skills) + (workflow?.instructions ?? '') + `\n\n## 当前环境\n- 工作目录：${cwd}（文件与进程工具只能访问这里，路径请用相对路径）${outputNote}\n- 系统：${platform}\n- 日期：${new Date().toISOString().slice(0, 10)}`,
    store: createJournalAgentStore({ directory: join(rt.ws.dataDir, 'sessions') }),
    maxSteps: b.maxSteps,
    maxOutputTokens,
    ...(!enforceCap ? { useProviderOutputDefault: true } : {}),
    timeoutMs: b.timeoutMs,
    toolResults: { authorize: async () => true },
    compaction: {
      inputBudget,
      keepRecentItems: 6,
      measure,
      maxOutputTokens: 4096,
      instructions: rt.genomes.text(genome.instructions.compaction) || undefined
    },
    onEvent: (e) => {
      workflow?.onEvent?.(e)
      recorder.onEvent(e)
      opts.onEvent?.(e)
    }
  })
  return {
    id: sessionId,
    cwd,
    model: ref,
    effort: opts.effort,
    genome,
    session,
    recorder,
    async ask(input) {
      const blocks: ContentBlock[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input
      recorder.beginTurn(textOf(blocks))
      let status: RunStatus = 'failed'
      let answer = ''
      try {
        status = await session.prompt(blocks)
        const snap = await session.snapshot()
        const last = [...snap.messages].reverse().find((m) => m.role === 'assistant')
        answer = textOf(last?.content)
        return { status, answer }
      } finally {
        recorder.endTurn(status, answer)
      }
    },
    async dispose() {
      await stopAllProcesses(sessionId)
      try { await session.dispose() } finally { await workflow?.dispose() }
    }
  }
}
