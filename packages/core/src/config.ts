import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
export type Protocol = 'chat-completions' | 'responses' | 'messages' | 'gemini'
export type AuthHeader = 'bearer' | 'x-api-key' | 'api-key' | 'x-goog-api-key'
export type ModelSetting = { id: string; contextWindow?: number; maxOutputTokens?: number; vision?: boolean; reasoningEffort?: ReasoningCapability }
export type ProviderOverride = {
  protocol?: Protocol
  /** API root for the chosen protocol (prefilled from the preset, user-editable). */
  baseUrl?: string
  region?: string
  apiKeyEnv?: string
  /** Legacy custom gateway: full endpoint URL. */
  endpoint?: string
  authHeader?: AuthHeader
  modelsListUrl?: string
  reasoningEffort?: ReasoningCapability
  label?: string
  /** User-added provider (not a preset). */
  custom?: boolean
  models?: ModelSetting[]
  /** Set when `models` came from the upstream /models endpoint. */
  modelsFetchedAt?: string
}
export type PermissionMode = 'ask' | 'acceptEdits' | 'plan' | 'bypass'
export const PERMISSION_MODES: PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'bypass']
/** Per-user settings in <dataDir>/settings.json (never committed). */
export type UserSettings = {
  providers: Record<string, ProviderOverride>
  defaults: { model?: string; effort?: string; fast?: string; vision?: string; permission?: PermissionMode }
  /** Remembered reasoning effort per model ref. */
  efforts: Record<string, string>
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
export type Workspace = {
  root: string
  /** Effective config: repo config with user settings merged in (providers, efforts). */
  config: EvoConfig
  dataDir: string
  settings: UserSettings
  /** Repo-level provider overrides, before user settings were merged. */
  baseProviders: Record<string, ProviderOverride>
}

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
  const dataDir = resolve(root, config.dataDir ?? 'data')
  const ws: Workspace = { root, config, dataDir, settings: loadSettings(dataDir, config), baseProviders: { ...(config.providers ?? {}) } }
  applySettings(ws)
  return ws
}

const settingsFile = (dataDir: string) => join(dataDir, 'settings.json')

export function loadSettings(dataDir: string, config?: EvoConfig): UserSettings {
  const f = settingsFile(dataDir)
  let raw: Partial<UserSettings> = {}
  if (existsSync(f)) {
    try { raw = JSON.parse(readFileSync(f, 'utf8')) } catch { raw = {} }
  }
  return {
    providers: raw.providers ?? {},
    defaults: raw.defaults ?? {},
    // One-time migration: efforts used to live in the repo config.
    efforts: raw.efforts ?? { ...(config?.reasoningEffort ?? {}) }
  }
}

/** Merge user settings over the repo config, in memory only. */
export function applySettings(ws: Workspace): void {
  const providers: Record<string, ProviderOverride> = {}
  for (const [id, o] of Object.entries(ws.baseProviders)) providers[id] = { ...o }
  for (const [id, o] of Object.entries(ws.settings.providers)) providers[id] = { ...(providers[id] ?? {}), ...o }
  ws.config.providers = providers
  ws.config.reasoningEffort = { ...ws.settings.efforts }
}

export function saveSettings(ws: Workspace): void {
  mkdirSync(ws.dataDir, { recursive: true })
  writeFileSync(settingsFile(ws.dataDir), JSON.stringify(ws.settings, null, 2) + '\n', { mode: 0o600 })
  applySettings(ws)
}
