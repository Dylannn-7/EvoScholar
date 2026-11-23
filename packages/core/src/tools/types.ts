import type { AgentTool } from '@evoscholar/harness'
import type { Ledger } from '../budget'
import type { ExecutionBackend } from '../execution'
import type { BudgetCategory, PermissionMode, Workspace } from '../config'
import type { SkillRef } from '../skills'

export type ToolEnv = {
  ws: Workspace
  /** Session working directory; file and process tools cannot leave it. */
  cwd: string
  executor?: ExecutionBackend
  permission?: () => PermissionMode
  /** Unattended calls cannot opt in to host execution. */
  hostExecutionAllowed?: () => boolean
  ledger: Ledger
  category: () => BudgetCategory
  sessionId?: string
  projectId?: string | null
  genomeId?: string
  skills?: readonly SkillRef[]
  /** Read-only workflow children do not save shared scratch outputs. */
  readOnly?: boolean
  /**
   * Permission gate for side effects. `kind` is 'edit' for file writes and 'exec' for code and
   * processes; the session's permission mode decides which reach the user.
   * Undefined means unattended mode (evaluation runs in an isolated directory): auto-approve.
   */
  approve?: (tool: string, summary: string, kind?: ApprovalKind, signal?: AbortSignal) => Promise<boolean>
  /** Model ref chosen for this session (composer); used to resolve helper roles. */
  model?: string
  /** Called with cwd-relative paths of files a tool created or modified (library index). */
  onFiles?: (paths: string[]) => void
  /** Optional sink for host-level trace events (exported with evaluation runs). */
  trace?: (event: Record<string, unknown>) => void
}
export type ApprovalKind = 'edit' | 'exec' | 'evolution'
export type ToolFactory = (env: ToolEnv) => AgentTool

/** Shell used by run_command / start_process on this platform. */
export function shellFor(command: string): [string, string[]] {
  return process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]]
    : ['/bin/sh', ['-c', command]]
}

export function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

export function objectArgs(input: unknown, allowed: string[], required: string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Arguments must be an object')
  const obj = input as Record<string, unknown>
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`Unknown argument: ${k}`)
  for (const k of required) if (obj[k] === undefined) throw new Error(`Missing argument: ${k}`)
  return obj
}
