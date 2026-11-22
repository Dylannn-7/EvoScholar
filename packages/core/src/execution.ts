import type { ToolEnv } from './tools/types'

export type ProcessResult = {
  code: number | null; signal: string | null; out: string; stdout: string; timedOut: boolean; files?: string[]
}

export type ExecutionJob = {
  host: [string, string[]]
  sandbox: string[]
  code?: string
  skillDir?: string
  emptyWorkspace?: boolean
  /** Final files whose container-relative paths are also their destinations in the project. */
  deliverables?: string[]
}

export type ServiceState = { running: boolean; text: string; output: string }
export interface IsolatedService {
  read(signal: AbortSignal): Promise<ServiceState>
  get(port: number, path: string, timeout: number, signal: AbortSignal): Promise<{ status: number; body: string }>
  stop(): Promise<void>
}

/** ready: engine and image usable; engine: no Linux engine reachable; image: engine up, image missing. */
export type ExecutionStatus = 'ready' | 'engine' | 'image'

export interface ExecutionBackend {
  available(): Promise<boolean>
  status?(): Promise<ExecutionStatus>
  run(env: ToolEnv, job: ExecutionJob, timeout: number, signal: AbortSignal): Promise<ProcessResult>
  start(env: ToolEnv, job: ExecutionJob, signal: AbortSignal): Promise<IsolatedService>
  disposeSession?(sessionId: string): Promise<void>
  recover?(): Promise<void>
}

export async function chooseExecution(env: ToolEnv): Promise<'isolated' | 'host'> {
  if (await env.executor?.available()) return 'isolated'
  if (env.ws.settings?.execution?.hostMode === true && env.hostExecutionAllowed?.()) return 'host'
  if (env.ws.settings?.execution?.hostMode === true && env.permission?.() === 'bypass')
    throw new Error('Linux 容器不可用。完全放行模式下，宿主模式无效。')
  throw new Error('Linux 容器不可用，代码执行已停用。请启动容器引擎并准备镜像，或在设置中确认使用宿主模式。')
}
