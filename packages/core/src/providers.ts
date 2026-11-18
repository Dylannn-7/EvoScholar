import type { AgentModel, Json, ModelEvent } from '@evoscholar/harness'
import { createChatCompletionsModel } from '@evoscholar/harness/chat-completions'
import { createMessagesModel } from '@evoscholar/harness/messages'
import { createResponsesModel } from '@evoscholar/harness/responses'
import type { AuthHeader, EvoConfig, ModelSetting, Protocol, ProviderOverride, ReasoningCapability } from './config'
import { createGeminiModel } from './gemini'
import presets from './presets.json'

export type { Protocol } from './config'
export const PROTOCOLS: { id: Protocol; label: string }[] = [
  { id: 'chat-completions', label: 'OpenAI Chat Completions' },
  { id: 'responses', label: 'OpenAI Responses' },
  { id: 'messages', label: 'Anthropic Messages' },
  { id: 'gemini', label: 'Google Gemini generateContent' }
]

type Bases = Partial<Record<Protocol, string>>
type Preset = {
  id: string
  label: string
  defaultProtocol: Protocol
  bases: Bases
  regions?: { id: string; label: string; bases: Bases }[]
  modelsListUrl?: string
  apiKeyUrl?: string
  authHeader?: AuthHeader
  reasoningEffort?: ReasoningCapability
  models: ModelSetting[]
}
export type ModelEntry = ModelSetting & { reasoningParam?: string }
export type ProviderInfo = {
  id: string
  label: string
  custom: boolean
  /** Protocols with a known default URL for this vendor (the vendor documents them). */
  official: Protocol[]
  defaultProtocol: Protocol
  protocol: Protocol
  /** Effective API root for `protocol`. */
  baseUrl: string
  /** Preset default for `protocol` (empty when the vendor documents none). */
  defaultBaseUrl: string
  bases: Bases
  regions?: { id: string; label: string; bases: Bases }[]
  region?: string
  authHeader: AuthHeader
  apiKeyEnv: string
  apiKeyUrl?: string
  hasKey: boolean
  modelsSource: 'preset' | 'live'
  modelsFetchedAt?: string
  reasoningEffort?: ReasoningCapability
  /** Raw request field the effort value is sent in, for display. */
  reasoningParam?: string
  models: ModelEntry[]
}

/** Models known to accept images; others default to text-only unless the upstream list says so. */
const VISION: Record<string, boolean> = {
  'deepseek/deepseek-flash': true,
  'deepseek/deepseek-v4-flash': true,
  'deepseek/deepseek-v4-flash-vision-exp': true,
  'deepseek/deepseek-v4-pro': false
}
const VISION_VENDORS = new Set(['openai', 'anthropic', 'gemini', 'azure'])
const PRESETS = presets as Preset[]

export function presetIds(): string[] {
  return PRESETS.map((p) => p.id)
}

