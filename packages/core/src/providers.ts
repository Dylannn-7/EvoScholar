import type { AgentModel, Json, ModelEvent } from '@evoscholar/harness'
import { createChatCompletionsModel } from '@evoscholar/harness/chat-completions'
import { createMessagesModel } from '@evoscholar/harness/messages'
import { createResponsesModel } from '@evoscholar/harness/responses'
import type { AuthHeader, EvoConfig, ModelSetting, Protocol, ProviderOverride, ReasoningCapability } from './config'
import type { Ledger } from './budget'
import { gatewayTransport, normalizeGatewayBase } from './gateway'
import { createGeminiModel } from './gemini'
import { MiB, readJson } from './http-body'
import { meterModel } from './metering'
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
  /** True when the user or the preset chose the header; false for the protocol-derived default. */
  authHeaderExplicit: boolean
  apiVersion?: string
  apiKeyEnv: string
  apiKeyUrl?: string
  hasKey: boolean
  gatewayApproved: boolean
  gatewayPrivateAccess: boolean
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

export const API_VERSION_RE = /^\d{4}-\d{2}-\d{2}(-preview)?$/
export function validApiVersion(value: string): boolean {
  return API_VERSION_RE.test(value)
}

/** Central effort -> numeric thinking token budget table for protocols/models that use token budgets. */
export const THINKING_BUDGET_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  none: 0,
  minimal: 1024,
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 24576,
  max: 32768
})

export function thinkingBudgetFor(effort: string, maxOutputTokens?: number): number | undefined {
  const raw = THINKING_BUDGET_TOKENS[effort]
  if (raw === undefined) return undefined
  if (raw === 0) return 0
  if (maxOutputTokens !== undefined && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0) {
    return Math.min(raw, Math.max(1, maxOutputTokens - 1))
  }
  return raw
}

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

function officialBase(base: string, preset?: Preset): boolean {
  if (!base || !preset) return false
  const all = [preset.bases, ...(preset.regions ?? []).map((region) => region.bases)]
  return all.some((bases) => Object.values(bases).includes(base))
}

function providerKey(info: ProviderInfo, override?: ProviderOverride): string | undefined {
  if (!info.baseUrl || info.baseUrl.includes('<')) return
  try {
    const origin = new URL(info.baseUrl).origin
    const official = officialBase(info.baseUrl, PRESETS.find((p) => p.id === info.id))
    const savedOrigin = override?.credentialOrigin
    if (savedOrigin ? savedOrigin !== origin : !official) return
    return process.env[info.apiKeyEnv]
  } catch { return undefined }
}

function providerTransport(config: EvoConfig, info: ProviderInfo, supplied?: typeof fetch): typeof fetch {
  const override = config.providers?.[info.id]
  const preset = PRESETS.find((p) => p.id === info.id)
  const official = officialBase(info.baseUrl, preset)
  return async (input, init) => {
    if (official) {
      const target = new URL(input instanceof Request ? input.url : input)
      const trusted = target.origin === new URL(info.baseUrl).origin ||
        (preset?.modelsListUrl !== undefined && target.href === preset.modelsListUrl)
      if (!trusted) throw new Error('模型列表地址与已授权的厂商地址不符')
      return (supplied ?? globalThis.fetch)(input, { ...init, redirect: 'error' })
    }
    return gatewayTransport({
      base: info.baseUrl, approval: override?.gatewayApproval,
      localPort: config.localHttpPort ?? Number(process.env.EVOSCHOLAR_PORT ?? 4317), fetch: supplied
    })(input, init)
  }
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
  const baseUrl = o?.baseUrl ?? (o?.endpoint ? legacyBase(o.endpoint) : defaultBaseUrl)
  const official = officialBase(baseUrl, p)
  let gatewayApproved = official
  try { gatewayApproved ||= !!o?.gatewayApproval && o.gatewayApproval.base === normalizeGatewayBase(baseUrl) } catch {}
  const info: ProviderInfo = {
    id,
    label: o?.label ?? p?.label ?? id,
    custom: !p,
    official: Object.keys(bases) as Protocol[],
    defaultProtocol,
    protocol,
    baseUrl,
    defaultBaseUrl,
    bases,
    regions: p?.regions,
    region: o?.region ?? p?.regions?.[0]?.id,
    authHeader: o?.authHeader ?? p?.authHeader ?? (protocol === 'gemini' ? 'x-goog-api-key' : protocol === 'messages' && id === 'anthropic' ? 'x-api-key' : 'bearer'),
    authHeaderExplicit: !!(o?.authHeader ?? p?.authHeader),
    ...(o?.apiVersion ? { apiVersion: o.apiVersion } : {}),
    apiKeyEnv: keyEnvFor(id, o),
    apiKeyUrl: p?.apiKeyUrl,
    hasKey: false,
    gatewayApproved,
    gatewayPrivateAccess: !!o?.gatewayApproval?.privateAccess,
    modelsSource: live ? 'live' : 'preset',
    modelsFetchedAt: o?.modelsFetchedAt,
    reasoningEffort: vendorEffort,
    reasoningParam: param,
    models
  }
  info.hasKey = gatewayApproved && !!providerKey(info, o)
  return info
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

const nativeAuth = (protocol: Protocol): AuthHeader =>
  protocol === 'gemini' ? 'x-goog-api-key' : protocol === 'messages' ? 'x-api-key' : 'bearer'

/**
 * Rewrite the adapter's native auth header when the provider asks for another style.
 * The derived default 'bearer' is left alone: Anthropic-compatible vendor endpoints have always
 * received the adapter's x-api-key, and changing that silently could break working setups.
 */
function authFetch(protocol: Protocol, style: AuthHeader, explicit: boolean, inner: typeof fetch = globalThis.fetch): typeof fetch {
  if (style === nativeAuth(protocol) || (!explicit && style === 'bearer')) return inner
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers)
    const auth = h.get('authorization')
    const key = auth?.replace(/^Bearer\s+/i, '') ?? h.get('x-api-key') ?? h.get('api-key') ?? h.get('x-goog-api-key') ?? ''
    h.delete('authorization')
    h.delete('x-api-key')
    h.delete('api-key')
    h.delete('x-goog-api-key')
    for (const [k, v] of Object.entries(authHeaders(style, key))) h.set(k, v)
    return inner(url, { ...init, headers: h })
  }) as typeof fetch
}

