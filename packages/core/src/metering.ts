import type { AgentModel, ContentBlock, ModelRequest, ModelUsage } from '@evoscholar/harness'
import type { BudgetCategory } from './config'
import type { Ledger } from './budget'
import { modelCostUsd, priceFor } from './pricing'

export type MeterContext = {
  ledger: Ledger
  modelRef: string
  contextWindow?: number
  imageInputTokenCap?: number
  enforceCap?: boolean
  category: () => BudgetCategory
  sessionId?: string
  genomeId?: string
  onWarning?: (msg: string) => void
}

function reserveInputTokens(request: ModelRequest, { contextWindow = Infinity, imageInputTokenCap }: MeterContext): number {
  let mediaTokens = 0
  let unknownMedia = false
  const measureBlock = (block: ContentBlock): ContentBlock => {
    if (block.type === 'text') return block
    if (block.type === 'image' && imageInputTokenCap !== undefined) {
      mediaTokens += imageInputTokenCap
      return { ...block, source: null }
    }
    unknownMedia = true
    return block
  }
  const messages = request.messages.map((message) => ({
    ...message, content: message.content.map(measureBlock), modelContent: message.modelContent?.map(measureBlock)
  }))
  // Media with no provider-published cap may expand to the full context.
  if (unknownMedia && Number.isFinite(contextWindow)) return contextWindow
  // Budget a token per UTF-8 byte plus allowance for the adapter's message framing.
  return Math.min(contextWindow, Buffer.byteLength(JSON.stringify({ ...request, messages })) + 512 + mediaTokens)
}

/**
 * Wraps any AgentModel so every request is budget-checked before it is sent and every response
 * (including failed streams that reported usage) is written to the ledger.
 */
export function meterModel(inner: AgentModel, ctx: MeterContext): AgentModel {
  const [provider] = ctx.modelRef.split('/')
  const actual = (usage: ModelUsage) => {
    const { usd, peak } = modelCostUsd(ctx.modelRef, usage)
    return {
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
      peak,
      costUsd: usd
    }
  }
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    async *stream(request, signal) {
      signal.throwIfAborted()
      const cat = ctx.category()
      if (cat === 'usage' && !ctx.enforceCap) {
        let usage: ModelUsage | undefined
        try {
          for await (const event of inner.stream(request, signal)) {
            if (event.type === 'finish') usage = event.usage
            yield event
          }
        } finally {
          if (usage) ctx.ledger.record({ category: cat, kind: 'model', provider, model: ctx.modelRef, sessionId: ctx.sessionId, genomeId: ctx.genomeId, ...actual(usage) })
        }
        return
      }
      const inputTokens = reserveInputTokens(request, ctx)
      const outputTokens = request.maxOutputTokens
      const price = priceFor(ctx.modelRef)
      const multiplier = price.peakMultiplier ?? 1
      const costUsd = (inputTokens * price.cacheMiss + outputTokens * price.output) * multiplier / 1e6
      const reservation = ctx.ledger.reserve({
        category: ctx.category(), kind: 'model', provider, model: ctx.modelRef,
        sessionId: ctx.sessionId, genomeId: ctx.genomeId, inputTokens, outputTokens,
        peak: multiplier > 1, costUsd
      })
      let usage: ModelUsage | undefined
      let possiblyBilled = false
      try {
        for (const w of reservation.warnings) ctx.onWarning?.(w)
        // Metered calls must send the same output limit that was reserved.
        for await (const event of inner.stream({ ...request, useProviderOutputDefault: undefined }, signal)) {
          possiblyBilled = true
          if (event.type === 'finish') usage = event.usage
          yield event
        }
      } catch (error) {
        const e = error as { code?: string; status?: number; diagnostics?: { usage?: ModelUsage } } | null
        usage ??= e?.diagnostics?.usage
        possiblyBilled ||= signal.aborted || !!e?.diagnostics || e?.code === 'network'
          || e?.code === 'protocol' || (e?.status ?? 0) >= 500
        throw error
      } finally {
        reservation.settle(usage ? actual(usage) : possiblyBilled ? undefined : null)
      }
    }
  }
}
