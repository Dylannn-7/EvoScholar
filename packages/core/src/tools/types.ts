import type { AgentTool } from '@evoscholar/harness'
import type { Ledger } from '../budget'
import type { BudgetCategory, Workspace } from '../config'
import type { SkillRef } from '../skills'

export type ToolEnv = {
  ws: Workspace
  /** Session working directory; file and process tools cannot leave it. */
  cwd: string
  ledger: Ledger
  category: () => BudgetCategory
  sessionId?: string
  genomeId?: string
  skills?: readonly SkillRef[]
  /** Read-only workflow children do not save shared scratch outputs. */
  readOnly?: boolean
  /**
   * Called for tools with side effects outside plain file edits (code execution, processes).
   * Undefined means unattended mode (evaluation runs in an isolated directory): auto-approve.
   */
  approve?: (tool: string, summary: string) => Promise<boolean>
  /** Optional sink for host-level trace events (exported with evaluation runs). */
  trace?: (event: Record<string, unknown>) => void
}
export type ToolFactory = (env: ToolEnv) => AgentTool

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
