import type { AgentModel, ModelUsage } from '@evoscholar/harness'
import type { BudgetCategory } from './config'
import type { Ledger } from './budget'
import { modelCostUsd } from './pricing'

export type MeterContext = {
  ledger: Ledger
  modelRef: string
  category: () => BudgetCategory
  sessionId?: string
  genomeId?: string
  onWarning?: (msg: string) => void
}

/** Rough pre-flight estimate: ~3 characters per token for mixed CJK/English. */
function estimateInputTokens(request: unknown): number {
  return Math.ceil(JSON.stringify(request).length / 3)
}

/**
 * Wraps any AgentModel so every request is budget-checked before it is sent and every response
 * (including failed streams that reported usage) is written to the ledger.
 */
export function meterModel(inner: AgentModel, ctx: MeterContext): AgentModel {
  const [provider] = ctx.modelRef.split('/')
  const record = (usage: ModelUsage) => {
    const { usd, peak } = modelCostUsd(ctx.modelRef, usage)
    ctx.ledger.record({
      category: ctx.category(),
      kind: 'model',
      provider,
      model: ctx.modelRef,
      sessionId: ctx.sessionId,
      genomeId: ctx.genomeId,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
      peak,
      costUsd: usd
    })
  }
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    async *stream(request, signal) {
      const est = modelCostUsd(ctx.modelRef, {
        inputTokens: estimateInputTokens(request),
        outputTokens: Math.min(request.maxOutputTokens, 2000)
      }).usd * ctx.ledger.rate
      for (const w of ctx.ledger.assertCanSpend(ctx.category(), est)) ctx.onWarning?.(w)
      let recorded = false
      try {
        for await (const event of inner.stream(request, signal)) {
          if (event.type === 'finish' && event.usage && !recorded) {
            recorded = true
            record(event.usage)
          }
          yield event
        }
      } catch (error) {
        const usage = (error as { diagnostics?: { usage?: ModelUsage } }).diagnostics?.usage
        if (usage && !recorded) record(usage)
        throw error
      }
    }
  }
}