export function keyEnvFor(id: string, override?: ProviderOverride): string {
  return override?.apiKeyEnv ?? `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

function presetBases(p: Preset | undefined, region?: string): Bases {
  if (!p) return {}
  return p.regions?.find((r) => r.id === region)?.bases ?? p.bases
}

export function reasoningParam(protocol: Protocol, provider: string): string {
  if (protocol === 'responses') return 'reasoning.effort'
  if (protocol === 'gemini') return 'thinkingConfig.thinkingLevel'
  if (protocol === 'messages') return provider === 'anthropic' || provider === 'deepseek' ? 'output_config.effort' : 'thinking'
  return 'reasoning_effort'
}

function describe(id: string, p: Preset | undefined, o: ProviderOverride | undefined): ProviderInfo {
  const bases = presetBases(p, o?.region)
  const defaultProtocol = p?.defaultProtocol ?? o?.protocol ?? 'chat-completions'
  const protocol = o?.protocol ?? defaultProtocol
  const defaultBaseUrl = bases[protocol] ?? ''
  const vendorEffort = o?.reasoningEffort ?? p?.reasoningEffort
  const presetModels = new Map((p?.models ?? []).map((m) => [m.id, m]))
  const live = !!o?.modelsFetchedAt && !!o.models
  const param = reasoningParam(protocol, id)
  const models = (o?.models ?? p?.models ?? []).map((m): ModelEntry => {
    const base = presetModels.get(m.id)
    return {
      ...base,
      ...m,
      contextWindow: m.contextWindow ?? base?.contextWindow,
      maxOutputTokens: m.maxOutputTokens ?? base?.maxOutputTokens,
      vision: m.vision ?? base?.vision ?? VISION[`${id}/${m.id}`] ?? VISION_VENDORS.has(id),
      reasoningEffort: m.reasoningEffort ?? base?.reasoningEffort ?? vendorEffort,
      reasoningParam: param
    }
  })
  return {
    id,
    label: o?.label ?? p?.label ?? id,
    custom: !p,
    official: Object.keys(bases) as Protocol[],
    defaultProtocol,
    protocol,
    baseUrl: o?.baseUrl ?? (o?.endpoint ? legacyBase(o.endpoint) : defaultBaseUrl),
    defaultBaseUrl,
    bases,
    regions: p?.regions,
    region: o?.region ?? p?.regions?.[0]?.id,
    authHeader: o?.authHeader ?? p?.authHeader ?? (protocol === 'gemini' ? 'x-goog-api-key' : protocol === 'messages' && id === 'anthropic' ? 'x-api-key' : 'bearer'),
    apiKeyEnv: keyEnvFor(id, o),
    apiKeyUrl: p?.apiKeyUrl,
    hasKey: !!process.env[keyEnvFor(id, o)],
    modelsSource: live ? 'live' : 'preset',
    modelsFetchedAt: o?.modelsFetchedAt,
    reasoningEffort: vendorEffort,
    reasoningParam: param,
    models
  }
}

/** Old configs stored a full endpoint URL for custom gateways; recover the API root. */
function legacyBase(endpoint: string): string {
  return endpoint.replace(/\/(chat\/completions|responses|v1\/messages|messages)\/?$/, '')
}

export function listProviders(config: EvoConfig): ProviderInfo[] {
  const out = PRESETS.map((p) => describe(p.id, p, config.providers?.[p.id]))
  for (const [id, o] of Object.entries(config.providers ?? {}))
    if (!PRESETS.some((p) => p.id === id)) out.push(describe(id, undefined, o))
  return out
}

export function providerInfo(config: EvoConfig, id: string): ProviderInfo | undefined {
  const p = PRESETS.find((x) => x.id === id)
  const o = config.providers?.[id]
  return p || o ? describe(id, p, o) : undefined
}

export function parseModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/')
  if (i <= 0) throw new Error(`模型引用必须是「厂商/模型」：${ref}`)
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) }
}

function joinPath(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '')
  return b.endsWith(suffix) ? b : b + suffix
}

/** Full request URL for a provider (chat/responses/messages) or the API root (gemini). */
export function endpointFor(config: EvoConfig, provider: string, protocol?: Protocol): { url: string; protocol: Protocol } {
  const info = providerInfo(config, provider)
  if (!info) throw new Error(`未知厂商「${provider}」，请先在设置里添加`)
  const proto = protocol ?? info.protocol
  const base = protocol && protocol !== info.protocol ? info.bases[protocol] ?? '' : info.baseUrl
  if (!base || base.includes('<')) throw new Error(`${info.label} 的 ${proto} 协议还没有填写 Base URL`)
  if (proto === 'chat-completions') return { url: joinPath(base, '/chat/completions'), protocol: proto }
  if (proto === 'responses') return { url: joinPath(base, '/responses'), protocol: proto }
  if (proto === 'messages') return { url: base.replace(/\/+$/, '').endsWith('/messages') ? base : joinPath(base, /\/v1$/.test(base.replace(/\/+$/, '')) ? '/messages' : '/v1/messages'), protocol: proto }
  return { url: base.replace(/\/+$/, ''), protocol: proto }
}

export function modelsListUrl(info: ProviderInfo, override?: string): string {
  if (override) return override
  const preset = PRESETS.find((p) => p.id === info.id)
  if (preset?.modelsListUrl && info.baseUrl === info.defaultBaseUrl) return preset.modelsListUrl
  const base = info.baseUrl.replace(/\/+$/, '')
  if (info.protocol === 'messages') return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`
  return `${base}/models`
}

function authHeaders(style: AuthHeader, key: string): Record<string, string> {
  if (style === 'x-api-key') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  if (style === 'api-key') return { 'api-key': key }
  if (style === 'x-goog-api-key') return { 'x-goog-api-key': key }
  return { authorization: `Bearer ${key}` }
}

