import type { AgentTool } from '@evoscholar/harness'
import { deepseekFetch, deepseekSearch } from './deepseek'
import type { ToolEnv, ToolFactory } from './types'
export * from './types'

/** All tools the host can offer. A genome selects a subset via tools.enabled. */
export const TOOL_FACTORIES: Record<string, ToolFactory> = {
  web_search: deepseekSearch,
  web_fetch: deepseekFetch
}

export function registerTool(name: string, factory: ToolFactory): void {
  TOOL_FACTORIES[name] = factory
}

export function buildTools(
  enabled: string[],
  env: ToolEnv,
  overrides: Record<string, { description?: string }> = {},
  readText: (ref: string) => string = (s) => s
): AgentTool[] {
  return enabled.map((name) => {
    const f = TOOL_FACTORIES[name]
    if (!f) throw new Error(`Genome enables unknown tool "${name}"`)
    const tool = f(env)
    const d = overrides[name]?.description
    return d ? { ...tool, description: readText(d) } : tool
  })
}
