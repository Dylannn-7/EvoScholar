/**
 * Prices in USD per 1M tokens (models) or per 1k calls (tools).
 * Source: https://api-docs.deepseek.com/quick_start/pricing/ (checked 2026-11-18).
 * Unknown models fall back to CONSERVATIVE so the budget is over- rather than under-estimated.
 */
export type ModelPrice = { cacheHit: number; cacheMiss: number; output: number; peakMultiplier?: number }
export type PriceSchedule = 'deepseek' | 'flat'

export const MODEL_PRICES: Record<string, ModelPrice & { schedule: PriceSchedule }> = {
  'deepseek/deepseek-flash': { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6, peakMultiplier: 2, schedule: 'deepseek' },
  'deepseek/deepseek-v4-pro': { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98, peakMultiplier: 2, schedule: 'deepseek' }
}
export const CONSERVATIVE: ModelPrice & { schedule: PriceSchedule } = {
  cacheHit: 0.5, cacheMiss: 3, output: 15, schedule: 'flat'
}
/** USD per 1k successful calls. */
export const TOOL_PRICES: Record<string, number> = {
  'deepseek/search': 0.75,
  'deepseek/fetch': 0.75,
  'deepseek/ocr-page': 0.225
}

/** DeepSeek peak: Mon–Fri 01:00–04:00 and 06:00–10:00 UTC (Chinese public holidays ignored → safe side). */
export function isDeepSeekPeak(at: Date = new Date()): boolean {
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes()
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
}

export function priceFor(modelRef: string): ModelPrice & { schedule: PriceSchedule; known: boolean } {
  const p = MODEL_PRICES[modelRef]
  return p ? { ...p, known: true } : { ...CONSERVATIVE, known: false }
}

export function modelCostUsd(
  modelRef: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
  at: Date = new Date()
): { usd: number; peak: boolean } {
  const p = priceFor(modelRef)
  const peak = p.schedule === 'deepseek' && isDeepSeekPeak(at)
  const m = peak ? (p.peakMultiplier ?? 1) : 1
  const hit = Math.min(usage.cacheReadTokens ?? 0, usage.inputTokens)
  const miss = usage.inputTokens - hit
  const usd = ((hit * p.cacheHit + miss * p.cacheMiss + usage.outputTokens * p.output) * m) / 1e6
  return { usd, peak }
}

export function toolCostUsd(key: string, units = 1): number {
  return ((TOOL_PRICES[key] ?? 1) * units) / 1000
}
