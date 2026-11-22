import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWriteFile } from './atomic-file'
import { dirname, join, resolve } from 'node:path'

export type BudgetConfig = {
  totalCny: number
  categories: Record<BudgetCategory, number>
  dailyUsageSoftCny: number
  evolutionPerRoundCny: number
  evolutionRoundsPerDay: number
  webCallsPerDay: number
  alertAt: number[]
  /** Legacy setting retained for loading existing config files. */
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
  /** Optional query parameter ?api-version=<value> (used by versioned Azure OpenAI deployments). */
  apiVersion?: string
  modelsListUrl?: string
  gatewayApproval?: { base: string; privateAccess: boolean }
  credentialOrigin?: string
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
export type ExecutionSettings = { engine?: string; image?: string; hostMode?: boolean }
export type ThemePreference = 'dark' | 'light' | 'system'
export const THEME_PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system']
export type UiSettings = { theme?: ThemePreference }
export type UserSettings = {
  providers: Record<string, ProviderOverride>
  execution?: ExecutionSettings
  /** Workbench appearance. */
  ui?: UiSettings
  defaults: { model?: string; effort?: string; fast?: string; vision?: string; permission?: PermissionMode; figureStyle?: string }
  /** Remembered reasoning effort per model ref. */
  efforts: Record<string, string>
}
export type EvoConfig = {
  /** Effective server port for outbound self-request checks. */
  localHttpPort?: number
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
    execution: raw.execution,
    ui: raw.ui && THEME_PREFERENCES.includes(raw.ui.theme as ThemePreference) ? { theme: raw.ui.theme } : undefined,
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
  atomicWriteFile(settingsFile(ws.dataDir), JSON.stringify(ws.settings, null, 2) + '\n', 0o600)
  applySettings(ws)
}
