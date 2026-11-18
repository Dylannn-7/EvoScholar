import type { AgentTool } from '@evoscholar/harness'
import type { Ledger } from '../budget'
import type { BudgetCategory, Workspace } from '../config'

export type ToolEnv = {
  ws: Workspace
  ledger: Ledger
  category: () => BudgetCategory
  sessionId?: string
  genomeId?: string
  /** Called for tools that need the user's approval (e.g. code execution). */
  approve?: (tool: string, summary: string) => Promise<boolean>
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