/** The harness adapters always send `Authorization: Bearer`; rewrite it for vendors that want another header. */
function authFetch(style: AuthHeader, inner: typeof fetch = globalThis.fetch): typeof fetch | undefined {
  if (style === 'bearer' || style === 'x-goog-api-key') return inner === globalThis.fetch ? undefined : inner
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers)
    const auth = h.get('authorization')
    const key = auth?.replace(/^Bearer\s+/i, '') ?? h.get('x-api-key') ?? ''
    h.delete('authorization')
    h.delete('x-api-key')
    for (const [k, v] of Object.entries(authHeaders(style, key))) h.set(k, v)
    return inner(url, { ...init, headers: h })
  }) as typeof fetch
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
    if (Array.isArray(rec.values) && rec.values.length)
      return { supported: true, values: rec.values.map((v) => String(v).trim()).filter(Boolean) }
  }
  const arr = raw.supported_reasoning_efforts ?? raw.reasoning_efforts ?? raw.reasoning_effort_levels
  if (Array.isArray(arr) && arr.length) {
    const values = arr.map((v) => String(v).trim()).filter(Boolean)
    if (values.length) return { supported: true, values }
  }
  if (raw.thinking === false) return { supported: false }
  const params = raw.supported_parameters
  if (Array.isArray(params) && !params.includes('reasoning') && !params.includes('reasoning_effort')) return { supported: false }
  return undefined
}

