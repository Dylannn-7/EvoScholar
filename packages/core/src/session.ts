import { appendFileSync, realpathSync, mkdirSync } from 'node:fs'
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
import { DockerExecutor } from './docker-executor'
import type { ExecutionBackend } from './execution'
import { Ledger } from './budget'
import type { BudgetCategory, Workspace } from './config'
import { openDb, type Db } from './db'
import { GenomeRepo, PROTECTED_LIMITS, modelFor, stageRole, type HarnessGenome } from './genome'
import { meterModel } from './metering'
import { createModel, defaultModelRef, modelInfo } from './providers'
import { inside } from './tools/sandbox'
import { permissionGate } from './permissions'
import type { PermissionMode } from './config'
import { TOOL_FACTORIES, buildTools, runProcess, stopAllProcesses, type ToolEnv } from './tools'
import { TrajectoryRecorder, textOf } from './trajectory'
import { skillIndex } from './skills'
import { openWorkflow } from './workflow'
import { installEvolveLoop, type EvolveHooks, type EvolveLoop } from './evolve/loop'
import { EvolveStore } from './evolve/store'
import { extraSkills, listSkills, type SkillRef } from './skills'
import { kernelIndex } from './evolve/kernels'
import { reconcileRuntime } from './recovery'

export type Runtime = { ws: Workspace; db: Db; ledger: Ledger; genomes: GenomeRepo; evolve: EvolveStore; executor: ExecutionBackend }

