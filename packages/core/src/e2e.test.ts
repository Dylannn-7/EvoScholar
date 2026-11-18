import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openResearchSession, openRuntime, openWorkspace, modelCostUsd, isDeepSeekPeak, BudgetError } from './index'

const REPO = resolve(__dirname, '../../..')

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-'))
  for (const f of ['evoscholar.config.json']) cpSync(join(REPO, f), join(dir, f))
  cpSync(join(REPO, 'genomes'), join(dir, 'genomes'), { recursive: true })
  cpSync(join(REPO, 'prompts'), join(dir, 'prompts'), { recursive: true })
  mkdirSync(join(dir, 'data'))
  writeFileSync(join(dir, '.env'), 'DEEPSEEK_API_KEY=sk-test\n')
  delete process.env.DEEPSEEK_API_KEY
  return openWorkspace(dir)
}

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' }
  })

test('pricing: off-peak vs peak, cache hits', () => {
  const sat = new Date('2026-11-21T03:00:00Z')
  const wedPeak = new Date('2026-11-18T03:00:00Z')
  assert.equal(isDeepSeekPeak(sat), false)
  assert.equal(isDeepSeekPeak(wedPeak), true)
  const u = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000 }
  assert.equal(modelCostUsd('deepseek/deepseek-flash', u, sat).usd.toFixed(3), '0.750')
  assert.equal(modelCostUsd('deepseek/deepseek-flash', u, wedPeak).usd.toFixed(3), '1.500')
})

test('tool-using turn is metered, recorded and searchable', async () => {
  const ws = workspace()
  const rt = openRuntime(ws, () => {})
  let modelCalls = 0
  const seen: string[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    seen.push(u)
    assert.equal((init?.headers as Record<string, string>).Authorization ?? (init?.headers as Record<string, string>).authorization, 'Bearer sk-test')
    if (u.endsWith('/v1/tools/search'))
      return Response.json({ results: [{ title: '光子晶体综述', url: 'https://example.org/a', summary: '摘要', date: '2026-01-01T00:00:00Z', site_name: 'Example', authority: 3 }] })
    assert.equal(u, 'https://api.deepseek.com/v1/chat/completions')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'deepseek-flash')
    modelCalls++
    if (modelCalls === 1)
      return sse([
        { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"光子晶体 site:cnki.net"}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_cache_hit_tokens: 1000 } }
      ])
    assert.ok(JSON.stringify(body.messages).includes('光子晶体综述'))
    return sse([
      { choices: [{ index: 0, delta: { content: '找到一篇综述 [1]。' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1500, completion_tokens: 20, prompt_cache_hit_tokens: 1200 } }
    ])
  }) as typeof fetch
  const rs = await openResearchSession(rt, { category: 'dev' })
  const { status, answer } = await rs.ask('找一篇光子晶体的中文综述')
  await rs.dispose()
  assert.equal(status, 'complete')
  assert.match(answer, /综述/)
  const s = rt.ledger.summary()
  assert.ok(s.byCategory.dev > 0, 'model + search cost recorded under dev')
  assert.equal(s.webCallsToday, 1)
  const turn = rt.db.prepare('SELECT * FROM turns').get() as Record<string, unknown>
  assert.equal(turn.genome_id, 'g-0000')
  assert.equal(turn.steps, 2)
  assert.equal(turn.tool_calls, 1)
  const events = rt.db.prepare(`SELECT type FROM events`).all().map((r) => (r as { type: string }).type)
  assert.ok(events.includes('tool.result'))
})

test('hard cap stops calls before they are sent', async () => {
  const ws = workspace()
  ws.config.budget.categories.dev = 0.000001
  const rt = openRuntime(ws, () => {})
  rt.ledger.record({ category: 'dev', kind: 'model', provider: 'deepseek', costUsd: 1 })
  let called = false
  globalThis.fetch = (async () => { called = true; return new Response('') }) as typeof fetch
  const rs = await openResearchSession(rt, { category: 'dev' })
  await assert.rejects(rs.ask('hi'), BudgetError)
  await rs.dispose()
  assert.equal(called, false)
})
