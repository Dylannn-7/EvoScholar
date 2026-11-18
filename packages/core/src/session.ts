import { join } from 'node:path'
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
import { GenomeRepo, PROTECTED_LIMITS, roleFor, type HarnessGenome } from './genome'
import { meterModel } from './metering'
import { createModel, modelInfo } from './providers'
import { buildTools, type ToolEnv } from './tools'
import { TrajectoryRecorder, textOf } from './trajectory'

export type Runtime = { ws: Workspace; db: Db; ledger: Ledger; genomes: GenomeRepo }

export function openRuntime(ws: Workspace, onAlert?: (m: string) => void): Runtime {
  const db = openDb(ws.dataDir)
  return { ws, db, ledger: new Ledger(db, ws.config, onAlert), genomes: new GenomeRepo(ws.root) }
}

export type ResearchSession = {
  id: string
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
  } = {}
): Promise<ResearchSession> {
  const genome = opts.genome ?? rt.genomes.load()
  const sessionId = opts.sessionId ?? `s-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
  const category = opts.category ?? 'usage'
  const ref = roleFor(genome, opts.stage)
  const info = modelInfo(rt.ws.config, ref)
  const model = meterModel(
    createModel(rt.ws.config, ref, { parameters: genome.routing.parameters?.[ref] }),
    { ledger: rt.ledger, modelRef: ref, category: () => category, sessionId, genomeId: genome.id, onWarning: opts.onWarning }
  )
  const env: ToolEnv = { ws: rt.ws, ledger: rt.ledger, category: () => category, sessionId, genomeId: genome.id, approve: opts.approve }
  const tools = buildTools(genome.tools.enabled, env, genome.tools.overrides, (s) => rt.genomes.text(s))
  const recorder = new TrajectoryRecorder(rt.db, sessionId, genome.id, { category, title: opts.title, stage: opts.stage })
  const b = genome.budgets
  const maxOutputTokens = Math.min(b.maxOutputTokens, info.maxOutputTokens ?? b.maxOutputTokens)
  const inputBudget = Math.min(b.contextBudgetTokens ?? 120_000, PROTECTED_LIMITS.contextBudgetTokens, info.contextWindow - maxOutputTokens)
  const session = await openAgentSession({
    sessionId,
    model,
    tools,
    instructions: rt.genomes.text(genome.instructions.system),
    store: createJournalAgentStore({ directory: join(rt.ws.dataDir, 'sessions') }),
    maxSteps: b.maxSteps,
    maxOutputTokens,
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
      recorder.onEvent(e)
      opts.onEvent?.(e)
    }
  })
  return {
    id: sessionId,
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
    dispose: () => session.dispose()
  }
}
