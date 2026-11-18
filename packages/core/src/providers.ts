import type { AgentModel, Json } from '@evoscholar/harness'
import { createChatCompletionsModel } from '@evoscholar/harness/chat-completions'
import { createMessagesModel } from '@evoscholar/harness/messages'
import { createResponsesModel } from '@evoscholar/harness/responses'
import type { EvoConfig, ProviderOverride } from './config'
import presets from './presets.json'

export type Protocol = 'chat-completions' | 'messages' | 'responses'
type Preset = {
  id: string
  label: string
  apiEndpoints?: string[]
  baseUrl?: string
  chatCompletionsBaseUrl?: string
  regions?: { id: string; label: string; baseUrl: string; chatCompletionsBaseUrl?: string }[]
  apiKeyUrl?: string
  models: { id: string; contextWindow?: number; maxOutputTokens?: number }[]
}
export type ProviderInfo = {
  id: string
  label: string
  protocols: Protocol[]
  apiKeyEnv: string
  apiKeyUrl?: string
  custom: boolean
  hasKey: boolean
  models: { id: string; contextWindow?: number; maxOutputTokens?: number; vision?: boolean }[]
}

/** Models known to accept images; others default to text-only unless the config says otherwise. */
const VISION: Record<string, boolean> = {
  'deepseek/deepseek-flash': true,
  'deepseek/deepseek-v4-pro': false
}
const VISION_VENDORS = new Set(['openai', 'anthropic'])

const PRESETS = presets as Preset[]

export function keyEnvFor(id: string, override?: ProviderOverride): string {
  return override?.apiKeyEnv ?? `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

export function listProviders(config: EvoConfig): ProviderInfo[] {
  const out: ProviderInfo[] = PRESETS.map((p) => {
    const o = config.providers?.[p.id]
    const protocols = (p.apiEndpoints?.length ? p.apiEndpoints : ['messages']) as Protocol[]
    return {
      id: p.id,
      label: p.label,
      protocols,
      apiKeyEnv: keyEnvFor(p.id, o),
      apiKeyUrl: p.apiKeyUrl,
      custom: false,
      hasKey: !!process.env[keyEnvFor(p.id, o)],
      models: (o?.models ?? p.models).map((m) => ({ ...m, vision: VISION[`${p.id}/${m.id}`] ?? VISION_VENDORS.has(p.id) }))
    }
  })
  for (const [id, o] of Object.entries(config.providers ?? {})) {
    if (PRESETS.some((p) => p.id === id)) continue
    out.push({
      id,
      label: o.label ?? id,
      protocols: [o.protocol ?? 'chat-completions'],
      apiKeyEnv: keyEnvFor(id, o),
      custom: true,
      hasKey: !!process.env[keyEnvFor(id, o)],
      models: o.models ?? []
    })
  }
  return out
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
  return {
    contextWindow: m?.contextWindow ?? 128_000,
    maxOutputTokens: m?.maxOutputTokens,
    vision: m?.vision ?? VISION[ref] ?? false
  }
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
  const common = {
    endpoint: url,
    model,
    id: `${ref}@${protocol}`,
    apiKey,
    parameters: opts.parameters,
    fetch: opts.fetch,
    inputCapabilities: { images: info.vision }
  }
  if (protocol === 'messages') return createMessagesModel(common)
  if (protocol === 'responses') return createResponsesModel(common)
  return createChatCompletionsModel(common)
}
