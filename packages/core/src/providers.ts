import type { AgentModel, Json } from '@evoscholar/harness'
import { createChatCompletionsModel } from '@evoscholar/harness/chat-completions'
import { createMessagesModel } from '@evoscholar/harness/messages'
import { createResponsesModel } from '@evoscholar/harness/responses'
import type { EvoConfig, ProviderOverride, ReasoningCapability } from './config'
import presets from './presets.json'

export type Protocol = 'chat-completions' | 'messages' | 'responses'
type PresetModel = { id: string; contextWindow?: number; maxOutputTokens?: number; reasoningEffort?: ReasoningCapability }
type Preset = {
  id: string
  label: string
  apiEndpoints?: string[]
  baseUrl?: string
  chatCompletionsBaseUrl?: string
  modelsListUrl?: string
  reasoningEffort?: ReasoningCapability
  regions?: { id: string; label: string; baseUrl: string; chatCompletionsBaseUrl?: string }[]
  apiKeyUrl?: string
  models: PresetModel[]
}
export type ModelEntry = {
  id: string
  contextWindow?: number
  maxOutputTokens?: number
  vision?: boolean
  reasoningEffort?: ReasoningCapability
}
export type ProviderInfo = {
  id: string
  label: string
  protocols: Protocol[]
  apiKeyEnv: string
  apiKeyUrl?: string
  modelsListUrl?: string
  reasoningEffort?: ReasoningCapability
  custom: boolean
  hasKey: boolean
  modelsSource: 'preset' | 'live'
  models: ModelEntry[]
}

/** Models known to accept images; others default to text-only unless the config says otherwise. */
const VISION: Record<string, boolean> = {
  'deepseek/deepseek-flash': true,
  'deepseek/deepseek-v4-flash': true,
  'deepseek/deepseek-v4-flash-vision-exp': true,
  'deepseek/deepseek-v4-pro': false
}
const VISION_VENDORS = new Set(['openai', 'anthropic'])

const PRESETS = presets as Preset[]
const liveModelCache = new Map<string, ModelEntry[]>()

