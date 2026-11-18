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
  cpSync(join(REPO, 'skills'), join(dir, 'skills'), { recursive: true })
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
  assert.equal(turn.genome_id, rt.genomes.activeId())
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

test('the full output limit is reserved across separate ledger connections', async (t) => {
  const ws = workspace()
  ws.config.budget.categories.dev = 0.5
  const rt = openRuntime(ws, () => {})
  const other = openRuntime(ws, () => {})
  const realFetch = globalThis.fetch
  let release!: () => void
  let sent!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const requestSent = new Promise<void>((resolve) => { sent = resolve })
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 8192)
    if (++calls === 1) {
      sent()
      await held
    }
    return sse([
      { choices: [{ index: 0, delta: { content: '完成' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 800, completion_tokens: 60 } }
    ])
  }
  const first = await openResearchSession(rt, { category: 'dev' })
  const second = await openResearchSession(other, { category: 'dev' })
  const pending = first.ask('第一条')
  t.after(async () => {
    release()
    await pending.catch(() => {})
    await first.dispose()
    await second.dispose()
    rt.db.close()
    other.db.close()
    globalThis.fetch = realFetch
  })
  await Promise.race([requestSent, pending])
  const reserved = other.ledger.summary().reservedCny
  assert.ok(reserved > 0.07 && reserved < 0.5, String(reserved))
  ws.config.budget.categories.dev = reserved * 1.5
  await assert.rejects(second.ask('第二条'), { name: 'BudgetError', scope: 'category' })
  assert.equal(calls, 1)
  release()
  assert.equal((await pending).status, 'complete')
  assert.equal(other.ledger.summary().reservedCny, 0)
  assert.ok(other.ledger.summary().totalCny < 0.01)
})

test('official DeepSeek image input fits a small budget without reserving the context window', async (t) => {
  const ws = workspace()
  ws.config.budget.categories.dev = 0.3
  const rt = openRuntime(ws, () => {})
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async (_url, init) => {
    called = true
    assert.ok(rt.ledger.summary().reservedCny < 0.3)
    assert.match(String(init?.body), /data:image\/png;base64,/)
    return sse([
      { choices: [{ index: 0, delta: { content: '完成' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 8 } }
    ])
  }
  t.after(() => { globalThis.fetch = originalFetch; rt.db.close() })
  const rs = await openResearchSession(rt, { category: 'dev' })
  try {
    const result = await rs.ask([{ type: 'image', mimeType: 'image/png', source: 'data:image/png;base64,' + 'A'.repeat(250_000) }])
    assert.equal(result.status, 'complete')
    assert.ok(called)
    assert.equal(rt.ledger.summary().reservedCny, 0)
  } finally { await rs.dispose() }
})

test('web requests reserve the remaining daily slot and release it on rejection', () => {
  const ws = workspace()
  ws.config.budget.webCallsPerDay = 1
  const rt = openRuntime(ws, () => {})
  const entry = { category: 'dev', kind: 'search', provider: 'deepseek', units: 1, costUsd: 0.00075 } as const
  try {
    const first = rt.ledger.reserve(entry)
    assert.throws(() => rt.ledger.reserve(entry), { name: 'BudgetError', scope: 'web' })
    first.settle(null)
    const second = rt.ledger.reserve(entry)
    second.settle()
    second.settle()
    assert.equal(rt.ledger.summary().webCallsToday, 1)
    assert.equal(rt.ledger.summary().reservedCny, 0)
    assert.equal((rt.db.prepare('SELECT estimated FROM ledger').get() as { estimated: number }).estimated, 1)
  } finally {
    rt.db.close()
  }
})
