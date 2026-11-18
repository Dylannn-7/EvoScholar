// Google Gemini generateContent adapter (streaming SSE). Lives in core because the harness
// fork stays byte-identical to upstream; it implements the same AgentModel contract.
import type { AgentModel, ContentBlock, Json, ModelEvent, ModelRequest, ModelUsage, ToolCall } from '@evoscholar/harness'

export type GeminiOptions = {
  /** API root, e.g. https://generativelanguage.googleapis.com/v1beta */
  baseUrl: string
  model: string
  id?: string
  apiKey(signal: AbortSignal): string | Promise<string>
  fetch?: typeof globalThis.fetch
  parameters?: Readonly<Record<string, Json>>
  inputCapabilities?: { images?: boolean }
}

type Part = Record<string, unknown>
type Content = { role: 'user' | 'model'; parts: Part[] }

function mediaPart(block: ContentBlock): Part {
  if (block.type === 'text') return { text: block.text }
  const src = typeof block.source === 'string' ? block.source
    : block.source && typeof block.source === 'object' && !Array.isArray(block.source) && typeof (block.source as { url?: unknown }).url === 'string'
      ? String((block.source as { url: string }).url) : ''
  const m = /^data:([^;,]+);base64,(.+)$/.exec(src)
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } }
  if (/^https?:\/\//.test(src)) return { fileData: { mimeType: block.mimeType, fileUri: src } }
  return { text: `[${block.type}${block.filename ? ` ${block.filename}` : ''}]` }
}

/** Convert harness messages into Gemini `contents`, replaying thought signatures from our own turns. */
export function geminiContents(request: ModelRequest, adapterId: string): Content[] {
  const out: Content[] = []
  const names = new Map<string, string>()
  const push = (role: Content['role'], parts: Part[]) => {
    if (!parts.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else out.push({ role, parts })
  }
  for (const msg of request.messages) {
    if (msg.role === 'assistant') {
      const state = msg.providerState?.adapterId === adapterId && msg.providerState.value && typeof msg.providerState.value === 'object' && !Array.isArray(msg.providerState.value)
        ? msg.providerState.value as Record<string, Json> : {}
      const sigs = (state.signatures && typeof state.signatures === 'object' && !Array.isArray(state.signatures) ? state.signatures : {}) as Record<string, Json>
      const parts: Part[] = []
      const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
      if (text) parts.push({ text, ...(typeof sigs._text === 'string' ? { thoughtSignature: sigs._text } : {}) })
      for (const c of msg.calls ?? []) {
        names.set(`${msg.id}/${c.id}`, c.name)
        parts.push({ functionCall: { name: c.name, args: c.arguments ?? {} }, ...(typeof sigs[c.id] === 'string' ? { thoughtSignature: sigs[c.id] } : {}) })
      }
      push('model', parts)
    } else if (msg.role === 'tool') {
      const name = names.get(msg.invocationId ?? '') ?? 'tool'
      const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
      const media = msg.content.filter((b) => b.type !== 'text').map(mediaPart)
      push('user', [{ functionResponse: { name, response: msg.isError ? { error: text } : { content: text } } }, ...media])
    } else {
      push('user', msg.content.map(mediaPart))
    }
  }
  return out
}

async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '')
        const data = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
        if (data && data !== '[DONE]') yield JSON.parse(data) as Record<string, unknown>
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function createGeminiModel(input: GeminiOptions): AgentModel {
  const base = new URL(input.baseUrl.replace(/\/+$/, '') + '/')
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid Gemini endpoint')
  const model = input.model.trim().replace(/^models\//, '')
  if (!model || /[\s/?#]/.test(model)) throw new Error('Invalid Gemini model id')
  const id = input.id ?? `${base.href}${model}@gemini`
  const transport = input.fetch ?? globalThis.fetch
  return {
    id,
    capabilities: { tools: true, images: !!input.inputCapabilities?.images, files: false },
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const { thinkingConfig: tc, generationConfig: gc, ...rest } = (input.parameters ?? {}) as Record<string, Json>
      const body: Record<string, unknown> = {
        ...rest,
        systemInstruction: { parts: [{ text: request.instructions }] },
        contents: geminiContents(request, id),
        generationConfig: {
          ...(gc && typeof gc === 'object' && !Array.isArray(gc) ? gc : {}),
          ...(request.useProviderOutputDefault ? {} : { maxOutputTokens: request.maxOutputTokens }),
          thinkingConfig: { includeThoughts: true, ...(tc && typeof tc === 'object' && !Array.isArray(tc) ? tc : {}) }
        }
      }
      if (request.tools.length)
        body.tools = [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
      const key = await input.apiKey(signal)
      if (!key || /[\r\n]/.test(key)) throw new Error('Invalid model credential')
      const url = new URL(`models/${encodeURIComponent(model)}:streamGenerateContent`, base)
      url.searchParams.set('alt', 'sse')
      const res = await transport(url.href, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      })
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Gemini HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
      }
      let text = ''
      let finish = ''
      let usage: ModelUsage | undefined
      const calls: ToolCall[] = []
      const signatures: Record<string, string> = {}
      for await (const chunk of sse(res.body, signal)) {
        const cand = (chunk.candidates as Record<string, unknown>[] | undefined)?.[0]
        for (const part of ((cand?.content as { parts?: Part[] } | undefined)?.parts ?? [])) {
          const sig = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined
          if (part.functionCall && typeof part.functionCall === 'object') {
            const fc = part.functionCall as { name?: string; args?: Json; id?: string }
            const callId = fc.id ?? `call_${calls.length + 1}`
            const args = fc.args ?? {}
            calls.push({ id: callId, name: String(fc.name ?? ''), arguments: args })
            if (sig) signatures[callId] = sig
            yield { type: 'tool-delta', index: calls.length - 1, id: callId, name: String(fc.name ?? ''), arguments: JSON.stringify(args) }
          } else if (typeof part.text === 'string') {
            if (part.thought) yield { type: 'reasoning-delta', text: part.text }
            else {
              text += part.text
              if (sig) signatures._text = sig
              yield { type: 'text-delta', text: part.text }
            }
          } else if (sig) signatures._text = sig
        }
        if (typeof cand?.finishReason === 'string') finish = cand.finishReason
        const u = chunk.usageMetadata as Record<string, number> | undefined
        if (u) usage = {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
          ...(u.cachedContentTokenCount ? { cacheReadTokens: u.cachedContentTokenCount } : {})
        }
      }
      yield {
        type: 'finish',
        content: text ? [{ type: 'text', text }] : [],
        ...(calls.length ? { calls } : {}),
        ...(Object.keys(signatures).length ? { providerState: { signatures } } : {}),
        ...(usage ? { usage } : {}),
        reason: calls.length ? 'tools' : finish === 'MAX_TOKENS' ? 'length' : 'complete'
      }
    }
  }
}
