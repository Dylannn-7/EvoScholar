import type { AgentTool } from '@evoscholar/harness'
import { deepseekFetch, deepseekSearch } from './deepseek'
import { editFile, listFiles, readFile, writeFile } from './fs'
import { readSkill } from '../skills'
import { litImport, litLookup, litSearch, litVerify, pdfPageImage, pdfText } from './literature'
import { httpGet, readProcess, runCommand, runPython, startProcess, stopProcess } from './exec'
import { figureCheck } from './figures'
import { checkFeedback, manuscriptCheck } from './writing'
export { stopAllProcesses, pythonBin, pyenvDir, runProcess, childEnv } from './exec'
export { inside, checkCommand, appPrivate, modelPath } from './sandbox'
export { mergeWorks, titleSim, normDoi, searchAll, type Work } from './literature'
import { BudgetError } from '../budget'
import { textResult, type ToolEnv, type ToolFactory } from './types'
export * from './types'

/** All tools the host can offer. A genome selects a subset via tools.enabled. */
export const TOOL_FACTORIES: Record<string, ToolFactory> = {
  web_search: deepseekSearch,
  web_fetch: deepseekFetch,
  list_files: listFiles,
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  run_python: runPython,
  run_command: runCommand,
  start_process: startProcess,
  read_process: readProcess,
  stop_process: stopProcess,
  http_get: httpGet,
  lit_search: litSearch,
  lit_lookup: litLookup,
  lit_verify: litVerify,
  lit_import: litImport,
  pdf_text: pdfText,
  pdf_page_image: pdfPageImage,
  figure_check: figureCheck,
  manuscript_check: manuscriptCheck,
  check_feedback: checkFeedback,
  read_skill: readSkill
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
    const tool = guarded(f(env))
    const d = overrides[name]?.description
    return d ? { ...tool, description: readText(d) } : tool
  })
}

/**
 * The harness treats a thrown tool error as fatal for the turn. Turn ordinary failures into
 * error results the model can read and recover from; budget stops and cancellation still propagate.
 */
export function guarded(tool: AgentTool): AgentTool {
  return {
    ...tool,
    async execute(args, context) {
      try {
        return await tool.execute(args, context)
      } catch (e) {
        if (e instanceof BudgetError || context?.signal?.aborted) throw e
        return textResult(`${tool.name} 出错：${(e as Error)?.message ?? String(e)}`, true)
      }
    }
  }
}
