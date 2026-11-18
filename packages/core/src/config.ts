import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type BudgetConfig = {
  totalCny: number
  categories: Record<BudgetCategory, number>
  dailyUsageSoftCny: number
  evolutionPerRoundCny: number
  evolutionRoundsPerDay: number
  webCallsPerDay: number
  alertAt: number[]
  /** When false/unset, daily user usage (`category: 'usage'`) is recorded without hard budget blocking. */
  enforceUsageCap?: boolean
}
export type BudgetCategory = 'usage' | 'evolution' | 'dev' | 'reserve'
export type ReasoningCapability = { supported: boolean; values?: string[] }
export type ProviderOverride = {
  protocol?: 'chat-completions' | 'messages' | 'responses'
  baseUrl?: string
  apiKeyEnv?: string
  /** Custom gateway: full endpoint URL. */
  endpoint?: string
  modelsListUrl?: string
  reasoningEffort?: ReasoningCapability
  label?: string
  models?: { id: string; contextWindow?: number; maxOutputTokens?: number; vision?: boolean; reasoningEffort?: ReasoningCapability }[]
}
export type EvoConfig = {
  dataDir: string
  currency: 'CNY' | 'USD'
  usdToCny: number
  budget: BudgetConfig
  evolution: { offPeakOnly: boolean }
  providers: Record<string, ProviderOverride>
  reasoningEffort?: Record<string, string>
}
export type Workspace = { root: string; config: EvoConfig; dataDir: string }

/** Walk up from `start` to the directory holding evoscholar.config.json. */
export function findRoot(start = process.cwd()): string {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, 'evoscholar.config.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('evoscholar.config.json not found; run inside an EvoScholar workspace')
    dir = parent
  }
}

export function loadEnvFile(root: string): void {
  const file = join(root, '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || line.trimStart().startsWith('#')) continue
    let value = m[2]
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

export function openWorkspace(start?: string): Workspace {
  const root = findRoot(start)
  loadEnvFile(root)
  const config = JSON.parse(readFileSync(join(root, 'evoscholar.config.json'), 'utf8')) as EvoConfig
  return { root, config, dataDir: resolve(root, config.dataDir ?? 'data') }
}