export function keyEnvFor(id: string, override?: ProviderOverride): string {
  return override?.apiKeyEnv ?? `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

function resolveModelList(
  providerId: string,
  baseModels: ModelEntry[],
  vendorEffort?: ReasoningCapability
): { models: ModelEntry[]; source: 'preset' | 'live' } {
  const byId = new Map(baseModels.map((m) => [m.id, m]))
  const liveEntries = liveModelCache.get(providerId)
  const enrich = (m: ModelEntry): ModelEntry => ({
    ...m,
    vision: m.vision ?? VISION[`${providerId}/${m.id}`] ?? VISION_VENDORS.has(providerId),
    reasoningEffort: m.reasoningEffort ?? vendorEffort
  })
  if (!liveEntries?.length) return { models: baseModels.map(enrich), source: 'preset' }

  const merged: ModelEntry[] = liveEntries.map((le) => {
    const base = byId.get(le.id)
    return enrich({
      ...base,
      ...le,
      contextWindow: le.contextWindow ?? base?.contextWindow,
      maxOutputTokens: le.maxOutputTokens ?? base?.maxOutputTokens,
      vision: le.vision ?? base?.vision,
      reasoningEffort: le.reasoningEffort ?? base?.reasoningEffort ?? vendorEffort
    })
  })
  return { models: merged, source: 'live' }
}

export function listProviders(config: EvoConfig): ProviderInfo[] {
  const out: ProviderInfo[] = PRESETS.map((p) => {
    const o = config.providers?.[p.id]
    const protocols = (p.apiEndpoints?.length ? p.apiEndpoints : ['messages']) as Protocol[]
    const vendorEffort = o?.reasoningEffort ?? p.reasoningEffort
    const resolved = resolveModelList(p.id, o?.models ?? p.models, vendorEffort)
    return {
      id: p.id,
      label: p.label,
      protocols,
      apiKeyEnv: keyEnvFor(p.id, o),
      apiKeyUrl: p.apiKeyUrl,
      modelsListUrl: o?.modelsListUrl ?? p.modelsListUrl,
      reasoningEffort: vendorEffort,
      custom: false,
      hasKey: !!process.env[keyEnvFor(p.id, o)],
      modelsSource: resolved.source,
      models: resolved.models
    }
  })
  for (const [id, o] of Object.entries(config.providers ?? {})) {
    if (PRESETS.some((p) => p.id === id)) continue
    const resolved = resolveModelList(id, o.models ?? [], o.reasoningEffort)
    out.push({
      id,
      label: o.label ?? id,
      protocols: [o.protocol ?? 'chat-completions'],
      apiKeyEnv: keyEnvFor(id, o),
      modelsListUrl: o.modelsListUrl ?? (o.endpoint ? deriveCustomModelsUrl(o.endpoint) : undefined),
      reasoningEffort: o.reasoningEffort,
      custom: true,
      hasKey: !!process.env[keyEnvFor(id, o)],
      modelsSource: resolved.source,
      models: resolved.models
    })
  }
  return out
}

function deriveCustomModelsUrl(endpoint: string): string | undefined {
  try {
    const u = new URL(endpoint)
    if (u.pathname.endsWith('/chat/completions')) return new URL(u.pathname.replace(/\/chat\/completions$/, '/models'), u).href
    if (u.pathname.endsWith('/responses')) return new URL(u.pathname.replace(/\/responses$/, '/models'), u).href
  } catch {}
  return undefined
}

function parseLiveVision(raw: Record<string, unknown>): boolean | undefined {
  const mods = raw.input_modalities ?? (raw.architecture as Record<string, unknown> | undefined)?.input_modalities
  if (Array.isArray(mods)) return mods.some((x) => String(x).toLowerCase() === 'image')
  const caps = raw.capabilities as Record<string, unknown> | undefined
  if (typeof caps?.vision === 'boolean') return caps.vision
  if (typeof raw.vision === 'boolean') return raw.vision
  return undefined
}

function parseLiveReasoningEffort(raw: Record<string, unknown>): ReasoningCapability | undefined {
  const caps = raw.capabilities as Record<string, unknown> | undefined
  const obj = (raw.reasoningEffort ?? raw.reasoning_effort_config ?? caps?.reasoning_effort ?? caps?.reasoning) as unknown
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>
    if (rec.supported === false) return { supported: false }
    if (Array.isArray(rec.values) && rec.values.length) {
      return { supported: true, values: rec.values.map((v) => String(v).trim()).filter(Boolean) }
    }
  }
  const arr = raw.supported_reasoning_efforts ?? raw.reasoning_efforts ?? raw.reasoning_effort_levels
  if (Array.isArray(arr) && arr.length) {
    const values = arr.map((v) => String(v).trim()).filter(Boolean)
    if (values.length) return { supported: true, values }
  }
  const params = raw.supported_parameters
  if (Array.isArray(params) && !params.includes('reasoning') && !params.includes('reasoning_effort')) {
    return { supported: false }
  }
  return undefined
}

/**
 * Fetch live model metadata (ids, context/output windows, vision, effort when supplied)
 * from a connected vendor's modelsListUrl.
 */
export async function refreshProviderModels(
  config: EvoConfig,
  providerId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<{ refreshed: boolean; count: number; error?: string }> {
  const prov = listProviders(config).find((p) => p.id === providerId)
  if (!prov) return { refreshed: false, count: 0, error: '未知厂商' }
  if (!prov.hasKey) return { refreshed: false, count: 0, error: '未配置 API Key' }
  if (!prov.modelsListUrl) return { refreshed: false, count: prov.models.length }
  const key = process.env[prov.apiKeyEnv]
  if (!key) return { refreshed: false, count: 0, error: '缺少 API Key' }

  const headers: Record<string, string> =
    prov.id === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'application/json' }
      : { authorization: `Bearer ${key}`, accept: 'application/json' }

  try {
    const res = await fetchFn(prov.modelsListUrl, { headers, signal: AbortSignal.timeout(6000) })
    if (!res.ok) return { refreshed: false, count: prov.models.length, error: `HTTP ${res.status}` }
    const json = (await res.json()) as { data?: Record<string, unknown>[] }
    const seen = new Set<string>()
    const entries: ModelEntry[] = []
    for (const raw of json?.data ?? []) {
      const id = String(raw?.id ?? '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      const cw = Number(raw.context_window ?? raw.context_length ?? raw.input_token_limit ?? 0)
      const mo = Number(raw.max_output_tokens ?? raw.max_completion_tokens ?? raw.max_tokens ?? raw.output_token_limit ?? 0)
      const vision = parseLiveVision(raw)
      const reasoningEffort = parseLiveReasoningEffort(raw)
      entries.push({
        id,
        ...(Number.isSafeInteger(cw) && cw > 0 ? { contextWindow: cw } : {}),
        ...(Number.isSafeInteger(mo) && mo > 0 ? { maxOutputTokens: mo } : {}),
        ...(vision !== undefined ? { vision } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
      })
    }
    if (!entries.length) return { refreshed: false, count: prov.models.length }
    liveModelCache.set(providerId, entries)
    return { refreshed: true, count: entries.length }
  } catch (e) {
    return { refreshed: false, count: prov.models.length, error: (e as Error).message }
  }
}

export function clearLiveModelCache(providerId?: string): void {
  if (providerId) liveModelCache.delete(providerId)
  else liveModelCache.clear()
}

export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/')
  if (i <= 0) throw new Error(`Model reference must be "provider/model": ${ref}`)
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) }
}

function join(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '')
  return b.endsWith(suffix) ? b : b + suffix
}

/** Resolve the full endpoint URL for a provider + protocol. */
export function endpointFor(config: EvoConfig, provider: string, protocol?: Protocol): { url: string; protocol: Protocol } {
  const o = config.providers?.[provider]
  const preset = PRESETS.find((p) => p.id === provider)
  if (o?.endpoint) return { url: o.endpoint, protocol: o.protocol ?? 'chat-completions' }
  if (!preset) throw new Error(`Unknown provider "${provider}". Add it under "providers" in evoscholar.config.json`)
  const supported = (preset.apiEndpoints?.length ? preset.apiEndpoints : ['messages']) as Protocol[]
  const proto = protocol ?? o?.protocol ?? (supported.includes('chat-completions') ? 'chat-completions' : supported[0])
  const region = preset.regions?.[0]
  const base = o?.baseUrl ?? preset.baseUrl ?? region?.baseUrl ?? ''
  const ccBase = o?.baseUrl ?? preset.chatCompletionsBaseUrl ?? region?.chatCompletionsBaseUrl ?? base
  if (proto === 'chat-completions') return { url: join(ccBase, '/chat/completions'), protocol: proto }
  if (proto === 'messages') return { url: base.endsWith('/messages') ? base : join(base, '/v1/messages'), protocol: proto }
  return { url: join(base, '/v1/responses'), protocol: proto }
}

export function modelInfo(config: EvoConfig, ref: string) {
  const { provider, model } = parseModelRef(ref)
  const p = listProviders(config).find((x) => x.id === provider)
  const m = p?.models.find((x) => x.id === model)
  // The official Flash image encoder caps each image at 1024 tokens.
  // https://api-docs.deepseek.com/guides/vision/#token-usage
  const imageInputTokenCap = ref === 'deepseek/deepseek-flash' &&
    new URL(endpointFor(config, provider).url).origin === 'https://api.deepseek.com' ? 1024 : undefined
  return {
    contextWindow: m?.contextWindow ?? 128_000,
    maxOutputTokens: m?.maxOutputTokens,
    vision: m?.vision ?? VISION[ref] ?? false,
    imageInputTokenCap,
    reasoningEffort: m?.reasoningEffort ?? p?.reasoningEffort ?? { supported: false }
  }
}

const THINKING_TOGGLE_VENDORS = new Set(['deepseek', 'zhipu', 'minimax', 'volcengine'])

/** Translate normalized `parameters.effort` into the vendor/protocol-specific request parameters. */
export function resolveProviderParameters(
  protocol: Protocol,
  provider: string,
  raw?: Record<string, Json>,
  fallbackEffort?: string
): Record<string, Json> | undefined {
  const { effort: rawEffort, ...rest } = raw ?? {}
  const effort = typeof rawEffort === 'string' && rawEffort ? rawEffort : fallbackEffort
  if (!effort) return Object.keys(rest).length ? rest : undefined

  if (protocol === 'responses') {
    if (rest.reasoning === undefined) rest.reasoning = { effort }
  } else if (protocol === 'messages') {
    if (effort === 'none') {
      if (rest.thinking === undefined) rest.thinking = { type: 'disabled' }
    } else if (provider === 'anthropic') {
      if (rest.thinking === undefined) rest.thinking = { type: 'adaptive' }
      if (rest.output_config === undefined) rest.output_config = { effort }
    } else if (provider === 'deepseek') {
      if (rest.thinking === undefined) rest.thinking = { type: 'enabled' }
      if (rest.output_config === undefined) rest.output_config = { effort }
    } else if (rest.thinking === undefined) {
      rest.thinking = { type: 'enabled' }
    }
  } else {
    if (effort === 'none' && THINKING_TOGGLE_VENDORS.has(provider)) {
      if (rest.thinking === undefined) rest.thinking = { type: 'disabled' }
    } else {
      if (provider === 'deepseek' && rest.thinking === undefined) rest.thinking = { type: 'enabled' }
      if (rest.reasoning_effort === undefined) rest.reasoning_effort = effort
    }
  }
  return Object.keys(rest).length ? rest : undefined
}

export function createModel(
  config: EvoConfig,
  ref: string,
  opts: { parameters?: Record<string, Json>; fetch?: typeof fetch } = {}
): AgentModel {
  const { provider, model } = parseModelRef(ref)
  const { url, protocol } = endpointFor(config, provider)
  const envName = keyEnvFor(provider, config.providers?.[provider])
  const apiKey = () => {
    const k = process.env[envName]
    if (!k) throw new Error(`缺少 API Key：请在 .env 中设置 ${envName}`)
    return k
  }
  const info = modelInfo(config, ref)
  const parameters = resolveProviderParameters(protocol, provider, opts.parameters, config.reasoningEffort?.[ref])
  const common = {
    endpoint: url,
    model,
    id: `${ref}@${protocol}`,
    apiKey,
    parameters,
    fetch: opts.fetch,
    inputCapabilities: { images: info.vision }
  }
  if (protocol === 'messages') return createMessagesModel(common)
  if (protocol === 'responses') return createResponsesModel(common)
  return createChatCompletionsModel(common)
}
