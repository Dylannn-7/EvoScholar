import { randomUUID } from 'node:crypto'
import type { BudgetCategory } from '../config'
import { meterModel } from '../metering'
import { createModel, modelInfo } from '../providers'
import type { Runtime } from '../session'

/** One metered, tool-less model call (used by the reflector). Returns the assistant text. */
export async function complete(
  rt: Runtime,
  ref: string,
  instructions: string,
  user: string,
  opts: { category?: BudgetCategory; maxOutputTokens?: number; signal?: AbortSignal; genomeId?: string } = {}
): Promise<string> {
  const model = meterModel(createModel(rt.ws.config, ref), {
    ledger: rt.ledger,
    modelRef: ref,
    contextWindow: modelInfo(rt.ws.config, ref).contextWindow,
    category: () => opts.category ?? 'evolution',
    genomeId: opts.genomeId
  })
  let text = ''
  let final = ''
  for await (const ev of model.stream(
    {
      requestId: randomUUID(),
      instructions,
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: user }] }],
      tools: [],
      maxOutputTokens: opts.maxOutputTokens ?? 4000
    },
    opts.signal ?? new AbortController().signal
  )) {
    if (ev.type === 'text-delta') text += ev.text
    else if (ev.type === 'finish') final = ev.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
  }
  return final || text
}

/** Extract the first JSON object from model text (tolerates ```json fences and prose). */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('反思器没有返回 JSON')
  return JSON.parse(body.slice(start, end + 1)) as T
}