/** Parse an upstream model list (OpenAI-style `data`, Anthropic `data`, Gemini `models`). */
export function parseModelList(json: unknown, protocol: Protocol): ModelSetting[] {
  const j = (json ?? {}) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] }
  const rows = j.data ?? j.models ?? []
  const seen = new Set<string>()
  const out: ModelSetting[] = []
  for (const raw of rows) {
    if (protocol === 'gemini' || j.models) {
      const methods = raw.supportedGenerationMethods
      if (Array.isArray(methods) && !methods.includes('generateContent')) continue
    }
    const id = String(raw?.id ?? raw?.name ?? '').trim().replace(/^models\//, '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const cw = Number(raw.context_window ?? raw.context_length ?? raw.input_token_limit ?? raw.inputTokenLimit ?? raw.max_input_tokens ?? 0)
    const mo = Number(raw.max_output_tokens ?? raw.max_completion_tokens ?? raw.max_tokens ?? raw.output_token_limit ?? raw.outputTokenLimit ?? 0)
    const vision = parseLiveVision(raw)
    const reasoningEffort = parseLiveReasoningEffort(raw)
    out.push({
      id,
      ...(Number.isSafeInteger(cw) && cw > 0 ? { contextWindow: cw } : {}),
      ...(Number.isSafeInteger(mo) && mo > 0 ? { maxOutputTokens: mo } : {}),
      ...(vision !== undefined ? { vision } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
    })
  }
  return out
}

/** Read the raw model list from the vendor's /models endpoint. The caller persists it in settings. */
export async function fetchProviderModels(
  config: EvoConfig,
  providerId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): Promise<{ ok: true; models: ModelSetting[]; url: string } | { ok: false; error: string }> {
  const info = providerInfo(config, providerId)
  if (!info) return { ok: false, error: '未知厂商' }
  const key = process.env[info.apiKeyEnv]
  if (!key) return { ok: false, error: '还没有填写 API Key' }
  if (!info.baseUrl || info.baseUrl.includes('<')) return { ok: false, error: '还没有填写 Base URL' }
  const url = new URL(modelsListUrl(info, config.providers?.[providerId]?.modelsListUrl))
  if (info.protocol === 'gemini') url.searchParams.set('pageSize', '1000')
  try {
    const res = await fetchFn(url.href, { headers: { ...authHeaders(info.authHeader, key), accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}${res.status === 401 || res.status === 403 ? '（API Key 无效或没有权限）' : ''}` }
    const models = parseModelList(await res.json(), info.protocol)
    if (!models.length) return { ok: false, error: '上游没有返回模型列表' }
    return { ok: true, models, url: url.href }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function modelInfo(config: EvoConfig, ref: string) {
  const { provider, model } = parseModelRef(ref)
  const p = providerInfo(config, provider)
  const m = p?.models.find((x) => x.id === model)
  // The official Flash image encoder caps each image at 1024 tokens.
  // https://api-docs.deepseek.com/guides/vision/#token-usage
  let imageInputTokenCap: number | undefined
  try {
    imageInputTokenCap = ref === 'deepseek/deepseek-flash' && new URL(endpointFor(config, provider).url).origin === 'https://api.deepseek.com' ? 1024 : undefined
  } catch {}
  return {
    contextWindow: m?.contextWindow ?? 128_000,
    maxOutputTokens: m?.maxOutputTokens,
    vision: m?.vision ?? VISION[ref] ?? VISION_VENDORS.has(provider),
    imageInputTokenCap,
    reasoningEffort: m?.reasoningEffort ?? p?.reasoningEffort ?? { supported: false },
    reasoningParam: p ? reasoningParam(p.protocol, provider) : undefined
  }
}

const THINKING_TOGGLE_VENDORS = new Set(['deepseek', 'zhipu', 'minimax', 'volcengine'])

/** Translate a raw effort value into the vendor/protocol-specific request parameters. */
export function resolveProviderParameters(
  protocol: Protocol,
  provider: string,
  raw?: Record<string, Json>,
  fallbackEffort?: string
): Record<string, Json> | undefined {
  const { effort: rawEffort, ...rest } = raw ?? {}
  const effort = typeof rawEffort === 'string' && rawEffort ? rawEffort : fallbackEffort
  if (!effort || effort === 'default') return Object.keys(rest).length ? rest : undefined

  if (protocol === 'gemini') {
    if (rest.thinkingConfig === undefined) rest.thinkingConfig = effort === 'none' ? { thinkingBudget: 0 } : { thinkingLevel: effort }
  } else if (protocol === 'responses') {
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
  opts: { parameters?: Record<string, Json>; effort?: string; fetch?: typeof fetch } = {}
): AgentModel {
  const { provider, model } = parseModelRef(ref)
  const info = providerInfo(config, provider)
  if (!info) throw new Error(`未知厂商「${provider}」`)
  const { url, protocol } = endpointFor(config, provider)
  const apiKey = () => {
    const k = process.env[info.apiKeyEnv]
    if (!k) throw new Error(`缺少 ${info.label} 的 API Key，请在「设置 → 模型与密钥」里填写`)
    return k
  }
  const mi = modelInfo(config, ref)
  const parameters = resolveProviderParameters(protocol, provider, opts.parameters, opts.effort ?? config.reasoningEffort?.[ref])
  if (protocol === 'gemini')
    return createGeminiModel({ baseUrl: url, model, id: `${ref}@gemini`, apiKey, parameters, fetch: opts.fetch, inputCapabilities: { images: mi.vision } })
  const common = {
    endpoint: url,
    model,
    id: `${ref}@${protocol}`,
    apiKey,
    parameters,
    fetch: authFetch(info.authHeader, opts.fetch ?? globalThis.fetch),
    inputCapabilities: { images: mi.vision }
  }
  if (protocol === 'messages') return createMessagesModel(common)
  if (protocol === 'responses') return createResponsesModel(common)
  return createChatCompletionsModel(common)
}

/** Send a tiny request to prove that URL, protocol, key and model all work together. */
export async function testProviderConnection(
  config: EvoConfig,
  ref: string,
  opts: { fetch?: typeof fetch; effort?: string; timeoutMs?: number } = {}
): Promise<{ ok: true; latencyMs: number; text: string; usage?: { inputTokens: number; outputTokens: number } } | { ok: false; error: string }> {
  const t0 = Date.now()
  try {
    const model = createModel(config, ref, { fetch: opts.fetch, effort: opts.effort })
    const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
    let text = ''
    let finish: Extract<ModelEvent, { type: 'finish' }> | undefined
    for await (const ev of model.stream({
      requestId: `probe-${t0}`,
      instructions: 'You are a connectivity probe. Reply with the single word OK.',
      messages: [{ id: 'probe', role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [],
      maxOutputTokens: 256
    }, signal)) {
      if (ev.type === 'text-delta') text += ev.text
      if (ev.type === 'finish') finish = ev
    }
    if (!finish) return { ok: false, error: '连接成功但没有收到完整回复' }
    return { ok: true, latencyMs: Date.now() - t0, text: text.trim().slice(0, 80), usage: finish.usage && { inputTokens: finish.usage.inputTokens, outputTokens: finish.usage.outputTokens } }
  } catch (e) {
    const err = e as Error & { status?: number; httpStatus?: number }
    const status = err.status ?? err.httpStatus
    return { ok: false, error: `${err.message}${status ? `（HTTP ${status}）` : ''}` }
  }
}

/** First usable model: a provider with a key and at least one model. */
export function defaultModelRef(config: EvoConfig): string | undefined {
  for (const p of listProviders(config)) if (p.hasKey && p.models.length) return `${p.id}/${p.models[0].id}`
  return undefined
}