function apiVersionFetch(apiVersion: string | undefined, inner: typeof fetch): typeof fetch {
  if (!apiVersion) return inner
  if (!validApiVersion(apiVersion)) throw new Error(`API 版本格式不正确：${apiVersion}（示例：2024-10-21 或 2024-12-01-preview）`)
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input)
    if (!target.searchParams.has('api-version')) target.searchParams.set('api-version', apiVersion)
    return inner(target.href, init)
  }) as typeof fetch
}

function clampThinkingBudgetFetch(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as { max_tokens?: unknown; thinking?: Record<string, unknown> }
        const max = typeof parsed.max_tokens === 'number' && Number.isSafeInteger(parsed.max_tokens) && parsed.max_tokens > 0
          ? parsed.max_tokens : undefined
        const budget = parsed.thinking?.budget_tokens
        if (max !== undefined && typeof budget === 'number' && budget >= max) {
          // The per-request max_tokens can be smaller than the model's; too small a budget is invalid.
          parsed.thinking = max - 1 >= ANTHROPIC_MIN_BUDGET ? { ...parsed.thinking, budget_tokens: max - 1 } : { type: 'disabled' }
          return inner(input, { ...init, body: JSON.stringify(parsed) })
        }
      } catch { /* forward unmodified body */ }
    }
    return inner(input, init)
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
  const rows = j.data ?? j.models
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const out: ModelSetting[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    if (protocol === 'gemini' || j.models) {
      const methods = raw.supportedGenerationMethods
      if (Array.isArray(methods) && !methods.includes('generateContent')) continue
    }
    const value = raw.id ?? raw.name
    if (typeof value !== 'string') continue
    const id = value.trim().replace(/^models\//, '')
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
  fetchFn?: typeof globalThis.fetch
): Promise<{ ok: true; models: ModelSetting[]; url: string } | { ok: false; error: string }> {
  const info = providerInfo(config, providerId)
  if (!info) return { ok: false, error: '未知厂商' }
  if (!info.gatewayApproved) return { ok: false, error: '请先确认网关地址和 API 根路径' }
  const key = providerKey(info, config.providers?.[providerId])
  if (!key) return { ok: false, error: '还没有填写 API Key' }
  if (!info.baseUrl || info.baseUrl.includes('<')) return { ok: false, error: '还没有填写 Base URL' }
  try {
    const url = new URL(modelsListUrl(info, config.providers?.[providerId]?.modelsListUrl))
    if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
      return { ok: false, error: '模型列表地址必须使用 HTTPS 或本机 HTTP，且不能包含账号密码' }
    if (info.protocol === 'gemini') url.searchParams.set('pageSize', '1000')
    if (info.apiVersion) {
      if (!validApiVersion(info.apiVersion)) return { ok: false, error: `API 版本格式不正确：${info.apiVersion}` }
      if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', info.apiVersion)
    }
    const res = await providerTransport(config, info, fetchFn)(url.href, { headers: { ...authHeaders(info.authHeader, key), accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, error: `HTTP ${res.status}${res.status === 401 || res.status === 403 ? '（API Key 无效或没有权限）' : ''}` }
    }
    const models = parseModelList(await readJson(res, 4 * MiB, '模型列表'), info.protocol)
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
// Numeric budgets only for model families known to need them; anything else (including future
// models) keeps the level/adaptive request that worked before.
const GEMINI_BUDGET_MODEL = /^(?:models\/)?gemini-[12](?:[.-]|$)/i
const ANTHROPIC_BUDGET_MODEL = /^claude-(?:3(?:[.-]|$)|(?:opus|sonnet|haiku)-4(?:-[0-5])?(?:-\d{8})?$)/i
/** Anthropic rejects extended-thinking budgets below this. */
const ANTHROPIC_MIN_BUDGET = 1024

/** Translate a raw effort value into the vendor/protocol-specific request parameters. */
export function resolveProviderParameters(
  protocol: Protocol,
  provider: string,
  raw?: Record<string, Json>,
  fallbackEffort?: string,
  opts?: { model?: string; maxOutputTokens?: number }
): Record<string, Json> | undefined {
  const { effort: rawEffort, ...rest } = raw ?? {}
  const effort = typeof rawEffort === 'string' && rawEffort ? rawEffort : fallbackEffort
  if (!effort || effort === 'default') return Object.keys(rest).length ? rest : undefined
  const model = opts?.model

  if (protocol === 'gemini') {
    if (rest.thinkingConfig === undefined) {
      if (effort === 'none') rest.thinkingConfig = { thinkingBudget: 0 }
      else if (model && GEMINI_BUDGET_MODEL.test(model)) {
        const budget = thinkingBudgetFor(effort, opts?.maxOutputTokens)
        rest.thinkingConfig = budget !== undefined ? { thinkingBudget: budget } : { thinkingLevel: effort }
      } else {
        rest.thinkingConfig = { thinkingLevel: effort }
      }
    }
  } else if (protocol === 'responses') {
    if (rest.reasoning === undefined) rest.reasoning = { effort }
  } else if (protocol === 'messages') {
    if (effort === 'none') {
      if (rest.thinking === undefined) rest.thinking = { type: 'disabled' }
    } else if (provider === 'anthropic') {
      if (model && ANTHROPIC_BUDGET_MODEL.test(model)) {
        const budget = thinkingBudgetFor(effort, opts?.maxOutputTokens)
        if (rest.thinking === undefined) rest.thinking = budget === undefined ? { type: 'adaptive' }
          : budget < ANTHROPIC_MIN_BUDGET ? { type: 'disabled' } : { type: 'enabled', budget_tokens: budget }
      } else {
        if (rest.thinking === undefined) rest.thinking = { type: 'adaptive' }
        if (rest.output_config === undefined) rest.output_config = { effort }
      }
    } else if (provider === 'deepseek') {
      if (rest.thinking === undefined) rest.thinking = { type: 'enabled' }
      if (rest.output_config === undefined) rest.output_config = { effort }
    } else if (rest.thinking === undefined) {
      // Anthropic-compatible vendor endpoints have always received this shape; keep it.
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
    if (!info.gatewayApproved) throw new Error('请先确认网关地址和 API 根路径')
    const k = providerKey(info, config.providers?.[provider])
    if (!k) throw new Error(`缺少 ${info.label} 的 API Key，请在「设置 → 模型与密钥」里填写`)
    return k
  }
  const mi = modelInfo(config, ref)
  const parameters = resolveProviderParameters(protocol, provider, opts.parameters, opts.effort ?? config.reasoningEffort?.[ref], {
    model, maxOutputTokens: mi.maxOutputTokens
  })
  let transport = providerTransport(config, info, opts.fetch)
  transport = apiVersionFetch(info.apiVersion, transport)
  transport = authFetch(protocol, info.authHeader, info.authHeaderExplicit, transport)
  const thinkingObj = parameters?.thinking as Record<string, unknown> | undefined
  if (protocol === 'messages' && provider === 'anthropic' && typeof thinkingObj?.budget_tokens === 'number') {
    transport = clampThinkingBudgetFetch(transport)
  }
  if (protocol === 'gemini')
    return createGeminiModel({ baseUrl: url, model, id: `${ref}@gemini`, apiKey, parameters, fetch: transport, inputCapabilities: { images: mi.vision } })
  const common = {
    endpoint: url,
    model,
    id: `${ref}@${protocol}`,
    apiKey,
    parameters,
    fetch: transport,
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
  opts: { fetch?: typeof fetch; effort?: string; timeoutMs?: number; ledger?: Ledger } = {}
): Promise<{ ok: true; latencyMs: number; text: string; usage?: { inputTokens: number; outputTokens: number } } | { ok: false; error: string }> {
  const t0 = Date.now()
  try {
    const rawModel = createModel(config, ref, { fetch: opts.fetch, effort: opts.effort })
    const model = opts.ledger
      ? meterModel(rawModel, { ledger: opts.ledger, modelRef: ref, category: () => 'usage' })
      : rawModel
    const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
    let text = ''
    let finish: Extract<ModelEvent, { type: 'finish' }> | undefined
    for await (const ev of model.stream({
      requestId: `probe-${t0}`,
      instructions: '这是连通性测试，只回复 OK。',
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