export function openRuntime(ws: Workspace, onAlert?: (m: string) => void, executor?: ExecutionBackend): Runtime {
  const db = openDb(ws.dataDir)
  const ledger = new Ledger(db, ws.config, onAlert)
  const engineEnv: ToolEnv = { ws, cwd: ws.root, ledger, category: () => 'usage' }
  const rt: Runtime = {
    ws, db, ledger, genomes: new GenomeRepo(ws.root), evolve: new EvolveStore(db, ws.dataDir),
    executor: executor ?? new DockerExecutor(ws, (command, args, timeout, signal) => runProcess(command, args, engineEnv, timeout, signal))
  }
  reconcileRuntime(rt, {
    onLog: (msg) => {
      console.warn(`[启动对账] ${msg}`)
      onAlert?.(msg)
    }
  })
  return rt
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
  /** In-loop evolution handle when enabled. */
  evolve?: EvolveLoop
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
    /** In-loop self-evolution (memory, reflection, overlays). Off for evaluation runs. */
    evolve?: { store: EvolveStore; projectId: string | null; emit?: EvolveHooks['emit']; choose?: EvolveHooks['choose'] }
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
  const enforceCap = category !== 'usage'
  const model = meterModel(
    createModel(rt.ws.config, ref, { parameters: genome.routing.parameters?.[ref], effort: opts.effort }),
    { ledger: rt.ledger, modelRef: ref, contextWindow: info.contextWindow, imageInputTokenCap: info.imageInputTokenCap,
      category: () => category, sessionId, genomeId: genome.id, onWarning: opts.onWarning }
  )
  const workDir = resolve(opts.cwd ?? join(rt.ws.dataDir, 'projects', sessionId))
  mkdirSync(workDir, { recursive: true })
  const cwd = realpathSync(workDir)
  const tracePath = join('.evoscholar', 'trace.jsonl')
  mkdirSync(inside(cwd, '.evoscholar'), { recursive: true })
  inside(cwd, tracePath)
  const trace = (e: Record<string, unknown>) => {
    const row = { ts: new Date().toISOString(), session: sessionId, genome: genome.id, ...e }
    appendFileSync(inside(cwd, tracePath), JSON.stringify(row) + '\n')
    recorder.hostEvent(row)
  }
  const approve = permissionGate(opts.permission ?? (() => 'ask'), opts.approve)
  let loop: EvolveLoop | undefined
  const onFiles = (paths: string[]) => { loop?.noteFiles(paths); opts.onFiles?.(paths) }
  const env: ToolEnv = { ws: rt.ws, cwd, ledger: rt.ledger, category: () => category, sessionId, genomeId: genome.id, skills: genome.skills, approve, trace, model: ref, onFiles,
    executor: rt.executor, permission: opts.permission,
    hostExecutionAllowed: () => {
      const mode = opts.permission?.()
      return !!opts.approve && mode !== 'bypass' && mode !== 'plan'
    }
  }
  if (opts.evolve) {
    loop = installEvolveLoop({
      store: opts.evolve.store, sessionId, projectId: opts.evolve.projectId, stage: opts.stage, cwd,
      turnId: () => recorder.turn, emit: opts.evolve.emit, choose: opts.evolve.choose,
      toolNames: genome.tools.enabled, skillNames: listSkills(rt.ws.root).map((x) => x.name), env
    })
  }
  const platform = '模型代码默认在 Linux 容器用 POSIX 命令语法执行；宿主和容器通过项目相对路径交换文件。'
  const outputNote = opts.outputDir ? `\n- 交付文件（图、表、文稿、数据结果）写到 ${opts.outputDir}/ 下；用户上传的文件在 evoscholar-in/ 下；不要改动项目里其他已有文件，除非用户明确要求` : ''
  const workflow = openWorkflow(genome, env, model, opts.stage)
  const envNote = `\n\n## 当前环境\n- 工作目录：${cwd}（文件与进程工具只能访问这里，路径请用相对路径）${outputNote}\n- 系统：${platform}\n- 日期：${new Date().toISOString().slice(0, 10)}`
  /** Tools and instructions for the current session overlay (tool notes, skill switches, prompt notes). */
  const assemble = () => {
    const ov = loop?.overlay()
    const overrides: Record<string, { description?: string }> = { ...(genome.tools.overrides ?? {}) }
    for (const [t, note] of Object.entries(ov?.toolNotes ?? {})) {
      const base = TOOL_FACTORIES[t]?.(env).description ?? ''
      overrides[t] = { description: `${overrides[t]?.description ? rt.genomes.text(overrides[t].description!) : base}\n补充（本会话试用）：${note}` }
    }
    let skills: SkillRef[] = [...(genome.skills ?? [])].filter((x) => !ov?.disable.includes(x.name))
    for (const [name, version] of Object.entries(ov?.versions ?? {})) {
      skills = skills.some((x) => x.name === name) ? skills.map((x) => (x.name === name ? { name, version } : x)) : [...skills, { name, version }]
    }
    for (const name of ov?.enable ?? []) {
      const meta = listSkills(rt.ws.root).find((x) => x.name === name)
      if (meta && !skills.some((x) => x.name === name)) skills = [...skills, { name, version: meta.version }]
    }
    const tools = [...buildTools(genome.tools.enabled, { ...env, skills }, overrides, (s) => rt.genomes.text(s)), ...(workflow?.tools ?? []), ...(loop?.tools ?? [])]
    const forged = loop ? kernelIndex(rt.ws.root, extraSkills(rt.ws.root).map((x) => x.name)) : ''
    const style = rt.ws.settings?.defaults.figureStyle ? `\n- 用户默认出图风格：${rt.ws.settings.defaults.figureStyle}（在 run_python 里 \`import evoscholar_styles as S; S.use('${rt.ws.settings.defaults.figureStyle}', venue=...)\`；用户另有要求时以用户为准）` : ''
    const instructions = rt.genomes.text(genome.instructions.system) + skillIndex(rt.ws.root, skills) + forged + (workflow?.instructions ?? '') + (loop?.instructions ?? '') + (ov?.instructions ?? '') + envNote + style
    return { tools, instructions, version: ov?.version ?? '' }
  }
  const initial = assemble()
  let configured = initial.version
  const b = genome.budgets
  const maxOutputTokens = enforceCap
    ? Math.min(b.maxOutputTokens, info.maxOutputTokens ?? b.maxOutputTokens)
    : (info.maxOutputTokens ?? b.maxOutputTokens)
  const inputBudget = enforceCap
    ? Math.min(b.contextBudgetTokens ?? 120_000, PROTECTED_LIMITS.contextBudgetTokens, info.contextWindow - maxOutputTokens)
    : Math.max(16_384, info.contextWindow - Math.min(maxOutputTokens, Math.floor(info.contextWindow * 0.4)))
  let remainingSteps = b.maxSteps
  const session = await openAgentSession({
    admit: () => {
      if (remainingSteps <= 0) throw new Error('已达到本回合步数上限')
      remainingSteps--
    },
    sessionId,
    model: workflow?.model ?? model,
    tools: initial.tools,
    instructions: initial.instructions,
    ...(loop ? { transformContext: loop.transformContext, guards: loop.guards } : {}),
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
      loop?.onEvent(e)
      workflow?.onEvent?.(e)
      recorder.onEvent(e)
      opts.onEvent?.(e)
    }
  })
  let asking = false
  return {
    id: sessionId,
    cwd,
    model: ref,
    effort: opts.effort,
    genome,
    session,
    recorder,
    evolve: loop,
    async ask(input) {
      const blocks: ContentBlock[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input
      if (asking) throw new Error('上一轮还在运行')
      asking = true
      remainingSteps = b.maxSteps
      let status: RunStatus = 'failed'
      let answer = ''
      try {
        recorder.beginTurn(textOf(blocks))
        if (opts.outputDir) try { mkdirSync(inside(cwd, opts.outputDir), { recursive: true }) } catch {}
        loop?.beginTurn(textOf(blocks))
        const next = assemble()
        if (next.version !== configured) {
          session.configure({ model: workflow?.model ?? model, tools: next.tools, instructions: next.instructions })
          configured = next.version
        }
        status = await session.prompt(blocks)
        const check = status === 'complete' && remainingSteps > 0 ? loop?.selfCheck() : undefined
        if (check) status = await session.prompt([{ type: 'text', text: check }])
        const snap = await session.snapshot()
        const last = [...snap.messages].reverse().find((m) => m.role === 'assistant')
        answer = textOf(last?.content)
        return { status, answer }
      } finally {
        try {
          recorder.endTurn(status, answer)
          try { loop?.finishTurn(status) } catch {}
        } finally { asking = false }
      }
    },
    async dispose() {
      try { await session.dispose() } finally {
        await stopAllProcesses(sessionId)
        await rt.executor.disposeSession?.(sessionId)
        await workflow?.dispose()
      }
    }
  }
}
